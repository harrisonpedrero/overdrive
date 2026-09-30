# OVERDRIVE

**Parallel feature work on one repository, run from a single Codex or Claude Code conversation.**

You describe the work to a coordinator. It writes a spec for each feature and gives each one its own clone and worker agent. QA agents build tests in a separate lab and send failures straight to the lane that owns them. A local runtime keeps the state, runs the tests and does the Git work, so the conversation stays about what to build and whether it is done.

Nothing is pushed, opened as a pull request or merged into a repository you adopted until you ask.

## How it works

<p align="center">
  <img src="docs/assets/overdrive.svg" width="860" alt="The coordinator sends specs to feature lanes, each a full clone with its own agent. QA agents keep suites in a separate lab and exchange findings and fixes with the lanes. A local runtime holds state, delivers messages and executes lab runs. Lanes merge into an integration build, and a passing run at the exact commit with no blocking findings is required for delivery.">
</p>

**Lanes.** A lane is one feature: a full clone on `feature/<slug>`, a spec that survives restarts, and a worker agent. Lanes share no working tree, so one agent's half-finished edit is never another agent's build failure.

**The lab.** QA agents keep suites, harnesses and fixtures in `lab/`, a local Git repository beside the lanes that is never pushed. A test can span three lanes and their integration without landing in anyone's product commit, and feature agents add product tests only when you ask for them.

**Evidence.** `lab_run` executes a suite in a clean clone at an exact commit, with the lab pinned to a snapshot, and records the verdict, output and artifacts. Those records are evidence. An agent reporting that the tests pass has sent a message, and it is never recorded as a run.

**Messages.** Agents write to each other and to the coordinator directly. A QA finding reaches its lane with the suite that reproduces it, and a passing run of that suite on a commit containing the one it failed at resolves it. The coordinator steps in to decide, unblock or redirect, not to forward mail.

**Delivery.** `integration_build` merges lanes into an integration clone for QA to test. For a project OVERDRIVE manages, `integrate` fast-forwards `project/` to a commit only when a lane or integration run passed at that exact commit and no blocking finding is open. For a repository you adopted, it publishes nothing: it returns push and fetch commands, and the coordinator runs the push only with your say-so.

That is most of the machinery. Nothing moves a lane through stages; the runtime enforces the few rules it can check exactly (one live turn per agent, no lost uncommitted work, no publishing, evidence only from executed runs, fast-forward-only promotion) and leaves the rest to the coordinator's judgment. That includes not splitting: a tightly coupled change usually goes better as one lane than as three that have to agree.

## Quick start

You need Node.js 24 or later, Git, and the Claude Code or Codex CLI. Clone the repository and register the checkout as a plugin marketplace:

```sh
git clone https://github.com/harrisonpedrero/overdrive.git
cd overdrive
```

Claude Code:

```sh
claude plugin marketplace add "$PWD"
claude plugin install overdrive@overdrive-local
```

Codex:

```sh
codex plugin marketplace add "$PWD"
codex plugin add overdrive@overdrive-local
```

`"$PWD"` works in PowerShell, bash and zsh, and the quotes keep a path with spaces in one piece.

Open the `workspace/` folder in a new Claude Code session or Codex task and say what you want:

> Use OVERDRIVE with https://github.com/acme/storefront.git. Add saved carts and faster product search as separate lanes, and have QA cover checkout and search in the browser.

Later in the same conversation:

> Build an integration of both lanes, have QA run everything against it, and tell me what stands between it and a pull request.

To start from nothing instead, describe the product; the coordinator creates it as a managed project in `project/`.

The [operator guide](docs/operator-guide.md) covers updating the plugin, quieter permission prompts in Claude Code, worker models and recovery.

## Models

The coordinator is whatever model your session uses. Workers are configured separately, in the workspace's `overdrive.json`: the `harness` (`claude` when the workspace was initialized from Claude Code, otherwise `codex`), a workspace `model` and per-agent `laneModels`. Name a worker model in conversation and the coordinator records it there. Codex workers default to `gpt-6-sol`; Claude workers default to the Claude CLI's configured model. Every setting is in the [operator guide](docs/operator-guide.md#overdrivejson).

## Boundaries

Workers keep your MCP servers, connectors, skills and web tools. The runtime's permission policy denies:

- publishing, for every worker: `git push`, pull request and issue writes, releases, package publishes;
- OVERDRIVE's coordinator tools, for every worker;
- browser and computer control, for feature agents (QA agents keep it for UI testing);
- `git config --global` and `--system` writes, and file-tool writes outside the agent's own checkout (for QA, `lab/` and the integration clone) and the temp directory.

It is a capability boundary, not a sandbox. Shell commands run with your privileges and are not path-checked, and publishing is matched by command text, so a script that uploads something is not caught. On Claude Code the policy runs as a hook on every tool call; Claude Code still runs the call if the hook cannot start or times out, or if managed settings turn hooks off. On Codex it sees only escalations out of the `workspace-write` sandbox. [Architecture](docs/architecture.md#security-properties) has the details.

Private reasoning is never stored or shown.

## Documentation

- [Operator guide](docs/operator-guide.md): setup, configuration, the lab, integration, updates and recovery.
- [Architecture](docs/architecture.md): storage, capability profiles, message delivery, and how runs, findings and integration work.
