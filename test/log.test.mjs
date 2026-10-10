import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { drain, Log } from "../src/worker/log.ts";
import { applyEvent } from "../src/worker/projection.ts";

/** A log over an in-memory database, with a clock the test moves by hand. */
function setup(apply) {
	const db = new DatabaseSync(":memory:");
	const sql = { exec: (query, ...args) => { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } };
	const transaction = (fn) => {
		db.exec("BEGIN");
		try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
	};
	const clock = { t: 1000 }, woke = { n: 0 };
	for (const table of [
		"CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)",
		"CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, actor TEXT, text TEXT, intent_id INTEGER, attempt_id TEXT)",
		"CREATE TABLE signals (id INTEGER PRIMARY KEY AUTOINCREMENT, to_attempt TEXT, kind TEXT, body TEXT, at INTEGER, seen INTEGER DEFAULT 0)",
	]) db.exec(table);
	const log = new Log({ sql, transaction, apply: apply ?? ((e) => applyEvent(sql, e)), now: () => clock.t, onEffects: () => woke.n++ });
	log.schema();
	const all = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((r) => ({ ...r }));
	return { db, sql, log, clock, woke, all };
}
const effect = (id, lane, data = {}) => ({ id, type: "work", lane, data });
const ok = { replaySafe: true, run: async () => {} };

test("a commit writes its events, what they change, its receipt and its effects together", () => {
	const { log, all, woke } = setup();
	const out = log.commit({
		command: { id: "c1", type: "note" }, result: { fine: true },
		events: [{ type: "activity.noted", actor: "ana", intentId: 2, attemptId: "2.1", data: { kind: "why", text: "chose a map" } }],
		effects: [effect("e1", "a")],
	});
	assert.equal(out.committed, true);
	assert.deepEqual(out.events.map((e) => [e.seq, e.type, e.commandId]), [[1, "activity.noted", "c1"]]);
	assert.deepEqual(all("activity"), [{ id: 1, at: 1000, kind: "why", actor: "ana", text: "chose a map", intent_id: 2, attempt_id: "2.1" }]);
	assert.deepEqual(out.receipt, { commandId: "c1", type: "note", status: "accepted", seq: 1, result: { fine: true }, error: null, at: 1000 });
	assert.equal(log.effect("e1").status, "pending");
	assert.equal(woke.n, 1);
});

test("a command seen before changes nothing and gets its first receipt back", () => {
	const { log, all, woke } = setup();
	const event = { type: "activity.noted", data: { kind: "why", text: "once" } };
	const first = log.commit({ command: { id: "c1", type: "note" }, events: [event], effects: [effect("e1", "a")], result: 1 });
	const again = log.commit({ command: { id: "c1", type: "note" }, events: [event, event], effects: [effect("e2", "a")], result: 2 });
	assert.equal(again.committed, false);
	assert.deepEqual(again.receipt, first.receipt);
	assert.deepEqual(again.events, first.events);
	assert.equal(all("activity").length, 1);
	assert.equal(log.effect("e2"), null);
	assert.equal(woke.n, 1);
});

test("a refused command is remembered as refused", () => {
	const { log } = setup();
	const r = log.reject({ id: "c1", type: "land" }, "attempt 1.1 moved");
	assert.deepEqual([r.status, r.error], ["rejected", "attempt 1.1 moved"]);
	assert.equal(log.reject({ id: "c1", type: "land" }, "something else").error, "attempt 1.1 moved");
	assert.equal(log.commit({ command: { id: "c1", type: "land" }, events: [{ type: "activity.noted", data: { kind: "x", text: "x" } }] }).committed, false);
	assert.equal(log.latest(), 0);
});

test("if applying an event fails, nothing of the commit is kept", () => {
	const { log, all } = setup((e) => { if (e.data.bad) throw new Error("no"); });
	assert.throws(() => log.commit({ command: { id: "c1", type: "t" }, events: [{ type: "a" }, { type: "b", data: { bad: true } }], effects: [effect("e1", "a")] }), /no/);
	assert.equal(log.latest(), 0);
	assert.equal(log.receipt("c1"), null);
	assert.deepEqual(all("effects"), []);
	// A commit made while another is being written joins it rather than opening a second transaction.
	const { log: nested } = setup((e) => { if (e.type === "outer") nested.commit({ events: [{ type: "inner" }] }); });
	nested.commit({ events: [{ type: "outer" }] });
	assert.deepEqual(nested.after(0).map((e) => e.type), ["outer", "inner"]);
});

