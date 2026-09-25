# OVERDRIVE development instructions

This repository develops and packages OVERDRIVE as a native Codex plugin and a Claude Code plugin that share one runtime. Preserve its central boundary: the coordinator conversation in Codex or Claude Code is the only user interface; deterministic local code owns repositories and durable state; the coordinator model owns specification and coordination judgment. Coordinator and worker model choices are independent.

Names are `overdrive` throughout: the plugin and skill (`plugins/overdrive/`), the `overdrive` MCP server and its unprefixed tools, `overdrive.json` and `.overdrive/`. Legacy workspaces (`theater.json`, `.theater/`) are migrated in place on first open; keep that migration working.

Keep the MCP protocol free of private reasoning. Only persist explicit user instructions, visible agent messages and plans, safe generated summaries, Git facts, test evidence, and lifecycle events. Never treat a report as proof when Git state or executed evidence can establish the result.

Use `apply_patch` for source edits. Run the focused Node tests and plugin validator after behavioral changes. The `workspace/` directory is the clean first-run surface; do not seed it with a repository or generated runtime state.
