# Operator guide

## First run

Open `C:\path\to\feature-theater\workspace` in a fresh Codex task using GPT-6 Astra. Say `Use Feature Theater with <repository URL>`. The plugin creates local state and reports detected repository instructions, ecosystems, setup candidates, and check candidates. Review those facts; they are hints, not commands that were executed.

To begin from nothing, say `Start a new Feature Theater project called <name> that <product brief>`. The plugin creates a minimal canonical repository at `project/`, then uses the same spec, lane, agent, and evidence workflow. After a feature is completed through the candidate gate, an explicit promotion request fast-forwards that canonical repository and refreshes the mirror. A divergent or dirty canonical project is refused rather than merged or reset.

## Worker harness

Lane workers run under Codex by default, using GPT-6 Sol independently of the coordinator model. Set `codex.model` for a workspace default and `codex.laneModels` for named lane overrides in `theater.json`:

```json
{
  "codex": {
    "model": "gpt-6-sol",
    "laneModels": { "search-redesign": "gpt-6-luna" }
  }
}
```

The selected model is used when starting or resuming a worker thread and for each new turn. Model names must be nonempty identifiers using letters, numbers, periods, underscores, colons or hyphens.

To run workers as Claude Code sessions instead, pass `harness: "claude"` to `theater_initialize` or `theater_project_create`, or set `"harness": "claude"` in an existing `theater.json`; the change applies to the next agent start. An optional `claude` object configures the workers:

```json
{
  "harness": "claude",
  "claude": {
    "model": "opus",
    "laneModels": { "search-redesign": "sonnet" },
    "permissionMode": "acceptEdits",
    "allowedTools": ["Bash", "PowerShell"],
    "disallowedTools": ["Bash(git push:*)", "Bash(gh pr:*)", "WebFetch", "WebSearch"]
  }
}
```

Omitted fields use the values shown, except `model`, which defaults to the CLI's configured model. Each turn is one `claude -p` process in the feature clone, resumed by session ID, with the feature contract appended to the system prompt and the context packet directory added as a readable root. Workers run with `--strict-mcp-config` and an empty MCP configuration, no settings files, no skills and no browser integration, so a lane cannot call Theater, hooks or the coordinator's integrations. A mid-turn steer is queued as the next user message of the same process; an interrupt terminates the process tree. Compaction requests are acknowledged without a model call because Claude Code compacts its own context; the saved checkpoint remains the semantic boundary.

Permission prompts cannot be relayed from a non-interactive Claude worker: anything outside the permission mode and allow list is denied automatically and the denied tool names are appended to the turn's handoff. The default policy therefore allows shell commands, confines file edits to the clone and packet directory, and denies remote publication and web tools. Unlike the Codex `:workspace` sandbox, shell commands are not filesystem- or network-contained on Windows; treat `bypassPermissions` as an explicit per-workspace choice. Agent tools need the server process that started the turn; a one-shot client that exits after each call ends the worker with it, so drive `theater_agent_*` from a persistent MCP connection.

Create a lane in ordinary language. The feature clone appears at `features/<slug>/repo`; its branch is `feature/<slug>`. Feature tasks appear as normal persisted Codex tasks and can be opened directly when desired. Their app-server disables apps, hooks, plugins, browser/computer control, and external MCP servers, so a lane worker cannot call Theater recursively or bypass coordinator-owned external authority.

To start from an explicitly reviewed, unpromoted sibling candidate, pass its lane as `base_feature` and its full frozen commit ID as `base_revision`. The runtime validates that commit in the source lane and fetches its committed objects directly into the independent new clone; the source may have advanced or have dirty files, which are not included. This selects provenance, not candidate approval. Canonical source/cache publication is unnecessary, and omitted bases still use refreshed canonical HEAD. Confirm the callable schema supports `base_feature` before using it; older runtimes need the previously verified cache-based workflow or a coordinated update. Without `base_feature`, the selected revision must resolve in the refreshed cache; private ref names can be pruned, so use their full commit ID. Repository-profile hints still describe canonical default HEAD; inspect the selected checkout's actual setup requirements.

Checkout-construction failures retain their partial directory and return its path, selected revision and recovery guidance before feature registration. Inspect any existing path and durable state before an authorized recovery; an occupied slug is never overwritten automatically. Errors later in registration/projection can have different state and must be reconciled separately.

