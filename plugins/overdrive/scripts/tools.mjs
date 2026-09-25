import {
  createFeature,
  doctorWorkspace,
  getFeatureContext,
  initializeManagedProject,
  initializeWorkspace,
  listFeatures,
  promoteManagedCandidate,
  recordCandidate,
  recordEvidence,
  updateFeature,
  updateWork,
} from './workspace.mjs';
import {
  compactFeatureAgent,
  inspectFeatureAgent,
  interruptFeatureAgent,
  resolveFeatureAgentRequest,
  startFeatureAgent,
  steerFeatureAgent,
  stopFeatureLane,
  waitFeatureAgent,
  waitFeatureAgents,
} from './agent-runtime.mjs';
import { readEvidence, runChecks, updateChecks } from './verification.mjs';
import { enqueueChecks, inspectCheckQueue, drainCheckQueue, resolveCheckJob } from './check-queue.mjs';
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
  tool('agents_wait', 'Receive the next feature handoff', 'Wait on up to eight unreconciled feature workers together. Completion or input on any lane returns promptly for coordinator review; an unrelated running lane does not hold the handoff. This only drives active coordination, not host wakeups after a turn ends.', object({
    ...workspace,
    features: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: string('Feature slug still awaiting reconciliation; omit already handled idle lanes.') },
    timeout_seconds: integer('Bounded wait, defaults to 30 seconds.', 1, 60),
  }, ['workspace_path', 'features']), { readOnlyHint: true, openWorldHint: true }),
  tool('checks_enqueue', 'Queue authorized verification', 'Bind reviewed configured checks to their current clean commit and full contract. One check per job; stable keys make identical enqueue requests idempotent. Dependencies stop on failure; the same clone and named shared resources serialize. The queue keeps up to 500 jobs; beyond that the oldest unreferenced passed or cancelled jobs are retired to the event log, keeping their receipts.', object({
    ...workspace,
    jobs: { type: 'array', minItems: 1, maxItems: 50, items: object({
      key: string('Unique durable job key. Use a new key for a changed revision or plan.'), ...feature,
      check_key: string('Exact configured check key.'),
      depends_on: { type: 'array', maxItems: 50, uniqueItems: true, items: string('Prerequisite job key in this queue or batch.') },
      resources: { type: 'array', maxItems: 20, uniqueItems: true, items: string('Shared exclusive resource key, such as port-4200 or gpu-benchmark. External commands must be coordinated separately.') },
    }, ['key', 'feature', 'check_key']) },
  }, ['workspace_path', 'jobs']), { destructiveHint: false, idempotentHint: true }),
  tool('checks_queue', 'Inspect verification queue', 'Read durable jobs, timings, receipts and blockers; reconcile a dead controller with exact completed receipts or quarantine uncertain execution. Does not execute checks.', object(workspace, ['workspace_path']), { destructiveHint: false, idempotentHint: true }),
  tool('checks_drain', 'Advance ready verification', 'Execute eligible jobs and immediately release successors. Failures stop dependents, while disjoint ready jobs continue. Returns completion and decision handoffs for prompt coordinator reconciliation; never launches feature workers or accepts candidates.', object({
    ...workspace,
    max_parallel: integer('Concurrent jobs; defaults to 2. Same-clone and shared-resource exclusion always applies.', 1, 4),
    max_checks: integer('Maximum admissions in this call; defaults to 10.', 1, 50),
    admission_seconds: integer('Stop admitting new jobs after this many seconds, default 60. Already admitted checks finish under their configured deadlines; this is not a call timeout.', 1, 300),
  }, ['workspace_path']), { destructiveHint: false, openWorldHint: true }),
  tool('checks_resolve', 'Resolve stopped verification', 'After inspecting a failure or interrupted command, explicitly retry its unchanged binding or cancel it. Changed commits/contracts require new jobs. Interrupted execution, including a direct checks_run job whose command was not confirmed stopped, retains resources until command termination is established.', object({
    ...workspace, job_key: string('Queue job key.'), action: string('Resolution.', { enum: ['retry', 'cancel'] }),
    reason: string('Observed cause and resolution; for interruption, include how command and child-process termination was established.'),
    execution_stopped: boolean('Required true for interrupted jobs, only after verifying the old command and children stopped.'),
  }, ['workspace_path', 'job_key', 'action', 'reason']), { destructiveHint: false }),
  tool('view', 'Show the work graph', 'Render one feature’s actual work dependencies and statuses as a native Mermaid diagram. No embedded chat, forms, navigation, or action buttons. Returns Markdown to include directly in the reply.', object({
    ...workspace, ...feature,
    work_items: { type: 'array', minItems: 1, maxItems: 24, uniqueItems: true, items: string('Exact work key.'), description: 'Optional focused subset for a large graph. Dependencies outside the view remain labeled. Without this, show all work when there are at most 24 items; larger graphs show 24 at a time, running, blocked, failed, review and ready work first, then their prerequisites, then the rest.' },
    page: integer('Optional 24-item page of the default large-graph order, starting at 1. Each call reflects current state; after work status changes, start again at page 1 because page membership may shift. Cannot be combined with work_items.', 1, 1000),
  }, ['workspace_path', 'feature']), { readOnlyHint: true, idempotentHint: true }),
  tool('checks_update', 'Configure feature checks', 'Save the required and optional verification commands for a feature. Commands execute in the submitted order, so list setup before dependent checks; reordering changes the contract. Changes invalidate earlier candidates; execute through checks_run or the verification queue.', object({
    ...workspace, ...feature,
    checks: { type: 'array', maxItems: 50, items: object({
      key: string('Stable check key.'), purpose: string('Behavior this command verifies.'),
      argv: { type: 'array', minItems: 1, items: string('Executable followed by its arguments; no implicit shell.') },
      kind: string('Evidence kind, such as test, typecheck, browser, integration.'),
      required: boolean('Whether a failure prevents completion; defaults to true.'),
      timeout_seconds: integer('Command deadline; defaults to 300 seconds.', 1, 1800),
      reuse_same_revision: boolean('Opt in only for a standalone check whose non-Git inputs are immutable and bound by its command or spec/work contract. Preserve exact same-revision proof across unrelated check changes. Do not enable for mutable shared setup or opaque external inputs.'),
      work_scope: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: string('Exact existing work item key.'), description: 'Optional prospective work binding for an independent reuse_same_revision check: selected definitions plus all transitive prerequisites. Omit to bind all work. Adding or changing scope requires new proof; unrelated work cannot inherit its receipt. Full spec and exact source binding remain required.' },
      artifact_paths: { type: 'array', maxItems: 20, items: string('Existing output file or directory to retain after this check, relative to its checkout. No globs, overlapping paths, Git metadata, or symlinks.'), description: 'Optional artifact collection contract. Copy these paths into the receipt archive before the next check. Missing paths or copy errors fail the receipt and stop remaining checks.' },
    }, ['key', 'purpose', 'argv']) },
  }, ['workspace_path', 'feature', 'checks']), { destructiveHint: false }),

  tool('checks_run', 'Execute feature checks', 'Run configured commands against a clean committed idle feature, stopping at the first failure for inspection. An optional selection controls execution only; readiness still requires current passing receipts for every required check in the saved contract. A timed-out command whose process tree cannot be confirmed stopped fails with COMMAND_TERMINATION_UNCERTAIN and no receipt; its interrupted job then reserves the clone until checks_resolve.', object({
    ...workspace, ...feature,
    check_keys: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: string('Exact configured check key.'), description: 'Optional nonempty selection of known checks, executed in saved order. Omit to run all. Does not edit the contract or create receipts for omitted checks.' },
  }, ['workspace_path', 'feature']), { destructiveHint: false, openWorldHint: true }),

  tool('evidence_get', 'Inspect an evidence receipt', 'Read one feature-scoped evidence record including actual command output and exit status. Use on demand; do not preload logs into the coordinator.', object({ ...workspace, ...feature, evidence_id: string('Evidence id from checks or feature context.') }, ['workspace_path', 'feature', 'evidence_id']), { readOnlyHint: true, idempotentHint: true }),

  tool('agent_wait', 'Wait for a feature result', 'Wait up to 60 seconds for a feature completion or input request and return compact progress. Use after dispatch when the coordinator is continuing the work; no repeated model polling is needed.', object({ ...workspace, ...feature, timeout_seconds: integer('Bounded wait; defaults to 30 seconds.', 1, 60) }, ['workspace_path', 'feature']), { readOnlyHint: true, openWorldHint: true }),

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

  tool('feature_get', 'Inspect feature lane', 'Load one feature only: current spec, work DAG, safe timeline, Git facts, evidence, candidate, and pending agent requests.', object({
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

  tool('evidence_record', 'Record feature evidence', 'Record an actually executed check, artifact inspection, review, or other evidence at an exact revision when available.', object({
    ...workspace,
    ...feature,
    work_item: string('Optional associated work item key.'),
    kind: string('Evidence kind, such as test, typecheck, browser, review, or benchmark.'),
    summary: string('Observed result, including relevant limitations.'),
    command: string('Exact command when one was executed.'),
    artifact: string('Artifact or report path.'),
    revision: string('Exact Git revision the evidence applies to.'),
    passed: boolean('Whether this is passing or failing evidence; omit for a neutral note.'),
  }, ['workspace_path', 'feature', 'kind', 'summary']), { destructiveHint: false }),

  tool('candidate_record', 'Record integration candidate', 'Verify and record the exact current HEAD as a reviewable candidate. Its checks are derived only from the executed receipts for that revision and current contract, one "key: outcome · receipt id" string each; caller text is never counted or shown as an executed check. A paused or archived lane is refused until it is made active again. Does not push, open a PR, or merge.', object({
    ...workspace,
    ...feature,
    revision: string('Candidate commit; defaults to HEAD.'),
    summary: string('What the candidate changes and why it is ready.'),
    checks: { type: 'array', maxItems: 100, items: string('Optional reviewer note.'), description: 'Optional caller notes, echoed only as unverifiedNotes in the response and timeline event. They are never stored, counted or shown as the candidate\'s executed checks; those come only from runtime receipts.' },
    allow_dirty: boolean('Deprecated: true is refused because evidence must describe a clean commit.'),
  }, ['workspace_path', 'feature', 'summary']), { destructiveHint: false }),

  tool('candidate_promote', 'Promote managed-project candidate', 'Fast-forward an OVERDRIVE-created canonical project to a recorded feature candidate. Refuses dirty, stale, unproven, or divergent state and never pushes remotely.', object({
    ...workspace,
    ...feature,
    revision: string('Candidate revision; defaults to the latest recorded candidate.'),
    summary: string('Optional concise promotion disposition.'),
  }, ['workspace_path', 'feature']), { destructiveHint: true, idempotentHint: true }),

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

  tool('agent_compact', 'Compact feature agent', 'Compact an idle feature task. If a turn is active, leave compaction queued.', object({ ...workspace, ...feature }, ['workspace_path', 'feature']), { destructiveHint: false, idempotentHint: true, openWorldHint: true }),

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

const handlers = {
  view: composeView,
  checks_update: updateChecks,
  checks_run: runChecks,
  checks_enqueue: enqueueChecks,
  checks_queue: inspectCheckQueue,
  checks_drain: drainCheckQueue,
  checks_resolve: resolveCheckJob,
  evidence_get: readEvidence,
  agent_wait: waitFeatureAgent,
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
  evidence_record: recordEvidence,
  candidate_record: recordCandidate,
  candidate_promote: promoteManagedCandidate,
  agent_start: startFeatureAgent,
  agent_inspect: inspectFeatureAgent,
  agent_steer: steerFeatureAgent,
  agent_compact: compactFeatureAgent,
  agent_interrupt: interruptFeatureAgent,
  agent_request_resolve: resolveFeatureAgentRequest,
};

export async function callTool(name, args) {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return await handler(args ?? {});
}
