// Three-way merge of git trees, by full path. Kept free of Worker-only imports so the tests can run it under Node.
import git from "isomorphic-git";
import { merge3, mergeJson, type ConflictRegion } from "./gitops.ts";

export interface MergeConflict { path: string; kind: "content" | "delete"; base: string | null; trunk: string | null; attempt: string | null; regions: ConflictRegion[] }
type Entry = { mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" };
type Repo = { fs: any; dir: string };

/**
 * Three-way merge of two trees by full path. A file both sides changed is merged as text, or taken
 * from `resolutions`. Returns the merged tree, or the conflicts if any file could not be merged.
 */
export async function mergeTrees(repo: Repo, base: string | null, trunk: string, attempt: string, resolutions: Map<string, string>) {
	const conflicts: MergeConflict[] = [], reconciled: string[] = [];
	const entries = async (oid: string | null) => new Map<string, Entry>(oid ? (await git.readTree({ ...repo, oid })).tree.map((e) => [e.path, e as Entry]) : []);
	const text = async (e: Entry | undefined) => {
		if (!e) return "";
		const bytes = (await git.readBlob({ ...repo, oid: e.oid })).blob;
		return bytes.includes(0) ? null : new TextDecoder().decode(bytes);
	};
	const same = (x?: Entry, y?: Entry) => x?.oid === y?.oid && x?.mode === y?.mode;
	const tree = (e?: Entry) => (e?.type === "tree" ? e.oid : null);

	const merge = async (b: string | null, o: string | null, t: string | null, prefix: string): Promise<string | null> => {
		const [eb, eo, et] = await Promise.all([entries(b), entries(o), entries(t)]);
		const out: Entry[] = [];
		for (const name of [...new Set([...eo.keys(), ...et.keys()])].sort()) {
			const [x, y, z] = [eb.get(name), eo.get(name), et.get(name)], path = prefix + name;
			let pick: Entry | undefined;
			if (same(y, z) || same(x, z)) pick = y;
			else if (same(x, y)) pick = z;
			else if (y?.type === "tree" && z?.type === "tree") {
				const oid = await merge(tree(x), y.oid, z.oid, `${path}/`);
				pick = oid ? { ...y, oid } : undefined;
			} else if (y?.type === "blob" && z?.type === "blob" && (!x || x.type === "blob")) {
				const [base, ours, theirs] = [await text(x), await text(y), await text(z)];
				const resolved = resolutions.get(path);
				let merged: string | null = null;
				if (resolved !== undefined) { merged = resolved; reconciled.push(path); }
				else if (base === null || ours === null || theirs === null) conflicts.push({ path, kind: "delete", base: null, trunk: null, attempt: null, regions: [] });
				else {
					const r = merge3(base, ours, theirs);
					if (r.clean) merged = r.text;
					else if (name === "package.json" && (merged = mergeJson(base, ours, theirs)) !== null) {}
					else conflicts.push({ path, kind: "content", base, trunk: ours, attempt: theirs, regions: r.regions });
				}
				// The side that changed the mode (made it executable, say) keeps it.
				pick = merged === null ? y : { ...y, mode: x && x.mode !== z.mode ? z.mode : y.mode, oid: await git.writeBlob({ ...repo, blob: new TextEncoder().encode(merged) }) };
			} else {
				// One side deleted or replaced what the other edited: there is no text to merge.
				conflicts.push({ path, kind: "delete", base: null, trunk: null, attempt: null, regions: [] });
				pick = y;
			}
			if (pick) out.push({ ...pick, path: name });
		}
		return out.length ? git.writeTree({ ...repo, tree: out }) : null;
	};
	const empty = () => git.writeTree({ ...repo, tree: [] });
	return { tree: trunk === attempt ? trunk : (await merge(base, trunk, attempt, "")) ?? (await empty()), conflicts, reconciled };
}
