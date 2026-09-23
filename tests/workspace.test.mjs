import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git } from '../plugins/feature-theater/scripts/util.mjs';
import { runChecks, updateChecks } from '../plugins/feature-theater/scripts/verification.mjs';
import {
  checkpointFeature,
  createFeature,
  doctorWorkspace,
  featureRuntime,
  getFeatureContext,
  initializeManagedProject,
  initializeWorkspace,
  listFeatures,
  planWork,
  promoteManagedCandidate,
  recordCandidate,
  recordEvidence,
  resolveAgentRequestRecord,
  savePendingAgentRequest,
  setFeatureStatus,
  switchFeature,
  updateSpec,
  updateWork,
} from '../plugins/feature-theater/scripts/workspace.mjs';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-theater-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(source);
  await fs.mkdir(workspace);
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.name', 'Feature Theater Test');
  await git(source, 'config', 'user.email', 'feature-theater@example.invalid');
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2));
  await fs.writeFile(path.join(source, 'package-lock.json'), '{}\n');
  await fs.writeFile(path.join(source, 'app.js'), 'export const value = 1;\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'base');
  return { parent, source, workspace };
}

async function verifyFile(workspace, feature, file, expected) {
  await updateChecks({ workspace_path: workspace, feature, checks: [{ key: 'artifact', purpose: 'Inspect the actual committed artifact', argv: [process.execPath, '-e', `require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(file)}, 'utf8').replaceAll('\\r\\n', '\\n'), ${JSON.stringify(expected)})`] }] });
  const result = await runChecks({ workspace_path: workspace, feature });
  assert.equal(result.verification.ready, true);
}

test('initializes a repository and creates independent feature lanes', async t => {
  const { source, workspace } = await fixture(t);
  const initialized = await initializeWorkspace({ workspace_path: workspace, repository: source });
  assert.equal(initialized.initialized, true);
  assert.deepEqual(initialized.repositoryProfile.ecosystems, ['node']);
  assert.deepEqual(initialized.repositoryProfile.setupCandidates, [['npm', 'ci']]);

  const alpha = await createFeature({
    workspace_path: workspace,
    feature: 'search-redesign',
    title: 'Search redesign',
    outcome: 'Users can find a record by title.',
  });
  assert.equal(alpha.feature.status, 'active');
  assert.match(alpha.feature.branch, /^feature\/search-redesign$/);
  assert.equal((await fs.readFile(path.join(workspace, 'features', 'search-redesign', 'repo', 'app.js'), 'utf8')).replaceAll('\r\n', '\n'), 'export const value = 1;\n');
  assert.ok(await fs.stat(path.join(workspace, 'features', 'search-redesign', 'AGENTS.md')));

  const repeat = await initializeWorkspace({ workspace_path: workspace, repository: source });
  assert.equal(repeat.alreadyInitialized, true);
  const differentSource = path.join(path.dirname(source), 'different-source');
  await fs.mkdir(differentSource);
  await assert.rejects(
    initializeWorkspace({ workspace_path: workspace, repository: differentSource }),
    error => error.code === 'REPOSITORY_MISMATCH',
  );
  const listed = await listFeatures({ workspace_path: workspace, refresh_git: true });
  assert.equal(listed.workspace.focus, 'search-redesign');
  assert.equal(listed.features[0].git.clean, true);
});

