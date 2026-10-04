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

export interface ConflictRegion { base: string; ours: string; theirs: string; oursLine: number }
export interface MergeResult { clean: boolean; text: string; regions: ConflictRegion[] }

const lines = (s: string) => (s === "" ? [] : s.split(/(?<=\n)/));

/** Three-way line merge. `ours` wins position; conflicts come back as structured regions, not markers. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
	if (ours === theirs) return { clean: true, text: ours, regions: [] };
	if (ours === base) return { clean: true, text: theirs, regions: [] };
	if (theirs === base) return { clean: true, text: ours, regions: [] };
	const regions: ConflictRegion[] = [];
	let text = "", line = 1;
	for (const part of diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true }) as any[]) {
		if (part.ok) {
			text += part.ok.join("");
			line += part.ok.length;
		} else {
			const c = part.conflict;
			regions.push({ base: c.o.join(""), ours: c.a.join(""), theirs: c.b.join(""), oursLine: line });
			text += `<<<<<<< ours\n${c.a.join("")}=======\n${c.b.join("")}>>>>>>> theirs\n`;
			line += c.a.length;
		}
	}
	return { clean: regions.length === 0, text, regions };
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
