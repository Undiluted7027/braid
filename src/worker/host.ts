// The only place that talks to Cloudflare Artifacts. Everything else goes through RepoHost.
// Reads use the Workers binding; writes go over the Git protocol (see land.ts).

export interface CommitMeta {
	hash: string;
	treeHash: string;
	message: string;
	author: { name: string; email: string };
	parents: string[];
	authoredAt: number;
}
export interface TreeEntry { name: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" | "gitlink" | "exec" }
export interface RepoRef { name: string; remote: string; token: string; defaultBranch: string }

export interface RepoHost {
	create(name: string, description?: string): Promise<RepoRef>;
	fork(source: string, name: string, description?: string): Promise<RepoRef>;
	importRepo(url: string, name: string, branch?: string): Promise<RepoRef>;
	remote(name: string): Promise<string>;
	token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<string>;
	log(name: string, ref: string, limit: number): Promise<CommitMeta[]>;
	readCommit(name: string, hash: string): Promise<CommitMeta | null>;
	readTree(name: string, hash: string): Promise<TreeEntry[] | null>;
	readBlob(name: string, hash: string): Promise<Uint8Array | null>;
	readFile(name: string, ref: string, path: string): Promise<Uint8Array | null>;
	remove(name: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ArtifactsHost implements RepoHost {
	private ns: Artifacts;
	constructor(ns: Artifacts) { this.ns = ns; }

	// Forks and creates are asynchronous; get() throws *_IN_PROGRESS until the repo is ready.
	private async open(name: string, waitMs = 10_000): Promise<ArtifactsRepo> {
		for (const deadline = Date.now() + waitMs; ; ) {
			try {
				return await this.ns.get(name);
			} catch (e) {
				const code = (e as ArtifactsError).code ?? "";
				if (!code.endsWith("_IN_PROGRESS") || Date.now() > deadline) throw e;
				await sleep(250);
			}
		}
	}
	private async with<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
		using repo = await this.open(name);
		return await fn(repo);
	}

	async create(name: string, description?: string) {
		const r = await this.ns.create(name, { description, setDefaultBranch: "main" });
		return { name: r.name, remote: r.remote, token: r.token, defaultBranch: r.defaultBranch };
	}
	async fork(source: string, name: string, description?: string) {
		const r = await this.with(source, (repo) => repo.fork(name, { description, defaultBranchOnly: true }));
		await this.with(name, (repo) => repo.info()); // wait until the fork is ready
		return { name: r.name, remote: r.remote, token: r.token, defaultBranch: r.defaultBranch };
	}
	async importRepo(url: string, name: string, branch?: string) {
		const r = await this.ns.import({ source: { url, branch }, target: { name } });
		using ready = await this.open(name, 120_000); // imports of real repositories take a while
		// The imported repo keeps its own default branch (often not "main").
		return { name: r.name, remote: r.remote, token: r.token, defaultBranch: (await ready.info()).defaultBranch };
	}
	remote(name: string) { return this.with(name, async (r) => (await r.info()).remote); }
	token(name: string, scope: "read" | "write", ttl: number) {
		return this.with(name, async (r) => (await r.createToken(scope, ttl)).plaintext);
	}
	log(name: string, ref: string, limit: number) { return this.with(name, (r) => r.log({ ref, limit })); }
	readCommit(name: string, hash: string) { return this.with(name, (r) => r.readCommit(hash)); }
	readTree(name: string, hash: string) { return this.with(name, (r) => r.readTree(hash)); }
	readBlob(name: string, hash: string) {
		return this.with(name, async (r) => {
			const b = await r.readBlob(hash);
			return b ? new Uint8Array(await b.arrayBuffer()) : null;
		});
	}
	readFile(name: string, ref: string, path: string) {
		return this.with(name, async (r) => {
			const b = await r.readFile({ ref, path });
			return b ? new Uint8Array(await b.arrayBuffer()) : null;
		});
	}
	async remove(name: string) { await this.ns.delete(name); }
}

/** Git Basic-auth callback for isomorphic-git. Artifacts tokens carry `?expires=`; the password is the secret only. */
export const gitAuth = (token: string) => () => ({ username: "x", password: token.split("?expires=")[0] });
