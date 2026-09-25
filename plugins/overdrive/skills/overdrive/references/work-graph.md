# Work graph

Most lanes need no graph: the spec is the assignment. Add one with `work_update` when a lane has internal ordering that matters, such as a schema change that two consumers build on, or when you hand its agent the work in bounded pieces.

- Give each item a stable key, a title, the bounded assignment as `description`, observable `acceptance`, and `depends_on` for real prerequisites only.
- You own item status; agents cannot edit the graph. `planned` and `ready` follow from dependencies. Set `running`, `review`, `done`, `failed`, `blocked` and `cancelled` yourself, from handoffs, Git and lab runs.
- To assign an item, set it `running` and name its key and outcome in `agent_start` or `agent_steer`. The agent's context packet points it to that item's saved description and acceptance.
- Record a failure as `failed` or `blocked` with the reason, and add a new item for new scope rather than rewriting finished work.
- `view` draws one lane's graph. Include its Markdown as returned, and add no stages, percentages or states the graph does not hold.
