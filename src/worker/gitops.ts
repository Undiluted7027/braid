// Read-only git analysis over RepoHost: what an attempt changed, where its history
// left trunk, and whether two concurrent changes to a file can be merged.
import { diff3Merge } from "node-diff3";
import type { RepoHost, TreeEntry } from "./host.ts";

export interface FileChange { path: string; status: "added" | "modified" | "deleted"; base: string | null; head: string | null }

const isDir = (e: TreeEntry) => e.type === "tree";

/** Files that differ between two trees. `base`/`head` are blob hashes. Identical subtrees are skipped by hash. */
export async function diffTrees(host: RepoHost, repo: string, baseTree: string | null, headTree: string | null, prefix = "", out: FileChange[] = []): Promise<FileChange[]> {
	if (baseTree === headTree) return out;
	const [b, h] = await Promise.all([
		baseTree ? host.readTree(repo, baseTree) : Promise.resolve([]),
		headTree ? host.readTree(repo, headTree) : Promise.resolve([]),
	]);
	const bm = new Map((b ?? []).map((e) => [e.name, e]));
	const hm = new Map((h ?? []).map((e) => [e.name, e]));
	for (const name of [...new Set([...bm.keys(), ...hm.keys()])].sort()) {
		const be = bm.get(name), he = hm.get(name);
		if (be && he && be.hash === he.hash) continue;
		const path = prefix + name;
		if ((be && isDir(be)) || (he && isDir(he))) {
			await diffTrees(host, repo, be && isDir(be) ? be.hash : null, he && isDir(he) ? he.hash : null, path + "/", out);
			if (be && !isDir(be)) out.push({ path, status: "deleted", base: be.hash, head: null });
			if (he && !isDir(he)) out.push({ path, status: "added", base: null, head: he.hash });
		} else if (!be) out.push({ path, status: "added", base: null, head: he!.hash });
		else if (!he) out.push({ path, status: "deleted", base: be.hash, head: null });
		else out.push({ path, status: "modified", base: be.hash, head: he.hash });
	}
	return out;
}

/** Every file path in a tree (for the file browser). */
export async function listTree(host: RepoHost, repo: string, tree: string, prefix = "", out: string[] = []): Promise<string[]> {
	for (const e of (await host.readTree(repo, tree)) ?? []) {
		if (isDir(e)) await listTree(host, repo, e.hash, prefix + e.name + "/", out);
		else out.push(prefix + e.name);
	}
	return out;
}

/**
 * The newest trunk commit reachable from an attempt's head. An attempt that merged
 * trunk back in has a newer base than its fork point, so walk the whole graph.
 */
export async function mergeBase(host: RepoHost, repo: string, head: string, trunkCommits: string[]): Promise<string | null> {
	const rank = new Map(trunkCommits.map((h, i) => [h, i])); // 0 = newest
	let best: string | null = null;
	const seen = new Set<string>();
	const queue = [head];
	for (let n = 0; queue.length && n < 500; n++) {
		const h = queue.shift()!;
		if (seen.has(h)) continue;
		seen.add(h);
		if (rank.has(h)) {
			if (best === null || rank.get(h)! < rank.get(best)!) best = h;
			continue; // everything behind a trunk commit is older trunk
		}
		const c = await host.readCommit(repo, h);
		if (c) queue.push(...c.parents);
	}
	return best;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
/** Decode as text, or null when the bytes are binary. */
export function asText(bytes: Uint8Array | null): string | null {
	if (!bytes) return null;
	if (bytes.subarray(0, 8000).includes(0)) return null;
	try { return decoder.decode(bytes); } catch { return null; }
}

/** One place two versions disagree: what each side and their base have there, and a few agreed lines either side of it for orientation. */
export interface ConflictRegion { base: string; ours: string; theirs: string; oursLine: number; before?: string; after?: string }
export interface MergeResult { clean: boolean; text: string; regions: ConflictRegion[] }

const lines = (s: string) => (s === "" ? [] : s.split(/(?<=\n)/));
const CONTEXT = 6;
type Part = { ok: string[] } | { conflict: { a: string[]; o: string[]; b: string[] } };
const parts = (base: string, ours: string, theirs: string) => diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true }) as unknown as Part[];
/** A marker has to start its own line, even after text that does not end with a newline. */
const closed = (s: string) => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
const block = (c: { a: string[]; o: string[]; b: string[] }, n?: number) =>
	`<<<<<<< trunk${n ? ` (conflict ${n})` : ""}\n${closed(c.a.join(""))}||||||| base\n${closed(c.o.join(""))}=======\n${closed(c.b.join(""))}>>>>>>> attempt\n`;

