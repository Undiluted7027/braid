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
	const candidate = w.head(b.repo, "braid-candidate");
	assert.deepEqual([w.runs.at(-1).ref, w.runs.at(-1).sha, w.runs.at(-1).branch], [`land:${b.attemptId}`, candidate, "braid-candidate"]);
	await w.finish(`land:${b.attemptId}`, "pass");
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
	await w.finish(`land:${b.attemptId}`, "fail");
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
	await w.finish(`land:${b.attemptId}`, "pass");
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
	await land(w, b.attemptId); await w.finish(`land:${b.attemptId}`, "pass"); await w.settle();
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
	await w.finish(`land:${b.attemptId}`, "pass");
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
	await land(w, b.attemptId); await w.finish(`land:${b.attemptId}`, "fail"); await w.settle();
	assert.match((await standing(w, b.attemptId)).refused, /trunk itself is failing, and this attempt does not fix it/);
	await land(w, c.attemptId); await w.finish(`land:${c.attemptId}`, "pass"); await w.settle();
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
	await land(w, b.attemptId); await w.finish(`land:${b.attemptId}`, "pass"); await w.settle();
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
