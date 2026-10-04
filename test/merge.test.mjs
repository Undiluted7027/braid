import test from "node:test";
import assert from "node:assert/strict";
import git from "isomorphic-git";
import { MemoryFS } from "../src/worker/memfs.ts";
import { mergeTrees } from "../src/worker/merge.ts";

const author = { name: "t", email: "t@t", timestamp: 1, timezoneOffset: 0 };

/** A repository with a base commit and two commits on top of it; returns the three trees. */
async function repoWith(base, trunk, attempt) {
	const fs = new MemoryFS(), dir = "/r", repo = { fs, dir };
	await fs.promises.mkdir(dir);
	await git.init({ fs, dir, defaultBranch: "main" });
	const tree = async (files) => {
		const build = async (prefix) => {
			const names = new Set(Object.keys(files).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]));
			const out = [];
			for (const name of names) {
				const path = prefix + name;
				if (path in files) out.push({ mode: "100644", path: name, type: "blob", oid: await git.writeBlob({ ...repo, blob: typeof files[path] === "string" ? new TextEncoder().encode(files[path]) : files[path] }) });
				else out.push({ mode: "040000", path: name, type: "tree", oid: await build(`${path}/`) });
			}
			return git.writeTree({ ...repo, tree: out });
		};
		return build("");
	};
	return { repo, base: await tree(base), trunk: await tree(trunk), attempt: await tree(attempt) };
}
async function files(repo, oid, prefix = "", out = {}) {
	for (const e of (await git.readTree({ ...repo, oid })).tree) {
		if (e.type === "tree") await files(repo, e.oid, `${prefix}${e.path}/`, out);
		else out[prefix + e.path] = new TextDecoder().decode((await git.readBlob({ ...repo, oid: e.oid })).blob);
	}
	return out;
}
const three = "one\ntwo\nthree\n";

test("mergeTrees: changes to different files and different lines merge", async () => {
	const r = await repoWith({ "a.txt": three, "lib/b.txt": three }, { "a.txt": "ONE\ntwo\nthree\n", "lib/b.txt": three, "new.txt": "t\n" }, { "a.txt": "one\ntwo\nTHREE\n", "lib/b.txt": "one\nTWO\nthree\n" });
	const m = await mergeTrees(r.repo, r.base, r.trunk, r.attempt, new Map());
	assert.deepEqual(m.conflicts, []);
	assert.deepEqual(await files(r.repo, m.tree), { "a.txt": "ONE\ntwo\nTHREE\n", "lib/b.txt": "one\nTWO\nthree\n", "new.txt": "t\n" });
});

test("mergeTrees: a conflict in a folder is reported by its full path", async () => {
	const r = await repoWith({ "lib/total.mjs": three }, { "lib/total.mjs": "one\nT\nthree\n" }, { "lib/total.mjs": "one\nA\nthree\n" });
	const m = await mergeTrees(r.repo, r.base, r.trunk, r.attempt, new Map());
	assert.deepEqual(m.conflicts.map((c) => [c.path, c.kind, c.trunk, c.attempt]), [["lib/total.mjs", "content", "one\nT\nthree\n", "one\nA\nthree\n"]]);
});

test("mergeTrees: same-named files with identical contents each get their own resolution", async () => {
	const r = await repoWith({ "a/index.txt": three, "b/index.txt": three }, { "a/index.txt": "one\nT\nthree\n", "b/index.txt": "one\nT\nthree\n" }, { "a/index.txt": "one\nA\nthree\n", "b/index.txt": "one\nA\nthree\n" });
	const open = await mergeTrees(r.repo, r.base, r.trunk, r.attempt, new Map());
	assert.deepEqual(open.conflicts.map((c) => c.path), ["a/index.txt", "b/index.txt"]);
	const m = await mergeTrees(r.repo, r.base, r.trunk, r.attempt, new Map([["a/index.txt", "for a\n"], ["b/index.txt", "for b\n"]]));
	assert.deepEqual(m.conflicts, []);
	assert.deepEqual(m.reconciled, ["a/index.txt", "b/index.txt"]);
	assert.deepEqual(await files(r.repo, m.tree), { "a/index.txt": "for a\n", "b/index.txt": "for b\n" });
});

test("mergeTrees: deletions carry over, and delete against edit is a conflict", async () => {
	const base = { "keep.txt": three, "gone.txt": three, "dir/x.txt": three, "fight.txt": three };
	const r = await repoWith(base, { "keep.txt": three, "dir/x.txt": three, "fight.txt": "one\nT\nthree\n" }, { "keep.txt": three, "gone.txt": three });
	const m = await mergeTrees(r.repo, r.base, r.trunk, r.attempt, new Map());
	assert.deepEqual(m.conflicts.map((c) => [c.path, c.kind]), [["fight.txt", "delete"]]);
	const clean = await repoWith(base, { "keep.txt": three, "dir/x.txt": three, "fight.txt": three }, { "keep.txt": three, "gone.txt": three, "fight.txt": three });
	const done = await mergeTrees(clean.repo, clean.base, clean.trunk, clean.attempt, new Map());
	assert.deepEqual(await files(clean.repo, done.tree), { "keep.txt": three, "fight.txt": three });
});

test("mergeTrees: both sides adding the same path differently conflicts; binary files are not merged as text", async () => {
	const bin = (n) => new Uint8Array([0, n, 0, 255]);
	const r = await repoWith({ "img.bin": bin(1) }, { "img.bin": bin(2), "new.txt": "t\n" }, { "img.bin": bin(3), "new.txt": "a\n" });
	const m = await mergeTrees(r.repo, r.base, r.trunk, r.attempt, new Map());
	assert.deepEqual(m.conflicts.map((c) => [c.path, c.kind]), [["img.bin", "delete"], ["new.txt", "content"]]);
});
