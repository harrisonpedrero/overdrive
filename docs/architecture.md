# Architecture

Feature Theater deliberately has no dashboard. Codex is the control surface, GPT-6 Astra is the meta-agent, and a local MCP server exposes deterministic operations.

## Responsibility boundary

| Layer | Owns | Does not own |
| --- | --- | --- |
| Coordinator task | User intent, spec quality, priorities, tradeoffs, steering, delivery decisions | Application edits for every lane, canonical runtime state |
| Feature task | One feature's repository exploration, implementation, bounded delegation, verification, visible handoff | Other feature context, lifecycle truth, remote authority |
| MCP runtime | Clone safety, SQLite transactions, work dependencies, leases, exact revisions, checkpoints, safe events, app-server protocol | Product judgment, inferred test adequacy, private reasoning |
| Git | Application history and diffs | Work status or semantic completion |

This replaces Diffmogger's Temporal control plane with Astra's adaptive coordination while retaining the parts that prevent drift: a durable graph, explicit ownership, visible failure/repair, isolated checkouts, evidence boundaries, and exact integration candidates.

## Storage

`theater.json` identifies the repository and exact default revision. `.theater/state.sqlite3` is canonical orchestration state. `.theater/index.md` is a compact cross-feature projection. `.theater/features/<slug>/spec.md` and `context.md` are feature-scoped recovery inputs. `.theater/events.ndjson` mirrors safe events for inspection and recovery. `features/<slug>/repo` is a full independent clone; it does not borrow objects from the hidden mirror.

For a scratch project, `project/` is the managed canonical Git repository. Feature Theater seeds it with only a README, repository instructions, and an initial commit. A completed candidate may advance it only when the candidate contains its current HEAD, so promotion is an inspectable fast-forward rather than an automatic conflict resolution. The private mirror is refreshed afterward and new lanes start at the promoted revision.

Specs and context projections are plain files so a fresh agent can recover without serializing a chat transcript. SQLite keeps uniqueness, graph, lifecycle, and evidence invariants inspectable.

Planning cannot declare execution complete: work status changes go through lifecycle transitions, dependency readiness, and ownership leases. A candidate requires passing evidence at its exact revision, and completion additionally requires that candidate to remain the clean checkout HEAD.

## Context lifecycle

Every feature has its own persisted Codex thread. The runtime starts it at the feature checkout with GPT-6 Astra and injects a feature-specific developer contract. The feature task reads the repository's own instructions and only that lane's spec/context. Worker app-server processes disable apps, hooks, plugins, browser/computer control, and every configured external MCP server. The Theater coordinator cannot appear recursively and external integrations remain coordinator-owned.

Each start or steer schedules one bounded turn. The coordinator reconciles its visible handoff with Git and evidence before deciding whether to continue, rather than attaching an unbounded native goal loop that can retry work against stale orchestration state.

A switch writes a semantic checkpoint, changes the coordinator focus, and requests compaction of the outgoing feature thread when idle. The coordinator then loads only the destination packet. Codex does not currently expose safe host-task compaction to an MCP process, so a substantial focus change returns one explicit `/compact` recommendation rather than mutating the task from a second app-server process. Active workers are not killed merely because the human conversation moved elsewhere.

## Safe theater stream

The app-server bridge listens for visible plan updates, final agent messages, turn completion, and working-diff notifications. It stores a bounded diff summary and digest—not raw reasoning. Reasoning and raw response events are explicitly discarded. Git state and recorded commands/checks remain the proof boundary.

Approval and user-input requests are persisted in sanitized form and surfaced to the coordinator. They remain unanswered until the user authorizes a resolution; after a server restart, an old request is reported as orphaned instead of being guessed.

## Security properties

- Repository URLs with embedded credentials are rejected.
- Git and Codex commands use argv arrays; repository input is never interpolated into a shell command.
- Managed paths are containment-checked and existing symlinks/junctions are rejected.
- Full clone creation, lifecycle writes, and agent-state writes use cross-process workspace locks plus SQLite transactions.
- Setup commands are suggested from repository facts but never auto-executed during initialization.
- Lane tasks use Codex's `:workspace` permission profile over the feature checkout and its context packet. Apps, hooks, plugins, browser/computer control, image generation, and configured external MCP servers are disabled in their app-server process; broader filesystem or network access still requires a surfaced approval.
- Remote pushes, PRs, conflict-producing merges, and destructive cleanup are outside the runtime.
- The only built-in integration mutation is an explicitly requested, fast-forward-only promotion into a Feature Theater-created local `project/`; adopted repositories retain their normal review and integration path.
