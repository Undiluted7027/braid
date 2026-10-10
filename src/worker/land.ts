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
export interface Prepared { ok: true; sha: string; parentSha: string; attemptSha: string; reconciled: string[]; combined: string[]; push(): Promise<void>; stage(writeToken: string): Promise<void> }
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
	/** Keep both sides where both only added lines at the same place (see mergeTrees). Only for merges that will be run before they land. */
	combining?: boolean;
}

/** The landing message with a line saying which files had both sides' additions kept, put before the trailers. */
export function withCombined(message: string, paths: string[]): string {
	if (!paths.length) return message;
	const line = `Combined: trunk and this attempt both added lines at the same place in ${paths.join(", ")}; both were kept, trunk's first.`;
	return /\n\nBraid-Intent:/.test(message) ? message.replace(/\n\nBraid-Intent:/, `\n\n${line}\n\nBraid-Intent:`) : `${message.trimEnd()}\n\n${line}`;
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
	const merged = await mergeTrees(repo, baseSha ? await treeOf(baseSha) : null, await treeOf(trunkSha), await treeOf(attemptSha), input.resolutions, input.combining);
	if (merged.conflicts.length) return { ok: false, reason: "conflict", trunkSha, attemptSha, conflicts: merged.conflicts };

	const who = { ...input.author, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
	const sha = await git.writeCommit({ fs, dir, commit: { message: `${withCombined(input.message, merged.combined).trimEnd()}\n`, tree: merged.tree, parent: [trunkSha, attemptSha], author: who, committer: who } });
	const send = async (url: string, token: string, ref: string, force: boolean) => {
		await git.writeRef({ fs, dir, ref: `refs/heads/${ref}`, value: sha, force: true });
		const push = await git.push({ fs, http, dir, url, ref, force, onAuth: gitAuth(token) });
		if (!push.ok) throw new Error(`push of ${ref} rejected: ${JSON.stringify(push.refs)}`);
	};
	return {
		ok: true, sha, parentSha: trunkSha, attemptSha, reconciled: merged.reconciled, combined: merged.combined,
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

/**
 * Take a landing back out of trunk: one new commit on top of trunk that undoes what the landing changed.
 * Later landings stay. If one of them changed the same lines, there is nothing safe to do and the files are returned.
 */
export async function revert(input: { branch: string; trunk: { remote: string; token: string }; sha: string; parentSha: string; message: string; author: Author }): Promise<{ ok: true; sha: string; parentSha: string } | { ok: false; conflicts: string[] }> {
	const { branch } = input;
	const fs = new MemoryFS(), repo = { fs, dir };
	await fs.promises.mkdir(dir);
	await git.init({ fs, dir, defaultBranch: branch });
	await git.addRemote({ fs, dir, remote: "trunk", url: input.trunk.remote });
	await git.fetch({ fs, http, dir, remote: "trunk", ref: branch, singleBranch: true, onAuth: gitAuth(input.trunk.token) });
	const head = await git.resolveRef({ fs, dir, ref: `refs/remotes/trunk/${branch}` });
	const treeOf = async (oid: string) => (await git.readCommit({ fs, dir, oid })).commit.tree;
	// Undoing a change is a merge where the change is the base and what came before it is the other side.
	const merged = await mergeTrees(repo, await treeOf(input.sha), await treeOf(head), await treeOf(input.parentSha), new Map());
	if (merged.conflicts.length) return { ok: false, conflicts: merged.conflicts.map((c) => c.path) };
	const who = { ...input.author, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
	const sha = await git.writeCommit({ fs, dir, commit: { message: `${input.message.trimEnd()}\n`, tree: merged.tree, parent: [head], author: who, committer: who } });
	await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: sha, force: true });
	const push = await git.push({ fs, http, dir, url: input.trunk.remote, ref: branch, onAuth: gitAuth(input.trunk.token) });
	if (!push.ok) throw new Error(`push to trunk rejected: ${JSON.stringify(push.refs)}`);
	return { ok: true, sha, parentSha: head };
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

export interface ChainMember {
	id: string;
	attempt: { remote: string; token: string };
	/** The attempt's commit this landing was asked for. */
	expect: string;
	message: string;
	author: Author;
	/** Reconciled file contents. Only the first member may carry any: they were written against trunk as it is. */
	resolutions: Map<string, string>;
}
export type ChainStep =
	| { id: string; ok: true; sha: string; parentSha: string; attemptSha: string; reconciled: string[]; combined: string[]; sameTree: boolean }
	| { id: string; ok: false; reason: "conflict"; againstTrunk: boolean; onto: string; attemptSha: string; conflicts: MergeConflict[] }
	| { id: string; ok: false; reason: "nothing-to-land" }
	| { id: string; ok: false; reason: "moved"; found: string };
export type Chain =
	| { ok: false; reason: "moved"; found: string }
	| { ok: true; trunkSha: string; steps: ChainStep[]; tip: string | null; push(): Promise<void>; stage(remote: string, token: string, ref: string): Promise<void> };

/**
 * Merge several attempts into trunk one after another, each on top of the one before: trunk + A, that + B,
 * that + C. Every step is the landing commit that attempt would have had landing in that order, so running
 * the last one runs them all together, and trunk can move to any step. A member that conflicts with what is
 * ahead of it, has moved, or adds nothing is left out and the chain goes on without it. Nothing is pushed yet.
 */
export async function chain(input: { branch: string; trunk: { remote: string; token: string }; expectTrunk: string; members: ChainMember[]; combining?: boolean }): Promise<Chain> {
	const { branch } = input;
	const fs = new MemoryFS(), repo = { fs, dir };
	await fs.promises.mkdir(dir);
	await git.init({ fs, dir, defaultBranch: branch });
	await git.addRemote({ fs, dir, remote: "trunk", url: input.trunk.remote });
	await git.fetch({ fs, http, dir, remote: "trunk", ref: branch, singleBranch: true, onAuth: gitAuth(input.trunk.token) });
	const trunkSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/trunk/${branch}` });
	if (trunkSha !== input.expectTrunk) return { ok: false, reason: "moved", found: trunkSha };
	const treeOf = async (oid: string) => (await git.readCommit({ fs, dir, oid })).commit.tree;

	const steps: ChainStep[] = [];
	let onto = trunkSha;
	for (const [i, m] of input.members.entries()) {
		const remote = `m${i}`;
		await git.addRemote({ fs, dir, remote, url: m.attempt.remote });
		await git.fetch({ fs, http, dir, remote, ref: branch, singleBranch: true, onAuth: gitAuth(m.attempt.token) });
		const attemptSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/${remote}/${branch}` });
		if (attemptSha !== m.expect) { steps.push({ id: m.id, ok: false, reason: "moved", found: attemptSha }); continue; }
		if (onto === attemptSha || await git.isDescendent({ fs, dir, oid: onto, ancestor: attemptSha, depth: -1 })) { steps.push({ id: m.id, ok: false, reason: "nothing-to-land" }); continue; }
		const baseSha = ((await git.findMergeBase({ fs, dir, oids: [onto, attemptSha] })) as string[])[0];
		const merged = await mergeTrees(repo, baseSha ? await treeOf(baseSha) : null, await treeOf(onto), await treeOf(attemptSha), m.resolutions, input.combining);
		if (merged.conflicts.length) { steps.push({ id: m.id, ok: false, reason: "conflict", againstTrunk: onto === trunkSha, onto, attemptSha, conflicts: merged.conflicts }); continue; }
		const who = { ...m.author, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
		const sha = await git.writeCommit({ fs, dir, commit: { message: `${withCombined(m.message, merged.combined).trimEnd()}\n`, tree: merged.tree, parent: [onto, attemptSha], author: who, committer: who } });
		// An attempt that started from exactly the commit it lands on merges to its own tree, which has already been run.
		steps.push({ id: m.id, ok: true, sha, parentSha: onto, attemptSha, reconciled: merged.reconciled, combined: merged.combined, sameTree: baseSha === onto && merged.reconciled.length === 0 });
		onto = sha;
	}
	const tip = onto === trunkSha ? null : onto;
	const send = async (url: string, token: string, ref: string, force: boolean) => {
		if (!tip) return;
		await git.writeRef({ fs, dir, ref: `refs/heads/${ref}`, value: tip, force: true });
		const push = await git.push({ fs, http, dir, url, ref, force, onAuth: gitAuth(token) });
		if (!push.ok) throw new Error(`push of ${ref} rejected: ${JSON.stringify(push.refs)}`);
	};
	return { ok: true, trunkSha, steps, tip, push: () => send(input.trunk.remote, input.trunk.token, branch, false), 
		// The staging repository's own branch is moved too: a repository whose HEAD names no commit cannot be fetched from.
		stage: async (remote, token, ref) => { await send(remote, token, ref, true); await send(remote, token, branch, true); },
	};
}

/**
 * Move trunk to a commit of a chain that was parked under `ref` on the staging repository: the tip, or
 * any step before it. Trunk only moves forward: if it is no longer where the chain was built from, nothing happens.
 */
export async function promoteFrom(input: { branch: string; trunk: { remote: string; token: string }; staging: { remote: string; token: string; ref: string }; sha: string; parentSha: string }): Promise<{ ok: true } | { ok: false; found: string }> {
	const { branch } = input;
	const fs = new MemoryFS();
	await fs.promises.mkdir(dir);
	await git.init({ fs, dir, defaultBranch: branch });
	await git.addRemote({ fs, dir, remote: "trunk", url: input.trunk.remote });
	await git.addRemote({ fs, dir, remote: "staging", url: input.staging.remote });
	await git.fetch({ fs, http, dir, remote: "trunk", ref: branch, singleBranch: true, onAuth: gitAuth(input.trunk.token) });
	const trunkSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/trunk/${branch}` });
	if (trunkSha === input.sha) return { ok: true };
	if (trunkSha !== input.parentSha) return { ok: false, found: trunkSha };
	await git.fetch({ fs, http, dir, remote: "staging", ref: input.staging.ref, singleBranch: true, onAuth: gitAuth(input.staging.token) });
	// The commit asked for must be in what was parked, and must stand on the trunk it was built from.
	const parked = await git.resolveRef({ fs, dir, ref: `refs/remotes/staging/${input.staging.ref}` });
	if (parked !== input.sha && !(await git.isDescendent({ fs, dir, oid: parked, ancestor: input.sha, depth: -1 }))) return { ok: false, found: trunkSha };
	if (!(await git.isDescendent({ fs, dir, oid: input.sha, ancestor: trunkSha, depth: -1 }))) return { ok: false, found: trunkSha };
	await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: input.sha, force: true });
	const push = await git.push({ fs, http, dir, url: input.trunk.remote, ref: branch, onAuth: gitAuth(input.trunk.token) });
	if (!push.ok) throw new Error(`push to trunk rejected: ${JSON.stringify(push.refs)}`);
	return { ok: true };
}
