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
	assert.deepEqual([held.queued, held.note], ["locking", "regenerating the lockfile from the merged manifest"]);
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

test("a Go project: both sides add a dependency at the same place, go.mod keeps both and go.sum is regenerated in the Go image", async (t) => {
	const { w, intents } = await started(t, ["One", "Two"]);
	const mod = (extra) => `module example.com/tally\n\ngo 1.24\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n${extra})\n`;
	const trunk = w.clone("p--trunk", "owner");
	w.push(trunk, { "go.mod": mod(""), "go.sum": "uuid h1\n", "tally.go": "package tally\n", "package.json": null, "test/app.test.js": null });
	await w.project.onPush("p--trunk"); await w.settle();
	// Trunk is run as Go, in the Go image, and so is everything forked from it.
	assert.deepEqual([w.runs.at(-1).ref, w.runs.at(-1).toolchain, w.runs.at(-1).policy.checks], ["trunk", "go", ["vet", "build", "test"]]);
	await w.finish("trunk", "pass"); await w.settle();
	const a = await ready(w, intents[0], "ana", { "go.mod": mod("\tgithub.com/google/go-cmp v0.7.0\n"), "go.sum": "uuid h1\ncmp h1\n" });
	const b = await ready(w, intents[1], "ben", { "go.mod": mod("\tgithub.com/dustin/go-humanize v1.0.1\n"), "go.sum": "uuid h1\nhumanize h1\n" });
	assert.deepEqual([(await w.state()).runs.find((r) => r.ref === b.attemptId).toolchain, w.runs.at(-1).toolchain], ["go", "go"]);
	await land(w, a.attemptId);
	const held = await land(w, b.attemptId);
	assert.deepEqual([held.queued, held.note], ["locking", "regenerating the lockfile from the merged manifest"]);
	const job = w.runs.at(-1);
	assert.deepEqual([job.ref, job.regenerate, job.toolchain], [`lock:${b.attemptId}`, ["go.sum"], "go"]);
	await w.project.lockfiles(job.runId, { "go.sum": "uuid h1\ncmp h1\nhumanize h1\n" });
	await w.finish(`lock:${b.attemptId}`, "pass"); await w.settle();
	await w.finish(await mergeRef(w, b.attemptId), "pass"); await w.settle();
	assert.ok((await standing(w, b.attemptId)).landed);
	assert.equal(trunkFile(w, "go.sum"), "uuid h1\ncmp h1\nhumanize h1");
	assert.match(trunkFile(w, "go.mod"), /go-cmp v0\.7\.0\n\tgithub\.com\/dustin\/go-humanize v1\.0\.1\n\)/);
	assert.match((await w.state()).reconciliations.at(-1).rationale, /go\.sum was regenerated from the merged go\.mod/);
});

test("a Java project's runs carry the mirror trunk names, and an attempt cannot name another", async (t) => {
	const { w, intents } = await started(t, ["One"]);
	const trunk = w.clone("p--trunk", "owner");
	w.push(trunk, { "pom.xml": "<project/>\n", "package.json": null, "test/app.test.js": null });
	await w.project.onPush("p--trunk"); await w.settle();
	assert.deepEqual([w.runs.at(-1).toolchain, w.runs.at(-1).policy.maven], ["java", { mirror: "https://maven-central.storage-download.googleapis.com/maven2/", hosts: ["maven-central.storage-download.googleapis.com"] }]);
	w.push(trunk, { "braid.json": JSON.stringify({ environment: { maven: "https://repo.acme.example/maven2/" } }) });
	await w.project.onPush("p--trunk"); await w.settle();
	assert.deepEqual(w.runs.at(-1).policy.maven, { mirror: "https://repo.acme.example/maven2/", hosts: ["repo.acme.example"] });
	const a = await agent(w, intents[0], "ana");
	work(w, a, { "braid.json": JSON.stringify({ environment: { maven: "https://elsewhere.example/m2/" } }) }); await w.project.onPush(a.repo); await w.settle();
	assert.deepEqual([w.runs.at(-1).ref, w.runs.at(-1).policy.maven.hosts], [a.attemptId, ["repo.acme.example"]]);
});

