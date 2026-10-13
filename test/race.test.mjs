import test from "node:test";
import assert from "node:assert/strict";
import { facts, raceKey, settleJudgement, together } from "../src/worker/race.ts";
import { passage } from "../src/worker/signal.ts";

const judged = (by, pick, error = null) => ({ by, pick, ranking: [], why: "", differences: "", attempts: [], error });

test("judges agree only when at least two answered and all named the same attempt", () => {
	assert.deepEqual(together([judged("a", "1.1"), judged("b", "1.1")]), { pick: "1.1", agreed: true });
	assert.deepEqual(together([judged("a", "1.1"), judged("b", "1.2")]), { pick: null, agreed: false });
	assert.deepEqual(together([judged("a", "1.1")]), { pick: "1.1", agreed: false }, "one judge recommends");
	assert.deepEqual(together([judged("a", "1.1"), judged("b", null, "failed")]), { pick: "1.1", agreed: false }, "a judge that failed is not a second opinion");
	assert.deepEqual(together([judged("a", null), judged("b", null)]), { pick: null, agreed: false }, "both saying none is not a pick");
	assert.deepEqual(together([]), { pick: null, agreed: false });
});

test("a judge's letters become attempt ids, and an answer that leaves things out is completed", () => {
	const j = settleJudgement({ pick: "b", ranking: ["B", "Z", "B"], why: "w", differences: "d", attempts: [{ letter: "A", strengths: "s", weaknesses: "k", keep: "" }, { letter: "Q", strengths: "x", weaknesses: "x", keep: "x" }] }, ["1.1", "1.2", "1.3"], "m");
	assert.deepEqual([j.by, j.pick, j.ranking, j.attempts.map((a) => [a.id, a.strengths])], ["m", "1.2", ["1.2", "1.1", "1.3"], [["1.1", "s"], ["1.2", ""], ["1.3", ""]]]);
	const worded = settleJudgement({ pick: "A", ranking: [], why: "Attempt A is a better fit than attempt B. A button helps.", differences: "Attempts A, B and C differ; attempts A or B would do. Attempt Z is not one.", attempts: [] }, ["1.1", "1.2", "1.3"], "m");
	assert.deepEqual([worded.why, worded.differences], ["Attempt 1.1 is a better fit than attempt 1.2. A button helps.", "Attempts 1.1, 1.2 and 1.3 differ; attempts 1.1 or 1.2 would do. Attempt Z is not one."]);
	assert.equal(settleJudgement({ pick: "none", ranking: ["A", "B"], why: "", differences: "", attempts: [] }, ["1.1", "1.2"], "m").pick, null);
	assert.equal(settleJudgement({ pick: "AB", ranking: [], why: "", differences: "", attempts: [] }, ["1.1", "1.2"], "m").pick, null, "only a single letter names an attempt");
});

test("what code measures of each attempt in a comparison", () => {
	const attempt = (id, extra = {}) => ({ id, headSha: `${id}-head`, agent: id, model: null, flags: [], behind: 0, trunkConflicts: [], createdAt: 0, ...extra });
	const file = (path, base, head) => ({ path, status: base === null ? "added" : "modified", base, head, binary: false });
	const run = (sha, status, extra = {}) => ({ sha, status, finishedAt: 1, nothingToRun: false, steps: [{ name: "test", ms: 40 }, { name: "build", ms: 60 }], ...extra });
	const out = facts([
		{ attempt: attempt("1.1", { flags: [{}] }), files: [file("a.js", "one\ntwo\n", "one\nTWO\nthree\n"), file("shared.js", null, "x\n")], review: { sha: "1.1-head", status: "done", verdict: "approve", criteria: [{ verdict: "met" }, { verdict: "unclear" }] }, run: run("1.1-head", "pass"), readyAt: 5 * 60_000 },
		{ attempt: attempt("1.2", { behind: 2, trunkConflicts: ["shared.js"] }), files: [file("shared.js", null, "y\n")], review: { sha: "older", status: "done", verdict: "approve", criteria: [] }, run: run("1.2-head", "pass", { nothingToRun: true }), readyAt: null },
	]);
	assert.deepEqual(out[0], { attemptId: "1.1", sha: "1.1-head", agent: "1.1", model: null, checks: "pass", checkMs: 100, files: 2, added: 3, removed: 1, only: ["a.js"], flags: 1, review: "approve", met: 1, criteria: 2, minutes: 5, behind: 0, conflicts: 0 });
	assert.deepEqual([out[1].checks, out[1].checkMs, out[1].only, out[1].review, out[1].minutes, out[1].behind, out[1].conflicts], ["none", null, [], null, null, 2, 1], "a review of an older commit does not count");
	assert.equal(raceKey([{ id: "1.2", sha: "b" }, { id: "1.1", sha: "a" }]), "1.1@a 1.2@b");
});

test("the lines quoted around a citation", () => {
	const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
	assert.equal(passage(text, 5, 1), "line 4\nline 5\nline 6");
	assert.equal(passage(text, 1, 2), "line 1\nline 2\nline 3");
	assert.equal(passage(text, null), "");
	assert.equal(passage(null, 3), "");
});
