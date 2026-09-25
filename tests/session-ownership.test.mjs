import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WorkerBridge } from '../plugins/overdrive/scripts/app-server.mjs';
import { createAgentRuntime } from '../plugins/overdrive/scripts/agent-runtime.mjs';
import { OverdriveError, refusedRequest } from '../plugins/overdrive/scripts/util.mjs';
import { createFeature, getFeatureContext, initializeManagedProject, markCompacted, markDescendantsUnconfirmed, readUnconfirmedDescendants, readWorkerGuards, recordAgentEvent, saveAgentSession, savePendingAgentRequest, setFeatureStatus } from '../plugins/overdrive/scripts/workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// A native backend whose session store outlives any controller and rejects foreign session IDs.
class NativeBackend extends EventEmitter {
  constructor(harness, store, calls, faults) {
    super();
    Object.assign(this, { harness, store, calls, faults, responses: [] });
  }
  async startThread() {
    this.calls.push({ harness: this.harness, method: 'thread/start' });
    if (this.faults[this.harness] === 'thread/start') throw refusedRequest(new Error(`${this.harness} could not create a session`));
    const thread = { id: `${this.harness}-${this.store.size + 1}`, turns: [] };
    this.store.set(thread.id, thread);
    return { thread };
  }
  async resumeThread({ threadId }) { return await this.request('thread/resume', { threadId }); }
  // Faults: 'turn/start' is an explicit refusal; 'lost' starts the turn but loses the response;
  // 'lost-after-started' also reports turn/started first; 'lost-unstarted' loses a request the
  // backend never acted on.
  async request(method, params) {
    this.calls.push({ harness: this.harness, method, threadId: params.threadId });
    const thread = this.store.get(params.threadId);
    if (!thread) throw refusedRequest(new Error(`${this.harness} has no session ${params.threadId}`));
    const fault = this.faults[this.harness];
    if (method === 'turn/start') {
      if (fault === 'turn/start') throw refusedRequest(new Error(`${this.harness} could not start a turn`));
      const timeout = new OverdriveError(`${this.harness} request timed out: turn/start`, 'CODEX_TIMEOUT');
      if (fault === 'lost-unstarted') throw timeout;
      const turn = { id: `${thread.id}-turn-${thread.turns.length + 1}`, status: 'inProgress', items: [] };
      Object.defineProperty(turn, 'guardId', { value: params.guardId ?? null });
      thread.turns.push(turn);
      if (fault === 'lost-after-started') this.emit('notification', { method: 'turn/started', params: { threadId: thread.id, turn } });
      if (fault?.startsWith('lost')) throw timeout;
      return { turn };
    }
    // Interrupt faults: 'interrupt-fails' is a backend error; 'interrupt-silent' acknowledges but the
    // turn keeps running; faults.interruptGate holds any interrupt until its gate opens.
    if (method === 'turn/interrupt') {
      if (fault === 'interrupt-fails') throw new OverdriveError(`${this.harness} interrupt failed`, 'CODEX_TIMEOUT');
      if (fault === 'interrupt-silent') return { interrupted: true };
      if (this.faults.interruptGate) {
        this.faults.interruptGate.reached();
        await this.faults.interruptGate.gate;
      }
      const turn = thread.turns.find(candidate => candidate.id === params.turnId);
      if (turn?.status !== 'inProgress') return { interrupted: false };
      turn.status = 'interrupted';
      setImmediate(() => this.emit('notification', { method: 'turn/completed', params: { threadId: thread.id, turn } }));
      return { interrupted: true };
    }
    return { thread };
  }
  // Like the Claude bridge, a finished worker whose whole process tree ended reports that exit.
  finish(threadId, text = 'Visible handoff.') {
    const turn = this.store.get(threadId).turns.at(-1);
    Object.assign(turn, { status: 'completed', items: [{ type: 'agentMessage', text }] });
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn } });
    if (turn.guardId) this.emit('notification', { method: 'worker/exited', params: { threadId, guardId: turn.guardId } });
  }
  raise(id, method, params) {
    (this.live ??= new Set()).add(String(id));
    this.emit('serverRequest', { id, method, params });
  }
  liveRequest(requestId) { return this.live?.has(String(requestId)) ? { id: requestId } : null; }
  respondToServer(requestId, result, error) {
    this.live.delete(String(requestId));
    this.responses.push({ requestId, error });
  }
  shutdown() {}
}

