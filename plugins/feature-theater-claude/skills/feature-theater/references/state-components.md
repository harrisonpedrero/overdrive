# Work graph in the conversation

The built-in visual is a work graph, not a second interface. It shows the shape of the work: prerequisites, parallel branches, joins, actual progress states, and explicit blockers. Everything else normally belongs in the existing chat.

Call `theater_view` with the workspace and selected feature, or let it use the current focus. Render its `markdown` directly; it is a native Mermaid diagram, not an HTML content reference. Identify the feature and observation time in the surrounding reply. Arrows run from prerequisite to dependent task. Do not add fake stages, percentage-complete scores, or statuses that are not in the work graph. Empty work returns a plain message instead of an invented diagram.

For graphs above 24 work items, select the keys relevant to the user's question with `work_items`. The response counts omitted work and labels prerequisites outside the view. State that the view is partial. Do not imply that unrelated branches have disappeared or that an outside prerequisite is complete.

`theater_state` remains available for scoped, versioned data: feature summaries, work, evidence, recent activity, handoff, or spec. Those selections are context retrieval, not a catalog of UI panels. Prefer normal prose or a short list for that information. `renderWorkGraph(snapshot)` is the pure graph renderer; the saved snapshot and `.mmd` source keep its facts inspectable.

The graph is a timestamped observation, not a continuously updating dashboard. If `changedDuringRead` is true, obtain a fresh snapshot before drawing conclusions. Never add a message composer, steering form, navigation, refresh toolbar, or duplicated chat controls. Refreshes and user directions happen in the actual conversation. A graph's status labels are not a substitute for executed verification.
