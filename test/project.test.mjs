import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./harness/world.mjs";

/** A project with the starter app on trunk, trunk verified, and one open intent per title. */
async function started(t, titles = ["First"], env) {
	const w = await world(env);
	t.after(() => w.close());
	await w.project.init({ slug: "p", name: "P", description: "", source: "starter" });
	await w.settle();
	await w.finish("trunk");
	const intents = [];
	for (const title of titles) intents.push(await w.project.createIntent({ title, goal: `${title}.` }));
	return { w, intents };
}
/** Join an intent and get a working copy of the attempt. */
async function agent(w, intent, name) {
	const joined = await w.project.join({ intentId: intent.id, agent: name, origin: "http://braid" });
	return { ...joined, name, repo: w.rows("SELECT repo FROM attempts WHERE id = ?", joined.attemptId)[0].repo, dir: null };
}
const work = (w, a, files, message) => { a.dir ??= w.clone(a.repo, a.name); return w.push(a.dir, files, message); };

test("a push is read by the worker: the attempt's files, its verification, and the note", async (t) => {
	const { w, intents } = await started(t);
	const a = await agent(w, intents[0], "ana");
	const sha = work(w, a, { "notes.md": "hello\n" });
	await w.project.onPush(a.repo);
	assert.equal((await w.state()).attempts[0].headSha !== sha, true, "nothing is read in the call that reports the push");
	await w.settle();
	const s = await w.state();
	assert.deepEqual([s.attempts[0].headSha, s.attempts[0].files.map((f) => `${f.status} ${f.path}`)], [sha, ["added notes.md"]]);
	assert.deepEqual(w.runs.map((r) => [r.ref, r.sha === sha]).at(-1), [a.attemptId, true]);
	assert.match(s.activity.map((x) => x.text).join("\n"), /ana pushed .* to attempt 1\.1 \(1 file changed\)/);
});

test("checkpoint answers with the caller's own push already read", async (t) => {
	const { w, intents } = await started(t);
	const a = await agent(w, intents[0], "ana");
	const sha = work(w, a, { "notes.md": "hello\n" });
	const asked = w.tool(a, "checkpoint", { summary: "notes" });
	await w.settle();
	const out = await asked;
	assert.deepEqual([out.head, out.changed, out.note], [sha, ["added notes.md"], undefined]);
});

// ── landing ──────────────────────────────────────────────────────────────────
// These hold what landing does, whatever the machinery under it. `land` asks, lets the worker do
// everything that is due, and says where the attempt stands afterwards.

async function standing(w, id) {
	const s = await w.state(), a = s.attempts.find((x) => x.id === id), q = s.queue.find((x) => x.attemptId === id);
	const open = s.reconciliations.find((r) => r.attemptId === id && r.status === "open");
	if (a.status === "landed") return { landed: s.intents.find((i) => i.id === a.intentId).landedSha };
	if (open) return { conflict: open.conflicts.map((c) => c.path), reconciliation: open };
	if (q) return { queued: q.state, note: q.note };
	const no = s.activity.find((x) => x.attemptId === id && x.kind === "land" && /was not landed/.test(x.text));
	return no ? { refused: no.text } : { idle: a.status };
}
async function land(w, id, { force = false, sha, by = "rev" } = {}) {
	try { await w.project.land(id, by, force, sha); } catch (e) { await w.settle(); return { refused: String(e.message) }; }
	await w.settle();
	return standing(w, id);
}
/** An attempt with one pushed commit that Braid has read, verified with `status` unless that is null. */
async function ready(w, intent, name, files, status = "pass") {
	const a = await agent(w, intent, name);
	a.sha = work(w, a, files);
	await w.project.onPush(a.repo);
	await w.settle();
	if (status) { await w.finish(a.attemptId, status); await w.settle(); }
	return a;
}
/** The run that decides an attempt's merge with trunk: its batch's, or its own step once a failed batch is taken apart. */
const mergeRef = async (w, id) => (await w.state()).candidates.find((c) => c.attemptId === id).runRef;
const trunkLine = (w) => w.git(`${w.root}/p--trunk.git`, "log", "--first-parent", "--format=%s", "refs/heads/main").split("\n");
const trunkFile = (w, file) => w.git(`${w.root}/p--trunk.git`, "show", `refs/heads/main:${file}`);
const title = (to) => ({ "index.html": `<!doctype html>\n<title>${to}</title>\n` });

test("a landing asked for before verification finishes waits, then lands by itself", async (t) => {
	const { w, intents } = await started(t);
	const a = await ready(w, intents[0], "ana", { "notes.md": "hello\n" }, null);
	const first = await land(w, a.attemptId, { sha: a.sha });
	assert.equal(first.queued, "waiting");
	assert.match(first.note, /waiting for .* to be verified/);
	assert.equal(w.head("p--trunk") === a.sha, false);
	await w.finish(a.attemptId, "pass");
	await w.settle();
	const done = await standing(w, a.attemptId);
	assert.equal(done.landed, w.head("p--trunk"));
	assert.equal(trunkFile(w, "notes.md"), "hello");
	const s = await w.state();
	assert.deepEqual([s.intents[0].status, s.landings.length, s.queue.length, s.project.head], ["landed", 1, 0, done.landed]);
	// The why is copied to the context repository by the worker, and trunk is verified again.
	assert.match(w.git(`${w.root}/p--context.git`, "show", "refs/heads/main:intents/1/attempt-1.1/attempt.json"), /"landedAs"/);
	assert.equal(w.runs.at(-1).ref === "trunk" && w.runs.at(-1).sha === done.landed, true);
});

