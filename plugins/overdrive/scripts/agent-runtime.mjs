import { randomUUID } from 'node:crypto';
import { WorkerBridge, finalVisibleMessage, turnFailureMessage } from './app-server.mjs';
import { denialNote, workerServer } from './worker-policy.mjs';
import { summarizePatch, OverdriveError, parseJsonObject, refusedRequest, requiredText, redactString, resolveWorkspace } from './util.mjs';
import { adoptAgentObservation, agentBusy, withAgentControl, withLaneStop } from './ownership.mjs';
import { workerJobState } from './process-tree.mjs';
import {
  agentInbox,
  attestDescendantsStopped,
  bindAgentSession,
  clearWorkerGuards,
  deliverableAgents,
  featureRuntime,
  featureUpdateInput,
  getFeatureContext,
  markDelivered,
  markDescendantsUnconfirmed,
  openCoordinatorInbox,
  pendingAgentRequest,
  readUnconfirmedDescendants,
  readWorkerGuards,
  recordAgentEvent,
  recordWorkerGuardJob,
  registerWorkerGuard,
  releaseAgentSession,
  resolveAgentRequestRecord,
  saveAgentSession,
  savePendingAgentRequest,
  sendAgentMessage,
  takeCoordinatorMessages,
  updateStoppedFeature,
} from './workspace.mjs';

// After a failed delivery an agent's messages wait this long before the next attempt.
const DELIVERY_RETRY_MS = 60_000;
// Where a steer cannot reach the agent now, the message waits in its inbox instead.
const QUEUED_WHEN = new Set(['INVALID_TRANSITION', 'DISPATCH_UNCERTAIN', 'AGENT_OWNED', 'TURN_MISMATCH']);

// Tool items whose running call is shown, with the label each gets; their results are never read.
const TOOL_LABELS = new Map([
  ['commandExecution', item => item.command],
  ['mcpToolCall', item => `${item.server}.${item.tool}`],
  ['dynamicToolCall', item => item.tool],
  ['toolCall', item => [item.tool, item.summary].filter(Boolean).join(': ')],
]);
const toolLabel = item => redactString(String(TOOL_LABELS.get(item.type)(item) ?? '')).replace(/\s+/g, ' ').slice(0, 120);

const messageText = message => `Message from ${message.from_agent} (${message.created_at}):\n${message.body}`;
const messageBlock = messages => messages.map(messageText).join('\n\n');
const reportDeliveryFailure = error => process.stderr.write(`[overdrive] message delivery failed: ${redactString(error.message)}\n`);

