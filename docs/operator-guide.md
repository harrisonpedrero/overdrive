# Operator guide

The [README](../README.md) covers daily use and installation. This guide covers setup, configuration, the lab, integration and recovery.

## Setup

1. Install the plugin ([README](../README.md#installation)). OVERDRIVE looks for the worker CLI on `PATH`, and for Claude also in `~/.local/bin`. Set `CODEX_CLI_PATH` or `CLAUDE_CLI_PATH` to use a different executable; under a Codex coordinator only `CODEX_CLI_PATH` reaches the server.
2. Open an empty folder, such as `workspace/`, as the coordinator's working directory.
3. Adopt a repository with `workspace_init` (a credential-free URL, SSH remote or absolute local path), or start one from a brief with `project_create`. Either creates `overdrive.json`, `.overdrive/` and the lab. The response lists detected ecosystems and setup hints; nothing from the repository is executed.
4. Run `doctor` after setup or whenever something looks wrong. It checks Git, Node, the configured worker CLI, `overdrive.json`, database integrity, the repository cache, the managed project and lane paths.

Each lane is a full clone at `features/<slug>/repo` on `feature/<slug>`, created from the refreshed default revision or from `base_revision`. To start from another lane's unintegrated commit, pass that lane as `base_feature` and the full commit ID as `base_revision`.

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
    "allowedTools": [],
    "disallowedTools": ["Bash(git push:*)", "Bash(gh pr:*)"]
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
| `claude.disallowedTools` | `["Bash(git push:*)", "Bash(gh pr:*)"]` | Deny rules. Setting this replaces the default list. |

Model and permission changes apply from the next turn; `harness` applies to new sessions.

The worker permission policy ([architecture](architecture.md#worker-capability-profiles)) answers only the calls that prompt. A call matching `allowedTools`, or one the permission mode lets through without prompting, skips it. Under `bypassPermissions` nothing prompts, so publishing is then blocked only by `disallowedTools`. Deny rules hold in every mode, and feature agents always get deny rules for the browser and computer-control servers on top of this list.

Codex workers have no permission settings: they run in the `workspace-write` sandbox with network access, and the policy answers their escalations. Questions and MCP elicitations from a worker reach the coordinator as pending requests, answered with `agent_request_resolve`.

## The lab

`lab/` is created at initialization, or on first use in older workspaces, with a README that QA agents follow. QA agents own its contents and commit to it. Each suite is a directory:

```text
lab/suites/<name>/suite.json
{
  "description": "What this suite proves",
  "argv": ["node", "run.mjs"],
  "cwd": "suite",
  "timeout_seconds": 600,
  "features": ["search-redesign"]
}
```

- `<name>`: lowercase letters, digits, `-` and `_`.
- `argv`: 1 to 200 strings, run without a shell.
- `cwd`: `suite` (the suite directory, the default) or `target` (the checkout under test).
- `timeout_seconds`: 1 to 3600, default 600.
- `features`: optional, the lanes the suite covers.

Every run receives this environment:

| Variable | Value |
| --- | --- |
| `OVERDRIVE_TARGET` | Clean clone at the revision under test |
| `OVERDRIVE_REVISION` | Commit under test |
| `OVERDRIVE_LAB` | The lab repository |
| `OVERDRIVE_SUITE` | Suite name |
| `OVERDRIVE_ARTIFACTS` | Empty directory for this run's screenshots, logs and traces |
| `OVERDRIVE_PORT` | A free TCP port on 127.0.0.1 |

A suite starts every service it needs and stops it before exiting. Target clones keep ignored directories such as `node_modules` between runs, so dependency setup should be idempotent, for example reinstalling only when the lockfile changed. Keep dependencies and outputs out of the lab's Git with `.gitignore`, because every run snapshots the lab's working tree.

`lab_run {suite, target, revision?}` targets a lane slug or `integration`. Without a revision a lane is tested at a snapshot of its working tree, uncommitted changes included, and the integration build at its HEAD. A run is `passed` (exit 0 within the timeout), `failed`, or `uncertain` when its processes could not be confirmed stopped. Artifacts stay in `.overdrive/lab/runs/<id>/artifacts/`, with a manifest of path, size and sha256. `lab_run` returns a 4,000-character output tail; `lab_get {run}` returns the full stored tail of up to 24,000 characters and the artifact list. `lab_get` without a run lists the suites, the latest runs, the integration build and, on request, findings.

Feature agents may read the lab and run suites against their own lane only. QA agents may run any target, record findings and build integrations.

`finding_record` opens a finding on a lane (`blocking` by default, or `minor`) and messages the lane. A finding with a `repro_suite` is resolved by a passing run of that suite on the lane, or on an integration that includes it, at a revision containing the one it was found at. Only the coordinator marks a finding resolved by hand; QA agents and the coordinator can close one as `wontfix` with a note.

## Integration and publishing

`integration_build {features, base?}` merges lanes in order into `.overdrive/lab/integration`. Each entry is a lane slug, which contributes a snapshot of its working tree, or `slug@ref` for an exact revision. On a conflict, the build stops with the lane and the conflicting files, and leaves the merge in place. Resolve and commit it in the integration clone, or run `git merge --abort` there and have the lanes reconcile. Lanes after the conflict are not merged yet (`lab_get` lists them as `pending`), so rebuild to include them; rebuilds replay the recorded resolution. Then test the integration with `lab_run` on target `integration`.

`integrate {target, revision?}` takes a lane or `integration` and only committed work, so test the exact commit you mean to integrate:

- **Managed project:** fast-forwards `project/` when it is clean and on its default branch, the commit contains its HEAD, a lab run passed at that commit, and no blocking finding is open on the included lanes. The lanes become `done` and new lanes start from the new HEAD. `PROMOTION_NOT_FAST_FORWARD` means the commit does not contain the project HEAD; rebuild the integration on the current HEAD, which `integration_build` does by default.
- **Adopted repository:** publishes nothing. It returns the commit, the checkout that holds it (`path`), the passing run, any open blocking findings, and a `push` command that pushes the commit from that checkout to the repository URL: to `feature/<slug>` for a lane, or to a branch name you fill in for the integration. When the commit has a passing run and no open blocking findings, the included lanes become `done`. With the user's authority, the coordinator runs the push.

## Recovery

**Controller restart.** The first command that reads a lane whose controller has exited releases it. A busy agent becomes `uncertain` when its turn may still be running, and `disconnected` otherwise; idle agents are unchanged. Checkouts, sessions and pending messages are kept. Requests pending on the old process cannot be answered (`REQUEST_ORPHANED`); the worker asks again on its next turn. A controller sweeps messages only while it runs at least one agent, so after a restart review `feature_list` and `agent_start` the agents you want running. Their waiting messages open the new turns. A lab run left running by an exited controller is marked `uncertain` by the next run on that target.

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
