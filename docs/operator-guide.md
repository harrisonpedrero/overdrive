# Operator guide

The [README](../README.md) covers daily use and installation. This guide covers setup, configuration, the lab, integration and recovery.

## Setup

1. Install the plugin ([README](../README.md#installation)). OVERDRIVE looks for the worker CLI on `PATH`, and for Claude also in `~/.local/bin`. Set `CODEX_CLI_PATH` or `CLAUDE_CLI_PATH` to use a different executable; under a Codex coordinator only `CODEX_CLI_PATH` reaches the server.
2. Open an empty folder, such as `workspace/`, as the coordinator's working directory.
3. Adopt a repository with `workspace_init` (a credential-free URL, SSH remote or absolute local path), or start one from a brief with `project_create`. Either creates `overdrive.json`, `.overdrive/` and the lab. The response lists detected ecosystems and setup hints; nothing from the repository is executed.
4. Run `doctor` after setup or whenever something looks wrong. It checks Git, Node, the configured worker CLI, `overdrive.json`, database integrity, the repository cache, the managed project and lane paths.

Each lane is a full clone at `features/<slug>/repo` on `feature/<slug>`, created from the refreshed default revision or from `base_revision`. To start from another lane's unintegrated commit, pass that lane as `base_feature` and the commit ID, full or at least 7 hex digits, as `base_revision`.

A clone commits with a locally adopted repository's own `user.name` and `user.email` when that repository sets both, or else with your configured Git identity. Failing both, it commits as the clone-local `OVERDRIVE <overdrive@local.invalid>`. Global Git config is never changed. `feature_create` reports the identity Git will record and the commands for a lane-local override.

In Codex, `workspace_init`, `integrate` and `agent_request_resolve` ask for approval before running.

## overdrive.json

`workspace_init` and `project_create` write the repository fields; leave those alone. You, or the coordinator on your behalf, edit these:

```json
{
  "harness": "claude",
  "codex": {
    "model": "gpt-6-sol",
    "laneModels": { "search-redesign": "gpt-6-luna" }
  },
  "claude": {
    "model": "claude-opus-5-5",
    "laneModels": { "qa": "sonnet" },
    "permissionMode": "acceptEdits",
    "allowedTools": []
  }
}
```

| Setting | Default | Effect |
| --- | --- | --- |
| `harness` | `codex` | Harness for new agent sessions. A saved session always resumes on the harness that created it; `agent_start` with `force_new_session: true` replaces it on the current one, and the old conversation stays in its backend. |
| `codex.model`, `claude.model` | `gpt-6-sol`; the Claude CLI's configured model | Worker model for the workspace. Claude accepts exact IDs and CLI aliases. |
| `codex.laneModels`, `claude.laneModels` | none | Per-agent model, keyed by lane slug or QA agent name. |
| `claude.permissionMode` | `acceptEdits` | One of `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`. Decides which calls prompt. |
| `claude.allowedTools` | `[]` | Allow rules; a matching call runs without a prompt. |
| `claude.disallowedTools` | `Bash(git push:*)`, and `Bash(gh pr <subcommand>:*)` for each `gh pr` subcommand that writes (`create`, `merge`, `edit`, `comment`, `review`, `close`, `reopen`, `ready`, `lock`, `unlock`, `revert`, `update-branch`) | Deny rules. Setting this replaces the default list. |

Model and permission changes apply from the next turn; `harness` applies to new sessions.

The worker permission policy ([architecture](architecture.md#worker-capability-profiles)) runs as a `PreToolUse` hook on every tool call, so `allowedTools`, the permission mode and a repository's own settings, `disableAllHooks` included, cannot skip it; the mode and allow rules decide only what else prompts. Deny rules hold in every mode. On top of this list, every worker is denied `ScheduleWakeup`, because the CLI exits when the turn ends and a wakeup could never fire, and feature agents are denied the browser and computer-control servers.

Codex workers have no permission settings: they run in the `workspace-write` sandbox with network access, and the policy answers their escalations, including the file-change approval requests Codex sends for patches under approval policy `untrusted`. Codex can apply a patch without such a request, for example under preapproved permissions or a cached approval, and the policy never sees that patch. Questions and MCP elicitations from a worker reach the coordinator as pending requests, answered with `agent_request_resolve`.

## The lab

`lab/` is created at initialization, or on first use in older workspaces, with a README that QA agents follow and an `ENVIRONMENT.md` in which QA keeps verified install, build and test commands, failures known at base and machine quirks; every agent's context packet names that file. QA agents own its contents and commit to it. Each suite is a directory:

```text
lab/suites/<name>/suite.json
{
  "description": "What this suite proves",
  "argv": ["node", "run.mjs"],
  "cwd": "suite",
  "timeout_seconds": 600
}
```

- `<name>`: lowercase letters, digits, `-` and `_`.
- `argv`: 1 to 200 strings, run without a shell.
- `cwd`: `suite` (the suite directory, the default) or `target` (the checkout under test).
- `timeout_seconds`: 1 to 3600, default 600.

Every run receives this environment:

| Variable | Value |
| --- | --- |
| `OVERDRIVE_TARGET` | Clean clone at the revision under test |
| `OVERDRIVE_REVISION` | Commit under test |
| `OVERDRIVE_LAB` | A checkout of the run's lab snapshot, which the suite runs from |
| `OVERDRIVE_SUITE` | Suite name |
| `OVERDRIVE_ARTIFACTS` | Empty directory for this run's screenshots, logs, traces and `tests.json` |
| `OVERDRIVE_PORT` | A free TCP port on 127.0.0.1 |

Each `lab_run` call snapshots the lab's working tree, uncommitted suites included, when it starts and records it as `lab_revision`; its suites, harness and fixtures run from a checkout of that snapshot, so lab edits made during a run reach only later calls. A suite starts every service it needs and stops it before exiting. Target clones and lab snapshot checkouts keep ignored directories such as `node_modules` between runs, so dependency setup should be idempotent, for example reinstalling only when the lockfile changed. Ignored files in the lab itself, such as a `node_modules` QA installed there, are not in the snapshot and runs never see them. A suite that needs lab dependencies installs them idempotently into `OVERDRIVE_LAB`; the install happens on the first run in each lab snapshot checkout (one per target and slot) and is kept after that. Keep dependencies and outputs out of the lab's Git with `.gitignore`, because every run snapshots the lab's working tree.

`lab_run {suite, target, revision?}` targets a lane slug, `integration`, or `base` for control runs. Without a revision a lane is tested at its committed HEAD, or at a snapshot of its working tree, uncommitted changes included, when its own agent runs the suite; the integration build is tested at its HEAD, and `base` at the managed project HEAD, or the cached default revision of an adopted repository. A `base` revision given as a commit ID that the base cannot resolve, such as a foundation lane's commit, is taken from the lane that holds it. A `base` run belongs to no lane and resolves no findings. Each run records the lanes it tested as `run.lanes`: a lane run its own lane, and an integration run at the clone's HEAD the current build's lanes that HEAD contains. An integration run of any other revision, or of a HEAD reset away from the build, has `lanes: null` (unknown), so its verdict is attributed to no lane. `lab_run {batch}` takes 1-8 such runs instead, each listed once, and returns `runs` in order, each with its verdict and a 1,000-character output tail, or the error that kept it from running. The host sends one agent's calls one at a time, so separate calls from one agent queue, while a batch's runs on different targets execute at the same time, and up to three on one target, in `.overdrive/lab/targets/<target>`, `<target>--s1` and `<target>--s2`. Calls on one target wait for each other's runs there; a call that waited while an identical run (same suite, revision, lanes, lab snapshot and mutant) finished returns that run marked `reused` instead of repeating it. A run is `passed` (exit 0 within the timeout), `failed`, or `uncertain` when its processes could not be confirmed stopped. Artifacts stay in `.overdrive/lab/runs/<id>/artifacts/`, with a manifest of path, size and sha256. The runtime keeps the last 500,000 characters of a run's combined output, in the order it was printed, in `.overdrive/lab/runs/<id>/output.log`. A single `lab_run` and `lab_get {run}` return a 4,000-character output tail and that log's path (`outputLog`), and `lab_get {run}` also lists the artifacts. `lab_get` without a run lists the suites, the latest runs, the integration build and, on request, findings; with target `integration`, the findings are those on the lanes the build includes. It also lists recorded mutant controls (`mutants`) and, as `inconsistentVerdicts`, suites whose runs on one target at one revision and lab snapshot both passed and failed.

A suite may write per-test results to `$OVERDRIVE_ARTIFACTS/tests.json` as `{"<test id>": "passed|failed|error|skipped"}`. A lane or integration run of such a suite is then compared with the latest `base` run of the same suite at the same lab snapshot, such as one in the same batch, and returns `vsBase`: the base run, `regressions` (tests that passed on base and did not pass here, missing ones included) and `fixed` (tests that failed or errored on base and pass here), each capped at 50 with `omitted` counting the rest. When either side timed out, is uncertain, or wrote no valid `tests.json`, `vsBase` has `incomplete` with the reason instead of lists. The exit code stays the verdict.

`lab_run` with `mutant`, a lab-relative path of a patch in the lab snapshot, applies the patch to the target checkout before the suite runs and records the run with that `mutant`; the next sync of that checkout restores it. The patch applied is its blob as committed in the snapshot, up to 10 MiB. A patch that is not in the snapshot, is larger than that, does not apply or changes nothing fails with `MUTANT_INVALID`, as does a path that looks like a credential, which is refused before anything runs or is recorded. `lab_get` lists mutant runs under `mutants` with their raw `status`, `passed` or `failed`. A failure alone does not show the suite detected the mutant: that also takes a passing run of the same suite without the mutant and output showing the failure came from the injected defect rather than, say, a build error. A mutant run never resolves a finding, never becomes a finding's failing run, and `integrate` and context packets leave it out.

Feature agents may read the lab and run suites against their own lane only. QA agents may run any target, record findings and build integrations.

`finding_record` opens a finding on a lane (`blocking` by default, or `minor`) and messages the lane. A finding with a `repro_suite` is resolved by a passing run of that suite on the lane, or on an integration whose `lanes` include it, at a revision containing the one it was found at. The finding is linked to the latest failed run of that suite that tested the lane; changing the suite of an open finding relinks it and replaces its fix request if the lane has not received it yet. Only the coordinator marks a finding resolved by hand; QA agents and the coordinator can close one as `wontfix` with a note. Setting a closed finding `open` again reopens it: `lab_get` findings and `finding_record` results show `reopens` once it is above zero, and the lane's fix request says how often.

When a pass resolves a finding, `lab_run` returns `resolutionEvidence` alongside `resolvedFindings`; `lab_get {"findings":"all"}` shows the same evidence on each automatically resolved finding. `noFailingRun` is false only when the attached failed run used the current repro suite, tested the finding's lane (its own target, or an integration whose recorded `lanes` include it) and tested a revision containing the finding's recorded revision; true means no relevant failure is attached, while null means the attachment cannot be verified. `failureReason` is `lane_not_tested` for an integration run whose lanes exclude the lane and `membership_unknown` for one whose lanes are unknown, such as runs recorded before lanes were kept; such a run is never treated as the lane's failure. `passingReason` is null when the resolving run passed the repro suite at the resolved revision and tested the lane together with every lane of a verified failure that tested several, and otherwise names why not (`passing_run_mismatch`, `lane_not_tested`, `membership_unknown`, `failed_lanes_omitted`, `passing_run_unavailable`). A pass that omits such a lane no longer resolves the finding, so `failed_lanes_omitted` marks an earlier resolution that would not qualify now; the other reasons label the evidence and block nothing. `labSnapshotChanged` compares the entire lab tree content at the failed and passing runs' pinned revisions, because a suite can load shared harness and fixture files: true means their contents differ, false means they match, and null means the comparison is unavailable or there is no verified failure, with `labSnapshotReason` saying which. Metadata-only commits do not change that result, and a changed tree does not establish that the suite was weakened. Manual resolutions have no automatic resolution evidence.

## Integration and publishing

`integration_build {features, base?}` merges lanes in order into `.overdrive/lab/integration`. Each entry is a lane slug, which contributes its committed HEAD (uncommitted files are left out and counted as `uncommittedFiles`), or `slug@ref` for an exact revision. On a conflict, the build stops with the lane and the conflicting files. Its `laterConflicts` lists each later lane that would also conflict when merged alone onto the build so far, with its files, or `unavailable` when it could not be previewed; the preview is an in-memory `git merge-tree` that does not replay recorded resolutions. Its `laterLanes.lanes` lists the later lanes that may need reconciling together. For each, it gives the revision this build selected, that revision's `mergeBase` with the build base, and the conflicting paths where the revision's tree differs from that merge base. A lane that is only behind the base is not listed. A change can be inherited, such as from a lane this lane builds on, so an entry does not say which lane made the change or whether merging it will conflict. `unavailable` holds lanes that could not be compared, such as a revision with no single merge base, or comparisons that ran out of the advisory's one-minute limit. `omitted` counts what the caps left out. Only when `complete` is true does a lane's absence mean it did not change those files. Conflict markers there use the `zdiff3` style, which also shows the merge base's version. A QA agent's conflicted merge stays in place: resolve and commit it in the integration clone, or run `git merge --abort` there and have the lanes reconcile. The coordinator's is aborted, so it sends the conflicting files to the owning lanes. Lanes after the conflict are not merged yet (`lab_get` lists them as `pending`), so rebuild to include them; rebuilds replay the recorded resolution. While the stopped lane is pending and the clone's HEAD descends from the build base, `lab_get` returns the build's conflict as `integration.lastConflict`, with `laterConflicts` and `laterLanes` as captured at the build and absent for builds that predate them; `conflictFiles` lists only the paths unmerged in the clone now. Then test the integration with `lab_run` on target `integration`. When the new head already has runs, such as a rebuild of the same lanes or a fast-forward to a lane head QA tested, the build lists each suite's latest run there (`runs`), and a pass among them on a non-base target counts for `integrate` without a rerun.

`integrate {target, revision?}` takes a lane or `integration` and only committed work, so test the exact commit you mean to integrate:

- **Managed project:** fast-forwards `project/` when it is clean and on its default branch, the commit contains its HEAD, a lab run on a non-base target passed at that commit, and no blocking finding is open on the included lanes. The lanes become `done` and new lanes start from the new HEAD. `PROMOTION_NOT_FAST_FORWARD` means the commit does not contain the project HEAD; rebuild the integration on the current HEAD, which `integration_build` does by default.
- **Adopted repository:** publishes nothing. It returns the commit, the checkout that holds it (`path`), any open blocking findings, and two commands for a branch, `feature/<slug>` for a lane or a name you fill in for the integration: `push` pushes the commit from that checkout to the repository URL, and `fetch`, run in the user's own clone, creates the branch at the commit. When the commit has a passing run on a non-base target and no open blocking findings, the included lanes become `done`. With the user's authority, the coordinator runs the push, to the user's fork when they cannot push to the repository; otherwise the user runs the fetch.

Both results list the latest run of each suite at the commit, with its `vsBase` and the `mutants` run at that commit, and, in `suitesNotRun`, the lab suites that never ran there, leaving out suites that have only run, and passed, on base, such as a harness self-test; these do not block integration, but a report must not claim them as passing. The `next` note also names suites with regressions against base, suites whose verdict on the delivered target at the commit was inconsistent, and resolved findings on the included lanes whose lab snapshot changed after their failure or could not be compared, or that no failing run preceded. These are labels, not gates.

## Recovery

**Controller restart.** The first command that reads a lane whose controller has exited releases it. A busy agent becomes `uncertain` when its turn may still be running, and `disconnected` otherwise; idle agents are unchanged. Checkouts, sessions and pending messages are kept. Requests pending on the old process cannot be answered (`REQUEST_ORPHANED`); the worker asks again on its next turn. A controller sweeps messages only while it runs at least one agent, so after a restart review `feature_list` and `agent_start` the agents you want running. Their waiting messages open the new turns. Messages to the coordinator that a lost response or compaction dropped stay retrievable: `feature_list` with `coordinator_messages: "recent"` pages them newest first as `messageHistory`, pending and delivered alike, without delivering any; delivered records the runtime's handoff, not that anyone read it. A lab run left running by an exited controller becomes `uncertain` when `lab_get` returns it and no call holds its target, or when the next run on that target starts; its processes may still be running.

**Worker usage.** Lanes in `feature_list`, `feature_get`, `agent_inspect` and `agents_wait` carry `spend` once their agent has started a turn: `turns` started, `measuredTurns` (those with a credible per-turn delta), and those deltas summed as `tokensObserved` (all input, cache and output tokens) and, for Claude turns, `claudeCostEstimateUsdObserved`. The sums appear only once a turn is measured, so a missing field means no measurement, not zero. A turn whose baseline is unknown (such as a resumed Claude process whose totals are unverified), moved by a late report to the previous turn, or reset adds nothing, so `measuredTurns` below `turns` means the sums undercount. Even with every turn measured they are observed provider reports, not billing, and may still grow; Codex reports no cost. `feature_list` adds the workspace's total as `workspace.spend`, archived lanes included. `feature_get` and `agent_inspect` also show `feature.agent.usage` for the bound native session. `turn.delta` compares the latest reported cumulative snapshot with numbers frozen when the turn began; `cumulative.totals` is the latest accepted snapshot for the bound thread or session. Both include `observedAt`. `delta: null` with quality `unknown` means there is no credible baseline or report. A `partial` delta is observed usage, with `reason` explaining why it is not final; Codex has no final usage marker, so even its completed turns remain partial. Claude `complete` requires a clean worker exit after a valid result. Codex reports tokens but no USD cost; Claude `costUsd` is a client-side estimate, not billing. Claude `turn.mainLoop` counts only the main agent loop when result identities and usage are complete; session totals include subagents. Codex `cachedInputTokens` is already included in `inputTokens`; Claude cache read and creation fields are separate from `inputTokens`. Neither provider's cached fields are added to its reported totals.

**Uncertain dispatch.** When a turn request got no confirmed answer, the lane stays `uncertain` and no new turn starts until the native session shows whether one ran. The next `agent_inspect`, `agent_start` or `agent_steer` settles it from Codex history. A Claude session resumed by a later controller has no readable history, so `agent_start` fails with `DISPATCH_UNCERTAIN`. Check that no process for the lane is running, for example the processes whose working directory is its checkout. Then retry with `prior_turn_attestation: { "evidence": "<what you checked and found>" }`, which is recorded in the timeline.

**Unconfirmed worker processes.** `WORKERS_UNCONFIRMED` (on start) and `STOP_UNCONFIRMED` (on pause or archive) mean tools an earlier Claude turn launched may still be running. A guard whose Job Object has ended clears on the next inspect, start or pause. An attestation, passed as `prior_turn_attestation` to `agent_start` or to the pausing `feature_update`, clears only guards whose job no longer exists or was never recorded. A job that still holds processes must end first. When another live session owns the lane, pause it from that session or attest.

**Stuck agents.**

- `agent_inspect` shows safe progress, the tool calls still running, the live diff and pending requests.
- `agent_steer` redirects the running turn. The agent reads it when its current tool call returns, which `behindTool` names.
- `agent_interrupt` stops the turn and keeps the session and checkout.
- `feature_update {status: "paused"}` stops the worker and holds further dispatch.
- `agent_start` with `force_new_session: true` starts a fresh session, and is required when an old session has no recorded harness (`SESSION_OWNER_UNKNOWN`).
- `AGENT_OWNED` means another live coordinator session runs the lane: use that session or wait for its turn to end.

**Directories.** OVERDRIVE never deletes a directory it did not finish creating. For `PARTIAL_INITIALIZATION`, `FEATURE_PATH_OCCUPIED`, `LAB_PATH_OCCUPIED` or `CLONE_INVALID`, inspect the named path, keep what matters, move it aside and retry. `INTEGRATION_DIRTY` means an unfinished resolution in the integration clone: commit it or abort it there.

## Windows notes

- **Long paths:** every clone OVERDRIVE creates sets `core.longpaths=true`, so deep paths work without a system-wide change.
- **Loopback only:** bind every server to 127.0.0.1, never `0.0.0.0` or all interfaces, which triggers Windows Firewall prompts. Suites should use `OVERDRIVE_PORT`.
- **Symlinks:** Git creates symbolic links only with Developer Mode enabled (and `core.symlinks=true`); otherwise they check out as small text files. OVERDRIVE refuses to manage workspace paths that pass through a symlink or junction.
- **Line endings:** the runtime never sets `core.autocrlf`; clones, lab targets and integration builds follow your Git config. Suites that compare exact bytes should rely on the repository's `.gitattributes`.
- **Claude containment:** each Claude turn runs under a small Windows PowerShell warden in a kill-on-close Job Object, adding about half a second per turn start. Where the job cannot be created, as under Constrained Language Mode, workers run uncontained, and each later turn and pause needs an attestation.
