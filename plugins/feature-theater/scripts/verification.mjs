import { createHash, randomUUID } from 'node:crypto';
import { checkOutcome } from './check-outcome.mjs';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CANDIDATE_REVIEW_ACTION, assertCheckReservation, bumpSemanticGeneration, contractSnapshotKey, featureBySlug, loadWorkspace, meta, newId, parseJson, recordEvent, reserveInterruptedCheck, transaction, uncertainCheckKey, workGraphAction, workItems } from './state.mjs';
import { repositorySnapshot } from './git.mjs';
import { unconfirmedDescendants, workersKey } from './ownership.mjs';
import { TheaterError, atomicWrite, contained, ensureManagedPath, now, redactString, requiredText, resolveWorkspace, run, safeSlug, withWorkspaceLock } from './util.mjs';

export function featureChecks(db, featureId) {
  return parseJson(meta(db, `checks:${featureId}`), []);
}

function contractDefinition(db, feature) {
  const work = workItems(db, feature.id).map(item => ({
    key: item.item_key, title: item.title, description: item.description,
    acceptance: item.acceptance, kind: item.kind, dependencies: item.dependencies,
  })).sort((a, b) => a.key.localeCompare(b.key));
  const spec = db.prepare('SELECT content FROM spec_revisions WHERE feature_id = ? AND revision = ?').get(feature.id, feature.spec_revision)?.content ?? '';
  return { specRevision: feature.spec_revision, spec, work, checks: featureChecks(db, feature.id) };
}

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bindingKey = contractSnapshotKey;

export function featureContract(db, feature) {
  return fingerprint(contractDefinition(db, feature));
}

function checkBindings(definition) {
  const { checks, ...inputs } = definition;
  return Object.fromEntries(checks.map(({ reuse_same_revision: _policy, ...check }) => [check.key, fingerprint({ version: 1, ...inputs, work: scopedWork(inputs.work, check.work_scope), check })]));
}

function scopedWork(work, scope) {
  if (scope === undefined) return work;
  const byKey = new Map(work.map(item => [item.key, item]));
  const selected = new Set();
  const pending = [...scope];
  while (pending.length) {
    const key = pending.pop();
    if (selected.has(key)) continue;
    const item = byKey.get(key);
    if (!item) throw new TheaterError(`Unknown work scope item: ${key}`, 'WORK_ITEM_NOT_FOUND');
    selected.add(key);
    pending.push(...item.dependencies);
  }
  return work.filter(item => selected.has(item.key));
}

function captureContract(db, feature, definition) {
  const contract = fingerprint(definition);
  const key = bindingKey(feature.id, contract);
  // The exact full hash binds legacy receipts to this snapshot without rewriting their evidence. Its
  // required and reuse policies let a recorded candidate's checks be revalidated against this contract
  // later; a snapshot saved before they existed gains them when this exact definition is captured again.
  const policy = {
    required: definition.checks.filter(check => check.required).map(check => check.key),
    reuse: definition.checks.filter(check => check.reuse_same_revision).map(check => check.key),
  };
  const saved = parseJson(meta(db, key), null);
  if (!saved) meta(db, key, JSON.stringify({ version: 1, checks: checkBindings(definition), ...policy }));
  else if (saved.version === 1 && !(Array.isArray(saved.required) && Array.isArray(saved.reuse))) meta(db, key, JSON.stringify({ ...saved, ...policy }));
  return contract;
}

// Recording a candidate snapshots its exact contract, even when every receipt it relies on was reused.
export function captureFeatureContract(db, feature) {
  return captureContract(db, feature, contractDefinition(db, feature));
}

export function assertAgentIdle(feature) {
  if (feature.active_turn_id || ['starting', 'uncertain', 'running', 'compacting', 'waiting_for_user'].includes(feature.agent_status)) {
    throw new TheaterError('Wait for the feature agent to stop before changing its contract or verifying a candidate.', 'AGENT_BUSY');
  }
}

