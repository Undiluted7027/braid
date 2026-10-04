# Later

Features and gaps to pick up after the core is solid. The build plan below is in priority order; the sections after it are not.

## Build plan

As of October 3, 2026 the core loop works locally on a toy project. Submission is due October 14. This is what to build with the time, in order.

**Decided: the demo subject is Braid building itself.** Braid's own repository becomes a Braid project, and agents develop Braid through Braid. That gives a real codebase with a build, a typecheck and tests, and it is the most convincing story to show.

### Where the current version is thin

- **The demo subject is a toy.** Everything has run on a 60-line counter app with no build, tests or dependencies.
- **"Why" depends on agents volunteering it.** Decisions are whatever the agent chose to record. What it read, tried and abandoned is not captured.
- **Conflict detection is textual.** It predicts line-level merge conflicts per file. Two changes that break each other across different files are invisible.
- **Humans drive everything.** A person opens intents, starts agents, and clicks land.
- **It barely uses the platform.** Workers Builds and Previews, and Queues are untouched. (Containers are now used for verification.)

### What to build

1. **Real repositories.** Import an existing repo (starting with Braid's own) and run the whole loop on a project with a build and a test suite. This comes first because it will break things and makes everything after it honest.
   - Done: a trunk can start from an imported repository (any default branch) or from a local repository via `braid init`. Braid's own repository is a Braid project.
   - Open: the local working copy and the Braid trunk are two separate histories. Decide how changes made outside Braid reach trunk.
2. **Captured context, not volunteered notes.** Stream each agent's session into Braid and store it with the attempt in Artifacts, so the why is the actual record of the work.
   - Done: `braid join --run` streams what Claude Code and Codex say, run and get back; the server records every Braid tool call for any agent; the attempt view shows the session live with decisions placed in time; at landing the intent, decisions and transcript are committed to `<project>--context` in Artifacts.
   - Done: capture is narrowed and redacted. Agents start with a scrubbed environment; command output is stored as a status line (plus a short tail for git, test and build commands); text is redacted in the launcher and again on the server; the committed transcript keeps only each result's status line; `sync` no longer returns a token, the clone has a read-only `trunk` remote instead.
   - Open: agents not started by the launcher leave only their Braid calls. The Why view does not yet link a line of code to the moment in the session that produced it. Agents still run with the user's own file access; real confinement comes with hosted agents (item 4).
3. **Evidence-based review.** Run each attempt's tests and build in Cloudflare Sandbox on every push, and give every attempt a real deployed preview. Compare then shows results side by side.
   - Done: every commit of an attempt, and trunk after each landing, is run in a fresh container (install, typecheck, lint, test, build, or `braid.json`). The sandbox has no Internet and no credentials; it reaches only its own repository (read) and the npm registry (read) through Worker gateways, checked from inside. Results show per step in the attempt view and on the board, reach the agent in `checkpoint` and `heads_up`, and block `ready` and landing on a failed commit unless forced. Build output is saved and served as the preview.
   - Done: Braid previews its own UI. `braid.json` sets `preview.api` to `braid`, and the preview reads the project it belongs to from the instance it runs on (read-only, that project only, and it cannot send what it reads to another host).
   - Open: previews of other apps that need a backend. Only Node projects. A run that dies mid-way stays "running" until someone runs it again. 
4. **Agents hosted on Cloudflare.** Start agents from the UI in Sandbox, so opening an intent is enough to get attempts.
   - Done: "Run Claude Code" and "Run Codex" on an intent start the agent in a sandbox with a fresh attempt, Braid's tools and its session streamed in. The sandbox holds no credentials; one Worker entrypoint decides everything it can reach. Checked locally with a self-test agent that stands in for the model (tools, commit, push, trunk fetch, refusals), with each CLI's own doctor, and by starting both CLIs headless with the exact flags.
   - Done: real runs through an AI Gateway named `braid` (Unified Billing, provider keys held in the gateway). Hosted Claude Code and Codex each completed an intent, concurrently, waiting for verification before marking ready. An agent can be brought back to an attempt to reconcile a conflicted landing or to fix failed checks. Claude reconciliation also goes through the gateway.
   - Done, the acceptance test: three hosted agents changed the same tag. The second landing conflicted and Codex was brought back and resolved it through the tools; the third conflicted and was resolved by the model, on Workers AI and, on a further conflict, by Claude.
   - Found by that test: Codex's first resolution was its own file unchanged (its edit command had failed), Braid landed it, and trunk lost the other intent's change while the rationale claimed both survived. A resolution identical to one side is now refused unless `one_sided` is set, and the image has Python. The deeper gap remains: a resolution is not run before it lands (step 5's landing queue).
   - Open: bringing an agent back to fix failed checks is not tested with a real failure. Nothing brings an agent back automatically. Not yet deployed.
   - Acceptance test, which also closes the two unverified items below: start two hosted agents on intents that edit the same lines, land one, then land the other so it conflicts. The agent reconciles the first conflict with the `reconciliation` and `resolve` tools. A second conflict is resolved with "Reconcile with a model", first on Workers AI (no key needed), then on Claude once `ANTHROPIC_API_KEY` is set, which hosted Claude Code agents need anyway.
5. **Agents that coordinate.** A planner that splits a goal into intents, a reviewer agent that judges attempts against acceptance, and a landing queue that re-verifies after each landing.
6. **Semantic collisions.** After each landing, re-run the other attempts' checks against the new trunk, so cross-file breakage is caught by execution.

Items 2 and 3 are the direct answers to the competition brief's questions about tracking why a change was made and how to review everything agents produce.

### Also needed for the submission

- The 5 to 10 minute demo video.
- A public source repository and a pass over the run instructions once deployed.

## Not built yet

- **Previews for apps with a backend.** A built preview is static files; nothing runs the app's server.
- **Reconciling delete-versus-edit in the UI.** Currently the agent has to merge trunk with git.
- **Semantic overlap detection.** Prediction is per file, by three-way line merge. Two changes in different files that break each other are not caught.

## Known limits of previews

Recorded on October 4, 2026, when Braid's own UI became previewable (`preview.api` set to `braid` in `braid.json`).

- **An attempt's code can read its project's state.** That includes other attempts' redacted session transcripts. It cannot fetch or beacon them to another host, but a frame can still navigate itself to another site with data in the URL. Judged acceptable for a project that opts in, since its agents already see most of that state through their tools. Revisit before previewing repositories whose agents are not trusted.
- **Nested previews do not load on a token-protected instance.** A preview inside a previewed Braid has no key, because preview keys are deliberately left out of the proxied state.
- **Reloading a preview opened in a new tab loads the real app.** "Open" works, but the script in front of the page rewrites the address to `/`, so a reload asks for the instance's own root.
- **Root-path assets loaded from inside JavaScript or CSS are not redirected.** Lazy chunks and `url(/...)` still point at the site root. Braid's UI is a single bundle, so it is unaffected; a project with code splitting would be.

## Not verified yet

- **The one-sided confirmation in the UI.** The guard itself is verified through the API and the agent tool; nobody has clicked through the confirmation.
- **The landing fix for same-named files on the deployed instance.** Conflicted files are now identified by full path (checked locally with `a/index.txt` and `b/index.txt`); the deployed instance gets it at the next deploy.

Model-backed reconciliation (Workers AI and Claude) and a real-agent conflict through reconciliation were both verified locally on October 4, 2026, in the acceptance test for step 4.

Checked on October 4, 2026:

- Locally: the admin token guard (every route class, cookie sign-in, keyed previews, the socket), the context repo's contents read back from a clone, and capture and redaction with real Claude Code and Codex sessions that ran `env`, `cat .mcp.json` and `git config --list`.
- Step 4 on the deployed instance, in a separate project (`dep-step4`):
  - Claude Code and Codex each ran in a sandbox through AI Gateway, pushed, waited for verification and marked their attempts ready. No `Co-Authored-By` trailer on the hosted Claude Code commit.
  - Landing the second attempt conflicted. Braid refused a resolution identical to either side. Codex, brought back, wrote a version with both buttons and it landed.
  - A commit with a failing test was pushed to a third attempt. Claude Code, brought back to fix it, found the cause, pushed, waited for verification to pass and marked the attempt ready.
  - A second conflict was reconciled with Claude through the gateway, and trunk verification passed afterwards.
- Deployed at https://braid.undiluted7027.workers.dev: the push-event Workflow (a push with no `checkpoint` updated the attempt), sandbox runs and their isolation on Cloudflare's microVM, sign-in, the live socket, both kinds of preview, `ready` refused on a failed commit, and the forced-landing confirmation.

The `braid` project now lives on the deployed instance. It was moved there with its intents, decisions, landings and sessions; the local instance has forgotten it.
