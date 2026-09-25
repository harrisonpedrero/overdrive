# OVERDRIVE

OVERDRIVE runs several features against one repository at once. Each feature gets its own clone, specification, worker session and evidence, and one coordinator conversation in Codex or Claude Code drives all of them. There is no dashboard; the conversation is the interface.


## Daily use

1. Open the control workspace: `workspace/` in a fresh Codex task, or a Claude Code session with the plugin installed ([operator guide](docs/operator-guide.md#claude-code-installation)).
2. First time only, adopt a repository with `Use OVERDRIVE with https://github.com/owner/repository.git`, or start from nothing with `Start a new OVERDRIVE project called Atlas that helps teams triage incidents.`
3. Ask for a feature in ordinary language: `Create a search-redesign lane, help me refine the spec, then start it.`
4. Check in, steer and switch as needed:
   - `List my active features and the next action for each.`
   - `Show the work graph for search-redesign.`
   - `Steer search-redesign: keep the API stable and drop the cache rewrite.`
   - `Checkpoint this lane and switch to billing-recovery.`
5. Deliver: the coordinator reviews and commits the worker's diff, runs the configured checks through the runtime against that exact commit, and records a candidate. `Show the candidate evidence and explain what is still missing.` shows the gap. In a managed project, `Promote the accepted candidate, then create the next feature from it.` fast-forwards `project/`. Pushes, pull requests and merges happen only under your authorization; the coordinator carries out work you have already authorized, and that authorization persists without routine reconfirmation.

After a restart or compaction, the coordinator recovers from `.overdrive/index.md` and the focused lane's packet; you do not need to repeat context.

## Models

The coordinator and the lane workers choose their models independently.

- **Coordinator:** the model of your Codex task or Claude Code session. `workspace/.codex/config.toml` defaults new Codex coordinator tasks to GPT-6 Astra; an explicit model choice in the task wins. The `model` field in `overdrive.json` is recorded coordinator metadata and does not select workers.
- **Codex workers** (the default harness): `gpt-6-sol`, or `codex.model` in `overdrive.json`, with `codex.laneModels[<slug>]` overriding it for one lane.
- **Claude workers** (`"harness": "claude"`): the Claude CLI's configured model, or `claude.model` / `claude.laneModels[<slug>]`. Exact IDs such as `claude-opus-5-5` are accepted.

Model changes apply to the next agent start. The [operator guide](docs/operator-guide.md#worker-harness-and-models) shows the full `overdrive.json` settings.

## Design boundary

OVERDRIVE stores orchestration state in a local SQLite database and writes compact Markdown projections under `.overdrive/`. Application changes live only in `features/<feature>/repo`. A scratch workspace also has a managed canonical repository at `project/`; accepted candidates can advance it only by a clean fast-forward, giving later lanes a verified base. OVERDRIVE records visible plans, final agent messages, Git summaries, checkpoints and explicit coordinator notes; it never records or exposes private chain-of-thought.

Each worker receives only its own spec and checkpoint packet plus the repository's instructions. Worker processes disable apps, hooks, plugins, browser/computer control and configured external MCP servers, so a lane cannot call OVERDRIVE recursively and external authority stays with the coordinator. Required checks execute through the runtime and bind to the current spec and commit; manually reported passes cannot authorize completion. The work graph renders as a native diagram in the conversation, and all steering stays in the chat.

See [architecture](docs/architecture.md) and the [operator guide](docs/operator-guide.md) for the runtime contract and recovery behavior.

