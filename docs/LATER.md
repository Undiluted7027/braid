# Later

Features and gaps to pick up after the core is solid. The build plan below is in priority order; the sections after it are not.

## Build plan

What to build next, and the assessment behind it (the brief question by question, a 40-agent run, ACP, authentication, and what to take from T3 Code), is in [DIRECTION.md](DIRECTION.md), written October 9, 2026. This file stays the record of what was built and checked.

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
4. **First ten minutes.** Done and deployed on October 4, 2026.
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
5. **Why by line.** Done and deployed on October 4, 2026.
   - Done: a trunk file is traced along trunk's own history, commit by commit. A line belongs to the landing that put it there and, inside that landing, to the commit the agent made in its attempt. That commit carries the decisions the agent recorded between its previous commit and this one (those naming the file first) and the place in its session where it edited the file.
   - Done: the Why page selects a run of lines, not a whole landing. It shows the commit, "decided while writing these lines", then other decisions about the file, and a link that opens the intent page on that attempt's Session tab with the edit in view and marked. Checked on `real-test`: seven lines from a hosted Codex attempt led to its one decision and to the edit event in its session.
   - Done: lines that are in neither side of a merge are marked as written while reconciling, with the rationale. Lines pushed to trunk outside Braid are marked "out" and show their commit's subject, author and time, so they no longer wear a stale intent.
   - Done: `record` refuses a decision, assumption or rejection with no body, and reminds the agent to name files when it names none. A check's `detail` is redacted before it is stored.
   - Open: an attempt with one commit puts all its decisions on all its lines; the finer link needs agents that commit as they go. An attempt with no captured session has no moment to show.
   - Open: the trace reads trunk's last 300 commits and 50 per attempt, and is rebuilt for each file when trunk moves (about six seconds locally for a file with five landings).
   - Open: `by` on a landing is still a name the client sends. There are no people behind the one admin token.
6. **Planner and reviewer agent**, with whatever time is left, then the video.

Also from the reviews:

- Tests cover git analysis, redaction, capture and the tar reader. Nothing tests the project object, landing, the access guard or the two gateways' allow-lists.
- Scale: landing fetches full history of trunk and the attempt into memory. Project state sends every decision and every reconciliation's full file contents on each change. A conflict in large files can exceed the row size limit.
- Reviewers' suggestions to stop: more preview special cases, more redaction patterns, more session capture, export and import, and the Workers AI reconciliation path (an 8,000-token model writing whole files). Decision: keep what is built, do not extend it.
- "Behind" counts commits but the UI says landings. `wrangler.jsonc` carries the author's account id. Running Braid needs Workers Paid, Docker and Artifacts access, so a judge cannot run it without those.

### Also needed for the submission

- The 5 to 10 minute demo video.
- A public source repository and a pass over the run instructions once deployed.

## Interface overhaul (October 4, 2026)

The interface was redone twice on this day. The first pass (navy shell, Instrument Sans, tabs on attempts) was judged not enough; its diff is not in the tree. What is there now follows `DESIGN.md` in the repository root, which records the measured references and every value.

