import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../plugins/feature-theater/scripts/util.mjs';
import {
  checkpointFeature,
  createFeature,
  getFeatureContext,
  initializeWorkspace,
  listFeatures,
  planWork,
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
  await updateWork({ workspace_path: workspace, feature: 'alpha', key: 'build', status: 'done', summary: 'Changed the exported value.', result_revision: head });
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
  await updateWork({ workspace_path: workspace, feature: 'alpha', key: 'validate', status: 'done', summary: 'Test passed.', result_revision: head });
  const candidate = await recordCandidate({ workspace_path: workspace, feature: 'alpha', summary: 'Alpha is ready.', checks: ['node --test: passed'] });
  assert.equal(candidate.revision, head);
  const done = await setFeatureStatus({ workspace_path: workspace, feature: 'alpha', status: 'done' });
  assert.equal(done.feature.status, 'done');
  const completedContext = await getFeatureContext({ workspace_path: workspace, feature: 'alpha' });
  assert.equal(completedContext.candidates[0].status, 'accepted');
  assert.equal((await setFeatureStatus({ workspace_path: workspace, feature: 'alpha', status: 'done' })).unchanged, true);
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
