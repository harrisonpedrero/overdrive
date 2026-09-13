import path from 'node:path';
import { CodexAppServer, finalVisibleMessage } from './app-server.mjs';
import { summarizePatch, TheaterError, optionalText, parseJsonObject, requiredText } from './util.mjs';
import {
  featureRuntime,
  getFeatureContext,
  markCompacted,
  pendingAgentRequest,
  recordAgentEvent,
  resolveAgentRequestRecord,
  saveAgentSession,
  savePendingAgentRequest,
} from './workspace.mjs';

const bridge = new CodexAppServer();
const registrations = new Map();
const turnMessages = new Map();
const turnDiffs = new Map();
const turnPlans = new Map();
const compactionWaiters = new Map();
const compactionTurns = new Set();
const recordedCompactions = new Set();
let notificationQueue = Promise.resolve();

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

function redactString(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[credentials-redacted]@')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+/gi, '$1 [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ctx7sk-[A-Za-z0-9-]{20,})\b/g, '[redacted]')
    .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]');
}

function safePayload(value, key = '') {
  if (/reasoning|chain.?of.?thought|encrypted|credential|cookie/i.test(key)) return '[omitted]';
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
  const base = { workspace_path: registration.workspacePath, feature: registration.feature };
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
    if (compactionTurns.has(turnId)) {
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
  }
}

bridge.on('serverRequest', message => { void onServerRequest(message).catch(error => process.stderr.write(`[feature-theater] request handling failed: ${redactString(error.message)}\n`)); });
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
    void saveAgentSession({ workspace_path: registration.workspacePath, feature: registration.feature, thread_id: threadId, turn_id: null, status: 'disconnected', summary: `Codex app-server disconnected: ${redactString(error.message)}` }).catch(() => {});
  }
  registrations.clear();
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
    await bridge.request('thread/compact/start', { threadId });
    await completion;
  } catch (error) {
    clearTimeout(timer);
    compactionWaiters.delete(threadId);
    throw error;
  }
}

async function resume(runtime) {
  const response = await bridge.resumeThread({
    threadId: runtime.feature.thread_id,
    cwd: runtime.feature.checkout_path,
    runtimeWorkspaceRoots: runtimeRoots(runtime),
    developerInstructions: runtime.developerInstructions,
  });
  register(runtime.feature.thread_id, runtime.root, runtime.feature.slug);
  return response;
}

export async function startFeatureAgent({ workspace_path, feature, instruction, effort = 'high', force_new_session = false }) {
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new TheaterError('Unsupported reasoning effort.', 'INVALID_INPUT');
  const runtime = await featureRuntime({ workspace_path, feature });
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
  const turn = await bridge.request('turn/start', {
    threadId,
    input: textInput(runPrompt(runtime, instruction)),
    cwd: runtime.feature.checkout_path,
    runtimeWorkspaceRoots: runtimeRoots(runtime),
    model: 'gpt-6-astra',
    effort,
    summary: 'concise',
  });
  register(threadId, runtime.root, runtime.feature.slug);
  await enqueueStateWork(() => saveAgentSession({
      workspace_path: runtime.root,
      feature: runtime.feature.slug,
      thread_id: threadId,
      turn_id: turn.turn.id,
      status: 'running',
      summary: created ? 'Started a dedicated GPT-6 Astra feature task.' : 'Resumed the feature task with fresh lane context.',
      compacted: created && runtime.feature.compaction_pending,
    }));
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

export async function steerFeatureAgent({ workspace_path, feature, instruction, effort = 'high' }) {
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
    result = await bridge.request('turn/start', {
      threadId: runtime.feature.thread_id,
      input: textInput(runPrompt(runtime, direction)),
      cwd: runtime.feature.checkout_path,
      runtimeWorkspaceRoots: runtimeRoots(runtime),
      model: 'gpt-6-astra',
      effort,
      summary: 'concise',
    });
    mode = 'new_turn';
    await enqueueStateWork(() => saveAgentSession({ workspace_path: runtime.root, feature: runtime.feature.slug, thread_id: runtime.feature.thread_id, turn_id: result.turn.id, status: 'running' }));
  }
  await recordAgentEvent({ workspace_path: runtime.root, feature: runtime.feature.slug, kind: 'coordinator.steered', summary: `Coordinator ${mode === 'mid_turn' ? 'steered the active turn' : 'started a follow-up turn'}: ${redactString(clip(direction, 2_000))}`, details: { mode } });
  return { feature: runtime.feature.slug, threadId: runtime.feature.thread_id, turnId: result.turnId || result.turn?.id || runtime.feature.active_turn_id, mode };
}