- **Look.** Light, neutral and hairline-ruled, with Geist and Geist Mono self-hosted from npm packages (so Braid's preview of itself shows the real fonts). Buttons are ink; the eight intent colours and the three status colours are the only colour. The loom, agent sessions, commands and run output are the one dark surface in both themes. Panels that ask for a decision (Needs you, an open reconciliation, forms, dialogs, the reason card in Why) have an ink border and a hard offset shadow.
- **Drawings.** All inline SVG made of the loom's parts (`Graphics.tsx`): the labelled scene on the home page, one diagram per how-it-works step, a small loom on each project card and each intent drawn from its real attempts, and a drawing for every empty, loading and failed area. One icon set (`Kit.tsx`) replaces the text glyphs.
- **Home.** What Braid is beside the scene, then projects (each card shows its attempts, open intents, attempts in progress and open conflicts), then how it works. The new-project form says what a valid name is before it is refused.
- **Project page.** A visible title with four counts, the Needs-you list, the loom, intents as ruled groups (each attempt is a row: who, status, summary or what it is doing now, and its signals), and a side column with Trunk, who can read the project, and Activity. Trunk's own run is now readable here, with its steps and output; before, a failing trunk could be seen only as a tag in the top bar.
- **Intent page.** Goal and "Done when" side by side, the intent's strands against trunk, then the reconciliation if one is open, then attempts two abreast (landed first, then in progress, then closed). Tabs follow the keyboard pattern (arrows, Home, End). Disabled actions say why next to the button: nothing pushed, or what a resolution still needs.
- **Reconciliation.** Ways to hand it to the model or the agent come first; each conflict is a fieldset that counts answered conflicts and marks the chosen starting point.
- **Why.** Files, code and reason in three columns; each run of lines is labelled once with its intent; trunk history is a vertical trunk with a node per commit. On a phone the reason stays at the bottom of the screen while the code scrolls.
- **Who made an attempt.** Claude Code and Codex attempts show Anthropic's Claude mark and OpenAI's mark (outlines from Simple Icons, in `brands.ts`), named on hover and to screen readers; other agents get a square with their initials. The text beside the mark is the model the agent ran on. Braid knows it for agents it hosts and for Claude Code started by the launcher, which reads it from the agent's output; otherwise the agent's name is shown. Codex does not say which model it used (its JSON events carry none, per its docs and a live run), so for a Codex started by the launcher the model is known only when `braid join --model` names it.
- **Asking first.** Browser `confirm` and `prompt` boxes are replaced by one dialog (`ask` in `Kit.tsx`) that names the consequence and the action.
- **Fixed on the way.** A visitor could see "Run again" on checks and the whole reconciliation editor; both are now read-only for them. Error messages from the server start with a capital. A closed attempt no longer shows a pulsing "queued" dot on Checks.
- **Checked.** Every page at 1440 and 390 px in light and dark; the visitor view; the sign-in and confirmation dialogs; an empty project, empty trunk, missing project and missing intent; and, by altering the state in the browser, a failed run with output, a failing trunk, a landing waiting in the queue, a hosted agent running, and an unanswered question. The journey (create a project, open, edit and abandon an intent, make a push command, delete the project) was walked by mouse and by keyboard.
- **Not checked.** A reverted landing, a failed merge with trunk, and the "resolving" state of a reconciliation were read in code only. No hosted agent was started, so a live session was seen only with altered state.
- **Cards on the loom (added later the same week).** Everything drawn on the loom explains itself in a card (`LoomCard.tsx`) on hover, keyboard focus and tap: an attempt (intent, agent and model, status in words, what it is doing now, summary, files and decisions, an unanswered question, Braid's run, waiting to land, distance behind trunk, conflicts), a landing (who, when, commit, files, reconciliation and its rationale, whether it was taken back out, links to Why and the intent), a tie (kind, what it means, each file, both sides), where trunk started, and two things the loom did not draw before: reverts and commits pushed to trunk outside Braid (from `/history`). A click or Enter still follows the thing; a finger's first tap shows the card, which carries the link. On a phone the card is a sheet at the bottom with a close button. The card is placed once when it opens and filled from state by key, so a refresh changes its words and not its position. The small looms on project cards and intents show the same cards on hover only. Checked at 1440 px in light and dark and at 390 px with touch; reverts, outside pushes, a working hosted agent, a queued landing and an open question were checked with altered state because no local project has them.
- **Open.** The Why view does not draw a line from the selected code to its reason. The home page fetches each listed project's full state to draw its card; a summary read would be lighter with many projects. The launcher's help text (`cli/braid.mjs`) was not revisited.

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
- Item 4 on the deployed instance, in a separate public project (`dep-item4`, since deleted): a visitor could list and read it live (state, files, history, a keyed preview) and was refused every write, export, credential and agent start, and the private `braid` project; the sign-in dialog rejected a wrong token and opened the full view with the right one; the join command copied from the UI created and cloned an attempt using the served launcher; the clone command form cloned `braid`'s trunk with a read token that could not push; the starter project's tests ran on trunk; and the home, project, intent and Why pages were 390 px wide at 390 px.
- The rebuilt interface on the deployed instance, driven in Chrome in a throwaway project (`dep-ui`, since deleted): sign-in through the dialog, a project made with the form, an intent opened, "Run Claude Code" pressed, its session appearing live, the attempt showing the Claude mark with `claude-sonnet-5-5` beside it, the Checks tab, landing with the button, the Why page explaining the landed line, deleting the project by typing its name, and 390 px wide pages at 390 px. Fonts were the self-hosted Geist, and the served launcher has `--model`. No page errors.
- Item 5 on the deployed instance, on the `braid` project itself: `src/worker/project.ts` (1,697 lines) traced in 5.6 seconds the first time and under a second after, with every traced file matching trunk line for line; lines from direct pushes showed their commit ("pushed outside Braid by ..."); the four lines Codex added for intent 6 led to its two decisions and to the edit event in its session, which opened in view and marked.
- Deployed at https://braid.undiluted7027.workers.dev: the push-event Workflow (a push with no `checkpoint` updated the attempt), sandbox runs and their isolation on Cloudflare's microVM, sign-in, the live socket, both kinds of preview, `ready` refused on a failed commit, and the forced-landing confirmation.

The `braid` project now lives on the deployed instance. It was moved there with its intents, decisions, landings and sessions; the local instance has forgotten it.
