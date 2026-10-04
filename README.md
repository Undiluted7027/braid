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
| Review comments | **Response** | A person sends an attempt back with a note, or answers a question the agent recorded. The agent hears it on its next step (Braid starts a hosted agent again to act on it), and the note is kept with the attempt's decisions, so it is in the landing commit too. |
| Merge conflict | **Reconciliation** | Each place the two sides disagree, with their base and the intent and decisions behind each side. Resolved one conflict at a time by the agent, a model, or a person, with a rationale that is written into the landing commit. Two added dependencies are not a conflict: `package.json` is merged by key and the lockfile is regenerated in a sandbox. |
| Merge | **Landing** | One commit on trunk per intent (parents: trunk, attempt head). The commit message carries the goal and the why log. Trunk only takes what has been run: the attempt's commit must have passed, and if trunk has moved since, the merge of the two is verified first. |
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

A scripted run with deterministic "agents". Everything else is real: Artifacts forks, git pushes, MCP calls, overlap prediction, the starter app's tests run in a sandbox for every commit and every merge, landing, and both ways of reconciling. Open the printed URL and press Enter to step through. Variants: `pnpm sim` (run straight through and clean up), `pnpm sim --until=conflict` (leave the project at the open reconciliation), `pnpm sim --keep`.

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

On a machine without this repository, the instance serves the launcher as one file, and "Add an agent" on an intent shows the exact command:

```sh
curl -fsSLO https://<your-instance>/braid.mjs
node braid.mjs join https://<your-instance>/p/<project> --intent 1 --agent claude-code --run
```

