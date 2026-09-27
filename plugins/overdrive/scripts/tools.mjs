import {
  agentProfile,
  createFeature,
  createQaAgent,
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
import { buildIntegration, getLab, integrate, recordFinding, runLabSuite } from './lab.mjs';

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
const SLUG = '^[a-z][a-z0-9-]{0,62}$';
const feature = { feature: string('Feature slug, such as search-redesign.', { pattern: SLUG }) };
const agent = { agent: string('Lane slug or QA agent name, such as search-redesign or qa.', { pattern: SLUG }) };
const suite = description => string(description, { pattern: '^[a-z0-9][a-z0-9_-]{0,62}$' });
const target = string('A feature lane slug, or integration for the integration build.', { pattern: SLUG });
const labRun = {
  suite: suite('Suite to run.'),
  target: { ...target, description: 'A feature lane slug, integration for the integration build, or base for a control run that belongs to no lane, such as showing a suite fails without the lanes\' changes.' },
  revision: string('Optional branch, tag or commit in the target checkout. For base, a commit ID may also be a lane\'s commit, such as the foundation commit other lanes start from; that control run still never qualifies the commit for integrate.'),
  mutant: string('Optional lab-relative path of a patch in the lab snapshot, applied to the target checkout before the suite runs. The run is a recorded mutant control with its raw passed or failed status; a failure shows detection only beside a passing unmutated run and a failure caused by the patch. It never counts as evidence about the target, resolves no finding and is left out of integrate.'),
};
export const TOOLS = [
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
    base_revision: string('Optional branch, tag, or commit. Required commit ID (full, or at least 7 hex digits) when base_feature is supplied; otherwise defaults to the refreshed canonical revision.'),
    base_feature: string('Optional existing lane supplying the explicitly selected base_revision. Reads committed objects from that clone without publishing them to canonical source or selecting its current HEAD. Seeds from the cached canonical mirror without refreshing it, so canonical source may be unavailable.', { pattern: SLUG }),
    priority: integer('Relative feature priority.', -100, 100),
    spec: string('Optional complete initial Markdown specification.'),
  }, ['workspace_path', 'feature', 'title', 'outcome']), { destructiveHint: false, openWorldHint: true }),

  tool('qa_create', 'Create QA agent', 'Create a QA agent that works in the workspace lab (lab/): it builds reusable suites, tests lanes and integrations with lab_run, records findings and messages them to the lanes. The brief is its durable spec; revise it with feature_update. Start it with agent_start.', object({
    ...workspace,
    name: string('Agent name; defaults to qa. Give a second QA agent another name, such as qa-ui.', { pattern: SLUG }),
    brief: string('What to test: the user journeys, interfaces, environments and priorities this agent covers.'),
  }, ['workspace_path', 'brief']), { destructiveHint: false }),

  tool('feature_list', 'List feature lanes', 'Return a compact progress view of every lane and QA agent without loading their specifications, plus the messages agents sent the coordinator since they were last returned (coordinatorMessages, each returned once). With coordinator_messages set to recent it returns messageHistory instead: the 10 newest messages to the coordinator from any sender, pending and delivered alike, with their status and when and how the runtime handed them over (delivered records that handoff, not that anyone read it), and delivers none of them. When older messages remain, nextBeforeMessage holds the before_message value for the next page; otherwise it is null.', object({
    ...workspace,
    include_archived: boolean('Include archived lanes.'),
    refresh_git: boolean('Refresh Git status for each clone; slower on many features.'),
    coordinator_messages: string('pending (the default) returns and delivers new messages; recent pages earlier messages without delivering any, to recover ones a lost response or compaction dropped.', { enum: ['pending', 'recent'] }),
    before_message: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Message id from nextBeforeMessage: list the 10 messages before it. Only with coordinator_messages recent.' },
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

  tool('view', 'Show the work graph', 'Render one feature’s actual work dependencies and statuses as a native Mermaid diagram. No embedded chat, forms, navigation, or action buttons. Returns Markdown to include directly in the reply.', object({
    ...workspace, ...feature,
    work_items: { type: 'array', minItems: 1, maxItems: 24, uniqueItems: true, items: string('Exact work key.'), description: 'Optional focused subset for a large graph. Dependencies outside the view remain labeled. Without this, show all work when there are at most 24 items; larger graphs show 24 at a time, running, blocked, failed, review and ready work first, then their prerequisites, then the rest.' },
    page: integer('Optional 24-item page of the default large-graph order, starting at 1. Each call reflects current state; after work status changes, start again at page 1 because page membership may shift. Cannot be combined with work_items.', 1, 1000),
  }, ['workspace_path', 'feature']), { readOnlyHint: true, idempotentHint: true }),

  tool('agent_start', 'Start agent', 'Start or resume a lane or QA agent’s worker task (a GPT-6 Sol Codex task by default, or a Claude Code session when overdrive.json sets harness to claude) with only its own context and the repository instructions. Messages waiting for the agent are included in the turn. For a bounded work item, include its key and outcome in instruction.', object({
    ...workspace,
    ...agent,
    instruction: string('Optional immediate direction; otherwise the lane’s next action is used.'),
    effort: string('Worker reasoning effort.', { enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
    force_new_session: boolean('Create a replacement task on the currently configured harness instead of resuming the recorded one. A recorded task otherwise always resumes on the harness that created it.'),
    prior_turn_attestation: priorTurnAttestation('without an attestation such a lane cannot dispatch.'),
  }, ['workspace_path', 'agent']), { destructiveHint: false, openWorldHint: true }),

  tool('agent_steer', 'Steer agent', 'Send the agent a message: it steers the running turn, starts a turn when the agent is idle, and otherwise (paused, archived, unsettled, or run by another coordinator session) waits in the agent’s inbox until it can be delivered. For a bounded work item, include its key and outcome.', object({
    ...workspace,
    ...agent,
    message: string('Clear replacement, correction, constraint, or follow-up direction.', { maxLength: 20000 }),
    effort: string('Reasoning effort for a new turn.', { enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
  }, ['workspace_path', 'agent', 'message']), { destructiveHint: false, openWorldHint: true }),

  tool('agent_inspect', 'Inspect agent', 'Refresh and return safe native-task progress plus Git/evidence state. Private reasoning items are filtered.', object({
    ...workspace,
    ...agent,
    include_thread: boolean('Read the persisted native worker task as well as local OVERDRIVE state.'),
  }, ['workspace_path', 'agent']), { readOnlyHint: true, idempotentHint: true, openWorldHint: true }),

  tool('agent_interrupt', 'Interrupt agent', 'Interrupt an active turn while preserving the task and checkout.', object({ ...workspace, ...agent }, ['workspace_path', 'agent']), { destructiveHint: true, openWorldHint: true }),

  tool('agent_request_resolve', 'Resolve agent request', 'Answer a pending command, permission, elicitation, or input request from an agent’s task, within the user’s current or earlier authorization.', object({
    ...workspace,
    ...agent,
    request_id: string('Opaque pending request identifier returned by inspection.'),
    action: string('Resolution action.', { enum: ['accept', 'accept_session', 'decline', 'cancel', 'respond'] }),
    response: { type: 'object', description: 'Structured response for a question or elicitation.', additionalProperties: true },
    scope: string('Permission grant scope.', { enum: ['turn', 'session'] }),
  }, ['workspace_path', 'agent', 'request_id', 'action']), { destructiveHint: false, openWorldHint: true }),

  tool('agents_wait', 'Receive the next handoff', 'Wait for a turn completion or input request from agents, or a message to the coordinator. Without agents, waits on every agent this controller has running or has not yet handed off. Completion or input on any agent returns promptly for coordinator review, together with any coordinator messages; an unrelated running agent does not hold the handoff. On a timeout, each agent gets a short progress row; agent_inspect returns the full state. This only drives active coordination, not host wakeups after a turn ends.', object({
    ...workspace,
    agents: { type: 'array', minItems: 1, uniqueItems: true, items: string('Lane slug or QA agent name to wait on.') },
    timeout_seconds: integer('Maximum wait. It returns as soon as an agent finishes a turn, needs input or messages you. Defaults to 300 seconds.', 1, 600),
  }, ['workspace_path']), { readOnlyHint: true, openWorldHint: true }),

  tool('lab_run', 'Run a lab suite', 'Run lab/suites/<suite> against an exact revision of a lane, of the integration build or of base, in a clean runtime-owned clone, and record its verdict, output and artifacts. The suite runs from a snapshot of the lab working tree taken when the call starts, so lab edits made during the call reach only later calls. Only these runs count as evidence. A lane defaults to its committed HEAD or, when its own agent runs it, to a snapshot of its working tree, uncommitted changes included, taken without touching it; integration defaults to its HEAD; base defaults to the managed project HEAD, or the cached default revision. A pass resolves the open findings this suite reproduces on the tested lanes, which run.lanes lists: for integration, the current build\'s lanes its HEAD contains, or null (unknown, attributed to no lane) for any other integration revision. A finding found by a failure that tested several lanes resolves only on a pass that tests all of them. A lane or integration run of a suite that writes tests.json is compared test by test (vsBase) with the latest base run of that suite at the lane\'s base revision (for integration, the build\'s base) whose lab snapshot holds the same suite directory, one at the same snapshot first; labDiffers lists other lab files the two snapshots differ in. A call holds its agent until it returns or the host moves it to the background (Claude Code does after two minutes), so pass independent runs together in batch: runs on different targets execute at the same time, and up to three on one target in separate checkouts. Put timing-sensitive suites, such as benchmarks, and suites that need a fixed port or another machine-wide resource in a call of their own.', object({
    ...workspace,
    ...labRun,
    batch: {
      type: 'array', minItems: 1, maxItems: 8, items: object(labRun, ['suite', 'target']),
      description: 'Several runs in one call, instead of suite, target and revision; each returns its own verdict.',
    },
  }, ['workspace_path']), { destructiveHint: false }),

  tool('lab_get', 'Inspect the lab', 'List the lab suites, the 10 most recent runs, recorded mutant controls (mutants), suites whose runs on one target at one revision and lab snapshot both passed and failed (inconsistentVerdicts), the current integration build (with lastConflict, the conflict that stopped it, while that lane is pending) and, on request, findings; or return one run with its output tail, the path of its output log, its artifacts and, for a suite that writes tests.json, its vsBase comparison. While a run is running, its tail and log show the complete lines it has printed so far, updated about once a second. When older runs match, nextBeforeRun holds the before_run value for the next page, requested with the same suite and target; otherwise it is null. A returned run left running by a controller that exited becomes uncertain once no call holds its target; its processes may have outlived it.', object({
    ...workspace,
    run: string('Run id to return.'),
    before_run: string('Run id from nextBeforeRun: list the 10 runs recorded before it that match suite and target. It marks a position, not filters, so repeat suite and target. Not combined with run.'),
    suite: suite('Only list runs of this suite.'),
    target: { ...target, description: 'Only list runs and findings for this lane, integration (its runs, and findings on the lanes it includes) or base (control runs).' },
    findings: string('Include findings: open, or all.', { enum: ['open', 'all'] }),
  }, ['workspace_path']), { readOnlyHint: true, idempotentHint: true }),

  tool('finding_record', 'Record a finding', 'Create a finding on a lane, or update one by id; omitted fields keep their saved values. A new or reopened finding is sent to the lane agent as a message saying how to reproduce it.', object({
    ...workspace,
    ...feature,
    id: string('Existing finding id to update.'),
    title: string('Short statement of the defect; required for a new finding.'),
    body: string('Observed versus expected behavior and the evidence; required for a new finding.'),
    severity: string('blocking (the default) prevents integrating the lane; minor does not.', { enum: ['blocking', 'minor'] }),
    repro_suite: suite('Lab suite that reproduces the finding; a passing lab_run of it that tests this lane, and every lane of the failure it was found by, resolves it.'),
    status: string('Finding state. A passing lab_run of its repro suite resolves a finding; only the coordinator marks one resolved by hand. Use wontfix with a note for a judgment call.', { enum: ['open', 'resolved', 'wontfix'] }),
    note: string('Why the finding changed.'),
  }, ['workspace_path', 'feature']), { destructiveHint: false }),

  tool('integration_build', 'Build an integration', 'Reset the runtime-owned integration clone to base and merge the listed lanes in order. A lane contributes its committed HEAD (uncommitted files are left out and counted), or slug@ref an exact revision. When the clone still holds the recorded build of the same lane revisions on the same base, in any order, it is returned unchanged with reused: true and the runs already recorded at its head. Stops at the first conflict; a QA agent\'s conflicted merge stays in place for it to resolve, and the coordinator\'s is aborted. The conflict\'s laterConflicts lists later lanes that would also conflict merged alone onto the build so far, and laterLanes lists later lanes whose trees differ at the conflicting files from their merge base with the base.', object({
    ...workspace,
    features: { type: 'array', minItems: 1, maxItems: 50, items: string('Lane slug, or slug@ref.') },
    base: string('Optional project or repository ref; a lane\'s commit joins through features (slug@ref) instead. Defaults to the managed project HEAD, otherwise the refreshed default revision.'),
  }, ['workspace_path', 'features']), { destructiveHint: false, openWorldHint: true }),

  tool('integrate', 'Integrate into the project', 'Fast-forward the managed project to a lane or integration commit that has a passing lab run on a lane or integration (a base control run never counts) and no open blocking findings on the lanes it contains. Never pushes. For an adopted repository it publishes nothing: it returns the commit, its checkout path, a push command to run with the user’s authority and a fetch command for the user’s own clone, and delivers the commit when it has a passing lab run and no open blocking findings. On delivery it marks done each included lane whose agent is not in a turn, whose checkout is clean and whose HEAD is contained in the resulting project HEAD, or in the selected commit for an adopted repository; the rest keep their status and next action and are listed in remainingWork, and next names other agents still in a turn and unread messages to the coordinator.', object({
    ...workspace,
    target: target,
    revision: string('Optional exact revision. Defaults to the HEAD of a clean lane, or of the integration clone.'),
  }, ['workspace_path', 'target']), { destructiveHint: false }),
];

// Tools only workers have; their lab tools come from the coordinator surface.
const WORKER_ONLY_TOOLS = [
  tool('message_send', 'Message an agent', 'Send a message to a lane agent, a QA agent (such as qa) or the coordinator; the runtime delivers it.', object({
    ...workspace,
    to: string('Recipient: a lane slug, a QA agent name, or coordinator.', { pattern: '^[a-z][a-z0-9-]{0,62}$' }),
    message: string('What changed, what to test or fix, or what you need; self-contained.', { minLength: 1, maxLength: 20000 }),
  }, ['workspace_path', 'to', 'message']), { destructiveHint: false }),
  tool('lanes', 'List lanes', 'Every lane and QA agent: kind, title, status, agent status, checkout path, spec path, head commit, whether the checkout is dirty, and open findings.', object(workspace, ['workspace_path']), { readOnlyHint: true, idempotentHint: true }),
];

const workerHandlers = { message_send: sendAgentMessage, lanes: listLanes };

// The runtime addresses lanes and QA agents alike as features.
const byAgent = handler => ({ agent, ...args }) => handler({ ...args, feature: agent });

const handlers = {
  workspace_init: initializeWorkspace,
  project_create: initializeManagedProject,
  doctor: doctorWorkspace,
  feature_create: createFeature,
  qa_create: createQaAgent,
  feature_list: listFeatures,
  feature_get: getFeatureContext,
  async feature_update(args) {
    return await (['paused', 'archived'].includes(args.status) ? stopFeatureLane(args) : updateFeature(args));
  },
  work_update: updateWork,
  view: composeView,
  agent_start: byAgent(startFeatureAgent),
  agent_steer: byAgent(steerFeatureAgent),
  agent_inspect: byAgent(inspectFeatureAgent),
  agent_interrupt: byAgent(interruptFeatureAgent),
  agent_request_resolve: byAgent(resolveFeatureAgentRequest),
  agents_wait: ({ agents, ...args }) => waitFeatureAgents({ ...args, features: agents }),
  lab_run: runLabSuite,
  lab_get: getLab,
  finding_record: recordFinding,
  integration_build: buildIntegration,
  integrate,
};

// A worker's copy of the server: OVERDRIVE_AGENT and OVERDRIVE_WORKSPACE bind it to one agent;
// OVERDRIVE_WORKER alone is an inert copy of the plugin with no tools.
const workerAgent = () => process.env.OVERDRIVE_AGENT || null;
const inertWorker = () => !workerAgent() && Boolean(process.env.OVERDRIVE_WORKER);
const forbidden = message => new OverdriveError(message, 'WORKER_TOOL_FORBIDDEN');

function workerSchema(tool) {
  const { workspace_path: _workspace, ...properties } = tool.inputSchema.properties;
  return { ...tool, inputSchema: { ...tool.inputSchema, properties, required: tool.inputSchema.required.filter(key => key !== 'workspace_path') } };
}

const workerCaller = () => ({ from: safeSlug(workerAgent(), 'from'), workspace_path: process.env.OVERDRIVE_WORKSPACE });
const callerProfile = caller => agentProfile({ workspace_path: caller.workspace_path, agent: caller.from });

function ownLane(call, lane) {
  if (call?.target !== undefined && call.target !== lane) throw forbidden(`A feature agent may only target its own lane, ${lane}.`);
  return { ...call, target: lane };
}

// A worker lists the tools its kind may call, or every worker tool when its row cannot be read now;
// calls are checked either way.
export async function listTools() {
  if (inertWorker()) return [];
  if (!workerAgent()) return TOOLS;
  const profile = await callerProfile(workerCaller()).catch(() => null);
  return [...WORKER_ONLY_TOOLS, ...TOOLS].filter(tool => WORKER_TOOLS[tool.name] && (!profile || WORKER_TOOLS[tool.name].includes(profile))).map(workerSchema);
}

// The caller's kind comes from its recorded row, never from an argument. A feature agent's lab
// calls, and each run of its batch, always target its own lane.
async function callWorkerTool(name, args) {
  const access = WORKER_TOOLS[name];
  const handler = access && (workerHandlers[name] ?? handlers[name]);
  if (!handler) throw forbidden(`${name} is not available to OVERDRIVE workers.`);
  const caller = workerCaller();
  const profile = await callerProfile(caller);
  if (!access.includes(profile)) throw forbidden(`${name} is available to QA agents only.`);
  if (profile !== 'feature' || !name.startsWith('lab_')) return await handler({ ...args, ...caller });
  if (name === 'lab_run' && args.batch !== undefined) {
    return await handler({ ...args, ...caller, batch: Array.isArray(args.batch) ? args.batch.map(entry => ownLane(entry, caller.from)) : args.batch });
  }
  return await handler(ownLane({ ...args, ...caller }, caller.from));
}

export async function callTool(name, args) {
  if (inertWorker()) throw forbidden('This OVERDRIVE server runs inside a worker and exposes no tools.');
  if (workerAgent()) return await callWorkerTool(name, args ?? {});
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return await handler(args ?? {});
}
