import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkerBridge, finalVisibleMessage } from './app-server.mjs';
import { summarizePatch, TheaterError, parseJsonObject, requiredText, redactString } from './util.mjs';
import { withAgentControl, withLaneStop } from './ownership.mjs';
import {
  attestDescendantsStopped,
  bindAgentSession,
  clearWorkerGuards,
  featureRuntime,
  featureStatusInput,
  getFeatureContext,
  markCompacted,
  markDescendantsUnconfirmed,
  pendingAgentRequest,
  readUnconfirmedDescendants,
  readWorkerGuards,
  recordAgentEvent,
  registerWorkerGuard,
  releaseAgentSession,
  resolveAgentRequestRecord,
  saveAgentSession,
  savePendingAgentRequest,
  setStoppedFeatureStatus,
  queueCompaction,
} from './workspace.mjs';

// stopSettleMs bounds how long a pause or archive waits for an interrupted turn to be recorded as ended.
export function createAgentRuntime(bridge = new WorkerBridge(), { stopSettleMs = 15_000 } = {}) {
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
    process.stderr.write(`[overdrive] event handling failed: ${redactString(error.message)}\n`);
  });
  return next;
}

function register(threadId, workspacePath, feature) {
  for (const [registeredThreadId, registration] of registrations) {
    if (registration.workspacePath === workspacePath && registration.feature === feature) registrations.delete(registeredThreadId);
  }
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
      await markCompacted({ ...base, thread_id: threadId });
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

const descendantsSummary = turnId => `The worker process of turn ${turnId ?? 'unknown'} was stopped without its process tree, so tools it launched may still be running in the checkout. The lane cannot be paused or archived until the coordinator verifies that none is running.`;

async function onServerRequest(message) {
  const registration = registrations.get(message.params?.threadId);
  if (!registration) {
    try { bridge.respondToServer(message.id, undefined, 'OVERDRIVE cannot route this request to a registered feature.'); } catch { /* process may be exiting */ }
    return;
  }
  const payload = safePayload(message.params);
  const saved = await savePendingAgentRequest({
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
  if (saved.ignored) {
    try { bridge.respondToServer(message.id, undefined, 'This native session is no longer bound to its feature lane.'); } catch { /* process may be exiting */ }
  }
}

async function onNotification({ method, params }) {
  // Reasoning and raw response notifications are intentionally ignored. They are never state inputs.
  if (/reasoning|rawResponse/i.test(method)) return;
  const registration = registrations.get(params.threadId);
  if (!registration) return;
  const base = { workspace_path: registration.workspacePath, feature: registration.feature, owner_token: ownerToken };
  if (method === 'worker/exited') {
    await clearWorkerGuards({ ...base, guard_id: params.guardId });
    return;
  }
  if (method === 'serverRequest/resolved') {
    await resolveAgentRequestRecord({ ...base, thread_id: params.threadId, request_id: params.requestId, ignore_missing: true, summary: 'Codex app-server resolved the pending request.' });
    return;
  }
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
    // Recorded before the turn's end, so no reader sees the lane stopped without the marker.
    if (turn.descendantsUnconfirmed) await markDescendantsUnconfirmed({ ...base, thread_id: params.threadId, turn_id: turnId ?? null, summary: descendantsSummary(turnId) });
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
    if (plan) await recordAgentEvent({ ...base, thread_id: params.threadId, kind: 'agent.plan', summary: 'Agent updated its visible plan.', details: plan });
    if (diff) await recordAgentEvent({ ...base, thread_id: params.threadId, kind: 'agent.diff', summary: `Working diff touched ${diff.fileCount} file(s), +${diff.additions}/-${diff.deletions}.`, details: diff });
    const status = ['failed', 'interrupted'].includes(turn.status) ? turn.status : 'idle';
    const saved = await saveAgentSession({ ...base, thread_id: params.threadId, turn_id: null, status, summary: visible });
    turnMessages.delete(turnId);
    turnDiffs.delete(turnId);
    turnPlans.delete(turnId);
    compactionTurns.delete(turnId);
    if (saved.ignored) return;
    const runtime = await featureRuntime({ ...base, allow_inactive: true });
    if (!shuttingDown && runtime.feature.compaction_pending && status === 'idle') {
      setTimeout(() => { if (!shuttingDown) void compactFeatureAgent(base).catch(error => process.stderr.write(`[overdrive] deferred compaction: ${redactString(error.message)}\n`)); }, 0);
    }
  }
}

bridge.on('serverRequest', message => { void enqueueStateWork(() => onServerRequest(message)); });
bridge.on('notification', message => {
  void enqueueStateWork(() => onNotification(message));
});
bridge.on('exit', (error, threadIds = null) => {
  notificationQueue = notificationQueue.then(async () => {
  // A backend exit only affects the threads it owned; other harness lanes keep running.
  const affected = threadIds ? threadIds.filter(threadId => registrations.has(threadId)) : [...registrations.keys()];
  for (const [threadId, waiter] of compactionWaiters) {
    if (threadIds && !threadIds.includes(threadId)) continue;
    clearTimeout(waiter.timer);
    compactionWaiters.delete(threadId);
    waiter.reject(error);
  }
  for (const threadId of affected) {
    const registration = registrations.get(threadId);
    registrations.delete(threadId);
    const base = { workspace_path: registration.workspacePath, feature: registration.feature, owner_token: ownerToken };
    const runtime = await featureRuntime({ ...base, allow_inactive: true }).catch(() => null);
    const feature = runtime?.feature;
    // A turn that may outlive its backend connection (a known active turn or a request that may
    // have been delivered) stays uncertain with its turn ID; the native session settles it later.
    const mayBeLive = Boolean(feature?.active_turn_id || ['starting', 'uncertain'].includes(feature?.agent_status));
    const interrupted = mayBeLive || feature?.agent_status === 'waiting_for_user';
    const summary = mayBeLive
      ? `Worker bridge disconnected: ${redactString(error.message)} The turn may still be running; it is reconciled from the native session before more work starts.`
      : `Worker bridge disconnected: ${redactString(error.message)}`;
    await saveAgentSession({ ...base, thread_id: threadId, turn_id: mayBeLive ? feature.active_turn_id ?? null : null, status: mayBeLive ? 'uncertain' : interrupted ? 'disconnected' : 'idle', orphan_requests: interrupted, ...(interrupted ? { summary } : {}) }).catch(() => {});
  }
  if (!threadIds) {
    turnMessages.clear();
    turnPlans.clear();
    turnDiffs.clear();
    compactionTurns.clear();
  }
  }).catch(() => {});
});

function runtimeRoots(runtime) {
  return [runtime.feature.checkout_path, path.dirname(runtime.contextPath)];
}

function harnessParams(runtime) {
  return { harness: runtime.harness, model: runtime.workerModel, harnessOptions: runtime.harnessOptions };
}

// Callers validate the instruction before any native session or lane state changes.
function runPrompt(runtime, instruction) {
  const direction = instruction || runtime.feature.next_action || 'Choose and complete the highest-priority ready work.';
  return `Continue the ${runtime.feature.slug} feature lane.\n\nUser/coordinator direction:\n${direction}\n\nFirst load the feature context and spec named in your developer instructions, then inspect current Git state. Reconcile the request with the durable work graph. Work toward the smallest coherent verified result; do not silently broaden scope. Keep visible progress updates safe and concise. End with a handoff containing the exact resulting revision or dirty-state description, checks actually run and their outcomes, unresolved issues, and the next useful action. Do not include private chain-of-thought.`;
}

async function compactThreadAndWait(runtime) {
  const threadId = runtime.feature.thread_id;
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
    await Promise.all([bridge.request('thread/compact/start', { threadId, harness: runtime.harness }), completion]);
  } catch (error) {
    clearTimeout(timer);
    compactionWaiters.delete(threadId);
    throw error;
  }
}

// featureRuntime names the harness that owns the saved session; without one, the session
// predates recorded ownership and is never guessed onto the configured harness.
function requireSessionOwner(runtime) {
  if (runtime.harness) return;
  throw new TheaterError(`Native session ${runtime.feature.thread_id} of ${runtime.feature.slug} was saved before its backend was recorded, and its owner cannot be proven, so it was not sent to the configured harness. Start a replacement with theater_agent_start and force_new_session: true; the old conversation remains in its original backend.`, 'SESSION_OWNER_UNKNOWN');
}

function sessionParams(runtime) {
  return {
    ...harnessParams(runtime),
    threadId: runtime.feature.thread_id,
    cwd: runtime.feature.checkout_path,
    runtimeWorkspaceRoots: runtimeRoots(runtime),
    developerInstructions: runtime.developerInstructions,
  };
}

async function resume(runtime) {
  requireSessionOwner(runtime);
  const params = sessionParams(runtime);
  if (registrations.has(runtime.feature.thread_id)) return await bridge.updateThread?.(params);
  const response = await bridge.resumeThread(params);
  register(runtime.feature.thread_id, runtime.root, runtime.feature.slug);
  return response;
}

// Settles an 'uncertain' lane from its owning native session: a turn still in progress becomes
// the active turn, otherwise the lane is idle. History the backend cannot provide here (a Claude
// session loaded by a later controller) proves nothing, so the lane stays uncertain unless the
// coordinator attests, with the evidence it verified, that no worker from that request is
// running. runtime.feature follows the result.
async function settleUncertain(runtime, thread, attestation = null) {
  const unavailable = !thread || thread.history === 'unavailable';
  if (unavailable && !attestation) return;
  const running = unavailable ? null : thread.turns?.findLast(turn => turn.status === 'inProgress') ?? null;
  const base = { workspace_path: runtime.root, feature: runtime.feature.slug, thread_id: runtime.feature.thread_id, owner_token: ownerToken };
  const saved = await enqueueStateWork(() => saveAgentSession({ ...base, turn_id: running?.id ?? null, status: running ? 'running' : 'idle', only_if_status: 'uncertain' }));
  if (!saved.ignored) {
    await recordAgentEvent({ ...base, kind: 'agent.dispatch_reconciled', ...(unavailable
      ? { summary: `The coordinator attested that no worker from the unconfirmed turn request is running (native history unavailable): ${clip(attestation.evidence, 2_000)}`, details: { basis: 'coordinator_attestation', attestation } }
      : { summary: running ? `The unconfirmed turn request is running as turn ${running.id}.` : 'The unconfirmed turn request left no running turn; the lane is idle.', details: { basis: 'native_history' } }) });
  }
  const { agent } = saved.ignored ? (await getFeatureContext({ workspace_path: runtime.root, feature: runtime.feature.slug, timeline_limit: 1 })).feature : saved;
  Object.assign(runtime.feature, { agent_status: agent.status, active_turn_id: agent.activeTurnId });
}

function priorTurnAttestation(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TheaterError('prior_turn_attestation must be an object whose evidence states the process or backend facts you verified.', 'INVALID_INPUT');
  return { evidence: redactString(requiredText(value.evidence, 'prior_turn_attestation.evidence', { max: 4_000 })) };
}

const UNCERTAIN_NEXT = 'Inspect the lane. If you can verify under your existing authority that no worker from that request is still running for this lane (for example by checking the worker processes for its checkout), call theater_agent_start with prior_turn_attestation: { evidence } describing what you checked; it is recorded in the timeline. Until then no turn is dispatched.';

// A turn request without a confirmed outcome may have started a turn, so no new work is
// dispatched until the owning native session shows whether it did. This also holds after the
// controller that sent the request has died.
async function reconcileDispatch(runtime, attestation = null) {
  if (runtime.feature.agent_status !== 'uncertain') return;
  const owner = runtime.feature.thread_harness;
  let thread = null;
  let unreadable = null;
  try {
    // Resuming registers the session so an adopted running turn's events are recorded. A runtime
    // prepared for a replacement on another harness only attaches the owner's session to read it.
    if (runtime.harness === owner) await resume(runtime);
    else if (!registrations.has(runtime.feature.thread_id)) {
      const { harness: _configured, model: _model, harnessOptions: _options, ...session } = sessionParams(runtime);
      await bridge.attachThread?.({ ...session, harness: owner });
    }
    thread = (await bridge.request('thread/read', { harness: owner, threadId: runtime.feature.thread_id, includeTurns: true })).thread;
  } catch (error) {
    unreadable = redactString(error.message);
  }
  await settleUncertain(runtime, thread, attestation);
  if (runtime.feature.agent_status !== 'uncertain') return;
  const reason = unreadable ? `its native session could not be read (${unreadable})` : 'its native history is not available in this controller';
  throw new TheaterError(`The last turn request for ${runtime.feature.slug} has no confirmed outcome and ${reason}, so no new turn was started. ${UNCERTAIN_NEXT}`, 'DISPATCH_UNCERTAIN');
}

async function dispatchTurn(runtime, threadId, instruction, effort, created = false) {
  const base = { workspace_path: runtime.root, feature: runtime.feature.slug, thread_id: threadId, owner_token: ownerToken };
  const guardId = runtime.harness === 'claude' ? randomUUID() : null;
  const previous = runtime.feature;
  await enqueueStateWork(() => created
    ? bindAgentSession({ ...base, harness: runtime.harness, expected_thread_id: previous.thread_id ?? null, compacted: previous.compaction_pending })
    : saveAgentSession({ ...base, status: 'starting' }));
  try {
    if (guardId && (await registerWorkerGuard({ ...base, guard_id: guardId })).ignored) throw new TheaterError('The Claude worker guard could not be recorded for this session.', 'AGENT_OWNED');
    const result = await bridge.request('turn/start', {
      harness: runtime.harness, threadId, input: textInput(runPrompt(runtime, instruction)), cwd: runtime.feature.checkout_path,
      runtimeWorkspaceRoots: runtimeRoots(runtime), model: runtime.workerModel, effort, summary: 'concise', guardId,
    });
    if (result.treeStoppedGuardId) await clearWorkerGuards({ ...base, guard_id: result.treeStoppedGuardId });
    await enqueueStateWork(() => saveAgentSession({ ...base, turn_id: result.turn.id, status: 'running', only_if_status: 'starting' }));
    return result;
  } catch (error) {
    const summary = `Unable to start turn: ${redactString(error.message)}`;
    if (!error?.refused) {
      // The request may have reached the backend (a lost response, timeout or exit), so the turn
      // may be running. Keep the binding and any turn already reported; reconcileDispatch
      // decides from the native session before more work starts.
      await enqueueStateWork(async () => {
        await saveAgentSession({ ...base, status: 'uncertain', only_if_status: 'starting' });
        await recordAgentEvent({ ...base, kind: 'agent.dispatch_uncertain', summary: `${summary} The request may have reached the backend, so the session is reconciled before more work starts.` });
      });
      throw error;
    }
    await enqueueStateWork(async () => {
      // A replacement that never ran a turn is abandoned and the previous binding kept.
      if (created && !(await releaseAgentSession({
        ...base, previous_thread_id: previous.thread_id ?? null, previous_harness: previous.thread_harness ?? null, compaction_pending: previous.compaction_pending,
        summary: previous.thread_id ? `${summary} Kept native session ${previous.thread_id}.` : summary,
      })).ignored) return;
      await saveAgentSession({ ...base, status: 'failed', summary });
    });
    throw error;
  }
}

async function startOwned({ workspace_path, feature, effort = 'high', force_new_session = false, prior_turn_attestation = undefined }, direction) {
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new TheaterError('Unsupported reasoning effort.', 'INVALID_INPUT');
  const attestation = priorTurnAttestation(prior_turn_attestation);
  const runtime = await featureRuntime({ workspace_path, feature, force_new_session });
  if (!runtime.feature.spec_revision) throw new TheaterError('Save a concrete feature specification before starting its agent.', 'SPEC_REQUIRED');
  await reconcileDispatch(runtime, attestation);
  if (runtime.feature.active_turn_id) throw new TheaterError(`Feature already has active turn ${runtime.feature.active_turn_id}; steer it instead.`, 'TURN_ACTIVE');
  await bridge.ensureStarted();
  let threadId = runtime.feature.thread_id;
  let created = false;
  if (threadId && !force_new_session) {
    await resume(runtime);
    if (runtime.feature.compaction_pending) {
      await compactThreadAndWait(runtime);
    }
  } else {
    const started = await bridge.startThread({
      ...harnessParams(runtime),
      cwd: runtime.feature.checkout_path,
      runtimeWorkspaceRoots: runtimeRoots(runtime),
      developerInstructions: runtime.developerInstructions,
      effort,
    });
    threadId = started.thread.id;
    created = true;
    register(threadId, runtime.root, runtime.feature.slug);
    await bridge.request('thread/name/set', { harness: runtime.harness, threadId, name: `OVERDRIVE · ${runtime.feature.title}` }).catch(() => {});
  }
  const turn = await dispatchTurn(runtime, threadId, direction, effort, created);
  return {
    feature: runtime.feature.slug,
    threadId,
    turnId: turn.turn.id,
    createdSession: created,
    harness: runtime.harness,
    model: runtime.workerModel ?? 'harness-default',
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
  await reconcileDispatch(runtime);
  let result;
  let mode;
  if (runtime.feature.active_turn_id) {
    result = await bridge.request('turn/steer', {
      harness: runtime.harness,
      threadId: runtime.feature.thread_id,
      expectedTurnId: runtime.feature.active_turn_id,
      input: textInput(direction),
    });
    mode = 'mid_turn';
  } else {
    if (runtime.feature.compaction_pending) {
      await compactThreadAndWait(runtime);
    }
    result = await dispatchTurn(runtime, runtime.feature.thread_id, direction, effort);
    mode = 'new_turn';
  }
  await recordAgentEvent({ workspace_path: runtime.root, feature: runtime.feature.slug, kind: 'coordinator.steered', summary: `Coordinator ${mode === 'mid_turn' ? 'steered the active turn' : 'started a follow-up turn'}: ${redactString(clip(direction, 2_000))}`, details: { mode } });
  return { feature: runtime.feature.slug, threadId: runtime.feature.thread_id, turnId: result.turnId || result.turn?.id || runtime.feature.active_turn_id, harness: runtime.harness, mode };
}

function safeThreadView(thread) {
  const turns = (thread.turns || []).slice(-2).map(turn => ({
    id: turn.id,
    status: turn.status,
    visible: (turn.items || []).filter(item => item.type === 'agentMessage' || item.type === 'plan').map(item => item.type === 'agentMessage'
      ? { type: 'agentMessage', text: redactString(clip(item.text, 6_000)) }
      : { type: 'plan', text: redactString(clip(item.text, 6_000)) }),
  }));
  // 'native': the backend's own persisted history; 'controller': only turns run by this
  // controller; 'unavailable': session metadata only, so no turns are presented.
  const history = thread.history ?? 'native';
  const historyNote = {
    controller: 'Only turns run by this controller are shown; earlier turns are summarized by the feature summary and timeline.',
    unavailable: 'Earlier turns are not loaded in this controller; the feature summary and timeline hold the retained safe handoff.',
  }[history];
  return { id: thread.id, name: thread.name, cwd: thread.cwd, status: thread.status, updatedAt: thread.updatedAt, history, ...(historyNote ? { historyNote } : {}), turns: history === 'unavailable' ? null : turns };
}

async function inspectFeatureAgent({ workspace_path, feature, include_thread = true }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  let thread = null;
  let warning = null;
  if (include_thread && runtime.feature.thread_id && !runtime.harness) {
    warning = `Native session ${runtime.feature.thread_id} has no recorded owning backend, so it was not read. Replace it with theater_agent_start and force_new_session: true.`;
  } else if (include_thread && runtime.feature.thread_id) {
    try {
      await bridge.ensureStarted();
      // A fresh controller loads the session's metadata (no turn, no model call) so it can be read.
      if (!registrations.has(runtime.feature.thread_id)) await bridge.attachThread?.(sessionParams(runtime));
      const response = await bridge.request('thread/read', { harness: runtime.harness, threadId: runtime.feature.thread_id, includeTurns: true });
      thread = safeThreadView(response.thread);
      const active = response.thread.turns?.find(turn => turn.id === runtime.feature.active_turn_id);
      if (runtime.feature.agent_status === 'uncertain') {
        await settleUncertain(runtime, response.thread);
        if (runtime.feature.active_turn_id && !registrations.has(runtime.feature.thread_id)) await resume(runtime);
        if (runtime.feature.agent_status === 'uncertain') warning = response.thread.history === 'unavailable'
          ? `The last turn request has no confirmed outcome and this session's history is not available here. ${UNCERTAIN_NEXT}`
          : 'The last turn request has no confirmed outcome; the next agent command reconciles it from the native session before doing anything else.';
      } else if (active && ['completed', 'interrupted', 'failed'].includes(active.status)) {
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
  const result = await waitFeatureAgents({ workspace_path, features: [feature], timeout_seconds });
  return { timedOut: result.timedOut, ...result.handoffs[0] };
}

async function waitFeatureAgents({ workspace_path, features, timeout_seconds = 30 }) {
  if (!Number.isInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 60) throw new TheaterError('Wait duration must be 1–60 seconds.', 'INVALID_INPUT');
  if (!Array.isArray(features) || !features.length || features.length > 8 || features.some(feature => typeof feature !== 'string') || new Set(features).size !== features.length) throw new TheaterError('Supply 1–8 unique feature slugs.', 'INVALID_INPUT');
  const runtimes = await Promise.all(features.map(feature => featureRuntime({ workspace_path, feature, allow_inactive: true })));
  const signalled = new Set();
  let timer;
  let finish;
  const changed = new Promise(resolve => { finish = resolve; });
  const signalThread = threadId => {
    const runtime = runtimes.find(runtime => runtime.feature.thread_id && runtime.feature.thread_id === threadId);
    if (runtime) { signalled.add(runtime.feature.slug); finish(true); }
  };
  const notification = message => {
    if (['turn/completed', 'thread/status/changed'].includes(message.method)) signalThread(message.params?.threadId);
  };
  const request = message => signalThread(message.params?.threadId);
  bridge.on('notification', notification);
  bridge.on('serverRequest', request);
  timer = setTimeout(() => finish(false), timeout_seconds * 1000);
  try {
    await notificationQueue;
    const initial = await Promise.all(runtimes.map(runtime => getFeatureContext({ workspace_path, feature: runtime.feature.slug, timeline_limit: 1 })));
    for (const state of initial) {
      if (!state.feature.agent.activeTurnId || state.pendingAgentRequests.length) signalled.add(state.feature.slug);
    }
    const signal = signalled.size ? true : await changed;
    await notificationQueue;
    const selected = signal ? [...signalled] : runtimes.map(runtime => runtime.feature.slug);
    const handoffs = await Promise.all(selected.map(async feature => {
      const state = await inspectFeatureAgent({ workspace_path, feature, include_thread: true });
      return { feature: state.feature, git: state.git, liveProgress: state.liveProgress, pendingAgentRequests: state.pendingAgentRequests, warning: state.warning };
    }));
    return { timedOut: !signal, handoffs, nextAction: 'Reconcile completed or decision-ready handoffs now, advance authorized next actions, and wait only on remaining unreconciled work. This wait does not wake an ended coordinator turn.' };
  } finally {
    clearTimeout(timer);
    bridge.off('notification', notification);
    bridge.off('serverRequest', request);
  }
}

async function compactOwned({ workspace_path, feature }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  if (!runtime.feature.thread_id) return { compacted: false, reason: 'No feature task exists yet.' };
  requireSessionOwner(runtime);
  await reconcileDispatch(runtime);
  await queueCompaction({ workspace_path, feature, owner_token: ownerToken });
  if (runtime.feature.active_turn_id) return { compacted: false, queued: true, reason: `Turn ${runtime.feature.active_turn_id} is active; compaction will run when it finishes.` };
  await bridge.ensureStarted();
  await resume(runtime);
  await enqueueStateWork(() => saveAgentSession({ workspace_path, feature, thread_id: runtime.feature.thread_id, owner_token: ownerToken, status: 'compacting' }));
  try {
    await compactThreadAndWait(runtime);
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
  await reconcileDispatch(runtime);
  if (!runtime.feature.thread_id || !runtime.feature.active_turn_id) return { interrupted: false, reason: 'No active turn.' };
  requireSessionOwner(runtime);
  await bridge.ensureStarted();
  await resume(runtime);
  const result = await bridge.request('turn/interrupt', { harness: runtime.harness, threadId: runtime.feature.thread_id, turnId: runtime.feature.active_turn_id });
  // A backend that reports nothing to interrupt (the turn ended first) is taken at its word.
  if (result?.interrupted === false) return { interrupted: false, threadId: runtime.feature.thread_id, turnId: runtime.feature.active_turn_id, harness: runtime.harness, reason: 'The turn had already ended; its completion is recorded from the native session.' };
  await recordAgentEvent({ workspace_path: runtime.root, feature: runtime.feature.slug, kind: 'coordinator.interrupted', summary: `Interrupted active turn ${runtime.feature.active_turn_id}.`, details: {} });
  return { interrupted: true, threadId: runtime.feature.thread_id, turnId: runtime.feature.active_turn_id, harness: runtime.harness };
}

// Resolves true once the backend reports a completed turn on threadId, or false at the deadline.
// It listens from creation, so a completion that races the interrupt response is not missed.
function turnCompletion(threadId) {
  let finish;
  let timer;
  const completed = new Promise(resolve => { finish = resolve; });
  const listener = message => { if (message.method === 'turn/completed' && message.params?.threadId === threadId) finish(true); };
  bridge.on('notification', listener);
  return {
    wait: timeoutMs => { timer = setTimeout(() => finish(false), timeoutMs); return completed; },
    dispose: () => { clearTimeout(timer); bridge.off('notification', listener); },
  };
}

// The lane as recorded once every notification received so far has been applied.
async function recordedLane(runtime) {
  await notificationQueue;
  return (await featureRuntime({ workspace_path: runtime.root, feature: runtime.feature.slug, allow_inactive: true })).feature;
}

// Settles an interrupted turn whose completion was not delivered from the native session's own
// record of it. Returns false when the session cannot show that the turn has ended.
async function settleEndedTurn(runtime, turnId) {
  let turn;
  try {
    const { thread } = await bridge.request('thread/read', { harness: runtime.harness, threadId: runtime.feature.thread_id, includeTurns: true });
    turn = thread.history === 'unavailable' ? null : thread.turns?.find(candidate => candidate.id === turnId);
  } catch { return false; }
  if (!turn || !['completed', 'interrupted', 'failed'].includes(turn.status)) return false;
  const base = { workspace_path: runtime.root, feature: runtime.feature.slug, thread_id: runtime.feature.thread_id, owner_token: ownerToken };
  await enqueueStateWork(async () => {
    if (turn.descendantsUnconfirmed) await markDescendantsUnconfirmed({ ...base, turn_id: turnId, summary: descendantsSummary(turnId) });
    await saveAgentSession({ ...base, status: turn.status === 'completed' ? 'idle' : turn.status });
  });
  return true;
}

// Records why a pause or archive could not show that the lane's worker stopped and returns the
// STOP_UNCONFIRMED error to throw; the lifecycle status is left as it was. The refusal is recorded
// even when another controller owns the lane.
async function stopUnconfirmed({ workspace_path, feature, lifecycle }, status, reason, details = {}) {
  const message = `${feature} was not marked ${status} because its worker may still be running: ${reason} The lane stays ${lifecycle}.`;
  await recordAgentEvent({ workspace_path, feature, kind: 'feature.stop_unconfirmed', summary: message, details: { requestedStatus: status, ...details } });
  return new TheaterError(message, 'STOP_UNCONFIRMED', details);
}

const ATTEST_NEXT = 'If you can verify under your existing authority that no worker process for this lane is running (for example by checking the processes whose working directory is its checkout), retry with prior_turn_attestation: { evidence } describing what you checked; it is recorded in the timeline.';

// Stops the active turn of a lane that is being paused or archived. Every path that cannot show
// the turn has ended throws STOP_UNCONFIRMED.
async function stopWorker(runtime, status, attestation) {
  const { slug } = runtime.feature;
  const base = { workspace_path: runtime.root, feature: slug, owner_token: ownerToken };
  const unconfirmed = (reason, details) => stopUnconfirmed({ workspace_path: runtime.root, feature: slug, lifecycle: runtime.feature.status }, status, reason, details);
  try {
    await reconcileDispatch(runtime, attestation);
  } catch (error) {
    if (error.code !== 'DISPATCH_UNCERTAIN') throw error;
    throw await unconfirmed(`its last turn request has no confirmed outcome and its native session cannot settle it. ${ATTEST_NEXT}`, { agentStatus: 'uncertain' });
  }
  const turnId = runtime.feature.active_turn_id;
  if (!turnId) return { interrupted: false, reason: 'No active turn.' };
  requireSessionOwner(runtime);
  const threadId = runtime.feature.thread_id;
  const completion = turnCompletion(threadId);
  try {
    let result;
    try {
      await bridge.ensureStarted();
      await resume(runtime);
      result = await bridge.request('turn/interrupt', { harness: runtime.harness, threadId, turnId });
    } catch (error) {
      throw await unconfirmed(`interrupting turn ${turnId} failed (${redactString(error.message)}). Inspect the lane and retry once its turn has ended.`, { turnId, interruptError: error.code ?? null });
    }
    const interrupted = result?.interrupted !== false;
    if (interrupted) await recordAgentEvent({ ...base, kind: 'coordinator.interrupted', summary: `Interrupted active turn ${turnId}.`, details: {} });
    // The worker ended but its process tree could not be: the marker makes the stop unconfirmed.
    if (result?.descendantsUnconfirmed) await enqueueStateWork(() => markDescendantsUnconfirmed({ ...base, thread_id: threadId, turn_id: turnId, summary: descendantsSummary(turnId) }));
    let lane = await recordedLane(runtime);
    // A backend that reports nothing to interrupt has already ended the turn, so only its
    // recorded end is awaited; an acknowledged interrupt gets a bounded wait for the turn to end.
    if (lane.active_turn_id === turnId && interrupted && await completion.wait(stopSettleMs)) lane = await recordedLane(runtime);
    if (lane.active_turn_id === turnId && !(await settleEndedTurn(runtime, turnId))) {
      throw await unconfirmed(`${interrupted
        ? `turn ${turnId} acknowledged the interrupt but was not recorded as ended within ${Math.round(stopSettleMs / 1000)}s.`
        : `the backend reported nothing to interrupt, yet turn ${turnId} is not recorded as ended.`} Inspect the lane and retry once its turn has ended.`, { turnId, interruptAcknowledged: interrupted });
    }
    return { interrupted, threadId, turnId, harness: runtime.harness, treeStoppedGuardId: result?.treeStoppedGuardId ?? null, ...(result?.descendantsUnconfirmed ? { descendantsUnconfirmed: true } : {}) };
  } finally { completion.dispose(); }
}

async function stopForStatus({ prior_turn_attestation = undefined, ...args }, row, busy, foreignOwner) {
  // Validate the transition before stopping anything, so a refused transition never interrupts
  // work. Archiving an archived lane stays a no-op transition, as it always was.
  if (!(row.status === 'archived' && args.status === 'archived')) featureStatusInput(args);
  const attestation = priorTurnAttestation(prior_turn_attestation);
  const lane = { workspace_path: args.workspace_path, feature: row.slug, lifecycle: row.status };
  // An attestation can only speak for processes that could be checked before it was given, so it
  // clears only the marker generation that already existed, never one this stop records.
  const priorGeneration = (await readUnconfirmedDescendants(args))?.generation ?? null;
  // Another live controller may hold a worker process for this session that this one cannot see.
  if (foreignOwner && !attestation) {
    throw await stopUnconfirmed(lane, args.status, `its session belongs to another live coordinator session (process ${foreignOwner.pid}), which may still hold a worker process this session cannot see. Pause it from that session. ${ATTEST_NEXT}`, { foreignOwnerPid: foreignOwner.pid });
  }
  let interruption;
  if (busy) {
    const runtime = await featureRuntime({ workspace_path: args.workspace_path, feature: args.feature, allow_inactive: true });
    interruption = await stopWorker(runtime, args.status, attestation);
    if (interruption.treeStoppedGuardId) await clearWorkerGuards({ ...args, guard_id: interruption.treeStoppedGuardId });
  }
  // A worker process that outlived its turn, such as one an earlier interrupt could not stop, is
  // still running work, so the lane is not stopped until the backend holding it sees it exit.
  if (row.thread_id) {
    try {
      const settled = await bridge.settleThread?.({ threadId: row.thread_id });
      if (settled?.treeStoppedGuardId) await clearWorkerGuards({ ...args, guard_id: settled.treeStoppedGuardId });
    }
    catch (error) {
      if (error.code === 'CLAUDE_DESCENDANTS_UNCONFIRMED') {
        const recorded = await enqueueStateWork(() => markDescendantsUnconfirmed({ workspace_path: args.workspace_path, feature: row.slug, thread_id: row.thread_id, turn_id: error.details?.turnId ?? null, summary: redactString(error.message) }));
        if (!recorded.ignored) bridge.acknowledgeDescendants?.({ threadId: row.thread_id, turnId: error.details?.turnId });
      }
      throw await stopUnconfirmed(lane, args.status, `a worker process from an earlier turn ${error.code === 'CLAUDE_DESCENDANTS_UNCONFIRMED' ? 'left tools that may still be running' : 'is still running'} (${redactString(error.message)}).`, { lingeringProcess: true });
    }
  }
  const marker = await readUnconfirmedDescendants(args);
  // A stop that itself left descendants unconfirmed is refused whatever attestation it carries.
  const attestable = attestation && !interruption?.descendantsUnconfirmed && marker?.generation === priorGeneration;
  if (marker && !(attestable && (await attestDescendantsStopped({ ...args, evidence: attestation.evidence, generation: marker.generation })).cleared)) {
    throw await stopUnconfirmed(lane, args.status, `${marker.summary} ${ATTEST_NEXT}`, { descendantsUnconfirmed: true, turnId: marker.turnId ?? null });
  }
  const guards = await readWorkerGuards(args);
  if (guards.length) {
    if (!attestation || interruption?.descendantsUnconfirmed) throw await stopUnconfirmed(lane, args.status, `a Claude worker process from this lane has no confirmed process-tree exit. ${ATTEST_NEXT}`, { workerGuards: guards.length });
    await clearWorkerGuards({ ...args, evidence: attestation.evidence });
  }
  const result = await setStoppedFeatureStatus(args);
  return interruption ? { ...result, interruption } : result;
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
  await resolveAgentRequestRecord({ workspace_path, feature, request_id, owner_token: ownerToken, thread_id: request.thread_id, ignore_missing: true, summary: `Resolved ${request.method} with ${action}.` });
  return { resolved: true, requestId: String(request_id), action, feature };
}

async function compactOutgoingAfterSwitch(switchResult, workspacePath) {
  if (!switchResult?.from?.slug || !switchResult.compactFeatureThreadId) return { attempted: false };
  const result = await compactFeatureAgent({ workspace_path: workspacePath, feature: switchResult.from.slug });
  return { attempted: true, ...result };
}

// Resolves after the bridge has shut down, with the worker processes it could not stop.
async function shutdownAgentRuntime() {
  shuttingDown = true;
  await notificationQueue;
  const stopped = await bridge.shutdown();
  await notificationQueue;
  return { unstopped: stopped?.unstopped ?? [] };
}

// An omitted instruction falls back to the checkpoint next action; a supplied one, even an empty
// string, must be valid before the lane's control lock or native session is touched.
const startFeatureAgent = async args => {
  const direction = args.instruction === undefined || args.instruction === null ? undefined : requiredText(args.instruction, 'instruction', { max: 100_000 });
  return await withAgentControl(args, ownerToken, () => startOwned(args, direction));
};
const steerFeatureAgent = args => withAgentControl(args, ownerToken, () => steerOwned(args));
const compactFeatureAgent = args => withAgentControl(args, ownerToken, () => compactOwned(args));
const interruptFeatureAgent = args => withAgentControl(args, ownerToken, () => interruptOwned(args));
const resolveFeatureAgentRequest = args => withAgentControl(args, ownerToken, () => resolveRequestOwned(args));
// Pausing or archiving holds the lane's control lock from stopping its worker through recording
// the status, so no turn can start in between and the status is written only after the stop.
const stopFeatureLane = async args => {
  if (!['paused', 'archived'].includes(args.status)) throw new TheaterError('Only pausing or archiving stops a lane.', 'INVALID_INPUT');
  return await withLaneStop(args, ownerToken, (row, busy, foreignOwner) => stopForStatus(args, row, busy, foreignOwner));
};
return { startFeatureAgent, steerFeatureAgent, inspectFeatureAgent, waitFeatureAgent, waitFeatureAgents, compactFeatureAgent, interruptFeatureAgent, resolveFeatureAgentRequest, stopFeatureLane, compactOutgoingAfterSwitch, shutdownAgentRuntime };
}

export const { startFeatureAgent, steerFeatureAgent, inspectFeatureAgent, waitFeatureAgent, waitFeatureAgents, compactFeatureAgent, interruptFeatureAgent, resolveFeatureAgentRequest, stopFeatureLane, compactOutgoingAfterSwitch, shutdownAgentRuntime } = createAgentRuntime();
