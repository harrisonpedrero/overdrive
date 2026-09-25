import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WorkerBridge } from '../plugins/overdrive/scripts/app-server.mjs';
import { ClaudeWorkerBridge, normalizeWorkerOptions, workerEnvironment, workerLaunchArgs } from '../plugins/overdrive/scripts/claude-worker.mjs';
import { createAgentRuntime } from '../plugins/overdrive/scripts/agent-runtime.mjs';
import { createFeature, getFeatureContext, initializeManagedProject, readUnconfirmedDescendants, readWorkerGuards, updateFeature, workerHarness } from '../plugins/overdrive/scripts/workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, 'fixtures', 'fake-claude-cli.mjs');

async function fixture(t, claude = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-claude-'));
  await initializeManagedProject({ workspace_path: root, project_name: 'Claude fixture', description: 'Exercise the Claude worker bridge.', harness: 'claude' });
  await createFeature({ workspace_path: root, feature: 'alpha', title: 'Alpha', outcome: 'Complete one bounded turn.', spec: '# Alpha\n\nComplete the fixture.' });
  const argsFile = path.join(root, 'fake-claude-args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  t.after(() => { delete process.env.FAKE_CLAUDE_ARGS_FILE; });
  const bridge = new WorkerBridge({ claude: { launch: { command: process.execPath, args: [fakeCli] }, ...claude } });
  const runtime = createAgentRuntime(bridge);
  t.after(async () => {
    await runtime.shutdownAgentRuntime();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { args: { workspace_path: root, feature: 'alpha' }, argsFile, bridge, runtime };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('State did not converge');
}

const agentStatus = async args => (await getFeatureContext(args)).feature.agent.status;

function expireControllerOwner(root) {
  const db = new DatabaseSync(path.join(root, '.overdrive', 'state.sqlite3'));
  try { db.prepare("UPDATE meta SET value = json_set(value, '$.pid', ?) WHERE key LIKE 'agent-owner:%'").run(spawnSync(process.execPath, ['-e', '']).pid); }
  finally { db.close(); }
}

test('claude worker launch follows its capability profile, resumes and is free of nested-session markers', () => {
  const workerServer = { command: 'node', args: ['server.mjs'], env: { OVERDRIVE_AGENT: 'alpha', OVERDRIVE_WORKSPACE: 'C:/overdrive' } };
  const meta = { id: 'session-1', persisted: false, model: 'opus', options: normalizeWorkerOptions({}), profile: 'feature', workerServer, addDirs: ['C:/overdrive/.overdrive/features/alpha'], developerInstructions: 'lane contract', name: 'OVERDRIVE · Alpha' };
  const first = workerLaunchArgs(meta, 'ultra');
  for (const flag of ['--no-chrome', '--settings', 'mcp__claude-in-chrome', 'mcp__playwright']) assert.ok(first.includes(flag), flag);
  for (const flag of ['--strict-mcp-config', '--setting-sources', '--disable-slash-commands', '--allowedTools']) assert.ok(!first.includes(flag), flag);
  assert.deepEqual(JSON.parse(first[first.indexOf('--mcp-config') + 1]), { mcpServers: { overdrive: workerServer } });
  assert.equal(first[first.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.ok(first.includes('--session-id') && first.includes('session-1'));
  assert.ok(first.includes('--effort') && first.includes('max'));
  assert.ok(first.includes('--permission-mode') && first.includes('acceptEdits'));
  assert.ok(first.includes('--add-dir') && first.includes('--append-system-prompt') && first.includes('--name'));
  const qa = workerLaunchArgs({ ...meta, profile: 'qa' }, 'high');
  assert.ok(qa.includes('--chrome') && !qa.includes('--no-chrome') && qa.includes('--mcp-config'));
  assert.deepEqual(qa.slice(qa.indexOf('--disallowedTools') + 1, qa.indexOf('--mcp-config')), ['Bash(git push:*)', 'Bash(gh pr:*)']);
  const resumed = workerLaunchArgs({ ...meta, persisted: true }, 'high');
  assert.ok(resumed.includes('--resume') && !resumed.includes('--session-id') && !resumed.includes('--name'));
  const env = workerEnvironment({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '1', PATH: 'p', ANTHROPIC_BASE_URL: 'u' });
  assert.deepEqual(env, { ANTHROPIC_BASE_URL: 'u', PATH: 'p', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', OVERDRIVE_WORKER: '1' });
  for (const inherited of [{ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, { claude_code_disable_auto_memory: '0' }]) {
    const forced = workerEnvironment({ ...inherited, CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: 'h' });
    assert.deepEqual(forced, { CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: 'h', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', OVERDRIVE_WORKER: '1' });
  }
  assert.throws(() => normalizeWorkerOptions({ permissionMode: 'plan' }), error => error.code === 'INVALID_STATE');
  assert.throws(() => normalizeWorkerOptions({ allowedTools: 'Bash' }), error => error.code === 'INVALID_STATE');
  const custom = normalizeWorkerOptions({ permissionMode: 'bypassPermissions', allowedTools: [], disallowedTools: ['WebFetch'] });
  assert.ok(workerLaunchArgs({ ...meta, options: custom }, 'high').includes('--allow-dangerously-skip-permissions'));
});

test('overdrive.json selects the harness and per-lane model', () => {
  assert.deepEqual(workerHarness({}, 'alpha'), { harness: 'codex', workerModel: 'gpt-6-sol', harnessOptions: {} });
  assert.equal(workerHarness({ codex: { model: 'gpt-6-luna' } }, 'alpha').workerModel, 'gpt-6-luna');
  assert.equal(workerHarness({ codex: { model: 'gpt-6-luna', laneModels: { alpha: 'gpt-6-sol' } } }, 'alpha').workerModel, 'gpt-6-sol');
  assert.equal(workerHarness({ codex: { model: 'gpt-6-luna', laneModels: { alpha: 'gpt-6-sol' } } }, 'beta').workerModel, 'gpt-6-luna');
  assert.equal(workerHarness({ codex: { model: 'gpt-6-sol', laneModels: {} } }, 'constructor').workerModel, 'gpt-6-sol');
  for (const codex of [null, 'gpt-6-sol', { model: '' }, { model: null }, { model: 'bad model' }, { laneModels: [] }, { laneModels: null }, { laneModels: { beta: 3 } }]) {
    assert.throws(() => workerHarness({ codex }, 'alpha'), error => error.code === 'INVALID_STATE');
  }
  const claude = workerHarness({ harness: 'claude', claude: { model: 'opus', laneModels: { beta: 'sonnet' }, permissionMode: 'dontAsk' } }, 'beta');
  assert.deepEqual(claude, { harness: 'claude', workerModel: 'sonnet', harnessOptions: { permissionMode: 'dontAsk' } });
  assert.equal(workerHarness({ harness: 'claude' }, 'alpha').workerModel, null);
  assert.equal(workerHarness({ harness: 'claude', claude: { model: 'opus', laneModels: {} } }, 'constructor').workerModel, 'opus');
  assert.throws(() => workerHarness({ harness: 'gemini' }, 'alpha'), error => error.code === 'INVALID_STATE');
});

test('claude harness turn records only visible handoff and working diff, accepts a mid-turn steer, then resumes', async t => {
  const { args, argsFile, runtime } = await fixture(t);
  // The fake CLI holds its first response until the steer arrives, so the steer is always mid-turn.
  const started = await runtime.startFeatureAgent({ ...args, instruction: 'Write the first file; hold-for-steer.' });
  assert.equal(started.harness, 'claude');
  assert.equal(started.model, 'harness-default');
  const launch = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  assert.ok(launch.args.includes('--session-id') && launch.args.includes(started.threadId));
  const { env: identity } = JSON.parse(launch.args[launch.args.indexOf('--mcp-config') + 1]).mcpServers.overdrive;
  assert.deepEqual(identity, { OVERDRIVE_AGENT: 'alpha', OVERDRIVE_WORKSPACE: path.resolve(args.workspace_path) });
  assert.ok(launch.args.includes('--no-chrome') && launch.args.includes('--add-dir'));
  assert.ok(!launch.claudeEnv.includes('CLAUDECODE') && !launch.claudeEnv.includes('CLAUDE_CODE_SESSION_ID'));
  assert.ok(launch.claudeEnv.includes('CLAUDE_CODE_DISABLE_AUTO_MEMORY'));
  assert.equal(path.resolve(launch.cwd), path.resolve(started.checkoutPath));
  const steered = await runtime.steerFeatureAgent({ ...args, message: 'Also write the second file.' });
  assert.equal(steered.mode, 'mid_turn');
  await eventually(async () => (await agentStatus(args)) === 'idle');
  const state = await runtime.inspectFeatureAgent(args);
  assert.match(state.feature.summary, /^Handoff 2: wrote worker-2\.txt\./);
  assert.match(state.feature.summary, /denied 1 tool call\(s\): WebFetch/);
  const diff = state.timeline.find(event => event.kind === 'agent.diff');
  assert.equal(diff.details.fileCount, 2);
  assert.deepEqual(diff.details.files.sort(), ['worker-1.txt', 'worker-2.txt']);
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /private-do-not-persist|secret-tool-output/);
  assert.equal(state.git.clean, false);
  const again = await runtime.startFeatureAgent({ ...args, instruction: 'Continue.' });
  assert.equal(again.threadId, started.threadId);
  assert.equal(again.createdSession, false);
  const resumed = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  assert.ok(resumed.args.includes('--resume') && resumed.args.includes(started.threadId));
  await eventually(async () => (await agentStatus(args)) === 'idle');
  assert.match((await getFeatureContext(args)).feature.summary, /^Handoff 3: wrote worker-3\.txt\./);
});

test('a failed Claude turn keeps a bounded, redacted diagnostic and stays resumable', async t => {
  const cases = [
    { instruction: 'fail-fields', progress: true, detail: /^Claude Code reported a failed result \(error_during_execution\): API Error: Connection error\. connect ECONNREFUSED 127\.0\.0\.1:9/, secret: /fake-bearer-secret-value|end-of-noise/ },
    { instruction: 'fail-stderr', progress: true, detail: /^Claude Code reported a failed result \(error_during_execution\); its stderr ended with:\n[\s\S]*Error: connect ECONNREFUSED 127\.0\.0\.1:9/, secret: /fake-stderr-secret-value/ },
    { instruction: 'fail-result', progress: false, detail: /^API Error: connect ECONNREFUSED 127\.0\.0\.1:9 api_key=\[redacted\] noise[\s\S]* \[truncated\]$/, secret: /fake-result-secret-value|end-of-noise/ },
    { instruction: 'fail-exit', progress: false, detail: /^Claude worker exited \(1\) before completing the turn\. startup-noise\n[\s\S]*Error: connect ECONNREFUSED 127\.0\.0\.1:9 password=\[redacted\]$/, secret: /fake-exit-secret-value/ },
  ];
  for (const { instruction, progress, detail, secret } of cases) {
    const { args, argsFile, bridge, runtime } = await fixture(t);
    const started = await runtime.startFeatureAgent({ ...args, instruction });
    await eventually(async () => (await agentStatus(args)) === 'failed');
    const [turn] = (await bridge.request('thread/read', { harness: 'claude', threadId: started.threadId })).thread.turns;
    assert.equal(turn.status, 'failed');
    const reported = turn.items.map(item => item.text).join('\n');
    assert.match(reported, detail);
    assert.doesNotMatch(reported, secret);
    assert.ok(reported.length < 2_000, `diagnostic is bounded (${reported.length})`);
    const state = await getFeatureContext(args);
    assert.equal(state.feature.agent.activeTurnId, null);
    assert.match(state.feature.summary, detail);
    assert.doesNotMatch(state.feature.summary, secret);
    // Visible progress text from before a failure without a result string follows the diagnostic.
    assert.equal(/Working on message 1\./.test(state.feature.summary), progress);
    assert.doesNotMatch(JSON.stringify(state), /private-do-not-persist/);
    // Failure is not retried or masked; an explicit start resumes the same session.
    const again = await runtime.startFeatureAgent({ ...args, instruction: 'Continue.' });
    assert.equal(again.threadId, started.threadId);
    assert.ok(JSON.parse(await fs.readFile(argsFile, 'utf8')).args.includes('--resume'));
    await eventually(async () => (await agentStatus(args)) === 'idle');
    assert.match((await getFeatureContext(args)).feature.summary, /^Handoff 1: wrote worker-1\.txt\./);
  }
});

test('a failed Claude result prefers its result string, then falls back to a generic reason', async t => {
  const failures = [
    [{ result: 'Credit balance is too low', errors: ['ignored'] }, /^Credit balance is too low$/],
    [{ result: '  ' }, /^Claude Code reported a failed result \(error_during_execution\) without diagnostic detail\.$/],
    [{ result: '', error: { type: 'api_error', error: { message: 'Overloaded (token=abc123 retry later)' } } }, /^Claude Code reported a failed result \(error_during_execution\): Overloaded \(token=\[redacted\] retry later\)$/],
    // A secret at the clip boundary is redacted before the clip, so no part of it survives.
    [{ result: '', errors: [`${'x'.repeat(1_190)} sk-abcdefghijklmnopqrstuvwxyz`] }, /^Claude Code reported a failed result \(error_during_execution\): x{1190} \[redacted \[truncated\]$/],
  ];
  for (const [fields, expected] of failures) {
    const result = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, ...fields });
    const script = `process.stdin.once('data', () => process.stdout.write(${JSON.stringify(result)} + '\\n')); process.stdin.on('end', () => process.exit(0));`;
    const { completed } = await bridgeTurn(t, { input: 'go', launchArgs: ['-e', script, '--'] });
    await eventually(() => completed.length === 1);
    assert.equal(completed[0].status, 'failed');
    assert.equal(completed[0].items.length, 1);
    assert.match(completed[0].items[0].text, expected);
  }
});

test('a failed Claude result waiting for stderr refuses steering and ends within its bound', async t => {
  // Reports a blank failed result, writes its reason to stderr, then ignores the stdin close.
  const result = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
  const script = `process.stdin.once('data', () => process.stdout.write(${JSON.stringify(result)} + '\\n', () => process.stderr.write('connect ECONNREFUSED 127.0.0.1:9\\n'))); process.stdin.resume(); setInterval(() => {}, 1000);`;
  const { bridge, threadId, turnId, child, completed } = await bridgeTurn(t, { input: 'go', treeKill: treeKiller, launchArgs: ['-e', script, '--'] });
  await eventually(() => Boolean(bridge.threads.get(threadId).active?.failedResult));
  await assert.rejects(bridge.request('turn/steer', { threadId, expectedTurnId: turnId, input: 'more' }), error => error.code === 'TURN_MISMATCH');
  await eventually(() => completed.length === 1);
  assert.equal(child.exitCode, null, 'the worker still runs, so the bound ended the turn');
  assert.equal(completed[0].status, 'failed');
  assert.match(completed[0].items[0].text, /its stderr ended with:\nconnect ECONNREFUSED 127\.0\.0\.1:9$/);
  assert.equal(bridge.threads.get(threadId).active, null);
  assert.equal((await bridge.request('thread/read', { threadId })).thread.status, 'idle');
  // The lingering worker is stopped before the next turn, which runs normally.
  assert.ok((await bridge.request('turn/start', { threadId, input: 'again' })).turn.id);
});

test('an interrupt during a failed result stderr wait decides the turn by termination', async t => {
  const result = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
  const report = `process.stdout.write(${JSON.stringify(result)} + '\\n', () => process.stderr.write('connect ECONNREFUSED 127.0.0.1:9 token=fake-wait-secret\\n', after))`;
  // Keeps running after its report; the wait therefore lasts its whole bound.
  const stays = `const after = () => {}; process.stdin.once('data', () => ${report}); process.stdin.resume(); setInterval(() => {}, 1000);`;
  // Exits after its report while a detached helper holds its stderr open, so the exit is seen
  // before stderr closes.
  const exits = `const after = () => process.exit(0); process.stdin.once('data', () => { require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true, windowsHide: true }); ${report}; });`;
  const diagnostic = /^Claude Code reported a failed result \(error_during_execution\); its stderr ended with:\nconnect ECONNREFUSED 127\.0\.0\.1:9 token=\[redacted\]$/;
  const waiting = async (bridge, threadId, child, exitFirst) => {
    await eventually(() => {
      const turn = bridge.threads.get(threadId).active;
      return Boolean(turn?.failedResult) && turn.stderrTail.includes('ECONNREFUSED') && (!exitFirst || child.exitCode !== null);
    });
  };
  const settled = async (bridge, threadId, completed, status) => {
    // Past the one-second wait bound, the turn has still been decided only once.
    await eventually(() => completed.length === 1);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, status);
    assert.equal((await bridge.request('thread/read', { threadId })).thread.turns.at(-1).status, status);
    assert.equal(bridge.threads.get(threadId).active, null);
    assert.doesNotMatch(JSON.stringify(completed[0]), /fake-wait-secret/);
  };

  // A stopped worker: the interrupt succeeds and the turn is interrupted, keeping the diagnostic.
  // Uncontained, even a successful tree kill cannot confirm the tools it launched.
  for (const [script, exitFirst] of [[stays, false], [exits, true]]) {
    const { bridge, threadId, turnId, child, completed } = await bridgeTurn(t, { input: 'go', treeKill: treeKiller, launchArgs: ['-e', script, '--'] });
    await waiting(bridge, threadId, child, exitFirst);
    assert.deepEqual(await bridge.request('turn/interrupt', { threadId, turnId }), { interrupted: true, descendantsUnconfirmed: true });
    await settled(bridge, threadId, completed, 'interrupted');
    assert.match(completed[0].items[0].text, diagnostic);
  }

  // A worker that cannot be stopped outlasts the wait bound; the interrupt fails and so does the turn.
  const { bridge, threadId, turnId, child, completed } = await bridgeTurn(t, { input: 'go', treeKill: stalledKiller, terminationTimeoutMs: 1_500, launchArgs: ['-e', stays, '--'] });
  await waiting(bridge, threadId, child, false);
  child.kill = () => false;
  await assert.rejects(bridge.request('turn/interrupt', { threadId, turnId }), error => error.code === 'CLAUDE_TERMINATION_FAILED');
  await settled(bridge, threadId, completed, 'failed');
  assert.match(completed[0].items[0].text, /^Interrupt could not stop Claude worker process \d+/);
});

test('claude harness interrupt ends a hanging turn as interrupted', async t => {
  const { args, runtime } = await fixture(t);
  await runtime.startFeatureAgent({ ...args, instruction: 'hang' });
  await eventually(async () => (await agentStatus(args)) === 'running');
  const interrupted = await runtime.interruptFeatureAgent(args);
  assert.equal(interrupted.interrupted, true);
  await eventually(async () => (await agentStatus(args)) === 'interrupted');
  const state = await getFeatureContext(args);
  assert.equal(state.feature.agent.activeTurnId, null);
});

// Stand-ins for taskkill: one that exits nonzero without killing, one that never returns.
const failingKiller = () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] });
const stalledKiller = () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] });

// Bridge-level turns run uncontained unless a test opts in, so stubbed killers and processes
// model the worker process itself; containment has its own tests.
async function bridgeTurn(t, { input = 'hang', launchArgs = [fakeCli], ...options } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-claude-bridge-'));
  const bridge = new ClaudeWorkerBridge({ launch: { command: process.execPath, args: launchArgs }, terminationTimeoutMs: 500, containment: null, ...options });
  const completed = [];
  bridge.on('notification', message => { if (message.method === 'turn/completed') completed.push(message.params.turn); });
  let child;
  t.after(async () => {
    await bridge.shutdown();
    // Tests may stub child.kill to model an unstoppable worker; restore it and really stop it.
    if (child && child.exitCode === null && child.signalCode === null) {
      delete child.kill;
      const gone = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await gone;
    }
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  });
  const { thread } = await bridge.startThread({ cwd });
  const { turn } = await bridge.request('turn/start', { threadId: thread.id, input });
  child = bridge.threads.get(thread.id).active.child;
  return { bridge, cwd, threadId: thread.id, turnId: turn.id, child, completed };
}

test('claude interrupt report waits for the worker to exit', async t => {
  const { args, runtime } = await fixture(t, { treeKill: failingKiller, terminationTimeoutMs: 500, containment: null });
  await runtime.startFeatureAgent({ ...args, instruction: 'hang' });
  await eventually(async () => (await agentStatus(args)) === 'running');
  const interrupted = await runtime.interruptFeatureAgent(args);
  assert.equal(interrupted.interrupted, true);
  await eventually(async () => (await agentStatus(args)) === 'interrupted');
  assert.match((await getFeatureContext(args)).feature.summary, /tools it launched may still be running/);
});

test('claude interrupt falls back to the direct child when the tree killer fails or stalls', async t => {
  for (const treeKill of [failingKiller, stalledKiller]) {
    const { bridge, threadId, turnId, child, completed } = await bridgeTurn(t, { treeKill });
    // Success is reported, but descendants are not confirmed stopped, and the report says so.
    assert.deepEqual(await bridge.request('turn/interrupt', { threadId, turnId }), { interrupted: true, descendantsUnconfirmed: true });
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'worker exited before interrupt reported success');
    await eventually(() => completed.length === 1);
    assert.deepEqual({ status: completed[0].status, descendantsUnconfirmed: completed[0].descendantsUnconfirmed }, { status: 'interrupted', descendantsUnconfirmed: true });
    assert.match(completed[0].items.at(-1).text, /only the worker process itself was terminated/);
    const thread = (await bridge.request('thread/read', { threadId })).thread;
    assert.deepEqual({ status: thread.status, descendantsUnconfirmed: thread.turns.at(-1).descendantsUnconfirmed }, { status: 'idle', descendantsUnconfirmed: true });
  }
});