test('starts from scratch and promotes an accepted candidate into the next lane base', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-theater-scratch-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  const initialized = await initializeManagedProject({
    workspace_path: workspace,
    project_name: 'Atlas',
    description: 'Help teams triage incidents.',
  });
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.workspace.managedProject.name, 'Atlas');
  const project = path.join(workspace, 'project');
  assert.equal((await git(project, 'branch', '--show-current')).stdout, 'main');
  assert.match(await fs.readFile(path.join(project, 'README.md'), 'utf8'), /triage incidents/);

  const foundation = await createFeature({
    workspace_path: workspace,
    feature: 'foundation',
    title: 'Playable foundation',
    outcome: 'Create the first executable project slice.',
    spec: '# Foundation\n\napp.txt contains the working foundation.\n',
  });
  const repo = foundation.feature.checkoutPath;
  await git(repo, 'config', 'user.name', 'Feature Theater Test');
  await git(repo, 'config', 'user.email', 'feature-theater@example.invalid');
  await fs.writeFile(path.join(repo, 'app.txt'), 'atlas foundation\n');
  await git(repo, 'add', 'app.txt');
  await git(repo, 'commit', '-m', 'Build foundation');
  const candidateRevision = (await git(repo, 'rev-parse', 'HEAD')).stdout;
  await recordEvidence({
    workspace_path: workspace,
    feature: 'foundation',
    kind: 'test',
    summary: 'Foundation fixture passed.',
    command: 'fixture assertion',
    revision: candidateRevision,
    passed: true,
  });
  await assert.rejects(recordCandidate({ workspace_path: workspace, feature: 'foundation', summary: 'Report alone', checks: ['claimed'] }), error => error.code === 'COMPLETION_NOT_PROVEN');
  await verifyFile(workspace, 'foundation', 'app.txt', 'atlas foundation\n');
  await recordCandidate({
    workspace_path: workspace,
    feature: 'foundation',
    summary: 'Foundation is ready.',
    checks: ['fixture assertion: passed'],
  });
  await setFeatureStatus({ workspace_path: workspace, feature: 'foundation', status: 'done' });

  const stale = await createFeature({
    workspace_path: workspace,
    feature: 'alternate-foundation',
    title: 'Alternate foundation',
    outcome: 'Exercise divergent-candidate protection.',
    spec: '# Alternate\n\nalternate.txt contains the alternate foundation.\n',
  });
  await git(stale.feature.checkoutPath, 'config', 'user.name', 'Feature Theater Test');
  await git(stale.feature.checkoutPath, 'config', 'user.email', 'feature-theater@example.invalid');
  await fs.writeFile(path.join(stale.feature.checkoutPath, 'alternate.txt'), 'alternate foundation\n');
  await git(stale.feature.checkoutPath, 'add', 'alternate.txt');
  await git(stale.feature.checkoutPath, 'commit', '-m', 'Build alternate foundation');
  const staleRevision = (await git(stale.feature.checkoutPath, 'rev-parse', 'HEAD')).stdout;
  await recordEvidence({
    workspace_path: workspace,
    feature: 'alternate-foundation',
    kind: 'test',
    summary: 'Alternate fixture passed.',
    command: 'fixture assertion',
    revision: staleRevision,
    passed: true,
  });
  await verifyFile(workspace, 'alternate-foundation', 'alternate.txt', 'alternate foundation\n');
  await recordCandidate({
    workspace_path: workspace,
    feature: 'alternate-foundation',
    summary: 'Alternate foundation is ready.',
    checks: ['fixture assertion: passed'],
  });
  await setFeatureStatus({ workspace_path: workspace, feature: 'alternate-foundation', status: 'done' });

  const initialProjectHead = (await git(project, 'rev-parse', 'HEAD')).stdout;
  const localNote = path.join(project, 'local-note.txt');
  await fs.writeFile(localNote, 'preserve me\n');
  await assert.rejects(
    promoteManagedCandidate({ workspace_path: workspace, feature: 'foundation' }),
    error => error.code === 'DIRTY_MANAGED_PROJECT',
  );
  assert.equal((await git(project, 'rev-parse', 'HEAD')).stdout, initialProjectHead);
  await fs.rm(localNote);

  const promoted = await promoteManagedCandidate({ workspace_path: workspace, feature: 'foundation' });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.managedProject.head, candidateRevision);
  assert.equal((await git(project, 'rev-parse', 'HEAD')).stdout, candidateRevision);
  assert.equal((await fs.readFile(path.join(project, 'app.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'atlas foundation\n');
  assert.equal((await promoteManagedCandidate({ workspace_path: workspace, feature: 'foundation' })).alreadyIncluded, true);
  await assert.rejects(
    promoteManagedCandidate({ workspace_path: workspace, feature: 'alternate-foundation' }),
    error => error.code === 'PROMOTION_NOT_FAST_FORWARD',
  );
  assert.equal((await git(project, 'rev-parse', 'HEAD')).stdout, candidateRevision);

  const next = await createFeature({
    workspace_path: workspace,
    feature: 'second-slice',
    title: 'Second slice',
    outcome: 'Build on the accepted foundation.',
  });
  assert.equal(next.feature.baseRevision, candidateRevision);
  assert.equal((await fs.readFile(path.join(next.feature.checkoutPath, 'app.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'atlas foundation\n');
});

test('versions specs, enforces the work DAG and records an exact candidate', async t => {
  const { source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  await createFeature({ workspace_path: workspace, feature: 'alpha', title: 'Alpha', outcome: 'Deliver alpha.' });
  const spec = await updateSpec({
    workspace_path: workspace,
    feature: 'alpha',
    rationale: 'Acceptance behavior is now concrete.',
    content: '# Alpha\n\n## Acceptance criteria\n\n- `value` is 2.\n',
  });
  assert.equal(spec.revision, 1);

  const plan = await planWork({
    workspace_path: workspace,
    feature: 'alpha',
    items: [
      { key: 'build', title: 'Change the value', kind: 'build', acceptance: 'value is 2' },
      { key: 'validate', title: 'Run the test', kind: 'validate', dependencies: ['build'] },
    ],
  });
  assert.equal(plan.workItems.find(item => item.item_key === 'build').status, 'ready');
  assert.equal(plan.workItems.find(item => item.item_key === 'validate').status, 'planned');
  await assert.rejects(planBELoop(workspace), /cycle/i);
  await assert.rejects(
    updateWork({ workspace_path: workspace, feature: 'alpha', key: 'validate', status: 'running', owner: 'astra' }),
    error => error.code === 'DEPENDENCY_NOT_READY',
  );

  await updateWork({ workspace_path: workspace, feature: 'alpha', key: 'build', status: 'running', owner: 'astra' });
  const repo = path.join(workspace, 'features', 'alpha', 'repo');
  await git(repo, 'config', 'user.name', 'Feature Theater Test');
  await git(repo, 'config', 'user.email', 'feature-theater@example.invalid');
  await fs.writeFile(path.join(repo, 'app.js'), 'export const value = 2;\n');
  await git(repo, 'add', 'app.js');
  await git(repo, 'commit', '-m', 'Implement alpha');
  const head = (await git(repo, 'rev-parse', 'HEAD')).stdout;
  await updateWork({ workspace_path: workspace, feature: 'alpha', key: 'build', status: 'done', owner: 'astra', summary: 'Changed the exported value.', result_revision: head });
  await assert.rejects(
    planWork({ workspace_path: workspace, feature: 'alpha', items: [{ key: 'build', title: 'Rewrite completed work', kind: 'build' }] }),
    error => error.code === 'INVALID_TRANSITION',
  );
  const context = await getFeatureContext({ workspace_path: workspace, feature: 'alpha' });
  assert.equal(context.workItems.find(item => item.item_key === 'validate').status, 'ready');

  await assert.rejects(
    recordCandidate({ workspace_path: workspace, feature: 'alpha', summary: 'Unproven candidate.', checks: ['claimed check'] }),
    error => error.code === 'COMPLETION_NOT_PROVEN',
  );

  await updateWork({ workspace_path: workspace, feature: 'alpha', key: 'validate', status: 'running', owner: 'astra' });
  await recordEvidence({ workspace_path: workspace, feature: 'alpha', work_item: 'validate', kind: 'test', summary: 'Fixture assertion passed.', command: 'node --test', revision: head, passed: true });
  await updateWork({ workspace_path: workspace, feature: 'alpha', key: 'validate', status: 'done', owner: 'astra', summary: 'Test passed.', result_revision: head });
  await verifyFile(workspace, 'alpha', 'app.js', 'export const value = 2;\n');
  const candidate = await recordCandidate({ workspace_path: workspace, feature: 'alpha', summary: 'Alpha is ready.', checks: ['node --test: passed'] });
  assert.equal(candidate.revision, head);
  const done = await setFeatureStatus({ workspace_path: workspace, feature: 'alpha', status: 'done' });
  assert.equal(done.feature.status, 'done');
  const completedContext = await getFeatureContext({ workspace_path: workspace, feature: 'alpha' });
  assert.equal(completedContext.candidates[0].status, 'accepted');
  assert.equal((await setFeatureStatus({ workspace_path: workspace, feature: 'alpha', status: 'done' })).unchanged, true);
  await assert.rejects(
    promoteManagedCandidate({ workspace_path: workspace, feature: 'alpha' }),
    error => error.code === 'NOT_MANAGED_PROJECT',
  );
});

async function planBELoop(workspace) {
  return await planWork({
    workspace_path: workspace,
    feature: 'alpha',
    items: [
      { key: 'build', title: 'Build', dependencies: ['validate'] },
      { key: 'validate', title: 'Validate', dependencies: ['build'] },
    ],
  });
}

test('checkpoints and switches focus without moving active clones', async t => {
  const { source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  await createFeature({ workspace_path: workspace, feature: 'alpha', title: 'Alpha', outcome: 'Alpha outcome.' });
  await createFeature({ workspace_path: workspace, feature: 'beta', title: 'Beta', outcome: 'Beta outcome.' });
  await checkpointFeature({ workspace_path: workspace, feature: 'alpha', summary: 'Alpha is scoped.', next_action: 'Implement alpha.', unresolved: ['Choose copy.'] });
  await updateSpec({ workspace_path: workspace, feature: 'alpha', content: '# Alpha\n\nRevised after checkpoint.\n', rationale: 'Exercise checkpoint freshness.' });
  await assert.rejects(
    switchFeature({ workspace_path: workspace, feature: 'beta' }),
    error => error.code === 'CHECKPOINT_REQUIRED',
  );
  await checkpointFeature({ workspace_path: workspace, feature: 'alpha', summary: 'Alpha spec is revised.', next_action: 'Implement revised alpha.', unresolved: ['Choose copy.'] });
  const switched = await switchFeature({ workspace_path: workspace, feature: 'beta' });
  assert.equal(switched.focus, 'beta');
  assert.equal(switched.coordinatorCompactionRecommended, true);
  assert.ok(await fs.stat(path.join(workspace, 'features', 'alpha', 'repo', '.git')));
  assert.ok(await fs.stat(path.join(workspace, 'features', 'beta', 'repo', '.git')));
  const index = await fs.readFile(path.join(workspace, '.theater', 'index.md'), 'utf8');
  assert.match(index, /Focused feature: beta/);
});

// A frozen clock gives every change the checkpoint's millisecond, so only the semantic generation can tell them apart.
const freezeClock = t => t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

function switchRequiresCheckpoint(workspace, feature, reason = 'changed') {
  return assert.rejects(
    switchFeature({ workspace_path: workspace, feature }),
    error => error.code === 'CHECKPOINT_REQUIRED' && error.details.reason === reason,
  );
}

test('keeps checkpoints fresh across focus round-trips until the lane changes, even when timestamps tie', async t => {
  const { source, workspace } = await fixture(t);
  freezeClock(t);
  const alpha = { workspace_path: workspace, feature: 'alpha' };
  const roundTrip = async () => {
    assert.equal((await switchFeature({ workspace_path: workspace, feature: 'beta' })).focus, 'beta');
    assert.equal((await switchFeature(alpha)).focus, 'alpha');
  };
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  await createFeature({ ...alpha, title: 'Alpha', outcome: 'Alpha outcome.' });
  await createFeature({ workspace_path: workspace, feature: 'beta', title: 'Beta', outcome: 'Beta outcome.' });
  await switchFeature(alpha);
  await checkpointFeature({ ...alpha, summary: 'Alpha is scoped.', next_action: 'Implement alpha.' });
  const toBeta = await switchFeature({ workspace_path: workspace, feature: 'beta' });
  assert.equal(toBeta.from.compactionPending, true);
  await checkpointFeature({ workspace_path: workspace, feature: 'beta', summary: 'Beta is scoped.', next_action: 'Implement beta.' });
  assert.equal((await switchFeature(alpha)).focus, 'alpha');
  await roundTrip();

  const spec = { ...alpha, content: '# Alpha\n\nRevised after round-trip.\n', rationale: 'Exercise checkpoint freshness.' };
  await updateSpec(spec);
  await switchRequiresCheckpoint(workspace, 'beta');
  await checkpointFeature({ ...alpha, summary: 'Alpha spec is revised.', next_action: 'Implement revised alpha.' });
  assert.equal((await updateSpec(spec)).changed, false);
  await roundTrip();

  const plan = { ...alpha, items: [{ key: 'build', title: 'Build' }] };
  await planWork(plan);
  await switchRequiresCheckpoint(workspace, 'beta');
  // Re-planning overwrites the checkpoint's direction with the graph default; only an identical result is a no-op.
  const { feature: planned } = await getFeatureContext(alpha);
  await checkpointFeature({ ...alpha, summary: 'Alpha is planned.', next_action: planned.nextAction });
  await planWork(plan);
  await roundTrip();
  await checkpointFeature({ ...alpha, summary: 'Alpha is planned.', next_action: 'Build alpha.' });
  await planWork(plan);
  await switchRequiresCheckpoint(workspace, 'beta');
  await checkpointFeature({ ...alpha, summary: 'Alpha is planned.', next_action: 'Build alpha.' });

  const claim = { ...alpha, key: 'build', status: 'running', owner: 'worker' };
  await updateWork(claim);
  await switchRequiresCheckpoint(workspace, 'beta');
  await checkpointFeature({ ...alpha, summary: 'Alpha build is claimed.', next_action: 'Await the build.' });
  // Renewing the lease is bookkeeping, not a lane change.
  await updateWork(claim);
  await roundTrip();

  await checkpointFeature({ ...alpha, summary: 'First tied checkpoint.', next_action: 'Continue.' });
  await checkpointFeature({ ...alpha, summary: 'Second tied checkpoint.', next_action: 'Continue.' });
  const context = await getFeatureContext({ ...alpha, timeline_limit: 200 });
  assert.equal(context.checkpoint.summary, 'Second tied checkpoint.');
  assert.equal(new Set(context.timeline.map(event => event.createdAt)).size, 1);
  await roundTrip();

  // Repairing inconsistent readiness on a read is still a work-status change.
  await planWork({ ...alpha, items: [{ key: 'docs', title: 'Docs' }] });
  await checkpointFeature({ ...alpha, summary: 'Docs are planned.', next_action: 'Continue.' });
  const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  db.prepare("UPDATE work_items SET status = 'planned' WHERE item_key = 'docs'").run();
  db.close();
  assert.equal((await getFeatureContext(alpha)).workItems.find(item => item.item_key === 'docs').status, 'ready');
  await switchRequiresCheckpoint(workspace, 'beta');
});

test('verification reopens a checkpointed lane only when it supersedes a candidate', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-freshness-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  freezeClock(t);
  const alpha = { workspace_path: workspace, feature: 'alpha' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Freshness', description: 'Exercise verification freshness.' });
  const lane = await createFeature({ ...alpha, title: 'Alpha', outcome: 'Verified behavior.', spec: '# Alpha\n\nThe README exists.' });
  await createFeature({ workspace_path: workspace, feature: 'beta', title: 'Beta', outcome: 'Beta outcome.' });
  const failMarker = path.join(lane.feature.checkoutPath, '.check-fails');
  await fs.appendFile(path.join(lane.feature.checkoutPath, '.git', 'info', 'exclude'), '\n.check-fails\n');
  const checks = [{ key: 'actual', purpose: 'Read the committed README and fixture state', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md'); if (require('node:fs').existsSync('.check-fails')) process.exit(7)"] }];
  await updateChecks({ ...alpha, checks });
  await switchFeature(alpha);
  assert.equal((await runChecks(alpha)).verification.ready, true);
  await recordCandidate({ ...alpha, summary: 'Ready.', checks: ['README receipt'] });
  await checkpointFeature({ ...alpha, summary: 'Candidate awaits review.', next_action: 'Review the candidate.' });

  // A passing receipt is live evidence only.
  assert.equal((await runChecks(alpha)).verification.ready, true);
  assert.equal((await switchFeature({ workspace_path: workspace, feature: 'beta' })).focus, 'beta');
  await switchFeature(alpha);

  await fs.writeFile(failMarker, 'fail');
  assert.equal((await runChecks(alpha)).verification.ready, false);
  assert.equal((await getFeatureContext(alpha)).feature.status, 'active');
  await switchRequiresCheckpoint(workspace, 'beta');
  await checkpointFeature({ ...alpha, summary: 'Candidate was superseded by a failing check.', next_action: 'Repair alpha.' });

  // With nothing left to supersede, a failing receipt alone changes no lane state.
  assert.equal((await runChecks(alpha)).verification.ready, false);
  assert.equal((await switchFeature({ workspace_path: workspace, feature: 'beta' })).focus, 'beta');
  await switchFeature(alpha);

  await updateChecks({ ...alpha, checks: [{ ...checks[0], purpose: 'Read the README with a revised purpose' }] });
  await switchRequiresCheckpoint(workspace, 'beta');
});

test('checkpoints saved before semantic generations must be renewed after upgrade', async t => {
  const { source, workspace } = await fixture(t);
  freezeClock(t);
  const alpha = { workspace_path: workspace, feature: 'alpha' };
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  await createFeature({ ...alpha, title: 'Alpha', outcome: 'Alpha outcome.' });
  await createFeature({ workspace_path: workspace, feature: 'beta', title: 'Beta', outcome: 'Beta outcome.' });
  await switchFeature(alpha);
  await checkpointFeature({ ...alpha, summary: 'Saved by schema 4.', next_action: 'Continue.' });
  const file = path.join(workspace, '.theater', 'state.sqlite3');
  let db = new DatabaseSync(file);
  const { id } = db.prepare('SELECT id FROM features WHERE slug = ?').get('alpha');
  db.exec('ALTER TABLE checkpoints DROP COLUMN semantic_generation; ALTER TABLE features DROP COLUMN semantic_generation');
  // A session of unknown backend with a request would be reclassified by the schema-3 backfill.
  db.prepare("UPDATE features SET thread_id = 'unknown-thread', thread_harness = NULL WHERE id = ?").run(id);
  db.prepare("INSERT INTO pending_agent_requests(request_id, feature_id, thread_id, method, summary, payload_json, status, created_at, resolved_at) VALUES ('old', ?, 'unknown-thread', 'item/tool/requestUserInput', 'Old request.', '{}', 'resolved', ?, ?)").run(id, new Date().toISOString(), new Date().toISOString());
  db.exec("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
  db.close();

  await switchRequiresCheckpoint(workspace, 'beta', 'legacy_checkpoint');
  db = new DatabaseSync(file);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '5');
  assert.deepEqual({ ...db.prepare('SELECT semantic_generation, thread_harness FROM features WHERE id = ?').get(id) }, { semantic_generation: 0, thread_harness: null });
  db.close();
  assert.equal((await checkpointFeature({ ...alpha, summary: 'Renewed after upgrade.', next_action: 'Continue.' })).semanticGeneration, 0);
  assert.equal((await switchFeature({ workspace_path: workspace, feature: 'beta' })).focus, 'beta');
});

const ARCHIVED = 'None. The lane is archived; its disposition records what shipped or remains.';

async function directions(workspace, feature) {
  const listed = (await listFeatures({ workspace_path: workspace, include_archived: true })).features.find(item => item.slug === feature);
  const packet = await fs.readFile(path.join(workspace, '.theater', 'features', feature, 'context.md'), 'utf8');
  const index = await fs.readFile(path.join(workspace, '.theater', 'index.md'), 'utf8');
  return {
    get: (await getFeatureContext({ workspace_path: workspace, feature })).feature.nextAction,
    list: listed.nextAction,
    context: packet.match(/^Next action: (.*)$/m)[1],
    index: index.split('\n').find(line => line.includes(`| ${feature} |`)).split('|').at(-2).trim(),
  };
}

function agreeOn(observed, action) {
  assert.deepEqual(observed, { get: action, list: action, context: action, index: action });
}

test('archiving gives unused and reviewed lanes a terminal direction that a later checkpoint can replace', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-theater-archive-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const unused = { workspace_path: workspace, feature: 'unused' };
  const reviewed = { workspace_path: workspace, feature: 'reviewed' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Archive', description: 'Exercise archived direction.' });
  await createFeature({ ...unused, title: 'Unused', outcome: 'Never started.', spec: '# Unused\n\nNothing yet.' });
  agreeOn(await directions(workspace, 'unused'), 'Plan the first bounded work from the accepted spec.');

  assert.equal((await setFeatureStatus({ ...unused, status: 'archived', disposition: 'Dropped before work.' })).feature.nextAction, ARCHIVED);
  agreeOn(await directions(workspace, 'unused'), ARCHIVED);
  await checkpointFeature({ ...unused, summary: 'Historical note.', next_action: 'Revive only after the parser rewrite lands.' });
  const repeated = await setFeatureStatus({ ...unused, status: 'archived', disposition: 'Dropped again.' });
  assert.equal(repeated.unchanged, true);
  agreeOn(await directions(workspace, 'unused'), 'Revive only after the parser rewrite lands.');

  await createFeature({ ...reviewed, title: 'Reviewed', outcome: 'A reviewed candidate.', spec: '# Reviewed\n\nThe README exists.' });
  await updateChecks({ ...reviewed, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(reviewed)).verification.ready, true);
  await recordCandidate({ ...reviewed, summary: 'Ready.', checks: ['readme receipt'] });
  await setFeatureStatus({ ...reviewed, status: 'archived', disposition: 'Superseded by another lane.' });
  agreeOn(await directions(workspace, 'reviewed'), ARCHIVED);
  // Reactivation replaces only the terminal text; the candidate still awaits review.
  assert.equal((await setFeatureStatus({ ...reviewed, status: 'active' })).feature.nextAction, 'Review or integrate the exact recorded candidate.');
  assert.equal((await setFeatureStatus({ ...unused, status: 'active' })).feature.nextAction, 'Revive only after the parser rewrite lands.');
});

test('rejects repository URLs containing credentials', async t => {
  const { workspace } = await fixture(t);
  await assert.rejects(initializeWorkspace({ workspace_path: workspace, repository: 'https://user:secret@example.com/repo.git' }), /embedded credentials/i);
});

test('scopes reusable app-server request ids to their feature lane', async t => {
  const { source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  await createFeature({ workspace_path: workspace, feature: 'alpha', title: 'Alpha', outcome: 'Alpha outcome.' });
  await createFeature({ workspace_path: workspace, feature: 'beta', title: 'Beta', outcome: 'Beta outcome.' });
  for (const feature of ['alpha', 'beta']) {
    await savePendingAgentRequest({
      workspace_path: workspace,
      feature,
      request_id: 1,
      thread_id: `thread-${feature}`,
      turn_id: `turn-${feature}`,
      method: 'item/tool/requestUserInput',
      summary: `${feature} needs input.`,
      payload: { feature },
    });
  }
  assert.equal((await getFeatureContext({ workspace_path: workspace, feature: 'alpha' })).pendingAgentRequests.length, 1);
  assert.equal((await getFeatureContext({ workspace_path: workspace, feature: 'beta' })).pendingAgentRequests.length, 1);
  await resolveAgentRequestRecord({ workspace_path: workspace, feature: 'alpha', request_id: 1, summary: 'Old request expired.', status: 'orphaned' });
  assert.equal((await getFeatureContext({ workspace_path: workspace, feature: 'alpha' })).pendingAgentRequests.length, 0);
  assert.equal((await getFeatureContext({ workspace_path: workspace, feature: 'beta' })).pendingAgentRequests.length, 1);
});

test('binds lanes to the current workspace after a copy, rename or linked path', async t => {
  const { parent, source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  await createFeature({ workspace_path: workspace, feature: 'lane', outcome: 'Stays inside its own workspace.', spec: '# Lane' });
  await createFeature({ workspace_path: workspace, feature: 'linked', outcome: 'Refuses a linked lane path.' });
  // The check leaves a marker beside the clone it actually ran in.
  await updateChecks({ workspace_path: workspace, feature: 'lane', checks: [{ key: 'marker', purpose: 'Show which clone executes', argv: [process.execPath, '-e', "require('node:fs').appendFileSync(require('node:path').join(process.cwd(), '..', 'ran.txt'), 'x')"] }] });
  const marker = root => path.join(root, 'features', 'lane', 'ran.txt');
  const mismatch = error => error.code === 'CHECKOUT_LOCATION_MISMATCH';

  assert.equal((await runChecks({ workspace_path: workspace, feature: 'lane' })).verification.ready, true);
  await fs.rm(marker(workspace));

  const copy = path.join(parent, 'copy');
  await fs.cp(workspace, copy, { recursive: true, verbatimSymlinks: true });
  await assert.rejects(getFeatureContext({ workspace_path: copy, feature: 'lane' }), mismatch);
  await assert.rejects(runChecks({ workspace_path: copy, feature: 'lane' }), mismatch);
  await assert.rejects(featureRuntime({ workspace_path: copy, feature: 'lane' }), mismatch);
  await assert.rejects(checkpointFeature({ workspace_path: copy, feature: 'lane', summary: 'Copied.', next_action: 'None.' }), mismatch);
  await assert.rejects(createFeature({ workspace_path: copy, feature: 'derived', outcome: 'Borrows a base.', base_feature: 'lane', base_revision: (await git(path.join(workspace, 'features', 'lane', 'repo'), 'rev-parse', 'HEAD')).stdout }), mismatch);
  assert.equal(await fs.stat(marker(workspace)).catch(() => null), null);
  assert.equal(await fs.stat(marker(copy)).catch(() => null), null);
  const copied = (await listFeatures({ workspace_path: copy, refresh_git: true })).features.find(item => item.slug === 'lane');
  assert.equal(copied.checkoutLocation.bound, false);
  assert.equal(path.relative(await fs.realpath(copy), copied.checkoutPath), path.join('features', 'lane', 'repo'));
  assert.equal(path.resolve(copied.checkoutLocation.recordedPath), path.resolve(await fs.realpath(workspace), 'features', 'lane', 'repo'));
  assert.match(copied.git.error, /not bound to this workspace/);
  const copyDoctor = (await doctorWorkspace({ workspace_path: copy })).checks.find(check => check.name === 'Feature paths');
  assert.equal(copyDoctor.ok, false);
  assert.match(copyDoctor.detail, /2 of 2 lane\(s\) not bound/);

  // The original is untouched and still fully usable.
  assert.equal((await getFeatureContext({ workspace_path: workspace, feature: 'lane' })).feature.checkoutLocation, undefined);
  assert.equal((await doctorWorkspace({ workspace_path: workspace })).checks.find(check => check.name === 'Feature paths').ok, true);

  const renamed = path.join(parent, 'renamed');
  await fs.rename(workspace, renamed);
  await assert.rejects(getFeatureContext({ workspace_path: renamed, feature: 'lane' }), mismatch);
  await assert.rejects(runChecks({ workspace_path: renamed, feature: 'lane' }), mismatch);
  await fs.rename(renamed, workspace);
  assert.equal((await runChecks({ workspace_path: workspace, feature: 'lane' })).verification.ready, true);
  assert.equal(await fs.readFile(marker(workspace), 'utf8'), 'x');

  const outside = path.join(parent, 'outside-linked');
  await fs.rename(path.join(workspace, 'features', 'linked'), outside);
  await fs.symlink(outside, path.join(workspace, 'features', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(getFeatureContext({ workspace_path: workspace, feature: 'linked' }), error => mismatch(error) && /symlink or junction/.test(error.message));
  await assert.rejects(featureRuntime({ workspace_path: workspace, feature: 'linked' }), mismatch);
  assert.equal((await getFeatureContext({ workspace_path: workspace, feature: 'lane' })).feature.slug, 'lane');
});
