import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createFeature, getFeatureContext, initializeManagedProject } from '../plugins/feature-theater/scripts/workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Each controller is a separate OS process; restarting one loses every in-memory session cache,
// so ownership can only come from durable state.
function controller(env) {
  const child = spawn(process.execPath, [path.join(here, 'fixtures', 'theater-controller.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const pending = new Map();
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.ready) return ready(message.ready);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const call = (op, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`Controller timed out: ${op}`)), 30_000);
    pending.set(id, message => {
      clearTimeout(timer);
      if (message.error) reject(Object.assign(new Error(`${op} ${JSON.stringify(args.instruction ?? '')}: ${message.error.message}`), { code: message.error.code }));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
  });
  return {
    started,
    call,
    async stop() { child.stdin.end(); await exited; },
    async kill() { child.kill(); await exited; },
  };
}

async function eventually(check, label) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`State did not converge: ${label}`);
}

async function lines(file) {
  try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('a restarted controller waits for saved Codex turns and preserves inspect-before-wait completion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-restart-wait-'));
  const env = { FAKE_CODEX_STORE: path.join(root, 'codex-store.json'), FAKE_CODEX_LOG: path.join(root, 'codex.log') };
  const controllers = [];
  t.after(async () => {
    for (const running of controllers) await running.kill().catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const launch = async () => {
    const running = controller(env);
    controllers.push(running);
    await running.started;
    return running;
  };
  await initializeManagedProject({ workspace_path: root, project_name: 'Wait fixture', description: 'Wait through a controller restart.' });
  for (const feature of ['normal', 'after', 'during', 'inspected']) {
    await createFeature({ workspace_path: root, feature, title: feature, outcome: 'Finish a saved turn.', spec: '# Saved turn' });
  }
  const args = feature => ({ workspace_path: root, feature });
  let current = await launch();
  await current.call('start', args('normal'));
  const normal = await current.call('wait', { ...args('normal'), timeout_seconds: 2 });
  assert.equal(normal.timedOut, false);
  assert.equal(normal.feature.agent.status, 'idle');
  assert.match(normal.feature.summary, /^Codex handoff for turn-/);

  const after = await current.call('start', { ...args('after'), instruction: 'FAKE_COMPLETE_AFTER_RESUME' });
  const during = await current.call('start', { ...args('during'), instruction: 'FAKE_COMPLETE_ON_RESUME' });
  const inspectedTurn = await current.call('start', { ...args('inspected'), instruction: 'FAKE_COMPLETE_ON_SECOND_READ' });
  const observer = await launch();
  assert.equal((await observer.call('inspect', args('after'))).feature.agent.status, 'running');
  assert.ok(!(await lines(env.FAKE_CODEX_LOG)).some(entry => entry.method === 'thread/resume' && entry.threadId === after.threadId), 'inspection does not claim a live controller\'s turn');
  await observer.stop();
  await current.kill();
  current = await launch();

  const waited = await current.call('wait', { ...args('after'), timeout_seconds: 3 });
  assert.equal(waited.timedOut, false);
  assert.deepEqual({ status: waited.feature.agent.status, turnId: waited.feature.agent.activeTurnId }, { status: 'idle', turnId: null });
  assert.equal(waited.feature.summary, `Codex handoff for ${after.turnId}.`);

  const inspected = await current.call('inspect', args('during'));
  assert.equal(inspected.warning, null);
  assert.equal(inspected.feature.agent.status, 'idle');
  assert.equal(inspected.feature.summary, `Codex handoff for ${during.turnId}.`);
  const afterInspect = await current.call('wait', { ...args('during'), timeout_seconds: 2 });
  assert.equal(afterInspect.timedOut, false);
  assert.equal(afterInspect.feature.summary, `Codex handoff for ${during.turnId}.`);
  assert.equal(afterInspect.feature.agent.status, 'idle');
  const completions = (await getFeatureContext({ ...args('during'), timeline_limit: 50 })).timeline.filter(event => event.kind === 'agent.idle' && event.summary === `Codex handoff for ${during.turnId}.`);
  assert.equal(completions.length, 1);
  const runningInspect = await current.call('inspect', args('inspected'));
  assert.equal(runningInspect.warning, null);
  assert.equal(runningInspect.feature.agent.status, 'running');
  const afterRunningInspect = await current.call('wait', { ...args('inspected'), timeout_seconds: 3 });
  assert.equal(afterRunningInspect.timedOut, false);
  assert.equal(afterRunningInspect.feature.agent.status, 'idle');
  assert.equal(afterRunningInspect.feature.summary, `Codex handoff for ${inspectedTurn.turnId}.`);
  const resumed = (await lines(env.FAKE_CODEX_LOG)).filter(entry => entry.method === 'thread/resume').map(entry => entry.threadId);
  assert.ok([after.threadId, during.threadId, inspectedTurn.threadId].every(threadId => resumed.includes(threadId)));
  await current.stop();
});

