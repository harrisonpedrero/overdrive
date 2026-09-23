import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../plugins/feature-theater/scripts/agent-runtime.mjs';
import { WorkerBridge } from '../plugins/feature-theater/scripts/app-server.mjs';
import { callTool } from '../plugins/feature-theater/scripts/tools.mjs';
import { git, withWorkspaceLock } from '../plugins/feature-theater/scripts/util.mjs';
import { runChecks, updateChecks } from '../plugins/feature-theater/scripts/verification.mjs';
import { initializeManagedProject, createFeature, recordCandidate, setFeatureStatus, updateSpec, getFeatureContext, listFeatures } from '../plugins/feature-theater/scripts/workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('every accepted slug length acquires its own control lock for checks, candidates and agent turns', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-long-slug-'));
  const runtime = createAgentRuntime(new WorkerBridge({ claude: { launch: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-claude-cli.mjs')] } } }));
  t.after(async () => {
    await runtime.shutdownAgentRuntime();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  });
  await callTool('theater_project_create', { workspace_path: workspace, project_name: 'Long slugs', description: 'Exercise slug boundaries.', harness: 'claude' });
  const slug = (length, lead = 'l') => `${lead}${'a'.repeat(length - 1)}`;
  const slugs = [slug(55), slug(56), slug(63), slug(63, 'm')];
  assert.deepEqual(slugs.map(value => value.length), [55, 56, 63, 63]);
  for (const feature of slugs) {
    const args = { workspace_path: workspace, feature };
    await callTool('theater_feature_create', { ...args, title: `Length ${feature.length}`, outcome: 'Operates under its control lock.', spec: '# Long\n\nThe README exists.' });
    await callTool('theater_checks_update', { ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
    assert.equal((await callTool('theater_checks_run', args)).verification.ready, true);
    await callTool('theater_candidate_record', { ...args, summary: 'Ready.', checks: ['README receipt'] });
    const started = await runtime.startFeatureAgent({ ...args, instruction: 'Write one file.' });
    assert.ok(started.threadId);
    for (let attempt = 0; (await getFeatureContext(args)).feature.agent.status !== 'idle'; attempt++) {
      assert.ok(attempt < 200, `agent for ${feature.length}-character slug did not finish`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok((await getFeatureContext(args)).candidates.length > 0);
  }

  // Slugs sharing their first 55 characters keep distinct locks: one lane's lock never blocks another.
  const [, , first, second] = slugs;
  assert.equal(await withWorkspaceLock(workspace, `control-${first}`, () => withWorkspaceLock(workspace, `control-${first.slice(0, 55)}`, () =>
    withWorkspaceLock(workspace, `control-${second}`, () => 'distinct', { timeoutMs: 300 }), { timeoutMs: 300 })), 'distinct');
  await assert.rejects(withWorkspaceLock(workspace, `control-${first}`, () => withWorkspaceLock(workspace, `control-${first}`, () => {}, { timeoutMs: 300 })), error => error.code === 'WORKSPACE_BUSY');

  for (const name of ['features', 'agent-state', 'verification-queue', slug(63), `control-${slug(1)}`]) assert.equal(await withWorkspaceLock(workspace, name, () => name), name);
  for (const name of [slug(64), `control-${slug(64)}`, `xontrol-${slug(63)}`, `control-1${'a'.repeat(62)}`, `control-${slug(63).toUpperCase()}`, `control--${slug(62)}`, '', 'Features', '-x', '1x', 'control-../x', 'control-a/b', 'a.b', 'a b', `control-${slug(3)}\n`, 42, null]) {
    await assert.rejects(withWorkspaceLock(workspace, name, () => assert.fail(`lock ${JSON.stringify(name)} ran`)), error => error.code === 'INVALID_LOCK', JSON.stringify(name));
  }
  for (const [feature, code] of [[slug(64), 'INVALID_INPUT'], [`${slug(30)}--${slug(31)}`, 'INVALID_SLUG'], [`1${slug(62)}`, 'INVALID_SLUG']]) {
    const refused = { workspace_path: workspace, feature };
    await assert.rejects(callTool('theater_feature_create', { ...refused, title: 'Refused', outcome: 'Refused.', spec: '# Refused' }), error => error.code === code, feature);
    await assert.rejects(callTool('theater_checks_update', { ...refused, checks: [] }), error => error.code === code, feature);
    await assert.rejects(callTool('theater_candidate_record', { ...refused, summary: 'No lane.', checks: [] }), error => error.code === code, feature);
    await assert.rejects(runtime.startFeatureAgent(refused), error => error.code === code, feature);
  }
});

test('latest required receipt and current specification gate delivery; dirty checks cannot pass', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-evidence-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'alpha' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Evidence', description: 'Exercise actual receipt gates.' });
  const lane = await createFeature({ ...args, title: 'Alpha', outcome: 'Verified behavior.', spec: '# Alpha\n\nThe README exists.' });
  const repo = lane.feature.checkoutPath;
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.check-fails\n');
  await updateChecks({ ...args, checks: [{ key: 'actual', purpose: 'Read the committed README and fixture state', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md'); if (require('node:fs').existsSync('.check-fails')) process.exit(7)"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  await setFeatureStatus({ ...args, status: 'done' });
  await fs.writeFile(path.join(repo, '.check-fails'), 'fail');
  assert.equal((await runChecks(args)).verification.ready, false);
  await assert.rejects(recordCandidate({ ...args, summary: 'Stale pass.', checks: ['old receipt'] }), error => error.code === 'COMPLETION_NOT_PROVEN');
  await fs.rm(path.join(repo, '.check-fails'));
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready again.', checks: ['current receipt'] });
  await setFeatureStatus({ ...args, status: 'done' });
  await updateSpec({ ...args, content: '# Alpha\n\nThe README must also describe startup.', rationale: 'New acceptance behavior.' });
  assert.equal((await getFeatureContext(args)).feature.status, 'active');
  await assert.rejects(recordCandidate({ ...args, summary: 'Old contract.', checks: ['old receipt'] }), error => error.code === 'COMPLETION_NOT_PROVEN');
  await updateChecks({ ...args, checks: [{ key: 'mutating', purpose: 'Detect a check that changes source', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('unexpected.txt', 'mutated')"] }] });
  const changed = await runChecks(args);
  assert.equal(changed.receipts[0].passed, false);
  assert.match(changed.receipts[0].summary, /checkout changed/);
  assert.equal((await git(repo, 'status', '--porcelain')).stdout.includes('unexpected.txt'), true);
});

test('an archived lane refuses candidates until it is explicitly reactivated', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-archived-candidate-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'shelved' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Archive', description: 'Archive stays terminal.' });
  await createFeature({ ...args, title: 'Shelved', outcome: 'Stays archived.', spec: '# Shelved\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  await setFeatureStatus({ ...args, status: 'archived', disposition: 'Shelved without integration.' });
  const archived = await getFeatureContext(args);
  assert.equal(archived.verification.ready, true);
  await assert.rejects(recordCandidate({ ...args, summary: 'Sneak back in.', checks: ['README receipt'] }), error => error.code === 'INVALID_TRANSITION' && /archived/.test(error.message) && /reactivate/i.test(error.message));
  const after = await getFeatureContext(args);
  assert.equal(after.feature.status, 'archived');
  assert.equal(after.feature.summary, archived.feature.summary);
  assert.equal(after.feature.nextAction, archived.feature.nextAction);
  assert.deepEqual(after.candidates, archived.candidates);
  assert.equal((await listFeatures({ workspace_path: workspace })).features.some(feature => feature.slug === 'shelved'), false);
  await setFeatureStatus({ ...args, status: 'active' });
  const reopened = await recordCandidate({ ...args, summary: 'Ready after reactivation.', checks: ['README receipt'] });
  assert.equal(reopened.feature.status, 'review');
  assert.equal((await listFeatures({ workspace_path: workspace })).features.some(feature => feature.slug === 'shelved'), true);
});

test('a paused lane refuses candidates until it is explicitly resumed', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-paused-candidate-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'held' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Pause', description: 'Pause stays a boundary.' });
  await createFeature({ ...args, title: 'Held', outcome: 'Stays paused.', spec: '# Held\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  await setFeatureStatus({ ...args, status: 'paused' });
  const paused = await getFeatureContext(args);
  assert.equal(paused.verification.ready, true);
  await assert.rejects(recordCandidate({ ...args, summary: 'Slip past the pause.', checks: ['README receipt'] }), error => error.code === 'INVALID_TRANSITION' && /paused/.test(error.message) && /resume/i.test(error.message));
  const after = await getFeatureContext(args);
  assert.equal(after.feature.status, 'paused');
  assert.equal(after.feature.summary, paused.feature.summary);
  assert.equal(after.feature.nextAction, paused.feature.nextAction);
  assert.deepEqual(after.candidates, paused.candidates);
  assert.deepEqual(after.timeline, paused.timeline);
  await setFeatureStatus({ ...args, status: 'active' });
  const resumed = await recordCandidate({ ...args, summary: 'Ready after resuming.', checks: ['README receipt'] });
  assert.equal(resumed.feature.status, 'review');
  const reviewed = await getFeatureContext(args);
  assert.equal(reviewed.candidates.filter(candidate => candidate.status === 'ready').length, 1);
  assert.equal(reviewed.candidates.find(candidate => candidate.status === 'ready').summary, 'Ready after resuming.');
});

test('checks execute in saved order and reordering changes the contract', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-order-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'order' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Order', description: 'Setup precedes dependent checks.' });
  const lane = await createFeature({ ...args, title: 'Order', outcome: 'Setup runs first.', spec: '# Order\n\nSetup precedes tests.' });
  const repo = lane.feature.checkoutPath;
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.prepared\n');
  const prepare = { key: 'z-prepare', purpose: 'Prepare ignored output', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('.prepared', 'ok')"] };
  const dependent = { key: 'a-test', purpose: 'Use prepared output', argv: [process.execPath, '-e', "require('node:fs').readFileSync('.prepared')"] };
  const saved = await updateChecks({ ...args, checks: [prepare, dependent] });
  assert.deepEqual(saved.checks.map(check => check.key), ['z-prepare', 'a-test']);
  const full = await runChecks(args);
  assert.deepEqual(full.receipts.map(receipt => [receipt.key, receipt.passed]), [['z-prepare', true], ['a-test', true]]);
  assert.equal(full.verification.ready, true);
  assert.deepEqual(full.verification.checks.map(check => check.key), ['z-prepare', 'a-test']);
  await fs.rm(path.join(repo, '.prepared'));
  const selected = await runChecks({ ...args, check_keys: ['a-test', 'z-prepare'] });
  assert.deepEqual(selected.receipts.map(receipt => [receipt.key, receipt.passed]), [['z-prepare', true], ['a-test', true]]);
  const unchanged = await updateChecks({ ...args, checks: [prepare, dependent] });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.contractHash, saved.contractHash);
  const reordered = await updateChecks({ ...args, checks: [dependent, prepare] });
  assert.equal(reordered.changed, true);
  assert.notEqual(reordered.contractHash, saved.contractHash);
  assert.deepEqual((await getFeatureContext(args)).verification.checks.map(check => [check.key, check.status]), [['a-test', 'missing'], ['z-prepare', 'missing']]);
  await fs.rm(path.join(repo, '.prepared'));
  const stopped = await runChecks(args);
  assert.deepEqual(stopped.receipts.map(receipt => [receipt.key, receipt.passed]), [['a-test', false]]);
  assert.deepEqual(stopped.completion.notRunCheckKeys, ['z-prepare']);
  assert.equal(stopped.verification.ready, false);
});

test('version-2 data migrates without turning historical claims into current proof', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-migration-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'legacy' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Legacy', description: 'Preserve history.' });
  const lane = await createFeature({ ...args, title: 'Legacy', outcome: 'Preserve historical work.', spec: '# Legacy\n\nOriginal intent.' });
  const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  const feature = db.prepare('SELECT * FROM features WHERE slug = ?').get('legacy');
  db.prepare("INSERT INTO evidence(id, feature_id, kind, summary, revision, passed, created_at) VALUES ('old-evidence', ?, 'test', 'Previously reported pass', ?, 1, ?)").run(feature.id, lane.feature.baseRevision, new Date().toISOString());
  db.prepare("INSERT INTO candidates(id, feature_id, revision, base_revision, summary, checks_json, status, created_at) VALUES ('old-candidate', ?, ?, ?, 'Old accepted candidate', '[]', 'accepted', ?)").run(feature.id, lane.feature.baseRevision, lane.feature.baseRevision, new Date().toISOString());
  db.prepare("UPDATE features SET status = 'done' WHERE id = ?").run(feature.id);
  for (const column of ['source', 'spec_revision', 'contract_hash', 'check_key', 'argv_json', 'exit_code', 'output', 'duration_ms']) db.exec(`ALTER TABLE evidence DROP COLUMN ${column}`);
  for (const column of ['spec_revision', 'contract_hash']) db.exec(`ALTER TABLE candidates DROP COLUMN ${column}`);
  db.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  db.close();
  const context = await getFeatureContext(args);
  assert.equal(context.feature.status, 'active');
  assert.equal(context.candidates[0].status, 'superseded');
  assert.equal(context.evidence[0].source, 'reported');
  assert.equal(context.verification.ready, false);
  await fs.writeFile(path.join(workspace, '.theater', 'features', 'legacy', 'spec.md'), 'STALE PROJECTION');
  await getFeatureContext(args);
  assert.match(await fs.readFile(path.join(workspace, '.theater', 'features', 'legacy', 'spec.md'), 'utf8'), /Original intent/);
});
