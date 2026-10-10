import test from "node:test";
import assert from "node:assert/strict";
import { merge3, predict, diffTrees, mergeBase, assemble, markedView, mergeJson } from "../src/worker/gitops.ts";

test("merge3: non-overlapping edits merge cleanly", () => {
	const r = merge3("a\nb\nc\nd\ne\n", "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
	assert.equal(r.clean, true);
	assert.equal(r.text, "A\nb\nc\nd\nE\n");
});
test("merge3: same-line edits conflict with structured regions", () => {
	const r = merge3("a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n");
	assert.equal(r.clean, false);
	assert.deepEqual(r.regions, [{ base: "b\n", ours: "B1\n", theirs: "B2\n", oursLine: 2, before: "a\n", after: "c\n" }]);
	assert.equal(r.text, "a\n<<<<<<< trunk\nB1\n||||||| base\nb\n=======\nB2\n>>>>>>> attempt\nc\n");
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

test("assemble: replaces each conflict and keeps both sides' other changes", () => {
	const base = "a\nb\nc\nd\ne\nf\ng\n", ours = "A\nb\nC1\nd\ne\nf\nG1\n", theirs = "a\nb\nC2\nd\nE\nf\nG2\n";
	assert.equal(merge3(base, ours, theirs).regions.length, 2);
	assert.equal(assemble(base, ours, theirs, ["C1 and C2\n", "G both"]), "A\nb\nC1 and C2\nd\nE\nf\nG both\n");
	assert.equal(assemble(base, ours, theirs, ["", ""]), "A\nb\nd\nE\nf\n");
});
test("assemble: a conflict at the end of a file without a final newline stays without one", () => {
	assert.equal(assemble("a\nb", "a\nB1", "a\nB2", ["B3"]), "a\nB3");
});
test("markedView: numbers the conflicts and leaves out the middle of long agreed stretches", () => {
	const filler = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join("");
	const base = `x\n${filler}y\n`, ours = `X1\n${filler}Y1\n`, theirs = `X2\n${filler}Y2\n`;
	const view = markedView(base, ours, theirs, 5);
	assert.match(view, /^<<<<<<< trunk \(conflict 1\)\nX1\n\|\|\|\|\|\|\| base\nx\n=======\nX2\n>>>>>>> attempt\nline 0\n/);
	assert.match(view, /… \(190 lines the same on both sides\) …\nline 195\n/);
	assert.match(view, /<<<<<<< trunk \(conflict 2\)\nY1\n/);
	assert.ok(view.length < 600);
});

test("mergeJson: two sides each adding a dependency merge by key, sorted, in the file's own indentation", () => {
	const pkg = (deps, extra = {}) => JSON.stringify({ name: "t", scripts: { test: "node --test" }, dependencies: deps, ...extra }, null, 2) + "\n";
	const merged = mergeJson(pkg({ ms: "1" }), pkg({ ms: "1", zod: "4" }), pkg({ ms: "1", diff: "9" }, { license: "MIT" }));
	assert.equal(merged, pkg({ diff: "9", ms: "1", zod: "4" }, { license: "MIT" }));
	assert.equal(merge3(pkg({ ms: "1" }), pkg({ ms: "1", zod: "4" }), pkg({ ms: "1", diff: "9" })).clean, false);
});
test("mergeJson: the same key changed two ways, or removed against changed, is left as a conflict", () => {
	const pkg = (deps) => JSON.stringify({ dependencies: deps });
	assert.equal(mergeJson(pkg({ ms: "1" }), pkg({ ms: "2" }), pkg({ ms: "3" })), null);
	assert.equal(mergeJson(pkg({ ms: "1" }), pkg({}), pkg({ ms: "3" })), null);
	assert.deepEqual(JSON.parse(mergeJson(pkg({ ms: "1", a: "1" }), pkg({ a: "1" }), pkg({ ms: "1", a: "2" }))), { dependencies: { a: "2" } });
	assert.equal(mergeJson("{", "{}", "{}"), null);
});

test("combine: both sides adding lines at the same place keeps both, trunk's first", async () => {
	const { combine, predict, bothAdded } = await import("../src/worker/gitops.ts");
	const base = "const a = 1;\n\nfunction render() {}\n";
	const trunk = "const a = 1;\n\nfunction one() {}\n\nfunction render() {}\n", attempt = "const a = 1;\n\nfunction two() {}\n\nfunction render() {}\n";
	assert.deepEqual(combine(base, trunk, attempt), { text: "const a = 1;\n\nfunction one() {}\n\nfunction two() {}\n\nfunction render() {}\n", places: 1 });
	assert.deepEqual([predict(base, trunk, attempt).conflict, predict(base, trunk, attempt, true).conflict], [true, false]);
	// Appended at the end of a file with no final newline on trunk's side: the two do not run together on one line.
	assert.equal(bothAdded({ base: "", ours: "x", theirs: "y\n" }), "x\ny\n");
	// One side's addition already contains the other's: kept once.
	assert.equal(bothAdded({ base: "", ours: "import a;\nimport b;\n", theirs: "import b;\n" }), "import a;\nimport b;\n");
});

test("combine: a place where either side changed or removed lines is still a conflict, and the whole file is left alone", async () => {
	const { combine, predict } = await import("../src/worker/gitops.ts");
	const base = "title: Tally\n\n\n\n\n\n\n\nend\n";
	const trunk = "title: Ana\n\n\n\n\n\n\n\nend\nmore from trunk\n", attempt = "title: Ben\n\n\n\n\n\n\n\nend\nmore from the attempt\n";
	assert.equal(combine(base, trunk, attempt), null);
	assert.deepEqual(predict(base, trunk, attempt, true), { conflict: true, regions: 2 });
	assert.deepEqual(combine("a\n", "a\nb\n", "a\n"), { text: "a\nb\n", places: 0 });
});
