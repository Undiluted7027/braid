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
   - Done: deployed, and checked there on October 4, 2026, including bringing an agent back to fix a commit with a failing test.
   - Open: nothing brings an agent back automatically.
   - Acceptance test, which also closes the two unverified items below: start two hosted agents on intents that edit the same lines, land one, then land the other so it conflicts. The agent reconciles the first conflict with the `reconciliation` and `resolve` tools. A second conflict is resolved with "Reconcile with a model", first on Workers AI (no key needed), then on Claude once `ANTHROPIC_API_KEY` is set, which hosted Claude Code agents need anyway.
5. **Agents that coordinate.** A planner that splits a goal into intents, a reviewer agent that judges attempts against acceptance, and a landing queue that re-verifies after each landing.
6. **Semantic collisions.** After each landing, re-run the other attempts' checks against the new trunk, so cross-file breakage is caught by execution.

Items 2 and 3 are the direct answers to the competition brief's questions about tracking why a change was made and how to review everything agents produce.

### Revised order after independent review (October 4, 2026)

Three independent reviews were run with steps 1 to 4 done: Codex on GPT-6 Astra (code and product), a fresh Claude Opus session as competition judge and engineer, and a fresh Claude Opus session using the local instance in a browser as a first-time developer and designer. They agreed that landing cannot yet be trusted and that a person cannot answer an agent, and that both come before the planner and reviewer agent. This order replaces steps 5 and 6 above. Findings marked (unchecked) have not been confirmed against the code; the rest have.

1. **Trustworthy landing.** Done and deployed on October 4, 2026.
   - Done: a landing is for one commit. "Land this" sends the commit on screen; if the attempt has moved, or moves while the landing waits, it is refused. A saved resolution records the trunk and attempt commits it was written against and is marked stale when either moves.
   - Done: a pass is required. Not run, queued and running wait; failed and errored are refused; only "Land now" (force) skips it, and that is recorded on the landing. Checks come from trunk's `braid.json` and trunk's scripts, and so does the `preview.api` flag.
   - Done: the landing queue. The merged commit is built, parked on the attempt's repository (`braid-candidate`), run in a sandbox, and only then pushed to trunk. A reconciled merge goes through the same run. This is also step 6: an attempt that passed alone and broke when merged with a landed change in another file was refused, with the failing output sent to the agent.
   - Done: while trunk is failing, an attempt lands only if its merge passes.
   - Done: a run that was interrupted is reported as "could not run" by the next alarm, and a stuck marker expires. The preview tar is cut off at the size limit.
   - Done: creating a project never removes a repository. An existing one is an error.
   - Done: the merge is done by full path over git trees (`src/worker/merge.ts`, with tests), not through isomorphic-git's merge driver.
   - Done: an abandoned, superseded or landed attempt has its hosted agent stopped, and its tools and credentials are refused.
   - Done: the landing is journalled before the push and recovered from trunk's log. A failed context copy is kept on a list and tried again at the next landing.
   - Done: re-reading a repository writes only the columns it computed, so it cannot undo a claim, check or status change.
   - Done: a hosted agent reaches only its own provider's inference calls, and a project runs at most six agents at once (`HOSTED_MAX`).
   - Open: one merge is verified at a time, so a long check suite makes the queue slow. Other ready attempts are not re-run against the new trunk after each landing; they are checked when someone lands them.
   - Open: the queue does not bring an agent back by itself when a merge fails; a person presses "Have it fix the merge with trunk".
   - Open: no spending budget per agent beyond the 45-minute limit and the six-agent limit.
   - Open: an attempt can still change what a check script does (`"test": "true"`). It shows in the diff; nothing flags it.
2. **A person can respond.** Done and deployed on October 4, 2026.
   - Done: "Send back for changes" on an attempt. The note is kept with the attempt's decisions (kind `feedback`), so it is in the why log, the brief and the landing commit. The attempt goes back to working, a landing that was asked for is dropped, and the agent hears it in `heads_up`. For Claude Code and Codex attempts Braid starts the agent again in a sandbox to act on it. Checked with a hosted Claude Code run: it made the change asked for, recorded how, and the note is in the landing commit message.
   - Done: a reply box under each unanswered `question` an agent recorded; the answer is kept as a decision (kind `answer`). "Just tell it" sends a message without changing the attempt.
   - Done: an open intent can be edited and abandoned from its page; agents working on it are told the new text.
   - Done: Abandon asks first and can be undone ("Reopen"). Landing an attempt its agent has not marked ready asks first, and is refused while the agent is still running.
   - Done: "Revert landing". Trunk gets one commit that undoes the landing, the intent is open again, the reason is kept with the attempt, and the attempt is marked reverted. Refused when a later landing changed the same lines.
   - Open: a note is for the whole attempt. It cannot be attached to a line of the diff.
   - Open: an agent started on someone's machine only hears a note if it is still running or is started again by hand; `braid join` has no "resume".
   - Open: a revert is pushed and then verified on trunk, not verified first. A reverted attempt cannot be landed again, because its commits are already in trunk's history; the intent needs a new attempt.
   - Open: acceptance is still prose. Nothing checks an attempt against it (the reviewer agent in item 6).
