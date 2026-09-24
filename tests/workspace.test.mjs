import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('an invalid spec is rejected before any feature clone and a corrected retry succeeds', async t => {
  const { source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const alpha = { workspace_path: workspace, feature: 'alpha', title: 'Alpha', outcome: 'Reject the spec first.' };
  await assert.rejects(createFeature({ ...alpha, spec: ' \n\t ' }), error => error.code === 'INVALID_INPUT' && /spec/.test(error.message));
  await assert.rejects(fs.stat(path.join(workspace, 'features', 'alpha')), error => error.code === 'ENOENT');
  assert.deepEqual((await listFeatures({ workspace_path: workspace })).features, []);

  const created = await createFeature({ ...alpha, spec: '# Alpha\n\nAccepted on retry.' });
  assert.equal(created.feature.slug, 'alpha');
  assert.equal(created.feature.specRevision, 1);
  assert.equal(await fs.readFile(created.specPath, 'utf8'), '# Alpha\n\nAccepted on retry.\n');
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
  // A done lane gains no running claim, even from a reclaimable item a legacy build left behind.
  const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  try { db.prepare("UPDATE work_items SET status = 'failed', blocker = 'Legacy failure.' WHERE item_key = 'validate'").run(); } finally { db.close(); }
  await assert.rejects(
    updateWork({ workspace_path: workspace, feature: 'alpha', key: 'validate', status: 'running', owner: 'astra' }),
    error => error.code === 'INVALID_TRANSITION' && error.message.includes('alpha is done'),
  );
  const refusedContext = await getFeatureContext({ workspace_path: workspace, feature: 'alpha' });
  assert.equal(refusedContext.feature.status, 'done');
  assert.equal(refusedContext.workItems.find(item => item.item_key === 'validate').status, 'failed');
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

test('renewing running work without new text keeps its saved progress and checkpoint', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-renewal-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  freezeClock(t);
  const alpha = { workspace_path: workspace, feature: 'alpha' };
  const beta = { workspace_path: workspace, feature: 'beta' };
  const build = async () => (await getFeatureContext(alpha)).workItems.find(item => item.item_key === 'build');
  const generation = () => {
    const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'), { readOnly: true });
    try { return Number(db.prepare("SELECT semantic_generation FROM features WHERE slug = 'alpha'").get().semantic_generation); } finally { db.close(); }
  };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Renewal', description: 'Exercise lease renewal.' });
  await createFeature({ ...alpha, title: 'Alpha', outcome: 'Alpha outcome.' });
  await createFeature({ ...beta, title: 'Beta', outcome: 'Beta outcome.' });
  await switchFeature(alpha);
  await planWork({ ...alpha, items: [{ key: 'build', title: 'Build' }] });
  const claim = { ...alpha, key: 'build', status: 'running', owner: 'worker' };
  await updateWork({ ...claim, summary: 'Implementation underway', blocker: 'Waiting on a fixture.' });
  await checkpointFeature({ ...alpha, summary: 'Build is running.', next_action: 'Await the build.' });
  const checkpointed = generation();

  const renewed = await updateWork(claim);
  assert.equal(renewed.item.result_summary, 'Implementation underway');
  assert.equal(renewed.item.blocker, 'Waiting on a fixture.');
  assert.equal(generation(), checkpointed);
  const { timeline } = await getFeatureContext(alpha);
  assert.equal(timeline[0].summary, 'build is running: Implementation underway');
  assert.equal((await switchFeature(beta)).focus, 'beta');
  assert.equal((await switchFeature(alpha)).focus, 'alpha');

  await updateWork({ ...claim, summary: 'Parser is done.' });
  assert.equal((await build()).result_summary, 'Parser is done.');
  assert.equal((await build()).blocker, 'Waiting on a fixture.');
  await switchRequiresCheckpoint(workspace, 'beta');
  await checkpointFeature({ ...alpha, summary: 'Parser is done.', next_action: 'Finish the build.' });
  await updateWork({ ...claim, blocker: 'Waiting on review.' });
  assert.equal((await build()).result_summary, 'Parser is done.');
  assert.equal((await build()).blocker, 'Waiting on review.');
  assert.equal((await getFeatureContext(alpha)).timeline[0].summary, 'build is running: blocker: Waiting on review.');
  await switchRequiresCheckpoint(workspace, 'beta');

  // Blank text still clears, and another owner taking over an expired lease starts fresh.
  await updateWork({ ...claim, summary: '', blocker: null });
  assert.equal((await build()).result_summary, '');
  assert.equal((await build()).blocker, '');
  await updateWork({ ...claim, summary: 'Half done.', blocker: 'Waiting on a fixture.', lease_seconds: 60 });
  t.mock.timers.tick(61_000);
  const takeover = await updateWork({ ...claim, owner: 'relief' });
  assert.equal(takeover.item.owner, 'relief');
  assert.equal(takeover.item.result_summary, '');
  assert.equal(takeover.item.blocker, '');
});

test('paused and archived lanes refuse new running claims but keep renewal and outcome bookkeeping', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-inactive-claim-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  freezeClock(t);
  const alpha = { workspace_path: workspace, feature: 'alpha' };
  const item = async key => (await getFeatureContext(alpha)).workItems.find(candidate => candidate.item_key === key);
  // Everything a refused claim must leave untouched, read without rewriting the packet.
  const laneState = async () => {
    const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'), { readOnly: true });
    try {
      const feature = db.prepare("SELECT id, status, next_action, semantic_generation, updated_at FROM features WHERE slug = 'alpha'").get();
      return {
        feature: { ...feature },
        work: db.prepare('SELECT item_key, status, owner, result_summary, blocker, lease_expires_at, updated_at FROM work_items WHERE feature_id = ? ORDER BY item_key').all(feature.id).map(row => ({ ...row })),
        events: Number(db.prepare('SELECT COUNT(*) AS count FROM events WHERE feature_id = ?').get(feature.id).count),
        packet: await fs.readFile(path.join(workspace, '.theater', 'features', 'alpha', 'context.md'), 'utf8'),
      };
    } finally { db.close(); }
  };
  const refused = async (update, status) => {
    const before = await laneState();
    await assert.rejects(updateWork({ ...alpha, ...update, status: 'running' }), error => error.code === 'INVALID_TRANSITION' && error.message.includes(`alpha is ${status}`));
    assert.deepEqual(await laneState(), before);
  };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Inactive', description: 'Exercise inactive-lane claims.' });
  await createFeature({ ...alpha, title: 'Alpha', outcome: 'Alpha outcome.' });
  await createFeature({ workspace_path: workspace, feature: 'beta', title: 'Beta', outcome: 'Beta outcome.' });
  await planWork({ ...alpha, items: ['build', 'docs', 'extra'].map(key => ({ key, title: key })) });
  const build = { key: 'build', owner: 'worker' };
  await updateWork({ ...alpha, ...build, status: 'running', summary: 'Parser underway.', lease_seconds: 60 });
  await updateWork({ ...alpha, key: 'docs', status: 'running', owner: 'writer' });
  await setFeatureStatus({ ...alpha, status: 'paused' });

  // A paused lane refuses a fresh claim and a takeover of an expired lease by another owner.
  await refused({ key: 'extra', owner: 'intruder' }, 'paused');
  t.mock.timers.tick(61_000);
  await refused({ key: 'build', owner: 'relief' }, 'paused');

  // Its current owner still renews, keeping saved text without a semantic change.
  const generation = (await laneState()).feature.semantic_generation;
  const renewed = await updateWork({ ...alpha, ...build, status: 'running' });
  assert.equal(renewed.feature.status, 'paused');
  assert.equal(renewed.item.owner, 'worker');
  assert.equal(renewed.item.result_summary, 'Parser underway.');
  assert.ok(renewed.item.lease_expires_at > new Date().toISOString());
  assert.equal((await laneState()).feature.semantic_generation, generation);

  // A stopped worker's outcome is still recorded, but blocked work is not reclaimed while paused.
  assert.equal((await updateWork({ ...alpha, key: 'docs', owner: 'writer', status: 'done', summary: 'Docs written.' })).item.status, 'done');
  assert.equal((await updateWork({ ...alpha, ...build, status: 'blocked', blocker: 'Needs the fixture.' })).item.status, 'blocked');
  await refused(build, 'paused');
  assert.equal((await item('extra')).status, 'ready');

  // Resuming restores normal claims.
  await setFeatureStatus({ ...alpha, status: 'active' });
  assert.equal((await updateWork({ ...alpha, key: 'extra', status: 'running', owner: 'intruder' })).item.owner, 'intruder');
  assert.equal((await updateWork({ ...alpha, ...build, status: 'running' })).item.status, 'running');

  // An archived lane refuses every running update, including its owner's renewal.
  await setFeatureStatus({ ...alpha, status: 'archived', disposition: 'Shelved.' });
  await planWork({ ...alpha, items: [{ key: 'later', title: 'later' }] });
  assert.equal((await item('later')).status, 'ready');
  await refused({ key: 'later', owner: 'intruder' }, 'archived');
  await refused(build, 'archived');
  assert.equal((await updateWork({ ...alpha, key: 'extra', owner: 'intruder', status: 'failed', blocker: 'Shelved mid-run.' })).item.status, 'failed');
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
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '6');
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
  // Older archives kept the candidate review text; it reads as archived until a checkpoint follows.
  const review = 'Review or integrate the exact recorded candidate.';
  const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  db.prepare("UPDATE features SET next_action = ? WHERE slug = 'reviewed'").run(review);
  db.close();
  assert.equal((await getFeatureContext(reviewed)).feature.nextAction, ARCHIVED);
  assert.equal((await listFeatures({ workspace_path: workspace, include_archived: true })).features.find(item => item.slug === 'reviewed').nextAction, ARCHIVED);
  await checkpointFeature({ ...reviewed, summary: 'Candidate kept for a later decision.', next_action: review });
  assert.equal((await setFeatureStatus({ ...reviewed, status: 'archived', disposition: 'Still superseded.' })).unchanged, true);
  agreeOn(await directions(workspace, 'reviewed'), review);
  // Reactivation replaces only the terminal text; the candidate still awaits review.
  assert.equal((await setFeatureStatus({ ...reviewed, status: 'active' })).feature.nextAction, 'Review or integrate the exact recorded candidate.');
  assert.equal((await setFeatureStatus({ ...unused, status: 'active' })).feature.nextAction, 'Revive only after the parser rewrite lands.');
});

