import test from "node:test";
import assert from "node:assert/strict";
import { merge3, predict, diffTrees, mergeBase } from "../src/worker/gitops.ts";

test("merge3: non-overlapping edits merge cleanly", () => {
	const r = merge3("a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
	assert.equal(r.clean, true);
	assert.equal(r.text, "A\nb\nc\nd\nE\n");
});
test("merge3: same-line edits conflict with structured regions", () => {
	const r = merge3("a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n");
	assert.equal(r.clean, false);
	assert.deepEqual(r.regions, [{ base: "b\n", ours: "B1\n", theirs: "B2\n", oursLine: 2 }]);
});
test("merge3: identical edits are not a conflict", () => {
	assert.equal(merge3("a\nb\n", "a\nX\n", "a\nX\n").clean, true);
});
test("predict: delete vs edit conflicts, delete vs untouched does not", () => {
	assert.equal(predict("x\n", null, "y\n").conflict, true);
	assert.equal(predict("x\n", null, "x\n").conflict, false);
	assert.equal(predict(null, "a\n", "b\n").conflict, true);
});

// A tiny fake host: trees and commits keyed by hash.
const trees = {
	t0: [{ name: "a.txt", hash: "b1", type: "blob" }, { name: "src", hash: "t0s", type: "tree" }],
	t0s: [{ name: "x.ts", hash: "b2", type: "blob" }, { name: "y.ts", hash: "b3", type: "blob" }],
	t1: [{ name: "a.txt", hash: "b1", type: "blob" }, { name: "src", hash: "t1s", type: "tree" }, { name: "new.md", hash: "b9", type: "blob" }],
	t1s: [{ name: "x.ts", hash: "b2x", type: "blob" }],
};
const commits = {
	c0: { parents: [] }, c1: { parents: ["c0"] }, c2: { parents: ["c1"] },
	f1: { parents: ["c0"] }, f2: { parents: ["f1", "c1"] }, f3: { parents: ["f2"] },
};
const host = { readTree: async (_r, h) => trees[h] ?? null, readCommit: async (_r, h) => commits[h] ?? null };

test("diffTrees: reports added, modified, deleted and skips equal subtrees", async () => {
	const d = await diffTrees(host, "r", "t0", "t1");
	assert.deepEqual(d.map((c) => `${c.status} ${c.path}`), ["added new.md", "modified src/x.ts", "deleted src/y.ts"]);
});
test("mergeBase: finds the newest trunk commit an attempt has merged in", async () => {
	const trunk = ["c2", "c1", "c0"];
	assert.equal(await mergeBase(host, "r", "f1", trunk), "c0");
	assert.equal(await mergeBase(host, "r", "f3", trunk), "c1");
});
