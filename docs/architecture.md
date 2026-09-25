# Architecture

One coordinator conversation drives a network of worker agents through the `overdrive` MCP server. The server is deterministic local code; judgment stays with the models. The process is freeform: there is no lifecycle state machine and no ceremony gate, only the invariants listed below.

## Responsibility boundary

| Party | Owns | Never owns |
| --- | --- | --- |
| Coordinator (host model) | User intent, specs, priorities, oversight of the agent network, delivery decisions, relaying the user's authority | Application edits, canonical state |
| Feature agent (one per lane) | Implementing its spec in its clone, commits on `feature/<slug>`, asking QA for verification | Other lanes, the lab, publication, browser or computer control |
| QA agent (`qa`, `qa-ui`, ...) | Harnesses, fixtures and suites in `lab/`; lab runs; findings; integration builds and conflict resolution | Product code in lane clones, publication |
| Runtime (`plugins/overdrive/scripts`) | Clones, SQLite state, message delivery, suite execution and evidence, snapshot and integration Git mechanics, the worker capability boundary | Product judgment, test adequacy, private reasoning |
| Git | Application and lab history | Lifecycle status or completion |

A QA agent is a lane row with `kind = 'qa'` whose checkout is `lab/`, so it shares every session, lock and wait mechanism with feature lanes.

## Storage layout

```text
<workspace>/
  overdrive.json            repository, default revision, harness and worker settings
  AGENTS.md, .gitignore     coordinator instructions; ignore rules for the local state below
  .overdrive/
    state.sqlite3           canonical state: lanes, specs, work, sessions, messages, lab runs, findings, events
    events.ndjson           supplementary operation journal, not a backup
    index.md                compact cross-lane projection
    locks/                  cross-process workspace locks
    cache/repository.git    private bare mirror of the source repository
    features/<slug>/        spec.md, context.md and work/ item files for each lane and QA agent
    lab/targets/<target>/   runtime-owned clean clones that suites run against
    lab/runs/<id>/artifacts/
    lab/integration/        the integration clone
  features/<slug>/
    AGENTS.md               the generated feature-agent contract
    repo/                   a full, independent clone on feature/<slug>
  lab/                      QA & integration lab: a local Git repository, never pushed
  project/                  managed canonical repository (project_create only)
```

SQLite is canonical; the Markdown files are projections that a fresh agent reads instead of a transcript. The legacy `evidence`, `candidates` and `checkpoints` tables receive no new writes; `feature_get` shows evidence rows as read-only history.

## Worker capability profiles

The profile comes from the agent's recorded `kind`, never from a tool argument.

| | Feature agent | QA agent |
| --- | --- | --- |
| Working directory | `features/<slug>/repo` | `lab/` |
| Additional roots | its context packet | every lane checkout, `.overdrive/lab`, its context packet |
| OVERDRIVE worker tools | `message_send`, `lanes`, `lab_get`, `lab_run` (its own lane only) | the same on any target, plus `finding_record` and `integration_build` |
| Browser and computer control | denied | allowed |
| Publishing | denied | denied |
| User MCP servers, connectors, plugins, skills, hooks, web tools | available | available |

**Worker-mode server.** Each worker session gets its own copy of `server.mjs` with `OVERDRIVE_AGENT=<slug>` and `OVERDRIVE_WORKSPACE=<root>`. It lists only the tools that agent's kind may call and refuses others with `WORKER_TOOL_FORBIDDEN`. Workers also get `OVERDRIVE_WORKER=1`, which leaves any copy of the coordinator plugin they load with no tools, and the coordinator plugin is disabled in their host.

**Permission policy.** `workerToolDecision` in `worker-policy.mjs` answers every tool call a worker's host would otherwise prompt for, in both harnesses:

1. Deny OVERDRIVE coordinator tools (plugin copies, or `overdrive` tools beyond the worker set).
2. For the feature profile, deny MCP tools whose server name matches `chrome|browser|computer|playwright|puppeteer|cua_repl`.
3. For every profile, deny shell commands whose text publishes: `git push` (with any options, including `subtree push`), `gh pr create|merge|edit`, `gh release`, `gh repo create`, `gh api` with a writing method, `npm|pnpm|yarn|cargo publish`, `dotnet nuget push`, `twine upload`, `docker push`.
4. Allow everything else.

Each denial is appended to the turn's handoff.

**Claude harness.** Each turn is one `claude -p` stream-json process resumed by session ID, with the contract appended to the system prompt. It runs with `--permission-mode <claude.permissionMode> --permission-prompt-tool stdio`, so prompted calls arrive as `can_use_tool` control requests that the policy answers. `--mcp-config` injects the worker server, and `--settings` disables the coordinator plugin. Feature agents get `--no-chrome` plus deny rules for the browser and computer-control servers; QA agents get `--chrome`. Auto-memory is off. On Windows the process tree runs inside a kill-on-close Job Object, so a turn's completion covers the tools it launched.

**Codex harness.** There is one app-server process per profile. The coordinator plugin and skill MCP dependency installs are disabled; for feature agents, the browser, computer-use and in-app browser features and the bundled browser and computer plugins are disabled too. Per thread, MCP servers the profile denies are replaced by disabled stand-ins, and the worker server is injected as `overdrive`. Threads run in the `workspace-write` sandbox with network access and approval policy `untrusted`. The runtime answers command, file-change and permission escalations with the policy; questions and MCP elicitations reach the coordinator as pending requests.