Before dispatch, the coordinator prepares known-needed dependencies and local Git refs when already authorized, using repository instructions and lockfiles. Dependency reinstalls must be coordinated with any preview in that clone. Assign known environment-limited probes, such as native PostgreSQL initialization under a restricted Windows token, to the coordinator along with protected local Git operations. Give the worker the preparation result and execution ownership so it can continue implementation and supported focused checks.

For an existing work item, the coordinator claims it as running with `theater_work_update` before dispatch or resumption, retains a stable owner for renewals and reconciliation, and sends its exact key and outcome. A worker cannot call Theater to claim work or update leases. If dispatch fails, confirm whether a worker started before correcting the claim; if it completes, reconcile actual changes and command evidence before recording the work outcome. Agent completion alone does not mark work done or produce execution receipts.

`theater_work_plan` returns current records only for the keys submitted in that call, alongside the feature summary, aggregate progress and next action. Omitted items remain in the graph. Use `theater_feature_get` for complete work records or `theater_view` for explicit graph inspection.

When a probe encounters a demonstrated environment restriction, hand off its exact argv, checkout/revision, relevant environment requirements, failure output, and service/cleanup scope instead of repeating unchanged setup or permission requests. The coordinator runs the authorized focused command when its checkout and resources are available, verifies owned cleanup, and returns the actual result promptly while independent work continues. Classify the restriction as an environment failure; require fresh product evidence from the capable environment. Required acceptance checks still need normal revision-bound Theater execution receipts; an ad hoc command result or worker report does not replace them.

During active coordination, reconcile completed workers and checks promptly and advance ready work. A requested notification interval governs reporting; it is not a reason to leave a completed handoff waiting. Continue independent lanes while another lane needs investigation or a user decision.

Use `theater_agents_wait` to receive the first handoff among up to eight unreconciled workers, then review the returned lane and advance its authorized next action. Remove handled idle lanes from the wait set. On a verification drain's completion, reconcile its `completed` and `needsAttention` results immediately, including candidate preparation when the complete gate passes. These calls drive an active coordinator; they cannot wake an ended host turn or perform source review and candidate judgment themselves. Scheduled follow-up remains necessary for that host boundary.

For Theater-owned workers, reconcile liveness through their owning Theater controller. An app task view reporting `notLoaded` or `interrupted` does not by itself establish that this controller's active turn stopped; compare the exact turn and controller state before recovery or redispatch. If refresh fails, preserve that uncertainty instead of declaring completion or starting a competing worker.

## Claude Code installation

`plugins/feature-theater-claude/` packages the coordinator for Claude Code: the `feature-theater` skill (the Codex skill rewritten without Codex-only mechanics) and an inline MCP declaration that launches the shared server from `plugins/feature-theater/scripts/server.mjs`. The plugin references that server through `${CLAUDE_PLUGIN_ROOT}/../feature-theater/`, so it must stay inside this repository checkout; the repository root also carries `.claude-plugin/marketplace.json` for a local marketplace named `feature-theater-local`.

Validate with `claude plugin validate plugins/feature-theater-claude`. For one session, start Claude Code with `--plugin-dir C:\path\to\feature-theater\plugins\feature-theater-claude`. To install persistently, run `/plugin marketplace add C:\path\to\feature-theater` once, then `/plugin install feature-theater@feature-theater-local` (or `claude plugin install feature-theater@feature-theater-local --scope user`). A control workspace that already declares `feature_theater` in its own `.mcp.json` should remove that entry when the plugin is installed, otherwise the server is loaded twice with duplicate tools; a workspace that wants only the skill can instead copy `plugins/feature-theater-claude/skills/feature-theater/` into its `.claude/skills/` directory. Agent tools must be called through the session's MCP connection: a one-shot stdio client that exits after each call terminates the worker turn it started.

## Deliver progressively

For multi-feature work, use the integration lane as an evolving deliverable. Start with the smallest coherent reviewed set of exact inputs and add later inputs as they become ready. A missing input blocks only behavior that depends on it; retain the complete final acceptance gate. An intermediate combined preview is not a release-ready candidate.

As soon as that slice supports the first meaningful user outcome and cheap readiness checks pass, prioritize walking the actual journey from normal entry through the user's approach, core action and observable result before further component polish. Use the real interface when the behavior depends on rendering or input. Controlled fixtures establish only the states and paths they exercise; placing the user inside an interaction or bypassing its approach does not prove ordinary reachability. Send concrete failures, including the relevant input/state and observed result, promptly to the responsible owner; use a focused reconstruction when useful, then retry the affected ordinary path while independent work continues. This priority does not require another framework, broad suite or approval step.