// stopSettleMs bounds how long a pause or archive waits for an interrupted turn to be recorded as
// ended; deliveryIntervalMs is the period of the message delivery sweep.
export function createAgentRuntime(bridge = new WorkerBridge(), { stopSettleMs = 15_000, deliveryIntervalMs = 2_000 } = {}) {
const ownerToken = randomUUID();
const registrations = new Map();
const turnMessages = new Map();
const turnDiffs = new Map();
const turnPlans = new Map();
// Per turn, the tool calls started and not yet returned, in memory only.
const turnTools = new Map();
const completedTurns = new Set();
const deliveryRetry = new Map();
let notificationQueue = Promise.resolve();
let sweepTimer = null;
let sweeping = null;
let closed = false;

function enqueueStateWork(work) {
  const next = notificationQueue.then(work);
  notificationQueue = next.catch(error => {
    process.stderr.write(`[overdrive] event handling failed: ${redactString(error.message)}\n`);
  });
  return next;
}

function register(threadId, workspacePath, feature, handoffPending = null) {
  for (const [registeredThreadId, registration] of registrations) {
    if (registration.workspacePath === workspacePath && registration.feature === feature) registrations.delete(registeredThreadId);
  }
  registrations.set(threadId, { workspacePath, feature, handoffPending });
  scheduleSweep();
}

const runningTools = turnId => [...(turnTools.get(turnId)?.values() ?? [])].map(({ tool, startedAt }) => ({ tool, runningSeconds: Math.round((Date.now() - startedAt) / 1000) }));

function textInput(text) {
  return [{ type: 'text', text, text_elements: [] }];
}

function clip(value, max = 100_000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

// Keeps the newest text of a message that is still being written.
function clipTail(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `[earlier output omitted]\n${text.slice(-max)}`;
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

// Redacted before clipping and bounded below the stored summary limit; a failure reason leads, so
// clipping a long visible message never drops it.
function turnHandoff(turn, streamed = '') {
  const reason = turnFailureMessage(turn);
  const handoff = [
    reason && `Agent turn failed: ${clip(redactString(reason), 2_000)}`,
    finalVisibleMessage(turn) || streamed,
  ].filter(Boolean).join('\n') || `Agent turn ${turn.status || 'completed'}.`;
  return clip(redactString(turn.denials?.length ? `${handoff}\n${denialNote(turn.denials)}` : handoff), 99_000);
}

const descendantsSummary = turnId => `The worker process of turn ${turnId ?? 'unknown'} was stopped without its process tree, so tools it launched may still be running in the checkout. The lane cannot be paused or archived until the coordinator verifies that none is running.`;

async function onServerRequest(message) {
  const registration = registrations.get(message.params?.threadId);
  if (!registration) {
    try { bridge.respondToServer(message.id, undefined, 'OVERDRIVE cannot route this request to a registered feature.', message.params?.threadId); } catch { /* process may be exiting */ }
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
    try { bridge.respondToServer(message.id, undefined, 'This native session is no longer bound to its feature lane.', message.params.threadId); } catch { /* process may be exiting */ }
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
  if (method === 'worker/contained') {
    await recordWorkerGuardJob({ ...base, thread_id: params.threadId, guard_id: params.guardId, job: params.job });
    return;
  }
  if (method === 'serverRequest/resolved') {
    await resolveAgentRequestRecord({ ...base, thread_id: params.threadId, request_id: params.requestId, ignore_missing: true, summary: 'Codex app-server resolved the pending request.' });
    return;
  }
  if (method === 'item/agentMessage/delta') {
    const key = params.turnId;
    // Redacted before clipping, so a cut can never split a secret out of its pattern.
    turnMessages.set(key, clipTail(redactString((turnMessages.get(key) || '') + (params.delta || '')), 20_000));
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
  if ((method === 'item/started' || method === 'item/completed') && TOOL_LABELS.has(params.item?.type)) {
    if (method === 'item/started') turnTools.set(params.turnId, (turnTools.get(params.turnId) ?? new Map()).set(params.item.id, { tool: toolLabel(params.item), startedAt: params.startedAtMs ?? Date.now() }));
    else turnTools.get(params.turnId)?.delete(params.item.id);
    return;
  }
  if (method === 'turn/started') {
    registration.handoffPending = params.turn?.id ?? true;
    await saveAgentSession({ ...base, thread_id: params.threadId, turn_id: params.turn?.id, status: 'running' });
    return;
  }
  if (method === 'turn/completed') {
    const turn = params.turn || {};
    const turnId = turn.id;
    const completionKey = `${params.threadId}:${turnId}`;
    if (turnId && completedTurns.has(completionKey)) return;
    // Recorded before the turn's end, so no reader sees the lane stopped without the marker.
    if (turn.descendantsUnconfirmed) await markDescendantsUnconfirmed({ ...base, thread_id: params.threadId, turn_id: turnId ?? null, summary: descendantsSummary(turnId) });
    const visible = turnHandoff(turn, turnMessages.get(turnId));
    const diff = turnDiffs.get(turnId);
    const plan = turnPlans.get(turnId);
    if (plan) await recordAgentEvent({ ...base, thread_id: params.threadId, kind: 'agent.plan', summary: 'Agent updated its visible plan.', details: plan });
    if (diff) await recordAgentEvent({ ...base, thread_id: params.threadId, kind: 'agent.diff', summary: `Working diff touched ${diff.fileCount} file(s), +${diff.additions}/-${diff.deletions}.`, details: diff });
    const status = ['failed', 'interrupted'].includes(turn.status) ? turn.status : 'idle';
    const saved = await saveAgentSession({ ...base, thread_id: params.threadId, turn_id: null, status, summary: visible });
    turnMessages.delete(turnId);
    turnDiffs.delete(turnId);
    turnPlans.delete(turnId);
    turnTools.delete(turnId);
    if (!saved.ignored && turnId) {
      completedTurns.add(completionKey);
      if (completedTurns.size > 256) completedTurns.delete(completedTurns.values().next().value);
    }
    scheduleSweep(0);
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
  for (const threadId of affected) {
    const registration = registrations.get(threadId);
    registrations.delete(threadId);
    const base = { workspace_path: registration.workspacePath, feature: registration.feature, owner_token: ownerToken };
    const runtime = await featureRuntime({ ...base, allow_inactive: true }).catch(() => null);
    const feature = runtime?.feature;
    turnTools.delete(feature?.active_turn_id);
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
    turnTools.clear();
  }
  }).catch(() => {});
});

// The capability profile always comes from the lane's recorded kind, never from a tool argument.
function harnessParams(runtime) {
  return { harness: runtime.harness, profile: runtime.profile, model: runtime.workerModel, harnessOptions: runtime.harnessOptions };
}

// Callers validate the instruction before any native session or lane state changes. Without an
// instruction or messages, the lane's next action directs the turn.
function runPrompt(runtime, instruction, messages) {
  const { slug } = runtime.feature;
  const direction = instruction || (messages.length ? null : runtime.feature.next_action || (runtime.profile === 'qa' ? 'Carry out your brief.' : 'Complete your spec.'));
  return [
    runtime.profile === 'qa' ? `Continue as the ${slug} QA agent.` : `Continue the ${slug} feature lane.`,
    messages.length ? `Messages for you:\n\n${messageBlock(messages)}` : null,
    direction ? `User/coordinator direction:\n${direction}` : null,
    'First load the context and spec named in your developer instructions, then inspect current Git state.',
  ].filter(Boolean).join('\n\n');
}

// featureRuntime names the harness that owns the saved session; without one, the session
// predates recorded ownership and is never guessed onto the configured harness.
function requireSessionOwner(runtime) {
  if (runtime.harness) return;
  throw new OverdriveError(`Native session ${runtime.feature.thread_id} of ${runtime.feature.slug} was saved before its backend was recorded, and its owner cannot be proven, so it was not sent to the configured harness. Start a replacement with agent_start and force_new_session: true; the old conversation remains in its original backend.`, 'SESSION_OWNER_UNKNOWN');
}

function sessionParams(runtime) {
  return {
    ...harnessParams(runtime),
    threadId: runtime.feature.thread_id,
    cwd: runtime.cwd,
    runtimeWorkspaceRoots: runtime.roots,
    developerInstructions: runtime.developerInstructions,
    workerServer: workerServer(runtime.root, runtime.feature.slug),
  };
}

async function resume(runtime) {
  requireSessionOwner(runtime);
  const params = sessionParams(runtime);
  if (registrations.has(runtime.feature.thread_id)) return await bridge.updateThread?.(params);
  const response = await bridge.resumeThread(params);
  // A turn adopted while it may be running awaits hand-off like one this controller started.
  register(runtime.feature.thread_id, runtime.root, runtime.feature.slug, agentBusy(runtime.feature) ? runtime.feature.active_turn_id ?? true : null);
  return response;
}

async function prepareCodexObservation(runtime) {
  if (runtime.harness !== 'codex' || !runtime.feature.thread_id ||
      (!runtime.feature.active_turn_id && runtime.feature.agent_status !== 'uncertain')) return false;
  if (!(await adoptAgentObservation({ workspace_path: runtime.root, feature: runtime.feature.slug }, ownerToken))) return false;
  await resume(runtime);
  return true;
}

async function reconcileCompletedNativeTurn(runtime, thread) {
  const turn = thread.turns?.find(candidate => candidate.id === runtime.feature.active_turn_id);
  if (!turn || !['completed', 'interrupted', 'failed'].includes(turn.status) ||
      !registrations.has(runtime.feature.thread_id)) return;
  await enqueueStateWork(async () => {
    const current = await getFeatureContext({ workspace_path: runtime.root, feature: runtime.feature.slug, timeline_limit: 1 });
    if (current.feature.agent.threadId !== thread.id || current.feature.agent.activeTurnId !== turn.id) return;
    await onNotification({ method: 'turn/completed', params: { threadId: thread.id, turn } });
  });
  const current = await getFeatureContext({ workspace_path: runtime.root, feature: runtime.feature.slug, timeline_limit: 1 });
  Object.assign(runtime.feature, { agent_status: current.feature.agent.status, active_turn_id: current.feature.agent.activeTurnId });
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
  if (typeof value !== 'object' || Array.isArray(value)) throw new OverdriveError('prior_turn_attestation must be an object whose evidence states the process or backend facts you verified.', 'INVALID_INPUT');
  return { evidence: redactString(requiredText(value.evidence, 'prior_turn_attestation.evidence', { max: 4_000 })) };
}

const ATTEST_NEXT = 'If you verify under your existing authority that no worker or tool process for this lane is running (for example by checking the processes whose working directory is its checkout), pass prior_turn_attestation: { evidence } describing what you checked to agent_start, or to feature_update when pausing or archiving; it is recorded in the timeline.';

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
    thread = (await bridge.request('thread/read', { harness: owner, profile: runtime.profile, threadId: runtime.feature.thread_id, includeTurns: true })).thread;
  } catch (error) {
    unreadable = redactString(error.message);
  }
  await settleUncertain(runtime, thread, attestation);
  if (runtime.feature.agent_status !== 'uncertain') return;
  const reason = unreadable ? `its native session could not be read (${unreadable})` : 'its native history is not available in this controller';
  throw new OverdriveError(`The last turn request for ${runtime.feature.slug} has no confirmed outcome and ${reason}, so no new turn was started. ${ATTEST_NEXT}`, 'DISPATCH_UNCERTAIN');
}

// Clears durable worker guards whose containment job no longer exists or holds no process: once
// its last handle has closed, the kernel has ended every process launched under it. Guards
// without a job stay.
async function recoverWorkerGuards(args) {
  for (const guard of await readWorkerGuards(args)) {
    if (guard.job && ['absent', 'empty'].includes(await workerJobState(guard.job))) await clearWorkerGuards({ ...args, guard_id: guard.id, job_gone: true });
  }
}

// Waits for or stops a worker process that an ended turn of this bridge left running. Tools it may
// have left behind are recorded as unconfirmed descendants before the error is rethrown.
async function settleLingeringWorker(base, threadId) {
  try {
    const settled = await bridge.settleThread?.({ threadId });
    if (settled?.treeStoppedGuardId) await clearWorkerGuards({ ...base, guard_id: settled.treeStoppedGuardId });
  } catch (error) {
    if (error.code === 'CLAUDE_DESCENDANTS_UNCONFIRMED') {
      const recorded = await enqueueStateWork(() => markDescendantsUnconfirmed({ ...base, thread_id: threadId, turn_id: error.details?.turnId ?? null, summary: redactString(error.message) }));
      if (!recorded.ignored) bridge.acknowledgeDescendants?.({ threadId, turnId: error.details?.turnId });
    }
    throw error;
  }
}

// Before a new turn, settle trees this bridge holds and clear only guards whose jobs ended.
// An attestation covers only prior records and never a job that still exists.
async function assertWorkersSettled(runtime, attestation) {
  const args = { workspace_path: runtime.root, feature: runtime.feature.slug };
  const priorGeneration = (await readUnconfirmedDescendants(args))?.generation ?? null;
  const priorGuards = new Set((await readWorkerGuards(args)).map(guard => guard.id));
  if (runtime.feature.thread_id) {
    try { await settleLingeringWorker({ ...args, owner_token: ownerToken }, runtime.feature.thread_id); }
    catch (error) { if (error.code !== 'CLAUDE_DESCENDANTS_UNCONFIRMED') throw error; }
  }
  // Clean-exit reports the settlement produced are applied first.
  await notificationQueue;
  await recoverWorkerGuards(args);
  let marker = await readUnconfirmedDescendants(args);
  if (marker && attestation && marker.generation === priorGeneration && (await attestDescendantsStopped({ ...args, evidence: attestation.evidence, generation: marker.generation })).cleared) marker = null;
  let guards = await readWorkerGuards(args);
  if (guards.length && attestation) {
    for (const guard of guards) {
      if (priorGuards.has(guard.id) && !(guard.job && (await workerJobState(guard.job)) === 'present')) await clearWorkerGuards({ ...args, guard_id: guard.id, evidence: attestation.evidence });
    }
    guards = await readWorkerGuards(args);
  }
  if (!marker && !guards.length) return;
  const reason = marker ? marker.summary : `${guards.length} worker process tree(s) from earlier turns of this lane have no confirmed exit, so tools they launched may still be running.`;
  throw new OverdriveError(`No turn was started for ${runtime.feature.slug}: ${reason} Wait for them to stop, or pause the lane, which stops a process tree this controller holds. ${ATTEST_NEXT}`, 'WORKERS_UNCONFIRMED', { workerGuards: guards.length, descendantsUnconfirmed: Boolean(marker) });
}

// Messages waiting for the agent open the turn's prompt and are marked delivered once it started;
// otherwise they stay pending. Callers hold the agent's control lock.
async function dispatchTurn(runtime, threadId, instruction, effort, created = false) {
  const base = { workspace_path: runtime.root, feature: runtime.feature.slug, thread_id: threadId, owner_token: ownerToken };
  const guardId = runtime.harness === 'claude' ? randomUUID() : null;
  const previous = runtime.feature;
  await enqueueStateWork(() => created
    ? bindAgentSession({ ...base, harness: runtime.harness, expected_thread_id: previous.thread_id ?? null })
    : saveAgentSession({ ...base, status: 'starting' }));
  const inbox = { workspace_path: runtime.root, feature: runtime.feature.slug };
  try {
    if (guardId && (await registerWorkerGuard({ ...base, guard_id: guardId })).ignored) throw new OverdriveError('The Claude worker guard could not be recorded for this session.', 'AGENT_OWNED');
    // Nothing has reached the backend yet, so a failed read leaves no turn to reconcile.
    const messages = await agentInbox(inbox).catch(error => { throw refusedRequest(error); });
    const result = await bridge.request('turn/start', {
      harness: runtime.harness, profile: runtime.profile, threadId, input: textInput(runPrompt(runtime, instruction, messages)), cwd: runtime.cwd,
      runtimeWorkspaceRoots: runtime.roots, model: runtime.workerModel, effort, summary: 'concise', guardId,
    });
    await markDelivered({ ...inbox, messages, how: 'prompt' }).catch(reportDeliveryFailure);
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
    // A refused request launched no worker, so its own guard is released; earlier ones stay.
    if (guardId) await clearWorkerGuards({ ...base, guard_id: guardId, unused: true });
    await enqueueStateWork(async () => {
      // A replacement that never ran a turn is abandoned and the previous binding kept.
      if (created && !(await releaseAgentSession({
        ...base, previous_thread_id: previous.thread_id ?? null, previous_harness: previous.thread_harness ?? null,
        summary: previous.thread_id ? `${summary} Kept native session ${previous.thread_id}.` : summary,
      })).ignored) return;
      await saveAgentSession({ ...base, status: 'failed', summary });
    });
    throw error;
  }
}

// prepared is a runtime the caller already built and reconciled under the same control lock.
async function startOwned({ workspace_path, feature, effort = 'high', force_new_session = false, prior_turn_attestation = undefined }, direction, prepared = null) {
  const attestation = priorTurnAttestation(prior_turn_attestation);
  const runtime = prepared ?? await featureRuntime({ workspace_path, feature, force_new_session });
  if (!runtime.feature.spec_revision) throw new OverdriveError('Save a concrete feature specification before starting its agent.', 'SPEC_REQUIRED');
  await reconcileDispatch(runtime, attestation);
  if (runtime.feature.active_turn_id) throw new OverdriveError(`Feature already has active turn ${runtime.feature.active_turn_id}; steer it instead.`, 'TURN_ACTIVE');
  await assertWorkersSettled(runtime, attestation);
  await bridge.ensureStarted();
  let threadId = runtime.feature.thread_id;
  let created = false;
  if (threadId && !force_new_session) {
    await resume(runtime);
  } else {
    const { threadId: _replaced, ...session } = sessionParams(runtime);
    const started = await bridge.startThread({ ...session, effort });
    threadId = started.thread.id;
    created = true;
    register(threadId, runtime.root, runtime.feature.slug);
    await bridge.request('thread/name/set', { harness: runtime.harness, profile: runtime.profile, threadId, name: `OVERDRIVE · ${runtime.feature.title}` }).catch(() => {});
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
    checkoutPath: runtime.cwd,
    next: 'The feature task is running. Use agent_inspect for safe progress or agent_steer to revise direction mid-turn.',
  };
}

// Steers the agent's live turn with its waiting messages and the direction, or starts a turn with
// them the way agent_start does. Without a direction (a delivery sweep) it does nothing once no
// message waits; featureRuntime refuses paused, done and archived agents either way.
async function deliverOwned(args, direction) {
  const runtime = await featureRuntime({ workspace_path: args.workspace_path, feature: args.feature });
  if (runtime.feature.thread_id) {
    await bridge.ensureStarted();
    await resume(runtime);
    await reconcileDispatch(runtime);
  }
  const turnId = runtime.feature.active_turn_id;
  const inbox = { workspace_path: runtime.root, feature: runtime.feature.slug };
  const messages = await agentInbox(inbox);
  if (!direction && !messages.length) return null;
  if (!turnId) return { ...(await startOwned(args, direction, runtime)), mode: 'new_turn' };
  const result = await bridge.request('turn/steer', {
    harness: runtime.harness,
    profile: runtime.profile,
    threadId: runtime.feature.thread_id,
    expectedTurnId: turnId,
    input: textInput([messageBlock(messages), direction].filter(Boolean).join('\n\n')),
  }).catch(error => {
    // A refused steer reached no turn, because the turn ended first.
    throw error.refused ? new OverdriveError(`Turn ${turnId} ended before the steer reached it.`, 'TURN_MISMATCH') : error;
  });
  await markDelivered({ ...inbox, messages, how: 'steer' }).catch(reportDeliveryFailure);
  // The agent takes a steer in only once its running tool call returns.
  const [behindTool] = runningTools(turnId);
  return {
    feature: runtime.feature.slug, threadId: runtime.feature.thread_id, turnId: result.turnId || turnId, harness: runtime.harness, mode: 'mid_turn',
    ...(behindTool ? { behindTool, next: 'The agent reads this when that call returns; use agent_interrupt if it must stop sooner.' } : {}),
  };
}

// Pending messages are delivered on a timer while this controller runs agents, and right after a
// turn ends. The timer stops once no agent is registered.
function scheduleSweep(delayMs = deliveryIntervalMs) {
  if (closed || !registrations.size || (sweepTimer && delayMs)) return;
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    sweeping ??= deliverPendingMessages().catch(reportDeliveryFailure).finally(() => {
      sweeping = null;
      scheduleSweep();
    });
  }, delayMs);
  sweepTimer.unref();
}

