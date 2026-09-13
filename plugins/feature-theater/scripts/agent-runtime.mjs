import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAppServer, finalVisibleMessage } from './app-server.mjs';
import { summarizePatch, TheaterError, optionalText, parseJsonObject, requiredText, redactString } from './util.mjs';
import { withAgentControl } from './ownership.mjs';
import {
  featureRuntime,
  getFeatureContext,
  markCompacted,
  pendingAgentRequest,
  recordAgentEvent,
  resolveAgentRequestRecord,
  saveAgentSession,
  savePendingAgentRequest,
  queueCompaction,
} from './workspace.mjs';

export function createAgentRuntime(bridge = new CodexAppServer()) {
const ownerToken = randomUUID();
const registrations = new Map();
const turnMessages = new Map();
const turnDiffs = new Map();
const turnPlans = new Map();
const compactionWaiters = new Map();
const compactionTurns = new Set();
const recordedCompactions = new Set();
let notificationQueue = Promise.resolve();
let shuttingDown = false;

function enqueueStateWork(work) {
  const next = notificationQueue.then(work);
  notificationQueue = next.catch(error => {
    process.stderr.write(`[feature-theater] event handling failed: ${redactString(error.message)}\n`);
  });
  return next;
}

function register(threadId, workspacePath, feature) {
  registrations.set(threadId, { workspacePath, feature });
}

function textInput(text) {
  return [{ type: 'text', text, text_elements: [] }];
}

function clip(value, max = 100_000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

function safePayload(value, key = '') {
  if (/reasoning|chain.?of.?thought|encrypted|credential|cookie/i.test(key)) return '[omitted]';
  if (/^(?:token|password|passwd|secret|api[_-]?key|authorization)$/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(clip(value, 20_000));
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safePayload(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([entryKey, entryValue]) => [entryKey, safePayload(entryValue, entryKey)]));
  }
  return value;
}

function settleCompaction(threadId) {
  const waiter = compactionWaiters.get(threadId);
  if (!waiter?.compacted || !waiter.turnCompleted) return;
  clearTimeout(waiter.timer);
  compactionWaiters.delete(threadId);
  waiter.resolve();
}

async function recordCompaction(base, threadId, turnId) {
  const key = `${threadId}:${turnId || 'unknown'}`;
  const waiter = compactionWaiters.get(threadId);
  if (!recordedCompactions.has(key)) {
    recordedCompactions.add(key);
    if (recordedCompactions.size > 256) recordedCompactions.delete(recordedCompactions.values().next().value);
    try {
      await markCompacted(base);
    } catch (error) {
      recordedCompactions.delete(key);
      waiter?.reject(error);
      throw error;
    }
  }
  if (waiter) {
    waiter.compacted = true;
    settleCompaction(threadId);
  }
}

function requestSummary(method, params) {
  if (method === 'item/commandExecution/requestApproval') {
    return `Agent requests approval to run: ${redactString(params.command || 'a command')}`;
  }
  if (method === 'item/fileChange/requestApproval') return `Agent requests file access${params.grantRoot ? ` under ${params.grantRoot}` : ''}.`;
  if (method === 'item/permissions/requestApproval') return `Agent requests additional ${params.permissions?.network ? 'network' : 'filesystem'} permission.`;
  if (method === 'item/tool/requestUserInput') return `Agent needs user input for ${params.questions?.length || 1} question(s).`;
  if (method === 'mcpServer/elicitation/request') return 'An agent tool needs user input.';
  return `Codex agent needs a response for ${method}.`;
}

async function onServerRequest(message) {
  const registration = registrations.get(message.params?.threadId);
  if (!registration) {
    try { bridge.respondToServer(message.id, undefined, 'Feature Theater cannot route this request to a registered feature.'); } catch { /* process may be exiting */ }
    return;
  }
  const payload = safePayload(message.params);
  await savePendingAgentRequest({
    workspace_path: registration.workspacePath,
    feature: registration.feature,
    owner_token: ownerToken,
    request_id: message.id,
    thread_id: message.params.threadId,
    turn_id: message.params.turnId,
    method: message.method,
    summary: requestSummary(message.method, payload),
    payload,
  });
}

async function onNotification({ method, params }) {
  // Reasoning and raw response notifications are intentionally ignored. They are never state inputs.
  if (/reasoning|rawResponse/i.test(method)) return;
  const registration = registrations.get(params.threadId);
  if (!registration) return;
  const base = { workspace_path: registration.workspacePath, feature: registration.feature, owner_token: ownerToken };
  if (method === 'item/agentMessage/delta') {
    const key = params.turnId;
    turnMessages.set(key, redactString(clip((turnMessages.get(key) || '') + (params.delta || ''))));
    return;
  }
  if (method === 'turn/diff/updated') {
    turnDiffs.set(params.turnId, summarizePatch(params.diff || ''));
    return;
  }
  if (method === 'turn/plan/updated') {
    turnPlans.set(params.turnId, safePayload({ explanation: params.explanation, steps: params.plan }));
    return;
  }
  if (method === 'item/started' && params.item?.type === 'contextCompaction') {
    compactionTurns.add(params.turnId);
    return;
  }
  if (method === 'item/completed' && params.item?.type === 'contextCompaction') {
    compactionTurns.add(params.turnId);
    await recordCompaction(base, params.threadId, params.turnId);
    return;
  }
  if (method === 'turn/started') {
    if (compactionWaiters.has(params.threadId)) compactionTurns.add(params.turn?.id);
    await saveAgentSession({ ...base, thread_id: params.threadId, turn_id: params.turn?.id, status: 'running' });
    return;
  }
  if (method === 'thread/compacted') {
    compactionTurns.add(params.turnId);
    await recordCompaction(base, params.threadId, params.turnId);
    return;
  }
  if (method === 'turn/completed') {
    const turn = params.turn || {};
    const turnId = turn.id;
    if (compactionTurns.has(turnId) && compactionWaiters.has(params.threadId)) {
      compactionTurns.delete(turnId);
      await saveAgentSession({ ...base, thread_id: params.threadId, turn_id: null, status: ['failed', 'interrupted'].includes(turn.status) ? turn.status : 'idle' });
      if (['failed', 'interrupted'].includes(turn.status)) {
        const waiter = compactionWaiters.get(params.threadId);
        if (waiter) {
          clearTimeout(waiter.timer);
          compactionWaiters.delete(params.threadId);
          waiter.reject(new TheaterError(`Thread compaction ${turn.status}: ${params.threadId}`, 'COMPACTION_FAILED'));
        }
      } else {
        const waiter = compactionWaiters.get(params.threadId);
        if (waiter) {
          waiter.turnCompleted = true;
          settleCompaction(params.threadId);
        }
      }
      return;
    }
    const visible = redactString(clip(finalVisibleMessage(turn) || turnMessages.get(turnId) || `Agent turn ${turn.status || 'completed'}.`));
    const diff = turnDiffs.get(turnId);
    const plan = turnPlans.get(turnId);
    if (plan) await recordAgentEvent({ ...base, kind: 'agent.plan', summary: 'Agent updated its visible plan.', details: plan });
    if (diff) await recordAgentEvent({ ...base, kind: 'agent.diff', summary: `Working diff touched ${diff.fileCount} file(s), +${diff.additions}/-${diff.deletions}.`, details: diff });
    const status = ['failed', 'interrupted'].includes(turn.status) ? turn.status : 'idle';
    await saveAgentSession({ ...base, thread_id: params.threadId, turn_id: null, status, summary: visible });
    turnMessages.delete(turnId);
    turnDiffs.delete(turnId);
    turnPlans.delete(turnId);
    compactionTurns.delete(turnId);
    const runtime = await featureRuntime({ ...base, allow_inactive: true });
    if (!shuttingDown && runtime.feature.compaction_pending && status === 'idle') {
      setTimeout(() => { if (!shuttingDown) void compactFeatureAgent(base).catch(error => process.stderr.write(`[feature-theater] deferred compaction: ${redactString(error.message)}\n`)); }, 0);
    }
  }
}

bridge.on('serverRequest', message => { void enqueueStateWork(() => onServerRequest(message)); });
bridge.on('notification', message => {
  void enqueueStateWork(() => onNotification(message));
});
bridge.on('exit', error => {
  notificationQueue = notificationQueue.then(async () => {
  for (const waiter of compactionWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
  compactionWaiters.clear();
  for (const [threadId, registration] of registrations) {
    const base = { workspace_path: registration.workspacePath, feature: registration.feature, owner_token: ownerToken };
    const runtime = await featureRuntime({ ...base, allow_inactive: true }).catch(() => null);
    const interrupted = Boolean(runtime?.feature.active_turn_id || runtime?.feature.agent_status === 'waiting_for_user');
    await saveAgentSession({ ...base, thread_id: threadId, turn_id: null, status: interrupted ? 'disconnected' : 'idle', ...(interrupted ? { summary: `Codex app-server disconnected: ${redactString(error.message)}` } : {}) }).catch(() => {});
  }
  registrations.clear();
  turnMessages.clear();
  turnPlans.clear();
  turnDiffs.clear();
  compactionTurns.clear();
  }).catch(() => {});
});

function runtimeRoots(runtime) {
  return [runtime.feature.checkout_path, path.dirname(runtime.contextPath)];
}

function runPrompt(runtime, instruction) {
  const direction = optionalText(instruction, 'instruction', { max: 100_000 }) || runtime.feature.next_action || 'Choose and complete the highest-priority ready work.';
  return `Continue the ${runtime.feature.slug} feature lane.\n\nUser/coordinator direction:\n${direction}\n\nFirst load the feature context and spec named in your developer instructions, then inspect current Git state. Reconcile the request with the durable work graph. Work toward the smallest coherent verified result; do not silently broaden scope. Keep visible progress updates safe and concise. End with a handoff containing the exact resulting revision or dirty-state description, checks actually run and their outcomes, unresolved issues, and the next useful action. Do not include private chain-of-thought.`;
}

async function compactThreadAndWait(threadId) {
  if (compactionWaiters.has(threadId)) throw new TheaterError(`Compaction is already running for ${threadId}.`, 'COMPACTION_ACTIVE');
  let resolve;
  let reject;
  const completion = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const timer = setTimeout(() => reject(new TheaterError(`Timed out waiting for thread compaction: ${threadId}`, 'CODEX_TIMEOUT')), 180_000);
  compactionWaiters.set(threadId, { resolve, reject, timer, compacted: false, turnCompleted: false });
  try {
    await Promise.all([bridge.request('thread/compact/start', { threadId }), completion]);
  } catch (error) {
    clearTimeout(timer);
    compactionWaiters.delete(threadId);
    throw error;
  }
}

async function resume(runtime) {
  if (registrations.has(runtime.feature.thread_id)) return;
  const response = await bridge.resumeThread({
    threadId: runtime.feature.thread_id,
    cwd: runtime.feature.checkout_path,
    runtimeWorkspaceRoots: runtimeRoots(runtime),
    developerInstructions: runtime.developerInstructions,
  });
  register(runtime.feature.thread_id, runtime.root, runtime.feature.slug);
  return response;
}

async function dispatchTurn(runtime, threadId, instruction, effort, created = false) {
  const base = { workspace_path: runtime.root, feature: runtime.feature.slug, thread_id: threadId, owner_token: ownerToken };
  await enqueueStateWork(() => saveAgentSession({ ...base, status: 'starting', compacted: created && runtime.feature.compaction_pending }));
  try {
    const result = await bridge.request('turn/start', {
      threadId, input: textInput(runPrompt(runtime, instruction)), cwd: runtime.feature.checkout_path,
      runtimeWorkspaceRoots: runtimeRoots(runtime), model: 'gpt-6-astra', effort, summary: 'concise',
    });
    await enqueueStateWork(() => saveAgentSession({ ...base, turn_id: result.turn.id, status: 'running', only_if_starting: true }));
    return result;
  } catch (error) {
    await enqueueStateWork(() => saveAgentSession({ ...base, status: 'failed', summary: `Unable to start turn: ${redactString(error.message)}` }));
    throw error;
  }
}

async function startOwned({ workspace_path, feature, instruction, effort = 'high', force_new_session = false }) {
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new TheaterError('Unsupported reasoning effort.', 'INVALID_INPUT');
  const runtime = await featureRuntime({ workspace_path, feature });
  if (!runtime.feature.spec_revision) throw new TheaterError('Save a concrete feature specification before starting its agent.', 'SPEC_REQUIRED');
  if (runtime.feature.active_turn_id) throw new TheaterError(`Feature already has active turn ${runtime.feature.active_turn_id}; steer it instead.`, 'TURN_ACTIVE');
  await bridge.ensureStarted();
  let threadId = runtime.feature.thread_id;
  let created = false;
  if (threadId && !force_new_session) {
    await resume(runtime);
    if (runtime.feature.compaction_pending) {
      await compactThreadAndWait(threadId);
    }
  } else {
    const started = await bridge.startThread({
      cwd: runtime.feature.checkout_path,
      runtimeWorkspaceRoots: runtimeRoots(runtime),
      developerInstructions: runtime.developerInstructions,
      model: 'gpt-6-astra',
      effort,
    });
    threadId = started.thread.id;
    created = true;
    register(threadId, runtime.root, runtime.feature.slug);
    await bridge.request('thread/name/set', { threadId, name: `Theater · ${runtime.feature.title}` }).catch(() => {});
  }
  const turn = await dispatchTurn(runtime, threadId, instruction, effort, created);
  return {
    feature: runtime.feature.slug,
    threadId,
    turnId: turn.turn.id,
    createdSession: created,
    model: 'gpt-6-astra',
    effort,
    checkoutPath: runtime.feature.checkout_path,
    next: 'The feature task is running. Use theater_agent_inspect for safe progress or theater_agent_steer to revise direction mid-turn.',
  };
}

async function steerOwned({ workspace_path, feature, instruction, effort = 'high' }) {
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new TheaterError('Unsupported reasoning effort.', 'INVALID_INPUT');
  const direction = requiredText(instruction, 'instruction', { max: 100_000 });
  const runtime = await featureRuntime({ workspace_path, feature });
  if (!runtime.feature.thread_id) throw new TheaterError('This feature has no agent session. Start it first.', 'AGENT_NOT_STARTED');
  await bridge.ensureStarted();
  await resume(runtime);
  let result;
  let mode;
  if (runtime.feature.active_turn_id) {
    result = await bridge.request('turn/steer', {
      threadId: runtime.feature.thread_id,
      expectedTurnId: runtime.feature.active_turn_id,
      input: textInput(direction),
    });
    mode = 'mid_turn';
  } else {
    if (runtime.feature.compaction_pending) {
      await compactThreadAndWait(runtime.feature.thread_id);
    }
    result = await dispatchTurn(runtime, runtime.feature.thread_id, direction, effort);
    mode = 'new_turn';
  }
  await recordAgentEvent({ workspace_path: runtime.root, feature: runtime.feature.slug, kind: 'coordinator.steered', summary: `Coordinator ${mode === 'mid_turn' ? 'steered the active turn' : 'started a follow-up turn'}: ${redactString(clip(direction, 2_000))}`, details: { mode } });
  return { feature: runtime.feature.slug, threadId: runtime.feature.thread_id, turnId: result.turnId || result.turn?.id || runtime.feature.active_turn_id, mode };
}

function safeThreadView(thread) {
  const turns = (thread.turns || []).slice(-2).map(turn => ({
    id: turn.id,
    status: turn.status,
    visible: (turn.items || []).filter(item => item.type === 'agentMessage' || item.type === 'plan').map(item => item.type === 'agentMessage'
      ? { type: 'agentMessage', text: redactString(clip(item.text, 6_000)) }
      : { type: 'plan', text: redactString(clip(item.text, 6_000)) }),
  }));
  return { id: thread.id, name: thread.name, cwd: thread.cwd, status: thread.status, updatedAt: thread.updatedAt, turns };
}

async function inspectFeatureAgent({ workspace_path, feature, include_thread = true }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  let thread = null;
  let warning = null;
  if (include_thread && runtime.feature.thread_id) {
    try {
      await bridge.ensureStarted();
      const response = await bridge.request('thread/read', { threadId: runtime.feature.thread_id, includeTurns: true });
      thread = safeThreadView(response.thread);
      const active = response.thread.turns?.find(turn => turn.id === runtime.feature.active_turn_id);
      if (active && ['completed', 'interrupted', 'failed'].includes(active.status)) {
        await enqueueStateWork(() => saveAgentSession({ workspace_path, feature, thread_id: runtime.feature.thread_id, owner_token: ownerToken, status: active.status === 'completed' ? 'idle' : active.status }));
      }
    } catch (error) {
      warning = `Native task could not be refreshed: ${error.message}`;
    }
  }
  const context = await getFeatureContext({ workspace_path: runtime.root, feature: runtime.feature.slug, timeline_limit: 30 });
  const turnId = context.feature.agent.activeTurnId;
  return { ...context, nativeTask: thread, liveProgress: { message: turnMessages.get(turnId) ? clip(turnMessages.get(turnId), 6_000) : null, plan: turnPlans.get(turnId) ?? null, diff: turnDiffs.get(turnId) ?? null }, warning, safety: 'Reasoning items are intentionally filtered. Visible agent messages and plans are reports; executed receipts remain the proof boundary.' };
}

async function waitFeatureAgent({ workspace_path, feature, timeout_seconds = 30 }) {
  if (!Number.isInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 60) throw new TheaterError('Wait duration must be 1–60 seconds.', 'INVALID_INPUT');
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  let timer;
  let finish;
  const changed = new Promise(resolve => { finish = resolve; });
  const notification = message => {
    if (message.params?.threadId === runtime.feature.thread_id && ['turn/completed', 'thread/status/changed'].includes(message.method)) finish(true);
  };
  const request = message => { if (message.params?.threadId === runtime.feature.thread_id) finish(true); };
  bridge.on('notification', notification);
  bridge.on('serverRequest', request);
  timer = setTimeout(() => finish(false), timeout_seconds * 1000);
  try {
    await notificationQueue;
    const initial = await getFeatureContext({ workspace_path, feature, timeline_limit: 1 });
    const signal = !initial.feature.agent.activeTurnId || initial.pendingAgentRequests.length ? true : await changed;
    await notificationQueue;
    const state = await inspectFeatureAgent({ workspace_path, feature, include_thread: true });
    return { timedOut: !signal, feature: state.feature, git: state.git, liveProgress: state.liveProgress, pendingAgentRequests: state.pendingAgentRequests, warning: state.warning };
  } finally {
    clearTimeout(timer);
    bridge.off('notification', notification);
    bridge.off('serverRequest', request);
  }
}

async function compactOwned({ workspace_path, feature }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  if (!runtime.feature.thread_id) return { compacted: false, reason: 'No feature task exists yet.' };
  await queueCompaction({ workspace_path, feature, owner_token: ownerToken });
  if (runtime.feature.active_turn_id) return { compacted: false, queued: true, reason: `Turn ${runtime.feature.active_turn_id} is active; compaction will run when it finishes.` };
  await bridge.ensureStarted();
  await resume(runtime);
  await enqueueStateWork(() => saveAgentSession({ workspace_path, feature, thread_id: runtime.feature.thread_id, owner_token: ownerToken, status: 'compacting' }));
  try {
    await compactThreadAndWait(runtime.feature.thread_id);
  } catch (error) {
    await enqueueStateWork(async () => {
      const current = await featureRuntime({ workspace_path, feature, allow_inactive: true });
      const base = { workspace_path, feature, thread_id: runtime.feature.thread_id, owner_token: ownerToken };
      if (!current.feature.active_turn_id && current.feature.agent_status === 'compacting') {
        await saveAgentSession({ ...base, status: 'failed' });
      }
      await recordAgentEvent({ ...base, kind: 'agent.compaction_failed', summary: `Compaction did not complete: ${redactString(error.message)}` });
    });
    throw error;
  }
  return { compacted: true, threadId: runtime.feature.thread_id, checkpoint: runtime.feature.summary };
}

async function interruptOwned({ workspace_path, feature }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  if (!runtime.feature.thread_id || !runtime.feature.active_turn_id) return { interrupted: false, reason: 'No active turn.' };
  await bridge.ensureStarted();
  await resume(runtime);
  await bridge.request('turn/interrupt', { threadId: runtime.feature.thread_id, turnId: runtime.feature.active_turn_id });
  await recordAgentEvent({ workspace_path: runtime.root, feature: runtime.feature.slug, kind: 'coordinator.interrupted', summary: `Interrupted active turn ${runtime.feature.active_turn_id}.`, details: {} });
  return { interrupted: true, threadId: runtime.feature.thread_id, turnId: runtime.feature.active_turn_id };
}

async function resolveRequestOwned({ workspace_path, feature, request_id, action, response, scope = 'turn' }) {
  if (!['accept', 'accept_session', 'decline', 'cancel', 'respond'].includes(action)) throw new TheaterError('Unknown request action.', 'INVALID_INPUT');
  if (!['turn', 'session'].includes(scope)) throw new TheaterError('scope must be turn or session.', 'INVALID_INPUT');
  const request = await pendingAgentRequest({ workspace_path, feature, request_id });
  await bridge.ensureStarted();
  const liveRequest = bridge.liveRequest(request_id);
  if (!liveRequest || liveRequest.params?.threadId !== request.thread_id) {
    await resolveAgentRequestRecord({ workspace_path, feature, request_id, status: 'orphaned', summary: `${request.method} belongs to an earlier app-server process and must be requested again.` });
    throw new TheaterError('This request belongs to an earlier server process and can no longer be answered. Inspect the feature task and retry the blocked operation.', 'REQUEST_ORPHANED');
  }
  let result;
  if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
    if (action === 'respond') throw new TheaterError('Use accept, accept_session, decline, or cancel for this request.', 'INVALID_INPUT');
    result = { decision: action === 'accept_session' ? 'acceptForSession' : action };
  } else if (request.method === 'item/permissions/requestApproval') {
    if (action === 'accept' || action === 'accept_session') result = { permissions: request.payload.permissions || {}, scope: action === 'accept_session' ? 'session' : scope };
    else result = { permissions: {}, scope: 'turn' };
  } else {
    if (action !== 'respond') throw new TheaterError('This request requires a structured response object.', 'INVALID_INPUT');
    result = parseJsonObject(response, 'response') || {};
  }
  bridge.respondToServer(request_id, result);
  await resolveAgentRequestRecord({ workspace_path, feature, request_id, summary: `Resolved ${request.method} with ${action}.` });
  return { resolved: true, requestId: String(request_id), action, feature };
}

async function compactOutgoingAfterSwitch(switchResult, workspacePath) {
  if (!switchResult?.from?.slug || !switchResult.compactFeatureThreadId) return { attempted: false };
  const result = await compactFeatureAgent({ workspace_path: workspacePath, feature: switchResult.from.slug });
  return { attempted: true, ...result };
}

async function shutdownAgentRuntime() {
  shuttingDown = true;
  await notificationQueue;
  bridge.shutdown();
  await notificationQueue;
}

const startFeatureAgent = args => withAgentControl(args, ownerToken, () => startOwned(args));
const steerFeatureAgent = args => withAgentControl(args, ownerToken, () => steerOwned(args));
const compactFeatureAgent = args => withAgentControl(args, ownerToken, () => compactOwned(args));
const interruptFeatureAgent = args => withAgentControl(args, ownerToken, () => interruptOwned(args));
const resolveFeatureAgentRequest = args => withAgentControl(args, ownerToken, () => resolveRequestOwned(args));
return { startFeatureAgent, steerFeatureAgent, inspectFeatureAgent, waitFeatureAgent, compactFeatureAgent, interruptFeatureAgent, resolveFeatureAgentRequest, compactOutgoingAfterSwitch, shutdownAgentRuntime };
}

export const { startFeatureAgent, steerFeatureAgent, inspectFeatureAgent, waitFeatureAgent, compactFeatureAgent, interruptFeatureAgent, resolveFeatureAgentRequest, compactOutgoingAfterSwitch, shutdownAgentRuntime } = createAgentRuntime();
