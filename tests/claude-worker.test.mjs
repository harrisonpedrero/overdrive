import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerBridge } from '../plugins/feature-theater/scripts/app-server.mjs';
import { ISOLATION_ARGS, normalizeWorkerOptions, workerEnvironment, workerLaunchArgs } from '../plugins/feature-theater/scripts/claude-worker.mjs';
import { createAgentRuntime } from '../plugins/feature-theater/scripts/agent-runtime.mjs';
import { createFeature, getFeatureContext, initializeManagedProject, workerHarness } from '../plugins/feature-theater/scripts/workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, 'fixtures', 'fake-claude-cli.mjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-claude-'));
  await initializeManagedProject({ workspace_path: root, project_name: 'Claude fixture', description: 'Exercise the Claude worker bridge.', harness: 'claude' });
  await createFeature({ workspace_path: root, feature: 'alpha', title: 'Alpha', outcome: 'Complete one bounded turn.', spec: '# Alpha\n\nComplete the fixture.' });
  const argsFile = path.join(root, 'fake-claude-args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  t.after(() => { delete process.env.FAKE_CLAUDE_ARGS_FILE; });
  const runtime = createAgentRuntime(new WorkerBridge({ claude: { launch: { command: process.execPath, args: [fakeCli] } } }));
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
