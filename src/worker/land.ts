// Writes to Artifacts. The binding is read-only, so landing clones nothing to disk:
// it fetches trunk and the attempt into an in-memory repo, merges by full path, and pushes over Git.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memfs";
import { gitAuth } from "./host";
import { mergeTrees, type MergeConflict } from "./merge.ts";
export { mergeTrees, type MergeConflict };

const dir = "/repo";
type Author = { name: string; email: string };

/** A merge that is ready but has not moved anything: `push` puts it on trunk, `stage` parks it on the attempt's repository to be verified first. */
export interface Prepared { ok: true; sha: string; parentSha: string; attemptSha: string; reconciled: string[]; push(): Promise<void>; stage(writeToken: string): Promise<void> }
export type LandResult =
	| Prepared
	| { ok: false; reason: "conflict"; trunkSha: string; attemptSha: string; conflicts: MergeConflict[] }
	| { ok: false; reason: "nothing-to-land"; trunkSha: string }
	| { ok: false; reason: "moved"; what: "trunk" | "attempt"; expected: string; found: string };

/** Where a merged commit waits, on the attempt's repository, while it is verified. */
export const CANDIDATE = "braid-candidate";

export interface LandInput {
	/** Trunk's branch name; attempts are forks, so they share it. */
	branch: string;
	trunk: { remote: string; token: string };
	attempt: { remote: string; token: string };
	message: string;
	author: Author;
	/** Reconciled file contents, keyed by path. Used instead of a textual merge for that file. */
	resolutions: Map<string, string>;
	/** The commits this landing was decided on. If either side has moved, nothing is merged. */
	expect?: { trunk?: string; attempt?: string };
}

/** Merge an attempt into trunk as one landing commit (parents: trunk head, attempt head), without pushing it anywhere yet. */
export async function prepare(input: LandInput): Promise<LandResult> {
	const { branch } = input;
	const fs = new MemoryFS(), repo = { fs, dir };
	await fs.promises.mkdir(dir);
	await git.init({ fs, dir, defaultBranch: branch });
	await git.addRemote({ fs, dir, remote: "trunk", url: input.trunk.remote });
	await git.addRemote({ fs, dir, remote: "attempt", url: input.attempt.remote });
	await git.fetch({ fs, http, dir, remote: "trunk", ref: branch, singleBranch: true, onAuth: gitAuth(input.trunk.token) });
	await git.fetch({ fs, http, dir, remote: "attempt", ref: branch, singleBranch: true, onAuth: gitAuth(input.attempt.token) });
	const trunkSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/trunk/${branch}` });
	const attemptSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/attempt/${branch}` });
	if (input.expect?.trunk && input.expect.trunk !== trunkSha) return { ok: false, reason: "moved", what: "trunk", expected: input.expect.trunk, found: trunkSha };
	if (input.expect?.attempt && input.expect.attempt !== attemptSha) return { ok: false, reason: "moved", what: "attempt", expected: input.expect.attempt, found: attemptSha };
	if (await git.isDescendent({ fs, dir, oid: trunkSha, ancestor: attemptSha, depth: -1 }) || trunkSha === attemptSha) {
		return { ok: false, reason: "nothing-to-land", trunkSha };
	}

	const treeOf = async (oid: string) => (await git.readCommit({ fs, dir, oid })).commit.tree;
	const baseSha = ((await git.findMergeBase({ fs, dir, oids: [trunkSha, attemptSha] })) as string[])[0];
	const merged = await mergeTrees(repo, baseSha ? await treeOf(baseSha) : null, await treeOf(trunkSha), await treeOf(attemptSha), input.resolutions);
	if (merged.conflicts.length) return { ok: false, reason: "conflict", trunkSha, attemptSha, conflicts: merged.conflicts };

	const who = { ...input.author, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
	const sha = await git.writeCommit({ fs, dir, commit: { message: `${input.message.trimEnd()}\n`, tree: merged.tree, parent: [trunkSha, attemptSha], author: who, committer: who } });
	const send = async (url: string, token: string, ref: string, force: boolean) => {
		await git.writeRef({ fs, dir, ref: `refs/heads/${ref}`, value: sha, force: true });
		const push = await git.push({ fs, http, dir, url, ref, force, onAuth: gitAuth(token) });
		if (!push.ok) throw new Error(`push of ${ref} rejected: ${JSON.stringify(push.refs)}`);
	};
	return {
		ok: true, sha, parentSha: trunkSha, attemptSha, reconciled: merged.reconciled,
		push: () => send(input.trunk.remote, input.trunk.token, branch, false),
		stage: (writeToken) => send(input.attempt.remote, writeToken, CANDIDATE, true),
	};
}

/**
 * Move trunk to a commit that was staged on the attempt's repository and has since been verified.
 * Trunk only moves forward: if it is no longer where the commit was built from, nothing happens.
 */
export async function promote(input: { branch: string; trunk: { remote: string; token: string }; attempt: { remote: string; token: string }; sha: string; parentSha: string }): Promise<{ ok: true } | { ok: false; found: string }> {
	const { branch } = input;
	const fs = new MemoryFS();
	await fs.promises.mkdir(dir);
	await git.init({ fs, dir, defaultBranch: branch });
	await git.addRemote({ fs, dir, remote: "trunk", url: input.trunk.remote });
	await git.addRemote({ fs, dir, remote: "attempt", url: input.attempt.remote });
	await git.fetch({ fs, http, dir, remote: "trunk", ref: branch, singleBranch: true, onAuth: gitAuth(input.trunk.token) });
	const trunkSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/trunk/${branch}` });
	if (trunkSha === input.sha) return { ok: true };
	if (trunkSha !== input.parentSha) return { ok: false, found: trunkSha };
	await git.fetch({ fs, http, dir, remote: "attempt", ref: CANDIDATE, singleBranch: true, onAuth: gitAuth(input.attempt.token) });
	const staged = await git.resolveRef({ fs, dir, ref: `refs/remotes/attempt/${CANDIDATE}` });
	if (staged !== input.sha) return { ok: false, found: trunkSha };
	await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: staged, force: true });
	const push = await git.push({ fs, http, dir, url: input.trunk.remote, ref: branch, onAuth: gitAuth(input.trunk.token) });
	if (!push.ok) throw new Error(`push to trunk rejected: ${JSON.stringify(push.refs)}`);
	return { ok: true };
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
