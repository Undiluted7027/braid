# Direction

Written October 9, 2026, from a review of where Braid stands against Cloudflare's brief, a 40-agent run on the deployed instance, and a reading of T3 Code's orchestrator. `docs/LATER.md` is the record of what was built and checked; this file is what to build next and why.

## What prompted this

The questions on the table:

- What more should Braid do?
- How deeply is Braid integrated with Cloudflare?
- Should Braid speak the Agent Client Protocol (ACP), as T3 Code does?
- How should people and their agents authenticate?
- How well, and how correctly, does Braid answer the brief's core questions, in a way people can use and understand?
- What interface work follows?

## The brief

From https://blog.cloudflare.com/next-git-platform-on-cloudflare/:

- "How do agents know what other agents are working on? What happens when they make conflicting changes? How do you review everything they produce? How do you keep track of not just what changed, but why a change was made?"
- It asks what "the developer experience should look like when hundreds or thousands of agents are working on the same codebase."
- "You could rethink repositories, branches, pull requests, worktrees, code review, and merge conflicts — or build new ways to preserve agent context, compare multiple changes at the same time, and decide which one should ship."
- "We aren't looking for GitHub as it exists today with agents added on top."
- Required: Workers and Artifacts; "at a minimum, we want to see multiple agents working on changes concurrently"; a 5 to 10 minute video; source under a permissive licence; instructions to run or try it. Submissions close October 14, 2026.
- No judging criteria are published. Products the post names beyond Workers and Artifacts: Workers Builds, Workers Previews, event subscriptions, Workflows.

## What 40 agents at once showed

Run on the deployed instance on October 9 in a project named `scale-probe` (left there as a test bed; 41 repositories). Forty scripted agents, eight at a time: twenty each added their own file, ten each added a function at the same place in `app.js`, ten each changed the same line of `styles.css`.

| Measure | Result |
|---|---|
| Joined, pushed, verified, marked ready | All 40, no failures |
| One `checkpoint` call | 15 s typical, 29 s at worst: each call re-reads every live attempt, and calls queue behind each other |
| `join` and `ready` | About 13 s typical for the same reason |
| An agent's `brief` | 2 kB with no other agents, 21.5 kB with 39: it lists every live agent |
| Overlaps found | 90 pairs, all correct |
| Asking for 40 landings | 22 landed, about 22 s each, strictly one at a time |
| The other 18 | Open reconciliations, each waiting for a person |
| Project page | 11,700 px tall; graph 4,700 px wide; eight intent colours shared by forty intents |

The 18 conflicts were of two kinds and neither needed a person. Nine were two agents adding different functions at the same spot, which is not a disagreement. Nine were intents that contradict each other (ten different accent colours), which was knowable before any agent started.

## How far Braid gets on each question

### How do agents know what other agents are working on?

- Has: claims, overlap predicted on every push, the other agent's reasoning attached to tool responses, `peek`, `message`.
- Missing a move to make. In the step 4 test Codex and Claude Code messaged each other, agreed both buttons should stay, and still collided at landing. An agent cannot build on another attempt, wait for one, or hand over a shared file.
- An agent only hears when it next calls a Braid tool.
- Every agent is told about every other agent; it should hear about its neighbours.
- Overlap is by file and line. A changed function and its callers in other files are invisible to each other until landing.

### What happens when they make conflicting changes?

- Has: prediction, reconciliation by region with both goals in view, the merge verified before trunk moves, `package.json` merged by key, lockfiles regenerated.
- Treats as a conflict what is not one: both sides adding different things at the same place.
- Cannot see: goals that contradict each other, an intent that depends on another, the same helper written twice.
- One merge is verified at a time. A real queue verifies batches together and splits a batch that fails.
- A conflict waits for a person to press a button, though the agent or the model could be sent straight away.

### How do you review everything they produce?

The weakest answer. Braid lays out the material for one attempt and leaves all the judging to a person.

- Nothing judges an attempt against the intent's acceptance text.
- Nothing flags what deserves a look: an attempt that edited its own tests, touched files outside its claims, or ran something destructive.
- No comparison of competing attempts beyond two cards side by side, though the brief asks for exactly that.
- No policy such as "land by itself when checks pass and the reviewer approves". With forty agents the person is the queue.

### How do you keep track of why?

The strongest answer: decisions, sessions, each line traced to the commit and session moment that wrote it, all committed to a context repository in Artifacts.