Give independent bounded reviews one owner each, exact revisions and concrete behavior/integration questions. Feature workers own implementation and focused checks; reviewers assess source; the coordinator prepares authorized setup/Git work, reconciles evidence and makes delivery decisions. Keep included revisions, owners/results and pending-input blockers in the existing integration checkpoint and work items. Reuse unchanged valid reviews and current receipts, but verify each resulting integration revision. Do not serialize all reviews through the coordinator or add a second orchestration graph merely to track the same work.

## Deliver selected peer inputs

A sibling commit ID identifies source; it does not make that commit readable in another isolated clone. Before assigning work that depends on it, the coordinator delivers the deliberately selected peer input and verifies access from the receiving checkout. For an authorized Git intake, fetch the frozen full commit ID from its owning clone into a named destination ref, then confirm `git cat-file -e <commit>^{commit}` and the required paths in the destination. Coordinate destination Git writes with its owner; preserve its HEAD and working files. Tell the worker the exact input revision, relevant paths and integration question rather than asking it to discover or fetch sibling context.

When destination Git writes are unsuitable, export selected committed files with `git archive` and, if needed, a binary/full-index patch between explicit base and target commits. Write a fresh bundle under the receiver's ignored `.theater/source-intake/` directory. Record the source clone, full base/target IDs, selected paths, additions/deletions or mode changes, and SHA256 hashes of the delivered artifacts in a manifest. Read committed Git objects rather than mutable working files, preserve earlier bundles, and publish the handoff only after verifying the files and manifest. This is source input, not applied code or acceptance evidence; the receiving owner decides how to compose it. Once actual peer inputs exist, use cheap checks against those modules for the relevant interface seam instead of continuing to infer compatibility from adapter stubs. Keep unrelated work moving while a missing input is delivered.

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

Use `check_keys` on `theater_checks_run` for focused execution only when the actual callable schema exposes it. Installed files do not prove what an existing task loaded. If the field is absent, do not attempt that unsupported selection; settle any active run, reconcile its receipts, then use the existing selective helper described under Updating the development install to reach a verified fresh controller. Omit selection only when a full run is intended. For an already-reviewed sequence, enqueue one configured check per job with `theater_checks_enqueue`, stating real dependencies and shared resources. Drain with bounded concurrency, command count and admission time using `theater_checks_drain`. A successful job releases its eligible successors immediately; a failure stops dependent work while unrelated lanes can proceed. The same clone is serialized automatically. Declare shared ports and sensitive performance resources consistently; previews and commands outside the queue still require coordinator scheduling.

Queue inspection separates waiting from execution time. Jobs bind to the exact revision and complete contract; source or contract changes require fresh work and evidence. The queue does not dispatch workers, decide repairs or record candidates. All required final acceptance checks remain mandatory even when focused checks or an intermediate combined preview are ready.

For each external resource lease used by a check, record its path and one claim/release owner alongside the command in the existing checkpoint. Follow the actual adapter contract, including after context recovery: let a self-claiming adapter acquire the idle lease; preclaim it only when the coordinator owns that protocol. Do not infer ownership from another check using the same resource. After failure, reconcile the recorded owner, actual process termination and cleanup before releasing your own claim; never automatically clear a busy or uncertain lease. A claim conflict before workload launch is a coordination failure, not a product result; fix that cause before the focused retry.

Choose the smallest meaningful contract for the required behavior and plausible failures; do not copy every broad suite into every lane by default. Before retrying a failed scenario, compare its recorded inputs, state and observed response with the intended product rule. An allowed loss or rejection can fail the driver's objective without violating that rule. Preserve the failed receipt, achieved milestones and unexercised remainder; do not reroll a dynamic outcome or change product behavior merely to obtain a pass. If the evidence cannot distinguish an allowed outcome from a defect, or successful completion is itself required under those conditions, keep that acceptance unresolved. Separate independently executable required milestones from optional follow-ons where the specification supports it.

Choose fresh validation from the changed behavior, its dependencies and plausible integration risks. An earlier complete journey informs that review at its original revision; it is not fresh proof. Matching Git trees can support source-equivalence review, but do not establish matching untracked fixtures, dependencies, services or command inputs and do not transfer runtime receipts across revisions. Small source changes do not automatically require another complete journey, and few changed lines alone do not establish narrow risk. Run focused current-revision checks that exercise the affected contract, including browser interaction where relevant; replay the journey when affected dependencies, unresolved integration risk or explicit acceptance require it. Disclose any bypassed setup or untested remainder.

