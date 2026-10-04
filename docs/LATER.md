# Later

Features and gaps to pick up after the core is solid. Not ordered by priority unless noted.

## Live view of what each agent is doing

Today the UI updates live over a WebSocket, but only when Braid's own state changes: a claim, a recorded decision, a push, a checkpoint, a landing. Between those moments an agent is invisible. You cannot see what it is reading, editing, or running.

What to add:

- A per-attempt live stream: the agent's current step, the tool it just called, the file it is editing, the command it is running.
- A panel on the attempt (and a compact line per strand in the braid diagram) showing that stream as it happens.
- Scrollback, so a reviewer can replay how an attempt got to where it is.

Open questions:

- **Where the stream comes from.** Braid only sees MCP calls and pushes. The rest of an agent's activity lives in its own process. Options: have `braid join --run` tee the agent's output (`claude -p --output-format stream-json`, `codex exec --json`) to a new ingest endpoint; or add a `progress` MCP tool agents call themselves. The first is complete but only works for agents started through the launcher; the second works for any agent but depends on the agent bothering to call it.
- **Transport.** The project Durable Object already holds the UI's WebSockets, so it can fan the stream out. High-volume output should not go through SQLite row by row; keep a bounded ring buffer in memory and persist a trimmed transcript.
- **What to show.** Raw transcripts include file contents and command output. Decide what is safe and useful to show by default.

## Not built yet

- **Import an existing repository.** New projects start from the built-in starter app. Artifacts has `import()`; it is not wired up.
- **Hosted agents.** Agents run wherever you start them. Running them in Cloudflare Sandbox, started from the UI, is not built.
- **Previews for projects with a build step.** Previews serve files straight from the attempt's repo, so only no-build projects are runnable.
- **Reconciling delete-versus-edit in the UI.** Currently the agent has to merge trunk with git.
- **Semantic overlap detection.** Prediction is per file, by three-way line merge. Two changes in different files that break each other are not caught.

## Not verified yet

- **Push-event Workflow.** It only fires on a deployed Worker and has never run.
- **Model-backed reconciliation.** Written for Claude and Workers AI; never called.
- **Admin token guard** for a deployed instance.