// A Claude worker process can outlive its completed turn and still change the checkout, so an idle
// lane is verified or completed only once its clean exit or a coordinator attestation has cleared every guard.
// Tools launched by a worker stopped without its process tree can likewise outlive it, so an
// unconfirmed-descendants marker blocks verification until an attestation clears it.
export function assertWorkersStopped(db, feature) {
  const guards = parseJson(meta(db, workersKey(feature.id)), []);
  if (guards.length) {
    throw new TheaterError('A worker process from this lane has not confirmed its exit. Wait for it to stop, or stop the lane with an attestation, before verifying, recording or accepting a candidate.', 'AGENT_BUSY', { workerGuards: guards.length });
  }
  const marker = unconfirmedDescendants(db, feature.id);
  if (marker) {
    throw new TheaterError(`Tools launched by a stopped worker of this lane may still be running, so checks, candidate recording and completion must wait. Confirm no process is running in its checkout, then pause the lane with theater_feature_status and prior_turn_attestation: { evidence } describing what you checked, and resume it. Recorded: ${marker.summary}`, 'AGENT_BUSY', { unconfirmedDescendants: true, turnId: marker.turnId ?? null });
  }
}

// Reports whether a candidate or the lane status actually changed; callers own the generation bump.
// Generated review text then yields to the work graph's direction on active, review, done and blocked
// lanes (reactivation keeps a blocked lane's stored text), unless a checkpoint saved that exact text
// after the latest candidate or archive event.
export function invalidateCandidates(db, featureId) {
  const { status } = db.prepare('SELECT status FROM features WHERE id = ?').get(featureId);
  const superseded = db.prepare("UPDATE candidates SET status = 'superseded' WHERE feature_id = ? AND status IN ('ready','accepted')").run(featureId).changes;
  const reopened = db.prepare("UPDATE features SET status = 'active' WHERE id = ? AND status IN ('done','review')").run(featureId).changes;
  if (!superseded && !reopened) return false;
  if (['active', 'review', 'done', 'blocked'].includes(status)) {
    db.prepare(`UPDATE features SET next_action = ? WHERE id = ? AND next_action = ? AND NOT EXISTS (
      SELECT 1 FROM events checkpointed WHERE checkpointed.feature_id = features.id AND checkpointed.kind = 'feature.checkpointed'
      AND json_extract(checkpointed.details_json, '$.nextAction') = features.next_action
      AND checkpointed.id > COALESCE((SELECT MAX(id) FROM events WHERE feature_id = features.id AND kind IN ('candidate.recorded', 'feature.archived')), 0)
    )`).run(workGraphAction(workItems(db, featureId)), featureId, CANDIDATE_REVIEW_ACTION);
  }
  return true;
}

export function verificationStatus(ctx, feature, revision) {
  const definition = contractDefinition(ctx.db, feature);
  const contract = fingerprint(definition);
  const bindings = checkBindings(definition);
  const savedBindings = new Map();
  const checks = definition.checks.map(check => {
    let receipt = null, reuseBlockedBy = null;
    const rows = ctx.db.prepare(`SELECT id, passed, summary, created_at, exit_code, duration_ms, contract_hash, spec_revision FROM evidence
      WHERE feature_id = ? AND source = 'executed' AND check_key = ? AND revision = ?
      ORDER BY rowid DESC`).iterate(feature.id, check.key, revision ?? '');
    for (const row of rows) {
      if (row.contract_hash === contract) { receipt = row; break; }
      if (row.spec_revision !== feature.spec_revision) continue;
      if (!savedBindings.has(row.contract_hash)) savedBindings.set(row.contract_hash, parseJson(meta(ctx.db, bindingKey(feature.id, row.contract_hash)), null));
      const saved = savedBindings.get(row.contract_hash);
      const known = saved?.version === 1 && /^[a-f0-9]{64}$/.test(saved.checks?.[check.key] ?? '');
      if (known && saved.checks[check.key] === bindings[check.key]) {
        if (check.reuse_same_revision || !row.passed) receipt = row;
        break;
      }
      if (!known && !row.passed && check.reuse_same_revision) { reuseBlockedBy = row.id; break; }
    }
    return { ...check, status: receipt ? receipt.passed ? 'passed' : 'failed' : 'missing', receipt, ...(receipt ? { reused: receipt.contract_hash !== contract } : {}), ...(reuseBlockedBy ? { reuseBlockedBy } : {}) };
  });
  const required = checks.filter(check => check.required);
  const ready = feature.spec_revision > 0 && required.length > 0 && required.every(check => check.status === 'passed');
  const openWork = workItems(ctx.db, feature.id).filter(item => !['done', 'cancelled'].includes(item.status)).map(item => item.item_key).sort();
  return { contractHash: contract, specRevision: feature.spec_revision, revision, ready, completionReady: ready && !openWork.length, openWork, checks };
}

