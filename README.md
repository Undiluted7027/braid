# Braid

**Intents, not branches.** A git platform for many agents changing one codebase at the same time, built on Cloudflare Workers and Artifacts.

Git merges text. It has no idea what either side was trying to do, so when two agents collide it can only show you two sets of lines. Braid keeps the *why* next to every change and uses it while agents are working, when their changes collide, and afterwards, when someone asks why a line is there.

Agents connect over **MCP**, so Claude Code, Codex and any other MCP-capable agent work unchanged. Code moves over plain **git**.

## The idea

| Instead of | Braid has | |
|---|---|---|
| Issue + branch + pull request | **Intent** | A goal with "done when" criteria, stated once. |
| Branch | **Attempt** | One agent's try at an intent, in its own fork of trunk. |
| Commit message | **Why log** | The decisions, rejected options and assumptions an agent records as it works. |
| Finding out at merge time | **Overlaps** | On every push, each attempt is compared with the others, and both agents are told, with the other's reasoning. |
| Merge | **Landing** | One commit on trunk per intent. Trunk only takes what has been run in a sandbox. |
| Two pull requests for one ticket | **Race** | Several agents on one intent, blind to each other, then compared. |
| `git blame` | **Why view** | Every line on trunk traced to the intent, the decision and the moment in the session that wrote it. |

The full table, and what runs where, is in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Four questions

**How do agents know what the others are doing?**
Before work starts, a planner reads each intent next to the others and names the ones that contradict or depend on each other. While agents work, every push is compared with every other live attempt, and each agent hears about a collision on its next tool call, with the other agent's reasoning.

**What happens when they make conflicting changes?**
Most never become a conflict: where both sides only added lines at the same place, both are kept and the result is run before it lands. Landings that are ready together are merged and verified together. A real conflict is shown place by place with the intent behind each side, and a project can send it to the agent, then to a model, before it reaches a person.

**How do you review everything they produce?**
You do not read every diff. Each commit is run in a clean sandbox. An attempt marked ready is read against each criterion by a model from a different maker than the agent that wrote it, and plain facts are flagged without a model (tests deleted, files changed that were not claimed). A project can let what is plainly good land by itself. Competing attempts are compared by two judges who see them by letter, not by who made them.

**How do you keep track of why?**
The why is recorded when it is decided, not reconstructed. It travels with the landing commit, is copied to a context repository you can clone, and is shown on the lines it led to.

## What it does, measured

On a deployed instance, with scripted agents unless stated:

| | |
|---|---|
| 40 agents at once, each joining, pushing and marking ready | tool calls answered in 0.1 to 0.6 seconds typically; starting an attempt took 3.2 seconds at worst |
| Their 40 landings | 31 land by themselves in 63 seconds, in 6 batches; 9 are left as conflicts |
| Those 9 | all named as contradictions by the planner before any agent started, with no false alarms among the other 30 intents |
| An incomplete attempt, with real agents | reviewed, sent back, fixed by a hosted Claude Code, approved and landed in 97 seconds with no person involved |
| A race between hosted Claude Code and Codex | both ready in about 70 seconds and compared 25 seconds later; the two judges disagreed, so it was left to a person |

How each number was obtained, and what has not been verified, is in [docs/LATER.md](docs/LATER.md).

## Run it

Needs Node 22.18 or newer, pnpm, git, Docker (running, for the sandboxes), and a Cloudflare account on the Workers Paid plan with Artifacts.

```sh
pnpm install
npx wrangler login
pnpm dev            # builds the interface and runs the Worker at http://localhost:8787
```

Then, in another terminal, watch four agents work on three intents at once, with no model needed:

```sh
pnpm sim --pause
```

The agents are scripted; everything else is real: Artifacts forks, git pushes, MCP calls, overlap prediction, the starter app's tests run in a sandbox for every commit and every merge, and landings. Open http://localhost:8787 and follow along.

Local development uses the real Artifacts service: repositories are created in the `braid` namespace of your account. `pnpm test` runs the test suite, which needs no Cloudflare account.

To put real agents on a project, start them in sandboxes on Cloudflare, or deploy your own instance, see [docs/RUNNING.md](docs/RUNNING.md). Every setting is in [docs/SETTINGS.md](docs/SETTINGS.md).

## Built on

| Cloudflare product | What Braid uses it for |
|---|---|
| **Workers** | The API, the MCP endpoint for agents, the interface, and previews of every attempt. |
| **Artifacts** | Trunk is a repository and every attempt is a fork of it. Push events tell Braid when an agent has pushed. |
| **Durable Objects** | One per project, with SQLite: all coordination state, an event log, and the only writer to trunk. |
| **Containers** | A fresh sandbox for every commit that is verified, and for every hosted agent, in an image for the project's language (Node, Python, Go, Rust or Java). No Internet access and no credentials inside. |
| **Workflows** | Carry each push event to the project that owns the repository. |
| **AI Gateway** | Every model call (reviews, planning, judging, reconciliation, hosted agents), with the provider keys held in the gateway. |
| **Workers AI** | Clef, a decision model, reads every push and says how likely each criterion is met. |
| **Browser Run** | Takes a picture of each attempt's preview when attempts are compared. |

## More

- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md): every idea, and what runs where.
- [docs/RUNNING.md](docs/RUNNING.md): real agents, hosted agents, deploying, the agent tools.
- [docs/SETTINGS.md](docs/SETTINGS.md): every `braid.json` key and instance setting.
- [docs/LIMITS.md](docs/LIMITS.md): what Braid does not do.
- [docs/DIRECTION.md](docs/DIRECTION.md): how well it answers the questions above, and what comes next.
- [docs/LATER.md](docs/LATER.md): what was built, checked and left open at each step.

## License

MIT
