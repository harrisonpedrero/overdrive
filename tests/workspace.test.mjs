import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git } from '../plugins/overdrive/scripts/util.mjs';
import {
  createFeature,
  doctorWorkspace,
  featureRuntime,
  getFeatureContext,
  initializeManagedProject,
  initializeWorkspace,
  listFeatures,
  resolveAgentRequestRecord,
  savePendingAgentRequest,
  updateFeature,
  updateWork,
} from '../plugins/overdrive/scripts/workspace.mjs';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(source);
  await fs.mkdir(workspace);
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.name', 'OVERDRIVE Test');
  await git(source, 'config', 'user.email', 'overdrive@example.invalid');
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
  assert.equal(listed.features[0].git.clean, true);
});

test('an exact sibling revision seeds a lane while canonical source is unavailable', async t => {
  const { parent, source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const canonicalBase = (await git(source, 'rev-parse', 'HEAD')).stdout;
  await createFeature({ workspace_path: workspace, feature: 'lane', outcome: 'Supplies a sibling base.' });
  const lane = path.join(workspace, 'features', 'lane', 'repo');
  await git(lane, 'config', 'user.name', 'OVERDRIVE Test');
  await git(lane, 'config', 'user.email', 'overdrive@example.invalid');
  await fs.writeFile(path.join(lane, 'app.js'), 'export const value = 2;\n');
  await git(lane, 'commit', '-am', 'selected');
  const selected = (await git(lane, 'rev-parse', 'HEAD')).stdout;
  // The sibling advances and gets dirty after the revision was selected.
  await fs.writeFile(path.join(lane, 'app.js'), 'export const value = 3;\n');
  await git(lane, 'commit', '-am', 'later');
  await fs.writeFile(path.join(lane, 'app.js'), 'export const value = 4;\n');
  await fs.writeFile(path.join(lane, 'dirty.txt'), 'uncommitted\n');

  const offline = path.join(parent, 'source-offline');
  await fs.rename(source, offline);
  await assert.rejects(createFeature({ workspace_path: workspace, feature: 'plain', outcome: 'Needs canonical source.' }));
  await assert.rejects(createFeature({ workspace_path: workspace, feature: 'canonical', outcome: 'Explicit canonical base.', base_revision: canonicalBase }));
  for (const slug of ['plain', 'canonical']) assert.equal(await fs.stat(path.join(workspace, 'features', slug)).catch(() => null), null);

  const derived = await createFeature({ workspace_path: workspace, feature: 'derived', outcome: 'Builds on the sibling offline.', base_feature: 'lane', base_revision: selected });
  assert.equal(derived.feature.baseRevision, selected);
  assert.equal(derived.canonicalSource.status, 'cached');
  assert.equal(derived.canonicalSource.defaultRevision, canonicalBase);
  const derivedRepo = path.join(workspace, 'features', 'derived', 'repo');
  assert.equal((await git(derivedRepo, 'rev-parse', 'HEAD')).stdout, selected);
  assert.equal((await fs.readFile(path.join(derivedRepo, 'app.js'), 'utf8')).replaceAll('\r\n', '\n'), 'export const value = 2;\n');
  assert.equal(await fs.stat(path.join(derivedRepo, 'dirty.txt')).catch(() => null), null);
  assert.equal((await git(derivedRepo, 'status', '--porcelain')).stdout, '');
  assert.equal(await fs.stat(path.join(derivedRepo, '.git', 'objects', 'info', 'alternates')).catch(() => null), null);
  assert.equal((await git(derivedRepo, 'remote', 'get-url', 'origin')).stdout, source);

  await fs.rename(offline, source);
  await fs.writeFile(path.join(source, 'app.js'), 'export const value = 9;\n');
  await git(source, 'commit', '-am', 'canonical advance');
  const latest = (await git(source, 'rev-parse', 'HEAD')).stdout;
  const recovered = await createFeature({ workspace_path: workspace, feature: 'plain', outcome: 'Needs canonical source.' });
  assert.equal(recovered.canonicalSource.status, 'refreshed');
  assert.equal(recovered.feature.baseRevision, latest);
  assert.equal((await git(path.join(workspace, 'features', 'plain', 'repo'), 'rev-parse', 'HEAD')).stdout, latest);
});

test('setup and check hints describe each lane\'s selected base while the canonical profile stays cached', async t => {
  const { parent, source, workspace } = await fixture(t);
  // Canonical default is a Rust project; Node appears only in a sibling commit and Go only off-default.
  await git(source, 'rm', '-q', 'package.json', 'package-lock.json');
  await fs.writeFile(path.join(source, 'Cargo.toml'), '[package]\nname = "app"\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'rust');
  await git(source, 'checkout', '-q', '-b', 'side');
  await git(source, 'rm', '-q', 'Cargo.toml');
  await fs.writeFile(path.join(source, 'go.mod'), 'module app\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'go');
  const side = (await git(source, 'rev-parse', 'HEAD')).stdout;
  await git(source, 'checkout', '-q', 'main');
  const rust = { ecosystems: ['rust'], setupCandidates: [['cargo', 'fetch']], checkCandidates: [['cargo', 'test']] };
  const hints = profile => ({ ecosystems: profile.ecosystems, setupCandidates: profile.setupCandidates, checkCandidates: profile.checkCandidates });
  const cachedProfile = async () => JSON.parse(await fs.readFile(path.join(workspace, 'overdrive.json'), 'utf8')).repositoryProfile;

  const initialized = await initializeWorkspace({ workspace_path: workspace, repository: source });
  assert.deepEqual(hints(initialized.repositoryProfile), rust);
  const lane = await createFeature({ workspace_path: workspace, feature: 'lane', outcome: 'Supplies a sibling base.' });
  assert.deepEqual(lane.repositoryProfile, initialized.repositoryProfile);
  const laneRepo = path.join(workspace, 'features', 'lane', 'repo');
  await git(laneRepo, 'config', 'user.name', 'OVERDRIVE Test');
  await git(laneRepo, 'config', 'user.email', 'overdrive@example.invalid');
  await fs.writeFile(path.join(laneRepo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await git(laneRepo, 'add', 'package.json');
  await git(laneRepo, 'commit', '-m', 'node');
  const selected = (await git(laneRepo, 'rev-parse', 'HEAD')).stdout;
  // Later working-tree edits in the sibling are not part of the selected commit.
  await fs.writeFile(path.join(laneRepo, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
  await fs.writeFile(path.join(laneRepo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

  const offline = path.join(parent, 'source-offline');
  await fs.rename(source, offline);
  const derived = await createFeature({ workspace_path: workspace, feature: 'derived', outcome: 'Adds Node tooling.', base_feature: 'lane', base_revision: selected });
  assert.equal(derived.canonicalSource.status, 'cached');
  assert.deepEqual(hints(derived.repositoryProfile), {
    ecosystems: ['node', 'rust'],
    setupCandidates: [['npm', 'install'], ['cargo', 'fetch']],
    checkCandidates: [['npm', 'run', 'test'], ['cargo', 'test']],
  });
  assert.deepEqual(await cachedProfile(), initialized.repositoryProfile);
  await fs.rename(offline, source);

  const explicit = await createFeature({ workspace_path: workspace, feature: 'explicit', outcome: 'Starts off-default.', base_revision: side });
  assert.equal(explicit.feature.baseRevision, side);
  assert.deepEqual(hints(explicit.repositoryProfile), { ecosystems: ['go'], setupCandidates: [['go', 'mod', 'download']], checkCandidates: [['go', 'test', './...']] });
  assert.deepEqual(await cachedProfile(), initialized.repositoryProfile);

  const plain = await createFeature({ workspace_path: workspace, feature: 'plain', outcome: 'Starts from default.' });
  assert.deepEqual(plain.repositoryProfile, initialized.repositoryProfile);
  assert.deepEqual(await cachedProfile(), initialized.repositoryProfile);
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

test('starts a managed project from scratch and bases lanes on its head', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-scratch-'));
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
  assert.equal(foundation.feature.baseRevision, (await git(project, 'rev-parse', 'HEAD')).stdout);
});

test('versions specs and enforces the work DAG', async t => {
  const { source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  await createFeature({ workspace_path: workspace, feature: 'alpha', title: 'Alpha', outcome: 'Deliver alpha.' });
  const spec = await updateFeature({
    workspace_path: workspace,
    feature: 'alpha',
    spec_rationale: 'Acceptance behavior is now concrete.',
    spec: '# Alpha\n\n## Acceptance criteria\n\n- `value` is 2.\n',
  });
  assert.equal(spec.spec.revision, 1);

  const plan = await updateWork({
    workspace_path: workspace,
    feature: 'alpha',
    items: [
      { key: 'build', title: 'Change the value', kind: 'build', acceptance: 'value is 2' },
      { key: 'validate', title: 'Run the test', kind: 'validate', depends_on: ['build'] },
    ],
  });
  assert.equal(plan.workItems.find(item => item.item_key === 'build').status, 'ready');
  assert.equal(plan.workItems.find(item => item.item_key === 'validate').status, 'planned');
  await assert.rejects(planBELoop(workspace), /cycle/i);
  await assert.rejects(
    updateWork({ workspace_path: workspace, feature: 'alpha', items: [{ key: 'orphan', title: 'Orphan', depends_on: ['missing'] }] }),
    error => error.code === 'UNKNOWN_DEPENDENCY',
  );

  await updateWork({ workspace_path: workspace, feature: 'alpha', items: [{ key: 'build', status: 'running' }] });
  await updateWork({ workspace_path: workspace, feature: 'alpha', items: [{ key: 'build', status: 'done', result: 'Changed the exported value.' }] });
  const context = await getFeatureContext({ workspace_path: workspace, feature: 'alpha' });
  assert.equal(context.workItems.find(item => item.item_key === 'validate').status, 'ready');

  await updateWork({ workspace_path: workspace, feature: 'alpha', items: [{ key: 'validate', status: 'running' }] });
  await updateWork({ workspace_path: workspace, feature: 'alpha', items: [{ key: 'validate', status: 'done', result: 'Test passed.' }] });
  const done = await updateFeature({ workspace_path: workspace, feature: 'alpha', status: 'done' });
  assert.equal(done.feature.status, 'done');
});

async function planBELoop(workspace) {
  return await updateWork({
    workspace_path: workspace,
    feature: 'alpha',
    items: [
      { key: 'build', title: 'Build', depends_on: ['validate'] },
      { key: 'validate', title: 'Validate', depends_on: ['build'] },
    ],
  });
}

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

test('a worker given only a running work key finds its saved details while the packet stays compact', async t => {
  const { parent, source, workspace } = await fixture(t);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const lane = { workspace_path: workspace, feature: 'compat' };
  await createFeature({ ...lane, title: 'Compat', outcome: 'Callers keep working.', spec: '# Compat\n\nKeep the API.' });
  const description = 'Preserve API compatibility.\n\n## Acceptance\n\n- forged criterion\n\n````js\nexport const value = 1;\n````\n\n# Forged title';
  const acceptance = 'Existing callers still work.\n| a | b |\n``` unterminated';
  const other = { key: 'other', title: 'Other work', description: 'UNRELATED description', acceptance: 'UNRELATED acceptance' };
  await updateWork({ ...lane, items: [{ key: 'deliver', title: 'Deliver', description: 'Draft text.', acceptance }, other] });
  // A revision before the item runs is what the worker sees, not the first draft.
  await updateWork({ ...lane, items: [{ key: 'deliver', title: 'Deliver', description, acceptance }, other] });
  const contextFile = path.join(workspace, '.overdrive', 'features', 'compat', 'context.md');
  assert.equal(linkedDetails(await fs.readFile(contextFile, 'utf8'), 'deliver'), undefined);

  await updateWork({ ...lane, items: [{ key: 'deliver', status: 'running' }] });
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

  // Refreshes such as an unchanged update leave an intact file untouched and restore a damaged one.
  const untouched = new Date('2001-02-03T04:05:06Z');
  await fs.utimes(detailsFile, untouched, untouched);
  await updateWork({ ...lane, items: [{ key: 'deliver', status: 'running' }] });
  await featureRuntime(lane);
  assert.equal((await fs.stat(detailsFile)).mtime.getTime(), untouched.getTime());
  const changed = expected.replace('Preserve API compatibility.', 'Preserve API compatibilitY.');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(expected));
  assert.equal(changed.split('\n', 1)[0], expected.split('\n', 1)[0]);
  await fs.writeFile(detailsFile, changed);
  await featureRuntime(lane);
  assert.equal(await fs.readFile(detailsFile, 'utf8'), expected);
  await fs.writeFile(detailsFile, expected.slice(0, expected.indexOf('## Acceptance')));
  await featureRuntime(lane);
  assert.equal(await fs.readFile(detailsFile, 'utf8'), expected);
  assert.doesNotMatch(packet, /Preserve API|Existing callers|Draft text|UNRELATED/);
  assert.match(packet, /^- \[ \] other · build · ready: Other work\n/m);
  assert.equal(linkedDetails(packet, 'other'), undefined);
  assert.deepEqual(markdownSections(packet), ['## Summary', '## Work graph', '## Evidence', '## Live facts']);

  // Many long running items add one line each to the packet; case-distinct keys and a Windows
  // device name get their own readable files.
  const long = marker => `${marker} ${'x'.repeat(49_000)}`;
  const heavy = ['con', 'Con', 'CON.x'].map(key => ({ key, title: `Heavy ${key}`, description: long(`${key}-description`), acceptance: long(`${key}-acceptance`) }));
  await updateWork({ ...lane, items: [{ key: 'deliver', title: 'Deliver', description, acceptance }, other, ...heavy] });
  await updateWork({ ...lane, items: heavy.map(({ key }) => ({ key, status: 'running' })) });
  const busy = await fs.readFile(contextFile, 'utf8');
  assert.ok(busy.length < packet.length + 1_000, `packet grew to ${busy.length} characters`);
  assert.doesNotMatch(busy, /xxxxxxxxxx/);
  const heavyFiles = heavy.map(({ key }) => linkedDetails(busy, key));
  assert.equal(new Set(heavyFiles.map(file => file.toLowerCase())).size, heavy.length);
  for (const [index, { key }] of heavy.entries()) {
    const details = await fs.readFile(heavyFiles[index], 'utf8');
    assert.ok(details.includes(`\n${long(`${key}-description`)}\n`) && details.includes(`\n${long(`${key}-acceptance`)}\n`));
  }

  // Details follow running work: settled work loses its generated file and newly running work gains
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
  const outsideDirectory = path.join(parent, 'linked-notes');
  await fs.mkdir(outsideDirectory);
  await fs.writeFile(path.join(outsideDirectory, 'note.md'), 'Keep this note.\n');
  const linkedDirectory = path.join(workDirectory, generatedName('linked'));
  await fs.symlink(outsideDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(workDirectory, generatedName('stale')), '<!-- OVERDRIVE generated work details: stale · 0 -->\nLeft by removed work.\n');
  await updateWork({ ...lane, items: [{ key: 'deliver', status: 'done', result: 'Delivered.' }, { key: 'other', status: 'running' }] });
  const next = await fs.readFile(contextFile, 'utf8');
  assert.equal(linkedDetails(next, 'deliver'), undefined);
  await assert.rejects(fs.stat(detailsFile), error => error.code === 'ENOENT');
  await assert.rejects(fs.stat(path.join(workDirectory, generatedName('stale'))), error => error.code === 'ENOENT');
  for (const [name, content] of Object.entries(kept)) assert.equal(await fs.readFile(path.join(workDirectory, name), 'utf8'), content);
  assert.ok((await fs.stat(path.join(workDirectory, generatedName('folder')))).isDirectory());
  assert.ok((await fs.lstat(linkedDirectory)).isSymbolicLink());
  assert.equal(await fs.readFile(path.join(outsideDirectory, 'note.md'), 'utf8'), 'Keep this note.\n');
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
  const mismatch = error => error.code === 'CHECKOUT_LOCATION_MISMATCH';

  const copy = path.join(parent, 'copy');
  await fs.cp(workspace, copy, { recursive: true, verbatimSymlinks: true });
  await assert.rejects(getFeatureContext({ workspace_path: copy, feature: 'lane' }), mismatch);
  await assert.rejects(featureRuntime({ workspace_path: copy, feature: 'lane' }), mismatch);
  await assert.rejects(updateFeature({ workspace_path: copy, feature: 'lane', summary: 'Copied.' }), mismatch);
  await assert.rejects(createFeature({ workspace_path: copy, feature: 'derived', outcome: 'Borrows a base.', base_feature: 'lane', base_revision: (await git(path.join(workspace, 'features', 'lane', 'repo'), 'rev-parse', 'HEAD')).stdout }), mismatch);
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
  await assert.rejects(featureRuntime({ workspace_path: renamed, feature: 'lane' }), mismatch);
  await fs.rename(renamed, workspace);
  assert.equal((await featureRuntime({ workspace_path: workspace, feature: 'lane' })).feature.slug, 'lane');

  const outside = path.join(parent, 'outside-linked');
  await fs.rename(path.join(workspace, 'features', 'linked'), outside);
  await fs.symlink(outside, path.join(workspace, 'features', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(getFeatureContext({ workspace_path: workspace, feature: 'linked' }), error => mismatch(error) && /symlink or junction/.test(error.message));
  await assert.rejects(featureRuntime({ workspace_path: workspace, feature: 'linked' }), mismatch);
  assert.equal((await getFeatureContext({ workspace_path: workspace, feature: 'lane' })).feature.slug, 'lane');
});

test('version-2 data migrates without turning historical claims into current proof', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-migration-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'legacy' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Legacy', description: 'Preserve history.' });
  const lane = await createFeature({ ...args, title: 'Legacy', outcome: 'Preserve historical work.', spec: '# Legacy\n\nOriginal intent.' });
  const statePath = path.join(workspace, '.overdrive', 'state.sqlite3');
  const db = new DatabaseSync(statePath);
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
  assert.equal(context.evidence[0].source, 'reported');
  const migrated = new DatabaseSync(statePath);
  try { assert.equal(migrated.prepare("SELECT status FROM candidates WHERE id = 'old-candidate'").get().status, 'superseded'); }
  finally { migrated.close(); }
  await fs.writeFile(path.join(workspace, '.overdrive', 'features', 'legacy', 'spec.md'), 'STALE PROJECTION');
  await getFeatureContext(args);
  assert.match(await fs.readFile(path.join(workspace, '.overdrive', 'features', 'legacy', 'spec.md'), 'utf8'), /Original intent/);
});
