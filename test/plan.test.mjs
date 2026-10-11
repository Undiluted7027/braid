import test from "node:test";
import assert from "node:assert/strict";
import { planPrompt, reaches, settleRelations, settleSplit, splitPrompt } from "../src/worker/plan.ts";

const intent = (id, title, criteria, status = "open") => ({ id, title, goal: `${title}.`, criteria, status });
const me = intent(5, "Blue accent", ["The accent colour is blue", "Buttons use it"]);
const others = [intent(2, "Red accent", ["The accent colour is red"]), intent(3, "Theme tokens", ["Colours come from tokens"]), intent(1, "Green accent", ["The accent is green"], "landed")];
const input = { intent: me, others };
const rel = (other, kind, extra = {}) => ({ other, kind, why: "They set the same colour to different values.", mine: [1], theirs: [1], ...extra });

test("settleRelations: a relation needs a real other intent, a reason, and for a contradiction the criteria that clash", () => {
	const kept = settleRelations({ relations: [rel(2, "contradicts"), rel(99, "contradicts"), rel(5, "contradicts"), rel(3, "contradicts", { why: "clash" }), rel(1, "contradicts", { mine: [], theirs: [1] })] }, input, []);
	assert.deepEqual(kept, [{ kind: "contradicts", from: 5, to: 2, why: "They set the same colour to different values.", fromCriteria: [1], toCriteria: [1] }]);
	// Criteria numbers that do not exist are dropped, and a contradiction left with none is not one.
	assert.deepEqual(settleRelations({ relations: [rel(2, "contradicts", { mine: [1, 7, 1], theirs: [4] })] }, input, []), []);
});

test("settleRelations: a dependency is on an open intent and cannot close a circle; one relation per pair, a contradiction first", () => {
	const dep = (other) => rel(other, "depends_on", { why: "It uses the tokens that intent introduces." });
	assert.deepEqual(settleRelations({ relations: [dep(3), dep(1)] }, input, []).map((r) => [r.kind, r.to, r.fromCriteria]), [["depends", 3, []]], "nothing waits for what has landed");
	assert.deepEqual(settleRelations({ relations: [dep(3)] }, input, [[3, 9], [9, 5]]), [], "I3 already needs I5 through I9");
	assert.deepEqual(settleRelations({ relations: [dep(2), rel(2, "contradicts"), rel(2, "duplicates")] }, input, []).map((r) => r.kind), ["contradicts"]);
	assert.deepEqual(settleRelations({ relations: [rel(1, "duplicates")] }, input, []).map((r) => [r.kind, r.to]), [["duplicates", 1]], "already done is worth saying");
	assert.deepEqual([reaches([[1, 2], [2, 3]], 1, 3), reaches([[1, 2], [2, 3]], 3, 1), reaches([[1, 2], [2, 1]], 1, 9)], [true, false, false]);
});

test("what the planner is shown: the new intent, then the others with their criteria and whether they landed", () => {
	const p = planPrompt(input);
	assert.ok(p.indexOf("# The new intent\n### I5: Blue accent") === 0);
	assert.match(p, /### I1: Green accent \(already landed\)\nGoal: Green accent\.\nCriteria:\n1\. The accent is green/);
	assert.match(p, /Answer for I5 only/);
});

test("settleSplit: at most eight intents, each with a title and a goal, depending only on earlier ones", () => {
	const one = (n, depends_on = []) => ({ title: `Intent number ${n}`, goal: `Do the thing number ${n}.`, done_when: ["It is there", "", "Tests pass"], depends_on });
	const kept = settleSplit({ note: "Split by part.", intents: [one(1, [2]), one(2, [1, 1, 5]), { title: "", goal: "No title here." }, one(3, [1, 2]), ...Array.from({ length: 9 }, (_, i) => one(i + 4))] });
	assert.equal(kept.intents.length, 8);
	assert.deepEqual(kept.intents.slice(0, 3).map((i) => i.dependsOn), [[], [1], [1, 2]]);
	assert.equal(kept.intents[0].acceptance, "- It is there\n- Tests pass");
	assert.match(splitPrompt({ goal: "Add accounts", files: ["src/app.js"], open: [{ id: 2, title: "Dark mode" }] }), /# Intents already open\n- I2: Dark mode/);
});
