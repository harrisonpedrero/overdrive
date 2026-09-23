# Architecture

OVERDRIVE (originally Feature Theater) deliberately has no dashboard. A Codex or Claude Code conversation is the control surface, its model is the coordinating meta-agent, and a local MCP server exposes deterministic operations. Package, MCP, tool and storage identifiers keep the original `feature-theater`/`theater` names for compatibility.

## Responsibility boundary

| Layer | Owns | Does not own |
| --- | --- | --- |
| Coordinator task | User intent, spec quality, priorities, tradeoffs, steering, delivery decisions | Application edits for every lane, canonical runtime state |
| Feature task | One feature's repository exploration, implementation, bounded delegation, verification, visible handoff | Other feature context, lifecycle truth, remote authority |
| MCP runtime | Clone safety, SQLite transactions, work dependencies, leases, exact revisions, checkpoints, safe events, app-server protocol | Product judgment, inferred test adequacy, private reasoning |
| Git | Application history and diffs | Work status or semantic completion |

Diffmogger's current design uses an adaptive manager and SQLite. OVERDRIVE carries that model into the native coordinator conversation: a durable graph, explicit ownership, visible failure/repair, isolated checkouts, evidence boundaries, and exact integration candidates.

## Storage

`theater.json` identifies the repository and exact default revision. `.theater/state.sqlite3` is canonical orchestration state, including the complete recorded timeline. `.theater/index.md` is a compact cross-feature projection. `.theater/features/<slug>/spec.md` and `context.md` are feature-scoped recovery inputs. `.theater/events.ndjson` is a supplementary workspace-operation journal, not a database backup; verification and recovery events are read from the canonical timeline. `features/<slug>/repo` is a full independent clone; it does not borrow objects from the hidden mirror.

For a scratch project, `project/` is the managed canonical Git repository. OVERDRIVE seeds it with only a README, repository instructions, and an initial commit. A completed candidate may advance it only when the candidate contains its current HEAD, so promotion is an inspectable fast-forward rather than an automatic conflict resolution. The private mirror is refreshed afterward and new lanes start at the promoted revision.

Specs and context projections are plain files so a fresh agent can recover without serializing a chat transcript. SQLite keeps uniqueness, graph, lifecycle, and evidence invariants inspectable.

Planning cannot declare execution complete. Required commands execute through the runtime and retain actual exits, bounded output, exact commits, and the accepted spec/work/check contract. Reports remain labeled reported. A candidate requires the latest passing receipt for every required check, and completion/promotion repeat that validation against the clean checkout HEAD. Contract changes invalidate prior candidates; optional failures remain visible. Legacy evidence is preserved but cannot authorize a fresh candidate without execution receipts.

## Context lifecycle

Every feature has its own persisted worker session. The runtime starts it at the feature checkout and injects a feature-specific developer contract. The feature task reads the repository's own instructions and only that lane's spec/context. Worker processes disable apps, hooks, plugins, browser/computer control, and every configured external MCP server. The OVERDRIVE coordinator cannot appear recursively and external integrations remain coordinator-owned.

`theater.json` selects the worker harness and worker model. The default is a Codex app-server thread running `codex.laneModels[<slug>]`, else `codex.model`, else `gpt-6-sol`; `"harness": "claude"` runs each turn as a non-interactive Claude Code process resumed by session ID, using `claude.laneModels[<slug>]`, else `claude.model`, else the CLI's configured model. Worker model selection is independent of the coordinator's model; the top-level `model` field is coordinator metadata. A router in `app-server.mjs` binds every thread to the backend that created it, so a workspace only launches the harness it uses and a backend exit affects only its own lanes. Both backends emit the same safe event vocabulary (turn started, visible message, working diff, turn completed), and the Claude backend derives the diff from Git rather than from tool arguments.

Each start or steer schedules one bounded turn. The coordinator reconciles its visible handoff with Git and evidence before deciding whether to continue, rather than attaching an unbounded native goal loop that can retry work against stale orchestration state.

Per-feature control locks and a persisted process owner prevent competing active workers and verification/promotion races. State writes are fenced by the owning runtime token. A terminated owner becomes disconnected and its callbacks become orphaned; the next coordinator resumes the preserved task from fresh canonical projections. Native compaction during an ordinary turn does not suppress that turn's final handoff. Explicit queued compaction runs after the current turn completes. Bounded event waits expose completion and input without repeated model polling.

## Conversation composition