test('claude worker result that arrives during an interrupt cannot complete the turn', async t => {
  // The worker answers a trigger with a success result, then records that it wrote it. The tree
  // killer sends the trigger and exits nonzero only after that record, so the result is always
  // in flight while termination is still undecided.
  const worker = "let seen = ''; process.stdin.on('data', chunk => { seen += chunk; if (!seen.includes('trigger')) return; seen = ''; process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Late result.' }) + '\\n', () => require('fs').writeFileSync(process.argv[1], 'written')); }); setInterval(() => {}, 1000);";
  const killer = "const fs = require('fs'); setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(1); }, 20);";
  for (const killable of [false, true]) {
    const marker = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-claude-marker-')), 'result-written');
    t.after(() => fs.rm(path.dirname(marker), { recursive: true, force: true }));
    let worker$;
    const treeKill = () => {
      worker$.stdin.write('{"trigger":true}\n');
      return { command: process.execPath, args: ['-e', killer, '--', marker] };
    };
    const { bridge, threadId, turnId, child, completed } = await bridgeTurn(t, { treeKill, launchArgs: ['-e', worker, '--', marker] });
    worker$ = child;
    if (!killable) child.kill = () => false;
    const interrupt = bridge.request('turn/interrupt', { threadId, turnId });
    // The tree killer fails, so a killable worker is stopped without confirming its descendants.
    if (killable) assert.deepEqual(await interrupt, { interrupted: true, descendantsUnconfirmed: true });
    else await assert.rejects(interrupt, error => error.code === 'CLAUDE_TERMINATION_FAILED');
    assert.equal(await fs.readFile(marker, 'utf8'), 'written');
    await eventually(() => completed.length === 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, killable ? 'interrupted' : 'failed');
    assert.doesNotMatch(JSON.stringify(completed[0]), /Late result/);
    assert.equal((await bridge.request('thread/read', { threadId })).thread.turns.at(-1).status, completed[0].status);
  }
});

