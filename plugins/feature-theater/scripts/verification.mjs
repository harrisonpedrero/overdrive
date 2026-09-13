import { createHash } from 'node:crypto';
import { featureBySlug, loadWorkspace, meta, newId, parseJson, recordEvent, transaction, workItems } from './state.mjs';
import { repositorySnapshot } from './git.mjs';
import { TheaterError, now, redactString, requiredText, resolveWorkspace, run, safeSlug, withWorkspaceLock } from './util.mjs';

export function featureChecks(db, featureId) {
  return parseJson(meta(db, `checks:${featureId}`), []);
}

export function featureContract(db, feature) {
  const work = workItems(db, feature.id).map(item => ({
    key: item.item_key, title: item.title, description: item.description,
    acceptance: item.acceptance, kind: item.kind, dependencies: item.dependencies,
  })).sort((a, b) => a.key.localeCompare(b.key));
  const spec = db.prepare('SELECT content FROM spec_revisions WHERE feature_id = ? AND revision = ?').get(feature.id, feature.spec_revision)?.content ?? '';
  return createHash('sha256').update(JSON.stringify({ specRevision: feature.spec_revision, spec, work, checks: featureChecks(db, feature.id) })).digest('hex');
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
  const contract = featureContract(ctx.db, feature);
  const checks = featureChecks(ctx.db, feature.id).map(check => {
    const receipt = ctx.db.prepare(`SELECT id, passed, summary, created_at, exit_code, duration_ms FROM evidence
      WHERE feature_id = ? AND source = 'executed' AND check_key = ? AND revision = ? AND contract_hash = ?
      ORDER BY rowid DESC LIMIT 1`).get(feature.id, check.key, revision ?? '', contract);
    return { ...check, status: receipt ? receipt.passed ? 'passed' : 'failed' : 'missing', receipt: receipt ?? null };
  });
  const required = checks.filter(check => check.required);
  return { contractHash: contract, specRevision: feature.spec_revision, revision, ready: feature.spec_revision > 0 && required.length > 0 && required.every(check => check.status === 'passed'), checks };
}

export function assertVerified(ctx, feature, revision, candidate = null) {
  const verification = verificationStatus(ctx, feature, revision);
  if (candidate && (candidate.contract_hash !== verification.contractHash || candidate.spec_revision !== feature.spec_revision)) {
    throw new TheaterError('Candidate was verified against an older feature contract. Run current checks and record a fresh candidate.', 'STALE_CONTRACT');
  }
  if (!verification.ready) {
    throw new TheaterError('Completion requires a saved specification and passing runtime receipts for every current required check at this commit.', 'COMPLETION_NOT_PROVEN', verification);
  }
  return verification;
}

async function withFeature(args, fn) {
  const root = await resolveWorkspace(args.workspace_path);
  return withWorkspaceLock(root, `control-${safeSlug(args.feature)}`, async () => {
    const ctx = await loadWorkspace(root);
    try { return await fn(ctx, featureBySlug(ctx.db, safeSlug(args.feature))); }
    finally { ctx.db.close(); }
  });
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
    return { key, argv: check.argv, purpose: requiredText(check.purpose, 'purpose', { max: 2000 }), kind: requiredText(check.kind ?? 'test', 'check kind', { max: 80 }), required: check.required !== false, timeout_seconds: timeout };
  }).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(checks.map(check => check.key)).size !== checks.length) throw new TheaterError('Check keys must be unique.', 'INVALID_INPUT');
  return withFeature(args, async (ctx, feature) => {
    assertAgentIdle(feature);
    const changed = JSON.stringify(featureChecks(ctx.db, feature.id)) !== JSON.stringify(checks);
    if (changed) transaction(ctx.db, () => {
      meta(ctx.db, `checks:${feature.id}`, JSON.stringify(checks));
      invalidateCandidates(ctx.db, feature.id);
      ctx.db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(now(), feature.id);
      recordEvent(ctx.db, { featureId: feature.id, kind: 'checks.updated', summary: `Configured ${checks.length} verification command(s).` });
    });
    return { feature: feature.slug, changed, checks, contractHash: featureContract(ctx.db, feature) };
  });
}

export async function runChecks(args) {
  return withFeature(args, async (ctx, feature) => {
    assertAgentIdle(feature);
    const checks = featureChecks(ctx.db, feature.id);
    if (!checks.length) throw new TheaterError('Configure meaningful verification commands first.', 'CHECKS_REQUIRED');
    const before = await repositorySnapshot(feature.checkout_path);
    if (!before.clean) throw new TheaterError('Commit the candidate before running recorded checks.', 'DIRTY_CANDIDATE');
    const contract = featureContract(ctx.db, feature);
    const receipts = [];
    for (const check of checks) {
      let result;
      try { result = await run(check.argv, { cwd: feature.checkout_path, timeoutMs: check.timeout_seconds * 1000, maxOutput: 500_000, allowFailure: true }); }
      catch (error) { result = { exitCode: null, stderr: error.message, stdout: '', durationMs: 0 }; }
      const after = await repositorySnapshot(feature.checkout_path);
      const unchanged = after.clean && after.head === before.head;
      const passed = result.exitCode === 0 && !result.timedOut && !result.overflow && unchanged;
      const summary = `${check.purpose}: ${passed ? 'passed' : 'failed'}${result.timedOut ? ' (timed out)' : result.overflow ? ' (output limit)' : !unchanged ? ' (checkout changed during verification)' : ` (exit ${result.exitCode ?? 'unavailable'})`}.`;
      const id = newId('evidence');
      ctx.db.prepare(`INSERT INTO evidence(id, feature_id, kind, summary, command, revision, passed, created_at, source, spec_revision, contract_hash, check_key, argv_json, exit_code, output, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'executed', ?, ?, ?, ?, ?, ?, ?)`).run(
        id, feature.id, check.kind, summary, redactString(JSON.stringify(check.argv)), before.head, passed ? 1 : 0, now(),
        feature.spec_revision, contract, check.key, redactString(JSON.stringify(result.argv ?? check.argv)), result.exitCode ?? null,
        redactString(`${result.stdout}\n${result.stderr}`).slice(-24_000), result.durationMs,
      );
      receipts.push({ id, key: check.key, passed, summary, exitCode: result.exitCode, durationMs: result.durationMs });
      if (!unchanged) break;
    }
    const verification = verificationStatus(ctx, featureBySlug(ctx.db, feature.slug), before.head);
    if (!verification.ready) invalidateCandidates(ctx.db, feature.id);
    recordEvent(ctx.db, { featureId: feature.id, kind: 'checks.executed', summary: `${receipts.filter(item => item.passed).length}/${receipts.length} command(s) passed at ${before.head.slice(0, 12)}.`, details: { receipts: receipts.map(item => item.id) } });
    return { feature: feature.slug, receipts, verification, git: await repositorySnapshot(feature.checkout_path) };
  });
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
