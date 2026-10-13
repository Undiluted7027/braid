# Running Braid with real agents, and deploying it

The short version is in the [README](../README.md#run-it). This is the rest.

## Put real agents on it

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

`--model <model>` runs the agent on that model and shows it beside the agent's mark on the attempt. Without it each agent uses its own default; Claude Code still reports which model that was, Codex does not, so a Codex attempt then shows the agent's name.

What a headless agent gets and what Braid keeps of its session:

- The agent runs with a scrubbed environment: only what it needs to run and to sign in to its own provider. `--pass-env NAME,NAME` lets more through.
- Its words, the commands it ran and the files it touched are recorded. Command output is recorded as a status line (`ok · 34 lines · 2.1 kB`); only git, test and build commands also keep the last few lines. Commands that name a credential file never keep output.
- Everything is redacted on your machine before it is sent (known key formats, bearer headers, passwords in URLs, the attempt's own tokens, secret-looking values from your environment) and again on the server.
- At landing, the intent, decisions and transcript are committed to `<project>--context`; `POST /api/p/<project>/context-credentials` returns a read token for cloning it.

This reduces what can leak; it does not sandbox the agent. A headless agent can still read anything your user can, and Codex's login shell reloads whatever your shell profile exports.

3. Watch the project page. When attempts are ready, open the intent, compare them (decisions, diff, live preview), and land one. Two agents joined to the same intent are a race: they are compared when both are ready (see "Race and compare" in [HOW-IT-WORKS.md](HOW-IT-WORKS.md)).

## Agents in Cloudflare sandboxes

With model access set up (AI Gateway, or provider keys: see [SETTINGS.md](SETTINGS.md)), an instance runs agents itself. On an intent, "Add an agent" offers "Run Claude Code" and "Run Codex": each starts a sandbox, clones a fresh attempt into it and runs the agent headless, with its session streamed to the attempt's page. "Race several agents" starts the project's line-up on one intent at once; the attempts are compared when they are ready. Locally this needs Docker; the sandbox image is built from the `Dockerfile` the first time.

## Deploy

```sh
npx wrangler secret put BRAID_ADMIN_TOKEN     # required: the UI asks for it once, the CLI takes --token
npx wrangler secret put ANTHROPIC_API_KEY     # optional: model-backed reconciliation with Claude, and hosted Claude Code
npx wrangler secret put AI_GATEWAY_TOKEN      # optional: hosted agents through AI Gateway (also set AI_GATEWAY_ID in wrangler.jsonc)
pnpm run deploy
```

Before the first deploy, replace `AI_GATEWAY_ACCOUNT_ID` in `wrangler.jsonc` with your own account id (it is only used for AI Gateway), and create an AI Gateway named as `AI_GATEWAY_ID` says if you want models through it.

To move a project between two instances that share an Artifacts namespace (local to deployed, say): `GET /api/p/<project>/export` on the old one, `POST /api/projects/import` with `{ "dump": <that> }` on the new one, then `DELETE /api/p/<project>?repos=keep` on the old one so it forgets the project without deleting its repositories.

With the admin token set, everything needs it, reads included: project state contains agent session transcripts. Agents keep using their own attempt tokens. A deployed instance with no admin token refuses requests unless the `BRAID_OPEN` variable is `"true"`.

A project's owner can make it public from its page ("Who can read this"). Anyone with the link can then read it live without signing in: intents, code, decisions, agent sessions and previews. They cannot change anything, and other projects stay private.

With AI Gateway or `ANTHROPIC_API_KEY` set, the "Reconcile with a model" button uses Claude; otherwise Workers AI. Agents and people can always reconcile without any model.

## Agent tools (MCP)

`brief` · `claim` · `record` · `checkpoint` · `peek` · `message` · `check` · `ready` · `reconciliation` · `resolve` · `sync`

Every response carries `heads_up`: overlaps, messages from other agents, and trunk movement since the agent's last call. Endpoint: `POST /mcp/<project>` with the attempt token as the bearer.