test("when trunk has moved, the merge is built, parked on the attempt and verified before trunk takes it", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", { "a.md": "a\n" }), b = await ready(w, intents[1], "ben", { "b.md": "b\n" });
	assert.ok((await land(w, a.attemptId)).landed);
	const afterA = w.head("p--trunk");
	const held = await land(w, b.attemptId);
	assert.equal(held.queued, "verifying");
	assert.equal(w.head("p--trunk"), afterA, "trunk does not move before the merge has passed");
	const batch = (await w.state()).batches[0], candidate = batch.tipSha;
	assert.deepEqual([batch.members, batch.trunkSha, batch.state], [[b.attemptId], afterA, "verifying"]);
	const job = w.runs.at(-1);
	assert.deepEqual([job.ref, job.sha, job.repo, w.head("p--landing", job.branch)], [`batch:${batch.id}`, candidate, "p--landing", candidate]);
	await w.finish(await mergeRef(w, b.attemptId), "pass");
	await w.settle();
	assert.equal((await standing(w, b.attemptId)).landed, candidate);
	assert.deepEqual([w.head("p--trunk"), trunkFile(w, "a.md"), trunkFile(w, "b.md")], [candidate, "a", "b"]);
});

test("a merge that fails verification is refused, trunk is untouched and the agent is told why", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", { "a.md": "a\n" }), b = await ready(w, intents[1], "ben", { "b.md": "b\n" });
	await land(w, a.attemptId);
	const afterA = w.head("p--trunk");
	await land(w, b.attemptId);
	await w.finish(await mergeRef(w, b.attemptId), "fail");
	await w.settle();
	const out = await standing(w, b.attemptId);
	assert.match(out.refused, /passes on its own but failed verification when merged with trunk/);
	assert.equal(w.head("p--trunk"), afterA);
	const heard = await w.tool(b, "brief");
	assert.ok(heard.heads_up.some((h) => h.kind === "merge-failed" && h.failed[0].step === "test"));
});

test("a landing is for one commit: the wrong commit, or an attempt that moves while it waits, is refused", async (t) => {
	const { w, intents } = await started(t);
	const a = await ready(w, intents[0], "ana", { "notes.md": "one\n" }, null);
	assert.match((await land(w, a.attemptId, { sha: "0".repeat(40) })).refused, /has moved to .* since you looked at/);
	assert.equal((await land(w, a.attemptId, { sha: a.sha })).queued, "waiting");
	work(w, a, { "notes.md": "two\n" });
	await w.project.onPush(a.repo);
	await w.settle();
	assert.match((await standing(w, a.attemptId)).refused, /moved to .* after landing was asked for/);
	assert.equal((await w.state()).queue.length, 0);
});

test("a commit that failed verification is refused unless forced, and a forced landing is marked", async (t) => {
	const { w, intents } = await started(t);
	const a = await ready(w, intents[0], "ana", { "notes.md": "one\n" }, "fail");
	assert.match((await land(w, a.attemptId)).refused, /failed verification/);
	assert.equal((await w.state()).attempts[0].status, "working");
	assert.ok((await land(w, a.attemptId, { force: true })).landed);
	assert.match((await w.state()).activity.map((x) => x.text).join("\n"), /forced without waiting for verification/);
});

test("a conflict opens a reconciliation; a resolution is verified as a merge and lands with both sides", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", title("Ana")), b = await ready(w, intents[1], "ben", title("Ben"));
	await land(w, a.attemptId);
	const afterA = w.head("p--trunk");
	const out = await land(w, b.attemptId);
	assert.deepEqual(out.conflict, ["index.html"]);
	const s = await w.state();
	assert.deepEqual([s.attempts.find((x) => x.id === b.attemptId).status, s.queue.length, w.head("p--trunk")], ["conflicted", 0, afterA]);
	assert.equal(out.reconciliation.conflicts[0].trunkWhy[0].intentId, intents[0].id);
	const told = await w.tool(b, "reconciliation");
	assert.equal(told.reconciliation.conflicts[0].regions.length, 1);
	// One side only is refused; both sides goes on to be verified, and lands when that passes.
	await assert.rejects(() => w.tool(b, "resolve", { resolutions: [{ path: "index.html", regions: ["<title>Ben</title>\n"] }], rationale: "mine" }), /keeps only one side/);
	await w.tool(b, "resolve", { resolutions: [{ path: "index.html", regions: ["<title>Ana and Ben</title>\n"] }], rationale: "Both names are in the title." });
	await w.settle();
	assert.equal((await standing(w, b.attemptId)).queued, "verifying");
	await w.finish(await mergeRef(w, b.attemptId), "pass");
	await w.settle();
	assert.ok((await standing(w, b.attemptId)).landed);
	assert.match(trunkFile(w, "index.html"), /Ana and Ben/);
	assert.match(w.git(`${w.root}/p--trunk.git`, "log", "-1", "--format=%B", "refs/heads/main"), /Reconciled with I1 by ben: Both names are in the title\./);
});

test("landing one attempt of an intent supersedes the others and stops their agents; a landed attempt takes no more calls", async (t) => {
	const { w, intents } = await started(t);
	const a = await ready(w, intents[0], "ana", { "a.md": "a\n" }), b = await ready(w, intents[0], "ben", { "b.md": "b\n" });
	w.db.prepare("UPDATE attempts SET hosted = 'running' WHERE id = ?").run(b.attemptId);
	assert.ok((await land(w, a.attemptId)).landed);
	const s = await w.state();
	assert.equal(s.attempts.find((x) => x.id === b.attemptId).status, "superseded");
	assert.ok(w.agents.some((x) => x.what === "stop" && x.name === `p/${b.attemptId}`));
	await assert.rejects(() => w.tool(a, "brief"), /is landed and takes no more tool calls/);
	await assert.rejects(() => w.tool(b, "brief"), /is superseded/);
});

