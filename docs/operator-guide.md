# Operator guide

## First run

Open `C:\path\to\feature-theater\workspace` in a fresh Codex task using GPT-6 Astra. Say `Use Feature Theater with <repository URL>`. The plugin creates local state and reports detected repository instructions, ecosystems, setup candidates, and check candidates. Review those facts; they are hints, not commands that were executed.

To begin from nothing, say `Start a new Feature Theater project called <name> that <product brief>`. The plugin creates a minimal canonical repository at `project/`, then uses the same spec, lane, agent, and evidence workflow. After a feature is completed through the candidate gate, an explicit promotion request fast-forwards that canonical repository and refreshes the mirror. A divergent or dirty canonical project is refused rather than merged or reset.

Create a lane in ordinary language. The feature clone appears at `features/<slug>/repo`; its branch is `feature/<slug>`. Feature tasks appear as normal persisted Codex tasks and can be opened directly when desired. Their app-server disables apps, hooks, plugins, browser/computer control, and external MCP servers, so a lane worker cannot call Theater recursively or bypass coordinator-owned external authority.

## Recovery

After a new coordinator task or compaction:

1. Read `.theater/index.md` or call the feature-list tool.
2. Load only the focused feature's context.
3. Reconcile the recorded task status with the native task and live Git state.
4. Continue from the saved next action; do not reconstruct old deliberation.

Switching lanes automatically compacts the outgoing feature task when it is idle. For the coordinator itself, use the single `/compact` recommendation returned after a substantial switch; MCP servers cannot safely compact the already-loaded host task from a second app-server process.

If Codex restarted during an approval prompt, the old callback cannot safely be answered. Inspect the feature, resume or steer it, and let it issue a fresh request.

An ended controller is detected by its persisted process owner; inspection clears stale activity and preserves the checkout. A running lane owned by another live coordinator cannot be started again from a competing session. Pausing requests interruption; switching focus alone preserves lifecycle state. The existing desktop coordinator still needs the explicit `/compact` command at substantial context boundaries.

## Verification and state views

Configure the relevant repository/feature commands, then have the runtime execute them against the idle, clean candidate commit. Every current required check needs a latest passing execution receipt for the current spec/work/check contract. A report, old spec, earlier pass followed by a failure, or a command that changes the checkout cannot authorize delivery. Individual receipt output is available on demand. Existing version-2 workspaces migrate automatically: historical evidence survives, but old manually authorized candidates need fresh verification.

Ask for the work graph to see dependencies, task states, and blockers as a native diagram in the conversation. Larger graphs can focus on selected work keys and label prerequisites outside the view. Other state—evidence, handoff, specs, and feature summaries—is normally answered in prose from scoped snapshots. Steering, switching, and refresh requests stay in the existing chat. There are no embedded forms, chat boxes, control panels, or separate dashboard.

## Failure handling

Initialization and clone failures preserve partial directories for diagnosis. Feature Theater will not automatically delete, stash, reset, or overwrite a dirty checkout. A failed work item remains visible; add repair work with explicit acceptance criteria. A feature blocked on user input does not freeze independent lanes.

## Updating the development install

Validate the plugin, update its Codex cachebuster, and reinstall it from the `feature-theater-local` marketplace. Test changed tools in a fresh Codex task so the task receives the new manifest, skill, and MCP process.
