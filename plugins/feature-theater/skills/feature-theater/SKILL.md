---
name: feature-theater
description: Coordinate multiple isolated feature clones inside Codex with GPT-6 Astra. Use when the user wants to initialize a repository workspace, create or switch feature lanes, iteratively develop feature specs, list or inspect feature progress, start/steer/interrupt feature agents, checkpoint context, record evidence, or prepare a tested candidate. Also use when the user says Feature Theater, Agent Diff Theater, Diffmogger, feature clone, or asks to avoid cross-feature context pollution. Do not use for an ordinary single-repository edit that does not need feature-lane orchestration.
---

# Feature Theater

Feature Theater makes Codex the entire orchestration interface. The MCP runtime owns deterministic state, clones, work dependencies, checkpoints, and exact evidence. You own product judgment: refine intent, decide the next useful work, interpret results, and explain choices. Dedicated GPT-6 Astra tasks implement individual features.

Never expose or request private chain-of-thought. Safe progress consists of explicit user directions, visible plans and messages, Git facts, executed evidence, and concise action/rationale summaries.

## Establish the workspace

Use the current control-workspace absolute path for every tool call. If `theater.json` is absent and the user supplied a repository URL/path, call `theater_initialize`. Initialization clones a private mirror and profiles the repository but deliberately does not execute setup scripts. If the repository is missing, ask only for that URL/path.

Run `theater_doctor` after initialization or when Git, Codex, state, or the repository cache appears unhealthy. Do not work around a partial `.theater` directory by deleting it; inspect and preserve recoverable state.

## Create and specify a feature

For a new idea:

1. Translate the desired outcome into a short slug, title, and concrete outcome. Resolve routine naming yourself.
2. Call `theater_feature_create`. This creates a self-contained clone at an exact refreshed commit.
3. Develop the specification conversationally. Cover user-visible behavior, constraints/compatibility, acceptance criteria, non-goals, and genuinely unresolved decisions. Avoid implementation detail that does not constrain the result.
4. Call `theater_spec_update` with the complete revised Markdown. Each call is a durable revision, so do not save cosmetic churn.
5. For work needing independent stages or evidence gates, call `theater_work_plan` with a small DAG. Use scope/design/build/review/validate/repair/integrate only where those boundaries are meaningful. Skip elaborate decomposition for a single coherent change.

Use `theater_work_update` to claim running work and to record real outcomes. A failed item stays failed; add a bounded repair item rather than rewriting history. Ownership leases prevent duplicate concurrent work.

## Start and control the feature task

Call `theater_agent_start` only after the feature has enough specification to act responsibly. It starts or resumes a dedicated GPT-6 Astra task whose working directory is that feature's clone. The task receives only the feature packet, current spec, and repository instructions. It may use native subagents for truly independent bounded work; do not force fan-out for small or dependent work.

One start or steer represents one bounded agent turn. After it finishes, reconcile the handoff with Git and executed evidence before starting another turn; do not create an automatic retry loop around stale context.

Use:

- `theater_agent_inspect` for safe visible progress, exact Git state, evidence, and pending user requests.
- `theater_agent_steer` to revise an active turn immediately; when idle it starts a contextual follow-up turn.
- `theater_agent_interrupt` only when the user wants the active turn stopped.
- `theater_agent_request_resolve` only after the user has authorized the exact command, permission, or answer. Never infer approval for remote publication, destructive cleanup, or broader filesystem/network access.

Do not poll continuously. Inspect when the user asks, before a consequential decision, after a completion signal, or when a dependent action needs the result.

## Switch without context pollution

For a real focus change:

1. Inspect the outgoing lane if its state may have changed.
2. Call `theater_checkpoint` with what is now true, one next action, and unresolved decisions/risks. A checkpoint is a semantic handoff, not a transcript.
3. Call `theater_feature_switch`.
4. The runtime compacts the outgoing feature task when it is idle, or keeps compaction queued until an idle boundary. The saved checkpoint is the coordinator's semantic compaction boundary. Codex does not currently let an MCP process compact the already-loaded host task, so when the outgoing lane contributed substantial context, end the concise switch confirmation by recommending `/compact` once. Afterward, recover only from `.theater/index.md` and the destination packet.
5. Load the destination with `theater_feature_get`. Do not preload every other feature spec. Use `theater_feature_list` for the cross-feature overview.

Switching coordinator focus does not pause independent feature tasks. Pause is an explicit lifecycle decision.

## Evidence and delivery

Treat agent reports as claims. Record checks actually run with `theater_evidence_record`, including exact command, observed result, artifact, limitation, and revision when applicable. A typecheck does not prove runtime behavior; choose the smallest check that exercises the changed behavior.

Use `theater_candidate_record` only for the exact checkout HEAD after relevant checks. It verifies revision identity and cleanliness and records a reviewable candidate; it never pushes, opens a pull request, merges, or publishes. Those remain normal Git/Codex operations requiring the user's authority.

Mark a feature done only after its non-cancelled work is closed, a ready candidate still matches the clean checkout HEAD, and passing evidence exists at that exact revision. Archive only with a disposition that states what shipped and what remains.

## Natural command vocabulary

Users do not need to memorize tools. Interpret requests such as these directly:

- “Use Feature Theater with `<repo-url>`.”
- “Clone a feature for team search and help me spec it.”
- “List everything active and what is blocked.”
- “Switch to billing recovery.”
- “What has the search agent changed?”
- “Tell it to preserve the public API and skip the cache migration.”
- “Checkpoint this, compact, and go back to onboarding.”
- “Record the tested HEAD as the candidate.”

Lead with the useful result in user-facing replies: current lane, material progress/change, blocker or decision, and next action. Keep tool mechanics secondary.
