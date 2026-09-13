---
name: feature-theater
description: Coordinate multiple isolated feature clones inside Codex with GPT-6 Astra. Use when the user wants to adopt a repository or start a managed project from scratch, create or switch feature lanes, iteratively develop feature specs, list or inspect feature progress, start/steer/interrupt feature agents, checkpoint context, record evidence, prepare or promote a tested candidate, or avoid cross-feature context pollution. Also use when the user says Feature Theater, Agent Diff Theater, Diffmogger, or feature clone. Do not use for an ordinary single-repository edit that does not need feature-lane orchestration.
---

# Feature Theater

Feature Theater makes Codex the entire orchestration interface. The MCP runtime owns deterministic state, clones, work dependencies, checkpoints, and exact evidence. You own product judgment: refine intent, decide the next useful work, interpret results, and explain choices. Dedicated GPT-6 Astra tasks implement individual features.

Never expose or request private chain-of-thought. Safe progress consists of explicit user directions, visible plans and messages, Git facts, executed evidence, and concise action/rationale summaries.

## Establish the workspace

Use the current control-workspace absolute path for every tool call. If `theater.json` is absent and the user supplied a repository URL/path, call `theater_initialize`. Initialization clones a private mirror and profiles the repository but deliberately does not execute setup scripts. New control workspaces default to GPT-6 Astra through their local Codex configuration; existing configuration and the user's explicit model choice remain authoritative.

If the user wants a new project rather than an existing repository, infer a concise project name and product brief from their request and call `theater_project_create`. It creates `project/` as the managed canonical Git repository with a minimal initial commit, then initializes the same lane workflow. Ask only for the missing product outcome when the request does not establish one; do not force the user to invent a repository first. If neither an existing source nor scratch-project intent is clear, ask whether to use a repository URL/path or start from a brief.

Run `theater_doctor` after initialization or when Git, Codex, state, or the repository cache appears unhealthy. Do not work around a partial `.theater` directory by deleting it; inspect and preserve recoverable state.

## Create and specify a feature

For a new idea:

1. Translate the desired outcome into a short slug, title, and concrete outcome. Resolve routine naming yourself.
2. Call `theater_feature_create`. This creates a self-contained clone at an exact refreshed commit.
3. Develop the specification conversationally. Cover user-visible behavior, constraints/compatibility, acceptance criteria, non-goals, and genuinely unresolved decisions. Avoid implementation detail that does not constrain the result.
4. Call `theater_spec_update` with the complete revised Markdown. Each call is a durable revision, so do not save cosmetic churn.
5. For work needing independent stages or evidence gates, call `theater_work_plan` with a small DAG. Use scope/design/build/review/validate/repair/integrate only where those boundaries are meaningful. Skip elaborate decomposition for a single coherent change.

Use `theater_work_update` to claim running work and to record real outcomes with the same owner while its lease is live. Preserve failure history and add bounded repair work when the assignment changes. An unchanged assignment may be retried after a transient failure. Do not regenerate a plan merely to change progress labels.

Choose meaningful required commands with `theater_checks_update`, using the repository's existing checks and the feature's acceptance criteria. Routine implementation choices belong to Astra; ask only about decisions that materially change the product or require authority the user has not supplied. Do not replace substantive checks with trivial commands to satisfy a gate.

## Start and control the feature task

Call `theater_agent_start` only after the feature has enough specification to act responsibly. It starts or resumes a dedicated GPT-6 Astra task whose working directory is that feature's clone. The task receives only the feature packet, current spec, and repository instructions. It may use native subagents for truly independent bounded work; do not force fan-out for small or dependent work.

One start or steer represents one bounded agent turn. After it finishes, reconcile the handoff with Git and executed evidence before starting another turn; do not create an automatic retry loop around stale context.

For a request to build or finish a feature, continue coordinating until the requested outcome is verified or a necessary user decision remains. After dispatch, use `theater_agent_wait` for completion/input events and concise progress, then reconcile and choose the next useful action. A completed worker turn is not necessarily a completed feature. Continue independent lanes while a real user request remains pending. For scheduled or unattended follow-up after the current conversation turn, use Codex's automation mechanism.

Use:

- `theater_agent_inspect` for safe visible progress, exact Git state, evidence, and pending user requests.
- `theater_agent_wait` for a bounded wait after dispatch, without repeatedly calling the model to poll.
- `theater_agent_steer` to revise an active turn immediately; when idle it starts a contextual follow-up turn.
- `theater_agent_interrupt` only when the user wants the active turn stopped.
- `theater_agent_request_resolve` only after the user has authorized the exact command, permission, or answer. Never infer approval for remote publication, destructive cleanup, or broader filesystem/network access.