The presentation boundary is a versioned state snapshot and a pure work-graph renderer. `theater_view` returns Mermaid Markdown for actual work dependencies, states, and blockers; the native conversation renders it. Graphs above 24 items default to a deterministic 24-item slice that puts work needing action and its prerequisites first; callers can page through that order or focus on selected work keys, with omitted work counted by state and outside prerequisites labeled. The runtime preserves the snapshot and diagram source. No HTML interface or presentation-side actions are needed.

Observation time, omissions, and unavailable data are explicit. The remaining state sections are bounded context for normal replies, not a catalog of UI panels. Steering, switching, questions, and refresh requests stay in the existing conversation. Overviews exclude specifications and command logs; selected detail loads only one feature. The previous embedded controls and multi-panel renderer were removed because they duplicated the host conversation.

A switch writes a semantic checkpoint, changes the coordinator focus, and requests compaction of the outgoing feature thread when idle. Checkpoint freshness is a per-lane semantic generation, not a timestamp: spec revisions, work-graph and work-status changes, lifecycle changes, verification-definition changes and candidate changes (including a failing check that supersedes a candidate) advance it in the same transaction, and a switch requires the outgoing lane's latest checkpoint to have recorded the current generation. Focus, compaction, agent-session state and evidence receipts do not advance it; checkpoints from before generations existed must be renewed once. Separately, each checkpoint stores a versioned checkout fingerprint from one binary-safe `git status --porcelain=v2 -z` read: HEAD and branch, index entries that differ from HEAD, working-tree status including untracked names, and SHA-256 of the raw bytes of every working-tree-dirty and untracked file (clean tracked files are covered by Git's status and never read; ignored files, assume-unchanged/skip-worktree entries, submodule internals and untracked nested repositories are excluded). Content hashing has hard limits of 10,000 files and 256 MiB, plus a best-effort 30 s deadline checked between files; a component that cannot be observed completely is recorded as unknown, never as a partial digest. At a switch, a component that differs proves drift: an idle outgoing lane then needs a new checkpoint (`CHECKPOINT_REQUIRED`, `checkout_changed`), as does a checkpoint without a fingerprint (`checkout_unverified`, including every checkpoint saved before schema 6). An indeterminate comparison fails with `CHECKOUT_INDETERMINATE` unless the coordinator passes `accept_unverified_checkout`, which never overrides definite drift. A lane whose durable turn state says a worker may be running switches anyway with a caveat in the switch result and its context packet, even when its checkout matched the checkpoint; the caveat is cleared only by a complete checkpoint or a fresh comparison of an idle lane. Each fingerprint is a best-effort observation, not an atomic snapshot: writes between the status and content reads, after the switch observation, or reverted before it are not detected. The coordinator then loads only the destination packet. Codex does not currently expose safe host-task compaction to an MCP process, so a substantial focus change returns one explicit `/compact` recommendation rather than mutating the task from a second app-server process. Active workers are not killed merely because the human conversation moved elsewhere.

## Safe theater stream

The app-server bridge listens for visible plan updates, final agent messages, turn completion, and working-diff notifications. It stores a bounded diff summary and digest—not raw reasoning. Reasoning and raw response events are explicitly discarded. Git state and recorded commands/checks remain the proof boundary.

Approval and user-input requests are persisted in sanitized form and surfaced to the coordinator. They remain unanswered until the user authorizes a resolution; after a server restart, an old request is reported as orphaned instead of being guessed.

## Security properties

- Repository URLs with embedded credentials are rejected.
- Git and Codex commands use argv arrays; repository input is never interpolated into a shell command.
- Managed paths are containment-checked and existing symlinks/junctions are rejected.
- Full clone creation, lifecycle writes, and agent-state writes use cross-process workspace locks plus SQLite transactions.
- Setup commands are suggested from repository facts but never auto-executed during initialization.
- Codex lane tasks use Codex's `:workspace` permission profile over the feature checkout and its context packet. Apps, hooks, plugins, browser/computer control, image generation, and configured external MCP servers are disabled in their app-server process; broader filesystem or network access still requires a surfaced approval. Claude lane workers use the permission policy in `theater.json` described in the operator guide; their shell commands are not sandboxed.
- Remote pushes, PRs, conflict-producing merges, and destructive cleanup are outside the runtime.
- The only built-in integration mutation is an explicitly requested, fast-forward-only promotion into an OVERDRIVE-created local `project/`; adopted repositories retain their normal review and integration path.
