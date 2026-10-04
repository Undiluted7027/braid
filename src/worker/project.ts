// One Durable Object per project. It owns the project's coordination state (intents,
// attempts, the why-log, overlaps, reconciliations) and is the only writer to trunk.
import { DurableObject } from "cloudflare:workers";
import { diffArrays } from "diff";
import { ArtifactsHost, type CommitMeta, type RepoHost } from "./host";
import { asText, diffTrees, listTree, mergeBase, predict } from "./gitops";
import { land, seed } from "./land";
import { llmName, resolveConflicts } from "./resolver";
import { DEMO_FILES } from "./template";
import type {
	Activity, Attempt, BlameLine, Check, Conflict, ConflictContext, Decision, DecisionKind, DiffFile, FileView,
	Intent, JoinResult, Landing, Overlap, Reconciliation, State,
} from "../shared/types";

export type BraidEnv = Env & { ANTHROPIC_API_KEY?: string; BRAID_MODEL?: string; BRAID_ADMIN_TOKEN?: string };

const LIVE = new Set(["working", "ready", "conflicted"]);
const RANK = { claim: 1, touch: 2, conflict: 3 } as const;
const MAX_TEXT = 400_000;
const now = () => Date.now();
const short = (sha: string) => sha.slice(0, 7);
const json = (v: unknown) => JSON.stringify(v);

/** An error the caller caused. The status rides in the message because only the message survives an RPC hop. */
export class BraidError extends Error {
	constructor(message: string, status = 400) { super(`[${status}] ${message}`); }
}
export function splitError(e: unknown): { status: number; message: string } {
	const text = String((e as Error)?.message ?? e);
	const m = /\[(\d{3})\] ([\s\S]*)$/.exec(text);
	return m ? { status: Number(m[1]), message: m[2] } : { status: 500, message: text };
}

function claimMatches(pattern: string, path: string) {
	const p = pattern.replace(/\*+$/, "").replace(/\/$/, "");
	return p === "" || path === p || path.startsWith(p + "/") || (pattern.endsWith("*") && path.startsWith(p));
}