async function deliverPendingMessages() {
  for (const [key, retryAt] of deliveryRetry) if (retryAt <= Date.now()) deliveryRetry.delete(key);
  for (const [root, entries] of Map.groupBy(registrations, ([, registration]) => registration.workspacePath)) {
    const skip = [...deliveryRetry.keys()].filter(key => key.startsWith(`${root}\n`)).map(key => key.slice(root.length + 1));
    const agents = await deliverableAgents({ workspace_path: root, threads: entries.map(([threadId]) => threadId), skip });
    await Promise.all(agents.map(feature => deliverMessages(root, feature)));
  }
}

// An agent another live controller owns is left to it. After a failed delivery the agent's
// messages stay pending and it is retried later.
async function deliverMessages(root, feature) {
  const args = { workspace_path: root, feature };
  const key = `${root}\n${feature}`;
  try {
    await withAgentControl(args, ownerToken, () => deliverOwned(args, null), { yieldToLiveOwner: true });
    deliveryRetry.delete(key);
  } catch (error) {
    deliveryRetry.set(key, Date.now() + DELIVERY_RETRY_MS);
    process.stderr.write(`[overdrive] messages for ${feature} stay pending: ${redactString(error.message)}\n`);
  }
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
    warning = `Native session ${runtime.feature.thread_id} has no recorded owning backend, so it was not read. Replace it with agent_start and force_new_session: true.`;
  } else if (include_thread && runtime.feature.thread_id) {
    try {
      await bridge.ensureStarted();
      // A live Codex turn needs a registered listener. Completed turns are also read back to
      // cover a completion delivered before resume registered the session.
      const observing = await prepareCodexObservation(runtime);
      if (!observing && !registrations.has(runtime.feature.thread_id)) await bridge.attachThread?.(sessionParams(runtime));
      const response = await bridge.request('thread/read', { harness: runtime.harness, profile: runtime.profile, threadId: runtime.feature.thread_id, includeTurns: true });
      thread = safeThreadView(response.thread);
      if (observing || registrations.has(runtime.feature.thread_id)) await reconcileCompletedNativeTurn(runtime, response.thread);
      if (runtime.feature.agent_status === 'uncertain') {
        await settleUncertain(runtime, response.thread);
        if (runtime.feature.active_turn_id && !registrations.has(runtime.feature.thread_id)) await resume(runtime);
        if (runtime.feature.agent_status === 'uncertain') warning = response.thread.history === 'unavailable'
          ? `The last turn request has no confirmed outcome and this session's history is not available here, so no turn is dispatched. ${ATTEST_NEXT}`
          : 'The last turn request has no confirmed outcome; the next agent command reconciles it from the native session before doing anything else.';
      }
    } catch (error) {
      warning = `Native task could not be refreshed: ${error.message}`;
    }
  }
  // A guard whose recorded job proves its tree ended (for example after the controller holding it
  // exited before recording the exit) is cleared here, without a new turn or a lifecycle change.
  // Guards whose tree may still run, or that have no job, stay.
  try {
    await recoverWorkerGuards({ workspace_path: runtime.root, feature: runtime.feature.slug });
  } catch (error) {
    warning ??= `Worker guards could not be re-checked: ${redactString(error.message)}`;
  }
  const context = await getFeatureContext({ workspace_path: runtime.root, feature: runtime.feature.slug, timeline_limit: 30 });
  const turnId = context.feature.agent.activeTurnId;
  return { ...context, nativeTask: thread, liveProgress: { message: turnMessages.get(turnId) ? clipTail(turnMessages.get(turnId), 3_000) : null, plan: turnPlans.get(turnId) ?? null, diff: turnDiffs.get(turnId) ?? null, running: runningTools(turnId) }, warning, safety: 'Reasoning items are intentionally filtered. Visible agent messages and plans are reports, not evidence.' };
}