test("a landing can be cancelled, and sending an attempt back drops the landing asked for it", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", { "a.md": "a\n" }, null), b = await ready(w, intents[1], "ben", { "b.md": "b\n" }, null);
	await land(w, a.attemptId); await land(w, b.attemptId);
	await w.project.cancelLanding(a.attemptId);
	await w.project.respond(b.attemptId, { kind: "feedback", body: "rename the file" });
	await w.settle();
	const s = await w.state();
	assert.deepEqual([s.queue.length, s.attempts.map((x) => x.status)], [0, ["working", "working"]]);
	await w.finish(a.attemptId, "pass"); await w.finish(b.attemptId, "pass"); await w.settle();
	assert.equal(w.head("p--trunk"), (await w.state()).project.head);
	assert.equal((await w.state()).landings.length, 0);
});

test("a landing that reached trunk but was not written down is recorded after a restart, once", async (t) => {
	const { w, intents } = await started(t);
	const a = await ready(w, intents[0], "ana", { "notes.md": "hello\n" });
	// The process dies between the push and the record.
	const real = w.project.recordLanding;
	w.project.recordLanding = async () => { throw new Error("the process ended"); };
	await land(w, a.attemptId).catch(() => {});
	const pushed = w.head("p--trunk");
	assert.equal(pushed === a.sha, false, "the landing commit is on trunk");
	assert.equal((await w.state()).landings.length, 0);
	w.restart();
	await w.project.onPush("p--trunk");
	await w.settle({ later: true });
	const s = await w.state();
	assert.deepEqual([s.landings.map((l) => l.sha), s.intents[0].status, s.attempts[0].status, s.queue.length, s.project.head], [[pushed], "landed", "landed", 0, pushed]);
	assert.equal(w.head("p--trunk"), pushed, "nothing was pushed a second time");
	void real;
});

test("a landing can be reverted: trunk gets one commit that undoes it and the intent is open again", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", { "a.md": "a\n" }), b = await ready(w, intents[1], "ben", { "b.md": "b\n" });
	const first = await land(w, a.attemptId);
	await land(w, b.attemptId); await w.finish(await mergeRef(w, b.attemptId), "pass"); await w.settle();
	await assert.rejects(() => w.project.revertLanding(first.landed, "rev", ""), /say why/);
	assert.deepEqual(await w.project.revertLanding(first.landed, "rev", "broke the build"), { queued: true });
	await w.settle();
	const out = { sha: w.head("p--trunk") };
	assert.equal((await w.state()).outcomes[0].outcome, "reverted");
	assert.throws(() => trunkFile(w, "a.md"));
	assert.equal(trunkFile(w, "b.md"), "b");
	const s = await w.state();
	assert.deepEqual([s.intents[0].status, s.attempts[0].status, s.landings.find((l) => l.sha === first.landed).revertedBy, s.project.head], ["open", "reverted", out.sha, out.sha]);
	await assert.rejects(() => w.project.revertLanding(first.landed, "rev", "again"), /already reverted/);
});

test("both sides changing dependencies: the lockfile is regenerated in a sandbox and the merge lands with it", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const pkg = (deps) => JSON.stringify({ name: "tally", private: true, scripts: { test: "node --test" }, dependencies: deps }, null, 2) + "\n";
	const a = await ready(w, intents[0], "ana", { "package.json": pkg({ left: "1.0.0" }), "package-lock.json": "lock with left\n" });
	const b = await ready(w, intents[1], "ben", { "package.json": pkg({ right: "2.0.0" }), "package-lock.json": "lock with right\n" });
	await land(w, a.attemptId);
	const held = await land(w, b.attemptId);
	assert.deepEqual([held.queued, held.note], ["locking", "regenerating the lockfile from the merged package.json"]);
	const job = w.runs.at(-1);
	assert.deepEqual([job.ref, job.regenerate], [`lock:${b.attemptId}`, ["package-lock.json"]]);
	await w.project.lockfiles(job.runId, { "package-lock.json": "lock with left and right\n" });
	await w.finish(`lock:${b.attemptId}`, "pass");
	await w.settle();
	assert.equal((await standing(w, b.attemptId)).queued, "verifying");
	await w.finish(await mergeRef(w, b.attemptId), "pass");
	await w.settle();
	assert.ok((await standing(w, b.attemptId)).landed);
	assert.equal(trunkFile(w, "package-lock.json"), "lock with left and right");
	assert.deepEqual(Object.keys(JSON.parse(trunkFile(w, "package.json")).dependencies), ["left", "right"]);
});

test("while trunk is failing, an attempt whose merge does not pass is refused and one that fixes it lands", async (t) => {
	const { w, intents } = await started(t, ["One", "Two", "Fix"]);
	const a = await ready(w, intents[0], "ana", { "a.md": "a\n" }), b = await ready(w, intents[1], "ben", { "b.md": "b\n" }), c = await ready(w, intents[2], "cy", { "fix.md": "fix\n" });
	await land(w, a.attemptId);
	await w.finish("trunk", "fail"); await w.settle();
	await land(w, b.attemptId); await w.finish(await mergeRef(w, b.attemptId), "fail"); await w.settle();
	assert.match((await standing(w, b.attemptId)).refused, /trunk itself is failing, and this attempt does not fix it/);
	await land(w, c.attemptId); await w.finish(await mergeRef(w, c.attemptId), "pass"); await w.settle();
	assert.ok((await standing(w, c.attemptId)).landed);
});

