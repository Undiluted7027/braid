import test from "node:test";
import assert from "node:assert/strict";
import { claimOverlaps, fileOverlaps, risen, strongest } from "../src/worker/overlap.ts";

const file = (path, base, head) => ({ path, status: base ? "modified" : "added", base, head });
const attempt = (id, intentId, files = [], claims = [], baseSha = "t0") => ({ id, intentId, baseSha, files, claims, repo: `r${id}` });
const blobs = { b: "one\ntwo\nthree\n", top: "ONE\ntwo\nthree\n", end: "one\ntwo\nTHREE\n", top2: "uno\ntwo\nthree\n" };
const text = async (_repo, hash) => (hash ? blobs[hash] ?? null : null);
const order = new Map([["t0", 0]]);

test("fileOverlaps: the same file changed apart is a touch, the same lines a conflict, and the pair is written smaller id first", async () => {
	const a = attempt("2.1", 2, [file("app.js", "b", "top"), file("only-a.js", null, "top")]);
	assert.deepEqual(await fileOverlaps(a, attempt("1.1", 1, [file("app.js", "b", "end")]), order, text), [{ a: "1.1", b: "2.1", path: "app.js", severity: "touch", regions: 0 }]);
	assert.deepEqual(await fileOverlaps(a, attempt("3.1", 3, [file("app.js", "b", "top2")]), order, text), [{ a: "2.1", b: "3.1", path: "app.js", severity: "conflict", regions: 1 }]);
	assert.deepEqual(await fileOverlaps(a, attempt("3.1", 3, [file("app.js", "b", "top")]), order, text), [{ a: "2.1", b: "3.1", path: "app.js", severity: "touch", regions: 0 }]);
});

test("attempts at the same intent are alternatives, not collisions", async () => {
	const a = attempt("1.1", 1, [file("app.js", "b", "top")], ["app.js"]), b = attempt("1.2", 1, [file("app.js", "b", "top2")], ["app.js"]);
	assert.deepEqual(await fileOverlaps(a, b, order, text), []);
	assert.deepEqual(claimOverlaps(a, b), []);
});

test("claimOverlaps: a claim meets the other side's files and claims, by path, folder or prefix", () => {
	const a = attempt("1.1", 1, [], ["src/ui/", "README.md"]), b = attempt("2.1", 2, [file("src/ui/App.tsx", "b", "top")], ["README.md", "docs/*"]);
	assert.deepEqual(claimOverlaps(a, b).map((o) => [o.a, o.b, o.path, o.severity]).sort(), [["1.1", "2.1", "README.md", "claim"], ["1.1", "2.1", "src/ui/App.tsx", "claim"]]);
	assert.deepEqual(claimOverlaps(b, a), claimOverlaps(a, b));
	assert.deepEqual(claimOverlaps(attempt("1.1", 1, [], ["a.js"]), attempt("2.1", 2, [], ["b.js"])), []);
});

test("strongest keeps one row per pair and path; risen reports what is new or worse", () => {
	const row = (path, severity, regions = 0) => ({ a: "1.1", b: "2.1", path, severity, regions });
	assert.deepEqual(strongest([row("x", "claim"), row("x", "conflict", 2), row("x", "touch"), row("y", "claim")]), [row("x", "conflict", 2), row("y", "claim")]);
	const before = [row("x", "claim"), row("y", "conflict", 1), row("z", "touch")];
	const after = [row("x", "touch"), row("y", "touch"), row("z", "touch"), row("w", "claim")];
	assert.deepEqual(risen(before, after).map((r) => [r.overlap.path, r.had?.severity ?? null]), [["x", "claim"], ["w", null]]);
});
