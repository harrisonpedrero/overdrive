# Feature Theater development instructions

This repository develops and packages the native Feature Theater Codex plugin. Preserve its central boundary: Codex is the only user interface; deterministic local code owns repositories and durable state; GPT-6 Astra owns specification and coordination judgment.

Keep the MCP protocol free of private reasoning. Only persist explicit user instructions, visible agent messages and plans, safe generated summaries, Git facts, test evidence, and lifecycle events. Never treat a report as proof when Git state or executed evidence can establish the result.

Use `apply_patch` for source edits. Run the focused Node tests and plugin validator after behavioral changes. The `workspace/` directory is the clean first-run surface; do not seed it with a repository or generated runtime state.