// ── what the worker does after a request has answered ────────────────────────

test("asking to land only writes it down; how it turned out is recorded when the worker has done it", async (t) => {
	const { w, intents } = await started(t, ["One", "Two", "Three"]);
	const a = await ready(w, intents[0], "ana", title("Ana")), b = await ready(w, intents[1], "ben", title("Ben")), c = await ready(w, intents[2], "cy", { "c.md": "c\n" }, "fail");
	const before = w.head("p--trunk");
	assert.deepEqual(await w.project.land(a.attemptId, "rev"), { landed: false, queued: true, waiting: "" });
	assert.equal(w.head("p--trunk"), before, "nothing has been pushed by the time the request answers");
	await w.settle();
	await land(w, b.attemptId); await land(w, c.attemptId);
	const outcomes = (await w.state()).outcomes.map((o) => [o.kind, o.outcome, o.attemptId, o.by]).reverse();
	assert.deepEqual(outcomes, [["landing", "landed", a.attemptId, "rev"], ["landing", "conflict", b.attemptId, "rev"], ["landing", "refused", c.attemptId, "rev"]]);
	assert.match((await w.state()).outcomes[0].text, /failed verification/);
});

test("after a landing, an attempt that touches none of its files is not read again; one that does is", async (t) => {
	const { w, intents } = await started(t, ["One", "Two", "Three"]);
	const a = await ready(w, intents[0], "ana", { "a.md": "a\n" }), b = await ready(w, intents[1], "ben", { "b.md": "b\n" }), c = await ready(w, intents[2], "cy", { "a.md": "c's\n" });
	const from = (await w.project.events(0, 1)).latest;
	await land(w, a.attemptId);
	const since = (await w.project.events(from, 2000)).events;
	const of = (type) => since.filter((e) => e.type === type).map((e) => e.attemptId);
	assert.deepEqual([of("attempt.trunk-advanced"), of("attempt.observed")], [[b.attemptId], [c.attemptId]]);
	const s = await w.state(), row = (x) => s.attempts.find((y) => y.id === x.attemptId);
	assert.deepEqual([row(b).behind, row(b).trunkConflicts, row(c).behind, row(c).trunkConflicts], [1, [], 1, ["a.md"]]);
	// The one that was not read still lands on the trunk that is really there.
	await land(w, b.attemptId); await w.finish(await mergeRef(w, b.attemptId), "pass"); await w.settle();
	assert.deepEqual([trunkFile(w, "a.md"), trunkFile(w, "b.md")], ["a", "b"]);
});

test("a revert that later landings stand in the way of is refused, and says so", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", title("Ana"));
	const first = await land(w, a.attemptId);
	const b = await ready(w, intents[1], "ben", title("Ana and Ben"));
	await land(w, b.attemptId);
	const head = w.head("p--trunk");
	await w.project.revertLanding(first.landed, "rev", "wrong name");
	await w.settle();
	const s = await w.state();
	assert.deepEqual([s.outcomes[0].kind, s.outcomes[0].outcome, s.intents[0].status, w.head("p--trunk")], ["revert", "refused", "landed", head]);
	assert.match(s.outcomes[0].text, /Later landings changed the same lines in index\.html/);
});

test("reconciling with a model is asked for and done later; a model that fails leaves the conflict open and says why", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", title("Ana")), b = await ready(w, intents[1], "ben", title("Ben"));
	await land(w, a.attemptId);
	const { reconciliation } = await land(w, b.attemptId);
	assert.deepEqual(await w.project.resolveWithModel(reconciliation.id), { resolving: true });
	assert.equal((await w.state()).reconciliations[0].status, "resolving");
	await w.settle();
	const s = await w.state();
	assert.deepEqual([s.reconciliations[0].status, s.outcomes[0].kind, s.outcomes[0].outcome, s.outcomes[0].ref], ["open", "reconcile", "failed", `R${reconciliation.id}`]);
});

test("an agent is started by the worker; a stop asked for at once still comes after the start", async (t) => {
	const { w, intents } = await started(t, ["One"], { ANTHROPIC_API_KEY: "k" });
	const { attemptId } = await w.project.hostAgent(intents[0].id, "claude");
	assert.deepEqual([w.agents.length, (await w.state()).attempts[0].hosted], [0, "starting"]);
	await w.project.stopHosted(attemptId);
	await w.settle();
	assert.deepEqual(w.agents.map((x) => [x.what, x.name]), [["start", `p/${attemptId}`], ["stop", `p/${attemptId}`]]);
	assert.deepEqual([w.agents[0].job.task, w.agents[0].job.kind, w.agents[0].job.attemptId, typeof w.agents[0].job.brief], ["work", "claude", attemptId, "string"]);
});

test("an agent that cannot be started is marked failed instead of starting for ever", async (t) => {
	const { w, intents } = await started(t, ["One"], { ANTHROPIC_API_KEY: "k" });
	w.fail("agent.start", 99);
	await w.project.hostAgent(intents[0].id, "claude");
	await w.settle({ later: true });
	const s = await w.state();
	assert.equal(s.attempts[0].hosted, "failed");
	assert.match(s.attempts[0].hostedDetail, /could not start/);
	assert.deepEqual([s.outcomes[0].kind, s.outcomes[0].outcome, s.stuck.length], ["agent", "failed", 0]);
});