test('spec and work edits keep an archived lane archived until it is reactivated', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-theater-archive-edit-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const lane = { workspace_path: workspace, feature: 'edited' };
  const noted = { workspace_path: workspace, feature: 'noted' };
  const plan = [{ key: 'readme', title: 'Write the README' }];
  const inspect = slug => {
    const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
    try {
      const row = db.prepare('SELECT id, spec_revision, semantic_generation FROM features WHERE slug = ?').get(slug);
      const candidates = db.prepare('SELECT status FROM candidates WHERE feature_id = ?').all(row.id).map(candidate => candidate.status);
      return { spec: Number(row.spec_revision), generation: Number(row.semantic_generation), candidates };
    } finally { db.close(); }
  };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Archive edits', description: 'Exercise edits to archived lanes.' });
  await createFeature({ ...lane, title: 'Edited', outcome: 'A reviewed candidate.', spec: '# Edited\n\nThe README exists.' });
  await planWork({ ...lane, items: plan });
  await updateChecks({ ...lane, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(lane)).verification.ready, true);
  await recordCandidate({ ...lane, summary: 'Ready.', checks: ['readme receipt'] });
  await setFeatureStatus({ ...lane, status: 'archived', disposition: 'Superseded by another lane.' });
  agreeOn(await directions(workspace, 'edited'), ARCHIVED);

  // Resubmitting the same plan is no lane change and keeps the terminal direction.
  const archived = inspect('edited');
  const resubmitted = await planWork({ ...lane, items: plan });
  assert.equal(resubmitted.feature.nextAction, ARCHIVED);
  assert.match(resubmitted.next, /reactivate/i);
  assert.doesNotMatch(resubmitted.next, /Claim/);
  assert.deepEqual(inspect('edited'), archived);
  agreeOn(await directions(workspace, 'edited'), ARCHIVED);

  // Legacy archives stored the candidate review text; an unchanged plan still reads as archived.
  const review = 'Review or integrate the exact recorded candidate.';
  const ready = 'Start or continue the highest-priority ready work.';
  const legacyArchive = async disposition => {
    await setFeatureStatus({ ...lane, status: 'archived', disposition });
    const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
    db.prepare("UPDATE features SET next_action = ? WHERE slug = 'edited'").run(review);
    db.close();
  };
  const recordReady = async () => {
    assert.equal((await runChecks(lane)).verification.ready, true);
    await recordCandidate({ ...lane, summary: 'Ready.', checks: ['readme receipt'] });
  };
  await setFeatureStatus({ ...lane, status: 'active' });
  await legacyArchive('Superseded by another lane.');
  await planWork({ ...lane, items: plan });
  agreeOn(await directions(workspace, 'edited'), ARCHIVED);
  assert.equal((await setFeatureStatus({ ...lane, status: 'active' })).feature.nextAction, review);
  await legacyArchive('Superseded again.');

  // A spec revision still supersedes the candidate and advances the lane, but not its direction.
  const beforeSpec = inspect('edited');
  assert.equal((await updateSpec({ ...lane, content: '# Edited\n\nThe README also describes startup.', rationale: 'Historical correction.' })).changed, true);
  const revised = inspect('edited');
  assert.equal(revised.spec, beforeSpec.spec + 1);
  assert.ok(revised.generation > beforeSpec.generation);
  assert.deepEqual(revised.candidates, ['superseded']);
  agreeOn(await directions(workspace, 'edited'), ARCHIVED);
  const followUp = await planWork({ ...lane, items: [...plan, { key: 'startup', title: 'Describe startup' }] });
  assert.match(followUp.next, /reactivate/i);
  assert.ok(inspect('edited').generation > revised.generation);
  agreeOn(await directions(workspace, 'edited'), ARCHIVED);
  // Reactivation restores work-graph guidance; the superseded candidate no longer awaits review.
  assert.equal((await setFeatureStatus({ ...lane, status: 'active' })).feature.nextAction, ready);
  assert.match((await planWork({ ...lane, items: plan })).next, /^Claim/);

  // So does a contract edit that supersedes a later candidate of a legacy archive.
  await recordReady();
  await legacyArchive('Superseded once more.');
  await planWork({ ...lane, items: [{ key: 'docs', title: 'Document startup' }] });
  assert.deepEqual(inspect('edited').candidates, ['superseded', 'superseded']);
  agreeOn(await directions(workspace, 'edited'), ARCHIVED);
  assert.equal((await setFeatureStatus({ ...lane, status: 'active' })).feature.nextAction, ready);

  // A checkpoint that explicitly saved the review text after archival stays authoritative.
  await recordReady();
  await setFeatureStatus({ ...lane, status: 'archived', disposition: 'Kept for a later decision.' });
  await checkpointFeature({ ...lane, summary: 'Candidate kept for a later decision.', next_action: review });
  await updateSpec({ ...lane, content: '# Edited\n\nThe README also describes shutdown.', rationale: 'Historical correction.' });
  assert.deepEqual(inspect('edited').candidates, ['superseded', 'superseded', 'superseded']);
  agreeOn(await directions(workspace, 'edited'), review);
  assert.equal((await setFeatureStatus({ ...lane, status: 'active' })).feature.nextAction, review);

  // An explicit checkpoint saved after archival survives later spec and work edits and reactivation.
  const note = 'Revive only after the parser rewrite lands.';
  await createFeature({ ...noted, title: 'Noted', outcome: 'Parked work.', spec: '# Noted\n\nNothing yet.' });
  await planWork({ ...noted, items: plan });
  await setFeatureStatus({ ...noted, status: 'archived', disposition: 'Parked.' });
  await checkpointFeature({ ...noted, summary: 'Historical note.', next_action: note });
  await planWork({ ...noted, items: plan });
  agreeOn(await directions(workspace, 'noted'), note);
  await updateSpec({ ...noted, content: '# Noted\n\nParser first.', rationale: 'Record the dependency.' });
  agreeOn(await directions(workspace, 'noted'), note);
  await planWork({ ...noted, items: [...plan, { key: 'parser', title: 'Adopt the parser' }] });
  agreeOn(await directions(workspace, 'noted'), note);
  assert.equal((await setFeatureStatus({ ...noted, status: 'active' })).feature.nextAction, note);
  const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  const events = db.prepare("SELECT kind FROM events WHERE feature_id = (SELECT id FROM features WHERE slug = 'noted') ORDER BY id").all().map(event => event.kind);
  db.close();
  assert.deepEqual(events.slice(-6), ['feature.archived', 'feature.checkpointed', 'work.planned', 'spec.revised', 'work.planned', 'feature.active']);
});