test('claude turn whose process outlives its result is stopped before the next turn and at shutdown', async t => {
  // Answers every message but ignores the stdin close that should end it.
  const worker = "process.stdin.on('data', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Answered.' }) + '\\n')); setInterval(() => {}, 1000);";
  const { bridge, threadId, child, completed } = await bridgeTurn(t, { treeKill: failingKiller, input: 'first', launchArgs: ['-e', worker, '--'] });
  await eventually(() => completed.length === 1);
  assert.equal(completed[0].status, 'completed');
  assert.equal(child.exitCode, null);
  await bridge.request('turn/start', { threadId, input: 'second' });
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'previous worker stopped before the next launch');
  await eventually(() => completed.length === 2);
  const second = bridge.threads.get(threadId).lingering;
  assert.ok(second && second.exitCode === null);
  assert.deepEqual(await bridge.shutdown(), { unstopped: [] });
  assert.ok(second.exitCode !== null || second.signalCode !== null);
});

test('claude bridge shutdown reports worker processes it could not stop', async t => {
  const stubborn = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);', '--'];
  const { bridge, child } = await bridgeTurn(t, { treeKill: failingKiller, launchArgs: stubborn });
  child.kill = () => false;
  assert.deepEqual(await bridge.shutdown(), { unstopped: [child.pid] });
  assert.equal(child.exitCode, null);
});