async function fixture(t, harness = 'claude', runtimeOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-ownership-'));
  await initializeManagedProject({ workspace_path: root, project_name: 'Ownership', description: 'Session routing.', harness });
  const args = { workspace_path: root, feature: 'alpha' };
  await createFeature({ ...args, title: 'Alpha', outcome: 'Preserve conversations.', spec: '# Ownership' });
  const stores = { codex: new Map(), claude: new Map() };
  const calls = [];
  const faults = {};
  const bridge = new WorkerBridge();
  for (const name of Object.keys(stores)) bridge.factories[name] = () => new NativeBackend(name, stores[name], calls, faults);
  const runtime = createAgentRuntime(bridge, runtimeOptions);
  t.after(async () => {
    await runtime.shutdownAgentRuntime();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const configure = async changes => {
    const file = path.join(root, 'overdrive.json');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...changes }, null, 2));
  };
  const sql = (statement, ...values) => {
    const db = new DatabaseSync(path.join(root, '.overdrive', 'state.sqlite3'));
    try { return db.prepare(statement).run(...values); } finally { db.close(); }
  };
  return { root, args, bridge, runtime, stores, calls, faults, configure, sql };
}

async function eventually(check, label = 'state') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`State did not converge: ${label}`);
}

const agent = async args => (await getFeatureContext(args)).feature.agent;

test('the worker bridge confirms session owners and refuses to reroute or guess them', async () => {
  const store = new Map();
  const bridge = new WorkerBridge();
  bridge.factories.claude = () => new NativeBackend('claude', store, [], {});
  const { thread } = await bridge.startThread({ harness: 'claude' });
  await assert.rejects(bridge.request('thread/read', { harness: 'codex', threadId: thread.id }), error => error.code === 'SESSION_OWNER_CONFLICT');
  assert.equal((await bridge.request('thread/read', { harness: 'claude', threadId: thread.id })).thread.id, thread.id);
  const restarted = new WorkerBridge();
  restarted.factories.claude = () => new NativeBackend('claude', store, [], {});
  await assert.rejects(restarted.request('thread/read', { threadId: thread.id }), error => error.code === 'SESSION_OWNER_UNKNOWN');
  await assert.rejects(restarted.resumeThread({ threadId: thread.id }), error => error.code === 'SESSION_OWNER_UNKNOWN');
  await restarted.resumeThread({ harness: 'claude', threadId: thread.id });
  await assert.rejects(restarted.resumeThread({ harness: 'codex', threadId: thread.id }), error => error.code === 'SESSION_OWNER_CONFLICT');
});

test('legacy state keeps Codex ownership only where provable and leaves the rest unknown', async t => {
  const f = await fixture(t, 'codex');
  await createFeature({ workspace_path: f.root, feature: 'beta', title: 'Beta', outcome: 'Had a native request.' });
  const legacy = version => {
    f.sql("UPDATE features SET thread_id = 'thread-' || slug, agent_status = 'idle'");
    f.sql('ALTER TABLE features DROP COLUMN thread_harness');
    f.sql("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(version));
  };
  f.sql("INSERT INTO pending_agent_requests(request_id, feature_id, thread_id, method, summary, payload_json, status, created_at) SELECT '7', id, 'thread-beta', 'item/tool/requestUserInput', 'Old request.', '{}', 'resolved', 'then' FROM features WHERE slug = 'beta'");
  legacy(3);
  assert.equal((await agent(f.args)).harness, 'unknown');
  assert.equal((await agent({ ...f.args, feature: 'beta' })).harness, 'codex');
  legacy(2);
  assert.equal((await agent(f.args)).harness, 'codex', 'state from before Claude workers existed is Codex-owned');
});

test('unknown legacy ownership fails clearly without contacting a backend and can be replaced', async t => {
  const f = await fixture(t, 'claude');
  f.sql("UPDATE features SET thread_id = 'legacy-thread', thread_harness = NULL, agent_status = 'idle'");
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'SESSION_OWNER_UNKNOWN' && /force_new_session/.test(error.message));
  await assert.rejects(f.runtime.steerFeatureAgent({ ...f.args, instruction: 'Continue.' }), error => error.code === 'SESSION_OWNER_UNKNOWN');
  await assert.rejects(f.runtime.compactFeatureAgent(f.args), error => error.code === 'SESSION_OWNER_UNKNOWN');
  const inspected = await f.runtime.inspectFeatureAgent(f.args);
  assert.match(inspected.warning, /force_new_session/);
  assert.equal(inspected.feature.agent.harness, 'unknown');
  assert.equal(inspected.feature.compactionPending, false);
  assert.deepEqual(f.calls, []);
  const replaced = await f.runtime.startFeatureAgent({ ...f.args, force_new_session: true });
  assert.deepEqual({ harness: replaced.harness, created: replaced.createdSession }, { harness: 'claude', created: true });
  const state = await getFeatureContext(f.args);
  assert.deepEqual({ threadId: state.feature.agent.threadId, harness: state.feature.agent.harness }, { threadId: replaced.threadId, harness: 'claude' });
  const event = state.timeline.find(entry => entry.kind === 'agent.session_replaced');
  assert.deepEqual(event.details, { previousThreadId: 'legacy-thread', previousHarness: null, threadId: replaced.threadId, harness: 'claude' });
});