export function assertVerified(ctx, feature, revision, candidate = null) {
  assertCheckReservation(ctx.db, feature.id);
  const verification = verificationStatus(ctx, feature, revision);
  if (candidate && (candidate.contract_hash !== verification.contractHash || candidate.spec_revision !== feature.spec_revision)) {
    throw new TheaterError('Candidate was verified against an older feature contract. Run current checks and record a fresh candidate.', 'STALE_CONTRACT');
  }
  if (!verification.ready) {
    throw new TheaterError('Completion requires a saved specification and passing runtime receipts for every current required check at this commit.', 'COMPLETION_NOT_PROVEN', verification);
  }
  return verification;
}

// Superseding a candidate or reopening a lane changes its projected direction and status, so the
// persisted packet and index follow. workspace.mjs imports this module, hence the deferred import.
async function refreshLaneFiles(ctx, slug) {
  await (await import('./workspace.mjs')).refreshLaneFiles(ctx, slug);
}

async function withFeature(args, fn, lockOptions) {
  const root = await resolveWorkspace(args.workspace_path);
  return withWorkspaceLock(root, `control-${safeSlug(args.feature)}`, async () => {
    const ctx = await loadWorkspace(root);
    try { return await fn(ctx, featureBySlug(ctx.db, safeSlug(args.feature))); }
    finally { ctx.db.close(); }
  }, lockOptions);
}

function artifactPaths(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw new TheaterError('artifact_paths must contain at most 20 checkout-relative paths.', 'INVALID_INPUT');
  const paths = value.map(value => {
    const relative = requiredText(value, 'artifact path', { max: 4096 }).replaceAll('\\', '/');
    if (relative.includes('\0') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new TheaterError('Artifact paths must name files or directories below the checkout, without traversal, Git metadata, or absolute paths.', 'INVALID_INPUT');
    }
    return relative;
  }).sort();
  if (paths.some((value, index) => paths.slice(0, index).some(parent => value === parent || value.startsWith(`${parent}/`)))) {
    throw new TheaterError('Artifact paths must not duplicate or contain one another.', 'INVALID_INPUT');
  }
  return paths;
}