// On a timeout an agent is reported by where it stands, never by its previous handoff.
function progressRow({ feature: { slug, status, agent }, git: { head, changedFileCount, unavailable }, liveProgress, warning }) {
  return {
    feature: { slug, status, agent: { status: agent.status, activeTurnId: agent.activeTurnId } },
    git: { head, changedFileCount, unavailable },
    liveProgress: { message: liveProgress.message && clipTail(liveProgress.message, 800), running: liveProgress.running },
    ...(warning ? { warning } : {}),
  };
}

// Without features, waits on this controller's registered lanes that are busy or whose turn it
// started or adopted has not yet been handed off, so a lane that finished between waits is still returned.
async function waitFeatureAgents({ workspace_path, features, timeout_seconds = 300 }) {
  if (!Number.isInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 600) throw new OverdriveError('Wait duration must be 1–600 seconds.', 'INVALID_INPUT');
  if (features !== undefined && (!Array.isArray(features) || !features.length || features.some(feature => typeof feature !== 'string') || new Set(features).size !== features.length)) throw new OverdriveError('features must be a nonempty list of unique feature slugs.', 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const lanes = () => new Map([...registrations.values()].filter(registration => registration.workspacePath === root).map(registration => [registration.feature, registration]));
  const registered = lanes();
  let runtimes = await Promise.all((features ?? [...registered.keys()]).map(feature => featureRuntime({ workspace_path, feature, allow_inactive: true })));
  if (!features) runtimes = runtimes.filter(runtime => registered.get(runtime.feature.slug).handoffPending || agentBusy(runtime.feature));
  if (!runtimes.length) {
    const messages = await takeCoordinatorMessages({ workspace_path: root });
    return { timedOut: false, handoffs: [], messages, nextAction: `${messages.length ? 'Act on these coordinator messages. ' : ''}No lane in this controller is running or awaiting handoff. Use feature_list for the latest lane state.` };
  }
  const signalled = new Set();
  let timer;
  let finish;
  const changed = new Promise(resolve => { finish = resolve; });
  // Messages to the coordinator are only in the database, so the wait polls for them.
  const inbox = await openCoordinatorInbox({ workspace_path: root });
  const poll = setInterval(() => { if (inbox.waiting()) finish(true); }, 1_000);
  // Without features, a turn this controller starts during the wait, such as a message delivery,
  // also wakes it when it completes or needs input.
  const signalThread = (threadId, handoff = false) => {
    const registration = registrations.get(threadId);
    const slug = runtimes.find(runtime => runtime.feature.thread_id && runtime.feature.thread_id === threadId)?.feature.slug
      ?? (handoff && !features && registration?.workspacePath === root ? registration.feature : null);
    if (slug) { signalled.add(slug); finish(true); }
  };
  const notification = message => {
    if (['turn/completed', 'thread/status/changed'].includes(message.method)) signalThread(message.params?.threadId, message.method === 'turn/completed');
  };
  const request = message => signalThread(message.params?.threadId, true);
  bridge.on('notification', notification);
  bridge.on('serverRequest', request);
  timer = setTimeout(() => finish(false), timeout_seconds * 1000);
  try {
    for (const runtime of runtimes) {
      if (await prepareCodexObservation(runtime)) {
        const response = await bridge.request('thread/read', { harness: runtime.harness, profile: runtime.profile, threadId: runtime.feature.thread_id, includeTurns: true });
        await reconcileCompletedNativeTurn(runtime, response.thread);
      }
    }
    await notificationQueue;
    const initial = await Promise.all(runtimes.map(runtime => getFeatureContext({ workspace_path, feature: runtime.feature.slug, timeline_limit: 1 })));
    // A listed agent at rest whose turn was already handed off has nothing new until its next turn;
    // one starting or uncertain is still reported, as without a list.
    const handedOff = ({ feature: { slug, agent } }) => Boolean(features) && registered.has(slug) && !registered.get(slug).handoffPending
      && !agentBusy({ active_turn_id: agent.activeTurnId, agent_status: agent.status });
    for (const state of initial) {
      if (state.pendingAgentRequests.length || (!state.feature.agent.activeTurnId && !handedOff(state))) signalled.add(state.feature.slug);
    }
    if (features && !signalled.size && initial.every(handedOff)) {
      const messages = await takeCoordinatorMessages({ workspace_path: root });
      return { timedOut: false, handoffs: [], messages, nextAction: `${messages.length ? 'Act on these coordinator messages. ' : ''}${features.join(', ')} ${features.length > 1 ? 'are' : 'is'} idle and already handed off, so nothing is new until a turn starts; agent_inspect returns an agent's full state.` };
    }
    const signal = signalled.size || inbox.waiting() ? true : await changed;
    await notificationQueue;
    const selected = signal ? [...signalled] : runtimes.map(runtime => runtime.feature.slug);
    // Taken after adoption and just before inspection, so a turn that started during the wait and
    // is handed off at rest counts as handed off.
    const pending = new Map([...lanes()].map(([slug, lane]) => [slug, lane.handoffPending]));
    const handoffs = await Promise.all(selected.map(async feature => {
      const state = await inspectFeatureAgent({ workspace_path, feature, include_thread: true });
      if (!signal) return progressRow(state);
      return { feature: state.feature, git: state.git, liveProgress: state.liveProgress, pendingAgentRequests: state.pendingAgentRequests, warning: state.warning };
    }));
    // A lane handed off at rest is done until its next turn; one started during this wait stays pending.
    // A timeout hands nothing off, so a turn that ends just after it is returned by the next wait.
    const current = lanes();
    for (const { feature: { slug, agent } } of handoffs) {
      const lane = current.get(slug);
      if (signal && lane && lane.handoffPending === pending.get(slug) && !agentBusy({ active_turn_id: agent.activeTurnId, agent_status: agent.status })) lane.handoffPending = null;
    }
    const messages = await takeCoordinatorMessages({ workspace_path: root });
    const nextAction = signal
      ? 'Reconcile completed or decision-ready handoffs and coordinator messages now, advance authorized next actions, and wait only on remaining unreconciled work.'
      : 'The wait timed out. Each row shows only where its agent stands; agent_inspect returns an agent\'s full state, and the next wait returns any turn that has since ended.';
    return { timedOut: !signal, handoffs, messages, nextAction: `${nextAction} This wait does not wake an ended coordinator turn.` };
  } finally {
    clearInterval(poll);
    inbox.close();
    clearTimeout(timer);
    bridge.off('notification', notification);
    bridge.off('serverRequest', request);
  }
}

async function interruptOwned({ workspace_path, feature }) {
  const runtime = await featureRuntime({ workspace_path, feature, allow_inactive: true });
  await reconcileDispatch(runtime);
  if (!runtime.feature.thread_id || !runtime.feature.active_turn_id) return { interrupted: false, reason: 'No active turn.' };
  requireSessionOwner(runtime);
  await bridge.ensureStarted();
  await resume(runtime);
  const result = await bridge.request('turn/interrupt', { harness: runtime.harness, profile: runtime.profile, threadId: runtime.feature.thread_id, turnId: runtime.feature.active_turn_id });
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
    const { thread } = await bridge.request('thread/read', { harness: runtime.harness, profile: runtime.profile, threadId: runtime.feature.thread_id, includeTurns: true });
    turn = thread.history === 'unavailable' ? null : thread.turns?.find(candidate => candidate.id === turnId);
  } catch { return false; }
  if (!turn || !['completed', 'interrupted', 'failed'].includes(turn.status)) return false;
  const base = { workspace_path: runtime.root, feature: runtime.feature.slug, thread_id: runtime.feature.thread_id, owner_token: ownerToken };
  await enqueueStateWork(async () => {
    if (turn.descendantsUnconfirmed) await markDescendantsUnconfirmed({ ...base, turn_id: turnId, summary: descendantsSummary(turnId) });
    await saveAgentSession({ ...base, status: turn.status === 'completed' ? 'idle' : turn.status, summary: turn.status === 'failed' ? turnHandoff(turn) : undefined });
  });
  return true;
}