test('a replacement that cannot be created or started keeps the previous binding', async t => {
  const f = await fixture(t, 'codex');
  const original = await f.runtime.startFeatureAgent(f.args);
  f.bridge.backend('codex').finish(original.threadId);
  await eventually(async () => (await agent(f.args)).status === 'idle');
  await f.configure({ harness: 'claude' });

  f.faults.claude = 'thread/start';
  await assert.rejects(f.runtime.startFeatureAgent({ ...f.args, force_new_session: true }), /could not create a session/);
  assert.deepEqual({ threadId: (await agent(f.args)).threadId, harness: (await agent(f.args)).harness }, { threadId: original.threadId, harness: 'codex' });

  f.faults.claude = 'turn/start';
  await assert.rejects(f.runtime.startFeatureAgent({ ...f.args, force_new_session: true }), /could not start a turn/);
  // The refused request launched no worker, so it leaves no guard behind.
  assert.deepEqual(await readWorkerGuards(f.args), []);
  const failed = await getFeatureContext(f.args);
  assert.deepEqual({ threadId: failed.feature.agent.threadId, harness: failed.feature.agent.harness, status: failed.feature.agent.status }, { threadId: original.threadId, harness: 'codex', status: 'failed' });
  assert.match(failed.feature.summary, new RegExp(`Kept native session ${original.threadId}`));
  assert.equal(failed.timeline.find(entry => entry.kind === 'agent.failed').details.restoredThreadId, original.threadId);

  delete f.faults.claude;
  const resumed = await f.runtime.startFeatureAgent(f.args);
  assert.deepEqual({ threadId: resumed.threadId, harness: resumed.harness, created: resumed.createdSession }, { threadId: original.threadId, harness: 'codex', created: false });
  assert.equal(f.calls.at(-1).harness, 'codex');

  // A first session that never starts leaves the lane unbound instead of pointing at nothing.
  await createFeature({ workspace_path: f.root, feature: 'beta', title: 'Beta', outcome: 'Start later.', spec: '# Beta' });
  f.faults.claude = 'turn/start';
  await assert.rejects(f.runtime.startFeatureAgent({ ...f.args, feature: 'beta' }), /could not start a turn/);
  assert.deepEqual({ threadId: (await agent({ ...f.args, feature: 'beta' })).threadId, harness: (await agent({ ...f.args, feature: 'beta' })).harness }, { threadId: null, harness: null });
});

test('late events from a replaced session cannot mutate its replacement', async t => {
  const f = await fixture(t, 'claude');
  const old = await f.runtime.startFeatureAgent(f.args);
  f.bridge.backend('claude').finish(old.threadId);
  await eventually(async () => (await agent(f.args)).status === 'idle');
  await f.configure({ harness: 'codex' });
  const replacement = await f.runtime.startFeatureAgent({ ...f.args, force_new_session: true });
  assert.equal(replacement.harness, 'codex');
  await eventually(async () => (await agent(f.args)).status === 'running');

  const claude = f.bridge.backend('claude');
  claude.emit('notification', { method: 'turn/started', params: { threadId: old.threadId, turn: { id: 'late-turn' } } });
  claude.emit('notification', { method: 'thread/compacted', params: { threadId: old.threadId, turnId: 'late-turn' } });
  claude.emit('notification', { method: 'turn/completed', params: { threadId: old.threadId, turn: { id: 'late-turn', status: 'failed', items: [{ type: 'agentMessage', text: 'Stale handoff.' }] } } });
  claude.raise(41, 'item/tool/requestUserInput', { threadId: old.threadId, turnId: 'late-turn' });
  claude.emit('exit', new Error('old backend closed'), [old.threadId]);
  // Durable writes are guarded as well, whichever controller delivers them.
  for (const ignored of await Promise.all([
    saveAgentSession({ ...f.args, thread_id: old.threadId, status: 'failed', summary: 'Stale handoff.' }),
    markCompacted({ ...f.args, thread_id: old.threadId }),
    recordAgentEvent({ ...f.args, thread_id: old.threadId, kind: 'agent.diff', summary: 'Stale diff.' }),
  ])) assert.deepEqual(ignored, { ignored: true });
  await new Promise(resolve => setTimeout(resolve, 100));

  const state = await getFeatureContext(f.args);
  assert.deepEqual(
    { threadId: state.feature.agent.threadId, harness: state.feature.agent.harness, status: state.feature.agent.status, turnId: state.feature.agent.activeTurnId },
    { threadId: replacement.threadId, harness: 'codex', status: 'running', turnId: replacement.turnId },
  );
  assert.equal(state.pendingAgentRequests.length, 0);
  assert.deepEqual(claude.responses.map(response => response.requestId), [41]);
  assert.ok(!state.timeline.some(entry => /Stale/.test(entry.summary)));
  f.bridge.backend('codex').finish(replacement.threadId, 'Replacement handoff.');
  await eventually(async () => (await getFeatureContext(f.args)).feature.summary === 'Replacement handoff.');
});