test('claude interrupt that cannot stop the worker fails visibly and blocks the next turn until it exits', async t => {
  // This worker also outlives the stdin close that ends a failed turn.
  const stubborn = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);', '--'];
  const { bridge, cwd, threadId, turnId, child, completed } = await bridgeTurn(t, { treeKill: failingKiller, launchArgs: stubborn });
  child.kill = () => false;
  await assert.rejects(bridge.request('turn/interrupt', { threadId, turnId }), error => error.code === 'CLAUDE_TERMINATION_FAILED' && error.message.includes(String(child.pid)));
  assert.equal(child.exitCode, null);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'failed');
  assert.match(completed[0].items[0].text, /could not stop Claude worker process \d+/);
  await assert.rejects(bridge.request('turn/start', { threadId, input: 'again' }), error => error.code === 'CLAUDE_STILL_RUNNING');
  await bridge.resumeThread({ threadId, cwd });
  await assert.rejects(bridge.request('turn/start', { threadId, input: 'again' }), error => error.code === 'CLAUDE_STILL_RUNNING');
  delete child.kill;
  child.kill();
  await eventually(() => child.exitCode !== null || child.signalCode !== null);
  const next = await bridge.request('turn/start', { threadId, input: 'hang' });
  assert.ok(next.turn.id);
});

