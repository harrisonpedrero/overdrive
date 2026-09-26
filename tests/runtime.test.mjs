import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntime } from '../plugins/overdrive/scripts/agent-runtime.mjs';
import { initializeManagedProject, createFeature, getFeatureContext, updateFeature } from '../plugins/overdrive/scripts/workspace.mjs';

class Bridge extends EventEmitter {
  constructor() { super(); this.turns = []; this.starts = 0; this.quick = false; this.requests = []; }
  async ensureStarted() {}
  async startThread(params) { this.startParams = params; return { thread: { id: 'fixture-thread' } }; }
  async resumeThread(params) { this.resumeParams = params; return { thread: { id: 'fixture-thread' } }; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.starts}`, status: 'inProgress', items: [] };
      this.turns.push(turn);
      this.emit('notification', { method: 'turn/started', params: { threadId: 'fixture-thread', turn } });
      if (this.quick) this.finish();
      return { turn };
    }
    if (method === 'thread/read') return { thread: { id: 'fixture-thread', turns: this.turns } };
    return {};
  }
  finish() {
    const turn = this.turns.at(-1);
    turn.status = 'completed';
    turn.items = [{ type: 'reasoning', text: 'private-do-not-persist' }, { type: 'agentMessage', text: 'Verified fixture result.' }];
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'fixture-thread', turn } });
  }
  shutdown() { this.emit('exit', new Error('fixture disconnected')); }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeManagedProject({ workspace_path: root, project_name: 'Runtime fixture', description: 'Exercise session state.' });
  await createFeature({ workspace_path: root, feature: 'alpha', title: 'Alpha', outcome: 'Complete one bounded turn.', spec: '# Alpha\n\nComplete the fixture.' });
  return { workspace_path: root, feature: 'alpha' };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('State did not converge');
}

for (const [name, codex, expectedModel] of [
  ['default', undefined, 'gpt-6-sol'],
  ['workspace override', { model: 'gpt-6-luna' }, 'gpt-6-luna'],
  ['lane override', { model: 'gpt-6-luna', laneModels: { alpha: 'gpt-6-sol' } }, 'gpt-6-sol'],
]) {
  test(`Codex ${name} reaches thread and turn dispatch`, async t => {
    const args = await fixture(t);
    if (codex) {
      const configPath = path.join(args.workspace_path, 'overdrive.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      config.codex = codex;
      await fs.writeFile(configPath, JSON.stringify(config));
    }
    const bridge = new Bridge();
    const runtime = createAgentRuntime(bridge);
    t.after(() => runtime.shutdownAgentRuntime());
    const started = await runtime.startFeatureAgent(args);
    assert.equal(started.model, expectedModel);
    assert.equal(bridge.startParams.model, expectedModel);
    assert.equal(bridge.requests.find(request => request.method === 'turn/start').params.model, expectedModel);
  });
}

test('an invalid start instruction creates no native task and leaves the lane startable', async t => {
  const args = await fixture(t);
  const bridge = new Bridge();
  let threadStarts = 0;
  const startThread = bridge.startThread.bind(bridge);
  bridge.startThread = params => (threadStarts++, startThread(params));
  let resumes = 0;
  const resumeThread = bridge.resumeThread.bind(bridge);
  bridge.resumeThread = params => (resumes++, resumeThread(params));
  const runtime = createAgentRuntime(bridge);
  t.after(() => runtime.shutdownAgentRuntime());
  for (const instruction of ['', '   ', '\n\t', 42, 'a\0b']) {
    await assert.rejects(runtime.startFeatureAgent({ ...args, instruction }), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(threadStarts, 0);
  assert.deepEqual(bridge.requests, []);
  const untouched = (await getFeatureContext(args)).feature;
  assert.deepEqual(untouched.agent, { status: 'not_started', threadId: null, harness: null, activeTurnId: null });

  bridge.quick = true;
  const started = await runtime.startFeatureAgent({ ...args, instruction: '  Build the fixture.  ' });
  assert.equal(threadStarts, 1);
  assert.equal(started.createdSession, true);
  assert.match(bridge.requests.find(request => request.method === 'turn/start').params.input[0].text, /direction:\nBuild the fixture\.\n/);
  await eventually(async () => (await getFeatureContext(args)).feature.agent.status === 'idle');

  const requests = bridge.requests.length;
  for (const instruction of ['', ' ']) {
    await assert.rejects(runtime.startFeatureAgent({ ...args, instruction }), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(resumes, 0);
  assert.equal(bridge.requests.length, requests);
  assert.deepEqual((await getFeatureContext(args)).feature.agent, { status: 'idle', threadId: 'fixture-thread', harness: 'codex', activeTurnId: null });

  const { nextAction } = (await getFeatureContext(args)).feature;
  await runtime.startFeatureAgent(args);
  assert.ok(bridge.requests.findLast(request => request.method === 'turn/start').params.input[0].text.includes(`direction:\n${nextAction || 'Complete your spec.'}\n`));
});

test('short completion cannot be overwritten by its start response; private items are absent', async t => {
  const args = await fixture(t);
  const bridge = new Bridge();
  bridge.quick = true;
  const runtime = createAgentRuntime(bridge);
  await runtime.startFeatureAgent(args);
  await eventually(async () => (await getFeatureContext(args)).feature.agent.status === 'idle');
  const state = await runtime.inspectFeatureAgent(args);
  assert.equal(state.feature.agent.activeTurnId, null);
  assert.doesNotMatch(JSON.stringify(state), /private-do-not-persist/);
  await runtime.shutdownAgentRuntime();
});

test('one controller owns a running lane and stale owners cannot overwrite it', async t => {
  const args = await fixture(t);
  const bridge = new Bridge();
  const first = createAgentRuntime(bridge);
  const otherBridge = new Bridge();
  const second = createAgentRuntime(otherBridge);
  await first.startFeatureAgent(args);
  await assert.rejects(second.startFeatureAgent(args), error => error.code === 'AGENT_OWNED');
  bridge.finish();
  await eventually(async () => (await getFeatureContext(args)).feature.agent.status === 'idle');
  await second.startFeatureAgent(args);
  bridge.emit('notification', { method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'old-turn', status: 'failed' } } });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await getFeatureContext(args)).feature.agent.status, 'running');
  otherBridge.finish();
  await eventually(async () => (await getFeatureContext(args)).feature.agent.status === 'idle');
  await first.shutdownAgentRuntime();
  await second.shutdownAgentRuntime();
});

test('native compaction inside a normal turn retains the final handoff', async t => {
  const args = await fixture(t);
  const bridge = new Bridge();
  const runtime = createAgentRuntime(bridge);
  await runtime.startFeatureAgent(args);
  bridge.emit('notification', { method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'turn-1', item: { type: 'contextCompaction' } } });
  bridge.finish();
  await eventually(async () => (await getFeatureContext(args)).feature.summary === 'Verified fixture result.');
  await updateFeature({ ...args, summary: 'Saved the result.', next_action: 'Review.' });
  await runtime.shutdownAgentRuntime();
});
