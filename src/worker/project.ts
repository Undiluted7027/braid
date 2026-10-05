// One Durable Object per project. It owns the project's coordination state (intents,
// attempts, the why-log, overlaps, reconciliations) and is the only writer to trunk.
import { DurableObject } from "cloudflare:workers";
import { diffArrays } from "diff";
import { ArtifactsHost, type CommitMeta, type RepoHost } from "./host";
import { asText, assemble, diffTrees, listTree, markedView, merge3, mergeBase, predict } from "./gitops";
import { CANDIDATE, commitFiles, prepare, promote, revert, seed } from "./land";
import { llmName, resolveConflicts } from "./resolver";
import { DEMO_FILES } from "./template";
import { redact } from "../shared/redact";
import type { RunJob, RunPolicy, Runner } from "./runner";
import { hosting, type AgentHost, type HostJob, type HostedKind } from "./agent";
import type {
	Activity, Attempt, BlameLine, Check, Conflict, ConflictContext, Decision, DecisionKind, DiffFile, FileView,
	Intent, JoinResult, Landing, LandOutcome, LineOrigin, Overlap, QueuedLanding, Reconciliation, Run, SessionEvent, State, TrunkCommit,
} from "../shared/types";

export type BraidEnv = Env & { ANTHROPIC_API_KEY?: string; BRAID_MODEL?: string; BRAID_ADMIN_TOKEN?: string; BRAID_OPEN?: string;
	AI_GATEWAY_TOKEN?: string; OPENAI_API_KEY?: string; HOSTED_CLAUDE_MODEL?: string; HOSTED_CODEX_MODEL?: string; HOSTED_MAX?: string;
};