test("work that fails five times is listed as stuck and can be tried again", async (t) => {
	const { w, intents } = await started(t);
	const a = await agent(w, intents[0], "ana");
	work(w, a, { "notes.md": "hello\n" });
	w.fail("run.start", 5);
	await w.project.onPush(a.repo);
	await w.settle({ later: true });
	let s = await w.state();
	assert.deepEqual(s.stuck.map((x) => [x.id, x.type, x.tries]), [[`run.start:${a.attemptId}`, "run.start", 5]]);
	assert.match(s.stuck[0].error, /run\.start failed/);
	assert.match(s.activity.map((x) => x.text).join("\n"), /Braid could not finish "run\.start" after 5 tries/);
	await w.project.retryEffect(s.stuck[0].id);
	await w.settle();
	s = await w.state();
	assert.deepEqual([s.stuck.length, w.runs.at(-1).ref], [0, a.attemptId]);
	await assert.rejects(() => w.project.retryEffect("nothing"), /not something that failed/);
});

test("a request sent twice with the same key is done once, and a refusal is remembered", async (t) => {
	const { w } = await started(t, []);
	const first = await w.project.keyed("k1", "createIntent", [{ title: "Once", goal: "Only once." }]);
	const [again, also] = await Promise.all([w.project.keyed("k1", "createIntent", [{ title: "Once", goal: "Only once." }]), w.project.keyed("k1", "createIntent", [{ title: "Other", goal: "x" }])]);
	assert.deepEqual([again, also], [first, first]);
	assert.equal((await w.state()).intents.length, 1);
	await assert.rejects(() => w.project.keyed("k2", "createIntent", [{ title: "", goal: "" }]), /needs a title and a goal/);
	await assert.rejects(() => w.project.keyed("k2", "createIntent", [{ title: "Fine now", goal: "x" }]), /needs a title and a goal/);
	await assert.rejects(() => w.project.keyed("k3", "destroy", []), /cannot be called this way/);
	// Two joins in flight with one key give one attempt.
	const intent = (await w.state()).intents[0];
	const joins = await Promise.all([0, 1].map(() => w.project.keyed("k4", "join", [{ intentId: intent.id, agent: "ana", origin: "" }])));
	assert.equal(joins[0].attemptId, joins[1].attemptId);
	assert.equal((await w.state()).attempts.length, 1);
});

test("a landing cancelled while its merge is being built does not move trunk", async (t) => {
	const { w, intents } = await started(t);
	const a = await ready(w, intents[0], "ana", { "notes.md": "hello\n" });
	const before = w.head("p--trunk");
	// Hold the landing at the point where it asks Artifacts for a credential, just before it fetches and merges.
	let reached, release;
	const there = new Promise((r) => { reached = r; }), go = new Promise((r) => { release = r; });
	const token = w.project.host.token.bind(w.project.host);
	w.project.host.token = async (repo, scope, ttl) => { if (repo === "p--trunk" && scope === "write") { reached(); await go; } return token(repo, scope, ttl); };
	await w.project.land(a.attemptId, "rev");
	const working = w.settle();
	await there;
	await w.project.cancelLanding(a.attemptId, "rev");
	release();
	await working; await w.settle();
	const s = await w.state();
	assert.deepEqual([w.head("p--trunk"), s.landings.length, s.attempts[0].status, s.queue.length, s.outcomes.map((o) => o.outcome)], [before, 0, "working", 0, ["cancelled"]]);
	// Asked again afterwards, it lands.
	w.project.host.token = token;
	assert.ok((await land(w, a.attemptId)).landed);
});

// ── batches: landings merged one on top of the other and verified together ────

/** Attempts that are ready and verified, one per intent, then trunk moved once so that none of them merges to a tree already run. */
async function several(t, changes, env) {
	const { w, intents } = await started(t, ["Mover", ...changes.map((_, i) => `Intent ${i + 1}`)], env);
	const mover = await ready(w, intents[0], "mover", { "moved.md": "moved\n" });
	const agents = [];
	for (const [i, files] of changes.entries()) agents.push(await ready(w, intents[i + 1], `agent${i + 1}`, files));
	assert.ok((await land(w, mover.attemptId)).landed);
	return { w, intents, agents, base: w.head("p--trunk") };
}
const askAll = async (w, agents) => { for (const a of agents) await w.project.land(a.attemptId, "rev"); await w.settle(); };
const jobsSince = (w, n) => w.runs.slice(n).map((r) => r.ref);

test("landings asked for together are merged one on top of the other, verified with one run, and all land", async (t) => {
	const { w, agents, base } = await several(t, [{ "a.md": "a\n" }, { "b.md": "b\n" }, { "c.md": "c\n" }]);
	const before = w.runs.length;
	await askAll(w, agents);
	const s = await w.state(), batch = s.batches[0];
	assert.deepEqual([batch.members, batch.state, s.queue.map((q) => [q.state, q.batch])], [agents.map((a) => a.attemptId), "verifying", agents.map(() => ["verifying", batch.id])]);
	assert.deepEqual(jobsSince(w, before), [`batch:${batch.id}`], "one run for the three of them");
	assert.equal(w.head("p--trunk"), base, "trunk has not moved yet");
	await w.finish(`batch:${batch.id}`, "pass");
	await w.settle();
	const done = await w.state();
	assert.deepEqual([done.attempts.filter((a) => a.status === "landed").length, done.queue.length, done.batches.length, done.project.head], [4, 0, 0, batch.tipSha]);
	assert.equal(w.head("p--trunk"), batch.tipSha);
	// Trunk's own line is one landing commit each, in the order asked, each on top of the one before.
	assert.deepEqual(trunkLine(w).slice(0, 3), ["Land I4: Intent 3", "Land I3: Intent 2", "Land I2: Intent 1"]);
	const three = done.landings.slice(-3);
	assert.deepEqual(three.map((l) => l.parentSha), [base, three[0].sha, three[1].sha]);
	assert.deepEqual([trunkFile(w, "a.md"), trunkFile(w, "b.md"), trunkFile(w, "c.md")], ["a", "b", "c"]);
	// Trunk is the commit that just passed, so it is not run a second time.
	assert.deepEqual(jobsSince(w, before), [`batch:${batch.id}`]);
	assert.deepEqual(done.runs.filter((r) => r.ref === "trunk").map((r) => [r.sha, r.status]), [[batch.tipSha, "pass"]]);
	assert.deepEqual(done.outcomes.slice(0, 3).map((o) => o.outcome), ["landed", "landed", "landed"]);
});