On an instance with an admin token, set `BRAID_ADMIN_TOKEN` in the environment first.

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
npx wrangler secret put ANTHROPIC_API_KEY     # optional: model-backed reconciliation with Claude, and hosted Claude Code
npx wrangler secret put AI_GATEWAY_TOKEN      # optional: hosted agents through AI Gateway (also set AI_GATEWAY_ID in wrangler.jsonc)
pnpm run deploy
```

To move a project between two instances that share an Artifacts namespace (local to deployed, say): `GET /api/p/<project>/export` on the old one, `POST /api/projects/import` with `{ "dump": <that> }` on the new one, then `DELETE /api/p/<project>?repos=keep` on the old one so it forgets the project without deleting its repositories.

With the admin token set, everything needs it, reads included: project state contains agent session transcripts. Agents keep using their own attempt tokens. A deployed instance with no admin token refuses requests unless the `BRAID_OPEN` variable is `"true"`.

A project's owner can make it public from its page ("Who can read this"). Anyone with the link can then read it live without signing in: intents, code, decisions, agent sessions and previews. They cannot change anything, and other projects stay private.

With AI Gateway or `ANTHROPIC_API_KEY` set, the "Reconcile with a model" button uses Claude; otherwise Workers AI. Agents and people can always reconcile without any model.

## What runs where

- **Worker** (`src/worker/index.ts`): HTTP API, the MCP endpoint, static UI, and previews. `/preview/<project>/<attempt>/` serves any attempt's files straight out of its Artifacts repo, so a no-build web project is runnable per attempt with nothing deployed.
- **Durable Object, one per project** (`src/worker/project.ts`): all coordination state in SQLite (intents, attempts, why log, overlaps, reconciliations, landings), WebSocket fan-out to the UI, and the only writer to trunk, so landings are serialized.
- **Artifacts**: trunk is a repo; every attempt is a fork (`<project>--i<intent>-a<n>-<id>`). Reads use the Workers binding (`log`, `readTree`, `readBlob`, `readFile`, `fork`, `createToken`). The binding cannot write, so landing fetches trunk and the attempt into an in-memory repo with isomorphic-git, merges, and pushes over the Git protocol (`src/worker/land.ts`).
- **Workflow on push events** (`PushWorkflow`): a `cf.artifacts.repo.pushed` trigger on the whole namespace starts a Workflow for every push, which tells the owning project to re-read that attempt and recompute overlaps. Agents also call `checkpoint` after pushing, which does the same thing synchronously.
- **Landing queue** (in the project object): "Land this" is a request for the commit on screen. Requests are tried one at a time, in order.
  - The attempt's own commit must have passed. If the attempt started from trunk's head, its merge is the tree that passed, and it lands at once.
  - Otherwise Braid builds the merge commit, parks it on the attempt's repository, and runs it in a sandbox. Trunk moves to it only if it passes, so two changes that each pass and break each other in different files are caught before trunk has them. A reconciled merge is verified the same way.
  - If the attempt moves after landing was asked for, the request is dropped. A saved resolution is only used for the two commits it was written against.
  - While trunk is failing, only an attempt whose merge passes (one that fixes it) lands.
  - "Land now" skips all of this, and the landing is recorded as forced.
  - The landing is written down before trunk is pushed, so one that reaches trunk is recorded even if the Worker stops in between.
- **Runner, one per attempt** (`src/worker/runner.ts`): a Durable Object with a container. For each new commit it starts a fresh Linux instance, fetches that commit, installs, and runs the project's checks, reporting each step to the project as it goes. After a build it copies the output into its own storage and serves it as the attempt's preview, so the preview outlives the sandbox.
  - The instance has no Internet access and is given no credentials. Git and package traffic leave it only through two Worker entrypoints: one adds a read token for that attempt's repository and refuses everything else (pushes, other repositories); the other allows reads from the npm registry.
  - What runs: `braid.json` at the repository root if present (`{ "install": "...", "checks": { "name": "command" }, "preview": { "dir": "dist", "api": "braid" } }`), otherwise the `typecheck`, `lint`, `test` and `build` scripts in `package.json`. A repository with neither is served as it is. Trunk decides: an attempt is run with trunk's `braid.json` and every check script trunk has, so it cannot pass by removing a check. (It can still change what a script does; that shows in its diff.)
  - A built page is served under `/preview/<project>/<attempt>/` but was built to live at a site root, so Braid puts a small script in front of it that sends its `/...` requests under the preview path and shows its router the path it expects.
  - `"api": "braid"` is for a project whose backend is Braid itself (this repository): the preview's `/api/` calls are answered by the instance it runs on, reads only and only for that project, so an attempt's UI can be reviewed against real data. Such a preview may only talk to its own instance.
- **Agent host, one per hosted attempt** (`src/worker/agent.ts`): "Run Claude Code" or "Run Codex" on an intent starts a sandbox, clones a fresh attempt into it, gives the agent its brief and Braid's tools, and starts it headless. The host reads what the agent prints every few seconds and adds it to the attempt's session, then removes the sandbox when the agent exits.
  - The sandbox has no Internet access and holds no credentials: no model key, no git token, not even its own Braid token. One Worker entrypoint sees every request it makes and allows only this project's Braid tools, fetch and push of its own attempt, fetch of trunk, its own provider's inference calls, and reads from the npm registry, adding the token for each outside the sandbox. Abandoning or superseding the attempt stops the agent.
  - Model access is through AI Gateway (`AI_GATEWAY_ID` and the `AI_GATEWAY_TOKEN` secret, with Unified Billing or stored provider keys), or through `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` secrets. `HOSTED_CLAUDE_MODEL` and `HOSTED_CODEX_MODEL` override the models.
- **Model** (`src/worker/resolver.ts`): optional. Claude via AI Gateway or the Anthropic SDK if a key is set, otherwise Workers AI. It is shown the merged file with the conflicts marked in place (long unchanged stretches left out) and answers with one replacement per conflict, so the size of the file does not matter and it cannot touch lines that were never in conflict.

## Agent tools (MCP)

`brief` · `claim` · `record` · `checkpoint` · `peek` · `message` · `check` · `ready` · `reconciliation` · `resolve` · `sync`

Every response carries `heads_up`: overlaps, messages from other agents, and trunk movement since the agent's last call. Endpoint: `POST /mcp/<project>` with the attempt token as the bearer.

## Limits

- A built preview is static files. An app that needs its own backend loads but its API calls fail. Braid's own UI is the exception: it reads from the instance it is previewed on. Assets a build loads by root path from inside JavaScript or CSS (lazy chunks, `url(/...)`) are not redirected.
- Verification supports Node projects (npm or pnpm). Each step has ten minutes.
- Overlap prediction is per file, by three-way line merge. It does not see semantic conflicts in different files.
- A file deleted on one side and edited on the other cannot be reconciled in the UI; the agent merges trunk with git (`sync`). A rename shows up as exactly that.
- Lockfiles are regenerated for npm and pnpm only.
- A hosted agent runs once, for at most 45 minutes. A person can bring it back to act on a note, reconcile a conflicted landing or fix failed checks; nothing does that automatically.
- Reverting a landing adds one commit that undoes it and reopens the intent. It is refused if a later landing changed the same lines, and the revert itself is verified on trunk afterwards, not before.
- Braid refuses a resolution that is identical to one side unless told that is intended.
- One merge is verified at a time, so landings queue behind each other; each takes as long as the project's checks.
- A project runs at most six hosted agents at once (`HOSTED_MAX`).
- Tests cover git analysis, the tree merge, redaction, session capture and the tar reader (`pnpm test`); the rest is exercised end to end by `pnpm sim`.

## License

MIT
