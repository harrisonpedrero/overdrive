# Composing state inside the coordinator conversation

Use components to help the user understand, choose, or steer. Ordinary prose is sufficient for a single fact. For an overview or a meaningful feature transition, call `theater_view` with the smallest useful composition and embed its returned `contentReference` on its own line in the same response.

| User need | Components in display order | Context loaded |
| --- | --- | --- |
| What is active or blocked? | `features` | Compact cross-feature rows only |
| Where are we on this feature? | `work`, `handoff` | Selected work, dependencies, checkpoint, requests |
| Is this ready to accept? | `evidence`, `handoff` | Current Git, required command receipts, candidate, unresolved work |
| What changed while I was away? | `activity`, `handoff` | Bounded safe events and current next action |
| Refine the feature | `spec`, `work` | Current spec, recent revision reasons, selected work |

These are composable patterns, not permanent pages. You can change their order, use one alone, or choose a different subset as the user's need changes. `theater_view_catalog` describes the available primitives.

## State contract

`theater_state` returns the same versioned data used by the renderer without producing a view. It includes `schemaVersion`, `id`, `observedAt`, `stateVersion`, `digest`, `changedDuringRead`, explicit omissions, and only the requested sections. The workspace is identified by both id and absolute path. Feature lifecycle and agent execution are separate fields. Counts describe work items, not an invented percentage of product completion. Missing evidence, unavailable Git, and disconnected agents remain explicit unknown or incomplete states.

Use this data when the user needs a custom composition the built-in patterns cannot express. Follow the available visualization skill for the host's rendering contract. The plugin's `scripts/presentation.mjs` exports `COMPONENTS`, `snapshotState`, and the pure `renderState(snapshot)` function for reusable composition. Keep the snapshot accessible beside any derived view; do not invent facts or infer success from a visual color.

## Interaction and freshness

Views are immutable observations. Their timestamp remains visible; they never claim to update themselves while an agent works. Refresh obtains a new observation through Astra. Local disclosure controls only reveal already selected data. Inspect, switch, refresh, and steering actions use the host's `window.openai.sendFollowUpMessage` bridge. The coordinator re-reads current state and performs the normal workflow. A view never invokes MCP tools, fetches a local server, grants permissions, or promotes a candidate directly.

If `changedDuringRead` is true, refresh before a delivery decision. A prior snapshot, candidate, or button label never authorizes acting on stale state. Keep direction text and selected feature identity in the follow-up request. A screenshot or view is presentation, not test evidence.

The renderer escapes all data, uses host theme/control utilities, and stacks at narrow widths. Retain accessible labels and native controls when composing a custom view. Do not build an application shell, navigation sidebar, global toolbar, or duplicate dashboard around these components.