// Records why a pause or archive could not show that the lane's worker stopped and returns the
// STOP_UNCONFIRMED error to throw; the lifecycle status is left as it was. The refusal is recorded
// even when another controller owns the lane.
async function stopUnconfirmed({ workspace_path, feature, lifecycle }, status, reason, details = {}) {
  const message = `${feature} was not marked ${status} because its worker may still be running: ${reason} The lane stays ${lifecycle}.`;
  await recordAgentEvent({ workspace_path, feature, kind: 'feature.stop_unconfirmed', summary: message, details: { requestedStatus: status, ...details } });
  return new OverdriveError(message, 'STOP_UNCONFIRMED', details);
}

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
      result = await bridge.request('turn/interrupt', { harness: runtime.harness, profile: runtime.profile, threadId, turnId });
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
  // Validate the update before stopping anything, so a refused update never interrupts work.
  featureUpdateInput(args);
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
    try { await settleLingeringWorker({ workspace_path: args.workspace_path, feature: row.slug }, row.thread_id); }
    catch (error) {
      throw await stopUnconfirmed(lane, args.status, `a worker process from an earlier turn ${error.code === 'CLAUDE_DESCENDANTS_UNCONFIRMED' ? 'left tools that may still be running' : 'is still running'} (${redactString(error.message)}).`, { lingeringProcess: true });
    }
  }
  // Clean-exit reports the settlement produced are applied first; a later controller can still
  // prove from a missing containment job that a tree it never held has ended.
  await notificationQueue;
  await recoverWorkerGuards(args);
  const marker = await readUnconfirmedDescendants(args);
  // A stop that itself left descendants unconfirmed is refused whatever attestation it carries.
  const attestable = attestation && !interruption?.descendantsUnconfirmed && marker?.generation === priorGeneration;
  if (marker && !(attestable && (await attestDescendantsStopped({ ...args, evidence: attestation.evidence, generation: marker.generation })).cleared)) {
    throw await stopUnconfirmed(lane, args.status, `${marker.summary} ${ATTEST_NEXT}`, { descendantsUnconfirmed: true, turnId: marker.turnId ?? null });
  }
  const guards = await readWorkerGuards(args);
  if (guards.length) {
    if (!attestation || interruption?.descendantsUnconfirmed) throw await stopUnconfirmed(lane, args.status, `a Claude worker process from this lane has no confirmed process-tree exit. ${ATTEST_NEXT}`, { workerGuards: guards.length });
    const running = (await Promise.all(guards.map(guard => (guard.job ? workerJobState(guard.job) : 'unknown')))).filter(state => state === 'present').length;
    if (running) throw await stopUnconfirmed(lane, args.status, `${running} worker process tree(s) from this lane still exist, so tools they launched may still be running and an attestation cannot cover them. Stop them from the controller holding them, or wait for them to end.`, { workerGuards: guards.length, runningJobs: running });
    await clearWorkerGuards({ ...args, evidence: attestation.evidence });
  }
  const result = await updateStoppedFeature(args);
  return interruption ? { ...result, interruption } : result;
}
async function resolveRequestOwned({ workspace_path, feature, request_id, action, response, scope = 'turn' }) {
  if (!['accept', 'accept_session', 'decline', 'cancel', 'respond'].includes(action)) throw new OverdriveError('Unknown request action.', 'INVALID_INPUT');
  if (!['turn', 'session'].includes(scope)) throw new OverdriveError('scope must be turn or session.', 'INVALID_INPUT');
  const request = await pendingAgentRequest({ workspace_path, feature, request_id });
  await bridge.ensureStarted();
  const liveRequest = bridge.liveRequest(request_id, request.thread_id);
  if (!liveRequest || liveRequest.params?.threadId !== request.thread_id) {
    await resolveAgentRequestRecord({ workspace_path, feature, request_id, status: 'orphaned', summary: `${request.method} belongs to an earlier app-server process and must be requested again.` });
    throw new OverdriveError('This request belongs to an earlier server process and can no longer be answered. Inspect the feature task and retry the blocked operation.', 'REQUEST_ORPHANED');
  }
  let result;
  if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
    if (action === 'respond') throw new OverdriveError('Use accept, accept_session, decline, or cancel for this request.', 'INVALID_INPUT');
    result = { decision: action === 'accept_session' ? 'acceptForSession' : action };
  } else if (request.method === 'item/permissions/requestApproval') {
    if (action === 'accept' || action === 'accept_session') result = { permissions: request.payload.permissions || {}, scope: action === 'accept_session' ? 'session' : scope };
    else result = { permissions: {}, scope: 'turn' };
  } else {
    if (action !== 'respond') throw new OverdriveError('This request requires a structured response object.', 'INVALID_INPUT');
    result = parseJsonObject(response, 'response') || {};
  }
  bridge.respondToServer(request_id, result, undefined, request.thread_id);
  await resolveAgentRequestRecord({ workspace_path, feature, request_id, owner_token: ownerToken, thread_id: request.thread_id, ignore_missing: true, summary: `Resolved ${request.method} with ${action}.` });
  return { resolved: true, requestId: String(request_id), action, feature };
}

