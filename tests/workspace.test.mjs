import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../plugins/feature-theater/scripts/util.mjs';
import { runChecks, updateChecks } from '../plugins/feature-theater/scripts/verification.mjs';
import {
  checkpointFeature,
  createFeature,
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
