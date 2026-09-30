# OVERDRIVE workspace

Open this folder in a new Claude Code session or Codex task once the plugin is installed. In Codex, `.codex/config.toml` makes GPT-6 Astra the coordinator model unless you choose another.

Adopt a repository:

> Use OVERDRIVE with https://github.com/owner/repository.git

Or start from a brief:

> Start a new OVERDRIVE project called Atlas that helps teams triage incidents.

Nothing is set up yet. Initialization adds `overdrive.json`, the `.overdrive/` state directory and the QA lab in `lab/`, plus `project/` for a new project; it never runs repository setup scripts. Lane clones then appear under `features/`.

From there, ask for lanes, QA agents, progress, steering and integration in plain language. The [main README](../README.md) explains how the pieces fit.
