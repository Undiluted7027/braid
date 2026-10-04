# Later

Features and gaps to pick up after the core is solid. The build plan below is in priority order; the sections after it are not.

## Build plan

As of October 3, 2026 the core loop works locally on a toy project. Submission is due October 14. This is what to build with the time, in order.

**Decided: the demo subject is Braid building itself.** Braid's own repository becomes a Braid project, and agents develop Braid through Braid. That gives a real codebase with a build, a typecheck and tests, and it is the most convincing story to show.

### Where the current version is thin

- **The demo subject is a toy.** Everything has run on a 60-line counter app with no build, tests or dependencies.
- **"Why" depends on agents volunteering it.** Decisions are whatever the agent chose to record. What it read, tried and abandoned is not captured.
- **Conflict detection is textual.** It predicts line-level merge conflicts per file. Two changes that break each other across different files are invisible.
- **Review is still diff-reading.** Nothing runs the code, so choosing which attempt ships has no evidence behind it.
- **Humans drive everything.** A person opens intents, starts agents in terminals, and clicks land.
- **It barely uses the platform.** Sandbox, Workers Builds and Previews, and Queues are untouched.

### What to build

1. **Real repositories.** Import an existing repo (starting with Braid's own) and run the whole loop on a project with a build and a test suite. This comes first because it will break things and makes everything after it honest.
   - Done: a trunk can start from an imported repository (any default branch) or from a local repository via `braid init`. Braid's own repository is a Braid project.
   - Open: the local working copy and the Braid trunk are two separate histories. Decide how changes made outside Braid reach trunk.
2. **Captured context, not volunteered notes.** Stream each agent's session into Braid and store it with the attempt in Artifacts, so the why is the actual record of the work.
   - Done: `braid join --run` streams what Claude Code and Codex say, run and get back; the server records every Braid tool call for any agent; the attempt view shows the session live with decisions placed in time; at landing the intent, decisions and transcript are committed to `<project>--context` in Artifacts.
   - Done: capture is narrowed and redacted. Agents start with a scrubbed environment; command output is stored as a status line (plus a short tail for git, test and build commands); text is redacted in the launcher and again on the server; the committed transcript keeps only each result's status line; `sync` no longer returns a token, the clone has a read-only `trunk` remote instead.
   - Open: agents not started by the launcher leave only their Braid calls. The Why view does not yet link a line of code to the moment in the session that produced it. Agents still run with the user's own file access; real confinement comes with hosted agents (item 4).
3. **Evidence-based review.** Run each attempt's tests and build in Cloudflare Sandbox on every push, and give every attempt a real deployed preview. Compare then shows results side by side.
4. **Agents hosted on Cloudflare.** Start agents from the UI in Sandbox, so opening an intent is enough to get attempts.
5. **Agents that coordinate.** A planner that splits a goal into intents, a reviewer agent that judges attempts against acceptance, and a landing queue that re-verifies after each landing.
6. **Semantic collisions.** After each landing, re-run the other attempts' checks against the new trunk, so cross-file breakage is caught by execution.

Items 2 and 3 are the direct answers to the competition brief's questions about tracking why a change was made and how to review everything agents produce.

### Also needed for the submission

- Deploy, which is the only way to verify the push-event Workflow.
- A real-agent conflict driven through reconciliation; so far only the scripted run has done this.
- The 5 to 10 minute demo video.
- A public source repository and a pass over the run instructions once deployed.

## Not built yet

- **Hosted agents.** Agents run wherever you start them. Running them in Cloudflare Sandbox, started from the UI, is not built.
- **Previews for projects with a build step.** Previews serve files straight from the attempt's repo, so only no-build projects are runnable.
- **Reconciling delete-versus-edit in the UI.** Currently the agent has to merge trunk with git.
- **Semantic overlap detection.** Prediction is per file, by three-way line merge. Two changes in different files that break each other are not caught.

## Not verified yet

- **Push-event Workflow.** It only fires on a deployed Worker and has never run.
- **Model-backed reconciliation.** Written for Claude and Workers AI; never called.

Checked locally on October 4, 2026: the admin token guard (every route class, cookie sign-in, keyed previews, the socket), the context repo's contents read back from a clone, and capture and redaction with real Claude Code and Codex sessions that ran `env`, `cat .mcp.json` and `git config --list`.
