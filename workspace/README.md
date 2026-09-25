# OVERDRIVE workspace

Open this folder in a fresh Codex task, or in Claude Code with the plugin installed. For Codex tasks, `.codex/config.toml` makes GPT-6 Astra the coordinator model unless you choose another.

Adopt a repository:

> Use OVERDRIVE with https://github.com/owner/repository.git

Or start from a brief:

> Start a new OVERDRIVE project called Atlas that helps teams triage incidents.

Nothing is set up yet. Initialization adds `overdrive.json`, the `.overdrive/` state directory and the QA lab in `lab/`, plus `project/` for a new project. It never runs repository setup scripts. Lane clones then appear under `features/`.

From there, ask for lanes, QA agents, progress, steering and integration in plain language. The [main README](../README.md) has examples.
