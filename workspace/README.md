# Feature Theater workspace

Open this folder in a fresh Codex task; its local configuration defaults to GPT-6 Astra. Paste a repository URL:

> Use Feature Theater with https://github.com/owner/repository.git

Or begin without a repository:

> Start a new Feature Theater project called Atlas that helps teams triage incidents.

Feature Theater will create its local state here. Feature clones appear under `features/`; compact specs, checkpoints, and the navigation index appear under `.theater/`. You can create, switch, inspect, pause, resume, steer, and finish features entirely through normal Codex requests.

Nothing is configured yet. Existing-repository initialization never runs setup scripts automatically. Scratch initialization creates a minimal local Git repository under `project/`; completed, evidence-backed candidates can be promoted there by fast-forward so each later lane inherits accepted work.

Ask “Show the work graph” to see dependencies, progress, and blockers directly in the conversation. Ask questions and steer through this chat as usual. Delivery requires current executed checks; the coordinator keeps reports and verified results distinct.