async function artifactFiles(root, paths) {
  const files = new Map();
  async function visit(relative) {
    let stat;
    try { stat = await fs.lstat(contained(root, relative), { bigint: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) for (const entry of await fs.readdir(contained(root, relative))) await visit(`${relative}/${entry}`);
    else if (stat.isFile()) files.set(relative, stat);
  }
  for (const relative of paths) await visit(relative);
  return files;
}

// Matching pre/post-run signatures only suggest a file predates the check; see PROVENANCE_NOTE for the limits.
const fileSignature = stat => stat && `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const PROVENANCE_NOTE = 'unchangedSinceBeforeRun=true means matching pre-run and post-run stat observations (inode, size, mtime, ctime); it does not guarantee the file was never modified, and content may change between those observations and the archive copy. false or null (snapshot unavailable) is not proof that this check produced the file.';

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function archiveCheckArtifacts(ctx, feature, check, id, revision, before) {
  const paths = artifactPaths(check.artifact_paths);
  if (!paths.length) return null;
  const current = before && await artifactFiles(feature.checkout_path, paths).catch(() => null);
  const directory = await ensureManagedPath(ctx.root, contained(ctx.root, '.theater', 'artifacts', id));
  await fs.mkdir(directory, { recursive: true });
  for (const relative of paths) {
    const source = await ensureManagedPath(feature.checkout_path, contained(feature.checkout_path, relative));
    const destination = contained(directory, 'files', relative);
    await fs.cp(source, destination, {
      recursive: true, force: false, errorOnExist: true,
      filter: async source => {
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new TheaterError(`Artifact contains a symlink, junction, or special file: ${source}`, 'UNSAFE_PATH');
        return true;
      },
    });
  }
  const files = [];
  for (const [relative, stat] of [...await artifactFiles(path.join(directory, 'files'), paths)].sort(([a], [b]) => a.localeCompare(b))) {
    const unchangedSinceBeforeRun = current ? before.has(relative) && fileSignature(before.get(relative)) === fileSignature(current.get(relative)) : null;
    files.push({ path: relative, bytes: Number(stat.size), sha256: await sha256File(contained(directory, 'files', relative)), unchangedSinceBeforeRun });
  }
  const manifest = path.join(directory, 'manifest.json');
  await atomicWrite(ctx.root, manifest, `${JSON.stringify({ evidenceId: id, checkKey: check.key, revision, collectedAt: now(), paths, provenance: current ? 'stat-snapshot' : 'unavailable', provenanceNote: PROVENANCE_NOTE, files }, null, 2)}\n`);
  return { manifest, unchanged: files.filter(file => file.unchangedSinceBeforeRun).length };
}

export async function updateChecks(args) {
  if (!Array.isArray(args.checks) || args.checks.length > 50) throw new TheaterError('checks must be an array of at most 50 commands.', 'INVALID_INPUT');
  const checks = args.checks.map(check => {
    const key = safeSlug(check.key, 'check key');
    if (!Array.isArray(check.argv) || !check.argv.length || check.argv.length > 200 || check.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !check.argv[0].trim()) {
      throw new TheaterError('Every check requires an executable and string argv, without a shell.', 'INVALID_INPUT');
    }
    const timeout = check.timeout_seconds ?? 300;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800) throw new TheaterError('Check timeout must be 1–1800 seconds.', 'INVALID_INPUT');
    if (check.required !== undefined && typeof check.required !== 'boolean') throw new TheaterError('required must be a boolean.', 'INVALID_INPUT');
    if (check.reuse_same_revision !== undefined && typeof check.reuse_same_revision !== 'boolean') throw new TheaterError('reuse_same_revision must be a boolean.', 'INVALID_INPUT');
    let scope;
    if (check.work_scope !== undefined) {
      if (!check.reuse_same_revision || !Array.isArray(check.work_scope) || !check.work_scope.length || check.work_scope.length > 200
        || check.work_scope.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,62}$/.test(key))
        || new Set(check.work_scope).size !== check.work_scope.length) {
        throw new TheaterError('work_scope requires reuse_same_revision and 1–200 unique exact work item keys.', 'INVALID_INPUT');
      }
      scope = [...check.work_scope].sort();
    }
    const paths = artifactPaths(check.artifact_paths);
    return { key, argv: check.argv, purpose: requiredText(check.purpose, 'purpose', { max: 2000 }), kind: requiredText(check.kind ?? 'test', 'check kind', { max: 80 }), required: check.required !== false, timeout_seconds: timeout, ...(paths.length ? { artifact_paths: paths } : {}), ...(check.reuse_same_revision ? { reuse_same_revision: true } : {}), ...(scope ? { work_scope: scope } : {}) };
  });
  // Submitted order is the execution order and part of the contract, so setup can precede dependent checks.
  if (new Set(checks.map(check => check.key)).size !== checks.length) throw new TheaterError('Check keys must be unique.', 'INVALID_INPUT');
  return withFeature(args, async (ctx, feature) => {
    assertAgentIdle(feature);
    const definition = contractDefinition(ctx.db, feature);
    for (const check of checks) scopedWork(definition.work, check.work_scope);
    const changed = JSON.stringify(featureChecks(ctx.db, feature.id)) !== JSON.stringify(checks);
    if (changed) transaction(ctx.db, () => {
      captureContract(ctx.db, feature, definition);
      meta(ctx.db, `checks:${feature.id}`, JSON.stringify(checks));
      invalidateCandidates(ctx.db, feature.id);
      bumpSemanticGeneration(ctx.db, feature.id);
      ctx.db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(now(), feature.id);
      recordEvent(ctx.db, { featureId: feature.id, kind: 'checks.updated', summary: `Configured ${checks.length} verification command(s).` });
    });
    if (changed) await refreshLaneFiles(ctx, feature.slug);
    return { feature: feature.slug, changed, checks, contractHash: featureContract(ctx.db, feature) };
  });
}

// The queue marks its own job interrupted when runChecks throws without a receipt; a direct run
// records an equivalent interrupted job, which blocks further checks, candidates, completion and
// dispatch in this clone until theater_checks_resolve confirms execution_stopped. The lane marker
// is written first, under the control lock already held, so a queue that cannot be written still
// leaves the clone reserved.
async function reserveUncertainExecution(ctx, feature, check, { revision, contract, startedAt, queued }, error) {
  const reason = redactString(error.message);
  const job = queued ? null : {
    key: `direct-${randomUUID()}`, feature: feature.slug, featureId: feature.id, checkKey: check.key, revision, contractHash: contract,
    dependsOn: [], resources: [], status: 'interrupted', queuedAt: startedAt, eligibleAt: startedAt, direct: true,
    reason: `Direct check run without a confirmed stop: ${reason} Establish command termination before releasing its clone.`,
    attempts: [{ receiptId: newId('evidence'), status: 'interrupted', startedAt, queueWaitMs: 0, eligibleWaitMs: 0, finishedAt: null, executionMs: null }],
  };
  let reservationError = null;
  if (job) {
    meta(ctx.db, uncertainCheckKey(feature.id), JSON.stringify({ jobKey: job.key, checkKey: check.key, revision, at: now() }));
    try { await withWorkspaceLock(ctx.root, 'verification-queue', () => reserveInterruptedCheck(ctx.db, job)); }
    catch (caught) { reservationError = redactString(caught.message); }
  }
  const reservedBy = job?.key ?? null;
  recordEvent(ctx.db, {
    featureId: feature.id, kind: 'checks.execution_uncertain',
    summary: `${check.purpose}: no receipt recorded because its command may still be running${reservedBy ? `; queue job ${reservedBy} reserves this clone` : ''}.`,
    details: { checkKey: check.key, revision, pid: error.details?.pid ?? null, commandExited: error.details?.commandExited ?? null, reservedBy, reservationError },
  });
  const guidance = queued ? 'Its queue job stays interrupted' : `Job ${reservedBy} reserves this clone${reservationError ? ` (recorded on the lane only; the queue could not be updated: ${reservationError})` : ''}`;
  return new TheaterError(`${reason} No receipt was recorded. ${guidance} until theater_checks_resolve confirms execution_stopped after you verify the command and its children stopped.`, error.code,
    { ...error.details, output: redactString(error.details?.output ?? ''), checkKey: check.key, reservedBy, reservationError });
}

export async function runChecks(args, execution = {}) {
  return withFeature(args, async (ctx, feature) => {
    assertCheckReservation(ctx.db, feature.id, execution.receiptId);
    assertAgentIdle(feature);
    assertWorkersStopped(ctx.db, feature);
    const checks = featureChecks(ctx.db, feature.id);
    if (!checks.length) throw new TheaterError('Configure meaningful verification commands first.', 'CHECKS_REQUIRED');
    let selectedChecks = checks;
    if (args.check_keys !== undefined) {
      if (!Array.isArray(args.check_keys) || !args.check_keys.length || args.check_keys.length > 50
        || new Set(args.check_keys).size !== args.check_keys.length
        || args.check_keys.some(key => typeof key !== 'string' || !checks.some(check => check.key === key))) {
        throw new TheaterError('check_keys must be a nonempty array of unique configured check keys.', 'INVALID_INPUT');
      }
      selectedChecks = checks.filter(check => args.check_keys.includes(check.key));
    }
    const before = await repositorySnapshot(feature.checkout_path);
    if (!before.clean) throw new TheaterError('Commit the candidate before running recorded checks.', 'DIRTY_CANDIDATE');
    const definition = contractDefinition(ctx.db, feature);
    const contract = fingerprint(definition);
    if (execution.receiptId && (selectedChecks.length !== 1 || before.head !== execution.revision || contract !== execution.contractHash)) {
      throw new TheaterError('Queued verification no longer matches the exact commit and full contract.', 'STALE_QUEUE_JOB');
    }
    captureContract(ctx.db, feature, definition);
    // Receipts are live evidence; only a superseded candidate or reopened lane is a semantic change.
    let invalidated = false;
    const invalidateUnverified = () => {
      if (!verificationStatus(ctx, featureBySlug(ctx.db, feature.slug), before.head).ready && invalidateCandidates(ctx.db, feature.id)) {
        bumpSemanticGeneration(ctx.db, feature.id);
        invalidated = true;
      }
    };
    const receipts = [];
    for (const check of selectedChecks) {
      let artifact = null;
      let artifactError = null;
      let archived = null;
      // Extra metadata walk before the command; a failure here only makes provenance unknown.
      let existing = null;
      try { existing = await artifactFiles(feature.checkout_path, artifactPaths(check.artifact_paths)); } catch { existing = null; }
      let result;
      const startedAt = now();
      try { result = await run(check.argv, { cwd: feature.checkout_path, timeoutMs: check.timeout_seconds * 1000, maxOutput: 500_000, allowFailure: true, confirmTermination: true }); }
      catch (error) {
        // A command that may still be running has not completed: it gets no receipt and keeps its clone reserved.
        if (error?.code === 'COMMAND_TERMINATION_UNCERTAIN') throw await reserveUncertainExecution(ctx, feature, check, { revision: before.head, contract, startedAt, queued: Boolean(execution.receiptId) }, error);
        result = { exitCode: null, stderr: error.message, stdout: '', durationMs: 0 };
      }
      const id = execution.receiptId ?? newId('evidence');
      try { archived = await archiveCheckArtifacts(ctx, feature, check, id, before.head, existing); artifact = archived?.manifest ?? null; }
      catch (error) { artifactError = redactString(error.message); }
      const after = await repositorySnapshot(feature.checkout_path);
      const unchanged = after.clean && after.head === before.head;
      const passed = result.exitCode === 0 && !result.timedOut && !result.overflow && unchanged && !artifactError;
      const summary = `${check.purpose}: ${passed ? 'passed' : 'failed'}${result.timedOut ? ' (timed out)' : result.overflow ? ' (output limit)' : !unchanged ? ' (checkout changed during verification)' : ` (exit ${result.exitCode ?? 'unavailable'})`}${artifactError ? ' (artifact collection failed; remaining checks stopped)' : ''}${archived?.unchanged ? ` (${archived.unchanged} archived artifact file(s) unchanged since before this run)` : ''}.`;
      // A failing receipt commits with the invalidation it causes, so a crash cannot leave its candidate standing.
      transaction(ctx.db, () => {
        ctx.db.prepare(`INSERT INTO evidence(id, feature_id, kind, summary, command, revision, passed, created_at, source, spec_revision, contract_hash, check_key, argv_json, exit_code, output, duration_ms, artifact)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'executed', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, feature.id, check.kind, summary, redactString(JSON.stringify(check.argv)), before.head, passed ? 1 : 0, now(),
          feature.spec_revision, contract, check.key, redactString(JSON.stringify(result.argv ?? check.argv)), result.exitCode ?? null,
          redactString(`${result.stdout}\n${result.stderr}${artifactError ? `\nArtifact collection failed: ${artifactError}` : ''}`).slice(-24_000), result.durationMs, artifact,
        );
        if (!passed) invalidateUnverified();
      });
      receipts.push({ id, key: check.key, passed, summary, exitCode: result.exitCode, durationMs: result.durationMs, artifact });
      if (!passed) break;
    }
    const verification = verificationStatus(ctx, featureBySlug(ctx.db, feature.slug), before.head);
    // Passing receipts can still leave this commit unverified; that is settled once the run ends.
    if (!verification.ready) transaction(ctx.db, invalidateUnverified);
    const selectedCheckKeys = selectedChecks.map(check => check.key);
    const completion = checkOutcome(selectedCheckKeys, receipts);
    recordEvent(ctx.db, { featureId: feature.id, kind: 'checks.executed', summary: `Run finished at ${before.head.slice(0, 12)}: ${receipts.length} executed, ${completion.failedCheckKeys.length} failed, ${completion.notRunCheckKeys.length} not run.`, details: { receipts: receipts.map(item => item.id), selectedCheckKeys, completion } });
    if (invalidated) await refreshLaneFiles(ctx, feature.slug);
    return { feature: feature.slug, selectedCheckKeys, receipts, completion, verification, git: await repositorySnapshot(feature.checkout_path) };
  }, execution.receiptId ? { timeoutMs: 0 } : undefined);
}

export async function readEvidence(args) {
  const root = await resolveWorkspace(args.workspace_path);
  const ctx = await loadWorkspace(root);
  try {
    const feature = featureBySlug(ctx.db, safeSlug(args.feature));
    const row = ctx.db.prepare('SELECT * FROM evidence WHERE id = ? AND feature_id = ?').get(requiredText(args.evidence_id, 'evidence_id'), feature.id);
    if (!row) throw new TheaterError('Evidence is not registered for this feature.', 'EVIDENCE_NOT_FOUND');
    return { ...row, passed: row.passed === null ? null : Boolean(row.passed), argv: parseJson(row.argv_json, null) };
  } finally { ctx.db.close(); }
}