function safeThreadView(thread) {
  const turns = (thread.turns || []).slice(-8).map(turn => ({
    id: turn.id,
    status: turn.status,
    visible: (turn.items || []).filter(item => item.type === 'agentMessage' || item.type === 'plan').map(item => item.type === 'agentMessage'
      ? { type: 'agentMessage', text: redactString(clip(item.text, 20_000)) }
      : { type: 'plan', text: redactString(clip(item.text, 20_000)) }),
  }));
  return { id: thread.id, name: thread.name, cwd: thread.cwd, status: thread.status, updatedAt: thread.updatedAt, turns };
}

export async function inspectFeatureAgent({ workspace_path, feature, include_thread = true }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  let thread = null;
  let warning = null;
  if (include_thread && runtime.feature.thread_id) {
    try {
      await bridge.ensureStarted();
      register(runtime.feature.thread_id, runtime.root, runtime.feature.slug);
      const response = await bridge.request('thread/read', { threadId: runtime.feature.thread_id, includeTurns: true });
      thread = safeThreadView(response.thread);
    } catch (error) {
      warning = `Native task could not be refreshed: ${error.message}`;
    }
  }
  const context = await getFeatureContext({ workspace_path: runtime.root, feature: runtime.feature.slug, timeline_limit: 30 });
  return { ...context, nativeTask: thread, warning, safety: 'Reasoning items are intentionally filtered. Visible agent messages and plans are reports; Git and evidence records remain the proof boundary.' };
}

export async function compactFeatureAgent({ workspace_path, feature }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  if (!runtime.feature.thread_id) return { compacted: false, reason: 'No feature task exists yet.' };
  if (runtime.feature.active_turn_id) return { compacted: false, queued: true, reason: `Turn ${runtime.feature.active_turn_id} is active; compaction remains queued for the next idle boundary.` };
  await bridge.ensureStarted();
  await resume(runtime);
  await compactThreadAndWait(runtime.feature.thread_id);
  return { compacted: true, threadId: runtime.feature.thread_id, checkpoint: runtime.feature.summary };
}

export async function interruptFeatureAgent({ workspace_path, feature }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  if (!runtime.feature.thread_id || !runtime.feature.active_turn_id) return { interrupted: false, reason: 'No active turn.' };
  await bridge.ensureStarted();
  await resume(runtime);
  await bridge.request('turn/interrupt', { threadId: runtime.feature.thread_id, turnId: runtime.feature.active_turn_id });
  await recordAgentEvent({ workspace_path: runtime.root, feature: runtime.feature.slug, kind: 'coordinator.interrupted', summary: `Interrupted active turn ${runtime.feature.active_turn_id}.`, details: {} });
  return { interrupted: true, threadId: runtime.feature.thread_id, turnId: runtime.feature.active_turn_id };
}

export async function resolveFeatureAgentRequest({ workspace_path, feature, request_id, action, response, scope = 'turn' }) {
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

export async function compactOutgoingAfterSwitch(switchResult, workspacePath) {
  if (!switchResult?.from?.slug || !switchResult.compactFeatureThreadId) return { attempted: false };
  const result = await compactFeatureAgent({ workspace_path: workspacePath, feature: switchResult.from.slug });
  return { attempted: true, ...result };
}

export function shutdownAgentRuntime() {
  return bridge.shutdown();
}