const PAUSED = 'Paused. Resume the lane with theater_feature_status (status active) before claiming or dispatching work.';
const READY = 'Start or continue the highest-priority ready work.';
const REVIEW = 'Review or integrate the exact recorded candidate.';
const pausedThen = next => `${PAUSED} Then: ${next}`;

function storedDirection(workspace, slug) {
  const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  try {
    const row = db.prepare('SELECT id, next_action, semantic_generation FROM features WHERE slug = ?').get(slug);
    return { feature: row.next_action, checkpoint: db.prepare('SELECT next_action FROM checkpoints WHERE feature_id = ? ORDER BY rowid DESC LIMIT 1').get(row.id).next_action, generation: Number(row.semantic_generation) };
  } finally { db.close(); }
}

// The persisted packet and index as written, read before any call that could rewrite them.
async function persisted(workspace, feature) {
  const packet = await fs.readFile(path.join(workspace, '.theater', 'features', feature, 'context.md'), 'utf8');
  const index = await fs.readFile(path.join(workspace, '.theater', 'index.md'), 'utf8');
  return {
    context: packet.match(/^Next action: (.*)$/m)[1],
    index: index.split('\n').find(line => line.includes(`| ${feature} |`)).split('|').at(-2).trim(),
  };
}

test('a paused lane directs resuming first while its edits keep the post-resume direction', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-theater-pause-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const lane = { workspace_path: workspace, feature: 'held' };
  const plan = [{ key: 'readme', title: 'Write the README' }];
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Pause', description: 'Exercise paused direction.' });
  await createFeature({ ...lane, title: 'Held', outcome: 'A documented project.', spec: '# Held\n\nThe README exists.' });
  await planWork({ ...lane, items: plan });
  agreeOn(await directions(workspace, 'held'), READY);

  assert.equal((await setFeatureStatus({ ...lane, status: 'paused' })).feature.nextAction, pausedThen(READY));
  agreeOn(await directions(workspace, 'held'), pausedThen(READY));

  // Spec, plan and work edits stay durable and keep deriving the post-resume direction beneath.
  assert.equal((await updateSpec({ ...lane, content: '# Held\n\nThe README also describes startup.', rationale: 'Scope startup.' })).changed, true);
  agreeOn(await directions(workspace, 'held'), pausedThen('Reconcile the work graph with the revised specification.'));
  const planned = await planWork({ ...lane, items: [...plan, { key: 'startup', title: 'Describe startup' }] });
  assert.match(planned.next, /held is paused; resume it/);
  assert.doesNotMatch(planned.next, /^Claim/);
  assert.deepEqual(planned.workItems.map(item => item.item_key), ['readme', 'startup']);
  agreeOn(await directions(workspace, 'held'), pausedThen(READY));
  await updateWork({ ...lane, key: 'readme', status: 'blocked', blocker: 'Needs the parser.' });
  await updateWork({ ...lane, key: 'startup', status: 'blocked', blocker: 'Needs the parser.' });
  const stuck = 'Resolve blocked readme: Needs the parser. (+1 more blocked or failed)';
  agreeOn(await directions(workspace, 'held'), pausedThen(stuck));
  assert.equal(storedDirection(workspace, 'held').feature, stuck);

  // Explicit checkpoint guidance is shown after the resume instruction, and an echo is not wrapped twice.
  const note = 'Adopt the parser, then unblock readme.';
  await checkpointFeature({ ...lane, summary: 'Waiting on the parser.', next_action: note });
  agreeOn(await directions(workspace, 'held'), pausedThen(note));
  await checkpointFeature({ ...lane, summary: 'Still waiting on the parser.', next_action: pausedThen(note) });
  agreeOn(await directions(workspace, 'held'), pausedThen(note));
  assert.deepEqual(storedDirection(workspace, 'held'), { ...storedDirection(workspace, 'held'), feature: note, checkpoint: note });
  // Only that exact projected form is unwrapped; other text that begins like it is saved as written.
  const logs = `${PAUSED} Also check the parser logs.`;
  await checkpointFeature({ ...lane, summary: 'Still waiting on the parser.', next_action: logs });
  assert.equal(storedDirection(workspace, 'held').feature, logs);
  await checkpointFeature({ ...lane, summary: 'Still waiting on the parser.', next_action: note });
  assert.equal((await setFeatureStatus({ ...lane, status: 'active' })).feature.nextAction, note);
  agreeOn(await directions(workspace, 'held'), note);
  // An active lane unwraps nothing, even text in the projected paused form.
  const quoted = pausedThen(note);
  await checkpointFeature({ ...lane, summary: 'Quoting the earlier pause.', next_action: quoted });
  assert.deepEqual(storedDirection(workspace, 'held'), { ...storedDirection(workspace, 'held'), feature: quoted, checkpoint: quoted });
  agreeOn(await directions(workspace, 'held'), quoted);

  // Echoing the bare resume instruction leaves nothing beyond resuming; pausing again keeps that
  // guidance and changes nothing, and resuming then derives direction.
  await setFeatureStatus({ ...lane, status: 'paused' });
  await checkpointFeature({ ...lane, summary: 'Parked.', next_action: PAUSED });
  agreeOn(await directions(workspace, 'held'), PAUSED);
  const parked = storedDirection(workspace, 'held');
  assert.equal(parked.feature, PAUSED);
  assert.equal((await setFeatureStatus({ ...lane, status: 'paused' })).feature.nextAction, PAUSED);
  assert.deepEqual(storedDirection(workspace, 'held'), parked);
  agreeOn(await directions(workspace, 'held'), PAUSED);
  assert.equal((await setFeatureStatus({ ...lane, status: 'active' })).feature.nextAction, stuck);

  // Leaving a pause for any other status ends the resume-first projection; archiving stays terminal.
  await setFeatureStatus({ ...lane, status: 'paused' });
  assert.equal((await setFeatureStatus({ ...lane, status: 'blocked', blocker: 'Waiting on the parser.' })).feature.nextAction, stuck);
  await setFeatureStatus({ ...lane, status: 'paused' });
  assert.equal((await setFeatureStatus({ ...lane, status: 'archived', disposition: 'Parked for the parser.' })).feature.nextAction, ARCHIVED);
  assert.equal((await setFeatureStatus({ ...lane, status: 'paused' })).feature.nextAction, pausedThen(stuck));
  agreeOn(await directions(workspace, 'held'), pausedThen(stuck));
  await setFeatureStatus({ ...lane, status: 'active' });
  await updateWork({ ...lane, key: 'readme', status: 'ready' });
  assert.match((await planWork({ ...lane, items: plan })).next, /^Claim/);
});