test('a controller savePendingAgentRequest from an unbound session is ignored', async t => {
  const f = await fixture(t, 'codex');
  const started = await f.runtime.startFeatureAgent(f.args);
  f.sql("UPDATE meta SET value = json_object('token', 'controller', 'pid', ?) WHERE key LIKE 'agent-owner:%'", process.pid);
  const request = { ...f.args, owner_token: 'controller', request_id: 5, turn_id: 't', method: 'item/tool/requestUserInput', summary: 'Needs input.', payload: {} };
  assert.deepEqual(await savePendingAgentRequest({ ...request, thread_id: 'replaced-thread' }), { ignored: true });
  assert.equal((await savePendingAgentRequest({ ...request, thread_id: started.threadId })).requestId, '5');
});

test('a loaded Claude session adopts a changed model before its next turn and reports it truthfully', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-model-'));
  await initializeManagedProject({ workspace_path: root, project_name: 'Model', description: 'Session settings.', harness: 'claude' });
  const args = { workspace_path: root, feature: 'alpha' };
  await createFeature({ ...args, title: 'Alpha', outcome: 'Change models.', spec: '# Alpha' });
  const argsFile = path.join(root, 'fake-claude-args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const runtime = createAgentRuntime(new WorkerBridge({ claude: { launch: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-claude-cli.mjs')] } } }));
  t.after(async () => {
    delete process.env.FAKE_CLAUDE_ARGS_FILE;
    await runtime.shutdownAgentRuntime();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const configure = async claude => {
    const file = path.join(root, 'overdrive.json');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), claude }, null, 2));
  };
  const launchedModel = async () => {
    const launched = JSON.parse(await fs.readFile(argsFile, 'utf8')).args;
    return { model: launched[launched.indexOf('--model') + 1], resumed: launched.includes('--resume'), mode: launched[launched.indexOf('--permission-mode') + 1] };
  };
  await configure({ model: 'opus' });
  const first = await runtime.startFeatureAgent(args);
  assert.equal(first.model, 'opus');
  assert.deepEqual(await launchedModel(), { model: 'opus', resumed: false, mode: 'acceptEdits' });
  await eventually(async () => (await agent(args)).status === 'idle');
  await configure({ model: 'sonnet', permissionMode: 'dontAsk' });
  const second = await runtime.startFeatureAgent({ ...args, instruction: 'Continue.' });
  assert.deepEqual({ threadId: second.threadId, created: second.createdSession, model: second.model }, { threadId: first.threadId, created: false, model: 'sonnet' });
  assert.deepEqual(await launchedModel(), { model: 'sonnet', resumed: true, mode: 'dontAsk' });
  await eventually(async () => (await agent(args)).status === 'idle');
});

test('a turn request without a confirmed outcome keeps its binding and blocks duplicate turns until reconciled', async t => {
  const f = await fixture(t, 'codex');
  const original = await f.runtime.startFeatureAgent(f.args);
  f.bridge.backend('codex').finish(original.threadId);
  await eventually(async () => (await agent(f.args)).status === 'idle');
  await f.configure({ harness: 'claude' });
  const turns = () => f.stores.claude.get('claude-1')?.turns ?? [];
  const lane = async () => {
    const { threadId, harness, status, activeTurnId } = await agent(f.args);
    return { threadId, harness, status, activeTurnId };
  };
  const finish = async () => {
    f.bridge.backend('claude').finish('claude-1');
    await eventually(async () => (await agent(f.args)).status === 'idle', 'idle');
  };

  // The replacement's turn began but the response was lost: the replacement stays bound.
  f.faults.claude = 'lost';
  await assert.rejects(f.runtime.startFeatureAgent({ ...f.args, force_new_session: true }), error => error.code === 'CODEX_TIMEOUT');
  assert.deepEqual(await lane(), { threadId: 'claude-1', harness: 'claude', status: 'uncertain', activeTurnId: null });
  const timeline = (await getFeatureContext({ ...f.args, timeline_limit: 50 })).timeline;
  assert.ok(timeline.some(entry => entry.kind === 'agent.dispatch_uncertain'));
  assert.ok(!timeline.some(entry => entry.kind === 'agent.failed'));
  delete f.faults.claude;
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'TURN_ACTIVE');
  assert.equal(turns().length, 1, 'no duplicate turn was dispatched');
  assert.deepEqual(await lane(), { threadId: 'claude-1', harness: 'claude', status: 'running', activeTurnId: 'claude-1-turn-1' });
  await finish();

  // turn/started arrived before the request failed: the running turn is kept, not failed.
  f.faults.claude = 'lost-after-started';
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'CODEX_TIMEOUT');
  assert.deepEqual(await lane(), { threadId: 'claude-1', harness: 'claude', status: 'running', activeTurnId: 'claude-1-turn-2' });
  delete f.faults.claude;
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'TURN_ACTIVE');
  assert.equal(turns().length, 2);
  await finish();

  // turn/started arrives only after the failure was recorded.
  f.faults.claude = 'lost';
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'CODEX_TIMEOUT');
  assert.equal((await lane()).status, 'uncertain');
  delete f.faults.claude;
  f.bridge.backend('claude').emit('notification', { method: 'turn/started', params: { threadId: 'claude-1', turn: turns().at(-1) } });
  await eventually(async () => (await lane()).activeTurnId === 'claude-1-turn-3', 'delayed turn/started');
  assert.equal((await lane()).status, 'running');
  await finish();

  // The lost request never began: inspection settles the lane to idle and work may continue.
  f.faults.claude = 'lost-unstarted';
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'CODEX_TIMEOUT');
  assert.equal((await lane()).status, 'uncertain');
  delete f.faults.claude;
  const inspected = await f.runtime.inspectFeatureAgent(f.args);
  assert.deepEqual({ status: inspected.feature.agent.status, turnId: inspected.feature.agent.activeTurnId }, { status: 'idle', turnId: null });
  assert.ok(inspected.timeline.some(entry => entry.kind === 'agent.dispatch_reconciled'));
  // History shows no turn, but a Claude request that was not refused may still have launched a
  // worker process, so its guard holds until the coordinator verifies none is running.
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'WORKERS_UNCONFIRMED' && error.details?.workerGuards === 1);
  assert.equal(turns().length, 3);
  const next = await f.runtime.startFeatureAgent({ ...f.args, prior_turn_attestation: { evidence: 'Verified no Claude worker process runs in the fixture checkout.' } });
  assert.equal(next.turnId, 'claude-1-turn-4');
  assert.equal(turns().length, 4);
});