- Agents cannot use it: a new agent gets no reasoning for the code it is about to change.
- People cannot ask it: you must already know which file to open.
- Deleted lines have no why.
- Losing attempts are left out of the committed context.
- Nothing promotes a decision into a standing rule for future agents.

### Is it easy to use and understand?

The idea reads well in the demo. Against it: eight new nouns before you can act, a first run that needs Workers Paid and Docker, and no way to trust it unattended.

### The pattern underneath

Braid informs; it does not act. It tells agents about collisions and tells people about everything, and then waits. The next step is for Braid to close the loops itself and bring a person in for exceptions.

## Cloudflare integration

- Used: Workers, Artifacts (binding, git, push events), Durable Objects with SQLite, Containers, Workflows, AI Gateway, Workers AI, static assets, observability.
- Named in the brief and not used: Workers Builds and Workers Previews. An attempt at a Worker project should get a real deployed preview with its backend, which also removes the main limit of Braid's own previews.
- Would serve the four questions: Access (identity), Browser Rendering (screenshots when comparing attempts), Vectorize (asking the why in words).

## Authentication

- Agents are sound: a token per attempt, short-lived git tokens scoped to one repository, and no credentials inside a hosted agent's sandbox.
- People are not: one shared admin token and no names, so "who landed this" is whatever the client sends.
- Plan: Cloudflare Access in front of the Worker for identity; roles per project (owner, reviewer, reader) in the project object; personal tokens for the CLI in place of the admin token. Access needs setting up in the Cloudflare account. Public read-only projects stay as they are.

## ACP

What it is: a JSON-RPC protocol between a client and a coding agent, the way LSP is for language servers. The client calls `initialize`, `session/new` (or `session/load`), `session/prompt` and `session/cancel`; the agent streams `session/update` (message and thought chunks, tool calls and their updates, plans, mode changes) and calls back for `session/request_permission`, file reads and writes, and terminals. Local agents speak it over stdio; the docs say "full support for remote agents is a work in progress". About forty agents are listed, including Gemini CLI, GitHub Copilot, Cursor, OpenCode, Goose and Kiro; Claude and Codex are reached through adapters (`zed-industries/claude-agent-acp`, `agentclientprotocol/codex-acp`).

What it gives Braid, as the client driving an agent in its sandbox:

- A live two-way session: "send back" becomes another turn, and Braid can push a collision warning mid-session.
- Permission requests and questions arrive as requests Braid can show under "needs you".
- Any ACP agent without a parser each.

How to adopt it, following T3 Code: keep the dedicated Claude Code and Codex paths, and add one generic ACP path for everything else. T3 keeps first-party adapters for Codex and Claude, deliberately does not use Cursor's ACP transport, and uses a generic adapter plus a registry for the long tail. Inside a sandbox the transport is stdio, bridged to the agent host; T3's `AcpMcpStdioBridge` relays MCP to ACP agents line by line, which is what Braid needs to hand its tools to one.

## What to take from T3 Code

Source read: `pingdotgg/t3code` at the merge of pull request 2829 ("introduce new orchestrator", merged October 2, 2026, about 380,000 lines added): `docs/internals/overview.md`, `providers.md`, `adding-a-provider.md`, `context-handoffs.md`, and `apps/server/src/orchestration-v2` and `apps/server/src/mcp`.

T3's orchestrator runs many agent sessions durably for one person and hands off to GitHub when the work is done (it syncs pull requests and settles a thread when its PR merges). Braid is the reverse: strong where work converges on trunk, thin in the session layer, where an agent is started, read, and restarted cold to be told anything. T3 is the best available design for that thin half.