test('pausing a claude lane is refused while its worker process still runs, even after the turn record ends', async t => {
  const stubborn = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);', '--'];
  const { args, bridge, runtime } = await fixture(t, { launch: { command: process.execPath, args: stubborn }, treeKill: failingKiller, terminationTimeoutMs: 500, containment: null });
  const started = await runtime.startFeatureAgent(args);
  const worker = bridge.backend('claude').threads.get(started.threadId).active.child;
  t.after(async () => {
    if (worker.exitCode !== null || worker.signalCode !== null) return;
    delete worker.kill;
    const gone = new Promise(resolve => worker.once('exit', resolve));
    worker.kill();
    await gone;
  });
  worker.kill = () => false;
  const pause = () => runtime.stopFeatureLane({ ...args, status: 'paused' });
  await assert.rejects(pause(), error => error.code === 'STOP_UNCONFIRMED' && error.message.includes(String(worker.pid)));
  assert.equal(worker.exitCode, null);
  // The failed interrupt ended the turn record, but its process still runs, so a retry is refused too.
  await eventually(async () => (await agentStatus(args)) === 'failed');
  await assert.rejects(pause(), error => error.code === 'STOP_UNCONFIRMED' && error.details?.lingeringProcess === true);
  assert.equal(worker.exitCode, null);
  const state = await getFeatureContext({ ...args, timeline_limit: 50 });
  assert.equal(state.feature.status, 'active');
  assert.equal(state.timeline.filter(entry => entry.kind === 'feature.stop_unconfirmed').length, 2);
  assert.ok(!state.timeline.some(entry => entry.kind === 'feature.paused'));
  // Once the process can be stopped, the pause stops it, but only the process itself (the tree
  // killer fails), so the pause is still unconfirmed until the coordinator attests.
  delete worker.kill;
  await assert.rejects(pause(), error => error.code === 'STOP_UNCONFIRMED' && error.details?.lingeringProcess === true && /tools that may still be running/.test(error.message));
  assert.ok(worker.exitCode !== null || worker.signalCode !== null);
  await assert.rejects(pause(), error => error.code === 'STOP_UNCONFIRMED' && error.details?.descendantsUnconfirmed === true);
  assert.equal((await getFeatureContext(args)).feature.status, 'active');
  // This worker launched nothing, which the test has verified by construction.
  const paused = await runtime.stopFeatureLane({ ...args, status: 'paused', prior_turn_attestation: { evidence: 'The stubborn fixture worker spawns no child processes and has exited.' } });
  assert.equal(paused.feature.status, 'paused');
  assert.ok((await getFeatureContext({ ...args, timeline_limit: 50 })).timeline.some(entry => entry.kind === 'agent.descendants_attested'));
  await assert.rejects(runtime.startFeatureAgent(args), error => error.code === 'INVALID_TRANSITION');
});

// A worker that launches a long-lived tool process, records its PID, then keeps running. The tool
// is detached so it is outside the worker's kill-on-close job on Windows and survives when only the
// worker itself is killed, as it does after a failed taskkill /T.
const toolLauncher = "const { spawn } = require('child_process'); const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true, windowsHide: true }); require('fs').writeFileSync(process.argv[1], String(tool.pid)); process.stdin.resume(); setInterval(() => {}, 1000);";
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

test('a pause that ends the worker but not the tools it launched is refused until they are verified stopped', async t => {
  const pidFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-claude-tool-')), 'tool.pid');
  const { args, runtime } = await fixture(t, { launch: { command: process.execPath, args: ['-e', toolLauncher, '--', pidFile] }, treeKill: failingKiller, terminationTimeoutMs: 500, containment: null });
  const tools = [];
  t.after(async () => {
    for (const pid of tools) if (alive(pid)) process.kill(pid);
    await fs.rm(path.dirname(pidFile), { recursive: true, force: true, maxRetries: 5 });
  });
  const launch = async (instruction, extra = {}) => {
    await fs.rm(pidFile, { force: true });
    await runtime.startFeatureAgent({ ...args, instruction, ...extra });
    let pid = 0;
    await eventually(async () => { try { pid = Number(await fs.readFile(pidFile, 'utf8')); return pid > 0; } catch { return false; } });
    tools.push(pid);
    return pid;
  };
  const stopTool = async pid => { process.kill(pid); await eventually(() => !alive(pid)); };
  const pause = extra => runtime.stopFeatureLane({ ...args, status: 'paused', ...extra });
  const lane = async () => {
    const state = await getFeatureContext({ ...args, timeline_limit: 100 });
    return { status: state.feature.status, agent: state.feature.agent.status, turnId: state.feature.agent.activeTurnId, events: state.timeline.map(entry => entry.kind) };
  };

  // The interrupt stops the worker and its turn is recorded as ended, but the tool survives.
  const first = await launch('first');
  await assert.rejects(pause(), error => error.code === 'STOP_UNCONFIRMED' && error.details?.descendantsUnconfirmed === true);
  assert.ok(alive(first), 'the launched tool is still running');
  let state = await lane();
  assert.deepEqual({ status: state.status, agent: state.agent, turnId: state.turnId }, { status: 'active', agent: 'interrupted', turnId: null });
  assert.ok(state.events.includes('agent.descendants_unconfirmed'));
  assert.ok(!state.events.includes('feature.paused'));

  // Retrying is refused, and so is an archive.
  await assert.rejects(pause(), error => error.code === 'STOP_UNCONFIRMED' && error.details?.descendantsUnconfirmed === true);
  await assert.rejects(runtime.stopFeatureLane({ ...args, status: 'archived', summary: 'Dropped.' }), error => error.code === 'STOP_UNCONFIRMED');
  assert.ok(alive(first));
  assert.equal((await lane()).status, 'active');

  // No next turn starts while the first tool is unconfirmed. Once it is verified stopped, a turn
  // start carrying that attestation clears the marker and runs; the second turn leaves a new
  // unconfirmed tool, and an attestation sent with the stop that produced it cannot cover it,
  // though it names a real check.
  await stopTool(first);
  await assert.rejects(runtime.startFeatureAgent({ ...args, instruction: 'second' }), error => error.code === 'WORKERS_UNCONFIRMED' && error.details?.descendantsUnconfirmed === true);
  const second = await launch('second', { prior_turn_attestation: { evidence: `Verified process ${first} launched by the worker has exited.` } });
  await assert.rejects(pause({ prior_turn_attestation: { evidence: `Verified process ${first} launched by the worker has exited.` } }), error => error.code === 'STOP_UNCONFIRMED' && error.details?.descendantsUnconfirmed === true);
  assert.ok(alive(second), 'the second tool is still running');
  state = await lane();
  assert.equal(state.status, 'active');
  assert.ok(!state.events.includes('feature.paused'));
  // Only the turn start's attestation, for the first tool, was recorded.
  assert.equal(state.events.filter(kind => kind === 'agent.descendants_attested').length, 1);

  // After the tool is really stopped, the coordinator's recorded attestation clears the marker.
  await stopTool(second);
  const paused = await pause({ prior_turn_attestation: { evidence: `Verified processes ${first} and ${second} launched by the worker have exited.` } });
  assert.equal(paused.feature.status, 'paused');
  assert.ok((await lane()).events.includes('agent.descendants_attested'));
});
// Answers with a result, then ignores the stdin close that normally ends it.
const lingering = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }) + '\\n')); process.stdin.resume(); setInterval(() => {}, 1000);";
// A tree killer that really ends the (childless) worker, standing in for a successful taskkill /T.
const treeKiller = pid => ({ command: process.execPath, args: ['-e', `process.kill(${pid})`] });

