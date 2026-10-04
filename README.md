# Braid

**Intents, not branches.** A git platform for many agents changing one codebase at the same time, built on Cloudflare Workers and Artifacts.

Git merges text. It has no idea what either side was trying to do, so when two agents collide it can only show you two sets of lines. Braid keeps the *why* next to every change and uses it at the three moments it matters: while agents are working (so they hear about collisions early, with the other agent's reasoning), when changes collide (so the resolution keeps both goals), and afterwards (so every line on trunk traces to the goal that put it there).

## How it works

| Instead of | Braid has | What it is |
|---|---|---|
| Issue + branch + PR | **Intent** | A goal with acceptance criteria, stated once. |
| Branch / worktree | **Attempt** | One agent's try at an intent: a fork of trunk in its own Artifacts repo. Several agents can attempt the same intent; you compare and pick one. |
| Commit message | **Why log** | Decisions, rejected options, and assumptions the agent records as it works. Kept with the change forever. |
| Finding out at merge time | **Overlaps** | On every push, Braid diffs every live attempt against every other and predicts, per file, whether they will merge. Both agents are told on their next tool call, with the other side's reasoning. |
| CI on a pull request | **Verification** | Every commit of every attempt is run in a fresh sandbox: install, typecheck, tests, build. Results sit next to the diff, go back to the agent, and gate landing. Trunk is verified after each landing. |
| Merge conflict | **Reconciliation** | Both versions, their base, and the intent and decisions behind each side. Resolved by the agent, a model, or a person, with a rationale that is written into the landing commit. |
| Merge | **Landing** | One commit on trunk per intent (parents: trunk, attempt head). The commit message carries the goal and the why log. |
| `git blame` | **Why view** | Every line on trunk, colored by the intent that landed it. Click a line to read the decisions behind it. |

Agents connect over **MCP**, so any MCP-capable coding agent works unchanged. For agents without MCP, every tool is also a shell command (`braid <tool>`). Code moves over plain **git**.

## Run it

Needs Node 22.18 or newer, pnpm, git, Docker (running, for the verification sandbox), and a Cloudflare account on the Workers Paid plan (required for Artifacts).

```sh
pnpm install
npx wrangler login
pnpm dev            # builds the UI, runs the Worker at http://localhost:8787
```

Local dev uses the real Artifacts service through the binding; repos are created in the `braid` namespace of your account.

### See four agents collide and reconcile (no model needed)

```sh
pnpm sim --pause
```

A scripted run with deterministic "agents". Everything else is real: Artifacts forks, git pushes, MCP calls, overlap prediction, landing, and both ways of reconciling. Open the printed URL and press Enter to step through. Variants: `pnpm sim` (run straight through and clean up), `pnpm sim --until=conflict` (leave the project at the open reconciliation), `pnpm sim --keep`.

### Put real agents on it

1. Open http://localhost:8787, create a project, and open an intent or two. A project's trunk can start from the built-in starter app, from an existing git repository imported by URL, or from a local repository:

```sh
node cli/braid.mjs init http://localhost:8787 --name my-project --from /path/to/repo   # pushes that repo's HEAD as trunk
```

2. For each agent, in its own terminal:

```sh
node cli/braid.mjs join http://localhost:8787/p/<project> --intent 1 --agent claude-code --run
node cli/braid.mjs join http://localhost:8787/p/<project> --intent 2 --agent codex --run
```

`join` forks trunk into a new Artifacts repo, clones it, writes the MCP config and a `BRAID.md` brief, and (with `--run`) starts Claude Code or Codex headless in that directory. Without `--run` it prints the directory so you can start the agent yourself. Join the same intent twice to get competing attempts.

What a headless agent gets and what Braid keeps of its session:

- The agent runs with a scrubbed environment: only what it needs to run and to sign in to its own provider. `--pass-env NAME,NAME` lets more through.
- Its words, the commands it ran and the files it touched are recorded. Command output is recorded as a status line (`ok · 34 lines · 2.1 kB`); only git, test and build commands also keep the last few lines. Commands that name a credential file never keep output.
- Everything is redacted on your machine before it is sent (known key formats, bearer headers, passwords in URLs, the attempt's own tokens, secret-looking values from your environment) and again on the server.
- At landing, the intent, decisions and transcript are committed to `<project>--context`; `POST /api/p/<project>/context-credentials` returns a read token for cloning it.

This reduces what can leak; it does not sandbox the agent. A headless agent can still read anything your user can, and Codex's login shell reloads whatever your shell profile exports.

3. Watch the project page. When attempts are ready, open the intent, compare them (decisions, diff, live preview), and land one.

### Deploy

```sh
npx wrangler secret put BRAID_ADMIN_TOKEN     # required: the UI asks for it once, the CLI takes --token
npx wrangler secret put ANTHROPIC_API_KEY     # optional: model-backed reconciliation with Claude
pnpm run deploy
```

With the admin token set, everything needs it, reads included: project state contains agent session transcripts. Agents keep using their own attempt tokens. A deployed instance with no admin token refuses requests unless the `BRAID_OPEN` variable is `"true"`.

Without `ANTHROPIC_API_KEY`, the "Reconcile with a model" button uses Workers AI. Agents and people can always reconcile without any model.

## What runs where

- **Worker** (`src/worker/index.ts`): HTTP API, the MCP endpoint, static UI, and previews. `/preview/<project>/<attempt>/` serves any attempt's files straight out of its Artifacts repo, so a no-build web project is runnable per attempt with nothing deployed.
- **Durable Object, one per project** (`src/worker/project.ts`): all coordination state in SQLite (intents, attempts, why log, overlaps, reconciliations, landings), WebSocket fan-out to the UI, and the only writer to trunk, so landings are serialized.
- **Artifacts**: trunk is a repo; every attempt is a fork (`<project>--i<intent>-a<n>-<id>`). Reads use the Workers binding (`log`, `readTree`, `readBlob`, `readFile`, `fork`, `createToken`). The binding cannot write, so landing fetches trunk and the attempt into an in-memory repo with isomorphic-git, merges, and pushes over the Git protocol (`src/worker/land.ts`).
- **Workflow on push events** (`PushWorkflow`): a `cf.artifacts.repo.pushed` trigger on the whole namespace starts a Workflow for every push, which tells the owning project to re-read that attempt and recompute overlaps. Agents also call `checkpoint` after pushing, which does the same thing synchronously.
- **Runner, one per attempt** (`src/worker/runner.ts`): a Durable Object with a container. For each new commit it starts a fresh Linux instance, fetches that commit, installs, and runs the project's checks, reporting each step to the project as it goes. After a build it copies the output into its own storage and serves it as the attempt's preview, so the preview outlives the sandbox.
  - The instance has no Internet access and is given no credentials. Git and package traffic leave it only through two Worker entrypoints: one adds a read token for that attempt's repository and refuses everything else (pushes, other repositories); the other allows reads from the npm registry.
  - What runs: `braid.json` at the repository root if present (`{ "install": "...", "checks": { "name": "command" }, "preview": { "dir": "dist" } }`), otherwise the `typecheck`, `lint`, `test` and `build` scripts in `package.json`. A repository with neither is served as it is.
- **Model** (`src/worker/resolver.ts`): optional. Claude via the Anthropic SDK if a key is set, otherwise Workers AI.

## Agent tools (MCP)

`brief` · `claim` · `record` · `checkpoint` · `peek` · `message` · `check` · `ready` · `reconciliation` · `resolve` · `sync`

Every response carries `heads_up`: overlaps, messages from other agents, and trunk movement since the agent's last call. Endpoint: `POST /mcp/<project>` with the attempt token as the bearer.

## Limits

- A built preview is static files. An app that needs its own backend loads but its API calls fail (Braid's own UI is one of these).
- Verification supports Node projects (npm or pnpm). Each step has ten minutes.
- Overlap prediction is per file, by three-way line merge. It does not see semantic conflicts in different files.
- A file deleted on one side and edited on the other cannot be reconciled in the UI; the agent merges trunk with git (`sync`).
- Agents run wherever you start them. Braid verifies their commits in sandboxes but does not host the agents yet.
- Tests cover git analysis, redaction, session capture and the tar reader (`pnpm test`); the rest is exercised end to end by `pnpm sim`.

## License

MIT
