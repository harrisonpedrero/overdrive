import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerBridge } from '../plugins/feature-theater/scripts/app-server.mjs';
import { ClaudeWorkerBridge, ISOLATION_ARGS, normalizeWorkerOptions, workerEnvironment, workerLaunchArgs } from '../plugins/feature-theater/scripts/claude-worker.mjs';
import { createAgentRuntime } from '../plugins/feature-theater/scripts/agent-runtime.mjs';
import { createFeature, getFeatureContext, initializeManagedProject, workerHarness } from '../plugins/feature-theater/scripts/workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, 'fixtures', 'fake-claude-cli.mjs');

async function fixture(t, claude = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-claude-'));
  await initializeManagedProject({ workspace_path: root, project_name: 'Claude fixture', description: 'Exercise the Claude worker bridge.', harness: 'claude' });
  await createFeature({ workspace_path: root, feature: 'alpha', title: 'Alpha', outcome: 'Complete one bounded turn.', spec: '# Alpha\n\nComplete the fixture.' });
  const argsFile = path.join(root, 'fake-claude-args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  t.after(() => { delete process.env.FAKE_CLAUDE_ARGS_FILE; });
  const runtime = createAgentRuntime(new WorkerBridge({ claude: { launch: { command: process.execPath, args: [fakeCli] }, ...claude } }));
  t.after(async () => {
    await runtime.shutdownAgentRuntime();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { args: { workspace_path: root, feature: 'alpha' }, argsFile, runtime };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('State did not converge');
}

const agentStatus = async args => (await getFeatureContext(args)).feature.agent.status;

test('claude worker launch is isolated, resumable and free of nested-session markers', () => {
  const meta = { id: 'session-1', persisted: false, model: 'opus', options: normalizeWorkerOptions({}), addDirs: ['C:/theater/.theater/features/alpha'], developerInstructions: 'lane contract', name: 'Theater · Alpha' };
  const first = workerLaunchArgs(meta, 'ultra');
  for (const flag of ISOLATION_ARGS) assert.ok(first.includes(flag), flag);
  assert.ok(first.includes('--session-id') && first.includes('session-1'));
  assert.ok(first.includes('--effort') && first.includes('max'));
  assert.ok(first.includes('--permission-mode') && first.includes('acceptEdits'));
  assert.ok(first.includes('Bash(git push:*)'));
  assert.ok(first.includes('--add-dir') && first.includes('--append-system-prompt') && first.includes('--name'));
  const resumed = workerLaunchArgs({ ...meta, persisted: true }, 'high');
  assert.ok(resumed.includes('--resume') && !resumed.includes('--session-id') && !resumed.includes('--name'));
  const env = workerEnvironment({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '1', PATH: 'p', ANTHROPIC_BASE_URL: 'u' });
  assert.deepEqual(env, { ANTHROPIC_BASE_URL: 'u', PATH: 'p', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  for (const inherited of [{ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }, { claude_code_disable_auto_memory: '0' }]) {
    const forced = workerEnvironment({ ...inherited, CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: 'h' });
    assert.deepEqual(forced, { CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: 'h', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  }
  assert.throws(() => normalizeWorkerOptions({ permissionMode: 'plan' }), error => error.code === 'INVALID_STATE');
  assert.throws(() => normalizeWorkerOptions({ allowedTools: 'Bash' }), error => error.code === 'INVALID_STATE');
  const custom = normalizeWorkerOptions({ permissionMode: 'bypassPermissions', allowedTools: [], disallowedTools: ['WebFetch'] });
  assert.ok(workerLaunchArgs({ ...meta, options: custom }, 'high').includes('--allow-dangerously-skip-permissions'));
});

test('theater.json selects the harness and per-lane model', () => {
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
  const started = await runtime.startFeatureAgent(args);
  assert.equal(started.harness, 'claude');
  assert.equal(started.model, 'harness-default');
  const launch = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  assert.ok(launch.args.includes('--session-id') && launch.args.includes(started.threadId));
  for (const flag of ISOLATION_ARGS) assert.ok(launch.args.includes(flag), flag);
  assert.ok(launch.args.includes('--add-dir'));
  assert.ok(!launch.claudeEnv.includes('CLAUDECODE') && !launch.claudeEnv.includes('CLAUDE_CODE_SESSION_ID'));
  assert.ok(launch.claudeEnv.includes('CLAUDE_CODE_DISABLE_AUTO_MEMORY'));
  assert.equal(path.resolve(launch.cwd), path.resolve(started.checkoutPath));
  const steered = await runtime.steerFeatureAgent({ ...args, instruction: 'Also write the second file.' });
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
  const compacted = await runtime.compactFeatureAgent(args);
  assert.equal(compacted.compacted, true);
  assert.equal((await getFeatureContext(args)).feature.compactionPending, false);
  const again = await runtime.startFeatureAgent({ ...args, instruction: 'Continue.' });
  assert.equal(again.threadId, started.threadId);
  assert.equal(again.createdSession, false);
  const resumed = JSON.parse(await fs.readFile(argsFile, 'utf8'));
  assert.ok(resumed.args.includes('--resume') && resumed.args.includes(started.threadId));
  await eventually(async () => (await agentStatus(args)) === 'idle');
  assert.match((await getFeatureContext(args)).feature.summary, /^Handoff 3: wrote worker-3\.txt\./);
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

async function bridgeTurn(t, { input = 'hang', launchArgs = [fakeCli], ...options } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-claude-bridge-'));
  const bridge = new ClaudeWorkerBridge({ launch: { command: process.execPath, args: launchArgs }, terminationTimeoutMs: 500, ...options });
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
  const { args, runtime } = await fixture(t, { treeKill: failingKiller, terminationTimeoutMs: 500 });
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
    assert.deepEqual(await bridge.request('turn/interrupt', { threadId, turnId }), { interrupted: true });
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'worker exited before interrupt reported success');
    await eventually(() => completed.length === 1);
    assert.equal(completed[0].status, 'interrupted');
    assert.match(completed[0].items.at(-1).text, /only the worker process itself was terminated/);
    assert.equal((await bridge.request('thread/read', { threadId })).thread.status, 'idle');
  }
});

test('claude worker result that arrives during an interrupt cannot complete the turn', async t => {
  // The worker answers a trigger with a success result, then records that it wrote it. The tree
  // killer sends the trigger and exits nonzero only after that record, so the result is always
  // in flight while termination is still undecided.
  const worker = "let seen = ''; process.stdin.on('data', chunk => { seen += chunk; if (!seen.includes('trigger')) return; seen = ''; process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Late result.' }) + '\\n', () => require('fs').writeFileSync(process.argv[1], 'written')); }); setInterval(() => {}, 1000);";
  const killer = "const fs = require('fs'); setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(1); }, 20);";
  for (const killable of [false, true]) {
    const marker = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'theater-claude-marker-')), 'result-written');
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
    if (killable) assert.deepEqual(await interrupt, { interrupted: true });
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

test('claude worker that exits right after its result still completes the turn', async t => {
  const script = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done before exit.' }) + '\\n', () => process.exit(0)));";
  const { completed } = await bridgeTurn(t, { input: 'finish', launchArgs: ['-e', script, '--'] });
  await eventually(() => completed.length === 1);
  assert.equal(completed[0].status, 'completed');
  assert.equal(completed[0].items[0].text, 'Done before exit.');
});