test('a second controller cannot pause an idle lane whose owner may still hold a worker process', async t => {
  const claude = { launch: { command: process.execPath, args: ['-e', lingering, '--'] }, terminationTimeoutMs: 500 };
  const { args, bridge, runtime: owner } = await fixture(t, claude);
  const started = await owner.startFeatureAgent(args);
  await eventually(async () => (await agentStatus(args)) === 'idle');
  const worker = bridge.backend('claude').threads.get(started.threadId).lingering;
  assert.ok(worker && worker.exitCode === null, 'the owner still holds the worker process after its result');
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); });

  // Controller B has no loaded session and cannot see that process.
  const other = createAgentRuntime(new WorkerBridge({ claude }));
  t.after(() => other.shutdownAgentRuntime());
  await assert.rejects(other.stopFeatureLane({ ...args, status: 'paused' }), error => error.code === 'STOP_UNCONFIRMED' && error.details?.foreignOwnerPid === process.pid);
  await assert.rejects(other.stopFeatureLane({ ...args, status: 'archived', summary: 'Dropped.' }), error => error.code === 'STOP_UNCONFIRMED');
  assert.equal(worker.exitCode, null);
  assert.equal((await getFeatureContext(args)).feature.status, 'active');

  // The owning controller stops its process tree and records the pause.
  const paused = await owner.stopFeatureLane({ ...args, status: 'paused' });
  assert.equal(paused.feature.status, 'paused');
  assert.ok(worker.exitCode !== null || worker.signalCode !== null);
});

test('after owner loss an idle lingering Claude worker requires durable stop evidence', async t => {
  const claude = { launch: { command: process.execPath, args: ['-e', lingering, '--'] }, terminationTimeoutMs: 500 };
  const { args, bridge, runtime } = await fixture(t, claude);
  const started = await runtime.startFeatureAgent(args);
  await eventually(async () => (await agentStatus(args)) === 'idle');
  const worker = bridge.backend('claude').threads.get(started.threadId).lingering;
  assert.ok(worker && worker.exitCode === null);
  assert.equal((await readWorkerGuards(args)).length, 1);
  expireControllerOwner(args.workspace_path);
  const restarted = createAgentRuntime(new WorkerBridge({ claude }));
  t.after(() => restarted.shutdownAgentRuntime());
  // The job still exists, so the later controller cannot treat the tree as ended.
  await assert.rejects(restarted.stopFeatureLane({ ...args, status: 'paused' }), error => error.code === 'STOP_UNCONFIRMED' && error.details?.workerGuards === 1);
  // Nor can an attestation speak for a tree whose job proves it may still be running.
  await assert.rejects(restarted.stopFeatureLane({ ...args, status: 'paused', prior_turn_attestation: { evidence: 'Claimed stopped.' } }), error => error.code === 'STOP_UNCONFIRMED' && error.details?.runningJobs === 1);
  assert.equal(worker.exitCode, null);
  assert.equal((await getFeatureContext(args)).feature.status, 'active');
  // The first controller ends the tree without recording it, as if it exited while doing so.
  bridge.removeAllListeners('notification');
  await bridge.settleThread({ threadId: started.threadId });
  assert.ok(worker.exitCode !== null || worker.signalCode !== null);
  // Once the tree is gone, its missing job proves it without an attestation.
  assert.equal((await restarted.stopFeatureLane({ ...args, status: 'paused' })).feature.status, 'paused');
  assert.deepEqual(await readWorkerGuards(args), []);
  assert.ok((await getFeatureContext({ ...args, timeline_limit: 50 })).timeline.some(entry => entry.kind === 'agent.worker_stopped' && entry.details?.basis === 'job_gone'));
  await updateFeature({ ...args, status: 'active' });
  assert.ok((await restarted.startFeatureAgent(args)).turnId);
  await restarted.shutdownAgentRuntime();
});

test('a normally completed Claude turn clears its worker guard before an idle pause', async t => {
  const script = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }) + '\\n', () => process.exit(0)));";
  const { args, runtime } = await fixture(t, { launch: { command: process.execPath, args: ['-e', script, '--'] } });
  await runtime.startFeatureAgent(args);
  await eventually(async () => (await agentStatus(args)) === 'idle' && (await readWorkerGuards(args)).length === 0);
  // The next turn needs no attestation either, and clears in turn.
  assert.ok((await runtime.startFeatureAgent(args)).turnId);
  await eventually(async () => (await agentStatus(args)) === 'idle' && (await readWorkerGuards(args)).length === 0);
  assert.equal((await runtime.stopFeatureLane({ ...args, status: 'paused' })).feature.status, 'paused');
});

const lingeringTool = path.join(here, 'fixtures', 'lingering-tool.mjs');

test('a tool that outlives its Claude turn keeps its guard until its tree ends', { skip: process.platform !== 'win32' && 'process-tree containment is Windows-only' }, async t => {
  // 'tool-tree' is an ordinary shell -> test runner -> test process chain, as npm test run by a
  // Bash tool call; 'spoof' also writes forged containment reports to the stderr it shares.
  for (const [mode, ending] of [['detached', 'exits'], ['tool-tree', 'exits'], ['spoof', 'exits'], ['detached', 'pause'], ['tool-tree', 'next-turn']]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-claude-tool-'));
    const pidFile = path.join(dir, 'tool.pid');
    const release = path.join(dir, 'release');
    const { args, bridge, runtime } = await fixture(t, { launch: { command: process.execPath, args: [lingeringTool, 'cli', mode, pidFile, release] }, terminationTimeoutMs: 500 });
    let pid = 0;
    t.after(async () => {
      await fs.writeFile(release, '').catch(() => {});
      if (pid && alive(pid)) process.kill(pid);
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });
    await runtime.startFeatureAgent(args);
    await eventually(async () => (await agentStatus(args)) === 'idle' && Number(await fs.readFile(pidFile, 'utf8').catch(() => '0')) > 0);
    pid = Number(await fs.readFile(pidFile, 'utf8'));
    // The CLI has reported and exited; only its tool still runs.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.ok(alive(pid), `${mode}: the tool is still running`);
    const [guard, ...others] = await readWorkerGuards(args);
    assert.equal(others.length, 0);
    // Containment really ran: the guard names its job and the bridge did not fall back.
    assert.match(guard?.job ?? '', /^Global\\overdrive-worker-/, `${mode}: the CLI exit did not clear the guard, and it names its job`);
    assert.equal(bridge.backend('claude').containmentUnavailable, null);
    assert.equal((await getFeatureContext(args)).feature.status, 'active');

    if (ending === 'exits') {
      // The tree ends by itself, so the guard clears without any attestation.
      await fs.writeFile(release, '');
      await eventually(async () => (await readWorkerGuards(args)).length === 0);
      assert.ok(!alive(pid));
    } else if (ending === 'pause') {
      // Pausing stops the tree through its job, which confirms it without an attestation.
      assert.equal((await runtime.stopFeatureLane({ ...args, status: 'paused' })).feature.status, 'paused');
      assert.ok(!alive(pid));
      assert.deepEqual(await readWorkerGuards(args), []);
    } else {
      // The next turn stops the earlier tree through its job before it starts.
      await fs.rm(pidFile);
      assert.ok((await runtime.startFeatureAgent(args)).turnId);
      assert.ok(!alive(pid));
      await eventually(async () => (await agentStatus(args)) === 'idle' && (await fs.readFile(pidFile, 'utf8').catch(() => '')).length > 0);
      pid = Number(await fs.readFile(pidFile, 'utf8'));
      assert.equal((await readWorkerGuards(args)).length, 1, 'only the new turn is guarded');
    }
  }
});