test('saved sessions keep their owning backend across harness changes and real controller restarts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-restart-'));
  const controllers = [];
  t.after(async () => {
    for (const running of controllers) await running.kill().catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await initializeManagedProject({ workspace_path: root, project_name: 'Restart fixture', description: 'Exercise session ownership.', harness: 'claude' });
  const args = { workspace_path: root, feature: 'alpha' };
  await createFeature({ ...args, title: 'Alpha', outcome: 'Keep one conversation.', spec: '# Alpha\n\nKeep the conversation.' });
  const env = {
    FAKE_CODEX_STORE: path.join(root, 'codex-store.json'), FAKE_CODEX_LOG: path.join(root, 'codex.log'),
    FAKE_CLAUDE_STORE: path.join(root, 'claude-store.json'), FAKE_CLAUDE_LOG: path.join(root, 'claude.log'),
  };
  const launch = async () => {
    const running = controller(env);
    controllers.push(running);
    await running.started;
    return running;
  };
  const configure = async harness => {
    const file = path.join(root, 'theater.json');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), harness }, null, 2));
  };
  const agent = async () => (await getFeatureContext(args)).feature.agent;
  const settled = status => eventually(async () => (await agent()).status === status, status);

  let current = await launch();
  const first = await current.call('start', args);
  assert.equal(first.harness, 'claude');
  assert.equal(first.createdSession, true);
  const claudeThread = first.threadId;
  await settled('idle');

  // The configured harness changes and the controller restarts gracefully.
  await configure('codex');
  await current.stop();
  current = await launch();
  assert.deepEqual({ threadId: (await agent()).threadId, harness: (await agent()).harness }, { threadId: claudeThread, harness: 'claude' });
  assert.match(await fs.readFile(path.join(root, '.theater', 'features', 'alpha', 'context.md'), 'utf8'), new RegExp(`thread ${claudeThread} \\(claude\\)`));
  // A fresh controller reads the Claude session from its metadata without launching a turn, and
  // says that earlier turns are not loaded instead of presenting an empty transcript.
  const inspected = await current.call('inspect', args);
  assert.equal(inspected.warning, null);
  assert.deepEqual(
    { harness: inspected.feature.agent.harness, status: inspected.feature.agent.status, id: inspected.nativeTask.id, nativeStatus: inspected.nativeTask.status, history: inspected.nativeTask.history, turns: inspected.nativeTask.turns },
    { harness: 'claude', status: 'idle', id: claudeThread, nativeStatus: 'unknown', history: 'unavailable', turns: null },
  );
  assert.match(inspected.nativeTask.historyNote, /not loaded/);
  assert.match(inspected.feature.summary, /^Handoff 1: wrote worker-1\.txt\./, 'the retained safe handoff is the summary');
  assert.equal((await lines(env.FAKE_CLAUDE_LOG)).length, 1, 'inspection launched no Claude process');
  const resumed = await current.call('start', { ...args, instruction: 'Continue.' });
  assert.deepEqual({ threadId: resumed.threadId, harness: resumed.harness, created: resumed.createdSession }, { threadId: claudeThread, harness: 'claude', created: false });
  await settled('idle');
  const loaded = (await current.call('inspect', args)).nativeTask;
  assert.equal(loaded.history, 'controller');
  assert.match(loaded.turns.at(-1).visible.at(-1).text, /^Handoff 2:/);

  // Interrupt reaches the owning backend after the configuration change.
  await current.call('start', { ...args, instruction: 'hang' });
  await settled('running');
  const interrupted = await current.call('interrupt', args);
  assert.deepEqual({ interrupted: interrupted.interrupted, harness: interrupted.harness }, { interrupted: true, harness: 'claude' });
  await settled('interrupted');

  // Compaction queued behind an active turn runs on the owning backend when the turn ends.
  await current.call('start', { ...args, instruction: 'Write one more file.' });
  assert.equal((await current.call('compact', args)).queued, true);
  await eventually(async () => {
    const state = await getFeatureContext(args);
    return state.feature.agent.status === 'idle' && !state.feature.compactionPending;
  }, 'queued compaction');
  assert.ok((await getFeatureContext({ ...args, timeline_limit: 50 })).timeline.some(event => event.kind === 'agent.compacted' && event.details.threadId === claudeThread));

  // A hard controller kill mid-turn leaves a turn that may still be running. The next controller
  // cannot see Claude history, so it keeps the turn uncertain and dispatches nothing until the
  // coordinator attests; then it resumes on the owner, not the configured harness.
  const hung = await current.call('start', { ...args, instruction: 'hang' });
  await settled('running');
  await current.kill();
  current = await launch();
  const afterCrash = await current.call('inspect', args);
  assert.deepEqual(
    { status: afterCrash.feature.agent.status, turnId: afterCrash.feature.agent.activeTurnId, id: afterCrash.nativeTask.id, history: afterCrash.nativeTask.history },
    { status: 'uncertain', turnId: hung.turnId, id: claudeThread, history: 'unavailable' },
  );
  assert.match(afterCrash.warning, /prior_turn_attestation/);
  await assert.rejects(current.call('start', { ...args, instruction: 'Resume after the crash.' }), error => error.code === 'DISPATCH_UNCERTAIN');
  const recovered = await current.call('start', { ...args, instruction: 'Resume after the crash.', prior_turn_attestation: { evidence: 'The killed controller took its fake Claude worker with it; none remains for this checkout.' } });
  assert.deepEqual({ threadId: recovered.threadId, harness: recovered.harness, created: recovered.createdSession }, { threadId: claudeThread, harness: 'claude', created: false });
  await settled('idle');

  // An explicit replacement adopts the configured harness and names the previous session.
  const replaced = await current.call('start', { ...args, instruction: 'Start fresh.', force_new_session: true });
  assert.equal(replaced.harness, 'codex');
  assert.equal(replaced.createdSession, true);
  assert.match(replaced.threadId, /^codex-/);
  await settled('idle');
  const replacement = (await getFeatureContext({ ...args, timeline_limit: 50 })).timeline.find(event => event.kind === 'agent.session_replaced');
  assert.deepEqual(replacement.details, { previousThreadId: claudeThread, previousHarness: 'claude', threadId: replaced.threadId, harness: 'codex' });

  // Switching the configuration back does not move the Codex session to Claude either.
  await configure('claude');
  await current.stop();
  current = await launch();
  const codexResumed = await current.call('start', { ...args, instruction: 'Continue on Codex.' });
  assert.deepEqual({ threadId: codexResumed.threadId, harness: codexResumed.harness, created: codexResumed.createdSession }, { threadId: replaced.threadId, harness: 'codex', created: false });
  await settled('idle');
  const codexTask = (await current.call('inspect', args)).nativeTask;
  assert.deepEqual({ id: codexTask.id, history: codexTask.history }, { id: replaced.threadId, history: 'native' });
  assert.ok(codexTask.turns.length > 0);
  await current.stop();

  const codexLog = await lines(env.FAKE_CODEX_LOG);
  const claudeLog = await lines(env.FAKE_CLAUDE_LOG);
  assert.ok(codexLog.length > 0 && claudeLog.length > 0);
  assert.ok(codexLog.every(entry => entry.threadId === null || entry.threadId.startsWith('codex-')), 'Codex never received a Claude session');
  assert.ok(claudeLog.every(entry => entry.sessionId === claudeThread), 'Claude never received a Codex session');
  assert.deepEqual(claudeLog.map(entry => entry.mode), ['create', 'resume', 'resume', 'resume', 'resume', 'resume']);
});