test('resuming a paused lane drops review direction only for a candidate superseded while paused', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-theater-pause-review-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const check = purpose => [{ key: 'readme', purpose, argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md'); if (require('node:fs').existsSync('.check-fails')) process.exit(7)"] }];
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Pause review', description: 'Exercise paused candidate review.' });
  const reviewed = async slug => {
    const lane = { workspace_path: workspace, feature: slug };
    const created = await createFeature({ ...lane, title: slug, outcome: 'A reviewed candidate.', spec: '# Reviewed\n\nThe README exists.' });
    await fs.appendFile(path.join(created.feature.checkoutPath, '.git', 'info', 'exclude'), '\n.check-fails\n');
    await planWork({ ...lane, items: [{ key: 'readme', title: 'Write the README' }] });
    await updateChecks({ ...lane, checks: check('Read the committed README') });
    assert.equal((await runChecks(lane)).verification.ready, true);
    await recordCandidate({ ...lane, summary: 'Ready.', checks: ['readme receipt'] });
    return lane;
  };

  // While its candidate is still ready, a paused lane resumes to review it.
  const held = await reviewed('held');
  assert.equal((await setFeatureStatus({ ...held, status: 'paused' })).feature.nextAction, pausedThen(REVIEW));
  assert.equal((await setFeatureStatus({ ...held, status: 'active' })).feature.nextAction, REVIEW);
  await setFeatureStatus({ ...held, status: 'paused' });
  // A contract change supersedes the candidate; the generated review text no longer applies.
  await updateChecks({ ...held, checks: check('Read the README, revised') });
  // Verification rewrites the persisted packet and index itself.
  assert.deepEqual(await persisted(workspace, 'held'), { context: PAUSED, index: PAUSED });
  assert.equal((await getFeatureContext(held)).feature.status, 'paused');
  agreeOn(await directions(workspace, 'held'), PAUSED);
  assert.equal((await setFeatureStatus({ ...held, status: 'active' })).feature.nextAction, READY);
  agreeOn(await directions(workspace, 'held'), READY);

  // Review text that a checkpoint saved deliberately stays authoritative.
  const kept = await reviewed('kept');
  await setFeatureStatus({ ...kept, status: 'paused' });
  await checkpointFeature({ ...kept, summary: 'Candidate kept for a later decision.', next_action: REVIEW });
  await updateChecks({ ...kept, checks: check('Read the README, revised') });
  assert.deepEqual(await persisted(workspace, 'kept'), { context: pausedThen(REVIEW), index: pausedThen(REVIEW) });
  agreeOn(await directions(workspace, 'kept'), pausedThen(REVIEW));
  assert.equal((await setFeatureStatus({ ...kept, status: 'active' })).feature.nextAction, REVIEW);

  // A checkpoint saved before an archive does not; reactivation regenerated that review text.
  const revived = await reviewed('revived');
  await checkpointFeature({ ...revived, summary: 'Candidate kept for a later decision.', next_action: REVIEW });
  await setFeatureStatus({ ...revived, status: 'archived', disposition: 'Shelved.' });
  assert.equal((await setFeatureStatus({ ...revived, status: 'active' })).feature.nextAction, REVIEW);
  await setFeatureStatus({ ...revived, status: 'paused' });
  await updateChecks({ ...revived, checks: check('Read the README, revised') });
  assert.deepEqual(await persisted(workspace, 'revived'), { context: PAUSED, index: PAUSED });
  agreeOn(await directions(workspace, 'revived'), PAUSED);
  assert.equal(storedDirection(workspace, 'revived').feature, REVIEW);
  assert.equal((await setFeatureStatus({ ...revived, status: 'active' })).feature.nextAction, READY);
  agreeOn(await directions(workspace, 'revived'), READY);
  // One saved after the archive is deliberate and survives the pause, the change and resuming.
  const shelved = await reviewed('shelved');
  await setFeatureStatus({ ...shelved, status: 'archived', disposition: 'Shelved.' });
  await checkpointFeature({ ...shelved, summary: 'Candidate kept for a later decision.', next_action: REVIEW });
  assert.equal((await setFeatureStatus({ ...shelved, status: 'active' })).feature.nextAction, REVIEW);
  await setFeatureStatus({ ...shelved, status: 'paused' });
  await updateChecks({ ...shelved, checks: check('Read the README, revised') });
  assert.deepEqual(await persisted(workspace, 'shelved'), { context: pausedThen(REVIEW), index: pausedThen(REVIEW) });
  agreeOn(await directions(workspace, 'shelved'), pausedThen(REVIEW));
  assert.equal((await setFeatureStatus({ ...shelved, status: 'active' })).feature.nextAction, REVIEW);
  agreeOn(await directions(workspace, 'shelved'), REVIEW);

  // A failing check run supersedes the candidate the same way and rewrites the persisted surfaces.
  const failing = await reviewed('failing');
  await setFeatureStatus({ ...failing, status: 'paused' });
  await fs.writeFile(path.join(workspace, 'features', 'failing', 'repo', '.check-fails'), 'fail');
  assert.equal((await runChecks(failing)).verification.ready, false);
  assert.deepEqual(await persisted(workspace, 'failing'), { context: PAUSED, index: PAUSED });
  agreeOn(await directions(workspace, 'failing'), PAUSED);
  assert.equal((await setFeatureStatus({ ...failing, status: 'active' })).feature.nextAction, READY);
});

test('superseding a candidate retires only its generated review direction on active, review, done and blocked lanes', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feature-theater-superseded-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const check = purpose => [{ key: 'readme', purpose, argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md'); if (require('node:fs').existsSync('.check-fails')) process.exit(7)"] }];
  const revised = check('Read the README, revised');
  const settled = 'Planned work is settled; verify the lane result, then record a candidate or plan follow-up work.';
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Superseded', description: 'Exercise superseded candidate direction.' });
  const reviewed = async (slug, beforeCandidate = async () => {}) => {
    const lane = { workspace_path: workspace, feature: slug };
    const created = await createFeature({ ...lane, title: slug, outcome: 'A reviewed candidate.', spec: '# Reviewed\n\nThe README exists.' });
    await fs.appendFile(path.join(created.feature.checkoutPath, '.git', 'info', 'exclude'), '\n.check-fails\n');
    await planWork({ ...lane, items: [{ key: 'readme', title: 'Write the README' }] });
    await beforeCandidate(lane);
    await updateChecks({ ...lane, checks: check('Read the committed README') });
    assert.equal((await runChecks(lane)).verification.ready, true);
    await recordCandidate({ ...lane, summary: 'Ready.', checks: ['readme receipt'] });
    return lane;
  };
  const candidates = slug => {
    const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
    try { return db.prepare('SELECT c.status FROM candidates c JOIN features f ON f.id = c.feature_id WHERE f.slug = ? ORDER BY c.rowid').all(slug).map(row => row.status); }
    finally { db.close(); }
  };
  // Verification rewrites the saved packet and index itself; read them before anything else can.
  const saved = async slug => {
    const packet = await fs.readFile(path.join(workspace, '.theater', 'features', slug, 'context.md'), 'utf8');
    const row = (await fs.readFile(path.join(workspace, '.theater', 'index.md'), 'utf8')).split('\n').find(line => line.includes(`| ${slug} |`)).split('|');
    return { ...await persisted(workspace, slug), contextStatus: packet.match(/^Status: (.*)$/m)[1], indexStatus: row[3].trim() };
  };
  const retiredTo = (next, status = 'active') => ({ context: next, index: next, contextStatus: status, indexStatus: status });

  // Resubmitting identical checks changes nothing.
  const review = await reviewed('review');
  const before = storedDirection(workspace, 'review');
  assert.equal((await updateChecks({ ...review, checks: check('Read the committed README') })).changed, false);
  assert.deepEqual(storedDirection(workspace, 'review'), before);
  assert.deepEqual(candidates('review'), ['ready']);
  assert.deepEqual(await saved('review'), retiredTo(REVIEW, 'review'));
  // A changed contract supersedes the candidate and reopens the lane to the work graph's direction.
  await updateChecks({ ...review, checks: revised });
  assert.deepEqual(await saved('review'), retiredTo(READY));
  assert.deepEqual(candidates('review'), ['superseded']);
  agreeOn(await directions(workspace, 'review'), READY);
  // The work graph direction keeps following later work updates.
  await updateWork({ ...review, key: 'readme', status: 'running', owner: 'astra' });
  agreeOn(await directions(workspace, 'review'), 'Await or reconcile running work: readme.');

  // A done lane reopens without its completed direction.
  const done = await reviewed('done', async lane => {
    await updateWork({ ...lane, key: 'readme', status: 'running', owner: 'astra' });
    await updateWork({ ...lane, key: 'readme', status: 'done', owner: 'astra', summary: 'The README exists.' });
  });
  await setFeatureStatus({ ...done, status: 'done' });
  await updateChecks({ ...done, checks: revised });
  assert.deepEqual(await saved('done'), retiredTo(settled));
  assert.deepEqual(candidates('done'), ['superseded']);
  agreeOn(await directions(workspace, 'done'), settled);

  // An active lane still holding its ready candidate.
  const active = await reviewed('active');
  await setFeatureStatus({ ...active, status: 'active' });
  await updateChecks({ ...active, checks: revised });
  assert.deepEqual(await saved('active'), retiredTo(READY));
  agreeOn(await directions(workspace, 'active'), READY);

  // A checkpoint saved since the candidate keeps its text, even word for word the generated one.
  const after = await reviewed('after');
  await checkpointFeature({ ...after, summary: 'Candidate kept for a later decision.', next_action: REVIEW });
  await updateChecks({ ...after, checks: revised });
  assert.deepEqual(await saved('after'), retiredTo(REVIEW));
  agreeOn(await directions(workspace, 'after'), REVIEW);
  // One saved before the candidate was replaced by the candidate's own direction.
  const early = await reviewed('early', lane => checkpointFeature({ ...lane, summary: 'Review expected soon.', next_action: REVIEW }));
  await updateChecks({ ...early, checks: revised });
  assert.deepEqual(await saved('early'), retiredTo(READY));
  // So was one saved before an archive whose reactivation regenerated the review direction.
  const revived = await reviewed('revived');
  await checkpointFeature({ ...revived, summary: 'Candidate kept for a later decision.', next_action: REVIEW });
  await setFeatureStatus({ ...revived, status: 'archived', disposition: 'Shelved.' });
  assert.equal((await setFeatureStatus({ ...revived, status: 'active' })).feature.nextAction, REVIEW);
  await updateChecks({ ...revived, checks: revised });
  assert.deepEqual(await saved('revived'), retiredTo(READY));

  // A failing run supersedes the candidate the same way.
  const failing = await reviewed('failing');
  await fs.writeFile(path.join(workspace, 'features', 'failing', 'repo', '.check-fails'), 'fail');
  assert.equal((await runChecks(failing)).verification.ready, false);
  assert.deepEqual(await saved('failing'), retiredTo(READY));
  assert.deepEqual(candidates('failing'), ['superseded']);
  agreeOn(await directions(workspace, 'failing'), READY);

  // A blocked lane stays blocked with its blocker, but no longer awaits the superseded candidate,
  // so reactivating it cannot bring back an impossible review instruction.
  const blocked = await reviewed('blocked');
  await setFeatureStatus({ ...blocked, status: 'blocked', blocker: 'Waiting on review.' });
  await updateChecks({ ...blocked, checks: revised });
  assert.deepEqual(await saved('blocked'), retiredTo(READY, 'blocked'));
  assert.deepEqual(candidates('blocked'), ['superseded']);
  assert.equal((await getFeatureContext(blocked)).feature.blocker, 'Waiting on review.');
  agreeOn(await directions(workspace, 'blocked'), READY);
  assert.equal((await setFeatureStatus({ ...blocked, status: 'active' })).feature.nextAction, READY);
  agreeOn(await directions(workspace, 'blocked'), READY);
  // Review text a checkpoint saved after the candidate stays through the block and reactivation.
  const held = await reviewed('held');
  await setFeatureStatus({ ...held, status: 'blocked', blocker: 'Waiting on review.' });
  await checkpointFeature({ ...held, summary: 'Candidate kept for a later decision.', next_action: REVIEW });
  await updateChecks({ ...held, checks: revised });
  assert.deepEqual(await saved('held'), retiredTo(REVIEW, 'blocked'));
  assert.equal((await setFeatureStatus({ ...held, status: 'active' })).feature.nextAction, REVIEW);

  // Archived lanes keep their stored direction.
  const shelved = await reviewed('shelved');
  await setFeatureStatus({ ...shelved, status: 'archived', disposition: 'Shelved.' });
  await updateChecks({ ...shelved, checks: revised });
  assert.equal(storedDirection(workspace, 'shelved').feature, ARCHIVED);
  agreeOn(await directions(workspace, 'shelved'), ARCHIVED);
});

// Level-two sections as a Markdown reader sees them, skipping fenced code blocks.
function markdownSections(packet) {
  const sections = [];
  let open = null;
  for (const line of packet.split('\n')) {
    if (open) {
      if (new RegExp(`^\`{${open},}\\s*$`).test(line)) open = null;
      continue;
    }
    const fence = line.match(/^(`{3,})/);
    if (fence) open = fence[1].length;
    else if (line.startsWith('## ')) sections.push(line);
  }
  return sections;
}

// The details file the packet names for a work key, as a worker given only that key would find it.
function linkedDetails(packet, key) {
  return packet.match(new RegExp(`^  - ${key.replaceAll('.', '\\.')} description and acceptance: (.+)$`, 'm'))?.[1];
}

test('a worker given only a claimed key finds its saved details while the packet stays compact', async t => {
  const { source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const lane = { workspace_path: workspace, feature: 'compat' };
  await createFeature({ ...lane, title: 'Compat', outcome: 'Callers keep working.', spec: '# Compat\n\nKeep the API.' });
  const description = 'Preserve API compatibility.\n\n## Acceptance\n\n- forged criterion\n\n````js\nexport const value = 1;\n````\n\n# Forged title';
  const acceptance = 'Existing callers still work.\n| a | b |\n``` unterminated';
  const other = { key: 'other', title: 'Other work', description: 'UNRELATED description', acceptance: 'UNRELATED acceptance' };
  await planWork({ ...lane, items: [{ key: 'deliver', title: 'Deliver', description: 'Draft text.', acceptance }, other] });
  // A revision before the claim is what the worker sees, not the first draft.
  await planWork({ ...lane, items: [{ key: 'deliver', title: 'Deliver', description, acceptance }, other] });
  const contextFile = path.join(workspace, '.theater', 'features', 'compat', 'context.md');
  assert.equal(linkedDetails(await fs.readFile(contextFile, 'utf8'), 'deliver'), undefined);

  await updateWork({ ...lane, key: 'deliver', status: 'running', owner: 'worker' });
  const runtime = await featureRuntime(lane);
  assert.equal(runtime.contextPath, contextFile);
  assert.ok(runtime.developerInstructions.includes(runtime.contextPath));
  assert.match(runtime.developerInstructions, /Each running item there names a file holding its saved description and acceptance criteria; read that file for your assigned work key/);
  const packet = await fs.readFile(runtime.contextPath, 'utf8');
  const detailsFile = linkedDetails(packet, 'deliver');
  assert.equal(path.dirname(path.dirname(detailsFile)), path.dirname(runtime.contextPath));
  assert.equal(path.basename(detailsFile), `item-deliver-${createHash('sha256').update('deliver').digest('hex').slice(0, 8)}.md`);
  const body = `# Work item \`deliver\`\n\nFeature: compat\nKind: build\nStatus: running\n\nSaved text appears verbatim inside each fence.\n\n## Description\n\n\`\`\`\`\`text\n${description}\n\`\`\`\`\`\n\n## Acceptance\n\n\`\`\`\`text\n${acceptance}\n\`\`\`\`\n`;
  const expected = `<!-- OVERDRIVE generated work details: deliver · ${createHash('sha256').update(body).digest('hex').slice(0, 16)} -->\n${body}`;
  assert.equal(await fs.readFile(detailsFile, 'utf8'), expected);
  assert.deepEqual(markdownSections(expected), ['## Description', '## Acceptance']);

  // Refreshes such as a lease renewal leave an intact file untouched and restore a damaged one.
  const untouched = new Date('2001-02-03T04:05:06Z');
  await fs.utimes(detailsFile, untouched, untouched);
  await updateWork({ ...lane, key: 'deliver', status: 'running', owner: 'worker' });
  await featureRuntime(lane);
  assert.equal((await fs.stat(detailsFile)).mtime.getTime(), untouched.getTime());
  await fs.writeFile(detailsFile, expected.slice(0, expected.indexOf('## Acceptance')));
  await featureRuntime(lane);
  assert.equal(await fs.readFile(detailsFile, 'utf8'), expected);
  assert.doesNotMatch(packet, /Preserve API|Existing callers|Draft text|UNRELATED/);
  assert.match(packet, /^- \[ \] other · build · ready: Other work\n/m);
  assert.equal(linkedDetails(packet, 'other'), undefined);
  assert.deepEqual(markdownSections(packet), ['## Current checkpoint', '## Work graph', '## Evidence', '## Live facts']);

  // Many long running items add one line each to the packet; case-distinct keys and a Windows
  // device name get their own readable files.
  const long = marker => `${marker} ${'x'.repeat(49_000)}`;
  const heavy = ['con', 'Con', 'CON.x'].map(key => ({ key, title: `Heavy ${key}`, description: long(`${key}-description`), acceptance: long(`${key}-acceptance`) }));
  await planWork({ ...lane, items: [{ key: 'deliver', title: 'Deliver', description, acceptance }, other, ...heavy] });
  for (const { key } of heavy) await updateWork({ ...lane, key, status: 'running', owner: `worker-${key}` });
  const busy = await fs.readFile(contextFile, 'utf8');
  assert.ok(busy.length < packet.length + 1_000, `packet grew to ${busy.length} characters`);
  assert.doesNotMatch(busy, /xxxxxxxxxx/);
  const heavyFiles = heavy.map(({ key }) => linkedDetails(busy, key));
  assert.equal(new Set(heavyFiles.map(file => file.toLowerCase())).size, heavy.length);
  for (const [index, { key }] of heavy.entries()) {
    const details = await fs.readFile(heavyFiles[index], 'utf8');
    assert.ok(details.includes(`\n${long(`${key}-description`)}\n`) && details.includes(`\n${long(`${key}-acceptance`)}\n`));
  }

  // Details follow the claim: settled work loses its generated file and newly claimed work gains
  // one, while anything not provably generated here stays.
  const workDirectory = path.dirname(detailsFile);
  const generatedName = key => `item-${key}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}.md`;
  const kept = {
    'notes.md': 'User notes.\n',
    'item-deliver-00000000.md': '<!-- OVERDRIVE generated work details: deliver · 0 -->\nWrong digest.\n',
    [generatedName('ghost')]: 'No generated marker.\n',
    [generatedName('mismatch')]: '<!-- OVERDRIVE generated work details: ghost · 0 -->\nMarker for another key.\n',
  };
  for (const [name, content] of Object.entries(kept)) await fs.writeFile(path.join(workDirectory, name), content);
  await fs.mkdir(path.join(workDirectory, generatedName('folder')));
  await fs.writeFile(path.join(workDirectory, generatedName('stale')), '<!-- OVERDRIVE generated work details: stale · 0 -->\nLeft by removed work.\n');
  await updateWork({ ...lane, key: 'deliver', status: 'done', owner: 'worker', summary: 'Delivered.' });
  await updateWork({ ...lane, key: 'other', status: 'running', owner: 'worker' });
  const next = await fs.readFile(contextFile, 'utf8');
  assert.equal(linkedDetails(next, 'deliver'), undefined);
  await assert.rejects(fs.stat(detailsFile), error => error.code === 'ENOENT');
  await assert.rejects(fs.stat(path.join(workDirectory, generatedName('stale'))), error => error.code === 'ENOENT');
  for (const [name, content] of Object.entries(kept)) assert.equal(await fs.readFile(path.join(workDirectory, name), 'utf8'), content);
  assert.ok((await fs.stat(path.join(workDirectory, generatedName('folder')))).isDirectory());
  assert.match(await fs.readFile(linkedDetails(next, 'other'), 'utf8'), /## Description\n\n```text\nUNRELATED description\n```\n\n## Acceptance\n\n```text\nUNRELATED acceptance\n```\n$/);
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
