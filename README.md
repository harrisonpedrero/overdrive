# Feature Theater

Feature Theater is a native Codex plugin for running several product ideas against one repository without mixing their code or context. It combines the durable feature graph and evidence discipline of Diffmogger with Agent Diff Theater's safe live progress and mid-turn steering. There is no dashboard or extension: Codex is the interface, and GPT-6 Astra is the coordinator.

## Try it

1. Open `workspace/` in Codex and start a new task with GPT-6 Astra.
2. Adopt code with `Use Feature Theater with https://github.com/owner/repository.git`, or start fresh with `Start a new Feature Theater project called Atlas that helps teams triage incidents.`
3. Then ask for a feature in ordinary language, for example: `Create a search-redesign lane, help me refine the spec, then start it.`

The coordinator can create isolated clones, revise versioned specs, maintain a dependency graph, launch or resume per-feature Codex tasks, inspect safe progress, steer an active turn, record evidence, and switch focus. Each feature task receives only its own spec and checkpoint packet plus the repository's own instructions. Worker processes disable apps, hooks, plugins, browser/computer control, and configured external MCP servers. That prevents recursive Theater calls and keeps external authority in the coordinator.

Useful requests include:

- `List my active features and the next action for each.`
- `Switch to search-redesign and show me its current spec.`
- `Steer search-redesign: keep the API stable and drop the cache rewrite.`
- `Checkpoint this lane and switch to billing-recovery.`
- `Record the tested commit as an integration candidate.`
- `Promote the accepted foundation candidate, then create the next feature from it.`

## Design boundary

Feature Theater stores orchestration state in a local SQLite database and writes compact Markdown projections under `.theater/`. Application changes live only in `features/<feature>/repo`. A scratch workspace also has a managed canonical repository at `project/`; accepted candidates can advance it only by a clean fast-forward, giving later lanes a verified base. Feature Theater records visible plans, final agent messages, Git summaries, checkpoints, and explicit coordinator notes; it never records or exposes private chain-of-thought.

See [architecture](docs/architecture.md) and [operator guide](docs/operator-guide.md) for the runtime contract and recovery behavior.
