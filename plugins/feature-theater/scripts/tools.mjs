import {
  checkpointFeature,
  createFeature,
  doctorWorkspace,
  getFeatureContext,
  initializeManagedProject,
  initializeWorkspace,
  listFeatures,
  planWork,
  promoteManagedCandidate,
  readTimeline,
  recordCandidate,
  recordEvidence,
  setFeatureStatus,
  switchFeature,
  updateSpec,
  updateWork,
} from './workspace.mjs';
import {
  compactFeatureAgent,
  compactOutgoingAfterSwitch,
  inspectFeatureAgent,
  interruptFeatureAgent,
  resolveFeatureAgentRequest,
  startFeatureAgent,
  steerFeatureAgent,
  waitFeatureAgent,
} from './agent-runtime.mjs';
import { readEvidence, runChecks, updateChecks } from './verification.mjs';
import { COMPONENTS, composeView, snapshotState } from './presentation.mjs';

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

const workspace = { workspace_path: string('Absolute path to the Feature Theater control workspace.') };
const feature = { feature: string('Feature slug, such as search-redesign.', { pattern: '^[a-z][a-z0-9-]{0,62}$' }) };
const view = {
  ...workspace, ...feature,
  components: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: string('Composable state component.', { enum: Object.keys(COMPONENTS) }), description: 'Choose components in display order. Defaults to features. Other components use the named or focused feature.' },
  include_archived: boolean('Include archived feature lanes in the overview.'),
};