test("a lane runs one effect at a time in order, and lanes run side by side", async () => {
	const { log } = setup();
	log.commit({ effects: [effect("a1", "a"), effect("a2", "a"), effect("b1", "b"), effect("a3", "a"), effect("c1", "c")] });
	assert.deepEqual(log.claim(10).map((e) => e.id), ["a1", "b1", "c1"]);
	assert.deepEqual(log.claim(10), []);
	log.succeed("a1");
	assert.deepEqual(log.claim(10).map((e) => e.id), ["a2"]);

	const fresh = setup().log, order = [], open = new Map();
	let atOnce = 0, most = 0;
	fresh.commit({ effects: ["a", "a", "b", "b", "c", "c", "d", "d"].map((lane, i) => effect(`${lane}${i}`, lane)) });
	const ran = await drain(fresh, { work: { replaySafe: true, run: async (e) => {
		assert.equal(open.get(e.lane), undefined, "two effects of one lane at once");
		open.set(e.lane, true); most = Math.max(most, ++atOnce);
		await new Promise((r) => setTimeout(r, 5));
		order.push(e.id); open.delete(e.lane); atOnce--;
	} } }, { concurrency: 3 });
	assert.equal(ran, 8);
	assert.equal(most, 3);
	for (const lane of "abcd") assert.deepEqual(order.filter((id) => id[0] === lane), order.filter((id) => id[0] === lane).toSorted());
	assert.equal(fresh.unsettled(), 0);
});

test("a failed effect waits and tries again, holding its lane; after its last try it is failed and reported", async () => {
	const { log, clock } = setup();
	log.commit({ effects: [effect("a1", "a"), effect("a2", "a"), effect("b1", "b")] });
	const tried = [], failed = [];
	const executors = { work: { replaySafe: true, run: async (e, ctx) => { tried.push(`${e.id}#${e.tries}${ctx.willRetry ? "" : "!"}`); if (e.id === "a1") throw new Error("artifacts said no"); } } };
	const opts = { maxTries: 3, now: () => clock.t, onFailed: (e, error) => failed.push([e.id, e.tries, error]) };
	await drain(log, executors, opts);
	assert.deepEqual(tried, ["a1#1", "b1#1"]);
	assert.deepEqual([log.effect("a1").status, log.effect("a1").lastError, log.effect("a2").status], ["pending", "artifacts said no", "pending"]);
	assert.equal(log.nextAt(), 1250);
	assert.equal(await drain(log, executors, opts), 0, "nothing is due yet, and a2 must not overtake a1");
	clock.t = 1250;
	await drain(log, executors, opts);
	assert.equal(log.nextAt(), 1750);
	clock.t = 1750;
	await drain(log, executors, opts);
	assert.deepEqual(tried, ["a1#1", "b1#1", "a1#2", "a1#3!", "a2#1"]);
	assert.deepEqual(failed, [["a1", 3, "artifacts said no"]]);
	assert.deepEqual([log.effect("a1").status, log.effect("a2").status], ["failed", "succeeded"]);
	assert.equal(log.requeueFailed("work"), 1);
	assert.deepEqual([log.effect("a1").status, log.effect("a1").tries], ["pending", 0]);

	const none = setup().log;
	none.commit({ effects: [{ id: "x", type: "unknown", lane: "a" }] });
	await drain(none, {});
	assert.match(none.effect("x").lastError, /nothing knows how/);
});

test("asking for the same work again: nothing while it waits, once more if it is running, new if it is settled", async () => {
	const { log } = setup();
	log.commit({ effects: [effect("observe:1.1", "1.1", { head: "aaa" })] });
	log.commit({ effects: [effect("observe:1.1", "1.1", { head: "bbb" })] });
	assert.equal(log.effects().length, 1);
	assert.equal(log.effect("observe:1.1").data.head, "aaa");

	const seen = [];
	let asked = false;
	await drain(log, { work: { replaySafe: true, run: async (e) => {
		seen.push(e.data.head);
		if (!asked) { asked = true; log.commit({ effects: [effect("observe:1.1", "1.1", { head: "ccc" })] }); }
	} } });
	assert.deepEqual(seen, ["aaa", "ccc"]);
	assert.equal(log.effect("observe:1.1").status, "succeeded");

	log.commit({ effects: [effect("other", "1.1")] });
	log.commit({ effects: [effect("observe:1.1", "1.1", { head: "ddd" })] });
	assert.deepEqual(log.effects("pending").map((e) => [e.id, e.data.head]), [["other", undefined], ["observe:1.1", "ddd"]]);
});