| T3's design | Where | What it fixes in Braid |
|---|---|---|
| Decide, then do: a command only records intent; events, state, a receipt and the pending side effects commit in one transaction; a worker does the I/O and feeds results back | `Orchestrator.ts`, `EventSink.ts`, `EffectOutbox.ts`, `EffectWorker.ts`, `CommandReceiptStore.ts` | Braid does git and Artifacts I/O inside the call that changes state: the 15 to 29 s `checkpoint`, and the hand-built journal for a crash mid-landing |
| Checkpoints as hidden git refs, one per turn, no commits on the agent's branch; a rollback must also roll back the agent's conversation or be refused | `CheckpointService.ts`, `CheckpointRollbackService.ts`, `CheckpointRestoreSafety.ts` | Line-level why depends on agents committing as they go. A checkpoint per turn ties a line to its turn, and lets an attempt be rewound and steered differently |
| A server-owned queue per thread: start now, queue for after this turn, steer mid-turn, restart | `CommandPolicy.ts`, `QueuedRunOrder.ts`, `ThreadMessageIntake.ts` | A person's note means a cold restart |
| Approvals and questions as stored requests, answerable by a person or by another agent through a tool, cancelled when the agent's process is lost | `RuntimeRequestService.ts`, tools `t3_pending_request_*` | Agent questions are only a kind of decision; nothing knows whether one is still open |
| Tools for agents to launch, wait for, fork and merge back other threads, and hand over a worktree | tools `t3_thread_launch`, `t3_thread_wait`, `t3_thread_fork`, `t3_thread_merge_back`, `t3_worktree_handoff` | The moves Braid's agents lack: wait for another attempt, build on it, delegate |
| Portable context handoff: a budgeted text summary of messages, commands, file changes and checkpoints, stated not to be native context | `ContextHandoffService.ts`, `docs/internals/context-handoffs.md` | Braid stores sessions and decisions already, so it can hand an attempt from one agent to another, and bring an agent back with its history |
| Usage limits as their own state with a reset time and automatic resume | `UsageLimitRecoveryWorker.ts` | Any agent failure is just "failed" |
| Turn finished and work settled are separate; settlement is decided on the server by a guarded command that refuses if there is newer activity | `RunFinalizationService.ts`, `ThreadSettlementService.ts` | The shape for a landing policy that acts without a person |
| On startup, reconcile recorded runs against what is really running; retire effects tied to a dead process | `ProviderRuntimeRecoveryService.ts` | Interrupted runs are handled case by case |
| A subscription sends only what that client needs | `ThreadStream.ts`, `LiveStreamBudget.ts` | The whole project goes to every viewer, and every agent to every agent |
| Replay fixtures recorded from real agents as the main test method ("a test that drives the adapter with hand-written frames is a guess about the protocol") | `testkit/` | Braid's capture tests are hand-written frames |
| An operator toolkit: agents create projects, start threads and answer requests through tools | `apps/server/src/mcp/toolkits` | A planner or reviewer becomes an agent with a toolkit, not bespoke code |

Traps T3 lists that several of its adapters hit, worth testing in Braid: a stop sent before the turn started; work the agent starts by itself after the turn settled; subagents that outlive the run that launched them; a failed turn leaving tool calls or questions open; inherited credentials in the agent's environment.

## What to build, in order

Foundation first, because the rest stands on it:

1. **Decide, then do.** An event log, an effects outbox and a worker in the project object. Tool calls answer from recorded state; overlap detection becomes incremental (only pairs involving the attempt that moved).
2. **Live sessions.** A queue per attempt with steer, queue and restart; stored requests; a checkpoint per turn; handoff summaries. ACP for the long tail of agents on the same session model.
3. **Agent moves.** Wait for an attempt, build on one, delegate, answer a request. Briefs narrowed to an agent's neighbours.

Then, on that:

4. **A planner** that reads intents before work starts: finds contradictions and dependencies, orders them, splits a goal into intents.
5. **A smarter merge.** Both-added blocks merge by themselves; a real conflict goes to the agent or the model at once and reaches a person only when those fail.
6. **A batching landing queue.**
7. **A reviewer agent** with a verdict per acceptance criterion, risk flags, and a landing policy per project.
8. **Race and compare.** Start several agents on one intent; one view with checks, diffs between attempts, screenshots and contrasted reasoning.
9. **Why for agents and by question.** A `why` tool, search in words, deleted lines, losing attempts, decisions promoted to project rules.
10. **An interface for many.** Group by intent, filter, summarise; more than eight intent colours.
11. **People.** Access, roles, names on every action.
12. **Workers Previews** for attempts at Worker projects.

The planner and reviewer (4 and 7) should be agents with an operator toolkit, as in T3.

## Still needed for the submission

- The demo video.
- The source published under its MIT licence. No outside remote has been authorised yet.
- A pass over the run instructions from a clean checkout.
- A rehearsal of Braid building Braid on the deployed instance: almost all of Braid was pushed straight to trunk, so its own Why view traces few lines to an intent.

## Open decisions

- Whether to start with the foundation (item 1) or with something more visible.
- Whether the `braid` project on the deployed instance becomes public.
- Landing commits are multi-line with trailers and agent authorship, unlike the one-line convention used for commits to this repository.
- A README credit line for the Anthropic and OpenAI marks.
- Leftover repositories in Artifacts (`duo--*`, `scale-probe--*`, probably `session-test--*`); Artifacts billing starts October 15.
