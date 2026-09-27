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
    lab/snapshots/<target>/ runtime-owned checkouts of lab snapshots that suites run from
    lab/runs/<id>/artifacts/
    lab/integration/        the integration clone
  features/<slug>/
    repo/                   a full, independent clone on feature/<slug>
  lab/                      QA & integration lab: a local Git repository, never pushed, with README.md and ENVIRONMENT.md
  project/                  managed canonical repository (project_create only)
```

SQLite is canonical; the Markdown files are projections that a fresh agent reads instead of a transcript. The legacy `evidence`, `candidates` and `checkpoints` tables receive no new writes; `feature_get` shows evidence rows as read-only history.

## Worker capability profiles

The profile comes from the agent's recorded `kind`, never from a tool argument.

| | Feature agent | QA agent |
| --- | --- | --- |
| Working directory | `features/<slug>/repo` | `lab/` |
| Additional roots | its context packet | every lane checkout, `.overdrive/lab`, its context packet |
| File tool writes | its checkout | `lab/` and the integration clone |
| OVERDRIVE worker tools | `message_send`, `lanes`, `lab_get`, `lab_run` (its own lane only) | the same on any target, plus `finding_record` and `integration_build` |
| Browser and computer control | denied | allowed |
| Publishing | denied | denied |
| Global or system Git configuration | denied | denied |
| User MCP servers, connectors, plugins, skills, hooks, web tools | available | available |

**Worker-mode server.** Each worker session gets its own copy of `server.mjs` with `OVERDRIVE_AGENT=<slug>` and `OVERDRIVE_WORKSPACE=<root>`. It lists only the tools that agent's kind may call and refuses others with `WORKER_TOOL_FORBIDDEN`. Workers also get `OVERDRIVE_WORKER=1`, which leaves any copy of the coordinator plugin they load with no tools, and the coordinator plugin is disabled in their host.

**Permission policy.** `workerToolDecision` in `worker-policy.mjs` is the one policy both harnesses apply, to every Claude tool call and every Codex escalation:

1. Deny OVERDRIVE coordinator tools (plugin copies, or `overdrive` tools beyond the worker set).
2. For the feature profile, deny MCP tools whose server name matches `chrome|browser|computer|playwright|puppeteer|cua_repl`.
3. For every profile, deny shell commands whose text publishes: `git push` (with any options, including `subtree push`), `gh pr` and `gh issue` subcommands that write (such as `create`, `merge`, `edit`, `comment`, `review`, `close`; reads such as `view`, `list` and `diff` stay allowed), `gh release`, `gh repo create`, `gh api` with a writing method, `npm|pnpm|yarn|cargo publish`, `dotnet nuget push`, `twine upload`, `docker push`.
4. For every profile, deny `git config` with `--global` or `--system`; reads such as `--get` and `--list` stay allowed. A worker once renamed the user's global Git identity.
5. Deny a file tool write (Claude's `Write`, `Edit`, `MultiEdit`, `NotebookEdit`; a Codex patch whose approval Codex requests) to any path outside the agent's write roots and the OS temp directory, or inside a `.git` directory. The temp directory never covers the workspace or the plugin, even when they lie inside it. A feature agent writes only in its checkout, so not in `lab/`, another lane or `~/.gitconfig`; a QA agent writes in `lab/` and the integration clone, not in lane checkouts. Shell commands are not path-checked.
6. Deny any other call Claude Code flags as a safety check (a protected path or a destructive command), including one nested in a compound shell command.
7. Allow everything else.

Each denial is appended to the turn's handoff.

**Claude harness.** Each turn is one `claude -p` stream-json process resumed by session ID, with the contract appended to the system prompt. It runs with `--permission-mode <claude.permissionMode> --permission-prompt-tool stdio`, so prompted calls arrive as `can_use_tool` control requests that the policy answers. `--mcp-config` injects the worker server. `--settings` disables the coordinator plugin, adds a `PreToolUse` hook that applies the same policy, with the agent's write roots, to every tool call, including calls a permission mode or allow rule approves, and sets `disableAllHooks: false` and the coordinator's `NODE_OPTIONS`, which outrank a repository's own settings, so those cannot switch the hook off or keep its Node from starting. A prompted call Claude Code types `safetyCheck` passes only as a file write the path rule vetted. Feature agents get `--no-chrome` plus deny rules for the browser and computer-control servers; QA agents get `--chrome`. Every worker gets a deny rule for `ScheduleWakeup`, because the process exits when the turn ends. Auto-memory is off. `CLAUDE_AUTO_BACKGROUND_TASKS=1` lets Claude Code move an MCP call such as `lab_run` to the background after two minutes, so the agent keeps working and takes queued messages in; the turn stays open until every background task has reported, and `agent_inspect` lists those still running as `liveProgress.background`. On Windows the process tree runs inside a kill-on-close Job Object, so a turn's completion covers the tools it launched.

**Codex harness.** There is one app-server process per profile. The coordinator plugin and skill MCP dependency installs are disabled; for feature agents, the browser, computer-use and in-app browser features and the bundled browser and computer plugins are disabled too. Per thread, MCP servers the profile denies are replaced by disabled stand-ins, and the worker server is injected as `overdrive`. Threads run in the `workspace-write` sandbox with network access and approval policy `untrusted`. The runtime answers command, file-change and permission escalations with the policy; for a file-change approval request, which Codex sends for an ordinary patch under `untrusted` after the patch's `item/started`, the policy checks the paths that event and any `item/fileChange/patchUpdated` named. A patch Codex applies without a request, such as under preapproved permissions or a cached approval, bypasses this check; the installed app-server schema proves only the request's shape. Questions and MCP elicitations reach the coordinator as pending requests.

## Message delivery

Messages are rows in `messages`, addressed to a lane, a QA agent or `coordinator`. Workers send them with `message_send`. The coordinator sends them with `agent_steer`, which is queued as a message when the agent cannot take it now. A `finding_record` that opens or reopens a finding messages the lane with how to reproduce it; if the finding is closed (resolved or `wontfix`) while that message is still pending, it is marked `withdrawn` and never delivered. No other notification is automatic; agents decide when to talk.

The coordinator's server sweeps pending messages about every 2 seconds while it runs agents, and again as soon as a turn completes. For each recipient that has a spec:

- With a live turn in this controller, the messages steer it (for Claude, as a stdin user message).
- When it is idle and not paused, done or archived (a `blocked` or `review` lane included), a new turn starts with the batched messages as its prompt.
- Otherwise the messages stay pending: for an agent that is paused, done or archived, for an `uncertain` agent, and for one another live controller owns. The next turn to start for that agent opens its prompt with every pending message.

Delivery holds the agent's control lock, so two controllers never deliver the same message. A failed delivery is retried after 60 seconds. Messages to `coordinator` stay pending until `agents_wait` (which wakes on them) or `feature_list` returns them, once; `feature_list` with `coordinator_messages: "recent"` pages them again, pending and delivered, without delivering any.

## Lab runs, snapshots, targets and integration

**Snapshots.** `snapshotCommit` commits a working tree through a temporary `GIT_INDEX_FILE`, parented on HEAD and dated with HEAD's time, leaving the checkout's index, branch and files untouched. A clean tree yields HEAD itself, and the same tree always yields the same commit. Snapshots stay reachable under `refs/overdrive/snapshots/<sha>` in that repository.

**Runs.** `lab_run {suite, target, revision?}`, or `lab_run {batch}` with 1-8 such runs, all checked before any starts, runs these steps:

1. Snapshot the lab working tree as `lab_revision`, once per call, and read each `suite.json` from that commit.
2. Resolve the revision: the given ref, a lane snapshot when the lane's own agent runs the suite or else the lane HEAD, the integration HEAD, or for the `base` control target the managed `project/` HEAD or the cached default revision. A `base` commit ID that neither holds, such as a foundation lane's commit, is resolved in the first feature lane checkout that has it.
3. Under a per-target lock, fetch it into `.overdrive/lab/targets/<target>`, a clone whose `origin` is the repository as in lane clones, `checkout --detach -f`, and `git clean -fd`, which keeps ignored dependency directories. A call runs up to three of its runs on one target at once, in `<target>`, `<target>--s1` and `<target>--s2`, after resolving their revisions one at a time.
4. When a run of the same suite on this target at the same revision, lab revision and mutant ended after the call arrived, return it marked `reused`. Otherwise sync `lab_revision` the same way into `.overdrive/lab/snapshots/` under the slot's directory name, for a mutant run apply its patch blob as committed at `lab_revision`, not the checkout's line-ending-converted copy, to the target checkout with `git apply` (such a run is a control of the suite, never evidence about the target), run the suite argv from there without a shell, with `OVERDRIVE_LAB` set to that checkout and the environment contract, timeout and output cap, and record the `lab_runs` row. Neither the suite nor its harness is read from the live lab, which QA may be editing.

The output keeps its last 500,000 characters of stdout and stderr in arrival order; it is redacted and written to `.overdrive/lab/runs/<id>/output.log`, and the row keeps its last 24,000 characters. Artifacts are listed with their path, size and sha256. A run whose processes cannot be confirmed stopped is `uncertain`, and its target and lab snapshot directories are never reused; the next run uses fresh sibling directories. A call holds its agent until it returns or the host moves it to the background, as Claude Code does after two minutes, so runs on different targets proceed in parallel across agents, within one batch, or across a Claude worker's backgrounded calls. A call on a busy target queues for its lock as long as its runs there could still finish within an hour (at least two minutes), then fails with `WORKSPACE_BUSY`; in a batch, only that target's runs fail.

**Findings.** A pass resolves open findings whose repro suite is the suite that ran, on the tested lane or on a lane included in the tested integration. It resolves one only when the tested commit contains the revision the finding was found at and is not an ancestor of the failing run's revision: the suite's latest failure on the lane or on integration when the finding was opened, reopened or given its repro suite. The finding is found at the lane revision that failure tested (for an integration run, the one its recorded build merged), or at the lane HEAD when that cannot be established or a reopened finding has no failure since it closed. When that failure is relevant to the finding (it failed the repro suite, tested the lane and contains the revision the finding was found at) and tested several lanes, the pass must also test every one of them; extra lanes and a rebuilt integration commit are fine. By hand, only the coordinator marks a finding `resolved`; QA agents and the coordinator may set `wontfix` with a note.

**Integration.** `integration_build` resets `.overdrive/lab/integration` to its base: the managed `project/` HEAD, or else the refreshed default revision. It then merges each lane's committed HEAD or `slug@ref`, hooks disabled, under the OVERDRIVE identity; a lane that already contains the build so far is fast-forwarded, so a lane commit QA already tested can be the integration head. A merge commit is dated at its later parent, so rebuilding the same lanes on the same base gives the same commit, and runs already recorded at it still count; the build returns each suite's latest run at its head. While the clone is clean at the recorded head, a request for the same lane revisions on the same base, in any order, returns that build as `reused` without merging or recording anything. It stops at the first conflict, and previews each later lane with `git merge-tree` against the build so far, which leaves the clone untouched; a QA agent's conflicted merge stays in place for it to resolve, with `zdiff3` markers, and the coordinator's is aborted. Which lanes a commit contains is judged by Git ancestry, so a resolution an agent commits there is honored. rerere replays recorded resolutions on later builds, and a HEAD committed there after its build, such as a resolution, stays reachable under `refs/overdrive/integration/`. Uncommitted changes in the integration clone block a rebuild rather than being discarded.

**Integrate.** `integrate {target, revision?}` accepts only committed lane work, and for the integration target only a commit in the current build. For a managed project, it requires a clean `project/` on its default branch, a passing lane or integration lab run at that exact commit (a base control run never counts), and no open blocking findings on the included lanes. It then fast-forwards `project/` with hooks disabled, refreshes the mirror, and marks `done` each included lane whose agent is not in a turn, whose checkout is clean and whose HEAD it contains; new lanes start from the new HEAD. Its `next` note names other agents still in a turn and unread messages to the coordinator. For an adopted repository it publishes nothing: it returns the commit, its checkout, a push command for the coordinator to run with the user's authority and a fetch command that brings the commit into the user's own clone as a branch, keeps the commit reachable under `refs/overdrive/delivered/` in that checkout, and, when the commit has a passing lab run and no open blocking findings, marks included lanes `done` by the same rule.

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
- Reasoning notifications, thinking blocks and tool results are discarded; a running tool call is held in memory only, as its name and a short redacted label (a shell call's command). Messages, handoffs, request payloads and run output are redacted before storage.
- The permission policy is a capability boundary, not a sandbox. Workers run repository code and its Claude project configuration with the user's privileges, and the policy holds whatever those settings allow. On Claude its hook sees every tool call and a repository's `disableAllHooks` cannot turn it off, but Claude Code runs the call anyway if the hook process cannot start or times out, or if managed settings turn hooks off (`disableAllHooks`, `allowManagedHooksOnly`). On Codex it sees only escalations. It matches publication by command text, so publishing through another route (a script, an HTTP client) is not caught, and it checks only file tools' paths, so a shell command can still write anywhere the user can. Claude workers' shell tools are not filesystem- or network-contained. Codex workers start in the `workspace-write` sandbox, but the runtime approves every escalation the policy does not deny.
