# Settings

Two places. How a project is run is set in `braid.json` at the root of its trunk, so it is versioned with the code and read from trunk, never from an attempt. What an instance can do is set by its secrets and variables.

## `braid.json` (per project, on trunk)

| Key | Default | What it does |
|---|---|---|
| `environment.image` | detected from the files | `"node"`, `"python"`, `"go"`, `"rust"` or `"java"`: the sandbox image a commit is run in. Read from the commit itself, not from trunk. |
| `install` | the language's usual install | The command that installs dependencies in the sandbox. |
| `checks` | what the language's conventions give | `{ "name": "command" }`: what is run for every commit and every merge. Without it: Node's `typecheck`, `lint`, `test` and `build` scripts; Python's `mypy`, `ruff` and `pytest` where set up; `go vet`, `go build`, `go test`; `cargo check`, `cargo test`; `mvn test`. |
| `preview.dir` | none | The directory a build writes, served as the attempt's preview. |
| `preview.api` | none | `"braid"` answers the preview's `/api/` calls from this instance, read-only. For a project whose backend is Braid itself. |
| `landing.policy` | `"person"` | `"auto"` lands an attempt without a person once it is ready, its checks passed, its review found every criterion met and nothing is flagged. |
| `landing.conflicts` | `"person"` | `"auto"` sends a conflict to the attempt's agent, then to a model, before a person. |
| `landing.batch` | `8` | How many landings are merged and verified together. |
| `landing.combine` | `true` | Keep both sides where trunk and an attempt only added lines at the same place. |
| `landing.likelihood` | `0.9` | Under `"auto"`, the least the decision model must give every criterion of the attempt picked in a race. The default comes from a trial of thirty patches on one small app: set your own. |
| `review` | `true` | Review attempts when they are marked ready. Also a switch in the interface. |
| `reviewer` | the other maker | `"claude"` or `"openai"` fixes who reviews. Otherwise an attempt is read by a model from a different maker than its agent. |
| `plan` | `true` | Look at each intent next to the others when it is opened or edited. Also a switch in the interface. |
| `signal` | `true` | `false` turns the decision model (Clef on Workers AI) off. |
| `race.agents` | one of each kind the instance can run | The line-up a race starts with: `[{ "kind": "claude", "model": "claude-opus-5-5" }, "codex"]`. |
| `race.wait` | `30` | Minutes the other attempts are waited for once one is ready. |

Example:

```json
{
	"checks": { "test": "node --test", "build": "vite build" },
	"preview": { "dir": "dist" },
	"landing": { "policy": "auto", "conflicts": "auto" },
	"race": { "agents": ["claude", "codex"], "wait": 20 }
}
```

### A repository with more than one language

Braid runs a commit in one image, picked from the manifest at the repository's root. Every image has Node, so a backend in Python, Go, Rust or Java with a JavaScript front end can be run together by saying so:

```json
{
	"environment": { "image": "python" },
	"install": "cd api && uv sync --frozen && cd ../web && npm ci",
	"checks": {
		"api": "cd api && uv run pytest",
		"web": "cd web && npm test",
		"web build": "cd web && npm run build"
	},
	"preview": { "dir": "web/dist" }
}
```

Two languages other than Node in one repository cannot be run together yet, and all checks run for every commit whichever part it touched. See [LIMITS.md](LIMITS.md).

## The instance (secrets and variables)

| Name | Needed for | What it is |
|---|---|---|
| `BRAID_ADMIN_TOKEN` (secret) | a deployed instance | The token the interface asks for once and the CLI takes with `--token`. With it set, everything needs it, reads included. |
| `BRAID_OPEN` | running with no token | `"true"` lets a deployed instance run open to anyone. |
| `AI_GATEWAY_ID`, `AI_GATEWAY_ACCOUNT_ID` (in `wrangler.jsonc`), `AI_GATEWAY_TOKEN` (secret) | models through AI Gateway | Reviews, planning, judging, model reconciliation and hosted agents reach their providers through the gateway, which holds the provider keys. Replace the account id in `wrangler.jsonc` with your own. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (secrets) | models without a gateway | Used when no gateway is set up. |
| `BRAID_MODEL` | optional | The Claude model for reconciliation, and for review and planning unless set below. |
| `BRAID_REVIEW_MODEL`, `BRAID_REVIEW_OPENAI_MODEL` | optional | The Claude and OpenAI models that review, plan and judge. |
| `HOSTED_CLAUDE_MODEL`, `HOSTED_CODEX_MODEL` | optional | The models hosted Claude Code and Codex run on when none is named. |
| `HOSTED_MAX` | optional | How many hosted agents one project runs at once. Six by default. |
| `SPARE_FORKS` | optional | How many forks of trunk are kept ready so that starting an attempt does not wait. Two by default; `0` turns it off. |

With no model configured Braid still works: agents coordinate, commits are verified, landings are batched and merged, and people review and reconcile. Reviews, planning, judging and model reconciliation are simply absent (reconciliation falls back to Workers AI).