## Message delivery

Messages are rows in `messages`, addressed to a lane, a QA agent or `coordinator`. Workers send them with `message_send`. The coordinator sends them with `agent_steer`, which is queued as a message when the agent cannot take it now. A `finding_record` that opens or reopens a finding messages the lane with how to reproduce it. No other notification is automatic; agents decide when to talk.

The coordinator's server sweeps pending messages about every 2 seconds while it runs agents, and again as soon as a turn completes. For each recipient that has a spec:

- With a live turn in this controller, the messages steer it (for Claude, as a stdin user message).
- When it is idle and not paused, done or archived (a `blocked` or `review` lane included), a new turn starts with the batched messages as its prompt.
- Otherwise the messages stay pending: for an agent that is paused, done or archived, for an `uncertain` agent, and for one another live controller owns. The next turn to start for that agent opens its prompt with every pending message.

Delivery holds the agent's control lock, so two controllers never deliver the same message. A failed delivery is retried after 60 seconds. Messages to `coordinator` stay pending until `agents_wait` (which wakes on them) or `feature_list` returns them, once.

## Lab runs, snapshots, targets and integration

**Snapshots.** `snapshotCommit` commits a working tree through a temporary `GIT_INDEX_FILE`, parented on HEAD and dated with HEAD's time, leaving the checkout's index, branch and files untouched. A clean tree yields HEAD itself, and the same tree always yields the same commit. Snapshots stay reachable under `refs/overdrive/snapshots/<sha>` in that repository.

**Runs.** `lab_run {suite, target, revision?}` runs these steps:

1. Resolve the revision: the given ref, a lane snapshot, or the integration HEAD.
2. Under a per-target lock, fetch it into `.overdrive/lab/targets/<target>`, `checkout --detach -f`, and `git clean -fd`, which keeps ignored dependency directories.
3. Snapshot the lab as `lab_revision`, then run the suite argv without a shell, with the environment contract, timeout and output cap, and record the `lab_runs` row.

The output tail is redacted, and artifacts are listed with their path, size and sha256. A run whose processes cannot be confirmed stopped is `uncertain`, and its target directory is never reused; the next run uses a fresh sibling directory. Runs on different targets proceed in parallel.

**Findings.** A pass resolves open findings whose repro suite is the suite that ran, on the tested lane or on a lane included in the tested integration. It resolves one only when the tested commit contains the revision the finding was found at and is not an ancestor of the failing run's revision. By hand, only the coordinator marks a finding `resolved`; QA agents and the coordinator may set `wontfix` with a note.

**Integration.** `integration_build` resets `.overdrive/lab/integration` to its base: the managed `project/` HEAD, or else the refreshed default revision. It then merges each lane's snapshot or `slug@ref` with `--no-ff`, hooks disabled, under the OVERDRIVE identity. It stops at the first conflict and leaves it in place. Which lanes a commit contains is judged by Git ancestry, so a resolution an agent commits there is honored. rerere replays recorded resolutions on later builds, and a HEAD committed there after its build, such as a resolution, stays reachable under `refs/overdrive/integration/`. Uncommitted changes in the integration clone block a rebuild rather than being discarded.

**Integrate.** `integrate {target, revision?}` accepts only committed lane work, and for the integration target only a commit in the current build. For a managed project, it requires a clean `project/` on its default branch, a passing lab run at that exact commit, and no open blocking findings on the included lanes. It then fast-forwards `project/` with hooks disabled, refreshes the mirror, and marks the lanes `done`; new lanes start from the new HEAD. For an adopted repository it publishes nothing: it returns the commit, its checkout and a push command for the coordinator to run with the user's authority, and marks the included lanes `done` when the commit has a passing lab run and no open blocking findings.

## Essential invariants

1. **One live turn per agent.** Per-agent control locks, persisted owner tokens, the `uncertain` dispatch state and process-tree guards prevent a second worker turn.
2. **No data loss.** The runtime never resets, deletes or overwrites uncommitted work, and never deletes a partial directory. Only its own target clones are scratch.
3. **No remote publication by the runtime.** Pushes, pull requests and merges into an adopted repository need the user's authority, exercised by the coordinator.
4. **Evidence integrity.** A lab run is an execution the runtime performed at an exact target revision and lab snapshot. Agent reports are never recorded as runs.
5. **Fast-forward promotion.** `project/` moves only by fast-forward, to a commit with a passing lab run and no open blocking findings on the lanes it includes.

Nothing else is enforced: the work graph is checked only for valid keys and cycles, specs change as durable revisions, and agents talk whenever they choose.

## Security properties

- Repository URLs with embedded credentials are rejected.
- Every command is an argv array. Repository input and suite argv are never interpolated into a shell.
- Managed paths are containment-checked, and a path that passes through a symlink or junction is refused.
- State writes use cross-process workspace locks and SQLite transactions, and agent-state writes are fenced by the owning controller's token.
- Initialization never runs repository setup scripts. Runtime Git commands run with hooks disabled and commit signing off.
- Reasoning notifications and thinking blocks are discarded. Messages, handoffs, request payloads and run output are redacted before storage.
- The permission policy is a capability boundary, not a sandbox. It sees only calls that would prompt, and it matches publication by command text, so publishing through another route (a script, an HTTP client) is not caught. Claude workers' shell and file tools are not filesystem- or network-contained. Codex workers start in the `workspace-write` sandbox, but the runtime approves every escalation the policy does not deny.