export const TOOLS = [
  tool('theater_view_catalog', 'State component patterns', 'Discover composable conversation components and their data scope. Use the smallest composition that answers the user.', object({}), { readOnlyHint: true, idempotentHint: true }),
  tool('theater_state', 'Observe scoped feature state', 'Read a versioned, bounded snapshot for native conversation composition. Only load the selected components; a feature overview never loads other specifications or raw logs.', object(view, ['workspace_path']), { readOnlyHint: true, idempotentHint: true }),
  tool('theater_view', 'Compose state in conversation', 'Compose selected state components into an inline Codex conversation fragment. Returns its content reference and immutable snapshot. Buttons send follow-up requests through the meta agent; they never directly mutate runtime state.', object(view, ['workspace_path']), { destructiveHint: false }),
  tool('theater_checks_update', 'Configure feature checks', 'Save the required and optional verification commands for a feature. Changes invalidate earlier candidates; commands execute only through theater_checks_run.', object({
    ...workspace, ...feature,
    checks: { type: 'array', maxItems: 50, items: object({
      key: string('Stable check key.'), purpose: string('Behavior this command verifies.'),
      argv: { type: 'array', minItems: 1, items: string('Executable followed by its arguments; no implicit shell.') },
      kind: string('Evidence kind, such as test, typecheck, browser, integration.'),
      required: boolean('Whether a failure prevents completion; defaults to true.'),
      timeout_seconds: integer('Command deadline; defaults to 300 seconds.', 1, 1800),
    }, ['key', 'purpose', 'argv']) },
  }, ['workspace_path', 'feature', 'checks']), { destructiveHint: false }),

  tool('theater_checks_run', 'Execute feature checks', 'Run the configured commands against a clean committed idle feature. Record actual exits, bounded output, and the current spec/contract. Dirty output and failures cannot authorize a candidate.', object({ ...workspace, ...feature }, ['workspace_path', 'feature']), { destructiveHint: false, openWorldHint: true }),

  tool('theater_evidence_get', 'Inspect an evidence receipt', 'Read one feature-scoped evidence record including actual command output and exit status. Use on demand; do not preload logs into the coordinator.', object({ ...workspace, ...feature, evidence_id: string('Evidence id from checks, context, or state views.') }, ['workspace_path', 'feature', 'evidence_id']), { readOnlyHint: true, idempotentHint: true }),

  tool('theater_agent_wait', 'Wait for a feature result', 'Wait up to 60 seconds for a feature completion or input request and return compact progress. Use after dispatch when the coordinator is continuing the work; no repeated model polling is needed.', object({ ...workspace, ...feature, timeout_seconds: integer('Bounded wait; defaults to 30 seconds.', 1, 60) }, ['workspace_path', 'feature']), { readOnlyHint: true, openWorldHint: true }),

  tool('theater_initialize', 'Initialize Feature Theater', 'Adopt a Git repository in a control workspace. Creates a private bare cache and durable local state; it does not run repository setup scripts.', object({
    ...workspace,
    repository: string('Credential-free Git URL, SSH remote, or absolute local repository path.'),
  }, ['workspace_path', 'repository']), { destructiveHint: false, idempotentHint: true, openWorldHint: true }),

  tool('theater_project_create', 'Create managed project', 'Start a new project from scratch inside the control workspace, create its initial Git commit, and initialize Feature Theater against it.', object({
    ...workspace,
    project_name: string('Human-readable project name.'),
    description: string('Concrete product brief for the new project.'),
    default_branch: string('Initial branch name; defaults to main.'),
  }, ['workspace_path', 'project_name', 'description']), { destructiveHint: false, idempotentHint: true }),

  tool('theater_doctor', 'Check Feature Theater', 'Check the local Git, Node, Codex, state database, and repository cache needed by this workspace.', object(workspace, ['workspace_path']), { readOnlyHint: true, idempotentHint: true }),

  tool('theater_feature_create', 'Create feature lane', 'Create an independent full repository clone at an exact commit and initialize its isolated spec/context packet.', object({
    ...workspace,
    ...feature,
    title: string('Human-readable feature title.'),
    outcome: string('Concrete outcome this lane must enable.'),
    base_revision: string('Optional branch, tag, or commit. The refreshed default revision is used when omitted.'),
    priority: integer('Relative feature priority.', -100, 100),
    spec: string('Optional complete initial Markdown specification.'),
  }, ['workspace_path', 'feature', 'title', 'outcome']), { destructiveHint: false, openWorldHint: true }),

  tool('theater_feature_list', 'List feature lanes', 'Return a compact cross-feature progress view without loading every feature specification.', object({
    ...workspace,
    include_archived: boolean('Include archived lanes.'),
    refresh_git: boolean('Refresh Git status for each clone; slower on many features.'),
  }, ['workspace_path']), { readOnlyHint: true, idempotentHint: true }),

  tool('theater_feature_get', 'Inspect feature lane', 'Load one feature only: current spec, work DAG, checkpoint, safe timeline, Git facts, evidence, candidate, and pending agent requests.', object({
    ...workspace,
    ...feature,
    timeline_limit: integer('Number of recent safe events.', 1, 200),
  }, ['workspace_path', 'feature']), { readOnlyHint: true, idempotentHint: true }),

  tool('theater_spec_update', 'Save feature spec revision', 'Save a complete new Markdown spec revision and report its logical line delta. Use after iterating on behavior, constraints, acceptance criteria, and scope with the user.', object({
    ...workspace,
    ...feature,
    content: string('Complete Markdown specification for the new revision.'),
    rationale: string('Concise reason this revision changed.'),
  }, ['workspace_path', 'feature', 'content']), { destructiveHint: false }),

  tool('theater_work_plan', 'Reconcile feature work graph', 'Upsert bounded work items and their dependencies. Existing completed work cannot be silently reopened; represent regressions or follow-up as repair work.', object({
    ...workspace,
    ...feature,
    items: {
      type: 'array', minItems: 1, maxItems: 200,
      items: object({
        key: string('Stable item key such as design-api or T-001.'),
        title: string('Short work title.'),
        description: string('Bounded assignment or transformation.'),
        kind: string('Work phase.', { enum: ['scope', 'design', 'build', 'review', 'validate', 'repair', 'integrate'] }),
        priority: integer('Relative item priority.', -100, 100),
        acceptance: string('Observable acceptance criteria.'),
        dependencies: { type: 'array', items: string('A prerequisite work item key.'), maxItems: 100 },
      }, ['key', 'title']),
    },
  }, ['workspace_path', 'feature', 'items']), { destructiveHint: false }),

  tool('theater_work_update', 'Update work item', 'Change one work item state, enforce ownership leases, and record result or blocker details.', object({
    ...workspace,
    ...feature,
    key: string('Stable work item key.'),
    status: string('New work state.', { enum: ['planned', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled'] }),
    owner: string('Required owner identifier when starting work.'),
    summary: string('Required result summary when completing work.'),
    blocker: string('Required blocker/failure detail for blocked or failed work.'),
    result_revision: string('Exact resulting Git revision when one exists.'),
    lease_seconds: integer('Running ownership lease duration.', 60, 86400),
  }, ['workspace_path', 'feature', 'key', 'status']), { destructiveHint: false }),

  tool('theater_checkpoint', 'Checkpoint feature context', 'Write a compact semantic checkpoint plus exact Git facts. Call before switching features and at major milestones.', object({
    ...workspace,
    ...feature,
    summary: string('What is now true and why it matters; no private reasoning.'),
    next_action: string('Single most useful next action.'),
    unresolved: { type: 'array', items: string('Open decision, risk, or blocker.'), maxItems: 100 },
  }, ['workspace_path', 'feature', 'summary', 'next_action']), { destructiveHint: false }),

  tool('theater_feature_switch', 'Switch feature focus', 'Switch coordinator focus after an outgoing checkpoint. Queues feature-session compaction, returns the destination recovery packet, and signals a high-value coordinator compaction boundary.', object({
    ...workspace,
    ...feature,
  }, ['workspace_path', 'feature']), { destructiveHint: false, idempotentHint: true, openWorldHint: true }),

  tool('theater_feature_status', 'Set feature lifecycle state', 'Pause, resume, block, review, complete, or archive a lane without moving its checkout. Completion requires closed work and passing evidence.', object({
    ...workspace,
    ...feature,
    status: string('Lifecycle state.', { enum: ['planned', 'active', 'paused', 'blocked', 'review', 'done', 'archived'] }),
    blocker: string('Required when blocking.'),
    disposition: string('Required when archiving; state what shipped or remains.'),
  }, ['workspace_path', 'feature', 'status']), { destructiveHint: false }),

  tool('theater_evidence_record', 'Record feature evidence', 'Record an actually executed check, artifact inspection, review, or other evidence at an exact revision when available.', object({
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

  tool('theater_candidate_record', 'Record integration candidate', 'Verify and record the exact current HEAD as a reviewable candidate with executed checks. Does not push, open a PR, or merge.', object({
    ...workspace,
    ...feature,
    revision: string('Candidate commit; defaults to HEAD.'),
    summary: string('What the candidate changes and why it is ready.'),
    checks: { type: 'array', minItems: 1, maxItems: 100, items: string('Executed check and outcome.') },
    allow_dirty: boolean('Deprecated: true is refused because evidence must describe a clean commit.'),
  }, ['workspace_path', 'feature', 'summary', 'checks']), { destructiveHint: false }),

  tool('theater_candidate_promote', 'Promote managed-project candidate', 'Fast-forward a Feature Theater-created canonical project to an accepted feature candidate. Refuses dirty, stale, unproven, or divergent state and never pushes remotely.', object({
    ...workspace,
    ...feature,
    revision: string('Accepted candidate revision; defaults to the latest accepted candidate.'),
    summary: string('Optional concise promotion disposition.'),
  }, ['workspace_path', 'feature']), { destructiveHint: true, idempotentHint: true }),

  tool('theater_agent_start', 'Start feature agent', 'Start or resume the lane-specific GPT-6 Astra Codex task with only that feature context and the repository instructions.', object({
    ...workspace,
    ...feature,
    instruction: string('Optional immediate direction; otherwise the checkpoint next action is used.'),
    effort: string('GPT-6 Astra reasoning effort.', { enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
    force_new_session: boolean('Create a replacement task instead of resuming the recorded one.'),
  }, ['workspace_path', 'feature']), { destructiveHint: false, openWorldHint: true }),

  tool('theater_agent_inspect', 'Inspect feature agent', 'Refresh and return safe native-task progress plus Git/evidence state. Private reasoning items are filtered.', object({
    ...workspace,
    ...feature,
    include_thread: boolean('Read the persisted native Codex task as well as local Theater state.'),
  }, ['workspace_path', 'feature']), { readOnlyHint: true, idempotentHint: true, openWorldHint: true }),

  tool('theater_agent_steer', 'Steer feature agent', 'Deliver a revision to the active turn, or start a follow-up turn when the lane task is idle.', object({
    ...workspace,
    ...feature,
    instruction: string('Clear replacement, correction, constraint, or follow-up direction.'),
    effort: string('Reasoning effort for a new follow-up turn.', { enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }),
  }, ['workspace_path', 'feature', 'instruction']), { destructiveHint: false, openWorldHint: true }),

  tool('theater_agent_compact', 'Compact feature agent', 'Compact an idle feature task at its durable checkpoint. If a turn is active, leave compaction queued.', object({ ...workspace, ...feature }, ['workspace_path', 'feature']), { destructiveHint: false, idempotentHint: true, openWorldHint: true }),

  tool('theater_agent_interrupt', 'Interrupt feature agent', 'Interrupt an active feature turn while preserving the task and checkout.', object({ ...workspace, ...feature }, ['workspace_path', 'feature']), { destructiveHint: true, openWorldHint: true }),

  tool('theater_agent_request_resolve', 'Resolve feature agent request', 'Relay the user-approved answer to a pending command, permission, elicitation, or input request from the feature task.', object({
    ...workspace,
    ...feature,
    request_id: string('Opaque pending request identifier returned by inspection.'),
    action: string('Resolution action.', { enum: ['accept', 'accept_session', 'decline', 'cancel', 'respond'] }),
    response: { type: 'object', description: 'Structured response for a question or elicitation.', additionalProperties: true },
    scope: string('Permission grant scope.', { enum: ['turn', 'session'] }),
  }, ['workspace_path', 'feature', 'request_id', 'action']), { destructiveHint: false, openWorldHint: true }),

  tool('theater_timeline', 'Read safe feature timeline', 'Read the append-only user-visible activity timeline for one feature. It never contains private chain-of-thought.', object({
    ...workspace,
    ...feature,
    limit: integer('Number of recent events.', 1, 200),
  }, ['workspace_path', 'feature']), { readOnlyHint: true, idempotentHint: true }),
];

const handlers = {
  theater_view_catalog: () => ({ schemaVersion: 1, components: COMPONENTS, patterns: { overview: ['features'], feature: ['work', 'handoff'], delivery: ['evidence', 'handoff'], refinement: ['spec', 'work'], progress: ['activity', 'handoff'] } }),
  theater_state: snapshotState,
  theater_view: composeView,
  theater_checks_update: updateChecks,
  theater_checks_run: runChecks,
  theater_evidence_get: readEvidence,
  theater_agent_wait: waitFeatureAgent,
  theater_initialize: initializeWorkspace,
  theater_project_create: initializeManagedProject,
  theater_doctor: doctorWorkspace,
  theater_feature_create: createFeature,
  theater_feature_list: listFeatures,
  theater_feature_get: getFeatureContext,
  theater_spec_update: updateSpec,
  theater_work_plan: planWork,
  theater_work_update: updateWork,
  theater_checkpoint: checkpointFeature,
  async theater_feature_status(args) {
    const result = await setFeatureStatus(args);
    if (['paused', 'archived'].includes(args.status) && result.feature.agent.activeTurnId) {
      result.interruption = await interruptFeatureAgent(args);
    }
    return result;
  },
  theater_evidence_record: recordEvidence,
  theater_candidate_record: recordCandidate,
  theater_candidate_promote: promoteManagedCandidate,
  theater_agent_start: startFeatureAgent,
  theater_agent_inspect: inspectFeatureAgent,
  theater_agent_steer: steerFeatureAgent,
  theater_agent_compact: compactFeatureAgent,
  theater_agent_interrupt: interruptFeatureAgent,
  theater_agent_request_resolve: resolveFeatureAgentRequest,
  theater_timeline: readTimeline,
  async theater_feature_switch(args) {
    const result = await switchFeature(args);
    if (result.compactFeatureThreadId) {
      try { result.featureSessionCompaction = await compactOutgoingAfterSwitch(result, args.workspace_path); }
      catch (error) { result.featureSessionCompaction = { attempted: true, compacted: false, warning: error.message }; }
    }
    if (result.coordinatorCompactionRecommended) {
      result.coordinatorCompaction = {
        semanticCheckpoint: true,
        nativeCommand: '/compact',
        automatic: false,
        reason: 'Codex does not expose the currently loaded host task to its MCP process. Run /compact after the switch response when the outgoing lane contributed substantial context.',
      };
    }
    return result;
  },
};

export async function callTool(name, args) {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return await handler(args ?? {});
}