test("when a batch fails, every step is run at once: those before the one that breaks it land, it is refused, the rest go back in line", async (t) => {
	const { w, agents, base } = await several(t, [{ "a.md": "a\n" }, { "b.md": "b\n" }, { "c.md": "c\n" }]);
	const [a, b, c] = agents;
	await askAll(w, agents);
	const batch = (await w.state()).batches[0], before = w.runs.length;
	await w.finish(`batch:${batch.id}`, "fail");
	await w.settle();
	assert.deepEqual([(await w.state()).batches[0].state, jobsSince(w, before)], ["splitting", [0, 1, 2].map((n) => `batch:${batch.id}:${n}`)]);
	assert.equal(w.head("p--trunk"), base);
	await w.finish(`batch:${batch.id}:0`, "pass"); await w.finish(`batch:${batch.id}:1`, "fail"); await w.finish(`batch:${batch.id}:2`, "fail");
	await w.settle();
	const s = await w.state(), of = (x) => s.attempts.find((y) => y.id === x.attemptId);
	assert.deepEqual([of(a).status, of(b).status, of(c).status], ["landed", "working", "working"]);
	assert.equal(w.head("p--trunk"), s.landings.at(-1).sha);
	assert.match((await standing(w, b.attemptId)).refused, /attempt 3\.1 passes on its own but failed verification when merged with trunk/);
	assert.ok((await w.tool(b, "checkpoint")).heads_up.some((h) => h.kind === "merge-failed"));
	// The one behind it is merged again, on the trunk that is there now, and lands when that passes.
	const next = s.batches[0];
	assert.deepEqual([next.members, next.trunkSha], [[c.attemptId], w.head("p--trunk")]);
	await w.finish(`batch:${next.id}`, "pass"); await w.settle();
	assert.ok((await standing(w, c.attemptId)).landed);
	assert.throws(() => trunkFile(w, "b.md"));
});

test("a batch that fails once and passes step by step is landed whole, and that is said", async (t) => {
	const { w, agents } = await several(t, [{ "a.md": "a\n" }, { "b.md": "b\n" }]);
	await askAll(w, agents);
	const batch = (await w.state()).batches[0];
	await w.finish(`batch:${batch.id}`, "fail"); await w.settle();
	await w.finish(`batch:${batch.id}:0`, "pass"); await w.finish(`batch:${batch.id}:1`, "pass"); await w.settle();
	const s = await w.state();
	assert.deepEqual([s.attempts.filter((x) => x.status === "landed").length, w.head("p--trunk")], [3, batch.tipSha]);
	assert.match(s.activity.map((x) => x.text).join("\n"), /failed once when verified together and passed when each step was run again/);
});

test("a landing that conflicts with one ahead of it waits for that one, then gets its reconciliation against trunk", async (t) => {
	const { w, agents } = await several(t, [title("Ana"), title("Ben"), { "c.md": "c\n" }]);
	const [a, b, c] = agents;
	await askAll(w, agents);
	let s = await w.state();
	assert.deepEqual(s.batches[0].members, [a.attemptId, c.attemptId]);
	assert.match(s.queue.find((q) => q.attemptId === b.attemptId).note, /conflicts with a landing ahead of it/);
	assert.equal(s.reconciliations.length, 0, "no reconciliation against a trunk that does not exist yet");
	await w.finish(`batch:${s.batches[0].id}`, "pass"); await w.settle();
	s = await w.state();
	assert.deepEqual([a, b, c].map((x) => s.attempts.find((y) => y.id === x.attemptId).status), ["landed", "conflicted", "landed"]);
	assert.deepEqual((await standing(w, b.attemptId)).conflict, ["index.html"]);
	assert.equal(s.reconciliations[0].trunkSha, w.head("p--trunk"));
});

test("cancelling one landing of a batch builds the batch again without it", async (t) => {
	const { w, agents, base } = await several(t, [{ "a.md": "a\n" }, { "b.md": "b\n" }, { "c.md": "c\n" }]);
	const [a, b, c] = agents;
	await askAll(w, agents);
	const first = (await w.state()).batches[0];
	await w.project.cancelLanding(b.attemptId, "rev");
	await w.settle();
	const second = (await w.state()).batches[0];
	assert.deepEqual([second.id !== first.id, second.members, w.runs.at(-1).ref], [true, [a.attemptId, c.attemptId], `batch:${second.id}`]);
	// The run of the batch that no longer stands changes nothing when it comes back.
	await w.finish(`batch:${first.id}`, "pass"); await w.settle();
	assert.equal(w.head("p--trunk"), base);
	await w.finish(`batch:${second.id}`, "pass"); await w.settle();
	const s = await w.state();
	assert.deepEqual([a, b, c].map((x) => s.attempts.find((y) => y.id === x.attemptId).status), ["landed", "working", "landed"]);
	assert.throws(() => trunkFile(w, "b.md"));
});

