# Feature Theater workspace

Open this folder in Codex with GPT-6 Astra and paste a repository URL:

> Use Feature Theater with https://github.com/owner/repository.git

Feature Theater will create its local state here. Feature clones appear under `features/`; compact specs, checkpoints, and the navigation index appear under `.theater/`. You can create, switch, inspect, pause, resume, steer, and finish features entirely through normal Codex requests.

Nothing is configured yet. Initialization never runs repository setup scripts automatically; Astra first inspects the repository profile and its instructions, then proposes or runs only the setup appropriate to the feature task.
