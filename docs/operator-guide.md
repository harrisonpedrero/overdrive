# Operator guide

## First run

Open `C:\path\to\feature-theater\workspace` in a fresh Codex task using GPT-6 Astra. Say `Use Feature Theater with <repository URL>`. The plugin creates local state and reports detected repository instructions, ecosystems, setup candidates, and check candidates. Review those facts; they are hints, not commands that were executed.

To begin from nothing, say `Start a new Feature Theater project called <name> that <product brief>`. The plugin creates a minimal canonical repository at `project/`, then uses the same spec, lane, agent, and evidence workflow. After a feature is completed through the candidate gate, an explicit promotion request fast-forwards that canonical repository and refreshes the mirror. A divergent or dirty canonical project is refused rather than merged or reset.

Create a lane in ordinary language. The feature clone appears at `features/<slug>/repo`; its branch is `feature/<slug>`. Feature tasks appear as normal persisted Codex tasks and can be opened directly when desired. Their app-server disables apps, hooks, plugins, browser/computer control, and external MCP servers, so a lane worker cannot call Theater recursively or bypass coordinator-owned external authority.

Before dispatch, the coordinator prepares known-needed dependencies and local Git refs when already authorized, using repository instructions and lockfiles. Dependency reinstalls must be coordinated with any preview in that clone. Give the worker the preparation result and keep protected local Git operations with the coordinator to avoid predictable permission handoffs.

During active coordination, reconcile completed workers and checks promptly and advance ready work. A requested notification interval governs reporting; it is not a reason to leave a completed handoff waiting. Continue independent lanes while another lane needs investigation or a user decision.

Use `theater_agents_wait` to receive the first handoff among up to eight unreconciled workers, then review the returned lane and advance its authorized next action. Remove handled idle lanes from the wait set. On a verification drain's completion, reconcile its `completed` and `needsAttention` results immediately, including candidate preparation when the complete gate passes. These calls drive an active coordinator; they cannot wake an ended host turn or perform source review and candidate judgment themselves. Scheduled follow-up remains necessary for that host boundary.

## Deliver progressively

For multi-feature work, use the integration lane as an evolving deliverable. Start with the smallest coherent reviewed set of exact inputs and add later inputs as they become ready. A missing input blocks only behavior that depends on it; retain the complete final acceptance gate. An intermediate combined preview is not a release-ready candidate.

Give independent bounded reviews one owner each, exact revisions and concrete behavior/integration questions. Feature workers own implementation and focused checks; reviewers assess source; the coordinator prepares authorized setup/Git work, reconciles evidence and makes delivery decisions. Keep included revisions, owners/results and pending-input blockers in the existing integration checkpoint and work items. Reuse unchanged valid reviews and current receipts, but verify each resulting integration revision. Do not serialize all reviews through the coordinator or add a second orchestration graph merely to track the same work.

## Recovery

After a new coordinator task or compaction:

1. Read `.theater/index.md` or call the feature-list tool.
2. Load only the focused feature's context.
3. Reconcile the recorded task status with the native task and live Git state.
4. Continue from the saved next action; do not reconstruct old deliberation.

Switching lanes automatically compacts the outgoing feature task when it is idle. For the coordinator itself, use the single `/compact` recommendation returned after a substantial switch; MCP servers cannot safely compact the already-loaded host task from a second app-server process.

If Codex restarted during an approval prompt, the old callback cannot safely be answered. Inspect the feature, resume or steer it, and let it issue a fresh request.

An ended controller is detected by its persisted process owner; inspection clears stale activity and preserves the checkout. A running lane owned by another live coordinator cannot be started again from a competing session. Pausing requests interruption; switching focus alone preserves lifecycle state. The existing desktop coordinator still needs the explicit `/compact` command at substantial context boundaries.

Inspect `theater_checks_queue` after a restart. Completed jobs retain their receipts; an interrupted command remains uncertain and reserves its clone and declared resources until explicitly resolved. Controller death does not prove child-process termination. Establish that the command processes stopped before using `theater_checks_resolve` with a reason and `execution_stopped: true` to retry or cancel interrupted work. Resume eligible saved jobs instead of submitting duplicate work.

## Verification and state views

Configure the relevant repository/feature commands, then have the runtime execute them against the idle, clean candidate commit. Every current required check needs a latest passing execution receipt for the current spec/work/check contract. A report, old spec, earlier pass followed by a failure, or a command that changes the checkout cannot authorize delivery. Individual receipt output is available on demand. Existing version-2 workspaces migrate automatically: historical evidence survives, but old manually authorized candidates need fresh verification.

Use `check_keys` on `theater_checks_run` for focused execution without changing the saved contract. For an already-reviewed sequence, enqueue one configured check per job with `theater_checks_enqueue`, stating real dependencies and shared resources. Drain with bounded concurrency, command count and admission time using `theater_checks_drain`. A successful job releases its eligible successors immediately; a failure stops dependent work while unrelated lanes can proceed. The same clone is serialized automatically. Declare shared ports and sensitive performance resources consistently; previews and commands outside the queue still require coordinator scheduling.

Queue inspection separates waiting from execution time. Jobs bind to the exact revision and complete contract; source or contract changes require fresh work and evidence. The queue does not dispatch workers, decide repairs or record candidates. All required final acceptance checks remain mandatory even when focused checks or an intermediate combined preview are ready.

Choose the smallest meaningful contract for the required behavior and plausible failures; do not copy every broad suite into every lane by default. Explain any contract change and preserve substantive requirements. Direct multi-check execution stops on its first failure. Drain admission budgets stop new starts while admitted commands finish under their configured deadlines. Queue history is currently limited to 500 jobs per workspace. Attempt `queueWaitMs` measures enqueue-to-start (including prerequisites), `eligibleWaitMs` measures observed eligibility-to-start, and `executionMs` comes from the actual command receipt; neither waiting measurement is model execution time.

Ask for the work graph to see dependencies, task states, and blockers as a native diagram in the conversation. Larger graphs can focus on selected work keys and label prerequisites outside the view. Other state—evidence, handoff, specs, and feature summaries—is normally answered in prose from scoped snapshots. Steering, switching, and refresh requests stay in the existing chat. There are no embedded forms, chat boxes, control panels, or separate dashboard.

## Failure handling

Initialization and clone failures preserve partial directories for diagnosis. Feature Theater will not automatically delete, stash, reset, or overwrite a dirty checkout. A failed work item remains visible; add repair work with explicit acceptance criteria. A feature blocked on user input does not freeze independent lanes.

Start with cheap environment readiness and focused behavior checks before broad suites. Inspect the actual failed command output to distinguish environment/setup, test-harness, resource contention and product failures. Address the demonstrated cause before explicitly retrying the affected queue job. Preserve unrelated current passes; do not rerun an unchanged broad suite merely because one command failed.

## Updating the development install

Validate the plugin, update its Codex cachebuster, and reinstall it from the `feature-theater-local` marketplace. Test changed tools in a fresh Codex task so the task receives the new manifest, skill, and MCP process.
