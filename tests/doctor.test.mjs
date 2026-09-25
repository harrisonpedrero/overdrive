import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../plugins/overdrive/scripts/util.mjs';
import { doctorWorkspace, initializeWorkspace } from '../plugins/overdrive/scripts/workspace.mjs';

const windows = process.platform === 'win32';

// Each fake CLI answers --version with the running Node version, so a passing probe proves which
// file was executed without depending on any real Codex or Claude Code installation.
async function fakeCli(dir, name) {
  await fs.mkdir(dir, { recursive: true });
  if (windows) {
    const file = path.join(dir, `${name}.exe`);
    await fs.link(process.execPath, file).catch(() => fs.copyFile(process.execPath, file));
    return file;
  }
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\necho ${process.version}\n`, { mode: 0o755 });
  return file;
}

function commandDirectory(name) {
  const found = spawnSync(windows ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  assert.equal(found.status, 0, `${name} must be installed for Doctor tests`);
  return path.dirname(found.stdout.split(/\r?\n/)[0].trim());
}

// PATH keeps only Git, Node, the platform locator and the given fake CLI folder. The home folder,
// Claude's last-resort install location, is redirected so a real ~/.local/bin/claude cannot answer.
async function isolatedEnvironment(t, parent, { bin, codex, claude } = {}) {
  const home = path.join(parent, 'home');
  await fs.mkdir(home, { recursive: true });
  const system = windows ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  const entries = [bin, commandDirectory('git'), path.dirname(process.execPath), ...system].filter(Boolean);
  const overrides = { PATH: entries.join(path.delimiter), HOME: home, USERPROFILE: home, CODEX_CLI_PATH: codex, CLAUDE_CLI_PATH: claude };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const apply = values => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(overrides);
  t.after(() => apply(saved));
}

async function fixture(t, harness) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-doctor-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(source);
  await fs.mkdir(workspace);
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.name', 'OVERDRIVE Test');
  await git(source, 'config', 'user.email', 'overdrive@example.invalid');
  await fs.writeFile(path.join(source, 'README.md'), 'doctor\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'base');
  await initializeWorkspace({ workspace_path: workspace, repository: source, ...(harness ? { harness } : {}) });
  return { parent, workspace };
}

const byName = report => Object.fromEntries(report.checks.map(check => [check.name, check]));

test('Doctor of a Claude workspace needs only the Claude Code CLI', async t => {
  const { parent, workspace } = await fixture(t, 'claude');
  const claude = await fakeCli(path.join(parent, 'bin'), 'claude');
  await isolatedEnvironment(t, parent, { bin: path.dirname(claude) });
  const report = await doctorWorkspace({ workspace_path: workspace });
  const checks = byName(report);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(checks['Claude Code'].ok, true);
  assert.equal(checks['Claude Code'].detail, `${process.version} (${claude})`);
  assert.equal(checks.Codex, undefined);
  for (const name of ['Git', 'Node', 'State database', 'Repository cache', 'Feature paths']) assert.equal(checks[name].ok, true, name);
});

test('Doctor of a Codex workspace, explicit or legacy default, needs only the Codex CLI', async t => {
  for (const harness of ['codex', undefined]) {
    await t.test(harness ?? 'legacy default', async t => {
      const { parent, workspace } = await fixture(t, harness);
      const codex = await fakeCli(path.join(parent, 'bin'), 'codex');
      await isolatedEnvironment(t, parent, { bin: path.dirname(codex) });
      const report = await doctorWorkspace({ workspace_path: workspace });
      const checks = byName(report);
      assert.equal(report.ok, true, JSON.stringify(report.checks));
      assert.equal(checks.Codex.ok, true);
      assert.match(checks.Codex.detail, new RegExp(`^${process.version.replaceAll('.', '\\.')}\\b`));
      assert.equal(checks['Claude Code'], undefined);
    });
  }
});

test('Doctor fails when the selected CLI is missing even if the other harness is installed', async t => {
  await t.test('claude selected, only codex present', async t => {
    const { parent, workspace } = await fixture(t, 'claude');
    const codex = await fakeCli(path.join(parent, 'bin'), 'codex');
    await isolatedEnvironment(t, parent, { bin: path.dirname(codex), codex, claude: path.join(parent, 'missing', 'claude') });
    const report = await doctorWorkspace({ workspace_path: workspace });
    const checks = byName(report);
    assert.equal(report.ok, false);
    assert.equal(checks['Claude Code'].ok, false);
    assert.match(checks['Claude Code'].detail, /CLAUDE_CLI_PATH/);
    assert.equal(checks.Codex, undefined);
    assert.equal(checks['State database'].ok, true);
  });
  await t.test('codex selected, only claude present', async t => {
    const { parent, workspace } = await fixture(t, 'codex');
    const claude = await fakeCli(path.join(parent, 'bin'), 'claude');
    await isolatedEnvironment(t, parent, { bin: path.dirname(claude), claude, codex: path.join(parent, 'missing', 'codex') });
    const report = await doctorWorkspace({ workspace_path: workspace });
    const checks = byName(report);
    assert.equal(report.ok, false);
    assert.equal(checks.Codex.ok, false);
    assert.equal(checks['Claude Code'], undefined);
    assert.equal(checks['State database'].ok, true);
  });
});

test('Doctor honors the executable override environment variables', async t => {
  await t.test('CLAUDE_CLI_PATH', async t => {
    const { parent, workspace } = await fixture(t, 'claude');
    const claude = await fakeCli(path.join(parent, 'override'), 'claude');
    await isolatedEnvironment(t, parent, { claude });
    const report = await doctorWorkspace({ workspace_path: workspace });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(byName(report)['Claude Code'].detail, `${process.version} (${claude})`);
  });
  await t.test('CODEX_CLI_PATH', async t => {
    const { parent, workspace } = await fixture(t);
    const codex = await fakeCli(path.join(parent, 'override'), 'codex');
    await isolatedEnvironment(t, parent, { codex });
    const report = await doctorWorkspace({ workspace_path: workspace });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
    assert.equal(byName(report).Codex.detail, `${process.version} (${codex})`);
  });
});

test('Doctor reports an invalid configuration and keeps independent diagnostics', async t => {
  await t.test('unknown harness', async t => {
    const { parent, workspace } = await fixture(t, 'claude');
    const claude = await fakeCli(path.join(parent, 'bin'), 'claude');
    const codex = await fakeCli(path.join(parent, 'bin'), 'codex');
    await isolatedEnvironment(t, parent, { bin: path.dirname(claude), codex });
    const configFile = path.join(workspace, 'overdrive.json');
    await fs.writeFile(configFile, JSON.stringify({ ...JSON.parse(await fs.readFile(configFile, 'utf8')), harness: 'gemini' }, null, 2));
    const report = await doctorWorkspace({ workspace_path: workspace });
    const checks = byName(report);
    assert.equal(report.ok, false);
    assert.equal(checks.Configuration.ok, false);
    assert.match(checks.Configuration.detail, /harness must be codex or claude, not "gemini"/);
    assert.equal(checks.Codex, undefined);
    assert.equal(checks['Claude Code'], undefined);
    for (const name of ['Git', 'Node', 'State database', 'Repository cache', 'Feature paths']) assert.equal(checks[name].ok, true, name);
  });
  await t.test('unreadable overdrive.json', async t => {
    const { parent, workspace } = await fixture(t, 'claude');
    const claude = await fakeCli(path.join(parent, 'bin'), 'claude');
    await isolatedEnvironment(t, parent, { bin: path.dirname(claude) });
    await fs.writeFile(path.join(workspace, 'overdrive.json'), '{ not json');
    const report = await doctorWorkspace({ workspace_path: workspace });
    const checks = byName(report);
    assert.equal(report.ok, false);
    assert.equal(checks.Configuration.ok, false);
    assert.equal(checks['Claude Code'], undefined);
    for (const name of ['Git', 'Node', 'Repository cache']) assert.equal(checks[name].ok, true, name);
  });
});

test('Doctor still probes the selected CLI and repository cache when the database is damaged', async t => {
  const { parent, workspace } = await fixture(t, 'claude');
  const claude = await fakeCli(path.join(parent, 'bin'), 'claude');
  await isolatedEnvironment(t, parent, { bin: path.dirname(claude) });
  const database = path.join(workspace, '.overdrive', 'state.sqlite3');
  for (const suffix of ['-wal', '-shm']) await fs.rm(`${database}${suffix}`, { force: true });
  await fs.writeFile(database, 'this is not a SQLite database'.repeat(200));
  const report = await doctorWorkspace({ workspace_path: workspace });
  const checks = byName(report);
  assert.equal(report.ok, false);
  assert.equal(checks.Configuration.ok, true);
  assert.equal(checks['Claude Code'].ok, true);
  assert.equal(checks.Workspace.ok, false);
  assert.match(checks.Workspace.detail, /not a database/i);
  assert.equal(checks['Repository cache'].ok, true);
});