For each delivery, reassess accumulated blocking checks against its intended outcome, affected behavior, available evidence and remaining product qualification. A previously required command need not remain blocking forever: after active verification settles, revise obsolete or redundant gates when the current coverage justifies it, including a predicate that mistakes a scenario win for product correctness. Use the existing checkpoint to state what remains required, why coverage is sufficient, exact revisions/receipt references and what is only historical or still unqualified. Preserve substantive acceptance and failure history; an inconvenient failure alone does not justify making a required check optional. Current required checks still need eligible execution receipts before a new candidate; changing requiredness neither turns a failed receipt into a pass nor carries historical proof to a new revision.

Direct multi-check execution stops on its first failure. Drain admission budgets stop new starts while admitted commands finish under their configured deadlines. Queue history is currently limited to 500 jobs per workspace. Attempt `queueWaitMs` measures enqueue-to-start (including prerequisites), `eligibleWaitMs` measures observed eligibility-to-start, and `executionMs` comes from the actual command receipt; neither waiting measurement is model execution time.

When reusing or handing off a probe, make assertion-dependent fixture inputs explicit, such as generation, catalog or schema version; do not inherit changing defaults. Include those selectors with the command and confirm the resolved input during existing cheap setup. Preserve frozen comparison manifests, required input pins and semantic assertions. In an intended current-HEAD mode, replace only obsolete candidate-specific guards with clean-current-revision verification and actual module hashes. A setup mismatch before assertions proves neither a product defect nor a behavior pass; inspect related setup assumptions before the focused retry while preserving unaffected evidence.

Use existing work updates and checkpoints for progress and result reporting. Work-status updates preserve the feature's next action while recording item status, blockers and results; checkpoint again when the intended direction changes. Plan, specification and candidate operations can still replace that direction. Adding or changing a work definition changes the current verification contract; ordinary status, owner and result updates do not. Preserve genuinely new requirements or repair scope in the plan even when that invalidates receipts. An earlier revision's observation remains useful evidence, not a current-revision execution receipt.

For a standalone check with immutable non-Git inputs bound in its command or spec/work contract, set `reuse_same_revision: true` in its check definition to retain exact same-revision receipts across unrelated check edits. Leave this off for checks that consume mutable shared setup or opaque external inputs; an unchanged command alone does not establish unchanged inputs. The binding includes the spec/work contract and every normalized field of that check except this reuse policy, so changed command arguments, purpose/input binding, timeout, artifacts, kind or requiredness invalidate its proof. Other checks retain the full-contract rule by default. Candidates still bind the complete current contract and must be recorded again after a contract change; queue jobs also retain their full original authorization.

For a reviewed independent check, optional `work_scope: ["exact-work-key"]` with `reuse_same_revision: true` binds only the selected work definitions and every transitive prerequisite. Omission binds all work. Scope is itself part of the check definition: adding or changing it requires prospective execution proof and cannot narrow legacy all-work receipts retroactively. Unrelated work additions preserve eligible scoped receipts; changes to selected definitions or prerequisites invalidate them. The complete specification and exact source revision remain bound.

The runtime preserves receipt IDs, original contract hashes, results and artifacts. It records versioned per-check bindings at execution and atomically captures the exact old full contract before replacing check definitions. Thus an older receipt can gain a verifiable definition binding only when its recorded full hash matches that captured contract. Already-lost definitions are not reconstructed from argv or the latest configuration. The newest applicable receipt wins, including failures; opting out cannot revive an older pass over a newer known-equivalent failure. An unknown newer failure blocks reuse and is identified by `reuseBlockedBy`. Reused results expose `reused: true` and their receipt's original `contract_hash`. No cross-revision or changed external-input equivalence is inferred. Confirm the installed callable schema supports these options before using them.

Plan changes still supersede the whole-contract candidate. Verification `ready` means current required receipts permit an intermediate candidate; `openWork` lists outstanding items, and `completionReady` additionally requires them closed. Feature completion retains its candidate, clean-checkout and idle-agent gates. Reconcile each new acceptance criterion with required checks and review before recording the new candidate; scoped proof is not coverage of unrelated new work. Closing work creates no execution evidence, and adding a required check blocks candidate readiness until it has proof. Review and integration work may remain open for an intermediate candidate, avoiding a cycle where finishing that work requires the candidate itself.

