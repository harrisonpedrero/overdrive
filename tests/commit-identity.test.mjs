import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../plugins/feature-theater/scripts/util.mjs';
import { runChecks, updateChecks } from '../plugins/feature-theater/scripts/verification.mjs';
import { createFeature, getFeatureContext, initializeManagedProject, initializeWorkspace, recordCandidate } from '../plugins/feature-theater/scripts/workspace.mjs';

const AUTOMATION = 'OVERDRIVE <overdrive@local.invalid>';
const IDENTITY_ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];

// Every Git child of this process sees only the given global file and an empty system file.
async function isolatedHost(t, globalConfig = '') {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-identity-'));
  const saved = Object.fromEntries(['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', ...IDENTITY_ENV].map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(parent, { recursive: true, force: true, maxRetries: 5 });
  });
  const globalFile = path.join(parent, 'global.gitconfig');
  const systemFile = path.join(parent, 'system.gitconfig');
  await fs.writeFile(globalFile, globalConfig);
  await fs.writeFile(systemFile, '');
  for (const key of IDENTITY_ENV) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_SYSTEM: systemFile });
  const hostUntouched = async () => {
    assert.equal(await fs.readFile(globalFile, 'utf8'), globalConfig);
    assert.equal(await fs.readFile(systemFile, 'utf8'), '');
  };
  return { parent, hostUntouched };
}

const git = (cwd, ...args) => run(['git', ...args], { cwd });
const gitStatus = (cwd, ...args) => run(['git', ...args], { cwd, allowFailure: true });

async function sourceRepository(parent, identity = {}) {
  const source = path.join(parent, 'source');
  await fs.mkdir(source);
  await git(source, 'init', '-b', 'main');
  if (identity.name) await git(source, 'config', 'user.name', identity.name);
  if (identity.email) await git(source, 'config', 'user.email', identity.email);
  await fs.writeFile(path.join(source, 'README.md'), '# Source\n');
  await git(source, 'add', '.');
  await git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base');
  return source;
}

// The ordinary worker commit: no -c overrides and no identity in the environment.
async function commitWork(repo, file) {
  await fs.writeFile(path.join(repo, file), `${file}\n`);
  await git(repo, 'add', '--', file);
  const commit = await gitStatus(repo, 'commit', '-m', `Add ${file}`);
  assert.equal(commit.exitCode, 0, commit.stderr);
  return (await git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).stdout;
}