test("after a restart, cut-off work that is safe to repeat goes back in line and the rest is dropped", async () => {
	const { log } = setup();
	log.commit({ effects: [effect("read", "a"), { id: "turn", type: "agent.turn", lane: "b" }, effect("later", "c")] });
	assert.equal(log.claim(2).length, 2);
	const { requeued, lost } = log.recover((type) => type !== "agent.turn");
	assert.deepEqual([requeued.map((e) => e.id), lost.map((e) => e.id)], [["read"], ["turn"]]);
	assert.deepEqual(log.effects().map((e) => [e.id, e.status]), [["read", "pending"], ["turn", "cancelled"], ["later", "pending"]]);
	assert.equal(await drain(log, { work: ok }), 2);
});

test("pending work can be cancelled, and old settled work is pruned while failures are kept", async () => {
	const { log, clock } = setup();
	log.commit({ effects: [effect("a1", "a"), effect("a2", "a"), effect("b1", "b"), { id: "bad", type: "unknown", lane: "z" }] });
	assert.deepEqual(log.cancel({ lane: "a" }, "attempt abandoned"), ["a1", "a2"]);
	await drain(log, { work: ok }, { maxTries: 1 });
	clock.t += 8 * 24 * 3600_000;
	assert.equal(log.prune(), 3);
	assert.deepEqual(log.effects().map((e) => [e.id, e.status]), [["bad", "failed"]]);
});

test("replaying the log into empty tables gives the same rows", () => {
	const first = setup();
	first.log.commit({ events: [{ type: "activity.noted", actor: "ana", intentId: 1, attemptId: "1.1", data: { kind: "claim", text: "ana plans to change app.js" } }] });
	first.log.commit({ events: [{ type: "signal.sent", attemptId: "1.1", data: { kind: "overlap", body: { path: "app.js" } } }, { type: "signal.sent", attemptId: "2.1", data: { kind: "message", body: { body: "hi" } } }] });
	first.clock.t = 2000;
	first.log.commit({ events: [{ type: "signals.delivered", attemptId: "1.1", data: { upTo: 1 } }] });
	first.log.commit({ events: [{ type: "signal.sent", attemptId: "1.1", data: { kind: "trunk-moved", body: {} } }, { type: "context.repo.created", data: { remote: "https://x/ctx.git" } }, { type: "from.the.future", data: {} }] });
	assert.deepEqual(first.all("signals").map((s) => [s.to_attempt, s.kind, s.seen]), [["1.1", "overlap", 1], ["2.1", "message", 0], ["1.1", "trunk-moved", 0]]);

	const second = setup();
	for (const e of first.log.after(0)) applyEvent(second.sql, e);
	for (const table of ["activity", "signals", "meta"]) assert.deepEqual(second.all(table), first.all(table));
});

test("work asked for while a slow effect runs starts at once in another lane", async () => {
	const { log } = setup();
	const order = [];
	log.commit({ effects: [{ id: "slow", type: "slow", lane: "spares" }] });
	await drain(log, {
		slow: { replaySafe: true, run: async () => {
			setTimeout(() => log.commit({ effects: [effect("quick", "repo:1.1")] }), 5);
			await new Promise((r) => setTimeout(r, 60));
			order.push("slow");
		} },
		work: { replaySafe: true, run: async () => { order.push("quick"); } },
	});
	assert.deepEqual(order, ["quick", "slow"]);
});

test("work that asks for itself again later, while it runs, waits until then", async () => {
	const { log, clock } = setup();
	let runs = 0;
	log.commit({ effects: [effect("spare", "spares")] });
	const executors = { work: { replaySafe: true, run: async () => { if (++runs === 1) log.commit({ effects: [{ ...effect("spare", "spares"), after: clock.t + 15_000 }] }); } } };
	await drain(log, executors, { now: () => clock.t });
	assert.deepEqual([runs, log.effect("spare").status, log.nextAt()], [1, "pending", 16_000]);
	clock.t = 16_000;
	await drain(log, executors, { now: () => clock.t });
	assert.deepEqual([runs, log.effect("spare").status], [2, "succeeded"]);
});