test('a real Codex app-server refusal fails the turn while a lost response is reconciled without a duplicate turn', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-dispatch-'));
  const env = { FAKE_CODEX_STORE: path.join(root, 'codex-store.json'), FAKE_CODEX_LOG: path.join(root, 'codex.log'), FAKE_CODEX_TIMEOUT_MS: '800' };
  const running = controller(env);
  t.after(async () => {
    await running.kill().catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await initializeManagedProject({ workspace_path: root, project_name: 'Dispatch fixture', description: 'Exercise unconfirmed turn requests.' });
  const args = { workspace_path: root, feature: 'alpha' };
  await createFeature({ ...args, title: 'Alpha', outcome: 'Start each turn once.', spec: '# Alpha' });
  await running.started;
  const agent = async () => {
    const { threadId, status, activeTurnId } = (await getFeatureContext(args)).feature.agent;
    return { threadId, status, activeTurnId };
  };
  const first = await running.call('start', args);
  await eventually(async () => (await agent()).status === 'idle', 'idle');
  const turns = async () => JSON.parse(await fs.readFile(env.FAKE_CODEX_STORE, 'utf8'))[first.threadId].turns;

  await assert.rejects(running.call('start', { ...args, instruction: 'FAKE_REFUSE' }), error => error.code === 'CODEX_RPC_ERROR');
  assert.deepEqual(await agent(), { threadId: first.threadId, status: 'failed', activeTurnId: null });
  assert.equal((await turns()).length, 1);

  await assert.rejects(running.call('start', { ...args, instruction: 'FAKE_LOSE_RESPONSE' }), error => error.code === 'CODEX_TIMEOUT');
  assert.deepEqual(await agent(), { threadId: first.threadId, status: 'uncertain', activeTurnId: null });
  const lost = (await turns()).at(-1);
  await assert.rejects(running.call('start', { ...args, instruction: 'Continue.' }), error => error.code === 'TURN_ACTIVE');
  assert.deepEqual(await agent(), { threadId: first.threadId, status: 'running', activeTurnId: lost.id });
  assert.equal((await turns()).length, 2, 'the reconciled turn was not dispatched twice');
  await eventually(async () => (await agent()).status === 'idle', 'lost turn completion');
  await running.call('start', { ...args, instruction: 'Continue.' });
  await eventually(async () => (await agent()).status === 'idle', 'final turn');
  assert.equal((await turns()).length, 3);
  await running.stop();
});
test('an unconfirmed turn request survives a controller crash and is reconciled by the next controller', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-crash-'));
  const env = {
    FAKE_CODEX_STORE: path.join(root, 'codex-store.json'), FAKE_CODEX_LOG: path.join(root, 'codex.log'), FAKE_CODEX_TIMEOUT_MS: '800',
    FAKE_CLAUDE_STORE: path.join(root, 'claude-store.json'), FAKE_CLAUDE_LOG: path.join(root, 'claude.log'),
  };
  const controllers = [];
  t.after(async () => {
    for (const running of controllers) await running.kill().catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const launch = async () => {
    const running = controller(env);
    controllers.push(running);
    await running.started;
    return running;
  };
  await initializeManagedProject({ workspace_path: root, project_name: 'Crash fixture', description: 'Exercise unconfirmed turns across restarts.' });
  const codexLane = { workspace_path: root, feature: 'alpha' };
  const claudeLane = { workspace_path: root, feature: 'beta' };
  await createFeature({ ...codexLane, title: 'Alpha', outcome: 'Codex lane.', spec: '# Alpha' });
  await createFeature({ ...claudeLane, title: 'Beta', outcome: 'Claude lane.', spec: '# Beta' });
  const agent = async args => {
    const { status, activeTurnId } = (await getFeatureContext(args)).feature.agent;
    return { status, activeTurnId };
  };
  const settled = (args, status) => eventually(async () => (await agent(args)).status === status, `${args.feature} ${status}`);
  const codexTurns = async threadId => JSON.parse(await fs.readFile(env.FAKE_CODEX_STORE, 'utf8'))[threadId].turns;

  let current = await launch();
  const codexSession = await current.call('start', codexLane);
  await settled(codexLane, 'idle');
  const file = path.join(root, 'theater.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), harness: 'claude' }, null, 2));
  const claudeSession = await current.call('start', claudeLane);
  assert.equal(claudeSession.harness, 'claude');
  await settled(claudeLane, 'idle');

  // Codex: the lost turn is still in progress in the native session when the controller dies.
  await assert.rejects(current.call('start', { ...codexLane, instruction: 'FAKE_LOSE_RESPONSE' }), error => error.code === 'CODEX_TIMEOUT');
  assert.deepEqual(await agent(codexLane), { status: 'uncertain', activeTurnId: null });
  await current.kill();
  current = await launch();
  assert.deepEqual(await agent(codexLane), { status: 'uncertain', activeTurnId: null }, 'crash recovery keeps the unconfirmed state');
  const lostTurn = (await codexTurns(codexSession.threadId)).at(-1);
  const recoveredInspect = await current.call('inspect', codexLane);
  assert.equal(recoveredInspect.warning, null);
  assert.deepEqual({ status: recoveredInspect.feature.agent.status, activeTurnId: recoveredInspect.feature.agent.activeTurnId }, { status: 'running', activeTurnId: lostTurn.id });
  await assert.rejects(current.call('start', { ...codexLane, instruction: 'Retry.' }), error => error.code === 'TURN_ACTIVE');
  assert.deepEqual(await agent(codexLane), { status: 'running', activeTurnId: lostTurn.id });
  assert.equal((await codexTurns(codexSession.threadId)).length, 2, 'the retry did not dispatch a duplicate turn');
  assert.equal((await current.call('interrupt', codexLane)).interrupted, true);
  await settled(codexLane, 'interrupted');

  // Codex: the lost turn finished while no controller was listening; native history proves it.
  await assert.rejects(current.call('start', { ...codexLane, instruction: 'FAKE_LOSE_RESPONSE_DONE' }), error => error.code === 'CODEX_TIMEOUT');
  assert.equal((await agent(codexLane)).status, 'uncertain');
  await current.kill();
  current = await launch();
  assert.equal((await agent(codexLane)).status, 'uncertain');
  const retried = await current.call('start', { ...codexLane, instruction: 'Retry.' });
  assert.equal(retried.createdSession, false);
  await settled(codexLane, 'idle');
  assert.equal((await codexTurns(codexSession.threadId)).length, 4, 'exactly one turn followed the finished lost turn');
  assert.ok((await getFeatureContext({ ...codexLane, timeline_limit: 50 })).timeline.some(event => event.kind === 'agent.dispatch_reconciled' && /no running turn/.test(event.summary)));

  // Codex: turn/started arrived, then the response was lost and the controller died while the
  // lane showed running. Recovery keeps the known turn uncertain rather than disconnected.
  await assert.rejects(current.call('start', { ...codexLane, instruction: 'FAKE_STARTED_THEN_LOSE' }), error => error.code === 'CODEX_TIMEOUT');
  const startedTurn = (await codexTurns(codexSession.threadId)).at(-1);
  assert.deepEqual(await agent(codexLane), { status: 'running', activeTurnId: startedTurn.id });
  await current.kill();
  current = await launch();
  assert.deepEqual(await agent(codexLane), { status: 'uncertain', activeTurnId: startedTurn.id }, 'crash recovery keeps a possibly live turn');
  await assert.rejects(current.call('start', { ...codexLane, instruction: 'Retry.' }), error => error.code === 'TURN_ACTIVE');
  assert.deepEqual(await agent(codexLane), { status: 'running', activeTurnId: startedTurn.id });
  assert.equal((await codexTurns(codexSession.threadId)).length, 5, 'no duplicate after a started-then-lost turn');
  assert.equal((await current.call('interrupt', codexLane)).interrupted, true);
  await settled(codexLane, 'interrupted');

  // Claude: a later controller cannot see earlier turns, so it neither assumes idle nor retries
  // until the coordinator confirms out of band that no worker is running.
  await assert.rejects(current.call('start', { ...claudeLane, instruction: 'hang FAKE_LOST_AFTER_SEND' }), error => error.code === 'CODEX_TIMEOUT');
  assert.deepEqual(await agent(claudeLane), { status: 'uncertain', activeTurnId: null });
  const launchesBefore = (await lines(env.FAKE_CLAUDE_LOG)).length;
  await current.kill();
  current = await launch();
  const inspected = await current.call('inspect', claudeLane);
  assert.deepEqual({ status: inspected.feature.agent.status, history: inspected.nativeTask.history, turns: inspected.nativeTask.turns }, { status: 'uncertain', history: 'unavailable', turns: null });
  assert.match(inspected.warning, /prior_turn_attestation/);
  await assert.rejects(current.call('start', { ...claudeLane, instruction: 'Retry.' }), error => error.code === 'DISPATCH_UNCERTAIN' && /prior_turn_attestation/.test(error.message));
  await assert.rejects(current.call('start', { ...claudeLane, instruction: 'Retry.', prior_turn_attestation: true }), error => error.code === 'INVALID_INPUT');
  await assert.rejects(current.call('start', { ...claudeLane, instruction: 'Retry.', prior_turn_attestation: { evidence: ' ' } }), error => error.code === 'INVALID_INPUT');
  assert.equal((await agent(claudeLane)).status, 'uncertain');
  assert.equal((await lines(env.FAKE_CLAUDE_LOG)).length, launchesBefore, 'no Claude process was launched without an attestation');
  const evidence = 'The controller that sent the request exited; no fake Claude worker process for this checkout remains.';
  const confirmed = await current.call('start', { ...claudeLane, instruction: 'Retry.', prior_turn_attestation: { evidence } });
  assert.deepEqual({ threadId: confirmed.threadId, harness: confirmed.harness, created: confirmed.createdSession }, { threadId: claudeSession.threadId, harness: 'claude', created: false });
  await settled(claudeLane, 'idle');
  const launches = await lines(env.FAKE_CLAUDE_LOG);
  assert.deepEqual(launches.slice(launchesBefore), [{ mode: 'resume', sessionId: claudeSession.threadId }]);
  const attested = (await getFeatureContext({ ...claudeLane, timeline_limit: 50 })).timeline.find(event => event.kind === 'agent.dispatch_reconciled');
  assert.deepEqual(attested.details, { basis: 'coordinator_attestation', attestation: { evidence } });
  // With readable native history, the Codex lane was settled from that history, not an attestation.
  assert.equal((await getFeatureContext({ ...codexLane, timeline_limit: 50 })).timeline.find(event => event.kind === 'agent.dispatch_reconciled').details.basis, 'native_history');
  await current.stop();
});
