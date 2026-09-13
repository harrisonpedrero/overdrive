import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntime } from '../plugins/feature-theater/scripts/agent-runtime.mjs';
import { initializeManagedProject, createFeature, getFeatureContext, checkpointFeature } from '../plugins/feature-theater/scripts/workspace.mjs';

class Bridge extends EventEmitter {
  constructor() { super(); this.turns = []; this.starts = 0; this.compactions = 0; this.quick = false; }
  async ensureStarted() {}
  async startThread() { return { thread: { id: 'fixture-thread' } }; }
  async resumeThread() { return { thread: { id: 'fixture-thread' } }; }
  async request(method) {
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.starts}`, status: 'inProgress', items: [] };
      this.turns.push(turn);
      this.emit('notification', { method: 'turn/started', params: { threadId: 'fixture-thread', turn } });
      if (this.quick) this.finish();
      return { turn };
    }
    if (method === 'thread/read') return { thread: { id: 'fixture-thread', turns: this.turns } };
    if (method === 'thread/compact/start') {
      this.compactions++;
      if (this.failCompaction) throw new Error('fixture compaction rejected');
      const turnId = `compact-${this.compactions}`;
      this.emit('notification', { method: 'turn/started', params: { threadId: 'fixture-thread', turn: { id: turnId } } });
      this.emit('notification', { method: 'item/completed', params: { threadId: 'fixture-thread', turnId, item: { type: 'contextCompaction' } } });
      this.emit('notification', { method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: turnId, status: 'completed' } } });
    }
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-runtime-'));
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

test('one controller owns a running lane, deferred compaction completes, and stale owners cannot overwrite it', async t => {
  const args = await fixture(t);
  const bridge = new Bridge();
  const first = createAgentRuntime(bridge);
  const otherBridge = new Bridge();
  const second = createAgentRuntime(otherBridge);
  await first.startFeatureAgent(args);
  await assert.rejects(second.startFeatureAgent(args), error => error.code === 'AGENT_OWNED');
  const queued = await first.compactFeatureAgent(args);
  assert.equal(queued.queued, true);
  assert.equal((await getFeatureContext(args)).feature.compactionPending, true);
  bridge.finish();
  await eventually(async () => !(await getFeatureContext(args)).feature.compactionPending);
  assert.equal(bridge.compactions, 1);
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
  await checkpointFeature({ ...args, summary: 'Saved the result.', next_action: 'Review.' });
  await runtime.shutdownAgentRuntime();
});

test('rejected compaction preserves the checkpoint and can be retried', async t => {
  const args = await fixture(t);
  const bridge = new Bridge();
  bridge.quick = true;
  const runtime = createAgentRuntime(bridge);
  await runtime.startFeatureAgent(args);
  await eventually(async () => (await getFeatureContext(args)).feature.agent.status === 'idle');
  await checkpointFeature({ ...args, summary: 'Verified handoff to preserve.', next_action: 'Review.' });
  bridge.failCompaction = true;
  await assert.rejects(runtime.compactFeatureAgent(args), /fixture compaction rejected/);
  const failed = await getFeatureContext(args);
  assert.equal(failed.feature.agent.status, 'failed');
  assert.equal(failed.feature.compactionPending, true);
  assert.equal(failed.feature.summary, 'Verified handoff to preserve.');
  bridge.failCompaction = false;
  assert.equal((await runtime.compactFeatureAgent(args)).compacted, true);
  const retried = await getFeatureContext(args);
  assert.equal(retried.feature.agent.status, 'idle');
  assert.equal(retried.feature.compactionPending, false);
  await runtime.shutdownAgentRuntime();
});