test("a commit that brings its own image is run in it only where trunk has allowed images to be built", async (t) => {
	const { w, intents } = await started(t, ["One", "Two", "Three"]);
	const job = (ref) => w.runs.filter((r) => r.ref === ref).at(-1);
	// Trunk has not allowed it. An attempt that asks outright is told so by its run; one with only a devcontainer is run as before.
	const a = await agent(w, intents[0], "ana"), b = await agent(w, intents[1], "ben");
	work(w, a, { "braid.json": JSON.stringify({ environment: { dockerfile: "Dockerfile", internet: "build" } }), Dockerfile: "FROM node:24\n" }); await w.project.onPush(a.repo);
	work(w, b, { ".devcontainer/devcontainer.json": '{ "image": "node:24" }' }); await w.project.onPush(b.repo); await w.settle();
	assert.deepEqual([job(a.attemptId).own.allowed, job(a.attemptId).own.image, job(b.attemptId).own ?? null], [false, { kind: "dockerfile", dockerfile: "Dockerfile", context: "." }, null], "an attempt cannot give itself the Internet");
	assert.deepEqual((await w.state()).attempts.map((x) => x.flags.map((f) => f.kind).filter((k) => k === "environment" || k === "checks")), [["checks", "environment"], ["environment"]]);
	// Trunk allows it. The same attempts are now run in their own images, and so is trunk if it names one.
	const trunk = w.clone("p--trunk", "owner");
	w.push(trunk, { "braid.json": JSON.stringify({ environment: { internet: "build", image: "node:24-slim" } }) });
	await w.project.onPush("p--trunk"); await w.settle();
	assert.deepEqual([job("trunk").own.allowed, job("trunk").own.image, (await w.state()).runs.find((r) => r.ref === "trunk").toolchain], [true, { kind: "image", image: "node:24-slim" }, "node:24-slim"]);
	await w.project.verify(a.attemptId, true); await w.project.verify(b.attemptId, true);
	assert.deepEqual([job(a.attemptId).own.allowed, job(b.attemptId).own.allowed, job(b.attemptId).own.image], [true, true, { kind: "image", image: "node:24" }]);
	// Commits with the same Dockerfile and manifests share one built image; a change to either makes another.
	const c = await agent(w, intents[2], "cy");
	work(w, c, { "braid.json": JSON.stringify({ environment: { dockerfile: "Dockerfile" } }), Dockerfile: "FROM node:24\n", "src.js": "1\n" }); await w.project.onPush(c.repo); await w.settle();
	const first = job(c.attemptId).own.key;
	work(w, c, { "src.js": "2\n" }); await w.project.onPush(c.repo); await w.settle();
	assert.equal(job(c.attemptId).own.key, first);
	work(w, c, { Dockerfile: "FROM node:24\nRUN true\n" }); await w.project.onPush(c.repo); await w.settle();
	assert.notEqual(job(c.attemptId).own.key, first);
	assert.match(first, /^[0-9a-f]{40}$/);
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

// ── review, flags and the landing policy ─────────────────────────────────────

/** A project that reviews attempts with a stand-in reviewer. `answer(input)` is what it says; by default every criterion is met. */
async function reviewed(t, titles, landing, answer) {
	const { w, intents } = await withApp(t, titles, landing ? { landing } : null, { ANTHROPIC_API_KEY: "k" });
	const asked = [];
	const approve = (input) => ({ verdict: "approve", summary: "Does what the intent asks.", concerns: [], changes: "", criteria: input.criteria.map((_, i) => ({ n: i + 1, verdict: "met", basis: "diff", why: "The diff shows it.", evidence: [{ path: input.files[0].path, line: 1 }] })) });
	w.project.reviewer = async (_env, input, pick) => { asked.push({ ...input, pick }); return { ...(answer ? answer(input, approve, asked.length) : approve(input)), model: "stand-in" }; };
	return { w, intents, asked, approve };
}
/** Push, have it read and verified, then have the agent claim what it changed and mark the attempt ready, as a real one would. */
async function finished(w, intent, name, files, { claim = Object.keys(files), status = "pass" } = {}) {
	const a = await agent(w, intent, name);
	if (claim.length) await w.tool(a, "claim", { paths: claim });
	a.sha = work(w, a, files);
	await w.project.onPush(a.repo); await w.settle();
	if (status) { await w.finish(a.attemptId, status); await w.settle(); }
	const said = w.tool(a, "ready", { summary: `${name} is done` });
	await w.settle(); await said; await w.settle();
	return a;
}
const row = async (w, a) => (await w.state()).attempts.find((x) => x.id === a.attemptId);
/** The settings a project had before races: the newer ones have their own tests. */
const old = ({ landing, review, conflicts, reviewers, plan, planner }) => ({ landing, review, conflicts, reviewers, plan, planner });

test("an attempt marked ready is reviewed against the intent's criteria, and the agent can read the review", async (t) => {
	const { w, asked } = await reviewed(t, []);
	const intent = await w.project.createIntent({ title: "Notes", goal: "Add notes.", acceptance: "- There is a notes file\n- It says hello" });
	const a = await finished(w, intent, "ana", { "notes.md": "hello\n" });
	const s = await w.state(), review = s.reviews[0];
	assert.deepEqual([s.intents[0].criteria, old(s.project.policy)], [["There is a notes file", "It says hello"], { landing: "person", review: true, conflicts: "person", reviewers: ["claude-opus-5-5"], plan: true, planner: "claude-opus-5-5" }]);
	assert.deepEqual([review.attemptId, review.sha, review.status, review.verdict, review.by, review.criteria.map((c) => [c.text, c.verdict, c.evidence])],
		[a.attemptId, a.sha, "done", "approve", "stand-in", [["There is a notes file", "met", [{ path: "notes.md", line: 1 }]], ["It says hello", "met", [{ path: "notes.md", line: 1 }]]]]);
	assert.deepEqual(review.criteria.map((c) => c.basis), ["diff", "diff"]);
	// What the reviewer was shown: the criteria, the diff, the check result, and the agent's own decisions only.
	assert.deepEqual([asked.length, asked[0].criteria, asked[0].files.map((f) => f.path), asked[0].run.status], [1, s.intents[0].criteria, ["notes.md"], "pass"]);
	const told = w.tool(a, "checkpoint"); await w.settle();
	assert.deepEqual((await told).review.criteria.map((c) => [c.n, c.verdict]), [[1, "met"], [2, "met"]]);
	// Nothing lands by itself unless the project asks for that.
	assert.deepEqual([(await row(w, a)).status, s.queue.length, (await row(w, a)).held], ["ready", 0, ""]);
	assert.match(s.attempts[0].flags.map((f) => f.kind).join(), /^$/);
});

test("with the policy on, an attempt that is ready, passes, is approved and has nothing flagged lands by itself", async (t) => {
	const { w, intents } = await reviewed(t, ["One"], { policy: "auto" });
	const a = await finished(w, intents[0], "ana", { "notes.md": "hello\n" });
	const s = await w.state();
	assert.deepEqual([(await row(w, a)).status, s.landings.length, s.outcomes[0].by, s.outcomes[0].outcome], ["landed", 1, "policy", "landed"]);
	assert.match(s.activity.map((x) => x.text).join("\n"), /Landing attempt 1\.1 by this project's policy: its checks passed, stand-in found every criterion met, and nothing is flagged/);
	const message = w.git(`${w.root}/p--trunk.git`, "log", "-1", "--format=%B", "refs/heads/main");
	assert.match(message, /Reviewed by stand-in: every criterion met\. Does what the intent asks\./);
	assert.match(message, /Braid-Agent: ana\nBraid-Reviewed-By: stand-in/);
});

test("the policy waits for checks and for the review, and a failed check or review stops it with the reason", async (t) => {
	const { w, intents } = await reviewed(t, ["One", "Two"], { policy: "auto" }, (input, approve, n) => { if (n === 2) throw new Error("[502] the model declined to review this attempt"); return approve(input); });
	const a = await finished(w, intents[0], "ana", { "a.md": "a\n" }, { status: null });
	assert.deepEqual([(await row(w, a)).status, (await row(w, a)).held, (await row(w, a)).heldFor], ["ready", "Waiting for its checks.", "checks"]);
	await w.finish(a.attemptId, "fail"); await w.settle();
	assert.deepEqual([(await row(w, a)).status, (await row(w, a)).held], ["ready", "Its checks failed (test)."]);
	const b = await finished(w, intents[1], "ben", { "b.md": "b\n" });
	const s = await w.state();
	assert.deepEqual([(await row(w, b)).status, (await row(w, b)).held, s.reviews.find((r) => r.attemptId === b.attemptId).status], ["ready", "It could not be reviewed: the model declined to review this attempt", "failed"]);
	// A person asks for the review again; this time it is made, and the attempt lands.
	await w.project.review(b.attemptId); await w.settle();
	assert.equal((await row(w, b)).status, "landed");
});

test("a flag always needs a person, whatever the review says", async (t) => {
	const { w, intents } = await reviewed(t, ["Change the test", "Loosen the checks", "Wander"], { policy: "auto" });
	const a = await finished(w, intents[0], "ana", { "test/app.test.js": "// rewritten\n" });
	const b = await finished(w, intents[1], "ben", { "package.json": JSON.stringify({ name: "tally", private: true, scripts: { test: "true" } }, null, "\t") + "\n" });
	const c = await finished(w, intents[2], "cy", { "c.md": "c\n", "README.md": "also this\n" }, { claim: ["c.md"] });
	const s = await w.state(), of = (x) => s.attempts.find((y) => y.id === x.attemptId);
	assert.deepEqual([a, b, c].map((x) => [of(x).status, of(x).flags.map((f) => f.kind)]), [["ready", ["tests-changed"]], ["ready", ["checks"]], ["ready", ["outside-claims"]]]);
	assert.match(of(b).flags[0].text, /Changed or removed the package\.json script test/);
	assert.match(of(a).held, /^Flagged for a person: changed tests that were already there\.$/);
	assert.deepEqual([a, b, c].map((x) => of(x).heldFor), ["flags", "flags", "flags"]);
	assert.deepEqual([s.reviews.map((r) => r.verdict), s.landings.length], [["approve", "approve", "approve"], 0]);
	// A person can still land it.
	assert.ok((await land(w, c.attemptId)).landed);
});

test("history pushed over and destructive commands in the session are flagged", async (t) => {
	const { w, intents } = await reviewed(t, ["One"], { policy: "auto" });
	const a = await agent(w, intents[0], "ana");
	await w.tool(a, "claim", { paths: ["a.md"] });
	work(w, a, { "a.md": "one\n" }); await w.project.onPush(a.repo); await w.settle();
	w.git(a.dir, "commit", "--quiet", "--amend", "-m", "rewritten"); w.git(a.dir, "push", "--quiet", "--force", "origin", "HEAD:main");
	await w.project.ingest(a.agentToken, [{ kind: "tool", tool: "Bash", text: "git push --force origin HEAD:main" }]);
	await w.project.onPush(a.repo); await w.settle();
	assert.deepEqual((await row(w, a)).flags.map((f) => f.kind), ["history", "destructive"]);
});

test("when the reviewer asks for changes the attempt is sent back with them, twice at most, then it waits for a person", async (t) => {
	const { w, intents, asked } = await reviewed(t, ["One"], { policy: "auto" }, (input, approve) => ({ ...approve(input), verdict: "changes", changes: "Say hello in the notes.", criteria: [{ n: 1, verdict: "not_met", basis: "diff", why: "No greeting.", evidence: [] }] }));
	const a = await finished(w, intents[0], "ana", { "notes.md": "one\n" });
	let s = await w.state();
	assert.deepEqual([(await row(w, a)).status, s.decisions.filter((d) => d.kind === "feedback").map((d) => [d.agent, d.body])], ["working", [["reviewer", "Say hello in the notes."]]]);
	const heard = w.tool(a, "brief"); await w.settle();
	assert.ok((await heard).heads_up.some((h) => h.kind === "feedback" && h.from === "reviewer" && h.body === "Say hello in the notes."));
	// It is told who sent it back, and to claim what it goes on to change: an unclaimed change is flagged and would stop it landing by itself.
	assert.match((await heard).heads_up.find((h) => h.kind === "feedback").note, /^The project's reviewer read your attempt and sent it back\. .*`claim` any file you will change that you have not claimed/);
	for (const text of ["two\n", "three\n"]) {
		a.sha = work(w, a, { "notes.md": text }); await w.project.onPush(a.repo); await w.settle(); await w.finish(a.attemptId, "pass"); await w.settle();
		const said = w.tool(a, "ready", { summary: "again" }); await w.settle(); await said; await w.settle();
	}
	s = await w.state();
	assert.deepEqual([asked.length, s.decisions.filter((d) => d.kind === "feedback").length, (await row(w, a)).status, (await row(w, a)).held], [3, 2, "ready", "The reviewer asked for changes twice and is still not satisfied."]);
});

test("the reviewer leaving it to a person, or approving with a criterion not shown, holds the attempt with the reason", async (t) => {
	const { w, intents } = await reviewed(t, [], { policy: "auto" }, (input, approve) => ({ ...approve(input), criteria: [approve(input).criteria[0], { n: 2, verdict: "met", basis: "diff", why: "I am sure it does.", evidence: [] }] }));
	const intent = await w.project.createIntent({ title: "Notes", goal: "Add notes.", acceptance: "There is a notes file\nIt survives a reload" });
	const a = await finished(w, intent, "ana", { "notes.md": "hello\n" });
	const s = await w.state();
	assert.deepEqual([s.reviews[0].verdict, s.reviews[0].criteria.map((c) => c.verdict), (await row(w, a)).status], ["person", ["met", "unclear"], "ready"]);
	assert.match((await row(w, a)).held, /^The reviewer left it to a person: "It survives a reload" is not shown to be met\. I am sure it does\.$/);
});

test("a landing the policy asked for that is refused is not asked for again, and says why", async (t) => {
	const { w, intents } = await reviewed(t, ["Mover", "One"], { policy: "auto" });
	// Both start from the same trunk; the first lands, so the second has to be merged and its merge run.
	const b = await agent(w, intents[1], "ben");
	const a = await finished(w, intents[0], "ana", { "a.md": "a\n" });
	assert.equal((await row(w, a)).status, "landed");
	await w.tool(b, "claim", { paths: ["b.md"] });
	b.sha = work(w, b, { "b.md": "b\n" }); await w.project.onPush(b.repo); await w.settle(); await w.finish(b.attemptId, "pass"); await w.settle();
	const said = w.tool(b, "ready", { summary: "done" }); await w.settle(); await said; await w.settle();
	assert.equal((await standing(w, b.attemptId)).queued, "verifying");
	await w.finish(await mergeRef(w, b.attemptId), "fail"); await w.settle();
	const s = await w.state();
	assert.deepEqual([(await row(w, b)).status, s.queue.length, s.outcomes.filter((o) => o.attemptId === b.attemptId).map((o) => [o.by, o.outcome])], ["ready", 0, [["policy", "refused"]]]);
	assert.match((await row(w, b)).held, /^Its landing was refused: attempt 2\.1 passes on its own but failed verification when merged with trunk/);
});

test("a commit pushed to a ready attempt is reviewed again, and a project can turn reviews off", async (t) => {
	const { w, intents, asked } = await reviewed(t, ["One", "Two"]);
	const a = await finished(w, intents[0], "ana", { "a.md": "a\n" });
	a.sha = work(w, a, { "a.md": "a again\n" }); await w.project.onPush(a.repo); await w.settle();
	assert.equal(asked.length, 1, "the review waits for the new commit's checks");
	await w.finish(a.attemptId, "pass"); await w.settle();
	assert.deepEqual([asked.length, (await w.state()).reviews[0].sha], [2, a.sha]);
	await w.project.setReview(false);
	await finished(w, intents[1], "ben", { "b.md": "b\n" });
	assert.deepEqual([asked.length, (await w.state()).project.policy.review], [2, false]);
});

test("without a model to review with, nothing is reviewed and a project that lands by itself says a person must", async (t) => {
	const { w, intents } = await withApp(t, ["One"], { landing: { policy: "auto" } });
	const a = await finished(w, intents[0], "ana", { "a.md": "a\n" });
	const s = await w.state();
	assert.deepEqual([s.reviews.length, old(s.project.policy), (await row(w, a)).status, (await row(w, a)).held], [0, { landing: "auto", review: false, conflicts: "person", reviewers: [], plan: false, planner: null }, "ready", "This instance has no model to review with, so a person lands it."]);
});

test("a criterion about the checks is met by the checks having passed, not by the reviewer saying so", async (t) => {
	const answer = (input, approve) => ({ ...approve(input), criteria: [approve(input).criteria[0], { n: 2, verdict: "met", basis: "checks", why: "The checks pass.", evidence: [] }] });
	const { w } = await reviewed(t, [], { policy: "auto" }, answer);
	const make = () => w.project.createIntent({ title: "Notes", goal: "Add notes.", acceptance: "There is a notes file\nThe existing tests still pass" });
	// Checks passed: the criterion is met on that basis and the attempt lands.
	const a = await finished(w, await make(), "ana", { "a.md": "a\n" });
	const s = await w.state();
	assert.deepEqual([s.reviews[0].criteria.map((c) => [c.verdict, c.basis]), (await row(w, a)).status], [[["met", "diff"], ["met", "checks"]], "landed"]);
});

test("an attempt is reviewed by a model from a different maker than its agent, unless the project names one", async (t) => {
	const { reviewerFor, reviewers } = await import("../src/worker/reviewer.ts");
	const both = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
	assert.deepEqual(reviewers(both).map((r) => r.provider), ["claude", "openai"]);
	assert.deepEqual([reviewerFor(both, "claude").provider, reviewerFor(both, "codex").provider, reviewerFor(both, "agent").provider], ["openai", "claude", "claude"]);
	assert.deepEqual([reviewerFor(both, "claude", "claude").provider, reviewerFor(both, "codex", "openai").provider], ["claude", "openai"]);
	// With one provider there is no choice; with none there is no review.
	assert.deepEqual([reviewerFor({ ANTHROPIC_API_KEY: "a" }, "claude").provider, reviewerFor({ OPENAI_API_KEY: "o" }, "codex").provider, reviewerFor({}, "claude"), reviewerFor({ AI: {} }, "claude")], ["claude", "openai", null, null]);
	// And the project object hands that choice to the reviewer.
	const { w, intents, asked } = await reviewed(t, ["One", "Two"]);
	w.project.env.OPENAI_API_KEY = "o";
	const a = await agent(w, intents[0], "claude-code"), b = await agent(w, intents[1], "codex");
	w.db.prepare("UPDATE attempts SET kind = 'claude' WHERE id = ?").run(a.attemptId); w.db.prepare("UPDATE attempts SET kind = 'codex' WHERE id = ?").run(b.attemptId);
	for (const x of [a, b]) {
		await w.tool(x, "claim", { paths: ["x.md", "y.md"] });
		x.sha = work(w, x, { [x === a ? "x.md" : "y.md"]: "x\n" }); await w.project.onPush(x.repo); await w.settle(); await w.finish(x.attemptId, "pass"); await w.settle();
		const said = w.tool(x, "ready", { summary: "done" }); await w.settle(); await said; await w.settle();
	}
	assert.deepEqual(asked.map((i) => [i.agent, i.pick.provider]), [["claude-code", "openai"], ["codex", "claude"]]);
});

// ── racing: several attempts at one intent, compared ─────────────────────────

/**
 * A project that reviews with a stand-in, and compares with stand-in judges. `says` maps a judge's model name to the
 * letter it picks (or a function of what it was shown). `signal(input)` stands in for the decision model.
 */
async function racing(t, { config = { landing: { policy: "auto" } }, says = { one: "A", two: "A" }, signal, titles = ["Shared"] } = {}) {
	const { w, intents } = await withApp(t, titles, config, { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" });
	w.project.reviewer = async (_env, input) => ({ verdict: "approve", summary: "Does what the intent asks.", concerns: [], changes: "", model: "stand-in",
		criteria: input.criteria.map((_, i) => ({ n: i + 1, verdict: "met", basis: "diff", why: "The diff shows it.", evidence: [{ path: input.files[0].path, line: 1 }] })) });
	const shown = [];
	w.project.judgesFor = () => Object.keys(says).map((model, i) => ({ provider: i ? "openai" : "claude", model }));
	w.project.judge = async (_env, input, who, turn) => {
		shown.push({ who: who.model, turn, input });
		const pick = typeof says[who.model] === "function" ? says[who.model](input) : says[who.model];
		if (pick === "fail") throw new Error("[502] the model answered 529");
		const letters = input.entrants.map((_, i) => String.fromCharCode(65 + i));
		return { model: who.model, pick, ranking: [pick, ...letters.filter((l) => l !== pick)], why: `Attempt ${pick} meets the criteria more plainly than attempts ${letters.join(" and ")} together.`, differences: "One writes a file, the other another.",
			attempts: letters.map((l) => ({ letter: l, strengths: `strong ${l}`, weaknesses: `weak ${l}`, keep: l === pick ? "" : "its file name" })) };
	};
	if (signal) { w.project.signaller = async (_env, input) => { const p = signal(input); return input.criteria.map(() => p); }; }
	return { w, intents, shown };
}
/** Push, have it verified, and mark ready: what `finished` does for an attempt that was started earlier. */
async function complete(w, a, files) {
	await w.tool(a, "claim", { paths: Object.keys(files) });
	a.sha = work(w, a, files); await w.project.onPush(a.repo); await w.settle(); await w.finish(a.attemptId, "pass"); await w.settle();
	const said = w.tool(a, "ready", { summary: `${a.name} is done` }); await w.settle(); await said; await w.settle();
	return a;
}
/** Two attempts at one intent, both finished: ana's is 1.1 (the judges' A) and ben's 1.2 (their B). */
async function pair(w, intent) {
	const a = await agent(w, intent, "ana"), b = await agent(w, intent, "ben");
	await complete(w, a, { "a.md": "a\n" });
	await complete(w, b, { "b.md": "b\n" });
	return { a, b };
}
const comparison = async (w) => (await w.state()).comparisons.at(-1);

test("two attempts at one intent are compared when both are ready; with the policy on, the one both judges pick lands and the why says so", async (t) => {
	const { w, intents, shown } = await racing(t);
	const a = await agent(w, intents[0], "ana"), b = await agent(w, intents[0], "ben");
	await complete(w, a, { "a.md": "a\n" });
	// One is ready and the other still working: it waits, and the intent says until when.
	let s = await w.state();
	assert.deepEqual([(await row(w, a)).heldFor, s.comparisons.length, s.intents[0].raceUntil > Date.now() + 29 * 60_000], ["race", 0, true]);
	assert.match((await row(w, a)).held, /Waiting for the other attempts at this intent/);
	await complete(w, b, { "b.md": "b\n" });
	const c = await comparison(w);
	assert.deepEqual([c.status, c.pick, c.agreed, c.attempts.map((x) => x.id), c.left, c.judges.map((j) => [j.by, j.pick, j.ranking])],
		["done", "1.1", true, ["1.1", "1.2"], [], [["one", "1.1", ["1.1", "1.2"]], ["two", "1.1", ["1.1", "1.2"]]]]);
	// What code measured, with no model.
	assert.deepEqual(c.facts.map((f) => [f.attemptId, f.checks, f.files, f.added, f.removed, f.only, f.review, f.met]), [["1.1", "pass", 1, 1, 0, ["a.md"], "approve", 1], ["1.2", "pass", 1, 1, 0, ["b.md"], "approve", 1]]);
	// The judges saw letters, not who made what, and each read the attempts in a different order.
	assert.deepEqual(shown.map((x) => [x.who, x.turn]), [["one", 0], ["two", 1]]);
	const { judgePrompt } = await import("../src/worker/race.ts");
	const text = judgePrompt(shown[0].input, [1, 0]);
	assert.ok(!/ana|ben/.test(text.replace(/ana is done|ben is done/g, "")) && text.indexOf('letter="B"') < text.indexOf('letter="A"'), "no agent names, and the order asked for");
	// The pick landed by the policy; the other was set aside; why this one is in the record and in the commit.
	s = await w.state();
	assert.deepEqual([(await row(w, a)).status, (await row(w, b)).status, s.intents[0].status], ["landed", "superseded", "landed"]);
	const why = s.decisions.find((d) => d.title === "Chosen over attempt 1.2");
	assert.deepEqual([why.attemptId, why.agent, why.kind], ["1.1", "braid", "decision"]);
	assert.match(why.body, /Landed by this project's policy\. one and two picked it\. Attempt 1\.1 meets the criteria more plainly than attempts 1\.1 and 1\.2 together\./);
	assert.match(w.git(`${w.root}/p--trunk.git`, "log", "-1", "--format=%B", "refs/heads/main"), /Chosen over attempt 1\.2: one and two picked it\./);
});

test("judges that disagree leave the choice to a person, and what the person chose against is recorded", async (t) => {
	const { w, intents } = await racing(t, { says: { one: "A", two: "B" } });
	const { a, b } = await pair(w, intents[0]);
	const c = await comparison(w);
	assert.deepEqual([c.pick, c.agreed, c.judges.map((j) => j.pick)], [null, false, ["1.1", "1.2"]]);
	assert.deepEqual([(await row(w, a)).heldFor, (await row(w, b)).heldFor, (await row(w, a)).status], ["choice", "choice", "ready"]);
	assert.match((await row(w, a)).held, /The judges did not agree \(one: 1\.1, two: 1\.2\): a person chooses\./);
	await land(w, b.attemptId); await w.settle();
	const s = await w.state();
	assert.deepEqual([(await row(w, b)).status, (await row(w, a)).status], ["landed", "superseded"]);
	assert.match(s.decisions.find((d) => d.title === "Chosen over attempt 1.1").body, /rev landed it\. two picked it \(one picked 1\.1\)\./);
});

test("one judge alone recommends and does not land; a judge that fails is said so, and comparing can be asked for again", async (t) => {
	const { w, intents } = await racing(t, { says: { one: "B", two: "fail" } });
	const { a, b } = await pair(w, intents[0]);
	let c = await comparison(w);
	assert.deepEqual([c.status, c.pick, c.agreed, c.judges.map((j) => [j.by, j.pick, j.error])], ["done", "1.2", false, [["one", "1.2", null], ["two", null, "the model answered 529"]]]);
	assert.match((await row(w, b)).held, /one recommends this attempt, and one judge alone does not land it: a person chooses\./);
	assert.match((await row(w, a)).held, /The judges preferred attempt 1\.2\./);
	// Both fail: the comparison failed, and a person can ask again.
	w.project.judge = async () => { throw new Error("[502] the model answered 529"); };
	await w.project.compare(intents[0].id); await w.settle();
	c = await comparison(w);
	assert.deepEqual([c.status, c.error, (await row(w, a)).heldFor], ["failed", "the model answered 529", "choice"]);
	await assert.rejects(w.project.compare(99), /needs at least two attempts/);
});

test("the decision model reads every push, and can stop the policy landing a pick it is not convinced by", async (t) => {
	const read = [];
	const { w, intents } = await racing(t, { signal: (input) => { read.push(input); return /a\.md/.test(input.patch) ? 0.6 : 0.97; } });
	const a = await agent(w, intents[0], "ana");
	await w.tool(a, "claim", { paths: ["a.md"] });
	a.sha = work(w, a, { "a.md": "a\n" }); await w.project.onPush(a.repo); await w.settle();
	// Asked while the attempt is still being worked on, with the intent, its criteria and the diff.
	let s = await w.state();
	assert.deepEqual([s.project.policy.signal, s.project.policy.likelihood, s.likelihoods.map((l) => [l.attemptId, l.sha, l.criteria])], ["stand-in", 0.9, [["1.1", a.sha, [{ text: "Shared.", p: 0.6 }]]]]);
	assert.deepEqual([read.length, read[0].criteria, /^### added a\.md/.test(read[0].patch)], [1, ["Shared."], true]);
	await w.finish(a.attemptId, "pass"); await w.settle();
	const b = await agent(w, intents[0], "ben");
	const said = w.tool(a, "ready", { summary: "ana is done" }); await w.settle(); await said; await w.settle();
	await complete(w, b, { "b.md": "b\n" });
	// Both judges pick A, which is ana's.
	assert.deepEqual([(await comparison(w)).pick, (await comparison(w)).agreed], ["1.1", true]);
	assert.deepEqual([(await row(w, a)).status, (await row(w, a)).heldFor], ["ready", "signal"]);
	assert.match((await row(w, a)).held, /Picked by the judges, but stand-in gives "Shared\." 60%, under this project's bar of 90%: a person chooses\./);
	assert.equal((await row(w, b)).heldFor, "choice");
});

test("the bar the decision model must clear is a setting, and so is turning the model off", async (t) => {
	for (const [config, lands] of [[{ landing: { policy: "auto", likelihood: 0.5 } }, true], [{ landing: { policy: "auto" }, signal: false }, true], [{ landing: { policy: "auto", likelihood: 0.99 } }, false]]) {
		const { w, intents } = await racing(t, { config, signal: () => 0.6 });
		const { a } = await pair(w, intents[0]);
		const s = await w.state();
		assert.deepEqual([(await row(w, a)).status === "landed", s.project.policy.signal, s.likelihoods.length > 0], [lands, config.signal === false ? null : "stand-in", config.signal !== false], JSON.stringify(config));
	}
});

test("when the wait for the others runs out, the attempt that is ready is taken alone and the rest are named as left out", async (t) => {
	const { w, intents, shown } = await racing(t, { config: { landing: { policy: "auto" }, race: { wait: 0 } } });
	const b = await agent(w, intents[0], "ben");
	const a = await finished(w, intents[0], "ana", { "a.md": "a\n" });
	const c = await comparison(w), s = await w.state();
	assert.deepEqual([c.status, c.pick, c.agreed, c.attempts.map((x) => x.id), c.left, c.judges, shown.length, s.project.policy.race.wait], ["done", "1.2", true, ["1.2"], ["1.1"], [], 0, 0]);
	assert.match(s.activity.map((x) => x.text).join("\n"), /Attempt 1\.2 was the only one at I1 ready when the wait for the others ran out/);
	assert.deepEqual([(await row(w, a)).status, (await row(w, b)).status], ["landed", "superseded"]);
	await assert.rejects(w.tool(b, "checkpoint"), /is superseded and takes no more tool calls/);
});

test("a hosted agent that has gone without finishing is not waited for", async (t) => {
	const { w, intents } = await racing(t);
	const { attemptId: gone } = await w.project.hostAgent(intents[0].id, "claude"); await w.settle();
	const a = await finished(w, intents[0], "ana", { "a.md": "a\n" });
	assert.deepEqual([(await row(w, a)).heldFor, (await w.state()).comparisons.length], ["race", 0]);
	await w.project.hostedDone(gone, "failed", "it ran out of turns"); await w.settle();
	const c = await comparison(w);
	assert.deepEqual([c.attempts.map((x) => x.id), c.left, (await row(w, a)).status], [["1.2"], ["1.1"], "landed"]);
});

test("a comparison is about the commits it read: when one attempt moves, they are compared again", async (t) => {
	const { w, intents, shown } = await racing(t, { config: {}, says: { one: "A", two: "A" } });
	const { a, b } = await pair(w, intents[0]);
	const first = await comparison(w);
	assert.deepEqual([shown.length, first.pick, (await row(w, a)).held, (await row(w, b)).status], [2, "1.1", "", "ready"], "nothing lands or is held where a person lands");
	a.sha = work(w, a, { "a.md": "a, again\n" }); await w.project.onPush(a.repo); await w.settle(); await w.finish(a.attemptId, "pass"); await w.settle();
	const second = await comparison(w);
	assert.deepEqual([shown.length, second.id > first.id, second.attempts.find((x) => x.id === a.attemptId).sha], [4, true, a.sha]);
	// Asked for nothing new, nothing is compared again.
	await w.project.review(a.attemptId); await w.settle();
	assert.equal(shown.length, 4);
});

test("attempts at one intent do not see each other, and what a person answers one is told to all", async (t) => {
	const { w, intents } = await racing(t, { config: {}, titles: ["Shared", "Other"] });
	const a = await agent(w, intents[0], "ana"), b = await agent(w, intents[0], "ben"), c = await agent(w, intents[1], "cy");
	await w.tool(a, "claim", { paths: ["a.md"] });
	a.sha = work(w, a, { "a.md": "a\n" }); await w.project.onPush(a.repo); await w.settle();
	await w.tool(a, "record", { kind: "decision", title: "Use a file", body: "Simplest thing." });
	const brief = await w.tool(b, "brief");
	assert.match(brief.brief, /\*\*Another agent is attempting this same intent, independently of you\.\*\*/);
	const [rival, other] = [brief.others.find((o) => o.attempt === a.attemptId), brief.others.find((o) => o.attempt === c.attemptId)];
	assert.deepEqual([Object.keys(rival).sort(), rival.same_intent_as_you, other.same_intent_as_you, "claims" in other], [["attempt", "note", "same_intent_as_you", "status"], true, false, true]);
	await assert.rejects(w.tool(b, "peek", { attempt: a.attemptId }), /another attempt at your own intent/);
	await assert.rejects(w.tool(b, "message", { to: a.attemptId, body: "what are you doing?" }), /another attempt at your own intent/);
	assert.deepEqual((await w.tool(b, "message", { to: "all", body: "hello" })).delivered_to, [c.attemptId]);
	assert.equal((await w.tool(c, "peek", { attempt: a.attemptId })).claims[0], "a.md", "an attempt at another intent may still look");
	// ana asks; the answer reaches ben too, now and in the brief of whoever starts later.
	await w.tool(a, "record", { kind: "question", title: "Markdown or text?" });
	const q = (await w.state()).decisions.find((d) => d.kind === "question");
	await w.project.respond(a.attemptId, { kind: "answer", question: q.id, body: "Markdown.", by: "sam" });
	const heard = (await w.tool(b, "checkpoint")).heads_up.find((h) => h.kind === "answer");
	assert.deepEqual([heard.question, heard.body, /applies to your attempt too/.test(heard.note)], ["Markdown or text?", "Markdown.", true]);
	const late = await agent(w, intents[0], "di");
	assert.match(late.brief, /sam, answering "Markdown or text\?" \(asked by another attempt at this intent\): Markdown\./);
	assert.match(late.brief, /\*\*2 other agents are attempting this same intent/);
});

test("a race starts several hosted agents on one intent, each on the model asked for, within the limit", async (t) => {
	const { w, intents } = await racing(t, { config: { race: { agents: [{ kind: "claude", model: "claude-opus-5-5" }, "codex"] } } });
	await w.settle();
	assert.deepEqual((await w.state()).project.policy.race, { agents: [{ kind: "claude", model: "claude-opus-5-5" }, { kind: "codex", model: null }], wait: 30 });
	const { attempts } = await w.project.race(intents[0].id, undefined, "sam"); await w.settle();
	assert.deepEqual([attempts, w.agents.filter((x) => x.what === "start").map((x) => [x.job.attemptId, x.job.kind, x.job.model ?? null])], [["1.1", "1.2"], [["1.1", "claude", "claude-opus-5-5"], ["1.2", "codex", null]]]);
	assert.match((await w.state()).activity.map((x) => x.text).join("\n"), /sam started a race on I1: claude-code on claude-opus-5-5 against codex/);
	assert.match(w.agents[0].job.brief, /Another agent is attempting this same intent/);
	// Named agents, and the limit on how many run at once.
	await assert.rejects(w.project.race(intents[0].id, [{ kind: "claude", model: "not a model" }]), /is not a model name/);
	await assert.rejects(w.project.race(intents[0].id, ["claude", "codex", "claude", "codex", "claude"]), /past the limit of 6/);
	await w.project.race(intents[0].id, [{ kind: "codex", model: "gpt-6.1-sol" }]); await w.settle();
	assert.deepEqual(w.agents.filter((x) => x.what === "start").at(-1).job.model, "gpt-6.1-sol");
});

test("one attempt can be read against another at the same intent", async (t) => {
	const { w, intents } = await racing(t, { config: {}, titles: ["Shared", "Other"] });
	const a = await agent(w, intents[0], "ana"), b = await agent(w, intents[0], "ben"), c = await agent(w, intents[1], "cy");
	a.sha = work(w, a, { "app.js": app(["one"]), "a.md": "a\n" }); await w.project.onPush(a.repo);
	b.sha = work(w, b, { "app.js": app(["two"]) }); await w.project.onPush(b.repo); await w.settle();
	const diff = await w.project.against(a.attemptId, b.attemptId);
	assert.deepEqual(diff.map((f) => [f.path, f.status, f.base, f.head]), [["a.md", "added", null, "a\n"], ["app.js", "modified", app(["two"]), app(["one"])]]);
	assert.deepEqual((await w.project.against(b.attemptId, a.attemptId)).map((f) => [f.path, f.status]), [["a.md", "deleted"], ["app.js", "modified"]]);
	await assert.rejects(w.project.against(a.attemptId, c.attemptId), /different intents/);
});

test("pictures are taken of the previews of attempts being compared, kept, and shown to the judges", async (t) => {
	const { w, intents, shown } = await racing(t, { config: {} });
	const asked = [];
	w.project.shooter = async (url) => { asked.push(url); if (/1\.2/.test(url)) throw new Error("the preview answered 404"); return new Uint8Array([0xff, 0xd8, 1, 2, 3]); };
	await w.project.state("http://braid.test");
	const { a, b } = await pair(w, intents[0]);
	const s = await w.state();
	assert.deepEqual([s.shots.map((x) => [x.attemptId, x.sha]), [...new Set(asked)].sort()], [[[a.attemptId, a.sha]], ["http://braid.test/preview/p/1.1/", "http://braid.test/preview/p/1.2/"]]);
	assert.deepEqual([[...(await w.project.shot(a.attemptId)).bytes], await w.project.shot(b.attemptId)], [[0xff, 0xd8, 1, 2, 3], null]);
	// A page that could not be pictured is not tried again for the same commit.
	assert.equal(asked.filter((u) => /1\.2/.test(u)).length, 1);
	assert.deepEqual(shown[0].input.entrants.map((e) => [e.attempt.id, e.shot && e.shot.mime, e.shot && e.shot.base64]), [["1.1", "image/jpeg", "/9gBAgM="], ["1.2", null, null]]);
});

test("the lines a reviewer cites are looked at by the decision model, and what it makes of them is kept beside the citation", async (t) => {
	const { w, intents } = await racing(t, { config: {}, signal: () => 0.95 });
	const cited = [];
	w.project.supporter = async (_env, list) => { cited.push(...list); return list.map(() => 0.31); };
	const a = await finished(w, intents[0], "ana", { "a.md": "one\ntwo\nthree\nfour\nfive\nsix\n" });
	const review = (await w.state()).reviews[0];
	assert.deepEqual([cited, review.verdict, review.criteria[0].verdict, review.criteria[0].evidence], [[{ claim: "Shared.", passage: "one\ntwo\nthree\nfour" }], "approve", "met", [{ path: "a.md", line: 1, support: 0.31 }]]);
	assert.equal((await row(w, a)).status, "ready");
});

// ── planning: how intents stand to each other before anyone works on them ────

/** A project whose planner is a stand-in: `says(input)` returns the relations it finds for the intent it is shown. */
async function planned(t, says, landing) {
	const { w } = await withApp(t, [], landing ? { landing } : null, { ANTHROPIC_API_KEY: "k" });
	const shown = [];
	w.project.planner = async (_env, input) => { shown.push(input); return { relations: says ? says(input) : [], model: "stand-in" }; };
	w.project.reviewer = async (_env, input) => ({ verdict: "approve", summary: "Fine.", concerns: [], changes: "", model: "stand-in", criteria: input.criteria.map((_, i) => ({ n: i + 1, verdict: "met", basis: "diff", why: "Shown.", evidence: [{ path: input.files[0].path, line: 1 }] })) });
	const open = async (title, acceptance = "") => { const i = await w.project.createIntent({ title, goal: `${title}.`, acceptance }); await w.settle(); return i; };
	return { w, shown, open };
}
const clash = (other) => ({ other, kind: "contradicts", why: "They set the accent colour to different values.", mine: [1], theirs: [1] });
const needs = (other) => ({ other, kind: "depends_on", why: "It restyles the button that intent adds.", mine: [], theirs: [] });

test("an intent is looked at next to the others when it is opened, and a contradiction is recorded on both", async (t) => {
	const { w, shown, open } = await planned(t, (input) => (input.intent.title === "Blue accent" ? [clash(1)] : []));
	const red = await open("Red accent", "The accent colour is red");
	assert.equal(shown.length, 0, "with nothing to stand next to, the planner is not asked");
	const blue = await open("Blue accent", "The accent colour is blue");
	const s = await w.state();
	assert.deepEqual([shown.length, shown[0].intent.id, shown[0].others.map((o) => [o.id, o.status, o.criteria])], [1, blue.id, [[red.id, "open", ["The accent colour is red"]]]]);
	assert.deepEqual(s.relations.map((r) => [r.kind, r.from, r.to, r.fromCriteria, r.toCriteria, r.by, r.source]), [["contradicts", blue.id, red.id, [1], [1], "stand-in", "planner"]]);
	assert.match(s.activity.map((x) => x.text).join("\n"), /I2 "Blue accent" contradicts I1 "Red accent": They set the accent colour to different values\./);
	// An agent that joins either is told in its brief, before it writes a line.
	const a = await agent(w, red, "ana");
	assert.match(a.brief, /## How this intent stands with the others\n- It CONTRADICTS I2 "Blue accent": They set the accent colour to different values\./);
});

test("a contradiction found while agents are working reaches them, and the policy leaves both to a person", async (t) => {
	const { w, open } = await planned(t, (input) => (input.intent.title === "Blue accent" ? [clash(1)] : []), { policy: "auto" });
	const red = await open("Red accent", "The accent colour is red");
	const a = await agent(w, red, "ana");
	const blue = await open("Blue accent", "The accent colour is blue");
	const heard = w.tool(a, "brief"); await w.settle();
	assert.deepEqual((await heard).heads_up.filter((h) => h.kind === "plan").map((h) => [h.with, h.why]), [["I2: Blue accent", "They set the accent colour to different values."]]);
	const b = await finished(w, blue, "ben", { "blue.md": "blue\n" });
	assert.deepEqual([(await row(w, b)).status, (await row(w, b)).heldFor], ["ready", "contradiction"]);
	assert.match((await row(w, b)).held, /^Its intent contradicts I1 "Red accent": They set the accent colour to different values\. A person chooses\.$/);
	// A person decides it is not a contradiction after all: the policy lands it.
	await w.project.dismissRelation((await w.state()).relations[0].id, "rev"); await w.settle();
	assert.deepEqual([(await row(w, b)).status, (await w.state()).relations.length], ["landed", 0]);
	// And the planner does not find the dismissed one again when the intent is looked at afresh.
	await w.project.plan(red.id); await w.settle();
	assert.equal((await w.state()).relations.length, 0);
});

test("an intent that needs another first is not landed before it, by the policy or by a person, and lands once it has", async (t) => {
	const { w, open } = await planned(t, (input) => (input.intent.title === "Style the button" ? [needs(1)] : []), { policy: "auto" });
	const add = await open("Add the button"), style = await open("Style the button");
	assert.deepEqual((await w.state()).relations.map((r) => [r.kind, r.from, r.to]), [["depends", style.id, add.id]]);
	const first = await agent(w, add, "ana");
	const b = await finished(w, style, "ben", { "style.md": "s\n" });
	assert.deepEqual([(await row(w, b)).status, (await row(w, b)).heldFor, (await row(w, b)).held], ["ready", "dependency", "Waiting for I1 to land first: It restyles the button that intent adds."]);
	assert.match(b.brief, /It needs I1 "Add the button" to land first/);
	// A person asking does not jump the order either.
	const asked = await land(w, b.attemptId);
	assert.deepEqual([asked.queued, asked.note], ["waiting", "waits for I1 to land first"]);
	// The first lands (by policy, once finished); the second follows by itself.
	await w.tool(first, "claim", { paths: ["button.md"] });
	first.sha = work(w, first, { "button.md": "b\n" }); await w.project.onPush(first.repo); await w.settle(); await w.finish(first.attemptId, "pass"); await w.settle();
	const said = w.tool(first, "ready", { summary: "done" }); await w.settle(); await said; await w.settle();
	for (let i = 0; i < 6 && (await w.state()).queue.length; i++) { const q = (await w.state()).batches[0]; if (q) await w.finish(`batch:${q.id}`, "pass"); await w.settle(); }
	const s = await w.state();
	assert.deepEqual([s.intents.map((i) => i.status), s.relations.length, s.landings.map((l) => l.intentId)], [["landed", "landed"], 0, [add.id, style.id]]);
});

test("a person can say how two intents stand; a circle of dependencies is refused; dropping an intent frees what waited on it", async (t) => {
	const { w, open } = await planned(t, null, { policy: "auto" });
	const one = await open("One"), two = await open("Two");
	await assert.rejects(() => w.project.relateIntents(two.id, { kind: "depends", other: one.id }), /say why/);
	await w.project.relateIntents(two.id, { kind: "depends", other: one.id, why: "Two builds on what One adds.", by: "rev" });
	await assert.rejects(() => w.project.relateIntents(one.id, { kind: "depends", other: two.id, why: "And back again." }), /go round in a circle/);
	assert.deepEqual((await w.state()).relations.map((r) => [r.kind, r.from, r.to, r.by, r.source]), [["depends", two.id, one.id, "rev", "person"]]);
	const b = await finished(w, two, "ben", { "two.md": "2\n" });
	assert.equal((await row(w, b)).heldFor, "dependency");
	await w.project.abandonIntent(one.id); await w.settle();
	assert.deepEqual([(await row(w, b)).status, (await w.state()).relations.length], ["landed", 0]);
});

test("editing an intent has it looked at again; an intent that would undo a landed one is said to contradict it", async (t) => {
	const { w, shown, open } = await planned(t, (input) => (/blue/i.test(input.intent.goal + input.intent.criteria.join()) ? [clash(1)] : []));
	const red = await open("Red accent", "The accent colour is red");
	const a = await ready(w, red, "ana", { "red.md": "red\n" });
	await land(w, a.attemptId);
	const next = await open("Accent again", "The accent colour stays as it is");
	assert.deepEqual([(await w.state()).relations.length, shown.at(-1).others.map((o) => [o.id, o.status])], [0, [[red.id, "landed"]]]);
	await w.project.editIntent(next.id, { acceptance: "The accent colour is blue" }); await w.settle();
	assert.deepEqual((await w.state()).relations.map((r) => [r.kind, r.from, r.to]), [["contradicts", next.id, red.id]]);
});

test("a planner that fails says so and nothing is held up; planning can be turned off", async (t) => {
	const { w, shown, open } = await planned(t, () => { throw new Error("[502] the model declined to plan this intent"); });
	await open("One"); await open("Two");
	assert.match((await w.state()).activity[0].text, /I2 could not be looked at next to the others: the model declined to plan this intent/);
	await w.project.setPlan(false);
	await open("Three");
	assert.deepEqual([shown.length, (await w.state()).project.policy.plan], [1, false]);
});

test("a broad goal is split into a proposal; accepting it opens the intents in order, and nothing is opened before that", async (t) => {
	const { w, shown } = await planned(t);
	w.project.splitter = async (_env, input) => ({ model: "stand-in", note: "Split by part of the page.", intents: [
		{ title: "Add a reset-all button", goal: "A button that sets every counter to zero.", done_when: ["There is a Reset all button", "Pressing it zeroes every counter"], depends_on: [] },
		{ title: "Confirm before resetting", goal: "Ask before the reset happens.", done_when: ["A confirmation is shown first"], depends_on: [1] },
	], seen: input });
	const { id } = await w.project.proposeSplit("Let people reset every counter at once, safely.", "rev");
	assert.equal((await w.state()).proposals[0].status, "running");
	await w.settle();
	let s = await w.state();
	assert.deepEqual([s.proposals[0].status, s.proposals[0].by, s.proposals[0].note, s.proposals[0].intents.map((i) => [i.title, i.acceptance, i.dependsOn]), s.intents.length],
		["done", "stand-in", "Split by part of the page.", [["Add a reset-all button", "- There is a Reset all button\n- Pressing it zeroes every counter", []], ["Confirm before resetting", "- A confirmation is shown first", [1]]], 0]);
	const made = await w.project.acceptProposal(id, { by: "rev" }); await w.settle();
	s = await w.state();
	assert.deepEqual([made.intents, s.intents.map((i) => [i.title, i.criteria.length, i.createdBy]), s.relations.map((r) => [r.kind, r.from, r.to]), s.proposals[0].status],
		[[1, 2], [["Add a reset-all button", 2, "rev"], ["Confirm before resetting", 1, "rev"]], [["depends", 2, 1]], "accepted"]);
	assert.equal(shown.length, 0, "the proposal already says how its intents stand, so they are not each planned again");
	await assert.rejects(() => w.project.acceptProposal(id), /that proposal is accepted/);
	await assert.rejects(() => w.project.proposeSplit("short"), /write the goal to split/);
});