Ask for the work graph to see dependencies, task states, and blockers as a native diagram in the conversation. Larger graphs can focus on selected work keys and label prerequisites outside the view. Other state—evidence, handoff, specs, and feature summaries—is normally answered in prose from scoped snapshots. Steering, switching, and refresh requests stay in the existing chat. There are no embedded forms, chat boxes, control panels, or separate dashboard.

## Failure handling

Treat `selectedCheckKeys` as a request, not a list of running work. A completed run's `completion` separates selected, executed, passed, failed and `notRunCheckKeys`; omitted execution does not create or alter receipts. On `checks.finished`, close that invocation's work and join its shell/controller rather than waiting for selected-but-unrun commands. Inspect the failed receipt, then explicitly run independent needed checks or admit them through the existing queue. The local selective client prints requested/finished events with its controller PID to stderr as well as completion in the JSON result, including when it uses the currently installed older response format. If no complete handoff arrives, it reports `checks.unconfirmed`: inspect the owned process and durable receipts before retrying. No additional polling loop is required.

Initialization and clone failures preserve partial directories for diagnosis. Feature Theater will not automatically delete, stash, reset, or overwrite a dirty checkout. A failed work item remains visible; add repair work with explicit acceptance criteria. A feature blocked on user input does not freeze independent lanes.

Keep temporary verification executables and their local support/fixture inputs available while coordinator review or registered execution still needs them. Leave the ignored originals in place, or preserve byte-exact inert source copies before removing runnable files; report archive locations, hashes, original restore paths, exact commands and source revisions. Hashes and result JSON are not source archives. This temporary handoff retention does not require permanent tests or application commits. Once downstream use is complete, ordinary temporary-file cleanup applies; do not wait for cleanup to deliver the handoff.

Optional cleanup must not delay completed useful work. A worker unable to remove its own ignored temporary probes or fixtures within available permissions should retain them and finish its handoff with exact paths, purpose and deferred cleanup, without repeated attempts or escalation solely for housekeeping. Live services and residue affecting correctness still need explicit disposition. Theater waits already return pending request summaries, payloads and creation times; reconcile them promptly and distinguish optional housekeeping from decisions blocking the requested behavior. Preserve request ownership and authorization, and let the worker finish its actual turn rather than synthesizing completion.

Start with cheap environment readiness and focused behavior checks before broad suites. For rendering work, verify the backend actually selected by the intended browser/launch options and report it in the real workload; installed hardware or a headless label does not establish hardware acceleration. A small graphics-context probe establishes availability, not application performance, and earlier software-rendered evidence keeps its original qualification.

Use actual inputs and observed results to distinguish environment, driver, resource-contention and product failures. Scope constraints to the responsible identity, shared resource or phase; keep unrelated participants concurrent and match deadlines to the operation and starting conditions measured. Once evidence identifies a driver-policy failure, simplify to the smallest native input sequence that can establish the remaining criterion instead of adding more bot heuristics. Preserve meaningful scenario progress, cumulative attempts and the applicable deadline across local retries or fallback calls; restarting a helper is not a new scenario. Correct product responses during a failed attempt establish those behaviors, not an unfinished end-to-end outcome. Probe the repair cheaply where useful, then retry the affected path while preserving target concurrency, behavior coverage, valid timing requirements and unrelated current evidence.

## Updating the development install

If an existing task still advertises an old schema, a necessary selective retry can use a fresh installed MCP controller without restarting that task:

```powershell
node C:\path\to\feature-theater\tools\run-installed-checks.mjs `
  C:\path\to\codex-home\plugins\cache\feature-theater-local\feature-theater\0.1.0+codex.20260914041431 `
  C:\path\to\control-workspace <feature> <exact-check-key> [additional-check-key]
```

Replace the angle/bracket placeholders with actual arguments. The client requires a nonempty selection, initializes the installed server, checks its advertised schema, and calls normal `theater_checks_run`. It refuses older schemas before execution. Normal clone locks, idle/clean checks, interruption reservations, receipt persistence and the full acceptance contract still apply. It keeps stdin open until the tool finishes under the configured check deadlines; do not pipe a one-shot request directly into `server.mjs`. No game command is executed merely by installing this helper. The installed path above pins the verified package; use a newly verified installed path after a future update.

Validate the plugin, update its Codex cachebuster, and reinstall it from the `feature-theater-local` marketplace. Test changed tools in a fresh Codex task so the task receives the new manifest, skill, and MCP process.
