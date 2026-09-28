# OVERDRIVE

OVERDRIVE runs parallel feature work against one repository from a single Codex or Claude Code conversation. Each feature lane gets its own full clone, spec and worker agent. QA agents build and run test suites in a separate lab and send findings straight to the lanes, and agents message each other as they work. A local runtime owns the clones, the durable state, the test evidence and the integration Git mechanics, and enforces what each worker may do. The conversation is the only interface.

## Daily use

Open `workspace/` as the coordinator's working directory and ask in ordinary language:

- `Use OVERDRIVE with https://github.com/owner/repository.git`
- `Start a new OVERDRIVE project called Atlas that helps teams triage incidents.`
- `Create a search-redesign lane, help me refine the spec, then start it.`
- `Add a QA agent that covers the search and checkout journeys in the browser.`
- `What is every agent doing, and is anything waiting on me?`
- `Tell search-redesign to keep the public API stable.`
- `Build an integration of search-redesign and billing-recovery and have QA test it.`
- `Integrate the tested build into the project.`
- `Push the tested search-redesign commit and open a pull request.`

Agents run in parallel and coordinate through messages; the coordinator steps in to decide, unblock or redirect. Nothing is pushed, opened as a pull request or merged into an adopted repository until you ask.

## Models and harnesses

The coordinator uses the model of your Codex task or Claude Code session. `workspace/.codex/config.toml` makes GPT-6 Astra the default for Codex tasks opened in `workspace/`.

Workers are configured separately in the workspace's `overdrive.json`:

```json
{
  "harness": "codex",
  "codex": { "model": "gpt-6-sol", "laneModels": { "search-redesign": "gpt-6-luna" } }
}
```

`harness` is `codex` (the default) or `claude`. The matching `codex` or `claude` object sets a workspace `model` and per-agent `laneModels`, keyed by lane slug or QA agent name. Codex workers default to `gpt-6-sol`; Claude workers default to the Claude CLI's configured model and accept exact IDs such as `claude-opus-5-5`. When you name a worker model, the coordinator records it here. The [operator guide](docs/operator-guide.md#overdrivejson) lists every setting.

## The lab

`lab/` in the workspace is a local Git repository that belongs to the QA agents: harnesses, fixtures and suites at `lab/suites/<name>/suite.json`. It is decoupled from the product repository and never pushed, so tests can span several lanes and their integration without landing in product commits. Feature agents do not add tests to the product repository unless you ask for them. Work that should never ship, such as probes, generated data and plans, stays in each agent's `.overdrive-workbench/`, which OVERDRIVE keeps out of Git and delivery.

Only runs the runtime executes count as evidence. `lab_run` runs a suite in a clean clone at an exact revision of a lane (by default its committed HEAD, or for the lane's own agent a snapshot of its working tree, uncommitted changes included) or of the integration build, with the lab itself pinned to a snapshot, and records the verdict, output and artifacts. An agent's report of a passing test is never recorded as a run. A passing run of a finding's repro suite resolves that finding, and integrating into a managed project requires a passing lane or integration run at that exact commit, never a base control run, with no open blocking findings.

## Boundaries

- The coordinator owns intent, specs, priorities, delivery decisions and your authority.
- The runtime never pushes, never resets or deletes uncommitted work, and moves a managed `project/` only by fast-forward.
- Every worker keeps your MCP servers, connectors, skills and web tools. The runtime denies publishing (push, pull request, release, package publish) to all workers, browser and computer control to feature agents, and OVERDRIVE's coordinator tools to both.
- Private reasoning is never stored or shown; visible messages are reports, not proof.

[Architecture](docs/architecture.md) describes how the runtime enforces this; the [operator guide](docs/operator-guide.md) covers configuration, the lab, integration and recovery.

## Installation

Requirements: Node.js 24 or later, Git, and the CLI of the worker harness you use (Codex or Claude Code). Both hosts install from the `overdrive-local` marketplace in this repository.

Codex:

```powershell
codex plugin marketplace add C:\path\to\overdrive
codex plugin add overdrive@overdrive-local
```

Claude Code:

```powershell
claude plugin marketplace add C:\path\to\overdrive
claude plugin install overdrive@overdrive-local
```

Start a new task or session afterward so it loads the plugin. For a single Claude Code session without installing, run `claude --plugin-dir C:\path\to\overdrive\plugins\overdrive`.

Claude Code asks before every OVERDRIVE call. To be asked only where Codex asks (adopting a repository, integrating, and answering an agent's request), add this to your user or project settings:

```json
"permissions": {
  "allow": ["mcp__plugin_overdrive_overdrive"],
  "ask": [
    "mcp__plugin_overdrive_overdrive__workspace_init",
    "mcp__plugin_overdrive_overdrive__integrate",
    "mcp__plugin_overdrive_overdrive__agent_request_resolve"
  ]
}
```

Keep only one copy of the coordinator plugin enabled. If another copy is installed under a different name, disable it with `claude plugin disable <plugin>@<marketplace>` in Claude Code, or with `enabled = false` under its `[plugins."<plugin>@<marketplace>"]` entry in `~/.codex/config.toml`.

## Existing workspaces

OVERDRIVE upgrades a workspace in the older layout the first time it opens it. Before any lock or database is opened, the state directory and configuration file are renamed to `.overdrive/` and `overdrive.json`, the workspace `.gitignore` and `AGENTS.md` are updated, and the database schema is upgraded in place. Lanes, specs, work, agent sessions and history carry over, and recorded evidence stays readable in `feature_get`. Close other sessions using the workspace first. If both the old and the new state exist, OVERDRIVE stops with `MIGRATION_CONFLICT`; keep the one holding current state and move the other aside.