/** Three-way line merge. `ours` wins position; conflicts come back as structured regions, and in `text` as marked blocks. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
	if (ours === theirs) return { clean: true, text: ours, regions: [] };
	if (ours === base) return { clean: true, text: theirs, regions: [] };
	if (theirs === base) return { clean: true, text: ours, regions: [] };
	const regions: ConflictRegion[] = [], all = parts(base, ours, theirs);
	let text = "", line = 1;
	all.forEach((part, i) => {
		if ("ok" in part) {
			text += part.ok.join("");
			line += part.ok.length;
		} else {
			const c = part.conflict, prev = all[i - 1], next = all[i + 1];
			regions.push({
				base: c.o.join(""), ours: c.a.join(""), theirs: c.b.join(""), oursLine: line,
				before: prev && "ok" in prev ? prev.ok.slice(-CONTEXT).join("") : "", after: next && "ok" in next ? next.ok.slice(0, CONTEXT).join("") : "",
			});
			text += block(c);
			line += c.a.length;
		}
	});
	return { clean: regions.length === 0, text, regions };
}

/**
 * The merged file with `pieces[i]` in place of the i-th conflict, and everything both sides agree on
 * (including each side's changes elsewhere in the file) kept as the merge has it.
 */
export function assemble(base: string, ours: string, theirs: string, pieces: string[]): string {
	let text = "", n = 0;
	for (const part of parts(base, ours, theirs)) {
		if ("ok" in part) { text += part.ok.join(""); continue; }
		const c = part.conflict, piece = pieces[n++] ?? "";
		// A replacement is whole lines, unless the conflict itself runs to the end of a file with no final newline.
		const wholeLines = [c.a, c.o, c.b].every((side) => side.length === 0 || side[side.length - 1].endsWith("\n"));
		text += wholeLines ? closed(piece) : piece;
	}
	return text;
}

/**
 * The merge as one text to read: numbered conflict blocks in place, with `around` agreed lines kept
 * on each side of them and the rest of a long file left out. Small enough to hand to a model whatever the file's size.
 */
export function markedView(base: string, ours: string, theirs: string, around = 40): string {
	const all = parts(base, ours, theirs);
	let text = "", n = 0;
	all.forEach((part, i) => {
		if (!("ok" in part)) { text += block(part.conflict, ++n); return; }
		const first = i === 0, last = i === all.length - 1, len = part.ok.length;
		const head = first ? 0 : around, tail = last ? 0 : around;
		if (len <= head + tail + 3) text += part.ok.join("");
		else text += `${part.ok.slice(0, head).join("")}… (${len - head - tail} lines the same on both sides) …\n${part.ok.slice(len - tail).join("")}`;
	});
	return text;
}

const DEPENDENCY_MAPS = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]);

/**
 * Three-way merge of a package.json by key instead of by line. Two agents that each add a dependency
 * touch neighbouring lines and conflict as text, though nothing about the two changes disagrees.
 * Returns null when the same key was changed two ways, or when a side is not valid JSON.
 */
export function mergeJson(base: string, ours: string, theirs: string): string | null {
	let b: unknown, o: unknown, t: unknown;
	try { b = JSON.parse(base || "{}"); o = JSON.parse(ours); t = JSON.parse(theirs); } catch { return null; }
	const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
	const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
	let stuck = false;
	const merge = (b: unknown, o: unknown, t: unknown, key?: string): unknown => {
		if (same(o, t) || same(b, t)) return o;
		if (same(b, o)) return t;
		if (!isObject(o) || !isObject(t)) { stuck = true; return o; }
		const from = isObject(b) ? b : {}, out: Record<string, unknown> = {};
		for (const k of [...Object.keys(o), ...Object.keys(t).filter((k) => !(k in o))]) {
			const inO = k in o, inT = k in t, inB = k in from;
			if (inO && inT) out[k] = merge(from[k], o[k], t[k], k);
			else if (!inB) out[k] = inO ? o[k] : t[k]; // added on one side
			else if (!same(from[k], inO ? o[k] : t[k])) stuck = true; // removed on one side, changed on the other
		}
		// Package managers keep these sorted; a merged one should look like one they wrote.
		return key && DEPENDENCY_MAPS.has(key) ? Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y))) : out;
	};
	const merged = merge(b, o, t);
	if (stuck) return null;
	return JSON.stringify(merged, null, /^([ \t]+)"/m.exec(ours)?.[1] ?? "\t") + (ours.endsWith("\n") ? "\n" : "");
}

/** Would these two versions of one file merge? null on either side means deleted (or binary). */
export function predict(base: string | null, ours: string | null, theirs: string | null): { conflict: boolean; regions: number } {
	if (ours === theirs) return { conflict: false, regions: 0 };
	if (ours === null || theirs === null || base === null) {
		// add/add with different content, or delete on one side and edit on the other
		const untouched = ours === base || theirs === base;
		return { conflict: !untouched, regions: untouched ? 0 : 1 };
	}
	const r = merge3(base, ours, theirs);
	return { conflict: !r.clean, regions: r.regions.length };
}