3. **Reconciliation by region.** Done and deployed on October 4, 2026.
   - Done: a resolution is one replacement per conflict, and Braid puts them in place (`assemble` in `gitops.ts`). The model is shown the merged file with numbered conflict blocks and unchanged stretches left out, and answers per conflict. Checked on a 51 kB, 3,000-line file with two conflicts and separate clean changes from each side: Claude resolved both in 16 seconds and every other line was kept.
   - Done: an agent's `reconciliation` tool returns the conflicts with a few lines around each (3 kB for that file) instead of three copies of the file; `full: true` adds the whole files. `resolve` takes `regions` or a whole `content`.
   - Done: hosted Codex, brought back to a conflict, answered with one replacement for the one conflicting line and it landed with both attributes. Its sandbox is stopped the moment the attempt lands, so its session ends with "stopped: the attempt is over" instead of its own last words.
   - Done: the one-sided guard also refuses an answer that takes the same side at every conflict.
   - Done: the editor works one conflict at a time: both sides, their base, the lines around, starting points (trunk's, the attempt's, both in either order, neither), and a switch to the whole file with markers. A resolved reconciliation shows what it changed in trunk's version. A conflicted attempt no longer shows "Land this".
   - Done: `package.json` is merged by key, so two attempts that each add a dependency do not conflict. A lockfile left in conflict is regenerated in a sandbox from the merged `package.json`, starting from trunk's lockfile, and the result is verified like any merge. Checked with npm: two attempts each added a dependency, the second landed with all of them locked and `npm ci` passing, and nobody touched the lockfile.
   - Open: lockfiles are regenerated for npm and pnpm. yarn and bun are not handled.
   - Open: a rename still shows as delete plus edit and cannot be reconciled in the UI.
   - Open: an open reconciliation shows on the project page only as a chip and one activity line (the "needs you" view in item 4).
   - Open: the state sent to the UI still carries full file contents for every open reconciliation; settled ones now carry only trunk's version and the result.
4. **First ten minutes.** Done locally on October 4, 2026; not yet deployed.
   - Done: the launcher is built into one file and served by the instance at `/braid.mjs`. "Add an agent" shows `curl` plus `node braid.mjs join ...`, which was copied from the UI and run as written. `braid init` now pushes into a project that was created empty instead of failing, and the CLI's help describes each command.
   - Done: "Clone trunk" makes a clone command with a read token that lasts an hour; an empty project gets a push command the same way.
   - Done: the home page says what Braid is in four steps, rows show the slug and path, every page has its own title and an `h1`, and the graph has a caption and can be used from the keyboard.
   - Done: a project can be made public by its owner. A visitor can read it live (state, sessions, diffs, files, previews) and nothing else; every write, export and credential request is refused, and other projects stay private. The UI shows a read-only banner, hides the controls, and has a sign-in dialog in place of the browser prompt. Checked on a token-protected local instance.
   - Done: the starter app has a test suite (`node --test`, no dependencies), so `pnpm sim` and every starter project show real verification and go through the landing queue.
   - Done: nothing is wider than the screen at 390 px on the home, project, intent and Why pages.
   - Done: "Needs you" at the top of a project: a failing trunk, conflicts to resolve, unanswered questions, failed checks, failed agents and attempts ready to review, each linking to where it is handled. Activity links to its intent and shows 30 at a time.
   - Done: the Why page has a file filter, and blame lines can be reached and opened from the keyboard. Chips are 12 px.
   - Open: the `braid` project on the deployed instance is still private. Making it public is the owner's call: it shows the agent sessions to anyone with the link. The README has no live URL or screenshot until then.
   - Done: the Why page lists files as folders that open and close (a flat list while filtering), and trunk history shows every commit on trunk tied to its intent: landings, reverts, pushes from outside Braid, and on request the commits each agent made inside its attempt.
   - Done: the local `demo-ready`, `demo-conflict` and `demo-done` projects were recreated with the current starter app (`BRAID_PROJECT=<name> pnpm sim --until=ready`, `--until=conflict`, `--keep`), so every attempt in them shows a real test run.
   - Open: trunk history reads at most 300 commits of trunk's own line and 50 per attempt.
   - Open: sessions from `pnpm sim` hold only the scripted agents' Braid calls.
