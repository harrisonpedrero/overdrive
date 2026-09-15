import { createHash } from 'node:crypto';
import { checkOutcome } from './check-outcome.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertCheckReservation, featureBySlug, loadWorkspace, meta, newId, parseJson, recordEvent, transaction, workItems } from './state.mjs';
import { repositorySnapshot } from './git.mjs';
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
const bindingKey = (featureId, contract) => `verification-contract:${featureId}:${contract}`;

export function featureContract(db, feature) {
  return fingerprint(contractDefinition(db, feature));
}

function checkBindings(definition) {
  const { checks, ...inputs } = definition;
  return Object.fromEntries(checks.map(({ reuse_same_revision: _policy, ...check }) => [check.key, fingerprint({ version: 1, ...inputs, check })]));
}

function captureContract(db, feature, definition) {
  const contract = fingerprint(definition);
  const key = bindingKey(feature.id, contract);
  // The exact full hash binds legacy receipts to this snapshot without rewriting their evidence.
  if (!meta(db, key)) meta(db, key, JSON.stringify({ version: 1, checks: checkBindings(definition) }));
  return contract;
}

export function assertAgentIdle(feature) {
  if (feature.active_turn_id || ['starting', 'running', 'compacting', 'waiting_for_user'].includes(feature.agent_status)) {
    throw new TheaterError('Wait for the feature agent to stop before changing its contract or verifying a candidate.', 'AGENT_BUSY');
  }
}

export function invalidateCandidates(db, featureId) {
  db.prepare("UPDATE candidates SET status = 'superseded' WHERE feature_id = ? AND status IN ('ready','accepted')").run(featureId);
  db.prepare("UPDATE features SET status = CASE WHEN status IN ('done','review') THEN 'active' ELSE status END WHERE id = ?").run(featureId);
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
  return { contractHash: contract, specRevision: feature.spec_revision, revision, ready: feature.spec_revision > 0 && required.length > 0 && required.every(check => check.status === 'passed'), checks };
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

async function archiveCheckArtifacts(ctx, feature, check, id, revision) {
  const paths = artifactPaths(check.artifact_paths);
  if (!paths.length) return null;
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
  const manifest = path.join(directory, 'manifest.json');
  await atomicWrite(ctx.root, manifest, `${JSON.stringify({ evidenceId: id, checkKey: check.key, revision, collectedAt: now(), paths }, null, 2)}\n`);
  return manifest;
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
    const paths = artifactPaths(check.artifact_paths);
    return { key, argv: check.argv, purpose: requiredText(check.purpose, 'purpose', { max: 2000 }), kind: requiredText(check.kind ?? 'test', 'check kind', { max: 80 }), required: check.required !== false, timeout_seconds: timeout, ...(paths.length ? { artifact_paths: paths } : {}), ...(check.reuse_same_revision ? { reuse_same_revision: true } : {}) };
  }).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(checks.map(check => check.key)).size !== checks.length) throw new TheaterError('Check keys must be unique.', 'INVALID_INPUT');
  return withFeature(args, async (ctx, feature) => {
    assertAgentIdle(feature);
    const changed = JSON.stringify(featureChecks(ctx.db, feature.id)) !== JSON.stringify(checks);
    if (changed) transaction(ctx.db, () => {
      captureContract(ctx.db, feature, contractDefinition(ctx.db, feature));
      meta(ctx.db, `checks:${feature.id}`, JSON.stringify(checks));
      invalidateCandidates(ctx.db, feature.id);
      ctx.db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(now(), feature.id);
      recordEvent(ctx.db, { featureId: feature.id, kind: 'checks.updated', summary: `Configured ${checks.length} verification command(s).` });
    });
    return { feature: feature.slug, changed, checks, contractHash: featureContract(ctx.db, feature) };
  });
}

export async function runChecks(args, execution = {}) {
  return withFeature(args, async (ctx, feature) => {
    assertCheckReservation(ctx.db, feature.id, execution.receiptId);
    assertAgentIdle(feature);
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
    const receipts = [];
    for (const check of selectedChecks) {
      let result;
      try { result = await run(check.argv, { cwd: feature.checkout_path, timeoutMs: check.timeout_seconds * 1000, maxOutput: 500_000, allowFailure: true }); }
      catch (error) { result = { exitCode: null, stderr: error.message, stdout: '', durationMs: 0 }; }
      const id = execution.receiptId ?? newId('evidence');
      let artifact = null;
      let artifactError = null;
      try { artifact = await archiveCheckArtifacts(ctx, feature, check, id, before.head); }
      catch (error) { artifactError = redactString(error.message); }
      const after = await repositorySnapshot(feature.checkout_path);
      const unchanged = after.clean && after.head === before.head;
      const passed = result.exitCode === 0 && !result.timedOut && !result.overflow && unchanged && !artifactError;
      const summary = `${check.purpose}: ${passed ? 'passed' : 'failed'}${result.timedOut ? ' (timed out)' : result.overflow ? ' (output limit)' : !unchanged ? ' (checkout changed during verification)' : ` (exit ${result.exitCode ?? 'unavailable'})`}${artifactError ? ' (artifact collection failed; remaining checks stopped)' : ''}.`;
      ctx.db.prepare(`INSERT INTO evidence(id, feature_id, kind, summary, command, revision, passed, created_at, source, spec_revision, contract_hash, check_key, argv_json, exit_code, output, duration_ms, artifact)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'executed', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, feature.id, check.kind, summary, redactString(JSON.stringify(check.argv)), before.head, passed ? 1 : 0, now(),
        feature.spec_revision, contract, check.key, redactString(JSON.stringify(result.argv ?? check.argv)), result.exitCode ?? null,
        redactString(`${result.stdout}\n${result.stderr}${artifactError ? `\nArtifact collection failed: ${artifactError}` : ''}`).slice(-24_000), result.durationMs, artifact,
      );
      receipts.push({ id, key: check.key, passed, summary, exitCode: result.exitCode, durationMs: result.durationMs, artifact });
      if (!passed) break;
    }
    const verification = verificationStatus(ctx, featureBySlug(ctx.db, feature.slug), before.head);
    if (!verification.ready) invalidateCandidates(ctx.db, feature.id);
    const selectedCheckKeys = selectedChecks.map(check => check.key);
    const completion = checkOutcome(selectedCheckKeys, receipts);
    recordEvent(ctx.db, { featureId: feature.id, kind: 'checks.executed', summary: `Run finished at ${before.head.slice(0, 12)}: ${receipts.length} executed, ${completion.failedCheckKeys.length} failed, ${completion.notRunCheckKeys.length} not run.`, details: { receipts: receipts.map(item => item.id), selectedCheckKeys, completion } });
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