test("a batch that reached trunk but was not written down is recorded after a restart, each landing once", async (t) => {
	const { w, agents } = await several(t, [{ "a.md": "a\n" }, { "b.md": "b\n" }, { "c.md": "c\n" }]);
	await askAll(w, agents);
	const batch = (await w.state()).batches[0];
	w.project.recordBatch = async () => { throw new Error("the process ended"); };
	await w.finish(`batch:${batch.id}`, "pass");
	await w.settle();
	assert.equal(w.head("p--trunk"), batch.tipSha, "trunk has the batch");
	assert.equal((await w.state()).landings.length, 1, "and none of the three is written down");
	w.restart();
	await w.project.onPush("p--trunk");
	await w.settle({ later: true });
	const s = await w.state();
	assert.deepEqual([s.landings.length, s.attempts.filter((x) => x.status === "landed").length, s.queue.length, s.batches.length, s.project.head], [4, 4, 0, 0, batch.tipSha]);
	assert.equal(new Set(s.landings.map((l) => l.sha)).size, 4);
	assert.equal(w.head("p--trunk"), batch.tipSha);
});

test("two attempts at one intent are not merged in the same batch; the second is superseded when the first lands", async (t) => {
	const { w, intents } = await started(t, ["Mover", "Shared"]);
	const mover = await ready(w, intents[0], "mover", { "moved.md": "m\n" });
	const a = await ready(w, intents[1], "ana", { "a.md": "a\n" }), b = await ready(w, intents[1], "ben", { "b.md": "b\n" });
	await land(w, mover.attemptId);
	await askAll(w, [a, b]);
	const batch = (await w.state()).batches[0];
	assert.deepEqual(batch.members, [a.attemptId]);
	await w.finish(`batch:${batch.id}`, "pass"); await w.settle();
	const s = await w.state();
	assert.deepEqual([s.attempts.find((x) => x.id === a.attemptId).status, s.attempts.find((x) => x.id === b.attemptId).status, s.queue.length, s.batches.length], ["landed", "superseded", 0, 0]);
	assert.throws(() => trunkFile(w, "b.md"));
});

test("a project sets how many landings go in one batch, and \"land now\" goes alone and first", async (t) => {
	const { w, intents } = await started(t, ["One", "Two", "Three", "Four"]);
	const trunk = w.clone("p--trunk", "owner");
	w.push(trunk, { "braid.json": JSON.stringify({ landing: { batch: 2 } }) + "\n" });
	await w.project.onPush("p--trunk"); await w.settle(); await w.finish("trunk", "pass"); await w.settle();
	const agents = [];
	for (const [i, intent] of intents.entries()) agents.push(await ready(w, intent, `agent${i}`, { [`f${i}.md`]: `${i}\n` }));
	await askAll(w, agents.slice(0, 3));
	let s = await w.state();
	assert.deepEqual([s.batches[0].members, s.queue.length], [agents.slice(0, 2).map((a) => a.attemptId), 3]);
	// Forced, the fourth lands at once; trunk has moved, so the batch is built again on top of it.
	await w.project.land(agents[3].attemptId, "rev", true); await w.settle();
	s = await w.state();
	assert.equal(s.attempts.find((x) => x.id === agents[3].attemptId).status, "landed");
	assert.deepEqual([s.batches.length, s.batches[0].trunkSha, s.batches[0].members], [1, w.head("p--trunk"), agents.slice(0, 2).map((a) => a.attemptId)]);
	await w.finish(`batch:${s.batches[0].id}`, "pass"); await w.settle();
	s = await w.state();
	assert.deepEqual(s.batches[0].members, [agents[2].attemptId]);
	await w.finish(`batch:${s.batches[0].id}`, "pass"); await w.settle();
	assert.equal((await w.state()).attempts.filter((x) => x.status === "landed").length, 4);
});

// ── merging without a person ─────────────────────────────────────────────────

const app = (functions) => `const state = {};\n\n${functions.map((f) => `function ${f}() {\n\treturn "${f}";\n}\n\n`).join("")}function render() {}\n`;
/** A project whose trunk has app.js with one function, verified by a run that has checks. */
async function withApp(t, titles, config, env) {
	const { w, intents } = await started(t, titles, env);
	const trunk = w.clone("p--trunk", "owner");
	w.push(trunk, { "app.js": app([]), ...(config ? { "braid.json": JSON.stringify(config) + "\n" } : {}) });
	await w.project.onPush("p--trunk"); await w.settle(); await w.finish("trunk", "pass"); await w.settle();
	return { w, intents };
}

