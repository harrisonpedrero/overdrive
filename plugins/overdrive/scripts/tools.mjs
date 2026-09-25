import {
  agentProfile,
  createFeature,
  doctorWorkspace,
  getFeatureContext,
  initializeManagedProject,
  initializeWorkspace,
  listFeatures,
  listLanes,
  sendAgentMessage,
  updateFeature,
  updateWork,
} from './workspace.mjs';
import { OverdriveError, safeSlug } from './util.mjs';
import { WORKER_TOOLS } from './worker-policy.mjs';
import {
  inspectFeatureAgent,
  interruptFeatureAgent,
  resolveFeatureAgentRequest,
  startFeatureAgent,
  steerFeatureAgent,
  stopFeatureLane,
  waitFeatureAgents,
} from './agent-runtime.mjs';
import { composeView } from './presentation.mjs';

const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
const boolean = description => ({ type: 'boolean', description });
const integer = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });

function object(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function tool(name, title, description, inputSchema, annotations = {}) {
  return {
    name,
    title,
    description,
    inputSchema,
    annotations: { title, openWorldHint: false, ...annotations },
  };
}

const priorTurnAttestation = consequence => ({
  ...object({
    evidence: string('The process or backend facts you verified, under your existing authority, showing that no worker or tool process for this lane is still running (for example the process check performed and its result).', { minLength: 1, maxLength: 4000 }),
  }, ['evidence']),
  description: `Evidence-based coordinator attestation when a turn request, foreign controller, or worker/process-tree stop cannot be confirmed. It is recorded in the timeline, not requested from the user as approval. Readable native history takes precedence for uncertain turn requests, and ${consequence}`,
});

const workspace = { workspace_path: string('Absolute path to the OVERDRIVE control workspace.') };
const feature = { feature: string('Feature slug, such as search-redesign.', { pattern: '^[a-z][a-z0-9-]{0,62}$' }) };
export const TOOLS = [
  tool('agents_wait', 'Receive the next feature handoff', 'Wait for a completion or input request from feature workers. Without features, waits on every lane this controller has running or has not yet handed off. Completion or input on any lane returns promptly for coordinator review; an unrelated running lane does not hold the handoff. This only drives active coordination, not host wakeups after a turn ends.', object({
    ...workspace,
    features: { type: 'array', minItems: 1, uniqueItems: true, items: string('Feature slug still awaiting reconciliation; omit already handled idle lanes.') },
    timeout_seconds: integer('Bounded wait, defaults to 30 seconds.', 1, 60),
  }, ['workspace_path']), { readOnlyHint: true, openWorldHint: true }),
  tool('view', 'Show the work graph', 'Render one feature’s actual work dependencies and statuses as a native Mermaid diagram. No embedded chat, forms, navigation, or action buttons. Returns Markdown to include directly in the reply.', object({
    ...workspace, ...feature,
    work_items: { type: 'array', minItems: 1, maxItems: 24, uniqueItems: true, items: string('Exact work key.'), description: 'Optional focused subset for a large graph. Dependencies outside the view remain labeled. Without this, show all work when there are at most 24 items; larger graphs show 24 at a time, running, blocked, failed, review and ready work first, then their prerequisites, then the rest.' },
    page: integer('Optional 24-item page of the default large-graph order, starting at 1. Each call reflects current state; after work status changes, start again at page 1 because page membership may shift. Cannot be combined with work_items.', 1, 1000),
  }, ['workspace_path', 'feature']), { readOnlyHint: true, idempotentHint: true }),

  tool('workspace_init', 'Initialize OVERDRIVE', 'Adopt a Git repository in a control workspace. Creates a private bare cache and durable local state; it does not run repository setup scripts.', object({
    ...workspace,
    repository: string('Credential-free Git URL, SSH remote, or absolute local repository path.'),
    harness: string('Lane worker harness: codex (default) or claude. Editable later as "harness" in overdrive.json.', { enum: ['codex', 'claude'] }),
  }, ['workspace_path', 'repository']), { destructiveHint: false, idempotentHint: true, openWorldHint: true }),

  tool('project_create', 'Create managed project', 'Start a new project from scratch inside the control workspace, create its initial Git commit, and initialize OVERDRIVE against it.', object({
    ...workspace,
    project_name: string('Human-readable project name.'),
    description: string('Concrete product brief for the new project.'),
    default_branch: string('Initial branch name; defaults to main.'),
    harness: string('Lane worker harness: codex (default) or claude. Editable later as "harness" in overdrive.json.', { enum: ['codex', 'claude'] }),
  }, ['workspace_path', 'project_name', 'description']), { destructiveHint: false, idempotentHint: true }),

  tool('doctor', 'Check OVERDRIVE', 'Check the local Git, Node, configured worker harness CLI (Codex or Claude Code), state database, and repository cache needed by this workspace.', object(workspace, ['workspace_path']), { readOnlyHint: true, idempotentHint: true }),

  tool('feature_create', 'Create feature lane', 'Create an independent full repository clone at an exact commit and initialize its isolated spec/context packet.', object({
    ...workspace,
    ...feature,
    title: string('Human-readable feature title.'),
    outcome: string('Concrete outcome this lane must enable.'),
    base_revision: string('Optional branch, tag, or commit. Required full commit ID when base_feature is supplied; otherwise defaults to the refreshed canonical revision.'),
    base_feature: string('Optional existing lane supplying the explicitly selected base_revision. Reads committed objects from that clone without publishing them to canonical source or selecting its current HEAD. Seeds from the cached canonical mirror without refreshing it, so canonical source may be unavailable.', { pattern: '^[a-z][a-z0-9-]{0,62}$' }),
    priority: integer('Relative feature priority.', -100, 100),
    spec: string('Optional complete initial Markdown specification.'),
  }, ['workspace_path', 'feature', 'title', 'outcome']), { destructiveHint: false, openWorldHint: true }),

  tool('feature_list', 'List feature lanes', 'Return a compact cross-feature progress view without loading every feature specification.', object({
    ...workspace,
    include_archived: boolean('Include archived lanes.'),
    refresh_git: boolean('Refresh Git status for each clone; slower on many features.'),
  }, ['workspace_path']), { readOnlyHint: true, idempotentHint: true }),

  tool('feature_get', 'Inspect feature lane', 'Load one feature only: current spec, work DAG, safe timeline, Git facts, recorded evidence history, and pending agent requests.', object({
    ...workspace,
    ...feature,
    timeline_limit: integer('Number of recent safe events.', 1, 200),
  }, ['workspace_path', 'feature']), { readOnlyHint: true, idempotentHint: true }),

  tool('feature_update', 'Update feature lane', 'Change a lane’s status, spec, summary, next action, blocker or unresolved notes in one call. Omitted fields stay unchanged; blank text clears a field. A changed spec is saved as a new durable revision. Statuses change freely, except that pausing or archiving first stops the lane worker and records the update only once no turn is running; if the stop cannot be confirmed nothing changes and STOP_UNCONFIRMED explains what is still running. A paused, done or archived lane dispatches nothing until it is made active again.', object({
    ...workspace,
    ...feature,
    status: string('Lifecycle state.', { enum: ['planned', 'active', 'paused', 'blocked', 'review', 'done', 'archived'] }),
    spec: string('Complete Markdown specification for a new revision.'),
    spec_rationale: string('Concise reason the spec changed.'),
    summary: string('What is now true and why it matters; no private reasoning.'),
    next_action: string('Single most useful next action.'),
    blocker: string('What blocks the lane. Setting a status other than blocked without one clears it.'),
    unresolved: { type: 'array', items: string('Open decision, risk, or blocker.'), maxItems: 100, description: 'Recorded in the timeline.' },
    prior_turn_attestation: priorTurnAttestation('without an attestation such a lane cannot be paused or archived.'),
  }, ['workspace_path', 'feature']), { destructiveHint: false, openWorldHint: true }),

  tool('work_update', 'Update work graph', 'Upsert work items and their dependencies, or remove items. Omitted fields keep their saved values; a new item needs a title. Any status may follow any other, except that planned and ready follow from whether every dependency is done. Returns the submitted items; use feature_get for all work or view for the graph.', object({
    ...workspace,
    ...feature,
    items: {
      type: 'array', maxItems: 200,
      items: object({
        key: string('Stable item key such as design-api or T-001.'),
        title: string('Short work title; required for a new item.'),
        description: string('Bounded assignment or transformation.'),
        acceptance: string('Observable acceptance criteria.'),
        kind: string('Work phase.', { enum: ['scope', 'design', 'build', 'review', 'validate', 'repair', 'integrate'] }),
        depends_on: { type: 'array', items: string('A prerequisite work item key.'), maxItems: 100, description: 'Replaces the item’s prerequisites.' },
        status: string('Work state.', { enum: ['planned', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled'] }),
        result: string('Result summary.'),
        blocker: string('Blocker or failure detail.'),
      }, ['key']),
    },
    remove: { type: 'array', items: string('Key of a work item to remove.'), maxItems: 200 },
  }, ['workspace_path', 'feature']), { destructiveHint: false }),

  tool('agent_start', 'Start feature agent', 'Start or resume the lane-specific worker task (a GPT-6 Sol Codex task by default, or a Claude Code session when overdrive.json sets harness to claude) with only that feature context and the repository instructions. For a bounded work item, include its key and outcome in instruction.', object({
    ...workspace,
    ...feature,
    instruction: string('Optional immediate direction; otherwise the lane’s next action is used.'),
    effort: string('Worker reasoning effort.', { enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
    force_new_session: boolean('Create a replacement task on the currently configured harness instead of resuming the recorded one. A recorded task otherwise always resumes on the harness that created it.'),
    prior_turn_attestation: priorTurnAttestation('without an attestation such a lane cannot dispatch.'),
  }, ['workspace_path', 'feature']), { destructiveHint: false, openWorldHint: true }),

  tool('agent_inspect', 'Inspect feature agent', 'Refresh and return safe native-task progress plus Git/evidence state. Private reasoning items are filtered.', object({
    ...workspace,
    ...feature,
    include_thread: boolean('Read the persisted native worker task as well as local OVERDRIVE state.'),
  }, ['workspace_path', 'feature']), { readOnlyHint: true, idempotentHint: true, openWorldHint: true }),

  tool('agent_steer', 'Steer feature agent', 'Deliver a revision to the active turn, or start a follow-up turn when the lane task is idle. For a bounded work item, include its key and outcome in instruction.', object({
    ...workspace,
    ...feature,
    instruction: string('Clear replacement, correction, constraint, or follow-up direction.'),
    effort: string('Reasoning effort for a new follow-up turn.', { enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
  }, ['workspace_path', 'feature', 'instruction']), { destructiveHint: false, openWorldHint: true }),

  tool('agent_interrupt', 'Interrupt feature agent', 'Interrupt an active feature turn while preserving the task and checkout.', object({ ...workspace, ...feature }, ['workspace_path', 'feature']), { destructiveHint: true, openWorldHint: true }),

  tool('agent_request_resolve', 'Resolve feature agent request', 'Relay the user-approved answer to a pending command, permission, elicitation, or input request from the feature task.', object({
    ...workspace,
    ...feature,
    request_id: string('Opaque pending request identifier returned by inspection.'),
    action: string('Resolution action.', { enum: ['accept', 'accept_session', 'decline', 'cancel', 'respond'] }),
    response: { type: 'object', description: 'Structured response for a question or elicitation.', additionalProperties: true },
    scope: string('Permission grant scope.', { enum: ['turn', 'session'] }),
  }, ['workspace_path', 'feature', 'request_id', 'action']), { destructiveHint: false, openWorldHint: true }),
];

// Tools only workers have; their lab tools come from the coordinator surface.
const WORKER_ONLY_TOOLS = [
  tool('message_send', 'Message an agent', 'Send a message to a lane agent, a QA agent (such as qa) or the coordinator; the runtime delivers it.', object({
    ...workspace,
    to: string('Recipient: a lane slug, a QA agent name, or coordinator.', { pattern: '^[a-z][a-z0-9-]{0,62}$' }),
    body: string('What changed, what to test or fix, or what you need; self-contained.', { minLength: 1, maxLength: 20000 }),
  }, ['workspace_path', 'to', 'body']), { destructiveHint: false }),
  tool('lanes', 'List lanes', 'Every lane and QA agent: kind, title, status, agent status, checkout path, head commit, whether the checkout is dirty, and open findings.', object(workspace, ['workspace_path']), { readOnlyHint: true, idempotentHint: true }),
];

const workerHandlers = { message_send: sendAgentMessage, lanes: listLanes };

const handlers = {
  view: composeView,
  agents_wait: waitFeatureAgents,
  workspace_init: initializeWorkspace,
  project_create: initializeManagedProject,
  doctor: doctorWorkspace,
  feature_create: createFeature,
  feature_list: listFeatures,
  feature_get: getFeatureContext,
  async feature_update(args) {
    return await (['paused', 'archived'].includes(args.status) ? stopFeatureLane(args) : updateFeature(args));
  },
  work_update: updateWork,
  agent_start: startFeatureAgent,
  agent_inspect: inspectFeatureAgent,
  agent_steer: steerFeatureAgent,
  agent_interrupt: interruptFeatureAgent,
  agent_request_resolve: resolveFeatureAgentRequest,
};

// A worker's copy of the server: OVERDRIVE_AGENT binds it to one agent (or to the from argument
// when it is *); OVERDRIVE_WORKER alone is an inert copy of the plugin with no tools.
const workerAgent = () => process.env.OVERDRIVE_AGENT || null;
const inertWorker = () => !workerAgent() && Boolean(process.env.OVERDRIVE_WORKER);
const forbidden = message => new OverdriveError(message, 'WORKER_TOOL_FORBIDDEN');

// A worker-mode schema drops workspace_path unless the server has no workspace, and asks for
// from only when the server has no fixed identity.
function workerSchema(tool) {
  const { workspace_path, ...properties } = tool.inputSchema.properties;
  const required = tool.inputSchema.required.filter(key => key !== 'workspace_path');
  const identity = {
    ...(workerAgent() === '*' ? { from: string('Your own agent name, as given in your instructions.', { pattern: '^[a-z][a-z0-9-]{0,62}$' }) } : {}),
    ...(process.env.OVERDRIVE_WORKSPACE ? {} : { workspace_path }),
  };
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, ...identity }, required: [...required, ...Object.keys(identity)] } };
}

async function callerProfile(caller) {
  return await agentProfile({ workspace_path: caller.workspace_path, agent: caller.from });
}

function workerCaller(args) {
  const from = workerAgent() === '*' ? args.from : workerAgent();
  return { from: safeSlug(from, 'from'), workspace_path: process.env.OVERDRIVE_WORKSPACE || args.workspace_path };
}

export async function listTools() {
  if (inertWorker()) return [];
  if (!workerAgent()) return TOOLS;
  // A fixed identity lists only the tools its kind may call; otherwise every worker tool is listed.
  const profile = workerAgent() === '*' ? null : await callerProfile(workerCaller({})).catch(() => null);
  return [...WORKER_ONLY_TOOLS, ...TOOLS]
    .filter(tool => WORKER_TOOLS[tool.name] && (!profile || WORKER_TOOLS[tool.name].includes(profile)))
    .map(workerSchema);
}

// The caller's kind comes from its recorded row, never from an argument. A feature agent's lab
// calls always target its own lane.
async function callWorkerTool(name, args) {
  const access = WORKER_TOOLS[name];
  const handler = access && (workerHandlers[name] ?? handlers[name]);
  if (!handler) throw forbidden(`${name} is not available to OVERDRIVE workers.`);
  const caller = workerCaller(args);
  const profile = await callerProfile(caller);
  if (!access.includes(profile)) throw forbidden(`${name} is available to QA agents only.`);
  const call = { ...args, ...caller };
  if (profile === 'feature' && name.startsWith('lab_')) {
    if (call.target !== undefined && call.target !== caller.from) throw forbidden(`A feature agent may only target its own lane, ${caller.from}.`);
    call.target = caller.from;
  }
  return await handler(call);
}

export async function callTool(name, args) {
  if (inertWorker()) throw forbidden('This OVERDRIVE server runs inside a worker and exposes no tools.');
  if (workerAgent()) return await callWorkerTool(name, args ?? {});
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return await handler(args ?? {});
}