test('an uncontained Claude worker leaves every turn unconfirmed until the coordinator attests', async t => {
  const script = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }) + '\\n', () => process.exit(0)));";
  const { args, runtime } = await fixture(t, { launch: { command: process.execPath, args: ['-e', script, '--'] }, containment: null });
  await runtime.startFeatureAgent(args);
  await eventually(async () => (await agentStatus(args)) === 'idle');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await readWorkerGuards(args)).length, 1);
  assert.match((await getFeatureContext(args)).feature.summary, /without process-tree containment \(no process-tree containment is available on this platform\)/);
  await assert.rejects(runtime.startFeatureAgent(args), error => error.code === 'WORKERS_UNCONFIRMED' && error.details?.workerGuards === 1);
  await assert.rejects(runtime.steerFeatureAgent({ ...args, message: 'Continue.' }), error => error.code === 'WORKERS_UNCONFIRMED');
  // The coordinator's attestation clears only the guard it was given for; the new turn is guarded again.
  assert.ok((await runtime.startFeatureAgent({ ...args, prior_turn_attestation: { evidence: 'Verified the fixture worker spawned nothing and exited.' } })).turnId);
  await eventually(async () => (await agentStatus(args)) === 'idle');
  assert.equal((await readWorkerGuards(args)).length, 1);
  assert.ok((await getFeatureContext({ ...args, timeline_limit: 50 })).timeline.some(entry => entry.kind === 'agent.workers_attested'));
});

test('after a controller loses a clean exit, inspection alone clears a guard whose job has ended', { skip: process.platform !== 'win32' && 'process-tree containment is Windows-only' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-claude-inspect-'));
  const pidFile = path.join(dir, 'tool.pid');
  const release = path.join(dir, 'release');
  const claude = { launch: { command: process.execPath, args: [lingeringTool, 'cli', 'detached', pidFile, release] }, terminationTimeoutMs: 500 };
  const { args, bridge, runtime } = await fixture(t, claude);
  t.after(async () => { await fs.writeFile(release, '').catch(() => {}); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const started = await runtime.startFeatureAgent(args);
  await eventually(async () => (await agentStatus(args)) === 'idle' && Number(await fs.readFile(pidFile, 'utf8').catch(() => '0')) > 0);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  // The first controller stops recording before the tree ends; a second one takes over.
  bridge.removeAllListeners('notification');
  expireControllerOwner(args.workspace_path);
  const observer = createAgentRuntime(new WorkerBridge({ claude }));
  t.after(() => observer.shutdownAgentRuntime());

  // While the tool runs, inspection keeps the guard.
  await observer.inspectFeatureAgent(args);
  assert.equal((await readWorkerGuards(args)).length, 1);

  await fs.writeFile(release, '');
  await eventually(() => !alive(pid));
  await (bridge.backend('claude').threads.get(started.threadId).turns.at(-1).settled);
  // The tree has ended but nothing recorded it, so the guard stays.
  assert.equal((await readWorkerGuards(args)).length, 1);
  // Inspection proves it from the job alone, without a turn or a lifecycle change.
  const inspected = await observer.inspectFeatureAgent(args);
  assert.equal(inspected.warning, null);
  assert.deepEqual(await readWorkerGuards(args), []);
  const state = await getFeatureContext({ ...args, timeline_limit: 50 });
  assert.equal(state.feature.status, 'active');
  assert.equal(state.feature.agent.status, 'idle');
  assert.ok(state.timeline.some(entry => entry.kind === 'agent.worker_stopped' && entry.details?.basis === 'job_gone'));
});

// A stand-in warden that reports with token 'tok', answers as the CLI, then, with its tools
// forging reports on the stderr they share, reports the CLI's exit and dies abnormally.
const forgingWarden = [
  "const mark = text => process.stderr.write('\\n\\u001eoverdrive-tree tok ' + text + '\\n');",
  "mark('started 1');",
  "process.stdin.once('data', () => {",
  "  process.stderr.write('\\n\\u001eoverdrive-tree empty\\n\\u001eoverdrive-tree forged exit 0\\n');",
  "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }) + '\\n');",
  '});',
  "process.stdin.on('end', () => { mark('exit 0'); process.stderr.write('', () => process.exit(1)); });",
].join('\n');

test('only the job itself, never a warden report, confirms a Claude worker tree ended', async t => {
  for (const [state, released] of [['present', false], ['unknown', false], ['empty', true], ['absent', true]]) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-claude-forged-'));
    const containment = {
      jobName: id => `Global\\overdrive-worker-${id}`,
      launch: (_cli, job) => ({ command: process.execPath, args: ['-e', forgingWarden], env: {}, job, token: 'tok' }),
      stop: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }),
      query: async () => state,
    };
    const bridge = new ClaudeWorkerBridge({ launch: { command: process.execPath, args: [] }, containment, terminationTimeoutMs: 500 });
    const events = [];
    bridge.on('notification', message => events.push(message));
    t.after(async () => { await bridge.shutdown(); await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }); });
    const { thread } = await bridge.startThread({ cwd });
    await bridge.request('turn/start', { threadId: thread.id, input: 'go', guardId: 'guard-1' });
    const [turn] = bridge.threads.get(thread.id).turns;
    assert.equal(await turn.settled, released ? 'confirmed' : 'unconfirmed', state);
    assert.equal(turn.status, 'completed');
    assert.equal(events.some(message => message.method === 'worker/contained' && message.params.guardId === 'guard-1'), true);
    assert.equal(events.some(message => message.method === 'worker/exited'), released, state);
    // Forged reports were read as the tools' own output.
    assert.match(turn.stderrTail, /overdrive-tree forged exit 0/);
  }
});