const LIVE = new Set(["working", "ready", "conflicted"]);
/** How many agents Braid runs for one project at a time, unless HOSTED_MAX says otherwise. */
const HOSTED_MAX = 6;
/** Files a package manager writes. A conflict in one is not merged as text; it is regenerated. */
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/;
const RANK = { claim: 1, touch: 2, conflict: 3 } as const;
const MAX_TEXT = 400_000;
const MAX_EVENT_TEXT = 4000;
// Command output is not the why, and it is where secrets turn up: keep a short excerpt, never the whole thing.
const MAX_RESULT_TEXT = 800;
const MAX_EVENTS = 20_000;
const MOVED_TABLES = ["meta", "intents", "attempts", "decisions", "overlaps", "signals", "reconciliations", "landings", "session", "activity"];
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
		this.schema();
	}

	/** Also run after the project is deleted: deleteAll drops the tables while this object lives on. */
	private schema() {
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
			CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT, at INTEGER, kind TEXT, tool TEXT, text TEXT);
			CREATE INDEX IF NOT EXISTS session_attempt ON session (attempt_id, id);
			CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, sha TEXT, status TEXT, steps TEXT, preview INTEGER,
				nothing_to_run INTEGER, error TEXT, started_at INTEGER, finished_at INTEGER, preview_api INTEGER DEFAULT 0);
			CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, actor TEXT, text TEXT, intent_id INTEGER, attempt_id TEXT);
			CREATE TABLE IF NOT EXISTS queue (attempt_id TEXT PRIMARY KEY, by TEXT, at INTEGER, attempt_sha TEXT, force INTEGER, state TEXT, note TEXT,
				candidate_sha TEXT, trunk_sha TEXT, reconciled TEXT);
			CREATE TABLE IF NOT EXISTS candidates (attempt_id TEXT PRIMARY KEY, sha TEXT, trunk_sha TEXT, attempt_sha TEXT, at INTEGER);
		`);
		// Added after the first projects existed.
		try { this.sql.exec("ALTER TABLE runs ADD COLUMN preview_api INTEGER DEFAULT 0"); } catch {}
		try { this.sql.exec("ALTER TABLE attempts ADD COLUMN hosted TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE attempts ADD COLUMN hosted_detail TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE reconciliations ADD COLUMN attempt_sha TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE landings ADD COLUMN reverted_by TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE landings ADD COLUMN revert_of TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE registry ADD COLUMN public INTEGER DEFAULT 0"); } catch {}
		try {
			this.sql.exec("ALTER TABLE attempts ADD COLUMN model TEXT");
			// Attempts from before the column existed: a hosted agent's first session line names its model.
			for (const e of this.rows<{ attempt_id: string; text: string }>("SELECT attempt_id, text FROM session WHERE kind = 'system' AND text LIKE '%started on attempt%' ORDER BY id")) {
				const model = /\(([\w.:-]+)\)/.exec(e.text)?.[1];
				if (model) this.sql.exec("UPDATE attempts SET model = ? WHERE id = ? AND model IS NULL", model, e.attempt_id);
			}
		} catch {}
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
		hosted: r.hosted ?? null, hostedDetail: r.hosted_detail ?? "", model: r.model ?? null,
	});
	private toDecision = (r: any): Decision => ({
		id: r.id, attemptId: r.attempt_id, intentId: r.intent_id, agent: r.agent, kind: r.kind, title: r.title, body: r.body,
		files: JSON.parse(r.files), sha: r.sha, at: r.at,
	});
	private toRecon = (r: any): Reconciliation => ({
		id: r.id, attemptId: r.attempt_id, intentId: r.intent_id, status: r.status, trunkSha: r.trunk_sha, conflicts: JSON.parse(r.conflicts),
		resolutions: JSON.parse(r.resolutions), rationale: r.rationale, resolvedBy: r.resolved_by, at: r.at, attemptSha: r.attempt_sha ?? null,
	});
	private toLanding = (r: any): Landing => ({
		sha: r.sha, parentSha: r.parent_sha, intentId: r.intent_id, attemptId: r.attempt_id, agent: r.agent, title: r.title,
		files: JSON.parse(r.files), reconciled: !!r.reconciled, at: r.at, revertedBy: r.reverted_by ?? null, revertOf: r.revert_of ?? null,
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

	/** What a re-read of the repository found. Written on its own, so it cannot undo a claim, a check or a status change made meanwhile. */
	private saveGit(a: Attempt) {
		this.sql.exec("UPDATE attempts SET base_sha=?, head_sha=?, files=?, behind=?, trunk_conflicts=?, updated_at=? WHERE id=?",
			a.baseSha, a.headSha, json(a.files), a.behind, json(a.trunkConflicts), now(), a.id);
	}
	private setStatus(id: string, status: Attempt["status"]) { this.sql.exec("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?", status, now(), id); }

	private note(kind: string, actor: string, text: string, intentId: number | null = null, attemptId: string | null = null) {
		this.sql.exec("INSERT INTO activity (at, kind, actor, text, intent_id, attempt_id) VALUES (?, ?, ?, ?, ?, ?)", now(), kind, actor, redact(text), intentId, attemptId);
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

	async listProjects(publicOnly = false) {
		return this.rows<any>(`SELECT slug, name, description, created_at AS createdAt, public FROM registry ${publicOnly ? "WHERE public = 1" : ""} ORDER BY created_at DESC`).map((p) => ({ ...p, public: !!p.public }));
	}
	async markPublic(slug: string, on: boolean) { this.sql.exec("UPDATE registry SET public = ? WHERE slug = ?", on ? 1 : 0, slug); }
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
		// Never clear a repository of that name first: the Artifacts namespace can be shared with another
		// Braid instance, and the repository may be that instance's live trunk.
		const taken = (e: unknown) => new BraidError(`could not create the repository ${repo} (${String((e as Error)?.message ?? e).slice(0, 200)}). If a repository with that name already exists in this Artifacts namespace, another Braid instance may own it: choose another name.`, 409);
		const source = input.source ?? "starter";
		let remote: string, head = "", branch = "main";
		if (source === "import") {
			if (!input.url) throw new BraidError("import needs a repository URL");
			const imported = await this.host.importRepo(input.url, repo, input.branch).catch((e) => { throw taken(e); });
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
			const created = await this.host.create(repo, `Braid trunk for ${input.name}`).catch((e) => { throw taken(e); });
			remote = created.remote;
			try {
				if (source === "starter") head = await seed(created.remote, created.token, DEMO_FILES, "Seed project", { name: "Braid", email: "seed@braid.dev" });
			} catch (e) {
				await this.host.remove(repo).catch(() => {}); // created a moment ago by this call, so it is ours to remove
				throw e;
			}
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

	/**
	 * Let anyone read this project without signing in: its intents, attempts, decisions, sessions,
	 * diffs and previews. Nothing can be changed without the admin token. Off unless someone turns it on.
	 */
	async setPublic(on: boolean, by = "human") {
		this.requireProject();
		this.setMeta("public", on ? "1" : "");
		this.note("project", by, on ? "Project made readable by anyone with the link" : "Project made private again");
		return { public: on };
	}
	async isPublic() { return this.meta("public") === "1"; }

	/** A read credential for trunk that lasts an hour, for cloning it. */
	async cloneCredentials() {
		this.requireProject();
		return { remote: this.meta("remote"), branch: this.branch, gitToken: await this.host.token(this.trunk, "read", 3600) };
	}

	/** A short-lived write credential for trunk, for pushing a first commit into an empty project. */
	async trunkCredentials() {
		this.requireProject();
		return { remote: this.meta("remote"), branch: this.branch, gitToken: await this.host.token(this.trunk, "write", 900) };
	}

	/** Read access to the context repo, for cloning the recorded why. */
	async contextCredentials() {
		const remote = this.meta("context_remote");
		if (!remote) throw new BraidError("nothing has landed yet, so there is no context repo", 404);
		return { remote, branch: "main", gitToken: await this.host.token(`${this.meta("slug")}--context`, "read", 3600) };
	}

	/**
	 * Everything this project knows, for moving it to another Braid instance that uses the same
	 * Artifacts namespace. The repositories stay where they are; only the record of the work moves.
	 * Sandbox runs are left out: their previews live in this instance and are made again on the other.
	 */
	async exportState() {
		this.requireProject();
		return Object.fromEntries(MOVED_TABLES.map((t) => [t, this.rows(`SELECT * FROM ${t}`)]));
	}

	async importState(dump: Record<string, Record<string, unknown>[]>) {
		if (this.trunk) throw new BraidError("a project with this name already exists here", 409);
		for (const table of MOVED_TABLES) {
			for (const row of dump[table] ?? []) {
				const cols = Object.keys(row).filter((c) => /^\w+$/.test(c));
				this.sql.exec(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => row[c] as any));
			}
		}
		this.requireProject();
		this.note("project", "braid", "Project moved to this Braid instance");
		await this.serial(() => this.recompute());
		return { slug: this.meta("slug"), name: this.meta("name"), description: this.meta("description") };
	}

	/** Delete the project. With `keepRepos`, forget it here and leave its repositories, for a project that has moved. */
	async destroy(keepRepos = false) {
		this.requireProject();
		for (const repo of keepRepos ? [] : [this.trunk, `${this.meta("slug")}--context`, ...this.attempts().map((a) => a.repo)]) {
			try { await this.host.remove(repo); } catch {}
		}
		for (const { id } of this.rows<{ id: string }>("SELECT id FROM attempts WHERE hosted IS NOT NULL")) {
			try { await this.agentHost(id)?.clear(); } catch {}
		}
		for (const { ref } of this.rows<{ ref: string }>("SELECT DISTINCT ref FROM runs")) {
			try { await this.runner(ref)?.clear(); } catch {}
		}
		await this.ctx.storage.deleteAll();
		this.schema();
	}

	async state(): Promise<State> {
		this.requireProject();
		return {
			project: {
				slug: this.meta("slug"), name: this.meta("name"), description: this.meta("description"),
				repo: this.trunk, remote: this.meta("remote"), branch: this.branch, head: this.meta("head"), contextRemote: this.meta("context_remote") || null, llm: llmName(this.env), hosting: hosting(this.env), public: this.meta("public") === "1",
			},
			runs: this.rows("SELECT * FROM runs WHERE id IN (SELECT MAX(id) FROM runs GROUP BY ref)").map(this.toRun),
			queue: this.rows<any>("SELECT * FROM queue ORDER BY force DESC, at, attempt_id").map((q): QueuedLanding => ({ attemptId: q.attempt_id, by: q.by, at: q.at, attemptSha: q.attempt_sha, state: q.state, note: q.note })),
			candidates: this.rows<any>("SELECT * FROM candidates").map((c) => ({ attemptId: c.attempt_id, sha: c.sha, trunkSha: c.trunk_sha, attemptSha: c.attempt_sha })),
			intents: this.intents(),
			attempts: this.attempts().map((a) => ({ ...a, now: this.latestEvent(a.id) })),
			decisions: this.rows("SELECT * FROM decisions ORDER BY id").map(this.toDecision),
			overlaps: this.rows<Overlap>("SELECT a, b, path, severity, regions FROM overlaps"),
			// A settled reconciliation is shown as its result against trunk; the other two copies of each file are not sent.
			reconciliations: this.rows("SELECT * FROM reconciliations ORDER BY id").map(this.toRecon).map((r) =>
				r.status === "resolved" || r.status === "stale" ? { ...r, conflicts: r.conflicts.map((c) => ({ ...c, base: null, attempt: null, regions: [] })) } : r),
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

	/** Change what an open intent asks for. Agents already working on it are told, with the new text. */
	async editIntent(id: number, input: { title?: string; goal?: string; acceptance?: string; by?: string }) {
		const intent = this.intent(id);
		if (intent.status !== "open") throw new BraidError(`I${id} is ${intent.status}; only an open intent can be edited`);
		const next = { title: (input.title ?? intent.title).trim(), goal: (input.goal ?? intent.goal).trim(), acceptance: (input.acceptance ?? intent.acceptance).trim() };
		if (!next.title || !next.goal) throw new BraidError("an intent needs a title and a goal");
		if (next.title === intent.title && next.goal === intent.goal && next.acceptance === intent.acceptance) return intent;
		this.sql.exec("UPDATE intents SET title = ?, goal = ?, acceptance = ? WHERE id = ?", next.title, next.goal, next.acceptance, id);
		for (const a of this.attempts()) {
			if (a.intentId === id && LIVE.has(a.status)) this.signal(a.id, "intent-changed", { ...next, note: "A person edited the intent you are working on. Read it again and adjust your work to it." });
		}
		this.note("intent", input.by ?? "human", `Edited I${id}: ${next.title}`, id);
		return this.intent(id);
	}

	async abandonIntent(id: number, by = "human") {
		this.intent(id);
		this.sql.exec("UPDATE intents SET status = 'abandoned' WHERE id = ? AND status = 'open'", id);
		const live = this.attempts().filter((a) => a.intentId === id && LIVE.has(a.status));
		this.sql.exec("UPDATE attempts SET status = 'abandoned' WHERE intent_id = ? AND status IN ('working','ready','conflicted')", id);
		this.note("intent", by, `Abandoned I${id}`, id);
		for (const a of live) await this.retire(a.id);
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
			trunkRemote: this.meta("remote"), trunkToken: await this.host.token(this.trunk, "read", 86400),
			mcpUrl: `${input.origin}/mcp/${this.meta("slug")}`, brief: this.briefText(this.attempt(id)),
		};
	}

	async abandonAttempt(id: string, by = "human") {
		const a = this.attempt(id);
		if (!LIVE.has(a.status)) throw new BraidError(`attempt ${id} is ${a.status}`);
		this.setStatus(id, "abandoned");
		this.note("attempt", by, `Attempt ${id} abandoned`, a.intentId, id);
		await this.retire(id);
		await this.serial(() => this.recompute());
	}

	/** Undo an abandon. */
	async restoreAttempt(id: string, by = "human") {
		const a = this.attempt(id);
		if (a.status !== "abandoned") throw new BraidError(`attempt ${id} is ${a.status}, not abandoned`);
		if (this.intent(a.intentId).status !== "open") throw new BraidError(`I${a.intentId} is ${this.intent(a.intentId).status}; reopen is only for attempts of an open intent`);
		this.setStatus(id, "working");
		this.note("attempt", by, `Attempt ${id} reopened`, a.intentId, id);
		await this.serial(() => this.recompute());
	}

	/**
	 * A person answers an agent. `feedback` sends the attempt back with a note, `answer` replies to a
	 * question the agent recorded, `message` just tells it something. Feedback and answers are kept
	 * with the attempt's decisions, so they are part of the why of whatever lands. The agent hears on
	 * its next tool call; with `bringBack`, Braid starts it again in a sandbox to act on it now.
	 */
	async respond(attemptId: string, input: { kind?: string; body?: string; question?: number; by?: string; bringBack?: boolean }) {
		this.requireProject();
		const a = this.attempt(attemptId), by = String(input.by || "human").slice(0, 40), body = redact(String(input.body ?? "")).trim();
		const kind = input.kind === "answer" ? "answer" : input.kind === "message" ? "message" : "feedback";
		if (!body) throw new BraidError("write what the agent should hear");
		if (!LIVE.has(a.status)) throw new BraidError(`attempt ${a.id} is ${a.status}`);
		if (kind === "message") {
			this.signal(a.id, "message", { from: { person: by }, body });
			this.note("message", by, `${by} → ${a.agent}: ${body}`, a.intentId, a.id);
		} else {
			const q = kind === "answer" ? this.rows<any>("SELECT * FROM decisions WHERE id = ? AND attempt_id = ? AND kind = 'question'", Number(input.question), a.id)[0] : null;
			if (kind === "answer" && !q) throw new BraidError("that question is not one this attempt recorded", 404);
			const title = q ? `Answer: ${q.title}` : "Sent back for changes";
			this.sql.exec("INSERT INTO decisions (attempt_id, intent_id, agent, kind, title, body, files, sha, at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)", a.id, a.intentId, by, kind, title, body, a.headSha, now());
			if (kind === "feedback") {
				// A landing that was asked for is off: the person wants something else first.
				this.sql.exec("DELETE FROM queue WHERE attempt_id = ? AND state != 'pushing'", a.id);
				if (a.status === "ready") this.setStatus(a.id, "working");
				this.signal(a.id, "feedback", { from: by, body, note: "A person reviewed your attempt and sent it back. Do what the note asks, `record` how you addressed it, push, checkpoint, and mark the attempt ready again." });
				this.note("feedback", by, `${by} sent attempt ${a.id} back: ${body}`, a.intentId, a.id);
			} else {
				this.signal(a.id, "answer", { from: by, question: q.title, body });
				this.note("feedback", by, `${by} answered ${a.agent}'s question "${q.title}": ${body}`, a.intentId, a.id);
			}
		}
		let broughtBack = false, couldNot = "";
		const running = this.rows<{ hosted: string | null }>("SELECT hosted FROM attempts WHERE id = ?", a.id)[0]?.hosted;
		if (input.bringBack && running !== "starting" && running !== "running") {
			try { await this.rehost(a.id, "respond"); broughtBack = true; } catch (e) { couldNot = splitError(e).message; }
		}
		if (kind === "feedback") await this.serial(() => this.advance());
		this.broadcast();
		return { ok: true, broughtBack, ...(couldNot ? { couldNot } : {}) };
	}

	/** An attempt that is over takes no further part: its agent is stopped and any landing asked for it is dropped. */
	private async retire(id: string) {
		this.sql.exec("DELETE FROM queue WHERE attempt_id = ?", id);
		const hosted = this.rows<{ hosted: string | null }>("SELECT hosted FROM attempts WHERE id = ?", id)[0]?.hosted;
		if (hosted === "starting" || hosted === "running") await this.agentHost(id)?.stop("the attempt is over").catch((e) => console.error("stop agent", id, e));
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
		this.saveGit(a);
		this.sql.exec("UPDATE attempts SET trunk_seen = ? WHERE id = ?", trunkHead.hash, a.id);
		// An agent that merged trunk into its attempt has reconciled the git way: the open reconciliation is moot.
		// The status is read again here: this attempt may have been abandoned or landed while the repository was being read.
		if (this.attempt(a.id).status === "conflicted" && a.behind === 0) {
			this.setStatus(a.id, "ready");
			this.sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status IN ('open', 'resolving')", a.id);
			this.note("reconcile", a.agent, `${a.agent} merged trunk into attempt ${a.id}; it is ready to land again`, a.intentId, a.id);
		}
		return this.attempt(a.id);
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
			const fresh = await this.refresh(a, trunkLog);
			if (LIVE.has(fresh.status)) live.push(fresh);
		}
		// Every new commit of an attempt is verified in a sandbox. Queued here, it runs on its own.
		for (const a of live) {
			if (a.headSha !== a.baseSha) await this.verify(a.id).catch((e) => console.error("verify", a.id, e));
		}
		// Trunk too, however its head moved: a landing, or a push from outside Braid.
		// A merge of two attempts that each passed can still be broken.
		if (this.meta("head")) await this.verify("trunk").catch((e) => console.error("verify trunk", e));

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
			await this.advance();
		});
	}

	// ── hosted agents: Braid runs the agent itself, in a sandbox ─────────────

	private agentHost(attemptId: string) {
		const ns = this.env.AGENT;
		return ns ? (ns.get(ns.idFromName(`${this.meta("slug")}/${attemptId}`)) as unknown as AgentHost) : null;
	}

	/** Start an attempt on an intent and run the agent for it here, instead of on someone's machine. */
	async hostAgent(intentId: number, kind: HostedKind) {
		this.requireProject();
		const can = hosting(this.env);
		if (!can.available) throw new BraidError("this Braid instance cannot run agents itself");
		if (kind !== "selftest" && !can[kind]) throw new BraidError(`no model credentials for ${kind}: set up AI Gateway (AI_GATEWAY_ID and the AI_GATEWAY_TOKEN secret) or the provider's API key`);
		this.roomForAgent();
		const agent = kind === "claude" ? "claude-code" : kind;
		const joined = await this.join({ intentId, agent, kind: kind === "selftest" ? "agent" : kind, origin: "" });
		const row = this.rows<{ repo: string }>("SELECT repo FROM attempts WHERE id = ?", joined.attemptId)[0];
		this.sql.exec("UPDATE attempts SET hosted = 'starting' WHERE id = ?", joined.attemptId);
		const job: HostJob = {
			slug: this.meta("slug"), attemptId: joined.attemptId, kind, agent, repo: row.repo, remote: joined.remote, trunkRepo: this.trunk,
			trunkRemote: joined.trunkRemote, branch: this.branch, agentToken: joined.agentToken, brief: joined.brief, task: "work",
		};
		await this.agentHost(joined.attemptId)!.start(job);
		this.note("attempt", "braid", `Started ${agent} for attempt ${joined.attemptId} in a Cloudflare sandbox`, intentId, joined.attemptId);
		return { attemptId: joined.attemptId };
	}

	/** Bring an agent back to an attempt it left, to reconcile a conflicted landing or to fix a failed verification. */
	async rehost(attemptId: string, task: "reconcile" | "fix" | "respond") {
		this.requireProject();
		const row = this.rows<any>("SELECT * FROM attempts WHERE id = ?", attemptId)[0];
		if (!row) throw new BraidError(`attempt ${attemptId} not found`, 404);
		const a = this.toAttempt(row);
		if (!LIVE.has(a.status)) throw new BraidError(`attempt ${a.id} is ${a.status}`);
		const kind: HostedKind = a.kind === "codex" ? "codex" : "claude";
		if (!hosting(this.env)[kind]) throw new BraidError(`this Braid instance cannot run ${kind} itself`);
		this.roomForAgent();
		const job: HostJob = {
			slug: this.meta("slug"), attemptId: a.id, kind, agent: a.agent, repo: a.repo, remote: a.remote, trunkRepo: this.trunk,
			trunkRemote: this.meta("remote"), branch: this.branch, agentToken: row.token, brief: this.briefText(a), task,
		};
		await this.agentHost(a.id)!.start(job);
		this.sql.exec("UPDATE attempts SET hosted = 'starting', hosted_detail = '' WHERE id = ?", a.id);
		this.note("attempt", "braid", `Brought ${a.agent} back to attempt ${a.id} in a Cloudflare sandbox to ${task === "reconcile" ? "reconcile with trunk" : task === "respond" ? "act on a person's note" : "fix failed verification"}`, a.intentId, a.id);
		return { attemptId: a.id };
	}

	/** Agents cost money while they run, so a project runs a bounded number at once. */
	private roomForAgent() {
		const max = Number(this.env.HOSTED_MAX) || HOSTED_MAX;
		const running = this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE hosted IN ('starting', 'running')")[0].n;
		if (running >= max) throw new BraidError(`${running} agents are already running for this project, which is the limit (HOSTED_MAX). Wait for one to finish or stop one.`, 409);
	}

	async stopHosted(attemptId: string) {
		this.attempt(attemptId);
		await this.agentHost(attemptId)?.stop();
		return { ok: true };
	}

	/** Session events from a hosted agent, read from its output by the host. */
	async hostedEvents(attemptId: string, events: { kind: string; tool?: string | null; text: string }[], state?: "running", model?: string) {
		if (state) this.sql.exec("UPDATE attempts SET hosted = ? WHERE id = ? AND hosted = 'starting'", state, attemptId);
		if (model) this.setModel(attemptId, model);
		this.addEvents(attemptId, events);
		if (state) this.broadcast();
	}

	async hostedDone(attemptId: string, state: "finished" | "failed" | "stopped", detail: string) {
		const a = this.attempt(attemptId);
		this.sql.exec("UPDATE attempts SET hosted = ?, hosted_detail = ? WHERE id = ?", state, detail, attemptId);
		this.addEvents(attemptId, [{ kind: "system", text: state === "finished" ? "the agent finished and its sandbox was removed" : `the agent ${state}: ${detail}` }]);
		this.note("attempt", "braid", state === "finished" ? `${a.agent} finished attempt ${a.id}; its sandbox was removed` : `${a.agent} on attempt ${a.id} ${state}: ${detail}`, a.intentId, a.id);
	}

	// ── verification: each commit of an attempt is run in a sandbox ──────────

	private toRun = (r: any): Run => ({
		id: r.id, ref: r.ref, sha: r.sha, status: r.status, steps: JSON.parse(r.steps), preview: !!r.preview, previewApi: !!r.preview_api, nothingToRun: !!r.nothing_to_run,
		error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
	});
	private latestRun(ref: string): Run | null {
		const r = this.rows("SELECT * FROM runs WHERE ref = ? ORDER BY id DESC LIMIT 1", ref)[0];
		return r ? this.toRun(r) : null;
	}
	private runner(ref: string) {
		const ns = this.env.RUNNER;
		return ns ? (ns.get(ns.idFromName(`${this.meta("slug")}/${ref}`)) as unknown as Runner) : null;
	}

	/** What trunk says a run consists of. Read from trunk, so a commit being verified cannot take a check out of its own verification. */
	private policyAt: { head: string; policy: RunPolicy } | null = null;
	private async policy(): Promise<RunPolicy> {
		const head = this.meta("head");
		if (this.policyAt?.head === head) return this.policyAt.policy;
		const read = async (path: string) => { try { return JSON.parse(asText(await this.host.readFile(this.trunk, head, path)) ?? "null"); } catch { return null; } };
		const [config, pkg] = [await read("braid.json"), await read("package.json")];
		const policy = { config: config && typeof config === "object" ? config : null, scripts: Object.keys(pkg?.scripts ?? {}) };
		this.policyAt = { head, policy };
		return policy;
	}

	private async startRun(ref: string, target: { repo: string; remote: string; sha: string; branch: string }, regenerate?: string[]) {
		const runId = this.rows<{ id: number }>("INSERT INTO runs (ref, sha, status, steps, preview, nothing_to_run, error, started_at) VALUES (?, ?, 'queued', '[]', 0, 0, NULL, ?) RETURNING id", ref, target.sha, now())[0].id;
		const job: RunJob = { slug: this.meta("slug"), ref, repo: target.repo, remote: target.remote, branch: target.branch, sha: target.sha, runId, policy: await this.policy(), ...(regenerate ? { regenerate } : {}) };
		await this.runner(ref)!.start(job);
		this.broadcast();
	}

	/** Verify the current commit of an attempt (or of trunk) unless that commit already has a run. */
	async verify(ref: string, again = false): Promise<Run | null> {
		this.requireProject();
		const runner = this.runner(ref);
		if (!runner) return null;
		const a = ref === "trunk" ? null : this.attempt(ref);
		const target = a ? { repo: a.repo, remote: a.remote, sha: a.headSha } : { repo: this.trunk, remote: this.meta("remote"), sha: this.meta("head") };
		if (!target.sha) return null;
		const last = this.latestRun(ref);
		if (!again && last?.sha === target.sha) return last;
		await this.startRun(ref, { ...target, branch: this.branch });
		return this.latestRun(ref);
	}

	/** Progress and results, reported by the runner as each step starts and ends. */
	async runUpdate(runId: number, patch: Partial<Run>) {
		const row = this.rows("SELECT * FROM runs WHERE id = ?", runId)[0];
		if (!row) return;
		const run = { ...this.toRun(row), ...patch };
		this.sql.exec("UPDATE runs SET status = ?, steps = ?, preview = ?, preview_api = ?, nothing_to_run = ?, error = ?, finished_at = ? WHERE id = ?",
			run.status, json(run.steps), run.preview ? 1 : 0, run.previewApi ? 1 : 0, run.nothingToRun ? 1 : 0, run.error ?? null, run.finishedAt ?? null, runId);
		if (!patch.finishedAt || run.status === "superseded") return this.broadcast();

		const merged = run.ref.includes(":"), locking = run.ref.startsWith("lock:");
		const a = run.ref === "trunk" ? null : this.attempt(run.ref.slice(run.ref.indexOf(":") + 1));
		if (a && locking) {
			this.note("verify", "braid", run.status === "pass" ? `Regenerated the lockfile for attempt ${a.id} merged with trunk` : `Could not regenerate the lockfile for attempt ${a.id}: ${run.error ?? run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}`, a.intentId, a.id);
			await this.serial(() => this.advance()).catch((e) => this.note("land", "braid", `The landing queue stopped: ${splitError(e).message}`));
			return;
		}
		const what = !a ? "trunk" : merged ? `attempt ${a.id} (${a.agent}) merged with trunk` : `attempt ${a.id} (${a.agent})`;
		const checks = run.steps.filter((s) => s.name !== "clone" && s.name !== "install");
		const summary = run.status === "error" ? `could not run: ${run.error}`
			: run.nothingToRun ? "nothing to run" : (checks.length ? checks : run.steps).map((s) => `${s.name} ${s.status === "pass" ? "✓" : "✗"}`).join(" · ");
		this.note("verify", "braid", `Verified ${what} at ${short(run.sha)}: ${summary}`, a?.intentId ?? null, a?.id ?? null);
		// The agent hears about a failure the next time it talks to Braid, with the output that shows why.
		if (a && !merged && run.status === "fail" && LIVE.has(a.status) && a.headSha === run.sha) {
			this.signal(a.id, "checks-failed", {
				commit: short(run.sha),
				failed: run.steps.filter((s) => s.status === "fail").map((s) => ({ step: s.name, command: s.command, exit_code: s.exitCode, output: s.tail.slice(-2000) })),
				note: "Braid ran this commit in a clean sandbox and these steps failed. Fix them, push, and checkpoint again.",
			});
		}
		// A result can be what a landing was waiting for.
		await this.serial(() => this.advance()).catch((e) => this.note("land", "braid", `The landing queue stopped: ${splitError(e).message}`));
	}

	/** Lockfiles a sandbox regenerated for a merge: kept as a resolution, for exactly the two commits it was made from. */
	async lockfiles(runId: number, files: Record<string, string>) {
		const run = this.rows<any>("SELECT * FROM runs WHERE id = ?", runId)[0];
		const entry = run && this.rows<any>("SELECT * FROM queue WHERE attempt_id = ? AND state = 'locking' AND candidate_sha = ?", String(run.ref).slice(5), run.sha)[0];
		if (!entry) return;
		const a = this.attempt(entry.attempt_id);
		const paths = Object.keys(files);
		this.sql.exec("INSERT INTO reconciliations (attempt_id, intent_id, status, trunk_sha, attempt_sha, conflicts, resolutions, rationale, resolved_by, at) VALUES (?, ?, 'resolved', ?, ?, ?, ?, ?, 'braid', ?)",
			a.id, a.intentId, entry.trunk_sha, entry.attempt_sha,
			json(paths.map((path) => ({ path, kind: "lockfile", base: null, trunk: null, attempt: null, regions: [], trunkWhy: [] }))),
			json(paths.map((path) => ({ path, content: files[path] }))),
			`Both sides changed dependencies. ${paths.join(", ")} was regenerated from the merged package.json in a sandbox, starting from trunk's version.`, now());
	}

	/** What an agent is told about the verification of its current commit. */
	private verification(a: Attempt) {
		const run = this.latestRun(a.id);
		if (!run) return { status: "not run" };
		if (run.sha !== a.headSha) return { status: "pending", note: "your latest commit has not been verified yet" };
		// Before it lands, the commit is also run merged with trunk. A failure there is the agent's to fix too.
		const candidate = this.rows<any>("SELECT * FROM candidates WHERE attempt_id = ? AND attempt_sha = ? AND trunk_sha = ?", a.id, a.headSha, this.meta("head"))[0];
		const merged = candidate ? this.latestRun(`land:${a.id}`) : null;
		return {
			status: run.status, commit: short(run.sha), steps: run.steps.map((s) => ({ step: s.name, status: s.status, exit_code: s.exitCode })),
			...(run.status === "queued" || run.status === "running" ? { note: "still running; a failure will arrive in heads_up" } : {}),
			...(merged && merged.sha === candidate.sha ? { merged_with_trunk: {
				status: merged.status, trunk: short(candidate.trunk_sha),
				steps: merged.steps.map((s) => ({ step: s.name, status: s.status, exit_code: s.exitCode, ...(s.status === "fail" ? { command: s.command, output: s.tail.slice(-2000) } : {}) })),
				...(merged.status === "fail" ? { note: "Your commit passes alone but fails once merged with trunk. Merge trunk into your attempt (`sync`), fix it, push, and checkpoint." } : {}),
			} } : {}),
		};
	}

	// ── sessions: the record of what each agent actually did ─────────────────

	private toEvent = (r: any): SessionEvent => ({ id: r.id, attemptId: r.attempt_id, at: r.at, kind: r.kind, tool: r.tool, text: r.text });
	private latestEvent(attemptId: string) {
		const r = this.rows("SELECT kind, tool, text, at FROM session WHERE attempt_id = ? ORDER BY id DESC LIMIT 1", attemptId)[0];
		return r ? { kind: r.kind, tool: r.tool, text: String(r.text).slice(0, 200), at: r.at } : null;
	}

	private addEvents(attemptId: string, events: { kind: string; tool?: string | null; text: string; at?: number }[]) {
		const kinds = new Set(["say", "tool", "result", "braid", "system"]);
		const added: SessionEvent[] = [];
		for (const e of events.slice(0, 200)) {
			if (!kinds.has(e.kind) || typeof e.text !== "string" || !e.text) continue;
			const row = this.rows("INSERT INTO session (attempt_id, at, kind, tool, text) VALUES (?, ?, ?, ?, ?) RETURNING *",
				attemptId, typeof e.at === "number" ? e.at : now(), e.kind, e.tool ? String(e.tool).slice(0, 80) : null, redact(e.text).slice(0, e.kind === "result" ? MAX_RESULT_TEXT : MAX_EVENT_TEXT))[0];
			added.push(this.toEvent(row));
		}
		if (!added.length) return;
		// Keep a long attempt bounded: drop the oldest events past the cap.
		this.sql.exec("DELETE FROM session WHERE attempt_id = ? AND id <= (SELECT id FROM session WHERE attempt_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)", attemptId, attemptId, MAX_EVENTS);
		const message = json({ type: "session", attemptId, events: added });
		for (const ws of this.ctx.getWebSockets()) {
			try { ws.send(message); } catch {}
		}
	}

	/** Session events streamed by the agent's launcher (see cli/braid.mjs). */
	/** Which model an attempt's agent is running on. A model name is a short plain word; anything else is ignored. */
	private setModel(attemptId: string, model: unknown) {
		if (typeof model !== "string" || !/^[\w.:\/-]{2,80}$/.test(model)) return;
		this.sql.exec("UPDATE attempts SET model = ? WHERE id = ? AND (model IS NULL OR model != ?)", model, attemptId, model);
		this.broadcast();
	}

	async ingest(token: string, events: { kind: string; tool?: string | null; text: string; at?: number }[], model?: unknown) {
		const row = this.rows<{ id: string }>("SELECT id FROM attempts WHERE token = ?", token)[0];
		if (!row) throw new BraidError("unknown agent token", 401);
		if (model) this.setModel(row.id, model);
		this.addEvents(row.id, Array.isArray(events) ? events : []);
		return { ok: true };
	}

	async session(attemptId: string, after = 0): Promise<SessionEvent[]> {
		this.attempt(attemptId);
		return this.rows("SELECT * FROM session WHERE attempt_id = ? AND id > ? ORDER BY id LIMIT 5000", attemptId, after).map(this.toEvent);
	}

	/**
	 * Commit an attempt's intent, decisions, and session transcript to the project's context
	 * repo in Artifacts, so the why of a landing can be cloned and read like the code.
	 * Git history cannot be taken back, so command output is left out: a result keeps only its
	 * first line (status and size). The full session stays in this object, where it can be deleted.
	 */
	private async saveContext(intent: Intent, a: Attempt, landingSha: string) {
		const repo = `${this.meta("slug")}--context`;
		let empty = false;
		if (!this.meta("context_remote")) {
			this.setMeta("context_remote", (await this.host.create(repo, `Braid context (why and sessions) for ${this.meta("name")}`)).remote);
			empty = true;
		}
		const base = `intents/${intent.id}/attempt-${a.id}`;
		const events = this.rows("SELECT * FROM session WHERE attempt_id = ? ORDER BY id", a.id).map(this.toEvent);
		const sha = await commitFiles(this.meta("context_remote"), await this.host.token(repo, "write", 600), "main", {
			[`intents/${intent.id}/intent.json`]: JSON.stringify({ ...intent, landedSha: landingSha, landedAttempt: a.id }, null, "\t") + "\n",
			[`${base}/attempt.json`]: JSON.stringify({ id: a.id, agent: a.agent, kind: a.kind, repo: a.repo, baseSha: a.baseSha, headSha: a.headSha, landedAs: landingSha, summary: a.summary, files: a.files.map((f) => `${f.status} ${f.path}`), checks: a.checks }, null, "\t") + "\n",
			[`${base}/decisions.json`]: JSON.stringify(this.decisionsFor(a.id), null, "\t") + "\n",
			[`${base}/session.jsonl`]: events.map((e) => JSON.stringify({ at: e.at, kind: e.kind, tool: e.tool, text: e.kind === "result" ? e.text.split("\n")[0].slice(0, 160) : e.text })).join("\n") + "\n",
		}, `Context for I${intent.id}: ${intent.title} (attempt ${a.id}, landed ${short(landingSha)})`, { name: "Braid", email: "context@braid.dev" }, empty);
		this.note("context", "braid", `Saved the why and ${events.length} session events of attempt ${a.id} to ${repo} as ${short(sha)}`, intent.id, a.id);
	}

	// ── agent tools (called through MCP with the attempt's token) ────────────

	async agent(token: string, tool: string, args: Record<string, any>): Promise<unknown> {
		this.requireProject();
		const row = this.rows("SELECT * FROM attempts WHERE token = ?", token)[0];
		if (!row) throw new BraidError("unknown agent token", 401);
		const me = this.toAttempt(row);
		if (!LIVE.has(me.status)) {
			const landed = me.status === "landed" ? ` It landed on trunk as ${short(this.intent(me.intentId).landedSha ?? "")}.` : "";
			throw new BraidError(`attempt ${me.id} is ${me.status} and takes no more tool calls.${landed} Stop work.`, 409);
		}
		this.addEvents(me.id, [{ kind: "braid", tool, text: describeCall(tool, args ?? {}) }]);
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
				// A title alone says what, not why. The why is the point: it is shown on the lines this decision led to.
				if (kind !== "question" && kind !== "note" && !String(args.body ?? "").trim()) throw new BraidError(`a ${kind} needs a body: say why, in a sentence or two (what you weighed, what you ruled out)`);
				const named = (args.files ?? []).map(String).filter(Boolean);
				this.sql.exec("INSERT INTO decisions (attempt_id, intent_id, agent, kind, title, body, files, sha, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					me.id, me.intentId, me.agent, kind, redact(String(args.title)), redact(String(args.body ?? "")), json((args.files ?? []).map(String)), me.headSha, now());
				this.note("why", me.agent, `${me.agent} recorded ${kind}: ${args.title}`, me.intentId, me.id);
				return { recorded: true, ...(named.length || kind === "question" ? {} : { tip: "Name the files this is about in `files`, so it is shown on the lines it led to." }) };
			}
			case "checkpoint": {
				await this.serial(() => this.recompute());
				const a = this.attempt(me.id);
				if (args.summary) { a.summary = redact(String(args.summary)); this.saveAttempt(a); }
				return {
					head: a.headSha, changed: a.files.map((f) => `${f.status} ${f.path}`), behind_trunk_by: a.behind,
					would_conflict_with_trunk: a.trunkConflicts, overlaps: this.overlapsFor(a.id), verification: this.verification(a),
				};
			}
			case "peek": {
				if (!args.attempt) throw new BraidError('peek needs the id of another attempt, e.g. {"attempt":"1.2"}; `brief` lists them');
				const other = this.attempt(String(args.attempt));
				const out: any = { ...this.describe(other), claims: other.claims, changed: other.files.map((f) => `${f.status} ${f.path}`), decisions: this.decisionsFor(other.id) };
				if (args.path) {
					const f = other.files.find((x) => x.path === args.path);
					out.file = f ? { path: f.path, status: f.status, content: await this.text(other.repo, f.head) } : null;
				}
				return out;
			}
			case "message": {
				const body = redact(String(args.body ?? ""));
				const targets = args.to && args.to !== "all" ? [this.attempt(String(args.to))] : this.attempts().filter((a) => LIVE.has(a.status) && a.id !== me.id);
				for (const t of targets) this.signal(t.id, "message", { from: { attempt: me.id, agent: me.agent, intent: me.intentId }, body });
				this.note("message", me.agent, `${me.agent} → ${targets.map((t) => t.agent).join(", ") || "nobody"}: ${body}`, me.intentId, me.id);
				return { delivered_to: targets.map((t) => t.id) };
			}
			case "check": {
				const check: Check = { name: String(args.name), status: args.status === "pass" ? "pass" : "fail", detail: redact(String(args.detail ?? "")).slice(0, 2000), at: now() };
				me.checks = [...me.checks.filter((c) => c.name !== check.name), check];
				this.saveAttempt(me);
				this.note("check", me.agent, `${me.agent} reported check "${check.name}": ${check.status}`, me.intentId, me.id);
				return { checks: me.checks };
			}
			case "ready": {
				await this.serial(() => this.recompute());
				const a = this.attempt(me.id);
				if (a.headSha === a.baseSha) throw new BraidError("nothing pushed yet: push your commits to the attempt remote before marking ready");
				const run = this.latestRun(a.id);
				if (run?.sha === a.headSha && run.status === "fail") {
					throw new BraidError(`commit ${short(a.headSha)} failed verification (${run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}). Fix it and push before marking ready; \`checkpoint\` shows the result.`);
				}
				if (a.status === "working") a.status = "ready";
				if (args.summary) a.summary = redact(String(args.summary));
				this.saveAttempt(a);
				this.note("ready", a.agent, `${a.agent} marked attempt ${a.id} ready: ${a.summary}`, a.intentId, a.id);
				return { status: a.status, would_conflict_with_trunk: a.trunkConflicts, overlaps: this.overlapsFor(a.id), verification: this.verification(a) };
			}
			case "reconciliation": {
				const r = this.openRecon(me.id);
				if (!r) return { reconciliation: null };
				// The conflicts themselves, not three copies of every file: a large file would not fit in an agent's context.
				return {
					reconciliation: {
						id: r.id, trunk: short(r.trunkSha),
						conflicts: r.conflicts.map((c) => ({
							path: c.path, kind: c.kind,
							regions: c.regions.map((g, i) => ({ region: i + 1, trunk_line: g.oursLine, before: g.before ?? "", trunk: g.ours, base: g.base, attempt: g.theirs, after: g.after ?? "" })),
							trunkWhy: c.trunkWhy,
							...(args.full ? { base: c.base, trunk: c.trunk, attempt: c.attempt } : {}),
						})),
					},
					instructions: RECONCILE_HELP,
				};
			}
			case "resolve": {
				const r = this.openRecon(me.id);
				if (!r) throw new BraidError("no open reconciliation for this attempt");
				return this.submitResolution(r.id, args.resolutions ?? [], String(args.rationale ?? ""), me.agent, args.one_sided === true);
			}
			case "sync":
				// No token here: this answer lands in the agent's transcript. The read credential for trunk is
				// set up in the attempt's git config at join (see cli/braid.mjs) and refreshed by `braid auth`.
				return {
					trunk_head: this.meta("head"),
					commands: [`git fetch trunk ${this.branch}`, "git merge FETCH_HEAD", `git push origin HEAD:${this.branch}`],
					note: "Merging trunk into your attempt and resolving conflicts in your working copy is always a valid way to reconcile. Call checkpoint after pushing. " +
						"If the `trunk` remote is missing or the fetch is refused, run `braid auth` in the attempt directory to set it up again.",
				};
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
		const said = this.decisionsFor(a.id).filter((d) => d.kind === "feedback" || d.kind === "answer");
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
			"5. Braid runs every commit you push in a clean sandbox: install, then the project's typecheck, tests and build. `checkpoint` reports the result under `verification`, and a failure arrives in `heads_up` with the output. Fix failures before you call `ready`.",
			"   Which checks run is decided by trunk, not by your copy of `braid.json`. Before your work lands it is run once more, merged with trunk; if that fails you hear about it the same way.",
			"6. Read `heads_up` on every response. If another intent conflicts with yours, adapt, or `message` that agent.",
			"7. `ready` with a summary when the goal is met. A human or reviewer lands it. Do not push after that unless you are asked to: a landing is for the commit that was reviewed.",
			"8. If landing conflicts, `reconciliation` gives you both sides and why each exists; answer with `resolve`.",
			"9. If you need a person to decide something, `record` it with kind `question`. The answer arrives in `heads_up`.",
			...(said.length ? ["", "## What people have said about this attempt (newest last)", "Do what each note asks and `record` how you addressed it.",
				...said.map((d) => `- ${d.agent}${d.kind === "answer" ? `, ${d.title.replace(/^Answer: /, "answering \"")}"` : ", sending it back"}: ${d.body}`)] : []),
		].filter((l, i, all) => l !== "" || all[i + 1]?.startsWith("##")).join("\n");
	}

	// ── landing and reconciliation ───────────────────────────────────────────

	private openRecon(attemptId: string): Reconciliation | null {
		const r = this.rows("SELECT * FROM reconciliations WHERE attempt_id = ? AND status IN ('open', 'resolving') ORDER BY id DESC LIMIT 1", attemptId)[0];
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

	/**
	 * Ask for an attempt to be landed. Trunk only takes commits that have been run: the attempt's own
	 * commit must have passed, and when trunk has moved since the attempt started, the merge of the two
	 * is built, verified in a sandbox, and only then becomes trunk. Requests wait in a queue and are
	 * tried one at a time, so each is verified against the trunk it will actually land on.
	 * `sha` is the commit the person was looking at; `force` lands without waiting for any of this.
	 */
	land(attemptId: string, by = "human", force = false, sha?: string): Promise<LandOutcome> {
		return this.serial(async () => {
			this.requireProject();
			await this.recompute();
			const a = this.attempt(attemptId);
			const intent = this.intent(a.intentId);
			if (intent.status !== "open") throw new BraidError(`I${intent.id} is already ${intent.status}`);
			if (!LIVE.has(a.status)) throw new BraidError(`attempt ${a.id} is ${a.status}`);
			if (a.headSha === a.baseSha) throw new BraidError(`attempt ${a.id} has no commits to land`);
			const hosted = this.rows<{ hosted: string | null }>("SELECT hosted FROM attempts WHERE id = ?", a.id)[0]?.hosted;
			if (!force && a.status === "working" && (hosted === "starting" || hosted === "running")) throw new BraidError(`${a.agent} is still working on attempt ${a.id} and has not marked it ready; wait, stop the agent, or land it anyway with force`, 409);
			if (sha && sha !== a.headSha) throw new BraidError(`attempt ${a.id} has moved to ${short(a.headSha)} since you looked at ${short(sha)}; review it again before landing`, 409);
			const before = this.rows<any>("SELECT * FROM queue WHERE attempt_id = ?", a.id)[0];
			if (before && before.attempt_sha === a.headSha) this.sql.exec("UPDATE queue SET force = ?, by = ? WHERE attempt_id = ?", force || before.force ? 1 : 0, by, a.id);
			else this.sql.exec("INSERT OR REPLACE INTO queue (attempt_id, by, at, attempt_sha, force, state, note) VALUES (?, ?, ?, ?, ?, 'waiting', '')", a.id, by, now(), a.headSha, force ? 1 : 0);
			return this.advance(a.id);
		});
	}

	/** Take back a landing that was asked for and has not happened yet. */
	async cancelLanding(attemptId: string, by = "human") {
		const a = this.attempt(attemptId);
		if (!this.rows("SELECT 1 FROM queue WHERE attempt_id = ? AND state != 'pushing'", attemptId).length) throw new BraidError(`attempt ${attemptId} is not waiting to land`);
		this.sql.exec("DELETE FROM queue WHERE attempt_id = ?", attemptId);
		this.note("land", by, `Landing of attempt ${attemptId} cancelled`, a.intentId, a.id);
		await this.serial(() => this.advance());
		return { ok: true };
	}

	/**
	 * Move the landing queue as far as it will go. Safe to call at any time: every step reads what is
	 * true now. Returns what happened to `focus`; if its landing was refused, that is thrown.
	 */
	private async advance(focus?: string): Promise<LandOutcome> {
		let outcome: LandOutcome | null = null, refused: BraidError | null = null;
		for (let moved = true, rounds = 0; moved && rounds < 50; rounds++) {
			moved = false;
			for (const entry of this.rows<any>("SELECT * FROM queue ORDER BY force DESC, at, attempt_id")) {
				const step = await this.tryLanding(entry);
				if (step.kind === "wait" || step.kind === "hold") {
					this.sql.exec("UPDATE queue SET note = ? WHERE attempt_id = ?", step.why, entry.attempt_id);
					if (entry.attempt_id === focus) outcome = { landed: false, queued: true, waiting: step.why };
					if (step.kind === "wait") continue;
					// One merge is verified at a time: whatever lands next changes what the others must be merged with.
					this.sql.exec("UPDATE queue SET note = ? WHERE attempt_id != ? AND state = 'waiting' AND force = 0 AND note = ''", `behind attempt ${entry.attempt_id} in the landing queue`, entry.attempt_id);
					break;
				}
				this.sql.exec("DELETE FROM queue WHERE attempt_id = ?", entry.attempt_id);
				if (step.kind === "landed") {
					if (entry.attempt_id === focus) outcome = { landed: true, sha: step.sha };
					moved = true; // trunk moved, so start again from the front
					break;
				}
				if (step.kind === "conflict" && entry.attempt_id === focus) outcome = { landed: false, reconciliationId: step.id, conflicts: step.paths };
				if (step.kind === "refused") {
					const a = this.attempt(entry.attempt_id);
					this.note("land", "braid", `Attempt ${a.id} was not landed: ${step.why}`, a.intentId, a.id);
					if (entry.attempt_id === focus) refused = new BraidError(step.why, 409);
				}
			}
		}
		this.broadcast();
		if (refused) throw refused;
		return outcome ?? { landed: false, queued: true, waiting: "" };
	}

	/** One queued landing, one step. */
	private async tryLanding(entry: any): Promise<
		{ kind: "wait" | "hold" | "refused"; why: string } | { kind: "landed"; sha: string } | { kind: "conflict"; id: number; paths: string[] } | { kind: "gone" }
	> {
		const a = this.attempt(entry.attempt_id), intent = this.intent(a.intentId), by = String(entry.by), forced = !!entry.force;
		const failed = (run: Run) => run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ");

		// A landing that was being pushed when this object stopped: trunk says whether it got there.
		if (entry.state === "pushing") {
			if ((await this.trunkLog()).some((c) => c.hash === entry.candidate_sha)) {
				if (!this.rows("SELECT 1 FROM landings WHERE sha = ?", entry.candidate_sha).length) await this.recordLanding(a, intent, by, entry.candidate_sha, entry.trunk_sha, JSON.parse(entry.reconciled || "[]"));
				return { kind: "landed", sha: entry.candidate_sha };
			}
			this.sql.exec("UPDATE queue SET state = 'waiting', candidate_sha = NULL WHERE attempt_id = ?", a.id);
			entry = { ...entry, state: "waiting", candidate_sha: null };
		}
		if (!LIVE.has(a.status) || intent.status !== "open") return { kind: "gone" };
		if (a.headSha !== entry.attempt_sha) return { kind: "refused", why: `attempt ${a.id} moved to ${short(a.headSha)} after landing was asked for at ${short(entry.attempt_sha)}; review it and land again` };

		const head = this.meta("head"), verifies = !!this.env.RUNNER && !forced;
		const own = this.latestRun(a.id), trunkRun = this.latestRun("trunk");
		const trunkRed = trunkRun?.sha === head && trunkRun.status === "fail";
		if (verifies) {
			if (!own || own.sha !== a.headSha || own.status === "queued" || own.status === "running") return { kind: "wait", why: `waiting for ${short(a.headSha)} to be verified` };
			if (own.status === "fail") return { kind: "refused", why: `attempt ${a.id} failed verification at ${short(a.headSha)} (${failed(own)}); land it anyway with force` };
			if (own.status !== "pass") return { kind: "refused", why: `attempt ${a.id} could not be verified at ${short(a.headSha)}${own.error ? ` (${own.error})` : ""}; run the verification again, or land it anyway with force` };

			// A lockfile being regenerated for this trunk and this commit: wait for it, then merge with what came back.
			if (entry.state === "locking" && entry.trunk_sha === head && entry.candidate_sha) {
				const run = this.latestRun(`lock:${a.id}`);
				if (run && run.sha === entry.candidate_sha) {
					if ((run.status === "queued" || run.status === "running") && now() - run.startedAt < 45 * 60_000) return { kind: "hold", why: "regenerating the lockfile from the merged package.json" };
					if (run.status !== "pass") return { kind: "refused", why: `both sides changed dependencies and the lockfile could not be regenerated${run.error ? ` (${run.error})` : failed(run) ? ` (${failed(run)} failed)` : ""}. Merge trunk into the attempt with git and run the install there` };
				}
			}

			// A merge already built for this trunk and this commit: its result decides.
			if (entry.state === "verifying" && entry.trunk_sha === head && entry.candidate_sha) {
				const run = this.latestRun(`land:${a.id}`);
				if (run && run.sha === entry.candidate_sha) {
					if (run.status === "queued" || run.status === "running") {
						if (now() - run.startedAt < 45 * 60_000) return { kind: "hold", why: `verifying the merge with trunk at ${short(head)}` };
						return { kind: "refused", why: `the merge of attempt ${a.id} with trunk was not verified within 45 minutes; land it again` };
					}
					if (run.status === "fail") {
						this.signal(a.id, "merge-failed", {
							trunk: short(head),
							failed: run.steps.filter((s) => s.status === "fail").map((s) => ({ step: s.name, command: s.command, exit_code: s.exitCode, output: s.tail.slice(-2000) })),
							note: "Your commit passes on its own but fails once merged with trunk. Merge trunk into your attempt (see `sync`), fix it, push, and checkpoint.",
						});
						return { kind: "refused", why: `attempt ${a.id} passes on its own but failed verification when merged with trunk at ${short(head)} (${failed(run)})${trunkRed ? "; trunk itself is failing, and this attempt does not fix it" : ""}. Land it anyway with force` };
					}
					if (run.status !== "pass") return { kind: "refused", why: `the merge of attempt ${a.id} with trunk could not be verified${run.error ? ` (${run.error})` : ""}; land it again` };
					this.sql.exec("UPDATE queue SET state = 'pushing' WHERE attempt_id = ?", a.id);
					const moved = await promote({
						branch: this.branch, sha: entry.candidate_sha, parentSha: entry.trunk_sha,
						trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
						attempt: { remote: a.remote, token: await this.host.token(a.repo, "read", 600) },
					});
					if (moved.ok) {
						await this.recordLanding(a, intent, by, entry.candidate_sha, entry.trunk_sha, JSON.parse(entry.reconciled || "[]"));
						return { kind: "landed", sha: entry.candidate_sha };
					}
					await this.trunkLog(); // trunk moved under it (a push from outside Braid): merge again
				}
			}
		}

		// Build the merge. A saved resolution is only for the two commits it was written against.
		const trunkHead = this.meta("head");
		this.sql.exec("UPDATE reconciliations SET status = 'stale' WHERE attempt_id = ? AND status = 'resolved' AND (trunk_sha != ? OR COALESCE(attempt_sha, ?) != ?)", a.id, trunkHead, a.headSha, a.headSha);
		// Every resolution still standing for these two commits: what a person, an agent or a model wrote, and any lockfile Braid regenerated.
		const resolved = this.rows("SELECT * FROM reconciliations WHERE attempt_id = ? AND status = 'resolved' ORDER BY id", a.id).map(this.toRecon);
		const recon = resolved.filter((r) => r.resolvedBy !== "braid").pop() ?? null;
		const resolutions = new Map(resolved.flatMap((r) => r.resolutions.map((x) => [x.path, x.content] as [string, string])));
		const build = async (extra: [string, string][] = []) => prepare({
			branch: this.branch,
			trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
			attempt: { remote: a.remote, token: await this.host.token(a.repo, "read", 600) },
			message: this.landingMessage(intent, a, recon),
			author: { name: a.agent, email: `${a.agent.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@agents.braid.dev` },
			resolutions: new Map([...resolutions, ...extra]),
			expect: { trunk: trunkHead, attempt: a.headSha },
		});
		let result = await build();
		// Only lockfiles left in conflict: nobody should merge those by hand. Build the merge with trunk's
		// lockfile, and have a sandbox bring it up to date with the merged package.json.
		if (!result.ok && result.reason === "conflict" && verifies && result.conflicts.every((c) => LOCKFILE.test(c.path) && c.trunk !== null)) {
			const locks = result.conflicts.map((c) => c.path);
			const interim = await build(result.conflicts.map((c) => [c.path, c.trunk!]));
			if (interim.ok) {
				await interim.stage(await this.host.token(a.repo, "write", 600));
				this.sql.exec("UPDATE queue SET state = 'locking', candidate_sha = ?, trunk_sha = ? WHERE attempt_id = ?", interim.sha, interim.parentSha, a.id);
				await this.startRun(`lock:${a.id}`, { repo: a.repo, remote: a.remote, sha: interim.sha, branch: CANDIDATE }, locks);
				this.note("land", by, `Both attempt ${a.id} and trunk changed ${locks.join(", ")}; regenerating it from the merged package.json`, a.intentId, a.id);
				return { kind: "hold", why: "regenerating the lockfile from the merged package.json" };
			}
			result = interim;
		}
		if (!result.ok && result.reason === "moved") {
			// Something was pushed since this object last looked. Look again; the next pass decides with what is there now.
			await this.recompute();
			return { kind: "wait", why: `${result.what === "trunk" ? "trunk" : `attempt ${a.id}`} moved while landing; trying again` };
		}
		if (!result.ok && result.reason === "nothing-to-land") return { kind: "refused", why: `attempt ${a.id} has nothing that trunk does not already have` };
		if (!result.ok) {
			// A lockfile in conflict next to other files is left for Braid: once the rest is resolved, it is regenerated.
			const conflicts: Conflict[] = result.conflicts.map((c) => ({ ...c, ...(LOCKFILE.test(c.path) && verifies ? { kind: "lockfile" as const, base: null, trunk: null, attempt: null, regions: [] } : {}), trunkWhy: this.trunkWhy(a.baseSha, c.path) }));
			this.sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status IN ('open', 'resolving')", a.id);
			this.sql.exec("INSERT INTO reconciliations (attempt_id, intent_id, status, trunk_sha, attempt_sha, conflicts, resolutions, rationale, resolved_by, at) VALUES (?, ?, 'open', ?, ?, ?, '[]', '', '', ?)",
				a.id, a.intentId, result.trunkSha, result.attemptSha, json(conflicts), now());
			const id = this.rows<{ id: number }>("SELECT id FROM reconciliations ORDER BY id DESC LIMIT 1")[0].id;
			this.setStatus(a.id, "conflicted");
			this.signal(a.id, "reconcile", { paths: conflicts.map((c) => c.path), note: "Landing conflicted with trunk. Call `reconciliation` for both sides and their reasoning, then `resolve`." });
			this.note("conflict", by, `Landing ${a.id} conflicted with trunk on ${conflicts.map((c) => c.path).join(", ")}; reconciliation R${id} opened`, a.intentId, a.id);
			return { kind: "conflict", id, paths: conflicts.map((c) => c.path) };
		}

		// What has already been run does not need running again: an attempt that starts from trunk's head
		// merges to exactly the tree that passed, and a project with no checks has nothing to run.
		const sameTree = a.baseSha === result.parentSha && result.reconciled.length === 0;
		const nothing = !!own?.nothingToRun && trunkRun?.sha === result.parentSha && trunkRun.status === "pass" && trunkRun.nothingToRun;
		if (!verifies || sameTree || (nothing && !trunkRed)) {
			// Written down before the push, so a landing that reaches trunk is recorded even if this object stops in between.
			this.sql.exec("UPDATE queue SET state = 'pushing', candidate_sha = ?, trunk_sha = ?, reconciled = ? WHERE attempt_id = ?", result.sha, result.parentSha, json(result.reconciled), a.id);
			await result.push();
			await this.recordLanding(a, intent, by, result.sha, result.parentSha, result.reconciled, forced && !!this.env.RUNNER);
			return { kind: "landed", sha: result.sha };
		}
		await result.stage(await this.host.token(a.repo, "write", 600));
		this.sql.exec("UPDATE queue SET state = 'verifying', candidate_sha = ?, trunk_sha = ?, reconciled = ? WHERE attempt_id = ?", result.sha, result.parentSha, json(result.reconciled), a.id);
		this.sql.exec("INSERT OR REPLACE INTO candidates (attempt_id, sha, trunk_sha, attempt_sha, at) VALUES (?, ?, ?, ?, ?)", a.id, result.sha, result.parentSha, a.headSha, now());
		await this.startRun(`land:${a.id}`, { repo: a.repo, remote: a.remote, sha: result.sha, branch: CANDIDATE });
		this.note("land", by, `Merged attempt ${a.id} with trunk at ${short(result.parentSha)} as ${short(result.sha)}; it lands if that passes verification`, a.intentId, a.id);
		return { kind: "hold", why: `verifying the merge with trunk at ${short(result.parentSha)}` };
	}

	/** Trunk has the landing commit: write down what it was, tell everyone affected, and keep the why. */
	private async recordLanding(a: Attempt, intent: Intent, by: string, sha: string, parentSha: string, reconciled: string[], unverified = false) {
		this.sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status IN ('open', 'resolving')", a.id);
		const files = a.files.map((f) => f.path);
		this.sql.exec("INSERT OR REPLACE INTO landings (sha, parent_sha, intent_id, attempt_id, agent, title, files, reconciled, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			sha, parentSha, intent.id, a.id, a.agent, intent.title, json(files), reconciled.length ? 1 : 0, now());
		this.sql.exec("UPDATE intents SET status = 'landed', landed_sha = ?, landed_attempt = ? WHERE id = ?", sha, a.id, intent.id);
		this.setStatus(a.id, "landed");
		this.setMeta("head", sha);
		this.note("land", by, `Landed I${intent.id} (${a.agent}, attempt ${a.id}) on trunk as ${short(sha)}${reconciled.length ? `, reconciled ${reconciled.join(", ")}` : ""}${unverified ? ", forced without waiting for verification" : ""}`, intent.id, a.id);
		await this.retire(a.id);

		this.setMeta("context_pending", json([...new Set([...this.pendingContext(), a.id])]));
		await this.saveContexts();

		const landedWhy = this.describe(a);
		for (const other of this.attempts()) {
			if (other.id === a.id || !LIVE.has(other.status)) continue;
			if (other.intentId === intent.id) {
				this.setStatus(other.id, "superseded");
				this.signal(other.id, "superseded", { note: `Attempt ${a.id} by ${a.agent} was chosen for this intent. Stop work.` });
				this.note("attempt", "braid", `Attempt ${other.id} (${other.agent}) superseded by ${a.id}`, intent.id, other.id);
				await this.retire(other.id);
			} else {
				this.signal(other.id, "trunk-moved", { landed: landedWhy, files, note: "Trunk moved. Call `checkpoint` to see whether this affects you, and `sync` for how to merge trunk into your attempt." });
			}
		}
		await this.recompute();
	}

	/** Landed attempts whose why has not reached the context repo yet. A failed copy stays here and is tried again at the next landing. */
	private pendingContext(): string[] { try { return JSON.parse(this.meta("context_pending") || "[]"); } catch { return []; } }
	private async saveContexts() {
		for (const id of this.pendingContext()) {
			const a = this.attempt(id), intent = this.intent(a.intentId);
			try {
				await this.saveContext(intent, a, intent.landedSha ?? "");
				this.setMeta("context_pending", json(this.pendingContext().filter((x) => x !== id)));
			} catch (e) {
				// The landing already happened; losing the context copy must not undo or fail it.
				this.note("context", "braid", `Could not save context for attempt ${id}; it will be tried again at the next landing: ${splitError(e).message}`, intent.id, id);
			}
		}
	}

	/**
	 * Take a landing back. Trunk gets one new commit that undoes it, the intent is open again, and
	 * the reason is kept with the attempt. The attempt itself is finished: its commits are in trunk's
	 * history, so the intent needs a new attempt.
	 */
	revertLanding(sha: string, by = "human", reason = "") {
		return this.serial(async () => {
			this.requireProject();
			const row = this.rows("SELECT * FROM landings WHERE sha = ?", sha)[0];
			if (!row) throw new BraidError(`no landing ${short(sha)}`, 404);
			const l = this.toLanding(row), why = redact(reason).trim();
			if (l.revertOf) throw new BraidError("that commit is itself a revert");
			if (l.revertedBy) throw new BraidError(`that landing was already reverted by ${short(l.revertedBy)}`);
			if (!why) throw new BraidError("say why the landing is being reverted: it is kept with the intent");
			const intent = this.intent(l.intentId);
			const result = await revert({
				branch: this.branch, sha: l.sha, parentSha: l.parentSha,
				trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
				message: `Revert I${intent.id}: ${intent.title}\n\nReason: ${why}\n\nBraid-Reverts: ${l.sha}\nBraid-Intent: ${intent.id}`,
				author: { name: by, email: `${by.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@people.braid.dev` },
			});
			if (!result.ok) throw new BraidError(`later landings changed the same lines in ${result.conflicts.join(", ")}, so this landing cannot be taken out on its own. Open an intent to undo it by hand.`, 409);
			this.sql.exec("UPDATE landings SET reverted_by = ? WHERE sha = ?", result.sha, l.sha);
			this.sql.exec("INSERT INTO landings (sha, parent_sha, intent_id, attempt_id, agent, title, files, reconciled, at, revert_of) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
				result.sha, result.parentSha, intent.id, l.attemptId, by, `Revert I${intent.id}: ${intent.title}`, json(l.files), now(), l.sha);
			this.sql.exec("UPDATE intents SET status = 'open', landed_sha = NULL, landed_attempt = NULL WHERE id = ?", intent.id);
			this.setStatus(l.attemptId, "reverted");
			this.sql.exec("INSERT INTO decisions (attempt_id, intent_id, agent, kind, title, body, files, sha, at) VALUES (?, ?, ?, 'feedback', 'Landing reverted', ?, ?, ?, ?)", l.attemptId, intent.id, by, why, json(l.files), result.sha, now());
			this.setMeta("head", result.sha);
			this.note("land", by, `Reverted the landing of I${intent.id} (${short(l.sha)}) on trunk as ${short(result.sha)}: ${why}. I${intent.id} is open again`, intent.id, l.attemptId);
			for (const other of this.attempts()) {
				if (LIVE.has(other.status)) this.signal(other.id, "trunk-moved", { reverted: `I${intent.id}: ${intent.title}`, reason: why, files: l.files, note: "A landing was taken back out of trunk. Call `checkpoint` to see whether this affects you." });
			}
			await this.recompute();
			await this.advance();
			return { reverted: true, sha: result.sha };
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

	private async submitResolution(reconId: number, resolutions: { path: string; content?: string; regions?: string[] }[], rationale: string, by: string, oneSided = false) {
		const row = this.rows("SELECT * FROM reconciliations WHERE id = ?", reconId)[0];
		if (!row) throw new BraidError(`reconciliation ${reconId} not found`, 404);
		const r = this.toRecon(row);
		if (r.status === "resolved") throw new BraidError(`reconciliation R${reconId} is already resolved`);
		// A file is answered either whole, or as one replacement per conflict, which is put in place here.
		const given = new Map<string, string>();
		for (const x of Array.isArray(resolutions) ? resolutions : []) {
			const c = r.conflicts.find((c) => c.path === String(x.path));
			if (typeof x.content === "string") given.set(String(x.path), x.content);
			else if (Array.isArray(x.regions) && c?.kind === "content") {
				if (x.regions.length !== c.regions.length) throw new BraidError(`${c.path} has ${c.regions.length} conflict${c.regions.length === 1 ? "" : "s"} and ${x.regions.length} replacement${x.regions.length === 1 ? " was" : "s were"} given: send one for each, in order`);
				given.set(c.path, assemble(c.base ?? "", c.trunk ?? "", c.attempt ?? "", x.regions.map(String)));
			}
		}
		const blocked = r.conflicts.filter((c) => c.kind === "delete").map((c) => c.path);
		if (blocked.length) throw new BraidError(`${blocked.join(", ")} was deleted on one side and edited on the other; merge trunk into the attempt instead (see the sync tool)`);
		const missing = r.conflicts.filter((c) => c.kind !== "lockfile" && !given.has(c.path)).map((c) => c.path);
		if (missing.length) throw new BraidError(`missing resolutions for: ${missing.join(", ")}`);
		if (!rationale.trim()) throw new BraidError("a resolution needs a rationale: say how both intents are preserved");
		const marked = [...given].filter(([, content]) => /^(<<<<<<< |>>>>>>> |\|\|\|\|\|\|\| base$)/m.test(content)).map(([path]) => path);
		if (marked.length) throw new BraidError(`conflict markers left in: ${marked.join(", ")}`);
		// A file handed back exactly as one side had it drops the other intent's change, whatever the rationale says.
		// It has happened: an agent's edit failed, it submitted its file untouched, and trunk's change was lost.
		const same = (a: string | null, b: string) => a !== null && a.trimEnd() === b.trimEnd();
		// The same goes for a file that takes one side at every conflict, even though the rest of it is merged.
		const allOf = (c: Conflict, side: "ours" | "theirs") => assemble(c.base ?? "", c.trunk ?? "", c.attempt ?? "", c.regions.map((g) => g[side]));
		const dropped = r.conflicts.filter((c) => c.kind === "content").flatMap((c) => same(c.attempt, given.get(c.path)!) ? [`${c.path} is identical to the attempt's version, so trunk's change is lost`]
			: same(c.trunk, given.get(c.path)!) ? [`${c.path} is identical to trunk's version, so the attempt's change is lost`]
			: c.regions.length && same(allOf(c, "theirs"), given.get(c.path)!) ? [`${c.path} takes the attempt's side at every conflict, so trunk's change there is lost`]
			: c.regions.length && same(allOf(c, "ours"), given.get(c.path)!) ? [`${c.path} takes trunk's side at every conflict, so the attempt's change there is lost`] : []);
		if (dropped.length && !oneSided) throw new BraidError(`this resolution keeps only one side: ${dropped.join("; ")}. Write a version that carries both changes. If dropping one side really is the right answer, submit again with one_sided set to true and say why in the rationale.`);
		this.sql.exec("UPDATE reconciliations SET status = 'resolved', resolutions = ?, rationale = ?, resolved_by = ? WHERE id = ?",
			json(r.conflicts.filter((c) => given.has(c.path)).map((c) => ({ path: c.path, content: given.get(c.path)! }))), rationale.trim(), by, reconId);
		this.sql.exec("INSERT INTO decisions (attempt_id, intent_id, agent, kind, title, body, files, sha, at) VALUES (?, ?, ?, 'decision', ?, ?, ?, ?, ?)",
			r.attemptId, r.intentId, by, `Reconciled with trunk (R${reconId})`, rationale.trim(), json(r.conflicts.map((c) => c.path)), r.trunkSha, now());
		this.note("reconcile", by, `${by} resolved R${reconId}: ${rationale.trim()}`, r.intentId, r.attemptId);
		// The resolved merge is verified like any other before it becomes trunk.
		if (this.attempt(r.attemptId).status === "conflicted") this.setStatus(r.attemptId, "ready");
		const landed = await this.land(r.attemptId, by, false, r.attemptSha ?? undefined);
		return { resolved: true, ...landed };
	}

	resolve(reconId: number, resolutions: { path: string; content?: string; regions?: string[] }[], rationale: string, by = "human", oneSided = false) {
		return this.submitResolution(reconId, resolutions, rationale, by, oneSided);
	}

	/** A conflicted file as one text with the conflicts marked in place, for editing it whole. */
	async marked(reconId: number, path: string) {
		const row = this.rows("SELECT * FROM reconciliations WHERE id = ?", reconId)[0];
		const c = row && this.toRecon(row).conflicts.find((c) => c.path === path && c.kind === "content");
		if (!c) throw new BraidError("no such conflict", 404);
		return { path, text: merge3(c.base ?? "", c.trunk ?? "", c.attempt ?? "").text };
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

	/**
	 * Trunk's commits, newest first, each tied to its intent where Braid can tell: the landing commit
	 * itself, a revert, and the commits an agent made in the attempt that landing brought in.
	 * What is left was pushed to trunk from outside Braid.
	 */
	async history(limit = 200, inside = false): Promise<TrunkCommit[]> {
		this.requireProject();
		// The log follows trunk's own line: one commit per landing, plus anything pushed straight to trunk.
		const line = await this.host.log(this.trunk, this.branch, 300), log = line.slice(0, Math.min(Math.max(limit, 1), 300));
		const landings = new Map(this.landings().map((l) => [l.sha, l]));
		const trunkLine = new Set(line.map((c) => c.hash));
		const row = (c: CommitMeta, kind: TrunkCommit["kind"], l?: Landing): TrunkCommit => ({
			sha: c.hash, subject: c.message.split("\n")[0].slice(0, 200), author: c.author.name, at: c.authoredAt < 1e12 ? c.authoredAt * 1000 : c.authoredAt,
			kind, intentId: l?.intentId ?? null, attemptId: l?.attemptId ?? null,
		});
		const out: TrunkCommit[] = [];
		for (const c of log) {
			const l = landings.get(c.hash);
			out.push(row(c, l ? (l.revertOf ? "revert" : "landing") : c.parents.length ? "outside" : "start", l));
			// The commits the agent made: back from the attempt's head (the landing's second parent) to where it left trunk.
			if (inside && l && !l.revertOf && c.parents[1]) {
				const made = await this.host.log(this.trunk, c.parents[1], 50).catch(() => []);
				for (const m of made) { if (trunkLine.has(m.hash)) break; out.push(row(m, "attempt", l)); }
			}
		}
		return out;
	}

	/** A file for the preview of `ref`: from the build Braid made of its current commit if there is one, otherwise straight from the repository. */
	async raw(ref: string, path: string): Promise<{ bytes: Uint8Array; path: string; built: boolean; api: boolean } | { proxy: true } | null> {
		this.requireProject();
		const { repo, ref: gitRef } = this.where(ref);
		const head = ref === "trunk" ? this.meta("head") : this.attempt(ref).headSha;
		const built = this.rows<{ preview_api: number }>("SELECT preview_api FROM runs WHERE ref = ? AND sha = ? AND preview = 1 ORDER BY id DESC LIMIT 1", ref, head)[0];
		if (built) {
			const api = !!built.preview_api;
			if (api && (path === "api" || path.startsWith("api/"))) return { proxy: true };
			const file = await this.runner(ref)!.file(path);
			return file ? { bytes: new Uint8Array(file.body), path: file.path, built: true, api } : null;
		}
		const bytes = await this.host.readFile(repo, gitRef, path);
		return bytes ? { bytes, path, built: false, api: false } : null;
	}

	/**
	 * A trunk file with its why, line by line. Each line is traced along trunk's own history to the
	 * commit that wrote it: a landing (and inside it, the commit the agent made in its attempt, or the
	 * reconciliation), a revert, or a push from outside Braid. For an agent's commit, the decisions it
	 * recorded while making it and the place in its session are attached, so a line leads to the moment it was written.
	 */
	private fileViews = new Map<string, { head: string; view: FileView }>();
	async file(path: string): Promise<FileView> {
		this.requireProject();
		const head = this.meta("head"), cached = this.fileViews.get(path);
		if (cached?.head === head) return cached.view;
		const split = (s: string | null) => (s ? s.replace(/\n$/, "").split("\n") : []);
		const read = async (ref: string) => { try { return asText(await this.host.readFile(this.trunk, ref, path)); } catch { return null; } };
		const content = await read(this.branch);
		const trail = this.landings().filter((l) => l.files.includes(path));
		if (content === null) return { path, content: null, binary: true, blame: [], trail, origins: {} };

		const chain = [...(await this.host.log(this.trunk, this.branch, 300))].reverse(); // oldest first, trunk's own line
		const landings = new Map(this.landings().map((l) => [l.sha, l]));
		const trunkLine = new Set(chain.map((c) => c.hash));
		const when = (c: CommitMeta) => (c.authoredAt < 1e12 ? c.authoredAt * 1000 : c.authoredAt);
		const meta = (c: CommitMeta) => ({ sha: c.hash, subject: c.message.split("\n")[0].slice(0, 200), author: c.author.name, at: when(c) });
		/** Read many versions of the file without opening hundreds of requests at once. */
		const readAll = async (refs: string[]) => {
			const out: (string | null)[] = new Array(refs.length).fill(null);
			for (let i = 0; i < refs.length; i += 12) await Promise.all(refs.slice(i, i + 12).map(async (ref, j) => { out[i + j] = await read(ref); }));
			return out;
		};
		/** Follow one version to the next: lines that survive keep their mark, new lines get `mark(index in next)`. */
		const step = <T>(prev: { text: string; mark: T }[], next: string[], mark: (index: number) => T) => {
			const out: { text: string; mark: T }[] = [];
			let i = 0, j = 0;
			for (const part of diffArrays(prev.map((b) => b.text), next)) {
				if (part.removed) i += part.value.length;
				else if (part.added) for (const text of part.value) out.push({ text, mark: mark(j++) });
				else { out.push(...prev.slice(i, i + part.value.length)); i += part.value.length; j += part.value.length; }
			}
			return out;
		};

		// A landing that does not list this file cannot have changed it, so its version is not read.
		const mayChange = chain.map((c) => { const l = landings.get(c.hash); return !l || l.files.includes(path); });
		const versions = await readAll(chain.filter((_, i) => mayChange[i]).map((c) => c.hash));
		const origins: Record<string, LineOrigin> = {};
		let lines: { text: string; mark: { sha: string | null; origin?: string } }[] = [];
		let before: string | null = null, v = 0;
		for (let n = 0; n < chain.length; n++) {
			if (!mayChange[n]) continue;
			const c = chain[n], now = versions[v++], l = landings.get(c.hash);
			if (now === before) continue;
			const next = split(now);
			if (!c.parents.length) {
				lines = step(lines, next, () => ({ sha: null }));
			} else if (!l) {
				origins[c.hash] = { key: c.hash, kind: "outside", landingSha: null, attemptId: null, commit: meta(c), decisionIds: [], eventId: null };
				lines = step(lines, next, () => ({ sha: null, origin: c.hash }));
			} else if (l.revertOf) {
				origins[c.hash] = { key: c.hash, kind: "revert", landingSha: l.sha, attemptId: l.attemptId, commit: meta(c), decisionIds: this.rows<{ id: number }>("SELECT id FROM decisions WHERE attempt_id = ? AND title = 'Landing reverted'", l.attemptId).map((d) => d.id), eventId: null };
				lines = step(lines, next, () => ({ sha: l.sha, origin: c.hash }));
			} else {
				const inside = await this.insideLanding(l, c, next, trunkLine, readAll, read, split, step, when, meta, path, origins);
				lines = step(lines, next, (j) => ({ sha: l.sha, origin: inside[j] }));
			}
			before = now;
		}
		// Trunk beyond what was read (more than 300 commits back) is shown without marks rather than with wrong ones.
		if (lines.map((b) => b.text).join("\n") !== split(content).join("\n")) lines = split(content).map((text) => ({ text, mark: { sha: null } }));
		const view: FileView = { path, content, binary: false, blame: lines.map((b) => ({ text: b.text, ...b.mark })), trail, origins };
		if (this.fileViews.size > 200) this.fileViews.clear();
		this.fileViews.set(path, { head, view });
		return view;
	}

	/**
	 * For one landing: which of the agent's own commits wrote each line of the landed file. Returns, per
	 * line of the landed version, the key of its origin. A line that is not in the attempt's last commit
	 * was written by the merge itself, which for a reconciled landing means by whoever reconciled.
	 */
	private async insideLanding(
		l: Landing, landed: CommitMeta, landedLines: string[], trunkLine: Set<string>,
		readAll: (refs: string[]) => Promise<(string | null)[]>, read: (ref: string) => Promise<string | null>, split: (s: string | null) => string[],
		step: <T>(prev: { text: string; mark: T }[], next: string[], mark: (index: number) => T) => { text: string; mark: T }[],
		when: (c: CommitMeta) => number, meta: (c: CommitMeta) => { sha: string; subject: string; author: string; at: number }, path: string, origins: Record<string, LineOrigin>,
	): Promise<(string | undefined)[]> {
		const mergeKey = `${l.sha}:merge`;
		const reconciled = this.rows<{ id: number }>("SELECT id FROM decisions WHERE attempt_id = ? AND title LIKE 'Reconciled with trunk%' ORDER BY id", l.attemptId).map((d) => d.id);
		origins[mergeKey] = { key: mergeKey, kind: l.reconciled ? "reconcile" : "merge", landingSha: l.sha, attemptId: l.attemptId, commit: meta(landed), decisionIds: l.reconciled ? reconciled : [], eventId: null };
		const headSha = landed.parents[1];
		if (!headSha) return landedLines.map(() => mergeKey);
		const made: CommitMeta[] = [];
		for (const c of await this.host.log(this.trunk, headSha, 50).catch(() => [] as CommitMeta[])) { if (trunkLine.has(c.hash)) break; made.push(c); }
		made.reverse(); // oldest first
		if (!made.length) return landedLines.map(() => mergeKey);

		const base = made[0].parents[0] ? await read(made[0].parents[0]) : null;
		const versions = await readAll(made.map((c) => c.hash));
		let lines: { text: string; mark: string | undefined }[] = split(base).map((text) => ({ text, mark: undefined }));
		let before = base;
		const decisions = this.decisionsFor(l.attemptId).filter((d) => d.kind !== "feedback" && d.kind !== "answer" && !d.title.startsWith("Reconciled with trunk"));
		const about = (d: Decision) => d.files.some((f) => claimMatches(f, path) || claimMatches(path, f));
		const name = path.slice(path.lastIndexOf("/") + 1);
		made.forEach((c, k) => {
			if (versions[k] === before) return;
			// What the agent did between its previous commit and this one is what produced this one.
			const from = k === 0 ? 0 : when(made[k - 1]), to = k === made.length - 1 ? Infinity : when(c);
			const during = decisions.filter((d) => d.at > from && d.at <= to);
			const picked = during.some(about) ? during.filter(about) : during.length ? during : decisions.filter(about);
			const event = this.rows<{ id: number }>("SELECT id FROM session WHERE attempt_id = ? AND at > ? AND at <= ? AND kind = 'tool' AND text LIKE ? ORDER BY (CASE WHEN lower(tool) IN ('edit', 'write', 'multiedit', 'apply_patch') THEN 0 ELSE 1 END), id LIMIT 1", l.attemptId, from, to === Infinity ? Number.MAX_SAFE_INTEGER : to, `%${name}%`)[0];
			origins[c.hash] = { key: c.hash, kind: "attempt", landingSha: l.sha, attemptId: l.attemptId, commit: meta(c), decisionIds: picked.map((d) => d.id), eventId: event?.id ?? null };
			lines = step(lines, split(versions[k]), () => c.hash);
			before = versions[k];
		});
		// Carry those marks across the merge: a landed line the attempt's last commit also has keeps its commit.
		return step(lines, landedLines, () => mergeKey as string | undefined).map((b) => b.mark);
	}

	/** Fresh git credentials for an attempt (the token returned by join is short-lived). */
	async credentials(agentToken: string) {
		const row = this.rows("SELECT * FROM attempts WHERE token = ?", agentToken)[0];
		if (!row) throw new BraidError("unknown agent token", 401);
		if (!LIVE.has(row.status)) throw new BraidError(`attempt ${row.id} is ${row.status}; it gets no new credentials`, 403);
		return {
			remote: row.remote as string, gitToken: await this.host.token(row.repo, "write", 86400),
			trunkRemote: this.meta("remote"), trunkToken: await this.host.token(this.trunk, "read", 86400),
		};
	}
}

/** One line saying what a Braid tool call was about, for the session record. */
function describeCall(tool: string, args: Record<string, any>): string {
	const clip = (s: unknown) => redact(String(s ?? "")).replace(/\s+/g, " ").slice(0, 300);
	switch (tool) {
		case "claim": return `claim ${(args.paths ?? []).join(", ")}${args.reason ? `: ${clip(args.reason)}` : ""}`;
		case "record": return `record ${args.kind ?? "decision"}: ${clip(args.title)}`;
		case "checkpoint": case "ready": return `${tool}${args.summary ? `: ${clip(args.summary)}` : ""}`;
		case "peek": return `peek at attempt ${args.attempt}${args.path ? ` (${args.path})` : ""}`;
		case "message": return `message to ${args.to ?? "all"}: ${clip(args.body)}`;
		case "check": return `check "${clip(args.name)}": ${args.status}`;
		case "resolve": return `resolve: ${clip(args.rationale)}`;
		default: return tool;
	}
}

const RECONCILE_HELP =
	"Each conflicting file lists its `regions`: the places where trunk and your attempt changed the same lines. A region has trunk's text, your attempt's text, their common base, and a few unchanged lines `before` and `after` it. " +
	"`trunkWhy` is the intents that changed this file on trunk and the decisions behind them. Everything outside the regions has already been merged from both sides. " +
	"For each region, write the text that should stand there so that BOTH intents are satisfied, then call `resolve` with { resolutions: [{ path, regions: [text for region 1, text for region 2, ...] }], rationale }. " +
	"A conflict of kind `lockfile` needs nothing from you: Braid regenerates that file once the others are resolved. " +
	"If the fix needs changes outside the regions too, send the whole merged file as `content` instead of `regions` (call `reconciliation` with full: true for the complete base, trunk and attempt versions). " +
	"The rationale is recorded in the landing commit, so say concretely how each side's intent survives.";