test('interrupt reports a turn that ended first as not interrupted', async t => {
  const f = await fixture(t, 'codex');
  const started = await f.runtime.startFeatureAgent(f.args);
  f.stores.codex.get(started.threadId).turns.at(-1).status = 'completed';
  const late = await f.runtime.interruptFeatureAgent(f.args);
  assert.deepEqual({ interrupted: late.interrupted, turnId: late.turnId }, { interrupted: false, turnId: started.turnId });
  assert.ok(!(await getFeatureContext(f.args)).timeline.some(entry => entry.kind === 'coordinator.interrupted'));
  f.bridge.backend('codex').finish(started.threadId);
  await eventually(async () => (await agent(f.args)).status === 'idle');
  await f.runtime.startFeatureAgent(f.args);
  assert.equal((await f.runtime.interruptFeatureAgent(f.args)).interrupted, true);
  await eventually(async () => (await agent(f.args)).status === 'interrupted');
  assert.ok((await getFeatureContext(f.args)).timeline.some(entry => entry.kind === 'coordinator.interrupted'));
});

test('runtime shutdown resolves after the bridge and reports unstopped worker processes', async () => {
  const bridge = new WorkerBridge();
  bridge.factories.claude = () => Object.assign(new NativeBackend('claude', new Map(), [], {}), { shutdown: async () => ({ unstopped: [4242] }) });
  bridge.backend('claude');
  const runtime = createAgentRuntime(bridge);
  assert.deepEqual(await runtime.shutdownAgentRuntime(), { unstopped: [4242] });
});
test('empty readable native history settles an unconfirmed first turn and outranks any attestation', async t => {
  const f = await fixture(t, 'claude');
  f.faults.claude = 'lost-unstarted';
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'CODEX_TIMEOUT');
  const lane = await agent(f.args);
  assert.deepEqual({ threadId: lane.threadId, status: lane.status }, { threadId: 'claude-1', status: 'uncertain' });
  assert.deepEqual(f.stores.claude.get('claude-1').turns, []);
  delete f.faults.claude;
  await assert.rejects(f.runtime.startFeatureAgent({ ...f.args, prior_turn_attestation: 'no worker' }), error => error.code === 'INVALID_INPUT');
  const started = await f.runtime.startFeatureAgent({ ...f.args, prior_turn_attestation: { evidence: 'Unneeded: native history is readable.' } });
  assert.equal(started.turnId, 'claude-1-turn-1');
  const reconciled = (await getFeatureContext({ ...f.args, timeline_limit: 50 })).timeline.find(entry => entry.kind === 'agent.dispatch_reconciled');
  assert.deepEqual(reconciled.details, { basis: 'native_history' });
});
test('a backend exit during a running turn keeps it uncertain and reconciles it without a duplicate', async t => {
  const f = await fixture(t, 'codex');
  const started = await f.runtime.startFeatureAgent(f.args);
  await eventually(async () => (await agent(f.args)).status === 'running');
  f.bridge.backend('codex').emit('exit', new Error('app-server crashed'), [started.threadId]);
  await eventually(async () => (await agent(f.args)).status === 'uncertain', 'uncertain after exit');
  assert.equal((await agent(f.args)).activeTurnId, started.turnId);
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'TURN_ACTIVE');
  const lane = await agent(f.args);
  assert.deepEqual({ status: lane.status, turnId: lane.activeTurnId }, { status: 'running', turnId: started.turnId });
  assert.equal(f.stores.codex.get(started.threadId).turns.length, 1);
  f.bridge.backend('codex').finish(started.threadId);
  await eventually(async () => (await agent(f.args)).status === 'idle');
  assert.equal((await f.runtime.startFeatureAgent(f.args)).turnId, `${started.threadId}-turn-2`);
});