export class Project extends DurableObject<BraidEnv> {
	private sql = this.ctx.storage.sql;
	private host: RepoHost = new ArtifactsHost(this.env.ARTIFACTS);
	private queue: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: BraidEnv) {
		super(ctx, env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
			CREATE TABLE IF NOT EXISTS registry (slug TEXT PRIMARY KEY, name TEXT, description TEXT, created_at INTEGER);
			CREATE TABLE IF NOT EXISTS intents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, goal TEXT, acceptance TEXT, status TEXT,
				created_by TEXT, created_at INTEGER, landed_sha TEXT, landed_attempt TEXT);
			CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, intent_id INTEGER, agent TEXT, kind TEXT, repo TEXT, remote TEXT, token TEXT,
				base_sha TEXT, head_sha TEXT, trunk_seen TEXT, status TEXT, summary TEXT, files TEXT, claims TEXT, behind INTEGER,
				trunk_conflicts TEXT, checks TEXT, created_at INTEGER, updated_at INTEGER);
			CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT, intent_id INTEGER, agent TEXT, kind TEXT,
				title TEXT, body TEXT, files TEXT, sha TEXT, at INTEGER);
			CREATE TABLE IF NOT EXISTS overlaps (a TEXT, b TEXT, path TEXT, severity TEXT, regions INTEGER, PRIMARY KEY (a, b, path));
			CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, to_attempt TEXT, kind TEXT, body TEXT, at INTEGER, seen INTEGER DEFAULT 0);
			CREATE TABLE IF NOT EXISTS reconciliations (id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT, intent_id INTEGER, status TEXT, trunk_sha TEXT,
				conflicts TEXT, resolutions TEXT, rationale TEXT, resolved_by TEXT, at INTEGER);
			CREATE TABLE IF NOT EXISTS landings (sha TEXT PRIMARY KEY, parent_sha TEXT, intent_id INTEGER, attempt_id TEXT, agent TEXT, title TEXT,
				files TEXT, reconciled INTEGER, at INTEGER);
			CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, actor TEXT, text TEXT, intent_id INTEGER, attempt_id TEXT);
		`);
	}

	// ── storage helpers ──────────────────────────────────────────────────────

	private rows<T = any>(query: string, ...args: any[]): T[] { return this.sql.exec(query, ...args).toArray() as T[]; }
	private meta(k: string): string { return this.rows<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0]?.v ?? ""; }
	private setMeta(k: string, v: string) { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v); }
	private get trunk() { return this.meta("repo"); }
	/** Trunk's branch. Imported repositories keep their own default branch; attempts are forks and share it. */
	private get branch() { return this.meta("branch") || "main"; }
	private requireProject() { if (!this.trunk) throw new BraidError("project not found", 404); }

	/** Run one mutation at a time. Git and Artifacts calls yield, so the DO's input gate alone is not enough. */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	private toIntent = (r: any): Intent => ({
		id: r.id, title: r.title, goal: r.goal, acceptance: r.acceptance, status: r.status, createdBy: r.created_by,
		createdAt: r.created_at, landedSha: r.landed_sha, landedAttempt: r.landed_attempt,
	});
	private toAttempt = (r: any): Attempt => ({
		id: r.id, intentId: r.intent_id, agent: r.agent, kind: r.kind, repo: r.repo, remote: r.remote, baseSha: r.base_sha, headSha: r.head_sha,
		status: r.status, summary: r.summary, files: JSON.parse(r.files), claims: JSON.parse(r.claims), behind: r.behind,
		trunkConflicts: JSON.parse(r.trunk_conflicts), checks: JSON.parse(r.checks), createdAt: r.created_at, updatedAt: r.updated_at,
	});
	private toDecision = (r: any): Decision => ({
		id: r.id, attemptId: r.attempt_id, intentId: r.intent_id, agent: r.agent, kind: r.kind, title: r.title, body: r.body,
		files: JSON.parse(r.files), sha: r.sha, at: r.at,
	});
	private toRecon = (r: any): Reconciliation => ({
		id: r.id, attemptId: r.attempt_id, intentId: r.intent_id, status: r.status, trunkSha: r.trunk_sha, conflicts: JSON.parse(r.conflicts),
		resolutions: JSON.parse(r.resolutions), rationale: r.rationale, resolvedBy: r.resolved_by, at: r.at,
	});
	private toLanding = (r: any): Landing => ({
		sha: r.sha, parentSha: r.parent_sha, intentId: r.intent_id, attemptId: r.attempt_id, agent: r.agent, title: r.title,
		files: JSON.parse(r.files), reconciled: !!r.reconciled, at: r.at,
	});

	private intents() { return this.rows("SELECT * FROM intents ORDER BY id").map(this.toIntent); }
	private attempts() { return this.rows("SELECT * FROM attempts ORDER BY created_at").map(this.toAttempt); }
	private landings() { return this.rows("SELECT * FROM landings ORDER BY at").map(this.toLanding); }
	private intent(id: number) {
		const r = this.rows("SELECT * FROM intents WHERE id = ?", id)[0];
		if (!r) throw new BraidError(`intent ${id} not found`, 404);
		return this.toIntent(r);
	}
	private attempt(id: string) {
		const r = this.rows("SELECT * FROM attempts WHERE id = ?", id)[0];
		if (!r) throw new BraidError(`attempt ${id} not found`, 404);
		return this.toAttempt(r);
	}
	private decisionsFor(attemptId: string) {
		return this.rows("SELECT * FROM decisions WHERE attempt_id = ? ORDER BY id", attemptId).map(this.toDecision);
	}
	private saveAttempt(a: Attempt) {
		this.sql.exec(
			"UPDATE attempts SET base_sha=?, head_sha=?, status=?, summary=?, files=?, claims=?, behind=?, trunk_conflicts=?, checks=?, updated_at=? WHERE id=?",
			a.baseSha, a.headSha, a.status, a.summary, json(a.files), json(a.claims), a.behind, json(a.trunkConflicts), json(a.checks), now(), a.id,
		);
	}

	private note(kind: string, actor: string, text: string, intentId: number | null = null, attemptId: string | null = null) {
		this.sql.exec("INSERT INTO activity (at, kind, actor, text, intent_id, attempt_id) VALUES (?, ?, ?, ?, ?, ?)", now(), kind, actor, text, intentId, attemptId);
		this.broadcast();
	}
	private signal(to: string, kind: string, body: unknown) {
		this.sql.exec("INSERT INTO signals (to_attempt, kind, body, at) VALUES (?, ?, ?, ?)", to, kind, json(body), now());
	}
	private broadcast() {
		for (const ws of this.ctx.getWebSockets()) {
			try { ws.send("changed"); } catch {}
		}
	}

	// ── live updates ─────────────────────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
	webSocketMessage() {}
	webSocketClose(ws: WebSocket) { try { ws.close(); } catch {} }

	// ── registry (the instance named "~registry" lists projects) ─────────────

	async listProjects() { return this.rows("SELECT slug, name, description, created_at AS createdAt FROM registry ORDER BY created_at DESC"); }
	async registerProject(slug: string, name: string, description: string) {
		if (this.rows("SELECT 1 FROM registry WHERE slug = ?", slug).length) throw new BraidError(`project "${slug}" already exists`, 409);
		this.sql.exec("INSERT INTO registry (slug, name, description, created_at) VALUES (?, ?, ?, ?)", slug, name, description, now());
	}
	async unregisterProject(slug: string) { this.sql.exec("DELETE FROM registry WHERE slug = ?", slug); }

	// ── project lifecycle ────────────────────────────────────────────────────

	/**
	 * Create the trunk repo. `starter` seeds a small demo app, `import` copies an existing
	 * git repository, and `empty` waits for a first push (see trunkCredentials).
	 */
	async init(input: { slug: string; name: string; description: string; source?: "starter" | "empty" | "import"; url?: string; branch?: string }) {
		if (this.trunk) throw new BraidError("project already exists", 409);
		const repo = `${input.slug}--trunk`;
		// This project has no state, so a repo with its trunk name is left over from a failed create. Clear it.
		await this.host.remove(repo).catch(() => {});
		const source = input.source ?? "starter";
		let remote: string, head = "", branch = "main";
		if (source === "import") {
			if (!input.url) throw new BraidError("import needs a repository URL");
			const imported = await this.host.importRepo(input.url, repo, input.branch);
			remote = imported.remote;
			// The reported default branch is not always the one that was imported, so look for commits.
			const tried: string[] = [];
			for (const candidate of [...new Set([input.branch, imported.defaultBranch, "main", "master"].filter(Boolean) as string[])]) {
				tried.push(candidate);
				head = (await this.host.log(repo, candidate, 1))[0]?.hash ?? "";
				if (head) { branch = candidate; break; }
			}
			if (!head) {
				await this.host.remove(repo).catch(() => {});
				throw new BraidError(`imported ${input.url} but found no commits on ${tried.join(", ")}; pass the branch to import`);
			}
		} else {
			const created = await this.host.create(repo, `Braid trunk for ${input.name}`);
			remote = created.remote;
			if (source === "starter") head = await seed(created.remote, created.token, DEMO_FILES, "Seed project", { name: "Braid", email: "seed@braid.dev" });
		}
		this.setMeta("slug", input.slug);
		this.setMeta("name", input.name);
		this.setMeta("description", input.description);
		this.setMeta("repo", repo);
		this.setMeta("remote", remote);
		this.setMeta("branch", branch);
		this.setMeta("head", head);
		this.note("project", "braid", head ? `Project created with trunk ${repo} at ${short(head)}` : `Project created with an empty trunk ${repo}; waiting for a first push`);
	}

	/** A short-lived write credential for trunk, for pushing a first commit into an empty project. */
	async trunkCredentials() {
		this.requireProject();
		return { remote: this.meta("remote"), branch: this.branch, gitToken: await this.host.token(this.trunk, "write", 900) };
	}

	async destroy() {
		this.requireProject();
		for (const repo of [this.trunk, ...this.attempts().map((a) => a.repo)]) {
			try { await this.host.remove(repo); } catch {}
		}
		await this.ctx.storage.deleteAll();
	}

	async state(): Promise<State> {
		this.requireProject();
		return {
			project: {
				slug: this.meta("slug"), name: this.meta("name"), description: this.meta("description"),
				repo: this.trunk, remote: this.meta("remote"), branch: this.branch, head: this.meta("head"), llm: llmName(this.env),
			},
			intents: this.intents(),
			attempts: this.attempts(),
			decisions: this.rows("SELECT * FROM decisions ORDER BY id").map(this.toDecision),
			overlaps: this.rows<Overlap>("SELECT a, b, path, severity, regions FROM overlaps"),
			reconciliations: this.rows("SELECT * FROM reconciliations ORDER BY id").map(this.toRecon),
			landings: this.landings(),
			activity: this.rows<any>("SELECT * FROM activity ORDER BY id DESC LIMIT 200").map((r): Activity => ({
				id: r.id, at: r.at, kind: r.kind, actor: r.actor, text: r.text, intentId: r.intent_id, attemptId: r.attempt_id,
			})),
		};
	}

	// ── intents and attempts ─────────────────────────────────────────────────

	async createIntent(input: { title: string; goal: string; acceptance?: string; by?: string }): Promise<Intent> {
		this.requireProject();
		if (!input.title?.trim() || !input.goal?.trim()) throw new BraidError("an intent needs a title and a goal");
		const by = input.by ?? "human";
		this.sql.exec("INSERT INTO intents (title, goal, acceptance, status, created_by, created_at) VALUES (?, ?, ?, 'open', ?, ?)",
			input.title.trim(), input.goal.trim(), input.acceptance?.trim() ?? "", by, now());
		const intent = this.toIntent(this.rows("SELECT * FROM intents ORDER BY id DESC LIMIT 1")[0]);
		this.note("intent", by, `Opened I${intent.id}: ${intent.title}`, intent.id);
		return intent;
	}

	async abandonIntent(id: number, by = "human") {
		this.intent(id);
		this.sql.exec("UPDATE intents SET status = 'abandoned' WHERE id = ? AND status = 'open'", id);
		this.sql.exec("UPDATE attempts SET status = 'abandoned' WHERE intent_id = ? AND status IN ('working','ready','conflicted')", id);
		this.note("intent", by, `Abandoned I${id}`, id);
		await this.serial(() => this.recompute());
	}

	/** Start an attempt: fork trunk into a fresh Artifacts repo and hand the agent its credentials. */
	join(input: { intentId: number; agent: string; kind?: string; origin: string }): Promise<JoinResult> {
		return this.serial(() => this.startAttempt(input));
	}
	private async startAttempt(input: { intentId: number; agent: string; kind?: string; origin: string }): Promise<JoinResult> {
		this.requireProject();
		const intent = this.intent(input.intentId);
		if (intent.status !== "open") throw new BraidError(`I${intent.id} is ${intent.status}`);
		if (!this.meta("head")) throw new BraidError("trunk has no commits yet: push a first commit before starting attempts");
		const agent = (input.agent || "agent").trim().slice(0, 40);
		const n = this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE intent_id = ?", intent.id)[0].n + 1;
		const id = `${intent.id}.${n}`;
		const repo = `${this.meta("slug")}--i${intent.id}-a${n}-${crypto.randomUUID().slice(0, 4)}`;
		const forked = await this.host.fork(this.trunk, repo, `Braid attempt ${id} (${agent}) for: ${intent.title}`);
		const base = (await this.host.log(repo, this.branch, 1))[0]?.hash ?? this.meta("head");
		const token = "brd_" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
		this.sql.exec(
			`INSERT INTO attempts (id, intent_id, agent, kind, repo, remote, token, base_sha, head_sha, trunk_seen, status, summary, files, claims, behind,
				trunk_conflicts, checks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', '', '[]', '[]', 0, '[]', '[]', ?, ?)`,
			id, intent.id, agent, input.kind ?? "agent", repo, forked.remote, token, base, base, base, now(), now(),
		);
		this.note("attempt", agent, `${agent} started attempt ${id} on I${intent.id} from ${short(base)}`, intent.id, id);
		return {
			attemptId: id, intentId: intent.id, branch: this.branch, remote: forked.remote, gitToken: forked.token, agentToken: token,
			mcpUrl: `${input.origin}/mcp/${this.meta("slug")}`, brief: this.briefText(this.attempt(id)),
		};
	}

	async abandonAttempt(id: string, by = "human") {
		const a = this.attempt(id);
		if (!LIVE.has(a.status)) throw new BraidError(`attempt ${id} is ${a.status}`);
		a.status = "abandoned";
		this.saveAttempt(a);
		this.note("attempt", by, `Attempt ${id} abandoned`, a.intentId, id);
		await this.serial(() => this.recompute());
	}

	// ── awareness: what changed, and who is about to collide ─────────────────

	private async trunkLog(): Promise<CommitMeta[]> {
		const log = await this.host.log(this.trunk, this.branch, 300);
		if (log[0] && log[0].hash !== this.meta("head")) {
			if (!this.meta("head")) this.note("project", "braid", `Trunk received its first commit ${short(log[0].hash)}`);
			this.setMeta("head", log[0].hash);
		}
		return log;
	}

	/** Re-read an attempt from Artifacts: head, the trunk commit it is based on, changed files, conflicts with trunk. */
	private async refresh(a: Attempt, trunkLog: CommitMeta[]): Promise<Attempt> {
		const head = (await this.host.log(a.repo, this.branch, 1))[0];
		const trunkHead = trunkLog[0];
		if (!head || !trunkHead) return a;
		const seen = this.rows<{ trunk_seen: string }>("SELECT trunk_seen FROM attempts WHERE id = ?", a.id)[0]?.trunk_seen;
		if (head.hash === a.headSha && seen === trunkHead.hash) return a;

		const base = (await mergeBase(this.host, a.repo, head.hash, trunkLog.map((c) => c.hash))) ?? a.baseSha;
		const baseCommit = await this.host.readCommit(a.repo, base);
		const baseTree = baseCommit?.treeHash ?? null;
		a.baseSha = base;
		a.headSha = head.hash;
		a.files = await diffTrees(this.host, a.repo, baseTree, head.treeHash);
		a.behind = Math.max(0, trunkLog.findIndex((c) => c.hash === base));
		a.trunkConflicts = [];
		if (a.behind > 0 && a.files.length) {
			const trunkFiles = new Map((await diffTrees(this.host, this.trunk, baseTree, trunkHead.treeHash)).map((f) => [f.path, f]));
			for (const f of a.files) {
				const t = trunkFiles.get(f.path);
				if (!t || t.head === f.head) continue;
				const p = predict(await this.text(a.repo, f.base), await this.text(this.trunk, t.head), await this.text(a.repo, f.head));
				if (p.conflict) a.trunkConflicts.push(f.path);
			}
		}
		// An agent that merged trunk into its attempt has reconciled the git way: the open reconciliation is moot.
		if (a.status === "conflicted" && a.behind === 0) {
			a.status = "ready";
			this.sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status != 'resolved'", a.id);
			this.note("reconcile", a.agent, `${a.agent} merged trunk into attempt ${a.id}; it is ready to land again`, a.intentId, a.id);
		}
		this.saveAttempt(a);
		this.sql.exec("UPDATE attempts SET trunk_seen = ? WHERE id = ?", trunkHead.hash, a.id);
		return a;
	}

	private blobCache = new Map<string, string | null>();
	private async text(repo: string, hash: string | null): Promise<string | null> {
		if (!hash) return null;
		if (!this.blobCache.has(hash)) {
			if (this.blobCache.size > 500) this.blobCache.clear();
			this.blobCache.set(hash, asText(await this.host.readBlob(repo, hash)));
		}
		return this.blobCache.get(hash)!;
	}

	/** Refresh every live attempt, then find every pair of different intents touching the same file. */
	private async recompute() {
		const trunkLog = await this.trunkLog();
		const order = new Map(trunkLog.map((c, i) => [c.hash, i]));
		const live: Attempt[] = [];
		for (const a of this.attempts()) {
			if (!LIVE.has(a.status)) continue;
			live.push(await this.refresh(a, trunkLog));
		}

		const next = new Map<string, Overlap>();
		const put = (o: Overlap) => {
			const key = `${o.a}|${o.b}|${o.path}`;
			const prev = next.get(key);
			if (!prev || RANK[o.severity] > RANK[prev.severity]) next.set(key, o);
		};
		for (let i = 0; i < live.length; i++) {
			for (let j = i + 1; j < live.length; j++) {
				const [a, b] = live[i].id < live[j].id ? [live[i], live[j]] : [live[j], live[i]];
				if (a.intentId === b.intentId) continue; // competing attempts at one intent are alternatives, not collisions
				const bFiles = new Map(b.files.map((f) => [f.path, f]));
				for (const fa of a.files) {
					const fb = bFiles.get(fa.path);
					if (!fb) continue;
					if (fa.head === fb.head) { put({ a: a.id, b: b.id, path: fa.path, severity: "touch", regions: 0 }); continue; }
					// Merge against the older of the two bases: it is an ancestor of both.
					const aOlder = (order.get(a.baseSha) ?? Infinity) >= (order.get(b.baseSha) ?? Infinity);
					const base = aOlder ? await this.text(a.repo, fa.base) : await this.text(b.repo, fb.base);
					const p = predict(base, await this.text(a.repo, fa.head), await this.text(b.repo, fb.head));
					put({ a: a.id, b: b.id, path: fa.path, severity: p.conflict ? "conflict" : "touch", regions: p.regions });
				}
				for (const [x, y] of [[a, b], [b, a]] as const) {
					for (const claim of x.claims) {
						for (const path of [...y.files.map((f) => f.path), ...y.claims]) {
							if (claimMatches(claim, path) || claimMatches(path, claim)) put({ a: a.id, b: b.id, path: claimMatches(claim, path) ? path : claim, severity: "claim", regions: 0 });
						}
					}
				}
			}
		}

		const prev = new Map(this.rows<Overlap>("SELECT a, b, path, severity, regions FROM overlaps").map((o) => [`${o.a}|${o.b}|${o.path}`, o]));
		const byId = new Map(live.map((a) => [a.id, a]));
		for (const [key, o] of next) {
			const before = prev.get(key);
			if (before && RANK[before.severity] >= RANK[o.severity]) continue;
			for (const [me, other] of [[o.a, o.b], [o.b, o.a]]) {
				this.signal(me, "overlap", { path: o.path, severity: o.severity, with: this.describe(byId.get(other)!, o.path) });
			}
			if (o.severity !== "claim" || !before) {
				const A = byId.get(o.a)!, B = byId.get(o.b)!;
				const verb = o.severity === "conflict" ? "will conflict on" : o.severity === "touch" ? "both changed" : "both plan to change";
				this.note(o.severity === "conflict" ? "conflict" : "overlap", "braid", `${A.agent} (I${A.intentId}) and ${B.agent} (I${B.intentId}) ${verb} ${o.path}`);
			}
		}
		this.sql.exec("DELETE FROM overlaps");
		for (const o of next.values()) this.sql.exec("INSERT INTO overlaps (a, b, path, severity, regions) VALUES (?, ?, ?, ?, ?)", o.a, o.b, o.path, o.severity, o.regions);
		this.broadcast();
	}

	/** Another agent's work as seen from outside: who, for which intent, and the reasoning that touches `path`. */
	private describe(a: Attempt, path?: string) {
		const intent = this.intent(a.intentId);
		const all = this.decisionsFor(a.id);
		const relevant = path ? all.filter((d) => d.files.some((f) => claimMatches(f, path) || claimMatches(path, f))) : [];
		return {
			attempt: a.id, agent: a.agent, status: a.status, intent: `I${intent.id}: ${intent.title}`, goal: intent.goal,
			why: (relevant.length ? relevant : all.slice(-3)).map((d) => ({ kind: d.kind, title: d.title, body: d.body, files: d.files })),
		};
	}

	/** Called for every push in the Artifacts namespace (via PushWorkflow). */
	async onPush(repo: string) {
		if (!this.trunk) return;
		const row = this.rows<{ id: string }>("SELECT id FROM attempts WHERE repo = ?", repo)[0];
		if (!row && repo !== this.trunk) return;
		await this.serial(async () => {
			if (row) {
				const before = this.attempt(row.id);
				await this.recompute();
				const after = this.attempt(row.id);
				if (after.headSha !== before.headSha) {
					this.note("push", after.agent, `${after.agent} pushed ${short(after.headSha)} to attempt ${after.id} (${after.files.length} file${after.files.length === 1 ? "" : "s"} changed)`, after.intentId, after.id);
				}
			} else await this.recompute();
		});
	}

	// ── agent tools (called through MCP with the attempt's token) ────────────

	async agent(token: string, tool: string, args: Record<string, any>): Promise<unknown> {
		this.requireProject();
		const row = this.rows("SELECT * FROM attempts WHERE token = ?", token)[0];
		if (!row) throw new BraidError("unknown agent token", 401);
		const me = this.toAttempt(row);
		const result = await this.runTool(me, tool, args ?? {});
		const pending = this.rows<any>("SELECT * FROM signals WHERE to_attempt = ? AND seen = 0 ORDER BY id", me.id);
		this.sql.exec("UPDATE signals SET seen = 1 WHERE to_attempt = ? AND seen = 0", me.id);
		return { ...(result as object), heads_up: pending.map((s) => ({ kind: s.kind, ...JSON.parse(s.body) })) };
	}

	private async runTool(me: Attempt, tool: string, args: Record<string, any>): Promise<object> {
		switch (tool) {
			case "brief":
				return { brief: this.briefText(me), others: this.others(me), trunk: this.trunkSummary() };
			case "claim": {
				const paths: string[] = (args.paths ?? []).map(String).filter(Boolean);
				if (!paths.length) throw new BraidError("claim needs at least one path");
				me.claims = [...new Set([...me.claims, ...paths])];
				this.saveAttempt(me);
				this.note("claim", me.agent, `${me.agent} plans to change ${paths.join(", ")}${args.reason ? `: ${args.reason}` : ""}`, me.intentId, me.id);
				await this.serial(() => this.recompute());
				return { claimed: me.claims, overlaps: this.overlapsFor(me.id) };
			}
			case "record": {
				const kind = (["decision", "assumption", "rejected", "question", "note"].includes(args.kind) ? args.kind : "decision") as DecisionKind;
				if (!args.title) throw new BraidError("record needs a title");
				this.sql.exec("INSERT INTO decisions (attempt_id, intent_id, agent, kind, title, body, files, sha, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					me.id, me.intentId, me.agent, kind, String(args.title), String(args.body ?? ""), json((args.files ?? []).map(String)), me.headSha, now());
				this.note("why", me.agent, `${me.agent} recorded ${kind}: ${args.title}`, me.intentId, me.id);
				return { recorded: true };
			}
			case "checkpoint": {
				await this.serial(() => this.recompute());
				const a = this.attempt(me.id);
				if (args.summary) { a.summary = String(args.summary); this.saveAttempt(a); }
				return {
					head: a.headSha, changed: a.files.map((f) => `${f.status} ${f.path}`), behind_trunk_by: a.behind,
					would_conflict_with_trunk: a.trunkConflicts, overlaps: this.overlapsFor(a.id),
				};
			}
			case "peek": {
				const other = this.attempt(String(args.attempt));
				const out: any = { ...this.describe(other), claims: other.claims, changed: other.files.map((f) => `${f.status} ${f.path}`), decisions: this.decisionsFor(other.id) };
				if (args.path) {
					const f = other.files.find((x) => x.path === args.path);
					out.file = f ? { path: f.path, status: f.status, content: await this.text(other.repo, f.head) } : null;
				}
				return out;
			}
			case "message": {
				const body = String(args.body ?? "");
				const targets = args.to && args.to !== "all" ? [this.attempt(String(args.to))] : this.attempts().filter((a) => LIVE.has(a.status) && a.id !== me.id);
				for (const t of targets) this.signal(t.id, "message", { from: { attempt: me.id, agent: me.agent, intent: me.intentId }, body });
				this.note("message", me.agent, `${me.agent} → ${targets.map((t) => t.agent).join(", ") || "nobody"}: ${body}`, me.intentId, me.id);
				return { delivered_to: targets.map((t) => t.id) };
			}
			case "check": {
				const check: Check = { name: String(args.name), status: args.status === "pass" ? "pass" : "fail", detail: String(args.detail ?? ""), at: now() };
				me.checks = [...me.checks.filter((c) => c.name !== check.name), check];
				this.saveAttempt(me);
				this.note("check", me.agent, `${me.agent} reported check "${check.name}": ${check.status}`, me.intentId, me.id);
				return { checks: me.checks };
			}
			case "ready": {
				await this.serial(() => this.recompute());
				const a = this.attempt(me.id);
				if (a.headSha === a.baseSha) throw new BraidError("nothing pushed yet: push your commits to the attempt remote before marking ready");
				if (a.status === "working") a.status = "ready";
				if (args.summary) a.summary = String(args.summary);
				this.saveAttempt(a);
				this.note("ready", a.agent, `${a.agent} marked attempt ${a.id} ready: ${a.summary}`, a.intentId, a.id);
				return { status: a.status, would_conflict_with_trunk: a.trunkConflicts, overlaps: this.overlapsFor(a.id) };
			}
			case "reconciliation": {
				const r = this.openRecon(me.id);
				return r ? { reconciliation: r, instructions: RECONCILE_HELP } : { reconciliation: null };
			}
			case "resolve": {
				const r = this.openRecon(me.id);
				if (!r) throw new BraidError("no open reconciliation for this attempt");
				return this.submitResolution(r.id, args.resolutions ?? [], String(args.rationale ?? ""), me.agent);
			}
			case "sync": {
				const token = await this.host.token(this.trunk, "read", 3600);
				const url = this.meta("remote").replace("https://", `https://x:${token.split("?expires=")[0]}@`);
				return {
					trunk_head: this.meta("head"),
					trunk_url: url,
					commands: [`git fetch ${url} ${this.branch}`, "git merge FETCH_HEAD", `git push origin HEAD:${this.branch}`],
					note: "Merging trunk into your attempt and resolving conflicts in your working copy is always a valid way to reconcile. Call checkpoint after pushing.",
				};
			}
			default:
				throw new BraidError(`unknown tool ${tool}`);
		}
	}

	private overlapsFor(id: string) {
		const byId = new Map(this.attempts().map((a) => [a.id, a]));
		return this.rows<Overlap>("SELECT a, b, path, severity, regions FROM overlaps WHERE a = ? OR b = ?", id, id).map((o) => ({
			path: o.path, severity: o.severity, with: this.describe(byId.get(o.a === id ? o.b : o.a)!, o.path),
		}));
	}
	private others(me: Attempt) {
		return this.attempts().filter((a) => a.id !== me.id && LIVE.has(a.status)).map((a) => ({
			...this.describe(a), same_intent_as_you: a.intentId === me.intentId, claims: a.claims, changed: a.files.map((f) => f.path),
		}));
	}
	private trunkSummary() {
		return { head: this.meta("head"), recent_landings: this.landings().slice(-5).reverse().map((l) => ({ sha: short(l.sha), intent: `I${l.intentId}: ${l.title}`, agent: l.agent, files: l.files })) };
	}
	private briefText(a: Attempt) {
		const intent = this.intent(a.intentId);
		return [
			`# Braid brief: attempt ${a.id} on intent I${intent.id}`,
			`**${intent.title}**`,
			`Goal: ${intent.goal}`,
			intent.acceptance ? `Acceptance: ${intent.acceptance}` : "",
			"",
			"You are one of several agents working in this project at the same time. Your working copy is a private fork of trunk.",
			"Other agents cannot see your files, only what you tell Braid and what you push. Protocol:",
			"1. `brief` first: see who else is working and why.",
			"2. `claim` the paths you expect to change before editing, so others hear about it early.",
			"3. `record` every real decision as you make it (what you chose, what you rejected, what you assumed). This is the project's memory of why.",
			`4. Commit and \`git push origin HEAD:${this.branch}\` often, then \`checkpoint\`. Braid answers with overlaps and predicted conflicts, including the other agent's reasoning.`,
			"5. Read `heads_up` on every response. If another intent conflicts with yours, adapt, or `message` that agent.",
			"6. `ready` with a summary when the goal is met. A human or reviewer lands it.",
			"7. If landing conflicts, `reconciliation` gives you both sides and why each exists; answer with `resolve`.",
		].filter((l) => l !== "").join("\n");
	}

	// ── landing and reconciliation ───────────────────────────────────────────

	private openRecon(attemptId: string): Reconciliation | null {
		const r = this.rows("SELECT * FROM reconciliations WHERE attempt_id = ? AND status != 'resolved' ORDER BY id DESC LIMIT 1", attemptId)[0];
		return r ? this.toRecon(r) : null;
	}

	private landingMessage(intent: Intent, a: Attempt, recon: Reconciliation | null) {
		const decisions = this.decisionsFor(a.id);
		const lines = [`Land I${intent.id}: ${intent.title}`, "", `Goal: ${intent.goal}`];
		if (intent.acceptance) lines.push(`Acceptance: ${intent.acceptance}`);
		if (a.summary) lines.push("", `Summary: ${a.summary}`);
		if (decisions.length) {
			lines.push("", "Why:");
			for (const d of decisions) lines.push(`- [${d.kind}] ${d.title}${d.body ? ` — ${d.body.replace(/\s+/g, " ")}` : ""}${d.files.length ? ` (${d.files.join(", ")})` : ""}`);
		}
		if (recon) {
			const against = [...new Set(recon.conflicts.flatMap((c) => c.trunkWhy.map((w) => `I${w.intentId}`)))];
			lines.push("", `Reconciled${against.length ? ` with ${against.join(", ")}` : ""} by ${recon.resolvedBy}: ${recon.rationale.replace(/\s+/g, " ")}`);
		}
		lines.push("", `Braid-Intent: ${intent.id}`, `Braid-Attempt: ${a.id}`, `Braid-Agent: ${a.agent}`);
		return lines.join("\n");
	}

	/** Land an attempt on trunk. On conflict, open a reconciliation that carries both sides' reasoning. */
	land(attemptId: string, by = "human") {
		return this.serial(async () => {
			this.requireProject();
			await this.recompute();
			const a = this.attempt(attemptId);
			const intent = this.intent(a.intentId);
			if (intent.status !== "open") throw new BraidError(`I${intent.id} is already ${intent.status}`);
			if (!LIVE.has(a.status)) throw new BraidError(`attempt ${a.id} is ${a.status}`);
			if (a.headSha === a.baseSha) throw new BraidError(`attempt ${a.id} has no commits to land`);

			const resolvedRow = this.rows("SELECT * FROM reconciliations WHERE attempt_id = ? AND status = 'resolved' ORDER BY id DESC LIMIT 1", a.id)[0];
			const recon = resolvedRow ? this.toRecon(resolvedRow) : null;
			const result = await land({
				branch: this.branch,
				trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
				attempt: { remote: a.remote, token: await this.host.token(a.repo, "read", 600) },
				message: this.landingMessage(intent, a, recon),
				author: { name: a.agent, email: `${a.agent.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@agents.braid.dev` },
				resolutions: new Map((recon?.resolutions ?? []).map((r) => [r.path, r.content])),
			});

			if (!result.ok && result.reason === "nothing-to-land") throw new BraidError(`attempt ${a.id} has nothing that trunk does not already have`);
			if (!result.ok) {
				const conflicts: Conflict[] = result.conflicts.map((c) => ({ ...c, trunkWhy: this.trunkWhy(a.baseSha, c.path) }));
				this.sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status != 'resolved'", a.id);
				this.sql.exec("INSERT INTO reconciliations (attempt_id, intent_id, status, trunk_sha, conflicts, resolutions, rationale, resolved_by, at) VALUES (?, ?, 'open', ?, ?, '[]', '', '', ?)",
					a.id, a.intentId, result.trunkSha, json(conflicts), now());
				const id = this.rows<{ id: number }>("SELECT id FROM reconciliations ORDER BY id DESC LIMIT 1")[0].id;
				a.status = "conflicted";
				this.saveAttempt(a);
				this.signal(a.id, "reconcile", { paths: conflicts.map((c) => c.path), note: "Landing conflicted with trunk. Call `reconciliation` for both sides and their reasoning, then `resolve`." });
				this.note("conflict", by, `Landing ${a.id} conflicted with trunk on ${conflicts.map((c) => c.path).join(", ")}; reconciliation R${id} opened`, a.intentId, a.id);
				return { landed: false as const, reconciliationId: id, conflicts: conflicts.map((c) => c.path) };
			}

			this.sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status != 'resolved'", a.id);
			const files = a.files.map((f) => f.path);
			this.sql.exec("INSERT INTO landings (sha, parent_sha, intent_id, attempt_id, agent, title, files, reconciled, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				result.sha, result.parentSha, intent.id, a.id, a.agent, intent.title, json(files), result.reconciled.length ? 1 : 0, now());
			this.sql.exec("UPDATE intents SET status = 'landed', landed_sha = ?, landed_attempt = ? WHERE id = ?", result.sha, a.id, intent.id);
			a.status = "landed";
			this.saveAttempt(a);
			this.setMeta("head", result.sha);
			this.note("land", by, `Landed I${intent.id} (${a.agent}, attempt ${a.id}) on trunk as ${short(result.sha)}${result.reconciled.length ? `, reconciled ${result.reconciled.join(", ")}` : ""}`, intent.id, a.id);

			const landedWhy = this.describe(a);
			for (const other of this.attempts()) {
				if (other.id === a.id || !LIVE.has(other.status)) continue;
				if (other.intentId === intent.id) {
					other.status = "superseded";
					this.saveAttempt(other);
					this.signal(other.id, "superseded", { note: `Attempt ${a.id} by ${a.agent} was chosen for this intent. Stop work.` });
					this.note("attempt", "braid", `Attempt ${other.id} (${other.agent}) superseded by ${a.id}`, intent.id, other.id);
				} else {
					this.signal(other.id, "trunk-moved", { landed: landedWhy, files, note: "Trunk moved. Call `checkpoint` to see whether this affects you, and `sync` for how to merge trunk into your attempt." });
				}
			}
			await this.recompute();
			return { landed: true as const, sha: result.sha };
		});
	}

	/** The intents that changed `path` on trunk after `baseSha`, with their reasoning. */
	private trunkWhy(baseSha: string, path: string): ConflictContext[] {
		const landings = this.landings();
		const from = landings.findIndex((l) => l.parentSha === baseSha);
		const since = (from === -1 ? landings : landings.slice(from)).filter((l) => l.files.includes(path));
		return since.map((l) => {
			const intent = this.intent(l.intentId);
			const all = this.decisionsFor(l.attemptId);
			const relevant = all.filter((d) => d.files.some((f) => claimMatches(f, path)));
			return { intentId: intent.id, title: intent.title, goal: intent.goal, agent: l.agent, decisions: relevant.length ? relevant : all };
		});
	}

	private async submitResolution(reconId: number, resolutions: { path: string; content: string }[], rationale: string, by: string) {
		const row = this.rows("SELECT * FROM reconciliations WHERE id = ?", reconId)[0];
		if (!row) throw new BraidError(`reconciliation ${reconId} not found`, 404);
		const r = this.toRecon(row);
		if (r.status === "resolved") throw new BraidError(`reconciliation R${reconId} is already resolved`);
		const given = new Map(resolutions.map((x) => [String(x.path), String(x.content)]));
		const blocked = r.conflicts.filter((c) => c.kind === "delete").map((c) => c.path);
		if (blocked.length) throw new BraidError(`${blocked.join(", ")} was deleted on one side and edited on the other; merge trunk into the attempt instead (see the sync tool)`);
		const missing = r.conflicts.filter((c) => !given.has(c.path)).map((c) => c.path);
		if (missing.length) throw new BraidError(`missing resolutions for: ${missing.join(", ")}`);
		if (!rationale.trim()) throw new BraidError("a resolution needs a rationale: say how both intents are preserved");
		const marked = [...given].filter(([, content]) => /^(<<<<<<<|>>>>>>>) /m.test(content)).map(([path]) => path);
		if (marked.length) throw new BraidError(`conflict markers left in: ${marked.join(", ")}`);
		this.sql.exec("UPDATE reconciliations SET status = 'resolved', resolutions = ?, rationale = ?, resolved_by = ? WHERE id = ?",
			json(r.conflicts.map((c) => ({ path: c.path, content: given.get(c.path)! }))), rationale.trim(), by, reconId);
		this.sql.exec("INSERT INTO decisions (attempt_id, intent_id, agent, kind, title, body, files, sha, at) VALUES (?, ?, ?, 'decision', ?, ?, ?, ?, ?)",
			r.attemptId, r.intentId, by, `Reconciled with trunk (R${reconId})`, rationale.trim(), json(r.conflicts.map((c) => c.path)), r.trunkSha, now());
		this.note("reconcile", by, `${by} resolved R${reconId}: ${rationale.trim()}`, r.intentId, r.attemptId);
		const a = this.attempt(r.attemptId);
		if (a.status === "conflicted") { a.status = "ready"; this.saveAttempt(a); }
		const landed = await this.land(r.attemptId, by);
		return { resolved: true, ...landed };
	}

	resolve(reconId: number, resolutions: { path: string; content: string }[], rationale: string, by = "human") {
		return this.submitResolution(reconId, resolutions, rationale, by);
	}

	/** Ask the configured model to reconcile, giving it both intents and both decision trails. */
	async resolveWithModel(reconId: number) {
		const row = this.rows("SELECT * FROM reconciliations WHERE id = ?", reconId)[0];
		if (!row) throw new BraidError(`reconciliation ${reconId} not found`, 404);
		const r = this.toRecon(row);
		if (r.status === "resolved") throw new BraidError(`reconciliation R${reconId} is already resolved`);
		const a = this.attempt(r.attemptId);
		this.sql.exec("UPDATE reconciliations SET status = 'resolving' WHERE id = ?", reconId);
		this.broadcast();
		try {
			const out = await resolveConflicts(this.env, { intent: this.intent(r.intentId), agent: a.agent, decisions: this.decisionsFor(a.id), conflicts: r.conflicts });
			return await this.submitResolution(reconId, out.resolutions, out.rationale, out.model);
		} catch (e) {
			this.sql.exec("UPDATE reconciliations SET status = 'open' WHERE id = ? AND status = 'resolving'", reconId);
			this.broadcast();
			throw e;
		}
	}

	// ── views for the UI ─────────────────────────────────────────────────────

	async diff(attemptId: string): Promise<DiffFile[]> {
		const a = this.attempt(attemptId);
		const out: DiffFile[] = [];
		for (const f of a.files) {
			const [base, head] = [await this.text(a.repo, f.base), await this.text(a.repo, f.head)];
			const binary = (f.base !== null && base === null) || (f.head !== null && head === null);
			const big = (base?.length ?? 0) > MAX_TEXT || (head?.length ?? 0) > MAX_TEXT;
			out.push({ path: f.path, status: f.status, base: binary || big ? null : base, head: binary || big ? null : head, binary: binary || big });
		}
		return out;
	}

	private where(ref: string) {
		if (ref === "trunk") return { repo: this.trunk, ref: this.branch };
		const a = this.attempt(ref);
		return { repo: a.repo, ref: this.branch };
	}

	async tree(ref: string): Promise<string[]> {
		this.requireProject();
		const { repo } = this.where(ref);
		const head = (await this.host.log(repo, this.branch, 1))[0];
		return head ? listTree(this.host, repo, head.treeHash) : [];
	}

	async raw(ref: string, path: string): Promise<Uint8Array | null> {
		this.requireProject();
		const { repo, ref: gitRef } = this.where(ref);
		return this.host.readFile(repo, gitRef, path);
	}

	/** A trunk file with line-level why: which landing (and so which intent) last wrote each line. */
	async file(path: string): Promise<FileView> {
		this.requireProject();
		const content = asText(await this.host.readFile(this.trunk, this.branch, path));
		const trail = this.landings().filter((l) => l.files.includes(path));
		if (content === null) return { path, content: null, binary: true, blame: [], trail };
		const split = (s: string | null) => (s ? s.replace(/\n$/, "").split("\n") : []);
		let blame: BlameLine[] = [];
		if (trail.length) blame = split(asText(await this.host.readFile(this.trunk, trail[0].parentSha, path))).map((text) => ({ text, sha: null }));
		else blame = split(content).map((text) => ({ text, sha: null }));
		for (const l of trail) {
			const next = split(asText(await this.host.readFile(this.trunk, l.sha, path)));
			const out: BlameLine[] = [];
			let i = 0;
			for (const part of diffArrays(blame.map((b) => b.text), next)) {
				if (part.removed) i += part.value.length;
				else if (part.added) out.push(...part.value.map((text) => ({ text, sha: l.sha })));
				else { out.push(...blame.slice(i, i + part.value.length)); i += part.value.length; }
			}
			blame = out;
		}
		return { path, content, binary: false, blame, trail };
	}

	/** Fresh git credentials for an attempt (the token returned by join is short-lived). */
	async credentials(agentToken: string) {
		const row = this.rows("SELECT * FROM attempts WHERE token = ?", agentToken)[0];
		if (!row) throw new BraidError("unknown agent token", 401);
		return { remote: row.remote as string, gitToken: await this.host.token(row.repo, "write", 86400) };
	}
}

const RECONCILE_HELP =
	"Each conflict has the file as it is on trunk, as it is in your attempt, their common base, and `trunkWhy`: the intents that changed this file on trunk and the decisions behind them. " +
	"Write a version of each file that satisfies BOTH intents, then call `resolve` with { resolutions: [{ path, content }], rationale }. " +
	"The rationale is recorded in the landing commit, so say concretely how each side's intent survives.";
