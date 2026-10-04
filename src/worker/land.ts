// Writes to Artifacts. The binding is read-only, so landing clones nothing to disk:
// it fetches trunk and the attempt into an in-memory repo, merges, and pushes over Git.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memfs";
import { gitAuth } from "./host";
import { merge3, type ConflictRegion } from "./gitops";

const dir = "/repo";
type Author = { name: string; email: string };

export interface MergeConflict { path: string; kind: "content" | "delete"; base: string | null; trunk: string | null; attempt: string | null; regions: ConflictRegion[] }
export type LandResult =
	| { ok: true; sha: string; parentSha: string; reconciled: string[] }
	| { ok: false; reason: "conflict"; trunkSha: string; conflicts: MergeConflict[] }
	| { ok: false; reason: "nothing-to-land"; trunkSha: string };

export interface LandInput {
	/** Trunk's branch name; attempts are forks, so they share it. */
	branch: string;
	trunk: { remote: string; token: string };
	attempt: { remote: string; token: string };
	message: string;
	author: Author;
	/** Reconciled file contents, keyed by path. Used instead of a textual merge for that file. */
	resolutions: Map<string, string>;
}

/** Merge an attempt into trunk as one landing commit (parents: trunk head, attempt head) and push it. */
export async function land(input: LandInput): Promise<LandResult> {
	const { branch } = input;
	const fs = new MemoryFS();
	await fs.promises.mkdir(dir);
	await git.init({ fs, dir, defaultBranch: branch });
	await git.addRemote({ fs, dir, remote: "trunk", url: input.trunk.remote });
	await git.addRemote({ fs, dir, remote: "attempt", url: input.attempt.remote });
	await git.fetch({ fs, http, dir, remote: "trunk", ref: branch, singleBranch: true, onAuth: gitAuth(input.trunk.token) });
	await git.fetch({ fs, http, dir, remote: "attempt", ref: branch, singleBranch: true, onAuth: gitAuth(input.attempt.token) });
	const trunkSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/trunk/${branch}` });
	const attemptSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/attempt/${branch}` });
	if (await git.isDescendent({ fs, dir, oid: trunkSha, ancestor: attemptSha, depth: -1 }) || trunkSha === attemptSha) {
		return { ok: false, reason: "nothing-to-land", trunkSha };
	}
	await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: trunkSha, force: true });

	// isomorphic-git gives the merge driver a file's name without its folder, so a file is identified
	// by its name together with both sides' contents, and its full path is looked up from those.
	const text = async (oid: string, filepath: string) => {
		try { return new TextDecoder().decode((await git.readBlob({ fs, dir, oid, filepath })).blob); } catch { return null; }
	};
	const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
	const sides = async (path: string) => ({ path, trunk: await text(trunkSha, path), attempt: await text(attemptSha, path) });
	const resolved = await Promise.all([...input.resolutions.keys()].map(sides));
	const conflicts: MergeConflict[] = [];
	const reconciled: string[] = [];
	try {
		const merged = await git.merge({
			fs, dir, ours: branch, theirs: `refs/remotes/attempt/${branch}`,
			fastForward: false, abortOnConflict: true,
			message: input.message, author: input.author, committer: input.author,
			mergeDriver: ({ contents, path }) => {
				const [base, trunk, attempt] = contents;
				const hit = resolved.find((r) => name(r.path) === path && r.trunk === trunk && r.attempt === attempt);
				if (hit) {
					reconciled.push(hit.path);
					return { cleanMerge: true, mergedText: input.resolutions.get(hit.path)! };
				}
				const r = merge3(base, trunk, attempt);
				if (!r.clean) conflicts.push({ path, kind: "content", base, trunk, attempt, regions: r.regions });
				return { cleanMerge: r.clean, mergedText: r.text };
			},
		});
		const sha = merged.oid!;
		const push = await git.push({ fs, http, dir, url: input.trunk.remote, ref: branch, onAuth: gitAuth(input.trunk.token) });
		if (!push.ok) throw new Error(`push to trunk rejected: ${JSON.stringify(push.refs)}`);
		return { ok: true, sha, parentSha: trunkSha, reconciled };
	} catch (e: any) {
		if (e?.code !== "MergeConflictError") throw e;
		for (const full of await Promise.all(((e.data?.bothModified ?? []) as string[]).map(sides))) {
			const c = conflicts.find((c) => c.path === name(full.path) && c.trunk === full.trunk && c.attempt === full.attempt);
			if (c) c.path = full.path;
		}
		// One side deleted a file the other edited: there is no text to merge.
		for (const path of [...(e.data?.deleteByUs ?? []), ...(e.data?.deleteByTheirs ?? [])]) {
			conflicts.push({ path, kind: "delete", base: null, trunk: null, attempt: null, regions: [] });
		}
		return { ok: false, reason: "conflict", trunkSha, conflicts };
	}
}

/** Create the first commit of a new repo from a set of files. */
export async function seed(remote: string, token: string, files: Record<string, string>, message: string, author: Author): Promise<string> {
	const fs = new MemoryFS();
	await fs.promises.mkdir(dir);
	await git.init({ fs, dir, defaultBranch: "main" });
	for (const [path, content] of Object.entries(files)) {
		const parent = `${dir}/${path}`.slice(0, `${dir}/${path}`.lastIndexOf("/"));
		await fs.promises.mkdir(parent, { recursive: true });
		await fs.promises.writeFile(`${dir}/${path}`, content);
		await git.add({ fs, dir, filepath: path });
	}
	const sha = await git.commit({ fs, dir, message, author });
	const push = await git.push({ fs, http, dir, url: remote, ref: "main", onAuth: gitAuth(token) });
	if (!push.ok) throw new Error(`seed push rejected: ${JSON.stringify(push.refs)}`);
	return sha;
}

/** Add or replace files in a repo as one commit on `branch`, creating the branch if the repo is empty. */
export async function commitFiles(remote: string, token: string, branch: string, files: Record<string, string>, message: string, author: Author, empty: boolean): Promise<string> {
	const fs = new MemoryFS();
	await fs.promises.mkdir(dir);
	if (empty) await git.init({ fs, dir, defaultBranch: branch });
	else await git.clone({ fs, http, dir, url: remote, ref: branch, singleBranch: true, depth: 1, onAuth: gitAuth(token) });
	for (const [path, content] of Object.entries(files)) {
		const full = `${dir}/${path}`;
		await fs.promises.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
		await fs.promises.writeFile(full, content);
		await git.add({ fs, dir, filepath: path });
	}
	const sha = await git.commit({ fs, dir, message, author });
	const push = await git.push({ fs, http, dir, url: remote, ref: branch, onAuth: gitAuth(token) });
	if (!push.ok) throw new Error(`push rejected: ${JSON.stringify(push.refs)}`);
	return sha;
}
