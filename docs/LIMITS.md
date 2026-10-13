# Limits

What Braid does not do, or does only in part. What is planned next is in [DIRECTION.md](DIRECTION.md); what was built, checked and left open at each step is in [LATER.md](LATER.md).

- A built preview is static files. An app that needs its own backend loads but its API calls fail. Braid's own UI is the exception: it reads from the instance it is previewed on. Assets a build loads by root path from inside JavaScript or CSS (lazy chunks, `url(/...)`) are not redirected.
- Verification supports Node projects (npm or pnpm). Each step has ten minutes.
- Overlap prediction is per file, by three-way line merge. It does not see semantic conflicts in different files.
- A file deleted on one side and edited on the other cannot be reconciled in the UI; the agent merges trunk with git (`sync`). A rename shows up as exactly that.
- Lockfiles are regenerated for npm and pnpm only.
- A hosted agent runs once, for at most 45 minutes. A person can bring it back to act on a note, reconcile a conflicted landing or fix failed checks. Only a conflict can bring it back by itself, and only in a project that asks for that (`landing.conflicts`).
- Reverting a landing adds one commit that undoes it and reopens the intent. It is refused if a later landing changed the same lines, and the revert itself is verified on trunk afterwards, not before.
- Braid refuses a resolution that is identical to one side unless told that is intended.
- One merge is verified at a time, so landings queue behind each other; each takes as long as the project's checks.
- A project runs at most six hosted agents at once (`HOSTED_MAX`), which also bounds a race. A race has no budget in money.
- Braid compares attempts; it does not combine them. What a judge finds worth keeping in a losing attempt is shown, and a person can send it to the winner as a note.
- A picture shows the page as it loads. It cannot show behaviour (a click, a reload), and inherits the limits of previews.
- Attempts at one intent cannot see each other through Braid. Two people running agents by hand can of course show each other anything.
- Tests (`pnpm test`) cover git analysis, the tree merge, redaction, session capture, the tar reader, and the project object itself run under Node against real git repositories with stand-ins for the models; `pnpm sim` exercises a deployed or local instance end to end.