// Resolves after the bridge has shut down, with the worker processes it could not stop.
async function shutdownAgentRuntime() {
  closed = true;
  clearTimeout(sweepTimer);
  await sweeping;
  await notificationQueue;
  const stopped = await bridge.shutdown();
  await notificationQueue;
  return { unstopped: stopped?.unstopped ?? [] };
}

// Effort and instruction are validated before the control lock, which may replace a dead owner
// and mark its running turn uncertain.
function assertEffort({ effort = 'high' }) {
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new OverdriveError('Unsupported reasoning effort.', 'INVALID_INPUT');
}
// An omitted instruction falls back to the lane's next action; a supplied one, even an empty
// string, must be valid.
const startFeatureAgent = async args => {
  assertEffort(args);
  const direction = args.instruction === undefined || args.instruction === null ? undefined : requiredText(args.instruction, 'instruction', { max: 100_000 });
  return await withAgentControl(args, ownerToken, () => startOwned(args, direction));
};
// A steer is durable: a message the agent cannot take now waits in its inbox.
const steerFeatureAgent = async args => {
  assertEffort(args);
  const message = requiredText(args.message, 'message', { max: 20_000 });
  let result;
  try {
    result = await withAgentControl(args, ownerToken, () => deliverOwned(args, message));
  } catch (error) {
    if (!QUEUED_WHEN.has(error.code)) throw error;
    const queued = await sendAgentMessage({ workspace_path: args.workspace_path, from: 'coordinator', to: args.feature, message });
    return { feature: queued.to, mode: 'queued', messageId: queued.id, reason: error.message, next: 'The message waits in the agent\'s inbox. It is delivered once the agent can take it, and at the latest in the prompt of its next turn.' };
  }
  await recordAgentEvent({ workspace_path: args.workspace_path, feature: result.feature, kind: 'coordinator.steered', summary: `Coordinator ${result.mode === 'mid_turn' ? 'steered the active turn' : 'started a follow-up turn'}: ${redactString(clip(message, 2_000))}`, details: { mode: result.mode } });
  return result;
};
const interruptFeatureAgent = args => withAgentControl(args, ownerToken, () => interruptOwned(args));
const resolveFeatureAgentRequest = args => withAgentControl(args, ownerToken, () => resolveRequestOwned(args));
// Pausing or archiving holds the lane's control lock from stopping its worker through recording
// the status, so no turn can start in between and the status is written only after the stop.
const stopFeatureLane = async args => {
  if (!['paused', 'archived'].includes(args.status)) throw new OverdriveError('Only pausing or archiving stops a lane.', 'INVALID_INPUT');
  return await withLaneStop(args, ownerToken, (row, busy, foreignOwner) => stopForStatus(args, row, busy, foreignOwner));
};
return { startFeatureAgent, steerFeatureAgent, inspectFeatureAgent, waitFeatureAgents, interruptFeatureAgent, resolveFeatureAgentRequest, stopFeatureLane, shutdownAgentRuntime };
}

export const { startFeatureAgent, steerFeatureAgent, inspectFeatureAgent, waitFeatureAgents, interruptFeatureAgent, resolveFeatureAgentRequest, stopFeatureLane, shutdownAgentRuntime } = createAgentRuntime();
