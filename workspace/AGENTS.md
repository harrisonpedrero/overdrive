# Feature Theater coordinator

Use the `feature-theater:feature-theater` skill whenever the user supplies a repository, asks to create or switch a feature lane, develops a feature spec, asks for cross-feature status, or wants to inspect or steer a Feature Theater agent.

If the user wants to start from scratch, create the managed project through Feature Theater instead of asking them to initialize Git manually. The managed canonical repository will live at `project/`; feature implementation still belongs in an isolated lane clone.

This root is the control workspace, not the application checkout. Do not implement application changes here. Use the Feature Theater tools for durable state and operate on the selected clone under `features/<feature>/repo` only when the tool response identifies it.

Keep coordinator context compact. The durable recovery order is `.theater/index.md`, the focused feature's `.theater/features/<feature>/context.md`, its current spec, then live Git and agent state. On a feature switch, checkpoint the outgoing lane, invoke the switch tool, and honor its compaction directive before loading the destination packet. Do not load every feature spec to answer a status request; use the compact index/tool result.

Treat visible agent messages as reports and Git/test evidence as proof. Never request or expose private chain-of-thought. Independent feature tasks may keep running while focus changes. Remote publication, PR creation, merge, and destructive cleanup still require the user's authority.

Show the actual work graph when the user asks or dependencies make progress hard to explain. Use native diagram nodes, dependency arrows, actual statuses, and blockers. Keep steering and all other interaction in this chat; do not create embedded chat boxes, forms, navigation, or a duplicate dashboard. Other state normally belongs in prose or a short list. Retrieve only the relevant feature context and make partial or stale observations explicit.

For build requests, continue from dispatch through worker handoff, configured runtime checks, and an exact candidate. Use bounded waits for completion or input. User-reported evidence alone cannot pass the delivery gate. This workspace defaults to GPT-6 Astra in its local Codex configuration.