const lifecycle = async args => {
  const state = await getFeatureContext({ ...args, timeline_limit: 50 });
  return { status: state.feature.status, agent: state.feature.agent.status, turnId: state.feature.agent.activeTurnId, events: state.timeline.map(entry => entry.kind) };
};

test('a pause whose worker cannot be confirmed stopped leaves the lane active and says so', async t => {
  const f = await fixture(t, 'codex', { stopSettleMs: 200 });
  const started = await f.runtime.startFeatureAgent(f.args);
  const nativeTurn = () => f.stores.codex.get(started.threadId).turns.at(-1);

  f.faults.codex = 'interrupt-fails';
  await assert.rejects(f.runtime.stopFeatureLane({ ...f.args, status: 'paused' }), error => error.code === 'STOP_UNCONFIRMED' && /interrupt failed/.test(error.message) && /stays active/.test(error.message));
  let lane = await lifecycle(f.args);
  assert.deepEqual({ status: lane.status, agent: lane.agent, turnId: lane.turnId }, { status: 'active', agent: 'running', turnId: started.turnId });
  assert.equal(nativeTurn().status, 'inProgress');
  assert.ok(lane.events.includes('feature.stop_unconfirmed'));
  assert.ok(!lane.events.includes('feature.paused'));

  // An acknowledged interrupt whose turn never ends is not a pause either.
  f.faults.codex = 'interrupt-silent';
  await assert.rejects(f.runtime.stopFeatureLane({ ...f.args, status: 'paused' }), error => error.code === 'STOP_UNCONFIRMED' && /acknowledged the interrupt/.test(error.message));
  lane = await lifecycle(f.args);
  assert.deepEqual({ status: lane.status, agent: lane.agent, turnId: lane.turnId }, { status: 'active', agent: 'running', turnId: started.turnId });
  assert.ok(!lane.events.includes('feature.paused'));

  // Once the backend stops the turn, the pause is recorded after the turn has ended.
  delete f.faults.codex;
  const paused = await f.runtime.stopFeatureLane({ ...f.args, status: 'paused' });
  assert.deepEqual({ status: paused.feature.status, agent: paused.feature.agent.status, turnId: paused.feature.agent.activeTurnId }, { status: 'paused', agent: 'interrupted', turnId: null });
  assert.deepEqual({ interrupted: paused.interruption.interrupted, turnId: paused.interruption.turnId }, { interrupted: true, turnId: started.turnId });
  assert.equal(nativeTurn().status, 'interrupted');
});

test('a confirmed pause blocks dispatch until the lane is made active again', async t => {
  const f = await fixture(t, 'codex', { stopSettleMs: 200 });
  const started = await f.runtime.startFeatureAgent(f.args);
  const turns = () => f.stores.codex.get(started.threadId).turns;
  // A turn that ended without its completion being delivered is settled from the native session.
  turns().at(-1).status = 'completed';
  const paused = await f.runtime.stopFeatureLane({ ...f.args, status: 'paused' });
  assert.deepEqual({ status: paused.feature.status, agent: paused.feature.agent.status, interrupted: paused.interruption.interrupted }, { status: 'paused', agent: 'idle', interrupted: false });
  assert.match(paused.feature.nextAction, /^Paused\. Resume the lane/);
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'INVALID_TRANSITION');
  await assert.rejects(f.runtime.steerFeatureAgent({ ...f.args, instruction: 'Keep going.' }), error => error.code === 'INVALID_TRANSITION');
  // Pausing an idle lane again is a plain transition that contacts no backend.
  const calls = f.calls.length;
  assert.equal((await f.runtime.stopFeatureLane({ ...f.args, status: 'paused' })).interruption, undefined);
  assert.equal(f.calls.length, calls);
  assert.equal(turns().length, 1);
  await setFeatureStatus({ ...f.args, status: 'active' });
  assert.equal((await f.runtime.startFeatureAgent(f.args)).turnId, `${started.threadId}-turn-2`);
});