The runtime detects an ended controller process, clears its stale active-turn state, and preserves the native task and checkout for resumption. If another live coordinator owns a running turn, use that session or wait for the turn to finish; do not launch a competing worker in the same checkout. A pause requests interruption and preserves the partial work. Inspect when the user asks, before a consequential decision, after a completion signal, or when a dependent action needs the result.

## Switch without context pollution

For a real focus change:

1. Inspect the outgoing lane if its state may have changed.
2. Call `theater_checkpoint` with what is now true, one next action, and unresolved decisions/risks. A checkpoint is a semantic handoff, not a transcript.
3. Call `theater_feature_switch`.
4. The runtime compacts the outgoing feature task when it is idle, or keeps compaction queued until an idle boundary. The saved checkpoint is the coordinator's semantic compaction boundary. Codex does not currently let an MCP process compact the already-loaded host task, so when the outgoing lane contributed substantial context, end the concise switch confirmation by recommending `/compact` once. Afterward, recover only from `.theater/index.md` and the destination packet.
5. Load the destination with `theater_feature_get`. Do not preload every other feature spec. Use `theater_feature_list` for the cross-feature overview.

Switching coordinator focus does not change feature lifecycle or pause independent tasks. A paused destination stays paused until the user requests resumption.

## Express state with conversation components

Use [state component patterns](references/state-components.md) when a view helps the user compare features, inspect dependencies or evidence, recover a handoff, or steer. Compose only the relevant primitives using `theater_view`; embed the returned content reference in the response. Use `theater_state` for bounded data when a custom composition would better answer the question. The snapshot timestamp and data scope are part of the contract. Views send actions back through the meta conversation and never bypass canonical tools.

## Evidence and delivery

Treat agent reports as claims. `theater_evidence_record` stores reported observations, reviews, artifacts, and limitations; it does not turn a claim into an executed receipt. When a worker finishes, inspect its actual diff and commit only the intended feature changes using ordinary Git operations in that identified checkout when authorized by the user's workflow. The worker sandbox can protect Git metadata; handle that local commit in the coordinator instead of repeatedly asking the user for broader worker permissions. Once the worker is idle and the changes are committed, run `theater_checks_run`. The runtime captures actual commands, exits, bounded output, the spec/work/check contract, and the exact Git revision. Use `theater_evidence_get` for an individual receipt's output when a failure or review needs it. A typecheck does not prove runtime behavior; choose checks that exercise the changed behavior.

Use `theater_candidate_record` only for the exact checkout HEAD after relevant checks. It verifies revision identity and cleanliness and records a reviewable candidate; it never pushes, opens a pull request, merges, or publishes. Those remain normal Git/Codex operations requiring the user's authority.

Mark a feature done only after its non-cancelled work is closed, the agent is idle, a ready candidate still matches the clean checkout HEAD and current contract, and every required command has a latest passing execution receipt. Spec, work-contract, or check-definition changes invalidate previous candidates. Optional failures and review limitations remain visible and must be assessed. Legacy manually recorded passes need fresh executed checks. Archive only with a disposition that states what shipped and what remains.

For a project created by `theater_project_create`, an explicit user request to accept or promote completed work may call `theater_candidate_promote`. Promotion is deliberately fast-forward-only: it updates the local managed `project/` repository and refreshes the source mirror, so the next lane starts from the accepted revision. If histories diverged or the canonical project is dirty, stop and resolve that state visibly; never synthesize a merge or discard work. Adopted repositories continue through their normal PR/integration flow.

## Natural command vocabulary

Users do not need to memorize tools. Interpret requests such as these directly:

- “Use Feature Theater with `<repo-url>`.”
- “Start a new project called Atlas that helps teams triage incidents.”
- “Clone a feature for team search and help me spec it.”
- “List everything active and what is blocked.”
- “Switch to billing recovery.”
- “What has the search agent changed?”
- “Tell it to preserve the public API and skip the cache migration.”
- “Checkpoint this, compact, and go back to onboarding.”
- “Record the tested HEAD as the candidate.”
- “Accept this candidate into the managed project and start the next feature from it.”

Lead with the useful result in user-facing replies: current lane, material progress/change, blocker or decision, and next action. Keep tool mechanics secondary.