test('a warden that cannot establish containment falls back to fail-closed uncontained workers', async t => {
  const failing = {
    jobName: id => `Global\\overdrive-worker-${id}`,
    launch: (_cli, job) => ({ command: process.execPath, args: ['-e', "process.stderr.write('Add-Type is blocked\\n'); process.exit(3)"], env: {}, job, token: 'tok' }),
    stop: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }),
    query: async () => 'unknown',
  };
  const script = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }) + '\\n', () => process.exit(0)));";
  const { bridge, completed } = await bridgeTurn(t, { input: 'go', containment: failing, launchArgs: ['-e', script, '--'] });
  await eventually(() => completed.length === 1);
  assert.equal(completed[0].status, 'completed');
  assert.match(bridge.containmentUnavailable, /warden exited \(3\) before starting the worker: Add-Type is blocked/);
  assert.match(completed[0].items.at(-1).text, /without process-tree containment/);
});

test('controller exit before a clean worker-exit notification leaves the durable guard', async t => {
  // A contained tree leaves a job a later controller can find gone; an uncontained one leaves nothing.
  for (const containment of [undefined, null]) {
    const claude = { launch: { command: process.execPath, args: ['-e', lingering, '--'] }, terminationTimeoutMs: 500, containment };
    const { args, bridge, runtime } = await fixture(t, claude);
    const started = await runtime.startFeatureAgent(args);
    await eventually(async () => (await agentStatus(args)) === 'idle');
    const worker = bridge.backend('claude').threads.get(started.threadId).lingering;
    bridge.removeAllListeners('notification'); // The controller has exited before recording process exit.
    worker.kill();
    await eventually(() => worker.exitCode !== null || worker.signalCode !== null);
    const guards = await readWorkerGuards(args);
    assert.equal(guards.length, 1);
    assert.equal(Boolean(guards[0].job), containment === undefined && process.platform === 'win32');
    expireControllerOwner(args.workspace_path);
    const restarted = createAgentRuntime(new WorkerBridge({ claude }));
    t.after(() => restarted.shutdownAgentRuntime());
    if (guards[0].job) {
      assert.equal((await restarted.stopFeatureLane({ ...args, status: 'paused' })).feature.status, 'paused');
      continue;
    }
    await assert.rejects(restarted.stopFeatureLane({ ...args, status: 'paused' }), error => error.code === 'STOP_UNCONFIRMED' && error.details?.workerGuards === 1);
    assert.equal((await restarted.stopFeatureLane({ ...args, status: 'paused', prior_turn_attestation: { evidence: `Verified worker ${worker.pid} exited after the controller stopped.` } })).feature.status, 'paused');
  }
});

test('a stop cannot settle a lingering worker process without its tree, and the next turn carries that', async t => {
  for (const next of ['settle', 'turn']) {
    const { bridge, threadId, child, completed } = await bridgeTurn(t, { input: 'finish', treeKill: failingKiller, launchArgs: ['-e', lingering, '--'] });
    await eventually(() => completed.length === 1);
    assert.equal(completed[0].status, 'completed');
    assert.equal(child.exitCode, null, 'the worker lingers after its result');
    if (next === 'settle') {
      await assert.rejects(bridge.settleThread({ threadId }), error => error.code === 'CLAUDE_DESCENDANTS_UNCONFIRMED' && error.message.includes(String(child.pid)) && error.details?.turnId === completed[0].id);
    } else {
      const { turn } = await bridge.request('turn/start', { threadId, input: 'hang' });
      assert.equal((await bridge.request('thread/read', { threadId })).thread.turns.find(entry => entry.id === turn.id).descendantsUnconfirmed, true);
    }
    await eventually(() => child.exitCode !== null || child.signalCode !== null);
  }
});

test('a failed next worker launch retains the earlier descendant uncertainty for pause', async t => {
  const { args, bridge, runtime } = await fixture(t, { launch: { command: process.execPath, args: ['-e', lingering, '--'] }, treeKill: failingKiller, terminationTimeoutMs: 500, containment: null });
  await runtime.startFeatureAgent(args);
  await eventually(async () => (await agentStatus(args)) === 'idle');
  bridge.backend('claude').launch.command = path.join(args.workspace_path, 'missing-worker.exe');
  // The next start stops the lingering worker without its tree and records that before refusing.
  await assert.rejects(runtime.startFeatureAgent(args), error => error.code === 'WORKERS_UNCONFIRMED');
  await assert.rejects(runtime.stopFeatureLane({ ...args, status: 'paused' }), error => error.code === 'STOP_UNCONFIRMED' && error.details?.descendantsUnconfirmed === true);
  assert.equal((await getFeatureContext(args)).feature.status, 'active');
  assert.ok(await readUnconfirmedDescendants(args));
  const paused = await runtime.stopFeatureLane({ ...args, status: 'paused', prior_turn_attestation: { evidence: 'The earlier fixture worker spawned no tools and has exited.' } });
  assert.equal(paused.feature.status, 'paused');
});

test('a failed next launch cannot lose prior worker uncertainty across controller restart', async t => {
  const claude = { launch: { command: process.execPath, args: ['-e', lingering, '--'] }, treeKill: failingKiller, terminationTimeoutMs: 500, containment: null };
  const { args, bridge, runtime } = await fixture(t, claude);
  await runtime.startFeatureAgent(args);
  await eventually(async () => (await agentStatus(args)) === 'idle');
  bridge.backend('claude').launch.command = path.join(args.workspace_path, 'missing-worker.exe');
  await assert.rejects(runtime.startFeatureAgent(args));
  expireControllerOwner(args.workspace_path);
  const restarted = createAgentRuntime(new WorkerBridge({ claude }));
  t.after(() => restarted.shutdownAgentRuntime());
  await assert.rejects(restarted.stopFeatureLane({ ...args, status: 'paused' }), error => error.code === 'STOP_UNCONFIRMED');
  assert.equal((await getFeatureContext(args)).feature.status, 'active');
  assert.ok((await readWorkerGuards(args)).length > 0);
});

test('claude worker that exits right after its result still completes the turn', async t => {
  const script = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done before exit.' }) + '\\n', () => process.exit(0)));";
  const { completed } = await bridgeTurn(t, { input: 'finish', launchArgs: ['-e', script, '--'] });
  await eventually(() => completed.length === 1);
  assert.equal(completed[0].status, 'completed');
  assert.equal(completed[0].items[0].text, 'Done before exit.');
});