test("two attempts that each add a function at the same place both land, with no reconciliation", async (t) => {
	const { w, intents } = await withApp(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", { "app.js": app(["one"]) }), b = await ready(w, intents[1], "ben", { "app.js": app(["two"]) });
	let s = await w.state();
	assert.deepEqual(s.overlaps.map((o) => [o.path, o.severity]), [["app.js", "touch"]], "seen as the same file, mergeable");
	await askAll(w, [a, b]);
	s = await w.state();
	// The second is merged on top of the first, both additions kept, and that merge is run.
	const batch = s.batches[0];
	assert.deepEqual([batch.members, s.reconciliations.length], [[a.attemptId, b.attemptId], 0]);
	await w.finish(`batch:${batch.id}`, "pass"); await w.settle();
	s = await w.state();
	assert.deepEqual(s.attempts.map((x) => x.status), ["landed", "landed"]);
	assert.equal(trunkFile(w, "app.js"), app(["one", "two"]).trimEnd());
	assert.match(w.git(`${w.root}/p--trunk.git`, "log", "-1", "--format=%B", "refs/heads/main"), /Combined: trunk and this attempt both added lines at the same place in app\.js; both were kept, trunk's first\.\n\nBraid-Intent: 2/);
	assert.match(s.activity.map((x) => x.text).join("\n"), /keeping both sides' additions in app\.js/);
	assert.deepEqual(s.decisions.filter((d) => d.agent === "braid").map((d) => [d.attemptId, d.title, d.files]), [[b.attemptId, "Both sides' additions kept", ["app.js"]]]);
});

test("additions are not combined when nothing would run the result, when the project says no, or for \"land now\"", async (t) => {
	// The project turns it off.
	const off = await withApp(t, ["One", "Two"], { landing: { combine: false } });
	const a = await ready(off.w, off.intents[0], "ana", { "app.js": app(["one"]) }), b = await ready(off.w, off.intents[1], "ben", { "app.js": app(["two"]) });
	assert.deepEqual((await off.w.state()).overlaps.map((o) => o.severity), ["conflict"]);
	await land(off.w, a.attemptId);
	assert.deepEqual((await land(off.w, b.attemptId)).conflict, ["app.js"]);
	// Forced: the merge would land without being run, so it is not made by itself.
	const forced = await withApp(t, ["One", "Two"]);
	const c = await ready(forced.w, forced.intents[0], "cy", { "app.js": app(["one"]) }), d = await ready(forced.w, forced.intents[1], "dee", { "app.js": app(["two"]) });
	await land(forced.w, c.attemptId);
	assert.deepEqual((await land(forced.w, d.attemptId, { force: true })).conflict, ["app.js"]);
});

test("a combined merge that fails its run is refused like any other, and trunk is untouched", async (t) => {
	const { w, intents } = await withApp(t, ["One", "Two"]);
	const a = await ready(w, intents[0], "ana", { "app.js": app(["one"]) }), b = await ready(w, intents[1], "ben", { "app.js": app(["two"]) });
	await land(w, a.attemptId);
	const head = w.head("p--trunk");
	await land(w, b.attemptId);
	await w.finish(await mergeRef(w, b.attemptId), "fail"); await w.settle();
	assert.match((await standing(w, b.attemptId)).refused, /failed verification when merged with trunk/);
	assert.equal(w.head("p--trunk"), head);
});

test("a project can send conflicts to the attempt's agent, then the model, before a person", async (t) => {
	const { w, intents } = await withApp(t, ["One", "Two", "Three"], { landing: { conflicts: "auto" } }, { ANTHROPIC_API_KEY: "k" });
	const a = await ready(w, intents[0], "ana", title("Ana"));
	// An attempt by an agent Braid can run, and one by an agent it does not run. Both started before anything landed.
	const b = await agent(w, intents[1], "claude-code");
	w.db.prepare("UPDATE attempts SET kind = 'claude' WHERE id = ?").run(b.attemptId);
	b.sha = work(w, b, title("Ben")); await w.project.onPush(b.repo); await w.settle(); await w.finish(b.attemptId, "pass"); await w.settle();
	const c = await ready(w, intents[2], "cy", title("Cy"));
	await land(w, a.attemptId);
	// The first conflicts: its agent is brought back to reconcile.
	await land(w, b.attemptId);
	let s = await w.state(), recon = s.reconciliations.find((r) => r.attemptId === b.attemptId);
	assert.deepEqual([recon.status, recon.auto, s.attempts.find((x) => x.id === b.attemptId).hosted], ["open", "agent", "starting"]);
	assert.deepEqual(w.agents.filter((x) => x.what === "start").map((x) => [x.name, x.job.task]), [[`p/${b.attemptId}`, "reconcile"]]);
	// The agent finishes and the conflict is still open: the model is asked. Here it cannot answer, so it is left for a person.
	await w.project.hostedDone(b.attemptId, "finished", "");
	assert.deepEqual([(await w.state()).reconciliations.find((r) => r.attemptId === b.attemptId).auto, (await w.state()).reconciliations.find((r) => r.attemptId === b.attemptId).status], ["model", "resolving"]);
	await w.settle();
	s = await w.state(); recon = s.reconciliations.find((r) => r.attemptId === b.attemptId);
	assert.deepEqual([recon.status, recon.auto, s.outcomes[0].kind, s.outcomes[0].outcome], ["open", "model", "reconcile", "failed"]);
	// Each has had its turn: nothing more is tried until a person acts.
	await w.project.hostedDone(b.attemptId, "finished", ""); await w.settle();
	assert.equal(w.agents.filter((x) => x.what === "start").length, 1);
	// An attempt by an agent Braid does not run goes straight to the model.
	await w.project.land(c.attemptId, "rev");
	for (let i = 0; i < 50 && !(await w.state()).reconciliations.some((r) => r.attemptId === c.attemptId); i++) await w.settle();
	assert.equal((await w.state()).reconciliations.find((r) => r.attemptId === c.attemptId).auto, "model");
});

test("without the setting, a conflict waits for a person and nobody is started", async (t) => {
	const { w, intents } = await withApp(t, ["One", "Two"], null, { ANTHROPIC_API_KEY: "k" });
	const a = await ready(w, intents[0], "ana", title("Ana")), b = await ready(w, intents[1], "ben", title("Ben"));
	await land(w, a.attemptId); await land(w, b.attemptId);
	const s = await w.state();
	assert.deepEqual([s.reconciliations[0].status, s.reconciliations[0].auto, w.agents.length], ["open", null, 0]);
});