test('dispatch requested while a pause is stopping the worker cannot restart it', async t => {
  const f = await fixture(t, 'codex', { stopSettleMs: 2_000 });
  const started = await f.runtime.startFeatureAgent(f.args);
  let open;
  let reached;
  const interrupting = new Promise(resolve => { reached = resolve; });
  f.faults.interruptGate = { gate: new Promise(resolve => { open = resolve; }), reached };
  const pausing = f.runtime.stopFeatureLane({ ...f.args, status: 'paused' });
  await interrupting;
  // Both wait for the lane's control lock; their outcomes are captured as soon as they settle.
  const outcome = promise => promise.then(() => 'dispatched', error => error.code);
  const starting = outcome(f.runtime.startFeatureAgent(f.args));
  const steering = outcome(f.runtime.steerFeatureAgent({ ...f.args, instruction: 'Keep going.' }));
  await new Promise(resolve => setTimeout(resolve, 400));
  // Until the worker has stopped, the lane does not claim to be paused.
  assert.equal((await lifecycle(f.args)).status, 'active');
  open();
  assert.equal((await pausing).feature.status, 'paused');
  assert.deepEqual(await Promise.all([starting, steering]), ['INVALID_TRANSITION', 'INVALID_TRANSITION']);
  assert.equal(f.stores.codex.get(started.threadId).turns.length, 1);
  assert.ok(!f.calls.some(call => call.method === 'turn/steer'));
  const lane = await lifecycle(f.args);
  assert.deepEqual({ status: lane.status, agent: lane.agent, turnId: lane.turnId }, { status: 'paused', agent: 'interrupted', turnId: null });
});

test('an unsettled turn request blocks a pause until native history or an attestation settles it', async t => {
  const f = await fixture(t, 'claude', { stopSettleMs: 200 });
  f.faults.claude = 'lost-unstarted';
  await assert.rejects(f.runtime.startFeatureAgent(f.args), error => error.code === 'CODEX_TIMEOUT');
  delete f.faults.claude;
  f.stores.claude.get('claude-1').history = 'unavailable';
  await assert.rejects(f.runtime.stopFeatureLane({ ...f.args, status: 'paused' }), error => error.code === 'STOP_UNCONFIRMED' && /prior_turn_attestation/.test(error.message));
  assert.deepEqual((({ status, agent }) => ({ status, agent }))(await lifecycle(f.args)), { status: 'active', agent: 'uncertain' });
  const paused = await f.runtime.stopFeatureLane({ ...f.args, status: 'paused', prior_turn_attestation: { evidence: 'No worker process runs in the alpha checkout.' } });
  assert.deepEqual({ status: paused.feature.status, agent: paused.feature.agent.status }, { status: 'paused', agent: 'idle' });
  const reconciled = (await getFeatureContext({ ...f.args, timeline_limit: 50 })).timeline.find(entry => entry.kind === 'agent.dispatch_reconciled');
  assert.equal(reconciled.details.basis, 'coordinator_attestation');
});

test('archiving validates before stopping the worker and then stops it like a pause', async t => {
  const f = await fixture(t, 'codex', { stopSettleMs: 200 });
  const started = await f.runtime.startFeatureAgent(f.args);
  await assert.rejects(f.runtime.stopFeatureLane({ ...f.args, status: 'archived' }), error => error.code === 'INVALID_INPUT');
  await assert.rejects(f.runtime.stopFeatureLane({ ...f.args, status: 'blocked', blocker: 'x' }), error => error.code === 'INVALID_INPUT');
  assert.ok(!f.calls.some(call => call.method === 'turn/interrupt'));
  assert.equal(f.stores.codex.get(started.threadId).turns.at(-1).status, 'inProgress');
  const archived = await f.runtime.stopFeatureLane({ ...f.args, status: 'archived', disposition: 'Superseded.' });
  assert.deepEqual({ status: archived.feature.status, agent: archived.feature.agent.status, interrupted: archived.interruption.interrupted }, { status: 'archived', agent: 'interrupted', interrupted: true });
  assert.equal((await f.runtime.stopFeatureLane({ ...f.args, status: 'archived' })).unchanged, true);
});

test('an idle lane owned by another live controller is paused only by its owner or on attestation', async t => {
  const f = await fixture(t, 'codex', { stopSettleMs: 200 });
  const started = await f.runtime.startFeatureAgent(f.args);
  f.bridge.backend('codex').finish(started.threadId);
  await eventually(async () => (await agent(f.args)).status === 'idle');
  const other = createAgentRuntime(f.bridge);
  const pause = extra => other.stopFeatureLane({ ...f.args, status: 'paused', ...extra });

  await assert.rejects(pause(), error => error.code === 'STOP_UNCONFIRMED' && error.details?.foreignOwnerPid === process.pid && /prior_turn_attestation/.test(error.message));
  let lane = await lifecycle(f.args);
  assert.equal(lane.status, 'active');
  assert.ok(lane.events.includes('feature.stop_unconfirmed'));
  const attested = await pause({ prior_turn_attestation: { evidence: 'The owning controller reports no worker process for this lane.' } });
  assert.equal(attested.feature.status, 'paused');

  // The owner itself pauses its idle lane as before.
  await setFeatureStatus({ ...f.args, status: 'active' });
  assert.equal((await f.runtime.stopFeatureLane({ ...f.args, status: 'paused' })).feature.status, 'paused');

  // Once the owning controller has ended, an ordinary idle pause needs nothing more.
  await setFeatureStatus({ ...f.args, status: 'active' });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  f.sql("UPDATE meta SET value = json_object('token', 'ended-controller', 'pid', ?) WHERE key LIKE 'agent-owner:%'", dead);
  assert.equal((await pause()).feature.status, 'paused');
  lane = await lifecycle(f.args);
  assert.deepEqual({ status: lane.status, agent: lane.agent }, { status: 'paused', agent: 'idle' });
});