test('an identity-free managed project reaches a verified commit under the disclosed automation identity', async t => {
  const { parent, hostUntouched } = await isolatedHost(t);
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  const args = { workspace_path: workspace, feature: 'alpha' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Identity', description: 'Commit without a host identity.' });
  const lane = await createFeature({ ...args, title: 'Alpha', outcome: 'A committed artifact.', spec: '# Alpha\n\nnotes.txt exists.' });
  assert.equal(lane.commitIdentity.origin, 'automation');
  assert.equal(lane.commitIdentity.automation, true);
  assert.equal(lane.commitIdentity.overridden, false);
  assert.equal(lane.commitIdentity.author, AUTOMATION);
  assert.equal(lane.commitIdentity.committer, AUTOMATION);
  assert.equal(lane.commitIdentity.scope, 'local');
  assert.match(lane.next, /Disclose that this lane commits as the OVERDRIVE automation identity and show the optional lane-local override.*need not wait/);
  // Each override is a separate command, runnable in any shell.
  assert.equal(lane.commitIdentity.override.length, 2);
  for (const command of lane.commitIdentity.override) assert.doesNotMatch(command, /&&|;/);
  const context = await fs.readFile(lane.contextPath, 'utf8');
  assert.match(context, /- Commit identity: OVERDRIVE <overdrive@local\.invalid> · OVERDRIVE automation fallback in clone-local config.*Lane-local override: run `git -C "[^`]+" config user\.name "Your Name"` then `git -C "[^`]+" config user\.email "you@example\.com"`\n/);

  const repo = lane.feature.checkoutPath;
  assert.equal(await commitWork(repo, 'notes.txt'), 'OVERDRIVE <overdrive@local.invalid>|OVERDRIVE <overdrive@local.invalid>');
  await updateChecks({ ...args, checks: [{ key: 'notes', purpose: 'Read the committed notes', argv: [process.execPath, '-e', "require('node:fs').readFileSync('notes.txt')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Committed notes.', checks: ['notes receipt'] });
  assert.equal((await getFeatureContext(args)).commitIdentity.origin, 'automation');
  assert.equal((await gitStatus(repo, 'config', '--global', '--get', 'user.name')).exitCode, 1);
  await hostUntouched();
});

test('an adopted local source carries its complete repository-local identity into the clone', async t => {
  const { parent, hostUntouched } = await isolatedHost(t);
  const source = await sourceRepository(parent, { name: 'Local Maintainer', email: 'maintainer@example.invalid' });
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const lane = await createFeature({ workspace_path: workspace, feature: 'beta', title: 'Beta', outcome: 'Commit as the maintainer.' });
  const maintainer = 'Local Maintainer <maintainer@example.invalid>';
  const sourcePath = await fs.realpath(source);
  assert.deepEqual([lane.commitIdentity.author, lane.commitIdentity.committer, lane.commitIdentity.origin, lane.commitIdentity.source, lane.commitIdentity.automation], [maintainer, maintainer, 'source', sourcePath, false]);
  assert.doesNotMatch(lane.next, /automation identity/);
  assert.equal(await commitWork(lane.feature.checkoutPath, 'change.txt'), `${maintainer}|${maintainer}`);
  const context = await fs.readFile(lane.contextPath, 'utf8');
  assert.ok(context.includes(`- Commit identity: ${maintainer} · copied into clone-local config from the adopted local source ${sourcePath}\n`), context);
  // Provenance lasts only while the clone-local identity is the one OVERDRIVE copied.
  await git(lane.feature.checkoutPath, 'config', 'user.email', 'changed@example.invalid');
  assert.equal((await getFeatureContext({ workspace_path: workspace, feature: 'beta' })).commitIdentity.summary, 'Local Maintainer <changed@example.invalid> · clone-local Git config');
  await hostUntouched();
});

test('an incomplete local source identity is not mixed with the automation fallback', async t => {
  const { parent, hostUntouched } = await isolatedHost(t);
  const source = await sourceRepository(parent, { name: 'Name Only' });
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const lane = await createFeature({ workspace_path: workspace, feature: 'gamma', title: 'Gamma', outcome: 'Commit.' });
  assert.equal(lane.commitIdentity.origin, 'automation');
  assert.equal(await commitWork(lane.feature.checkoutPath, 'change.txt'), 'OVERDRIVE <overdrive@local.invalid>|OVERDRIVE <overdrive@local.invalid>');
  await hostUntouched();
});

test('a remote-adopted clone with no identity commits under the disclosed automation fallback', async t => {
  const { parent, hostUntouched } = await isolatedHost(t);
  // The source's own repository config is not reachable through a remote URL.
  const source = await sourceRepository(parent, { name: 'Unreachable Remote Config', email: 'remote@example.invalid' });
  const remote = 'https://example.invalid/overdrive/remote.git';
  // Process-scoped URL rewriting serves the remote locally; command-scope config never counts as an identity.
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${pathToFileURL(source).href}.insteadOf`, GIT_CONFIG_VALUE_0: remote });
  t.after(() => { delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0; });
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  const initialized = await initializeWorkspace({ workspace_path: workspace, repository: remote });
  assert.equal(initialized.workspace.repository, remote);
  const lane = await createFeature({ workspace_path: workspace, feature: 'delta', title: 'Delta', outcome: 'Commit from a remote clone.' });
  assert.equal(lane.commitIdentity.origin, 'automation');
  assert.equal((await git(lane.feature.checkoutPath, 'config', '--local', '--get', 'remote.origin.url')).stdout, remote);
  assert.equal(await commitWork(lane.feature.checkoutPath, 'change.txt'), 'OVERDRIVE <overdrive@local.invalid>|OVERDRIVE <overdrive@local.invalid>');
  await hostUntouched();
});

test('an existing user identity is preserved rather than overwritten', async t => {
  const globalConfig = '[user]\n\tname = Global Person\n\temail = global@example.invalid\n';
  const { parent, hostUntouched } = await isolatedHost(t, globalConfig);
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Owned', description: 'Keep the user identity.' });
  const lane = await createFeature({ workspace_path: workspace, feature: 'epsilon', title: 'Epsilon', outcome: 'Commit as the user.' });
  assert.deepEqual([lane.commitIdentity.author, lane.commitIdentity.committer, lane.commitIdentity.origin, lane.commitIdentity.scope], ['Global Person <global@example.invalid>', 'Global Person <global@example.invalid>', 'configured', 'global']);
  const repo = lane.feature.checkoutPath;
  assert.equal((await gitStatus(repo, 'config', '--local', '--get', 'user.name')).exitCode, 1);
  assert.equal((await gitStatus(repo, 'config', '--local', '--get', 'user.email')).exitCode, 1);
  assert.equal(await commitWork(repo, 'change.txt'), 'Global Person <global@example.invalid>|Global Person <global@example.invalid>');
  assert.match(await fs.readFile(lane.contextPath, 'utf8'), /- Commit identity: Global Person <global@example\.invalid> · global Git config\n/);
  await hostUntouched();
});

test('a local source identity outranks global config in its clone, as it does in the source', async t => {
  const globalConfig = '[user]\n\tname = Global Person\n\temail = global@example.invalid\n';
  const { parent, hostUntouched } = await isolatedHost(t, globalConfig);
  const source = await sourceRepository(parent, { name: 'Repository Person', email: 'repo@example.invalid' });
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const lane = await createFeature({ workspace_path: workspace, feature: 'zeta', title: 'Zeta', outcome: 'Commit as in the source.' });
  assert.equal(lane.commitIdentity.origin, 'source');
  assert.equal(await commitWork(lane.feature.checkoutPath, 'change.txt'), 'Repository Person <repo@example.invalid>|Repository Person <repo@example.invalid>');
  await hostUntouched();
});

test('inherited environment and command-line identity overrides are reported as the effective author and committer', async t => {
  const { parent, hostUntouched } = await isolatedHost(t);
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Overrides', description: 'Report what Git will use.' });
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'Env Author', GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_COMMITTER_NAME: 'Env Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid' });
  const lane = await createFeature({ workspace_path: workspace, feature: 'eta', title: 'Eta', outcome: 'Commit under inherited overrides.' });
  const identity = lane.commitIdentity;
  assert.deepEqual([identity.author, identity.committer, identity.automation, identity.overridden], ['Env Author <author@example.invalid>', 'Env Committer <committer@example.invalid>', false, true]);
  // The clone-local fallback still backs a later worker environment without these variables.
  assert.equal(`${identity.name} <${identity.email}>`, AUTOMATION);
  assert.deepEqual(identity.environment, ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']);
  assert.match(identity.summary, /^Author Env Author <author@example\.invalid>, committer Env Committer <committer@example\.invalid> · this environment's GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL take precedence over OVERDRIVE <overdrive@local\.invalid>/);
  assert.doesNotMatch(lane.next, /automation identity/);
  assert.match(lane.next, /Disclose that inherited Git identity overrides decide/);
  const repo = lane.feature.checkoutPath;
  assert.equal(await commitWork(repo, 'env.txt'), `${identity.author}|${identity.committer}`);

  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Command Person', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'command@example.invalid' });
  t.after(() => { for (const key of ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1']) delete process.env[key]; });
  const current = (await getFeatureContext({ workspace_path: workspace, feature: 'eta' })).commitIdentity;
  assert.deepEqual([current.author, current.committer, current.automation, current.overridden, current.environment], ['Command Person <command@example.invalid>', 'Command Person <command@example.invalid>', false, true, ['GIT_CONFIG_COUNT']]);
  assert.match(await fs.readFile(lane.contextPath, 'utf8'), /- Commit identity: Author Command Person <command@example\.invalid>, committer Command Person <command@example\.invalid> · this environment's GIT_CONFIG_COUNT take precedence/);
  assert.equal(await commitWork(repo, 'command.txt'), `${current.author}|${current.committer}`);
  await hostUntouched();
});

test('an unreachable local source falls back without failing clone creation and says why', async t => {
  const { parent, hostUntouched } = await isolatedHost(t);
  const source = await sourceRepository(parent, { name: 'Offline Maintainer', email: 'offline@example.invalid' });
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const first = await createFeature({ workspace_path: workspace, feature: 'theta', title: 'Theta', outcome: 'Supplies a sibling base.' });
  const selected = (await git(first.feature.checkoutPath, 'rev-parse', 'HEAD')).stdout;
  await fs.rename(source, `${source}-offline`);
  t.after(() => fs.rename(`${source}-offline`, source).catch(() => {}));
  const lane = await createFeature({ workspace_path: workspace, feature: 'iota', title: 'Iota', outcome: 'Created offline.', base_feature: 'theta', base_revision: selected });
  assert.equal(lane.commitIdentity.origin, 'automation');
  assert.match(lane.commitIdentity.summary, /adopted local source .* could not be read/);
  assert.equal(await commitWork(lane.feature.checkoutPath, 'change.txt'), `${AUTOMATION}|${AUTOMATION}`);
  await hostUntouched();
});