5. **Why by line.**
   - Clicking a line shows every decision the attempt recorded for that file. Link a line to the decision and the moment in the session that produced it.
   - The Why view replays recorded landings only, so a change pushed to trunk outside Braid is shown with stale attribution. Attribute outside changes.
   - Decisions are long paragraphs stacked above the diff; put the change and its evidence first. `record` accepts a title with no body or files. A landed or abandoned attempt can still record. Nothing requires any why before `ready` (a forced record invites filler, so prefer tying why to lines over making it mandatory).
   - `by` on landings is a string the client sends: there are no people behind the one admin token.
   - A check's `detail` is not redacted before it is committed to the context repo.
6. **Planner and reviewer agent**, with whatever time is left, then the video.

Also from the reviews:

- Tests cover git analysis, redaction, capture and the tar reader. Nothing tests the project object, landing, the access guard or the two gateways' allow-lists.
- Scale: landing fetches full history of trunk and the attempt into memory. Project state sends every decision and every reconciliation's full file contents on each change. A conflict in large files can exceed the row size limit.
- Reviewers' suggestions to stop: more preview special cases, more redaction patterns, more session capture, export and import, and the Workers AI reconciliation path (an 8,000-token model writing whole files). Decision: keep what is built, do not extend it.
- "Behind" counts commits but the UI says landings. `wrangler.jsonc` carries the author's account id. Running Braid needs Workers Paid, Docker and Artifacts access, so a judge cannot run it without those.

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
- **Item 4 on the deployed instance.** The public view, the sign-in dialog, the served launcher and the phone layout have only run locally.
- **A landing interrupted between the push and its record.** Handled in code, never forced to happen. (An interrupted run did happen, during a deploy on October 4: it was reported as "could not run" and ran again when asked.)
- **The region editor on the deployed instance.** It was used in Chrome locally; on the deployed instance resolutions went through the API, the model and a hosted agent.
- **On the deployed instance: landing refused while a hosted agent is still working.** It ran locally; on the deployed instance my request arrived before the agent had pushed anything, so it was refused for having no commits instead.

Model-backed reconciliation (Workers AI and Claude) and a real-agent conflict through reconciliation were both verified locally on October 4, 2026, in the acceptance test for step 4.

Checked on October 4, 2026:

- Locally: the admin token guard (every route class, cookie sign-in, keyed previews, the socket), the context repo's contents read back from a clone, and capture and redaction with real Claude Code and Codex sessions that ran `env`, `cat .mcp.json` and `git config --list`.
- Step 4 on the deployed instance, in a separate project (`dep-step4`):
  - Claude Code and Codex each ran in a sandbox through AI Gateway, pushed, waited for verification and marked their attempts ready. No `Co-Authored-By` trailer on the hosted Claude Code commit.
  - Landing the second attempt conflicted. Braid refused a resolution identical to either side. Codex, brought back, wrote a version with both buttons and it landed.
  - A commit with a failing test was pushed to a third attempt. Claude Code, brought back to fix it, found the cause, pushed, waited for verification to pass and marked the attempt ready.
  - A second conflict was reconciled with Claude through the gateway, and trunk verification passed afterwards.
- Item 1 on the deployed instance, in a separate project (`dep-item1`, since deleted): a landing asked for before verification finished waited and landed by itself; an attempt that passed alone and failed when merged with trunk was refused with trunk untouched, and Claude Code, brought back, merged trunk, fixed it and it landed; a landing was refused for the wrong commit and when the attempt moved after the request; an attempt that removed the test script and added its own `braid.json` still had the test run; on a failing trunk a bystander was refused and a fix landed; a landed attempt's tools were refused; creating a project named after an existing repository was refused. The existing `braid` project loaded after the schema change.
- Item 2 on the deployed instance, in a separate project (`dep-item2`, since deleted): an answer, a message and an intent edit all reached the agent's next tool response; feedback on a ready attempt sent it back and dropped its queued landing; abandon and reopen; a landing reverted with a later landing kept; hosted Codex, sent back with a note, came back, made the change, recorded how, and it landed. Also the item 1 checks that had only run locally: a resolved conflict was verified as a merge before it landed, a landing was cancelled, "Land now" landed without waiting, and abandoning an attempt stopped its running agent.
- Item 3 on the deployed instance, in two separate projects (since deleted): Claude resolved two conflicts in a 68 kB, 4,000-line file in 25 seconds with every other line kept; a wrong number of replacements and one side at every conflict were refused; with npm and with pnpm, two attempts each added a dependency and the second landed with `package.json` merged by key, the lockfile regenerated in six seconds and the frozen install passing; hosted Claude Code, brought back to a conflict, answered with one replacement for the one line and it landed with both attributes.
- Deployed at https://braid.undiluted7027.workers.dev: the push-event Workflow (a push with no `checkpoint` updated the attempt), sandbox runs and their isolation on Cloudflare's microVM, sign-in, the live socket, both kinds of preview, `ready` refused on a failed commit, and the forced-landing confirmation.

The `braid` project now lives on the deployed instance. It was moved there with its intents, decisions, landings and sessions; the local instance has forgotten it.