test('a late completion cannot recreate an attested descendant marker', async t => {
  const f = await fixture(t, 'codex');
  const started = await f.runtime.startFeatureAgent(f.args);
  f.bridge.backend('codex').finish(started.threadId);
  await eventually(async () => (await agent(f.args)).status === 'idle');
  const db = new DatabaseSync(path.join(f.root, '.overdrive', 'state.sqlite3'));
  const ownerToken = JSON.parse(db.prepare("SELECT value FROM meta WHERE key LIKE 'agent-owner:%'").get().value).token;
  db.close();
  const marker = { ...f.args, thread_id: started.threadId, turn_id: started.turnId, owner_token: ownerToken, summary: 'Worker descendants may still run.' };
  const first = await markDescendantsUnconfirmed(marker);
  assert.ok(first.generation);
  const paused = await f.runtime.stopFeatureLane({ ...f.args, status: 'paused', prior_turn_attestation: { evidence: 'Verified the completed turn has no running processes.' } });
  assert.equal(paused.feature.status, 'paused');
  assert.equal(await readUnconfirmedDescendants(f.args), null);
  assert.deepEqual(await markDescendantsUnconfirmed(marker), { recorded: false, attested: true });
  assert.equal(await readUnconfirmedDescendants(f.args), null);
  await setFeatureStatus({ ...f.args, status: 'active' });
  const next = await f.runtime.startFeatureAgent(f.args);
  const fresh = await markDescendantsUnconfirmed({ ...marker, turn_id: next.turnId });
  assert.ok(fresh.generation && fresh.generation !== first.generation);
});

test('an invalid steer leaves lane ownership, agent state and the native task untouched', async t => {
  const f = await fixture(t, 'codex');
  // Raw rows: reading feature context would itself recover a dead owner's lane.
  const read = statement => {
    const db = new DatabaseSync(path.join(f.root, '.overdrive', 'state.sqlite3'));
    try { return db.prepare(statement).all().map(row => ({ ...row })); } finally { db.close(); }
  };
  const owners = () => read("SELECT key, value FROM meta WHERE key LIKE 'agent-owner:%' ORDER BY key");
  const lane = () => read("SELECT agent_status, thread_id, thread_harness, active_turn_id FROM features WHERE slug = 'alpha'")[0];
  const invalid = [{ instruction: ' \n\t ' }, { instruction: '' }, { instruction: 42 }, {}, { instruction: 'a\0b' }, { instruction: 'Continue.', effort: 'extreme' }];
  const rejectAll = async () => {
    for (const input of invalid) {
      await assert.rejects(f.runtime.steerFeatureAgent({ ...f.args, ...input }), error => error.code === 'INVALID_INPUT', JSON.stringify(input));
    }
  };

  // A fresh lane gains no owner and stays unstarted.
  await rejectAll();
  assert.deepEqual(owners(), []);
  assert.deepEqual(lane(), { agent_status: 'not_started', thread_id: null, thread_harness: null, active_turn_id: null });
  assert.deepEqual(f.calls, []);

  // A lane whose owning controller ended mid-turn keeps that owner, its running status and turn.
  const started = await f.runtime.startFeatureAgent(f.args);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  f.sql("UPDATE meta SET value = json_object('token', 'ended-controller', 'pid', ?) WHERE key LIKE 'agent-owner:%'", dead);
  const before = { owners: owners(), lane: lane(), calls: f.calls.length, turns: structuredClone(f.stores.codex.get(started.threadId).turns) };
  assert.deepEqual(before.lane, { agent_status: 'running', thread_id: started.threadId, thread_harness: 'codex', active_turn_id: started.turnId });
  await rejectAll();
  assert.deepEqual({ owners: owners(), lane: lane(), calls: f.calls.length, turns: f.stores.codex.get(started.threadId).turns }, before);
  assert.ok(!(await getFeatureContext({ ...f.args, timeline_limit: 50 })).timeline.some(entry => entry.kind === 'coordinator.steered'));

  // A valid steer still takes over the lane and steers the running turn.
  const steered = await f.runtime.steerFeatureAgent({ ...f.args, instruction: '  Also cover the edge case.  ' });
  assert.deepEqual({ mode: steered.mode, turnId: steered.turnId }, { mode: 'mid_turn', turnId: started.turnId });
  assert.deepEqual(f.calls.filter(call => call.method === 'turn/steer'), [{ harness: 'codex', method: 'turn/steer', threadId: started.threadId }]);
  assert.notDeepEqual(owners(), before.owners);
  assert.deepEqual(lane(), before.lane);
});
