// One Durable Object per project. It owns the project's coordination state (intents,
// attempts, the why-log, overlaps, reconciliations) and is the only writer to trunk.
import { DurableObject } from "cloudflare:workers";
import { diffArrays } from "diff";
import { ArtifactsHost, type CommitMeta, type RepoHost } from "./host";
import { asText, assemble, diffTrees, GENERATED, listTree, markedView, merge3, mergeBase, predict } from "./gitops";
import { claimMatches, claimOverlaps, fileOverlaps, risen, strongest } from "./overlap.ts";
import { CANDIDATE, chain, commitFiles, prepare, promoteFrom, revert, seed, type ChainStep } from "./land";
import { llmName, resolveConflicts } from "./resolver";
import { diffFlags, sessionFlags } from "./flags.ts";
import { criteriaOf, settle, type ReviewInput } from "./review.ts";
import { reviewAttempt, reviewerFor, reviewerName, reviewers, type Reviewer } from "./reviewer";
import { DEMO_FILES } from "./template";
import { redact } from "../shared/redact";
import { drain, Log, type Effect, type Executor, type NewEffect, type NewEvent } from "./log.ts";
import { applyEvent } from "./projection.ts";
import type { RunJob, RunPolicy, Runner } from "./runner";
import { hosting, type AgentHost, type HostJob, type HostedKind } from "./agent";
import type {
	Activity, Attempt, BlameLine, Check, Conflict, ConflictContext, Decision, DecisionKind, DiffFile, FileView,
	Flag, Intent, JoinResult, Landing, LandOutcome, LineOrigin, Outcome, Overlap, Review, QueuedLanding, Reconciliation, Run, SessionEvent, State, TrunkCommit,
} from "../shared/types";

export type BraidEnv = Env & { ANTHROPIC_API_KEY?: string; BRAID_MODEL?: string; BRAID_ADMIN_TOKEN?: string; BRAID_OPEN?: string;
	AI_GATEWAY_TOKEN?: string; OPENAI_API_KEY?: string; HOSTED_CLAUDE_MODEL?: string; HOSTED_CODEX_MODEL?: string; HOSTED_MAX?: string; SPARE_FORKS?: string; BRAID_REVIEW_MODEL?: string; BRAID_REVIEW_OPENAI_MODEL?: string;
};

const LIVE = new Set(["working", "ready", "conflicted"]);
/** How many agents Braid runs for one project at a time, unless HOSTED_MAX says otherwise. */
const HOSTED_MAX = 6;
/** Files a package manager writes. A conflict in one is not merged as text; it is regenerated. */
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/;
/** Forks of trunk kept ready so that starting an attempt does not wait for one to be made, unless SPARE_FORKS says otherwise. */
const SPARE_FORKS = 2, SPARE_FORKS_MAX = 8;
/** After trunk moves, spare forks are replaced once it has been still this long, so a run of landings replaces them once. */
const SPARE_SETTLE_MS = 15_000;
/** How long `checkpoint` and `ready` wait for Braid to read the caller's own latest push before answering with what it has. */
const OBSERVE_WAIT_MS = 4000;
/** How many landings are merged and verified together, unless trunk's braid.json says otherwise (landing.batch). */
const BATCH = 8;
/** A merge that has not been verified in this long is given up on. */
const VERIFY_LIMIT_MS = 45 * 60_000;
const MAX_TEXT = 400_000;
const MAX_EVENT_TEXT = 4000;
// Command output is not the why, and it is where secrets turn up: keep a short excerpt, never the whole thing.
const MAX_RESULT_TEXT = 800;
const MAX_EVENTS = 20_000;
const MOVED_TABLES = ["meta", "intents", "attempts", "decisions", "overlaps", "signals", "reconciliations", "landings", "session", "activity", "events", "outcomes", "reviews"];
/** How long one alarm keeps taking new effects before handing over to the next. An alarm may run for fifteen minutes. */
const DRAIN_MS = 8 * 60_000;
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

export class Project extends DurableObject<BraidEnv> {
	private sql = this.ctx.storage.sql;
	private host: RepoHost = new ArtifactsHost(this.env.ARTIFACTS);
	/** What was decided, and the work that follows from it (see log.ts). */
	private log = new Log({
		sql: this.sql, transaction: (fn) => this.ctx.storage.transactionSync(fn), apply: (e) => applyEvent(this.sql, e),
		onEffects: () => this.wake(),
	});

	constructor(ctx: DurableObjectState, env: BraidEnv) {
		super(ctx, env);
		this.schema();
		// A new process: whatever was marked running was cut off with the old one.
		const { lost } = this.log.recover((type) => this.executors[type]?.replaySafe ?? true);
		for (const e of lost) console.warn("effect lost with its process", e.id);
		this.wake();
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
			CREATE TABLE IF NOT EXISTS spares (repo TEXT PRIMARY KEY, remote TEXT, base_sha TEXT, at INTEGER);
			CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY AUTOINCREMENT, trunk_sha TEXT, tip_sha TEXT, ref TEXT, state TEXT, size INTEGER, target_sha TEXT, at INTEGER);
			CREATE TABLE IF NOT EXISTS outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, outcome TEXT, text TEXT, attempt_id TEXT, intent_id INTEGER, by TEXT, ref TEXT, at INTEGER, sha TEXT DEFAULT '');
		`);
		// Added after the first projects existed.
		try { this.sql.exec("ALTER TABLE runs ADD COLUMN preview_api INTEGER DEFAULT 0"); } catch {}
		try { this.sql.exec("ALTER TABLE attempts ADD COLUMN hosted TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE attempts ADD COLUMN hosted_detail TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE reconciliations ADD COLUMN attempt_sha TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE landings ADD COLUMN reverted_by TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE landings ADD COLUMN revert_of TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE registry ADD COLUMN public INTEGER DEFAULT 0"); } catch {}
		try { this.sql.exec("ALTER TABLE outcomes ADD COLUMN sha TEXT DEFAULT ''"); } catch {}
		try { this.sql.exec("ALTER TABLE queue ADD COLUMN combined TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE attempts ADD COLUMN flags TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE attempts ADD COLUMN held TEXT"); } catch {}
		try { this.sql.exec("ALTER TABLE attempts ADD COLUMN held_for TEXT"); } catch {}
		this.sql.exec(`CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT, intent_id INTEGER, sha TEXT, status TEXT, verdict TEXT,
			criteria TEXT, summary TEXT, concerns TEXT, changes TEXT, by TEXT, error TEXT, at INTEGER, finished_at INTEGER)`);
		try { this.sql.exec("ALTER TABLE reconciliations ADD COLUMN auto TEXT"); } catch {}
		try {
			this.sql.exec("ALTER TABLE queue ADD COLUMN batch_id INTEGER");
			this.sql.exec("ALTER TABLE queue ADD COLUMN position INTEGER");
			this.sql.exec("ALTER TABLE candidates ADD COLUMN run_ref TEXT");
			this.sql.exec("ALTER TABLE candidates ADD COLUMN run_sha TEXT");
			// A merge that an older version was verifying on the attempt's own repository is built again, in a batch.
			this.sql.exec("UPDATE queue SET state = 'waiting', candidate_sha = NULL WHERE state = 'verifying'");
		} catch {}
		this.log.schema();
		// Before the outbox, landings whose context copy failed were kept on a list and tried at the next landing.
		const owed: string[] = (() => { try { return JSON.parse(this.meta("context_pending") || "[]"); } catch { return []; } })();
		if (owed.length) {
			this.log.commit({ effects: owed.map((id) => this.contextEffect(id)) });
			this.setMeta("context_pending", "");
		}
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

	/**
	 * How something asked for earlier turned out, once the worker has done it: a landing, a revert, a
	 * reconciliation by the model, an agent being started. The request itself only answered "queued".
	 */
	private settled(kind: Outcome["kind"], outcome: string, text: string, a: { id: string; intentId: number } | null, by = "braid", ref = "", sha = ""): NewEvent {
		return { type: "outcome.recorded", actor: by, attemptId: a?.id ?? null, intentId: a?.intentId ?? null, data: { kind, outcome, text: redact(text), ref, sha } };
	}

	private toIntent = (r: any): Intent => ({
		id: r.id, title: r.title, goal: r.goal, acceptance: r.acceptance, status: r.status, createdBy: r.created_by,
		createdAt: r.created_at, landedSha: r.landed_sha, landedAttempt: r.landed_attempt, criteria: criteriaOf(r),
	});
	private toReview = (r: any): Review => ({
		id: r.id, attemptId: r.attempt_id, intentId: r.intent_id, sha: r.sha, status: r.status, verdict: r.verdict ?? null, criteria: JSON.parse(r.criteria || "[]"),
		summary: r.summary ?? "", concerns: JSON.parse(r.concerns || "[]"), changes: r.changes ?? "", by: r.by ?? "", error: r.error ?? null, at: r.at, finishedAt: r.finished_at ?? null,
	});
	/** The latest review of an attempt, whatever commit it was for. */
	private reviewOf(attemptId: string): Review | null {
		const r = this.rows("SELECT * FROM reviews WHERE attempt_id = ? ORDER BY id DESC LIMIT 1", attemptId)[0];
		return r ? this.toReview(r) : null;
	}
	private toAttempt = (r: any): Attempt => ({
		id: r.id, intentId: r.intent_id, agent: r.agent, kind: r.kind, repo: r.repo, remote: r.remote, baseSha: r.base_sha, headSha: r.head_sha,
		status: r.status, summary: r.summary, files: JSON.parse(r.files), claims: JSON.parse(r.claims), behind: r.behind,
		trunkConflicts: JSON.parse(r.trunk_conflicts), checks: JSON.parse(r.checks), createdAt: r.created_at, updatedAt: r.updated_at,
		hosted: r.hosted ?? null, hostedDetail: r.hosted_detail ?? "", model: r.model ?? null, flags: JSON.parse(r.flags || "[]"), held: r.held ?? "", heldFor: r.held ? r.held_for ?? "person" : "",
	});
	private toDecision = (r: any): Decision => ({
		id: r.id, attemptId: r.attempt_id, intentId: r.intent_id, agent: r.agent, kind: r.kind, title: r.title, body: r.body,
		files: JSON.parse(r.files), sha: r.sha, at: r.at,
	});
	private toRecon = (r: any): Reconciliation => ({
		id: r.id, attemptId: r.attempt_id, intentId: r.intent_id, status: r.status, trunkSha: r.trunk_sha, conflicts: JSON.parse(r.conflicts),
		resolutions: JSON.parse(r.resolutions), rationale: r.rationale, resolvedBy: r.resolved_by, at: r.at, attemptSha: r.attempt_sha ?? null, auto: r.auto ?? null,
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

	private setStatus(id: string, status: Attempt["status"]) { this.sql.exec("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?", status, now(), id); }

	private noted(kind: string, actor: string, text: string, intentId: number | null = null, attemptId: string | null = null): NewEvent {
		return { type: "activity.noted", actor, intentId, attemptId, data: { kind, text: redact(text) } };
	}
	private signalled(to: string, kind: string, body: unknown): NewEvent { return { type: "signal.sent", attemptId: to, data: { kind, body } }; }
	private note(kind: string, actor: string, text: string, intentId: number | null = null, attemptId: string | null = null) {
		this.log.commit({ events: [this.noted(kind, actor, text, intentId, attemptId)] });
		this.broadcast();
	}
	private signal(to: string, kind: string, body: unknown) { this.log.commit({ events: [this.signalled(to, kind, body)] }); }

	// ── the worker: effects recorded by a decision are carried out here ──────

	/** Have the alarm look at the outbox as soon as there is something it can take. */
	private wake() {
		const next = this.log.nextAt();
		if (next !== null) void this.ctx.storage.setAlarm(Math.max(next, now()));
	}

	async alarm() {
		await drain(this.log, this.executors, {
			until: now() + DRAIN_MS, concurrency: 8,
			onFailed: (effect, error) => this.effectFailed(effect, error),
		});
		this.log.prune();
		this.log.forget("req:", now() - 24 * 3600_000);
		this.wake();
	}

	private contextEffect(attemptId: string): NewEffect { return { id: `context.save:${attemptId}`, type: "context.save", lane: "context", data: { attemptId } }; }
	/** Read one attempt's repository again and compare it with the attempts it could collide with. */
	private observeEffect(attemptId: string): NewEffect { return { id: `attempt.observe:${attemptId}`, type: "attempt.observe", lane: `repo:${attemptId}`, data: { attemptId } }; }
	/** Verify the current commit of an attempt, or of trunk, unless it already has a run. */
	private runEffect(ref: string): NewEffect { return { id: `run.start:${ref}`, type: "run.start", lane: `run:${ref}`, data: { ref } }; }
	private spareEffect(): NewEffect { return { id: "fork.spare", type: "fork.spare", lane: "spares" }; }
	private removeEffect(repo: string): NewEffect { return { id: `repo.remove:${repo}`, type: "repo.remove", lane: "spares", data: { repo } }; }
	/** Move the landing queue, if anything is in it. */
	private advanceEffect(): NewEffect[] { return this.rows("SELECT 1 FROM queue LIMIT 1").length ? [{ id: "queue.advance", type: "queue.advance", lane: "landing" }] : []; }
	/** Have the reviewer read an attempt's current commit against its intent's criteria. */
	private reviewEffect(attemptId: string, again = false): NewEffect { return { id: `review.run:${attemptId}`, type: "review.run", lane: `review:${attemptId}`, data: { attemptId, again } }; }
	/** See whether the project's landing policy has something to do for an attempt. */
	private considerEffect(attemptId: string): NewEffect { return { id: `policy.consider:${attemptId}`, type: "policy.consider", lane: `policy:${attemptId}`, data: { attemptId } }; }
	private stopEffect(attemptId: string, why: string): NewEffect { return { id: `agent.stop:${attemptId}`, type: "agent.stop", lane: `agent:${attemptId}`, data: { attemptId, why } }; }

	/** Each kind of effect checks what is true before it acts, so one that runs twice does no harm. */
	private executors: Record<string, Executor> = {
		"context.save": {
			replaySafe: true,
			run: async (effect) => {
				if (!this.trunk) return; // the project was deleted while this waited
				const a = this.attempt(effect.data.attemptId), intent = this.intent(a.intentId);
				await this.saveContext(intent, a, intent.landedSha ?? "");
			},
		},
		"attempt.observe": {
			replaySafe: true,
			run: async (effect) => {
				const id: string = effect.data.attemptId, started = ++this.tick;
				await this.observe(id);
				// Whoever asked before this reading began has now been answered.
				this.waiting = this.waiting.filter((w) => !(w.id === id && w.asked < started && (w.done(true), true)));
			},
		},
		"trunk.observe": { replaySafe: true, run: async () => { if (this.trunk) await this.readTrunk(); } },
		"run.start": { replaySafe: true, run: async (effect) => {
			// While a batch is being written down trunk's head passes through each of its landings; trunk is looked at once that is done.
			if (effect.data.ref === "trunk" && this.rows("SELECT 1 FROM batches WHERE state = 'pushing' LIMIT 1").length) return;
			if (this.trunk && (effect.data.ref === "trunk" || this.rows("SELECT 1 FROM attempts WHERE id = ?", effect.data.ref).length)) await this.verify(effect.data.ref);
		} },
		// Everything that moves trunk shares one lane, so it happens one at a time and in the order asked.
		"queue.advance": { replaySafe: true, run: async () => { if (this.trunk) await this.advance(); } },
		"landing.revert": { replaySafe: true, run: async (effect) => { if (this.trunk) await this.doRevert(effect.data.sha, effect.data.by, effect.data.reason); } },
		"model.reconcile": { replaySafe: true, run: async (effect) => { if (this.trunk) await this.doModelReconcile(effect.data.reconId); } },
		"agent.start": { replaySafe: true, run: async (effect, ctx) => { if (this.trunk) await this.doStartAgent(effect.data.attemptId, effect.data.kind, effect.data.task, ctx.willRetry); } },
		"review.run": { replaySafe: true, run: async (effect) => { if (this.trunk) await this.doReview(effect.data.attemptId, !!effect.data.again); } },
		"policy.consider": { replaySafe: true, run: async (effect) => { if (this.trunk) { await this.policy(); this.consider(effect.data.attemptId); } } },
		"agent.stop": { replaySafe: true, run: async (effect) => { await this.agentHost(effect.data.attemptId)?.stop(effect.data.why); } },
		"fork.spare": { replaySafe: true, run: () => this.keepSpares() },
		"repo.remove": { replaySafe: true, run: async (effect) => { await this.host.remove(effect.data.repo).catch((e) => { if (!/not.?found|does not exist/i.test(String(e?.message ?? e))) throw e; }); } },
	};

	private effectFailed(effect: Effect, error: string) {
		if (!this.trunk) return;
		if (effect.type === "context.save") {
			const a = this.attempt(effect.data.attemptId);
			// The landing already happened; losing the context copy must not undo or fail it.
			this.note("context", "braid", `Could not save context for attempt ${a.id} after ${effect.tries} tries; it will be tried again at the next landing: ${splitError(error).message}`, a.intentId, a.id);
		} else if (effect.type === "queue.advance") this.note("land", "braid", `The landing queue stopped: ${splitError(error).message}`);
		else this.note("project", "braid", `Braid could not finish "${effect.type}" after ${effect.tries} tries: ${splitError(error).message}`);
		this.broadcast();
	}

	/** What was decided here, in order, after `seq`. */
	async events(after = 0, limit = 500) {
		this.requireProject();
		return { latest: this.log.latest(), events: this.log.after(after, limit), unsettled: this.log.effects().filter((e) => e.status === "pending" || e.status === "running" || e.status === "failed") };
	}

	/** Give an effect that used up its tries another go. */
	async retryEffect(id: string) {
		this.requireProject();
		if (!this.log.requeue(id)) throw new BraidError("that is not something that failed", 404);
		this.broadcast();
		return { ok: true };
	}

	/**
	 * Do something once however often it is asked. A request that carries a key and is sent again (a
	 * retry after a dropped connection) gets the first answer back and nothing happens twice.
	 */
	private inFlight = new Map<string, Promise<unknown>>();
	async keyed(key: string, method: string, args: unknown[]): Promise<unknown> {
		if (!KEYED.has(method)) throw new BraidError(`${method} cannot be called this way`);
		const id = `req:${method}:${key}`.slice(0, 200), seen = this.log.receipt(id);
		if (seen) {
			if (seen.status === "rejected") throw new Error(seen.error ?? "refused");
			return seen.result;
		}
		const going = this.inFlight.get(id);
		if (going) return going;
		const run = (async () => {
			try {
				const out = (await (this as any)[method](...args)) ?? { ok: true };
				this.log.commit({ command: { id, type: method }, result: out });
				return out;
			} catch (e) {
				// What the caller got wrong is remembered; a failure of ours is not, so trying again can succeed.
				if (splitError(e).status < 500) this.log.reject({ id, type: method }, String((e as Error).message));
				throw e;
			} finally { this.inFlight.delete(id); }
		})();
		this.inFlight.set(id, run);
		return run;
	}
	/** Tell open pages to read the state again. Many changes close together are told once. */
	private telling = false;
	private broadcast() {
		if (this.telling) return;
		this.telling = true;
		setTimeout(() => {
			this.telling = false;
			for (const ws of this.ctx.getWebSockets()) {
				try { ws.send("changed"); } catch {}
			}
		}, 100);
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
	async init(input: { slug: string; name: string; description: string; source?: "starter" | "empty" | "import"; url?: string; branch?: string; review?: boolean }) {
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
		if (input.review === false) this.setMeta("review", "off");
		this.note("project", "braid", head ? `Project created with trunk ${repo} at ${short(head)}` : `Project created with an empty trunk ${repo}; waiting for a first push`);
		if (head) this.log.commit({ effects: [this.runEffect("trunk"), this.spareEffect()] });
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

	/** Turn reviews of attempts on or off for this project, whatever trunk's braid.json says. Off is for projects where calling a model is not wanted. */
	async setReview(on: boolean, by = "human") {
		this.requireProject();
		this.setMeta("review", on ? "" : "off");
		this.note("project", by, on ? "Attempts are reviewed when they are marked ready" : "Attempts are no longer reviewed by a model");
		return { review: on };
	}

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
		this.log.commit({ effects: [{ id: "trunk.observe", type: "trunk.observe", lane: "trunk" }, ...this.trunkMovedEffects()] });
		return { slug: this.meta("slug"), name: this.meta("name"), description: this.meta("description") };
	}

	/** Delete the project. With `keepRepos`, forget it here and leave its repositories, for a project that has moved. */
	async destroy(keepRepos = false) {
		this.requireProject();
		for (const repo of keepRepos ? [] : [this.trunk, `${this.meta("slug")}--context`, ...this.attempts().map((a) => a.repo), ...this.rows<{ repo: string }>("SELECT repo FROM spares").map((r) => r.repo), `${this.meta("slug")}--landing`]) {
			try { await this.host.remove(repo); } catch {}
		}
		for (const { id } of this.rows<{ id: string }>("SELECT id FROM attempts WHERE hosted IS NOT NULL")) {
			try { await this.agentHost(id)?.clear(); } catch {}
		}
		for (const { ref } of this.rows<{ ref: string }>("SELECT DISTINCT ref FROM runs")) {
			try { await this.runner(ref)?.clear(); } catch {}
		}
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.schema();
	}

	async state(): Promise<State> {
		this.requireProject();
		const { landing, review } = ((await this.policy().catch(() => null))?.config ?? {}) as { landing?: any; review?: unknown };
		return {
			project: {
				slug: this.meta("slug"), name: this.meta("name"), description: this.meta("description"),
				repo: this.trunk, remote: this.meta("remote"), branch: this.branch, head: this.meta("head"), contextRemote: this.meta("context_remote") || null, llm: llmName(this.env), hosting: hosting(this.env), public: this.meta("public") === "1",
				policy: { landing: landing?.policy === "auto" ? "auto" : "person", review: review !== false && this.meta("review") !== "off" && !!reviewerName(this.env), reviewers: reviewers(this.env).map((r) => r.model), conflicts: landing?.conflicts === "auto" ? "auto" : "person" },
			},
			runs: this.rows("SELECT * FROM runs WHERE id IN (SELECT MAX(id) FROM runs GROUP BY ref)").map(this.toRun),
			queue: this.rows<any>("SELECT * FROM queue ORDER BY force DESC, at, attempt_id").map((q): QueuedLanding => ({ attemptId: q.attempt_id, by: q.by, at: q.at, attemptSha: q.attempt_sha, state: q.state, note: q.note, batch: q.batch_id ?? null })),
			batches: this.rows<any>("SELECT * FROM batches ORDER BY id").map((b) => ({
				id: b.id, trunkSha: b.trunk_sha, tipSha: b.tip_sha, state: b.state, at: b.at,
				members: this.rows<{ attempt_id: string }>("SELECT attempt_id FROM queue WHERE batch_id = ? ORDER BY position", b.id).map((r) => r.attempt_id),
			})),
			candidates: this.rows<any>("SELECT * FROM candidates").map((c) => ({ attemptId: c.attempt_id, sha: c.sha, trunkSha: c.trunk_sha, attemptSha: c.attempt_sha, runRef: c.run_ref ?? `land:${c.attempt_id}`, runSha: c.run_sha ?? c.sha })),
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
			reviews: this.rows("SELECT * FROM reviews WHERE id IN (SELECT MAX(id) FROM reviews GROUP BY attempt_id) ORDER BY id").map(this.toReview),
			outcomes: this.rows<any>("SELECT * FROM outcomes ORDER BY id DESC LIMIT 80").map((r): Outcome => ({
				id: r.id, kind: r.kind, outcome: r.outcome, text: r.text, attemptId: r.attempt_id, intentId: r.intent_id, by: r.by, ref: r.ref, sha: r.sha ?? "", at: r.at,
			})),
			stuck: this.log.effects("failed").map((e) => ({ id: e.id, type: e.type, error: redact(splitError(e.lastError ?? "").message), tries: e.tries, at: e.updatedAt, attemptId: typeof e.data.attemptId === "string" ? e.data.attemptId : null })),
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
	}

	/**
	 * Start an attempt: the agent gets its own fork of trunk in Artifacts and its credentials.
	 * Making a fork takes seconds, so a few are kept ready (see keepSpares) and one is taken here when
	 * it starts from trunk's head. Without one, the fork is made now. Nothing else waits on this.
	 */
	async join(input: { intentId: number; agent: string; kind?: string; origin: string }): Promise<JoinResult> {
		this.requireProject();
		const open = () => {
			const intent = this.intent(input.intentId);
			if (intent.status !== "open") throw new BraidError(`I${intent.id} is ${intent.status}`);
			return intent;
		};
		let intent = open();
		const head = this.meta("head");
		if (!head) throw new BraidError("trunk has no commits yet: push a first commit before starting attempts");
		const agent = (input.agent || "agent").trim().slice(0, 40);
		let repo = "", remote: string, base: string;
		const spare = this.rows<{ repo: string; remote: string; base_sha: string }>("SELECT * FROM spares WHERE base_sha = ? ORDER BY at LIMIT 1", head)[0];
		if (spare) {
			// Taken before anything is awaited, so two joins at once cannot be given the same fork.
			this.log.commit({ events: [{ type: "spare.taken", data: { repo: spare.repo } }] });
			[repo, remote, base] = [spare.repo, spare.remote, spare.base_sha];
		} else {
			const fork = () => {
				repo = `${this.meta("slug")}--a-${crypto.randomUUID().slice(0, 8)}`;
				return this.host.fork(this.trunk, repo, `Braid attempt (${agent}) for: ${intent.title}`);
			};
			// Several forks of one repository at once sometimes fail in Artifacts; a second try under a new name gets through.
			remote = (await fork().catch(() => fork())).remote;
			base = (await this.host.log(repo, this.branch, 1))[0]?.hash ?? head;
		}
		let gitToken: string, trunkToken: string;
		try {
			[gitToken, trunkToken] = await Promise.all([this.host.token(repo, "write", 86400), this.host.token(this.trunk, "read", 86400)]);
			intent = open(); // it may have landed or been abandoned while the fork was being made
		} catch (e) {
			this.log.commit({ effects: [this.removeEffect(repo)] });
			throw e;
		}
		const n = this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE intent_id = ?", intent.id)[0].n + 1;
		const id = `${intent.id}.${n}`;
		const token = "brd_" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
		this.sql.exec(
			`INSERT INTO attempts (id, intent_id, agent, kind, repo, remote, token, base_sha, head_sha, trunk_seen, status, summary, files, claims, behind,
				trunk_conflicts, checks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', '', '[]', '[]', 0, '[]', '[]', ?, ?)`,
			id, intent.id, agent, input.kind ?? "agent", repo, remote, token, base, base, base, now(), now(),
		);
		this.log.commit({
			events: [this.noted("attempt", agent, `${agent} started attempt ${id} on I${intent.id} from ${short(base)}`, intent.id, id)],
			// A fork made while trunk moved starts behind it: have that read. And make the next spare.
			effects: [...(base === this.meta("head") ? [] : [this.observeEffect(id)]), this.spareEffect()],
		});
		this.broadcast();
		return {
			attemptId: id, intentId: intent.id, branch: this.branch, remote, gitToken, agentToken: token,
			trunkRemote: this.meta("remote"), trunkToken,
			mcpUrl: `${input.origin}/mcp/${this.meta("slug")}`, brief: this.briefText(this.attempt(id)),
		};
	}

	/** How many forks to keep ready: a couple, and more while attempts are being started quickly. */
	private spareTarget() {
		const floor = this.env.SPARE_FORKS === undefined ? SPARE_FORKS : Math.max(0, Number(this.env.SPARE_FORKS) || 0);
		if (!floor) return 0;
		const lately = this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE created_at > ?", now() - 120_000)[0].n;
		return Math.min(SPARE_FORKS_MAX, Math.max(floor, lately));
	}

	/** Replace spare forks that trunk has moved past, and make new ones up to the number wanted. */
	private trunkMovedAt = 0;
	private async keepSpares() {
		if (!this.trunk || !this.meta("head")) return;
		// While landings are still coming, a fork made now is behind by the next one. Wait until trunk has been still.
		const still = now() - this.trunkMovedAt;
		if (still < SPARE_SETTLE_MS || this.rows("SELECT 1 FROM queue LIMIT 1").length) {
			this.log.commit({ effects: [{ ...this.spareEffect(), after: now() + Math.max(SPARE_SETTLE_MS - still, 5000) }] });
			return;
		}
		const slug = this.meta("slug");
		const stale = this.rows<{ repo: string }>("SELECT repo FROM spares WHERE base_sha != ?", this.meta("head"));
		if (stale.length) this.log.commit({ events: stale.map((s) => ({ type: "spare.dropped", data: { repo: s.repo } })), effects: stale.map((s) => this.removeEffect(s.repo)) });
		const one = async () => {
			const repo = `${slug}--a-${crypto.randomUUID().slice(0, 8)}`;
			const forked = await this.host.fork(this.trunk || `${slug}--trunk`, repo, "Braid: a fork of trunk kept ready for the next attempt");
			const base = (await this.host.log(repo, this.branch, 1))[0]?.hash ?? "";
			// The project was deleted, or trunk moved, while the fork was being made: it is of no use.
			if (!this.trunk || base !== this.meta("head")) return void (await this.host.remove(repo).catch(() => {}));
			this.log.commit({ events: [{ type: "spare.ready", data: { repo, remote: forked.remote, base } }] });
		};
		// A few at a time, and the number wanted is read again each round: it grows while attempts are being started.
		for (let round = 0; round < 6 && this.trunk; round++) {
			const short = this.spareTarget() - this.rows<{ n: number }>("SELECT COUNT(*) AS n FROM spares WHERE base_sha = ?", this.meta("head"))[0].n;
			if (short <= 0) return;
			const made = await Promise.allSettled(Array.from({ length: Math.min(short, 4) }, one));
			if (made.every((m) => m.status === "rejected")) throw (made[0] as PromiseRejectedResult).reason;
		}
	}

	async abandonAttempt(id: string, by = "human") {
		const a = this.attempt(id);
		if (!LIVE.has(a.status)) throw new BraidError(`attempt ${id} is ${a.status}`);
		this.setStatus(id, "abandoned");
		this.note("attempt", by, `Attempt ${id} abandoned`, a.intentId, id);
		await this.retire(id);
	}

	/** Undo an abandon. */
	async restoreAttempt(id: string, by = "human") {
		const a = this.attempt(id);
		if (a.status !== "abandoned") throw new BraidError(`attempt ${id} is ${a.status}, not abandoned`);
		if (this.intent(a.intentId).status !== "open") throw new BraidError(`I${a.intentId} is ${this.intent(a.intentId).status}; reopen is only for attempts of an open intent`);
		this.setStatus(id, "working");
		this.note("attempt", by, `Attempt ${id} reopened`, a.intentId, id);
		this.log.commit({ effects: [this.observeEffect(id)] });
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
		if (kind === "feedback") this.log.commit({ effects: this.advanceEffect() });
		if (kind === "answer") this.log.commit({ effects: [this.considerEffect(a.id)] });
		this.broadcast();
		return { ok: true, broughtBack, ...(couldNot ? { couldNot } : {}) };
	}

	/** An attempt that is over takes no further part: its agent is stopped and any landing asked for it is dropped. */
	private async retire(id: string) {
		this.sql.exec("DELETE FROM queue WHERE attempt_id = ?", id);
		// It can no longer collide with anyone.
		if (this.rows("SELECT 1 FROM overlaps WHERE a = ? OR b = ? LIMIT 1", id, id).length) this.log.commit({ events: [{ type: "overlaps.changed", attemptId: id, data: { overlaps: [] } }] });
		this.log.cancel({ lane: `repo:${id}` }, "the attempt is over");
		this.log.cancel({ lane: `review:${id}` }, "the attempt is over");
		// With this one over, another attempt at the intent may be the only one left, which is when the policy may land it.
		const intentId = this.rows<{ intent_id: number }>("SELECT intent_id FROM attempts WHERE id = ?", id)[0]?.intent_id;
		const others = this.rows<{ id: string }>("SELECT id FROM attempts WHERE intent_id = ? AND id != ? AND status = 'ready'", intentId ?? -1, id);
		if (others.length) this.log.commit({ effects: others.map((o) => this.considerEffect(o.id)) });
		const hosted = this.rows<{ hosted: string | null }>("SELECT hosted FROM attempts WHERE id = ?", id)[0]?.hosted;
		// A stop that fails is tried again by the worker: an agent left running costs money.
		if (hosted === "starting" || hosted === "running") this.log.commit({ effects: [this.stopEffect(id, "the attempt is over")] });
	}

	// ── awareness: what changed, and who is about to collide ─────────────────

	/** Trunk's own line, newest first. Kept between calls, and read again only when the head held is not the recorded one. */
	private trunkAt: CommitMeta[] | null = null;
	private async trunkLog(): Promise<CommitMeta[]> {
		const head = this.meta("head");
		return head && this.trunkAt?.[0]?.hash === head ? this.trunkAt : this.readTrunk();
	}

	/** Read trunk from Artifacts. If its head is not the recorded one, trunk moved, and everything that depends on it is looked at again. */
	private async readTrunk(): Promise<CommitMeta[]> {
		for (let tries = 0; ; tries++) {
			const was = this.meta("head"), held = this.trunkAt;
			const log = await this.host.log(this.trunk, this.branch, 300);
			if (this.meta("head") !== was && tries < 3) continue; // a landing was recorded while this was being read
			const head = log[0]?.hash;
			// An answer naming a commit that is already behind the recorded head is an old answer, not a move.
			if (head && head !== was && (held?.slice(1).some((c) => c.hash === head) || this.rows("SELECT 1 FROM landings WHERE parent_sha = ?", head).length)) return held ?? log;
			this.trunkAt = log;
			if (head && head !== was) {
				this.log.commit({
					events: [{ type: "trunk.moved", data: { head } }, ...(was ? [] : [this.noted("project", "braid", `Trunk received its first commit ${short(head)}`)])],
					effects: this.trunkMovedEffects(),
				});
				this.broadcast();
			}
			return log;
		}
	}

	/** Trunk has a new head: every live attempt stands differently to it, trunk itself needs verifying, and the spare forks are behind. */
	private trunkMovedEffects(): NewEffect[] {
		const live = this.rows<{ id: string }>("SELECT id FROM attempts WHERE status IN ('working', 'ready', 'conflicted')");
		this.trunkMovedAt = now();
		return [...live.map((a) => this.observeEffect(a.id)), this.runEffect("trunk"), { ...this.spareEffect(), after: now() + SPARE_SETTLE_MS }, ...this.advanceEffect()];
	}

	/** Requests waiting to hear that an attempt has been read since they asked. */
	private tick = 0;
	private waiting: { id: string; asked: number; done: (fresh: boolean) => void }[] = [];
	/** Ask for an attempt to be read again and wait a little for it. False means the answer will be from what was known before. */
	private observed(id: string, ms = OBSERVE_WAIT_MS): Promise<boolean> {
		const asked = ++this.tick;
		this.log.commit({ effects: [this.observeEffect(id)] });
		return new Promise((resolve) => {
			const w = { id, asked, done: resolve };
			this.waiting.push(w);
			setTimeout(() => { this.waiting = this.waiting.filter((x) => x !== w); resolve(false); }, ms);
		});
	}

	/**
	 * Read one attempt from Artifacts: its head, the trunk commit it is based on, what it changed, what
	 * would conflict with trunk, and where it meets the other live attempts. Only this attempt's
	 * repository is read; the others are compared from what is already recorded about them.
	 */
	private async observe(id: string): Promise<void> {
		if (!this.trunk) return;
		const row = this.rows<any>("SELECT * FROM attempts WHERE id = ?", id)[0];
		if (!row || !LIVE.has(row.status)) return;
		let a = this.toAttempt(row);
		const trunkLog = await this.trunkLog(), trunkHead = trunkLog[0], combining = await this.combining();
		const head = (await this.host.log(a.repo, this.branch, 1))[0];
		if (!head || !trunkHead) return;
		let git: Observed | null = null, scripts: { base: Record<string, string>; head: Record<string, string> } | null | undefined, rewrote = false;
		if (head.hash !== a.headSha || row.trunk_seen !== trunkHead.hash) {
			const base = (await mergeBase(this.host, a.repo, head.hash, trunkLog.map((c) => c.hash))) ?? a.baseSha;
			const baseTree = (await this.host.readCommit(a.repo, base))?.treeHash ?? null;
			const files = await diffTrees(this.host, a.repo, baseTree, head.treeHash);
			const behind = Math.max(0, trunkLog.findIndex((c) => c.hash === base));
			const trunkConflicts: string[] = [];
			if (behind > 0 && files.length) {
				const trunkFiles = new Map((await diffTrees(this.host, this.trunk, baseTree, trunkHead.treeHash)).map((f) => [f.path, f]));
				for (const f of files) {
					const t = trunkFiles.get(f.path);
					if (!t || t.head === f.head) continue;
					if (predict(await this.text(a.repo, f.base), await this.text(this.trunk, t.head), await this.text(a.repo, f.head), combining && !GENERATED.test(f.path)).conflict) trunkConflicts.push(f.path);
				}
			}
			git = { baseSha: base, headSha: head.hash, files, behind, trunkConflicts, trunkSeen: trunkHead.hash };
			// What a check runs can be changed in package.json without touching a test: compare its scripts.
			const pkg = files.find((f) => f.path === "package.json" && f.status === "modified");
			const read = async (hash: string | null) => { try { return (JSON.parse((await this.text(a.repo, hash)) ?? "{}").scripts ?? {}) as Record<string, string>; } catch { return {}; } };
			if (pkg) scripts = { base: await read(pkg.base), head: await read(pkg.head) };
			// A head the previous one cannot be reached from was pushed over it.
			if (head.hash !== a.headSha && a.headSha !== a.baseSha) rewrote = !(await this.host.log(a.repo, this.branch, 200)).some((c) => c.hash === a.headSha);
			a = { ...a, ...git };
		}
		const order = new Map(trunkLog.map((c, i) => [c.hash, i]));
		const others = this.attempts().filter((o) => o.id !== id && LIVE.has(o.status) && o.intentId !== a.intentId);
		const shared: Overlap[] = [];
		for (const o of others) shared.push(...await fileOverlaps(a, o, order, (repo, hash) => this.text(repo, hash), combining));
		this.recordObserved(id, row.head_sha, git, shared, new Map(others.map((o) => [o.id, o.headSha])), scripts, rewrote);
	}

	/** The flags for an attempt as it stands. Those that need a file read (changed scripts) or a moment in time (history pushed over) are carried over when not worked out afresh. */
	private flagsFor(a: Attempt, scripts?: { base: Record<string, string>; head: Record<string, string> } | null, rewrote = false): Flag[] {
		const fresh = diffFlags(a.files, a.claims, scripts ?? null);
		const kept = a.flags.filter((f) => f.kind === "history" || (scripts === undefined && f.kind === "checks" && f.paths.length === 1 && f.paths[0] === "package.json" && a.files.some((x) => x.path === "package.json")));
		const session = sessionFlags(this.rows<{ kind: string; text: string }>("SELECT kind, text FROM session WHERE attempt_id = ? AND kind = 'tool' ORDER BY id", a.id));
		const history: Flag[] = rewrote && !kept.some((f) => f.kind === "history") ? [{ kind: "history", text: "Pushed over its own earlier commits, so what was looked at before may be gone", paths: [] }] : [];
		const seen = new Set<string>();
		return [...fresh, ...kept, ...history, ...session].filter((f) => { const k = `${f.kind}|${f.text}`; return seen.has(k) ? false : (seen.add(k), true); });
	}

	/** Write down what a reading found. No awaiting here: it is decided against what is true now, which may have moved during the reading. */
	private recordObserved(id: string, started: string, git: Observed | null, shared: Overlap[], compared: Map<string, string>, scripts?: { base: Record<string, string>; head: Record<string, string> } | null, rewrote = false) {
		const row = this.rows<any>("SELECT * FROM attempts WHERE id = ?", id)[0];
		if (!row || !LIVE.has(row.status)) return;
		// Another reading of this attempt was written down meanwhile: this one compared an older commit. Read again.
		if (row.head_sha !== started) { this.log.commit({ effects: [this.observeEffect(id)] }); return; }
		const before = this.toAttempt(row), a: Attempt = git ? { ...before, ...git } : before;
		const events: NewEvent[] = [], effects: NewEffect[] = [];
		if (git) {
			events.push({ type: "attempt.observed", attemptId: id, intentId: a.intentId, data: git });
			if (git.headSha !== before.headSha) events.push(this.noted("push", a.agent, `${a.agent} pushed ${short(a.headSha)} to attempt ${a.id} (${a.files.length} file${a.files.length === 1 ? "" : "s"} changed)`, a.intentId, a.id));
			// An agent that merged trunk into its attempt has reconciled the git way: the open reconciliation is moot.
			if (before.status === "conflicted" && git.behind === 0) {
				a.status = "ready";
				events.push({ type: "attempt.status", attemptId: id, data: { status: "ready" } }, { type: "reconciliation.dropped", attemptId: id },
					this.noted("reconcile", a.agent, `${a.agent} merged trunk into attempt ${a.id}; it is ready to land again`, a.intentId, a.id));
			}
			effects.push(...this.advanceEffect());
		}
		// Every new commit of an attempt is verified in a sandbox.
		if (a.headSha !== a.baseSha && this.latestRun(id)?.sha !== a.headSha) effects.push(this.runEffect(id));
		const flags = this.flagsFor(a, git ? scripts ?? null : undefined, rewrote);
		if (json(flags) !== json(before.flags)) events.push({ type: "attempt.flagged", attemptId: id, intentId: a.intentId, data: { flags } });
		// A commit pushed to an attempt that is marked ready is a new thing to review.
		if (git && git.headSha !== before.headSha && a.status === "ready") effects.push(this.reviewEffect(id));
		const live = new Map(this.attempts().filter((o) => LIVE.has(o.status)).map((o) => [o.id, o]));
		live.set(id, a);
		const others = [...live.values()].filter((o) => o.id !== id && o.intentId !== a.intentId);
		// Claims are compared here, from what is recorded this instant; a claim made during the reading is not missed.
		const next = strongest([...shared.filter((o) => live.has(o.a) && live.has(o.b)), ...others.flatMap((o) => claimOverlaps(a, o))]);
		events.push(...this.overlapEvents(a, next, live));
		// Another attempt moved while this one was being compared with it: compare again.
		if (others.some((o) => (compared.has(o.id) ? compared.get(o.id) !== o.headSha : o.files.length > 0))) effects.push(this.observeEffect(id));
		this.log.commit({ events, effects });
		this.broadcast();
	}

	/** The events for an attempt's overlaps becoming `next`: the new set, and a heads-up to both sides for each one that is new or worse. */
	private overlapEvents(a: Attempt, next: Overlap[], live: Map<string, Attempt>): NewEvent[] {
		const before = this.rows<Overlap>("SELECT a, b, path, severity, regions FROM overlaps WHERE a = ? OR b = ?", a.id, a.id);
		const events: NewEvent[] = [];
		for (const { overlap: o, had } of risen(before, next)) {
			const A = live.get(o.a)!, B = live.get(o.b)!;
			for (const [me, other] of [[A, B], [B, A]]) events.push(this.signalled(me.id, "overlap", { path: o.path, severity: o.severity, with: this.describe(other, o.path) }));
			if (o.severity !== "claim" || !had) {
				const verb = o.severity === "conflict" ? "will conflict on" : o.severity === "touch" ? "both changed" : "both plan to change";
				events.push(this.noted(o.severity === "conflict" ? "conflict" : "overlap", "braid", `${A.agent} (I${A.intentId}) and ${B.agent} (I${B.intentId}) ${verb} ${o.path}`));
			}
		}
		const flat = (list: Overlap[]) => list.map((o) => `${o.a}|${o.b}|${o.path}|${o.severity}|${o.regions}`).sort().join("\n");
		if (flat(before) !== flat(next)) events.push({ type: "overlaps.changed", attemptId: a.id, data: { overlaps: next } });
		return events;
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

	/** Called for every push in the Artifacts namespace (via PushWorkflow). The push is only written down here; reading it is the worker's job. */
	async onPush(repo: string) {
		if (!this.trunk) return;
		const row = this.rows<{ id: string }>("SELECT id FROM attempts WHERE repo = ?", repo)[0];
		if (row) this.log.commit({ effects: [this.observeEffect(row.id)] });
		else if (repo === this.trunk) this.log.commit({ effects: [{ id: "trunk.observe", type: "trunk.observe", lane: "trunk" }] });
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
		this.sql.exec("UPDATE attempts SET hosted = 'starting' WHERE id = ?", joined.attemptId);
		this.log.commit({
			events: [this.noted("attempt", "braid", `Starting ${agent} for attempt ${joined.attemptId} in a Cloudflare sandbox`, intentId, joined.attemptId)],
			effects: [{ id: `agent.start:${joined.attemptId}`, type: "agent.start", lane: `agent:${joined.attemptId}`, data: { attemptId: joined.attemptId, kind, task: "work" } }],
		});
		this.broadcast();
		return { attemptId: joined.attemptId };
	}

	/** Hand the job to the attempt's agent host. If that cannot be done, the attempt says so instead of showing "starting" for ever. */
	private async doStartAgent(attemptId: string, kind: HostedKind, task: HostJob["task"], willRetry: boolean) {
		const row = this.rows<any>("SELECT * FROM attempts WHERE id = ?", attemptId)[0];
		if (!row || !LIVE.has(row.status) || row.hosted !== "starting") return; // over, or stopped, before it began
		const a = this.toAttempt(row);
		const job: HostJob = {
			slug: this.meta("slug"), attemptId: a.id, kind, agent: a.agent, repo: a.repo, remote: a.remote, trunkRepo: this.trunk,
			trunkRemote: this.meta("remote"), branch: this.branch, agentToken: row.token, brief: this.briefText(a), task,
		};
		try {
			await this.agentHost(a.id)!.start(job);
		} catch (e) {
			const said = splitError(e);
			if (said.status === 409) return; // it is already running: an earlier try got through
			if (willRetry) throw e;
			this.sql.exec("UPDATE attempts SET hosted = 'failed', hosted_detail = ? WHERE id = ? AND hosted = 'starting'", `could not start: ${said.message}`.slice(0, 500), a.id);
			this.log.commit({ events: [
				this.noted("attempt", "braid", `Could not start ${a.agent} for attempt ${a.id}: ${said.message}`, a.intentId, a.id),
				this.settled("agent", "failed", `Could not start ${a.agent}: ${said.message}`, a),
			] });
			this.broadcast();
		}
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
		if (row.hosted === "starting" || row.hosted === "running") throw new BraidError(`${a.agent} is already running for attempt ${a.id}`, 409);
		this.sql.exec("UPDATE attempts SET hosted = 'starting', hosted_detail = '' WHERE id = ?", a.id);
		this.log.commit({ effects: [{ id: `agent.start:${a.id}`, type: "agent.start", lane: `agent:${a.id}`, data: { attemptId: a.id, kind, task } }] });
		this.note("attempt", "braid", `Bringing ${a.agent} back to attempt ${a.id} in a Cloudflare sandbox to ${task === "reconcile" ? "reconcile with trunk" : task === "respond" ? "act on a person's note" : "fix failed verification"}`, a.intentId, a.id);
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
		// Same lane as the start: a stop asked for while the agent is still being started happens after it, not before.
		this.log.commit({ effects: [this.stopEffect(attemptId, "stopped by a person")] });
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
		// An agent that was sent a conflict and left it open has had its turn. A person stopping it is a person taking over.
		const left = this.rows<{ id: number }>("SELECT id FROM reconciliations WHERE attempt_id = ? AND status = 'open' AND auto = 'agent'", attemptId)[0];
		if (left && state !== "stopped" && LIVE.has(a.status)) { await this.policy(); this.sendOn(left.id, a, "model"); }
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

	/**
	 * Whether a merge may keep both sides where both only added lines at the same place. Only when the result
	 * will be run before it lands: a project with checks, and not turned off in trunk's braid.json (landing.combine).
	 */
	private async combining(): Promise<boolean> {
		if (!this.env.RUNNER || (await this.policy()).config?.landing?.combine === false) return false;
		const run = this.rows<any>("SELECT * FROM runs WHERE ref = 'trunk' AND status IN ('pass', 'fail') ORDER BY id DESC LIMIT 1")[0];
		return !!run && !run.nothing_to_run;
	}

	private async startRun(ref: string, target: { repo: string; remote: string; sha: string; branch: string }, regenerate?: string[]) {
		const runId = this.rows<{ id: number }>("INSERT INTO runs (ref, sha, status, steps, preview, nothing_to_run, error, started_at) VALUES (?, ?, 'queued', '[]', 0, 0, NULL, ?) RETURNING id", ref, target.sha, now())[0].id;
		const job: RunJob = { slug: this.meta("slug"), ref, repo: target.repo, remote: target.remote, branch: target.branch, sha: target.sha, runId, policy: await this.policy(), ...(regenerate ? { regenerate } : {}) };
		try {
			await this.runner(ref)!.start(job);
		} catch (e) {
			// A run that never reached its runner must not stand as "queued": the next try would take the commit for run.
			this.sql.exec("DELETE FROM runs WHERE id = ?", runId);
			throw e;
		}
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

		const checked = (run.steps.filter((s) => s.name !== "clone" && s.name !== "install").length ? run.steps.filter((s) => s.name !== "clone" && s.name !== "install") : run.steps).map((s) => `${s.name} ${s.status === "pass" ? "✓" : "✗"}`).join(" · ");
		const result = run.status === "error" ? `could not run: ${run.error}` : run.nothingToRun ? "nothing to run" : checked;
		if (run.ref.startsWith("batch:")) {
			// The merge of a batch of landings, or one step of it. The queue decides what follows.
			const [, id, position] = run.ref.split(":");
			const members = this.rows<{ attempt_id: string; position: number }>("SELECT attempt_id, position FROM queue WHERE batch_id = ? ORDER BY position", Number(id));
			const one = position === undefined ? null : members.find((m) => m.position === Number(position));
			const what = one ? `attempt ${one.attempt_id} as merged in its batch` : members.length === 1 ? `attempt ${members[0].attempt_id} merged with trunk` : `attempts ${members.map((m) => m.attempt_id).join(", ")} merged with trunk together`;
			const about = one ?? (members.length === 1 ? members[0] : null), a = about ? this.attempt(about.attempt_id) : null;
			this.log.commit({ events: [this.noted("verify", "braid", `Verified ${what} at ${short(run.sha)}: ${result}`, a?.intentId ?? null, a?.id ?? null)], effects: this.advanceEffect() });
			this.broadcast();
			return;
		}
		const merged = run.ref.includes(":"), locking = run.ref.startsWith("lock:");
		const a = run.ref === "trunk" ? null : this.attempt(run.ref.slice(run.ref.indexOf(":") + 1));
		if (a && locking) {
			this.note("verify", "braid", run.status === "pass" ? `Regenerated the lockfile for attempt ${a.id} merged with trunk` : `Could not regenerate the lockfile for attempt ${a.id}: ${run.error ?? run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}`, a.intentId, a.id);
			this.log.commit({ effects: this.advanceEffect() });
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
		// A result can be what a landing was waiting for, or what the landing policy was waiting for.
		this.log.commit({ effects: [...this.advanceEffect(), ...(a && !merged && LIVE.has(a.status) ? [this.considerEffect(a.id), ...(a.status === "ready" && a.headSha === run.sha ? [this.reviewEffect(a.id)] : [])] : [])] });
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
		const merged = candidate?.run_ref ? this.latestRun(candidate.run_ref) : null;
		return {
			status: run.status, commit: short(run.sha), steps: run.steps.map((s) => ({ step: s.name, status: s.status, exit_code: s.exitCode })),
			...(run.status === "queued" || run.status === "running" ? { note: "still running; a failure will arrive in heads_up" } : {}),
			...(merged && merged.sha === candidate.run_sha ? { merged_with_trunk: {
				status: merged.status, trunk: short(candidate.trunk_sha),
				steps: merged.steps.map((s) => ({ step: s.name, status: s.status, exit_code: s.exitCode, ...(s.status === "fail" ? { command: s.command, output: s.tail.slice(-2000) } : {}) })),
				...(merged.status === "fail" ? { note: "Your commit passes alone but fails once merged with trunk. Merge trunk into your attempt (`sync`), fix it, push, and checkpoint." } : {}),
			} } : {}),
		};
	}

	// ── review: a reading of an attempt against its intent, and a policy that may act on it ──

	/** The model that reviews. A field, so a test can put a stand-in here. */
	reviewer: (env: BraidEnv, input: ReviewInput, pick?: Reviewer | null) => Promise<Awaited<ReturnType<typeof reviewAttempt>>> = reviewAttempt;

	/** What an agent is told about the review of its current commit. */
	private reviewFor(a: Attempt) {
		const r = this.reviewOf(a.id);
		if (!r || r.sha !== a.headSha) return { status: "not reviewed" };
		if (r.status !== "done") return { status: r.status === "running" ? "being reviewed" : "the review could not be made" };
		return {
			status: "reviewed", verdict: r.verdict, summary: r.summary,
			criteria: r.criteria.map((c, i) => ({ n: i + 1, criterion: c.text, verdict: c.verdict, why: c.why })),
			...(r.concerns.length ? { concerns: r.concerns } : {}), ...(r.changes ? { changes_asked_for: r.changes } : {}),
		};
	}

	/** Ask for an attempt's current commit to be reviewed (again). */
	async review(attemptId: string) {
		this.requireProject();
		const a = this.attempt(attemptId);
		if (!LIVE.has(a.status)) throw new BraidError(`attempt ${a.id} is ${a.status}`);
		if (a.headSha === a.baseSha) throw new BraidError(`attempt ${a.id} has no commits to review`);
		if (!reviewerName(this.env)) throw new BraidError("this Braid instance has no model to review with", 501);
		this.log.commit({ effects: [this.reviewEffect(a.id, true)] });
		return { queued: true };
	}

	private async doReview(attemptId: string, again: boolean) {
		const config = (await this.policy()).config as { review?: unknown; reviewer?: unknown } | null;
		const row = this.rows<any>("SELECT * FROM attempts WHERE id = ?", attemptId)[0];
		if (!row || !LIVE.has(row.status) || row.head_sha === row.base_sha || !reviewerName(this.env)) return;
		if (!again && (config?.review === false || this.meta("review") === "off" || row.status !== "ready")) return;
		const a = this.toAttempt(row), intent = this.intent(a.intentId), last = this.reviewOf(a.id);
		if (!again && last?.sha === a.headSha && last.status === "done") return;
		// The reviewer is shown what the checks found, so it waits for them. Their result asks for the review again.
		const checked = this.latestRun(a.id);
		if (!again && this.env.RUNNER && (!checked || checked.sha !== a.headSha || checked.status === "queued" || checked.status === "running")) return;
		// By default, a model from a different maker than the agent that wrote the attempt.
		const pick = reviewerFor(this.env, a.kind, config?.reviewer);
		const id = this.rows<{ id: number }>("INSERT INTO reviews (attempt_id, intent_id, sha, status, by, at) VALUES (?, ?, ?, 'running', ?, ?) RETURNING id", a.id, a.intentId, a.headSha, pick?.model ?? "", now())[0].id;
		this.broadcast();
		try {
			const files = await this.diff(a.id);
			const input: ReviewInput = {
				intent, criteria: intent.criteria, agent: a.agent, summary: a.summary, files, flags: a.flags, run: this.latestRun(a.id)?.sha === a.headSha ? this.latestRun(a.id) : null,
				decisions: this.decisionsFor(a.id).filter((d) => d.agent !== "braid" && d.kind !== "feedback" && d.kind !== "answer"),
			};
			const answer = await this.reviewer(this.env, input, pick);
			const kept = settle(answer, intent.criteria, files, input.run?.status === "pass");
			this.sql.exec("UPDATE reviews SET status = 'done', verdict = ?, criteria = ?, summary = ?, concerns = ?, changes = ?, by = ?, finished_at = ? WHERE id = ?",
				kept.verdict, json(kept.criteria), redact(kept.summary), json(kept.concerns.map((c) => redact(c))), redact(kept.changes), answer.model, now(), id);
			const met = kept.criteria.filter((c) => c.verdict === "met").length;
			this.log.commit({
				events: [this.noted("review", answer.model, `Reviewed attempt ${a.id} at ${short(a.headSha)}: ${kept.verdict === "approve" ? "every criterion met" : kept.verdict === "changes" ? "changes asked for" : "left to a person"} (${met} of ${kept.criteria.length} criteria met)`, a.intentId, a.id)],
				effects: [this.considerEffect(a.id)],
			});
		} catch (e) {
			// Not tried again by itself: a person can ask for the review again.
			const said = splitError(e).message;
			this.sql.exec("UPDATE reviews SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", said.slice(0, 500), now(), id);
			this.log.commit({ events: [this.noted("review", "braid", `Attempt ${a.id} could not be reviewed: ${said}`, a.intentId, a.id)], effects: [this.considerEffect(a.id)] });
		}
		this.broadcast();
	}

	/**
	 * The landing policy, for one attempt. A project that sets `"landing": { "policy": "auto" }` in trunk's
	 * braid.json has an attempt landed without a person when its agent marked it ready, its checks passed,
	 * the review found every criterion met, nothing is flagged, no question is open, and it is the only live
	 * attempt at its intent. The landing goes through the queue like anyone's. When the reviewer asks for changes
	 * the attempt is sent back with them, twice at most. Whatever stops it is written on the attempt.
	 * Nothing is awaited here: it decides from what is recorded.
	 */
	private consider(attemptId: string) {
		const row = this.rows<any>("SELECT * FROM attempts WHERE id = ?", attemptId)[0];
		if (!row) return;
		const a = this.toAttempt(row), auto = this.policyAt?.policy.config?.landing?.policy === "auto";
		const hold = (why: string, kind: Attempt["heldFor"] = "") => { if (a.held !== why || a.heldFor !== kind) { this.sql.exec("UPDATE attempts SET held = ?, held_for = ? WHERE id = ?", why, kind, a.id); this.broadcast(); } };
		if (!auto || !LIVE.has(a.status) || a.status !== "ready" || this.intent(a.intentId).status !== "open") return hold("");
		if (this.rows("SELECT 1 FROM queue WHERE attempt_id = ?", a.id).length) return hold("");
		const run = this.env.RUNNER ? this.latestRun(a.id) : null;
		if (this.env.RUNNER && (!run || run.sha !== a.headSha || run.status === "queued" || run.status === "running")) return hold("Waiting for its checks.", "checks");
		if (run && run.status !== "pass") return hold(run.status === "fail" ? `Its checks failed (${this.failedSteps(run)}).` : "Its checks could not be run.", "checks-failed");
		const review = this.reviewOf(a.id);
		if (!reviewerName(this.env)) return hold("This instance has no model to review with, so a person lands it.", "no-reviewer");
		if (!review || review.sha !== a.headSha || review.status === "running") return hold("Waiting for its review.", "review");
		if (review.status === "failed") return hold(`It could not be reviewed: ${review.error}`, "review-failed");
		if (a.flags.length) return hold(`Flagged for a person: ${a.flags.map((f) => f.text.toLowerCase()).join("; ")}.`, "flags");
		const asked = this.decisionsFor(a.id);
		if (asked.some((q) => q.kind === "question" && !asked.some((d) => d.kind === "answer" && d.title === `Answer: ${q.title}`))) return hold("It asked a question that has no answer yet.", "question");
		if (this.rows("SELECT 1 FROM attempts WHERE intent_id = ? AND id != ? AND status IN ('working', 'ready', 'conflicted')", a.intentId, a.id).length) return hold("Another attempt at this intent is still going: a person chooses between them.", "choice");
		const tried = this.rows<any>("SELECT * FROM outcomes WHERE kind = 'landing' AND attempt_id = ? AND sha = ? ORDER BY id DESC LIMIT 1", a.id, a.headSha)[0];
		if (tried && tried.outcome !== "landed") return hold(`Its landing was ${tried.outcome === "conflict" ? "stopped by a conflict" : tried.outcome}: ${tried.text}`, "landing");
		if (review.verdict === "approve") {
			hold("");
			this.note("land", "policy", `Landing attempt ${a.id} by this project's policy: its checks passed, ${review.by} found every criterion met, and nothing is flagged`, a.intentId, a.id);
			void this.land(a.id, "policy", false, a.headSha).catch((e) => hold(`Its landing could not be asked for: ${splitError(e).message}`, "landing"));
			return;
		}
		if (review.verdict === "changes") {
			const rounds = asked.filter((d) => d.kind === "feedback" && d.agent === "reviewer").length;
			if (rounds >= 2) return hold("The reviewer asked for changes twice and is still not satisfied.", "reviewer");
			hold("");
			void this.respond(a.id, { kind: "feedback", body: review.changes, by: "reviewer", bringBack: a.kind === "claude" || a.kind === "codex" }).catch((e) => console.error("send back", a.id, e));
			return;
		}
		const open = review.criteria.find((c) => c.verdict !== "met");
		hold(`The reviewer left it to a person: ${open ? `"${open.text}" is ${open.verdict === "unclear" ? "not shown to be met" : "not met"}. ${open.why}` : review.summary}`, "reviewer");
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
			const created = await this.host.create(repo, `Braid context (why and sessions) for ${this.meta("name")}`);
			this.log.commit({ events: [{ type: "context.repo.created", data: { remote: created.remote } }] });
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
		if (!this.trunk) return; // deleted while the copy was being made
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
		if (pending.length) this.log.commit({ events: [{ type: "signals.delivered", attemptId: me.id, data: { upTo: pending.at(-1).id } }] });
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
				// Nothing is read for this: a claim is compared with what is already recorded about the others.
				const live = new Map(this.attempts().filter((o) => LIVE.has(o.status)).map((o) => [o.id, o]));
				live.set(me.id, me);
				const kept = this.rows<Overlap>("SELECT a, b, path, severity, regions FROM overlaps WHERE (a = ? OR b = ?) AND severity != 'claim'", me.id, me.id);
				const next = strongest([...kept, ...[...live.values()].filter((o) => o.id !== me.id).flatMap((o) => claimOverlaps(me, o))]);
				this.log.commit({ events: [
					{ type: "attempt.claimed", attemptId: me.id, intentId: me.intentId, actor: me.agent, data: { claims: me.claims } },
					{ type: "attempt.flagged", attemptId: me.id, intentId: me.intentId, data: { flags: this.flagsFor(me) } },
					this.noted("claim", me.agent, `${me.agent} plans to change ${paths.join(", ")}${args.reason ? `: ${args.reason}` : ""}`, me.intentId, me.id),
					...this.overlapEvents(me, next, live),
				] });
				this.broadcast();
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
				const fresh = await this.observed(me.id);
				const a = this.attempt(me.id);
				if (args.summary) { a.summary = redact(String(args.summary)); this.saveAttempt(a); }
				return {
					head: a.headSha, changed: a.files.map((f) => `${f.status} ${f.path}`), behind_trunk_by: a.behind,
					would_conflict_with_trunk: a.trunkConflicts, overlaps: this.overlapsFor(a.id), verification: this.verification(a), review: this.reviewFor(a),
					...(fresh ? {} : { note: STALE_NOTE }),
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
				const fresh = await this.observed(me.id);
				const a = this.attempt(me.id);
				if (!LIVE.has(a.status)) throw new BraidError(`attempt ${a.id} is ${a.status}`, 409);
				if (a.headSha === a.baseSha) throw new BraidError(fresh ? "nothing pushed yet: push your commits to the attempt remote before marking ready" : "Braid has not seen a push to this attempt yet. If you have pushed, call `ready` again in a few seconds.");
				const run = this.latestRun(a.id);
				if (run?.sha === a.headSha && run.status === "fail") {
					throw new BraidError(`commit ${short(a.headSha)} failed verification (${run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}). Fix it and push before marking ready; \`checkpoint\` shows the result.`);
				}
				if (a.status === "working") a.status = "ready";
				if (args.summary) a.summary = redact(String(args.summary));
				this.saveAttempt(a);
				this.log.commit({ events: [this.noted("ready", a.agent, `${a.agent} marked attempt ${a.id} ready: ${a.summary}`, a.intentId, a.id)], effects: [this.reviewEffect(a.id), this.considerEffect(a.id)] });
				this.broadcast();
				return { status: a.status, would_conflict_with_trunk: a.trunkConflicts, overlaps: this.overlapsFor(a.id), verification: this.verification(a), review: this.reviewFor(a), ...(fresh ? {} : { note: STALE_NOTE }) };
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
			intent.acceptance ? `Done when (your attempt is reviewed against each of these):\n${intent.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : "",
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
		const review = this.reviewOf(a.id), reviewed = review?.status === "done" && review.sha === a.headSha ? review : null;
		if (reviewed) lines.push("", `Reviewed by ${reviewed.by}: ${reviewed.verdict === "approve" ? "every criterion met" : reviewed.verdict === "changes" ? "changes asked for" : "left to a person"}. ${reviewed.summary.replace(/\s+/g, " ")}`);
		lines.push("", `Braid-Intent: ${intent.id}`, `Braid-Attempt: ${a.id}`, `Braid-Agent: ${a.agent}`, ...(reviewed ? [`Braid-Reviewed-By: ${reviewed.by}`] : []));
		return lines.join("\n");
	}

	/**
	 * Ask for an attempt to be landed. Trunk only takes commits that have been run: the attempt's own
	 * commit must have passed, and when trunk has moved since the attempt started, the merge of the two
	 * is built, verified in a sandbox, and only then becomes trunk. Requests wait in a queue and are
	 * tried one at a time, so each is verified against the trunk it will actually land on.
	 * `sha` is the commit the person was looking at; `force` lands without waiting for any of this.
	 */
	async land(attemptId: string, by = "human", force = false, sha?: string): Promise<LandOutcome> {
		this.requireProject();
		const a = this.attempt(attemptId), intent = this.intent(a.intentId);
		if (intent.status !== "open") throw new BraidError(`I${intent.id} is already ${intent.status}`);
		if (!LIVE.has(a.status)) throw new BraidError(`attempt ${a.id} is ${a.status}`);
		if (a.headSha === a.baseSha) throw new BraidError(`attempt ${a.id} has no commits to land`);
		const hosted = this.rows<{ hosted: string | null }>("SELECT hosted FROM attempts WHERE id = ?", a.id)[0]?.hosted;
		if (!force && a.status === "working" && (hosted === "starting" || hosted === "running")) throw new BraidError(`${a.agent} is still working on attempt ${a.id} and has not marked it ready; wait, stop the agent, or land it anyway with force`, 409);
		if (sha && sha !== a.headSha) throw new BraidError(`attempt ${a.id} has moved to ${short(a.headSha)} since you looked at ${short(sha)}; review it again before landing`, 409);
		// Only written down here. The worker reads the attempt once more, and the queue decides against what it finds.
		const before = this.rows<any>("SELECT * FROM queue WHERE attempt_id = ?", a.id)[0];
		if (before?.state === "pushing") return { landed: false, queued: true, waiting: "landing now" };
		// "Land now" on something being verified with others takes it out of that batch, which is then built again without it.
		if (before && before.attempt_sha === a.headSha) this.sql.exec(`UPDATE queue SET force = ?, by = ?${force && before.batch_id ? ", batch_id = NULL, position = NULL, state = 'waiting', candidate_sha = NULL" : ""} WHERE attempt_id = ?`, force || before.force ? 1 : 0, by, a.id);
		else this.sql.exec("INSERT OR REPLACE INTO queue (attempt_id, by, at, attempt_sha, force, state, note) VALUES (?, ?, ?, ?, ?, 'waiting', '')", a.id, by, now(), a.headSha, force ? 1 : 0);
		this.log.commit({ effects: [this.observeEffect(a.id), ...this.advanceEffect()] });
		this.broadcast();
		return { landed: false, queued: true, waiting: this.rows<{ note: string }>("SELECT note FROM queue WHERE attempt_id = ?", a.id)[0]?.note ?? "" };
	}

	/** Take back a landing that was asked for and has not happened yet. */
	async cancelLanding(attemptId: string, by = "human") {
		const a = this.attempt(attemptId);
		if (!this.rows("SELECT 1 FROM queue WHERE attempt_id = ? AND state != 'pushing'", attemptId).length) throw new BraidError(`attempt ${attemptId} is not waiting to land`);
		this.sql.exec("DELETE FROM queue WHERE attempt_id = ?", attemptId);
		this.log.commit({ events: [this.noted("land", by, `Landing of attempt ${attemptId} cancelled`, a.intentId, a.id), this.settled("landing", "cancelled", "Landing cancelled", a, by, "", a.headSha)], effects: this.advanceEffect() });
		this.broadcast();
		return { ok: true };
	}

	/**
	 * Move the landing queue as far as it will go. Run by the worker, one at a time. Safe to run at any
	 * time, and again after being cut off: every step reads what is true now, and the queue and batch
	 * rows say how far things had got.
	 *
	 * Landings that are ready are merged one on top of the other and verified together with one run of
	 * the last merge (a batch). "Land now" goes alone and first.
	 */
	private async advance(): Promise<void> {
		for (let rounds = 0; rounds < 60; rounds++) {
			// "Land now", and a landing an older version was pushing when it stopped, go alone and ahead of everything.
			const solo = this.rows<any>("SELECT * FROM queue WHERE batch_id IS NULL AND (force = 1 OR state = 'pushing') ORDER BY at, attempt_id LIMIT 1")[0];
			if (solo) { await this.landAlone(solo); continue; }
			const batch = this.rows<any>("SELECT * FROM batches ORDER BY id LIMIT 1")[0];
			if (batch) { if ((await this.batchStep(batch)) === "hold") break; continue; }
			if ((await this.formBatch()) !== "again") break;
		}
		this.broadcast();
	}

	/** Whether the request a landing step is working on is still the one in the queue. Asked again after every wait on git. */
	private held(entry: any) { return this.rows("SELECT 1 FROM queue WHERE attempt_id = ? AND at = ?", entry.attempt_id, entry.at).length > 0; }
	private failedSteps(run: Run) { return run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", "); }
	private setNote(entry: any, note: string) { this.sql.exec("UPDATE queue SET note = ? WHERE attempt_id = ? AND at = ?", note, entry.attempt_id, entry.at); }
	private unqueue(entry: any) { this.sql.exec("DELETE FROM queue WHERE attempt_id = ? AND at = ?", entry.attempt_id, entry.at); }

	/** A landing that will not happen: taken out of the queue, with the reason where the person and the agent can see it. */
	private refuse(entry: any, why: string) {
		if (!this.held(entry)) return;
		this.unqueue(entry);
		const a = this.attempt(entry.attempt_id);
		this.log.commit({ events: [this.noted("land", "braid", `Attempt ${a.id} was not landed: ${why}`, a.intentId, a.id), this.settled("landing", "refused", why, a, String(entry.by), "", a.headSha)], effects: [this.considerEffect(a.id)] });
	}

	/** What can be told about a queued landing without reading anything: whether it can be merged now. */
	private gate(entry: any): { kind: "ready" | "gone" } | { kind: "wait" | "refused"; why: string } {
		const a = this.attempt(entry.attempt_id), intent = this.intent(a.intentId);
		if (!LIVE.has(a.status) || intent.status !== "open") return { kind: "gone" };
		if (a.headSha !== entry.attempt_sha) return { kind: "refused", why: `attempt ${a.id} moved to ${short(a.headSha)} after landing was asked for at ${short(entry.attempt_sha)}; review it and land again` };
		if (!this.env.RUNNER || entry.force) return { kind: "ready" };
		const own = this.latestRun(a.id);
		if (!own || own.sha !== a.headSha || own.status === "queued" || own.status === "running") return { kind: "wait", why: `waiting for ${short(a.headSha)} to be verified` };
		if (own.status === "fail") return { kind: "refused", why: `attempt ${a.id} failed verification at ${short(a.headSha)} (${this.failedSteps(own)}); land it anyway with force` };
		if (own.status !== "pass") return { kind: "refused", why: `attempt ${a.id} could not be verified at ${short(a.headSha)}${own.error ? ` (${own.error})` : ""}; run the verification again, or land it anyway with force` };
		// A lockfile being regenerated for this trunk and this commit: wait for it, then merge with what came back.
		if (entry.state === "locking") {
			const run = this.latestRun(`lock:${a.id}`);
			if (entry.trunk_sha === this.meta("head") && run && run.sha === entry.candidate_sha) {
				if ((run.status === "queued" || run.status === "running") && now() - run.startedAt < VERIFY_LIMIT_MS) return { kind: "wait", why: "regenerating the lockfile from the merged package.json" };
				if (run.status !== "pass") return { kind: "refused", why: `both sides changed dependencies and the lockfile could not be regenerated${run.error ? ` (${run.error})` : this.failedSteps(run) ? ` (${this.failedSteps(run)} failed)` : ""}. Merge trunk into the attempt with git and run the install there` };
			}
			this.sql.exec("UPDATE queue SET state = 'waiting', candidate_sha = NULL WHERE attempt_id = ? AND at = ?", a.id, entry.at);
		}
		return { kind: "ready" };
	}

	/** Every resolution still standing for an attempt against trunk as it is: what a person, an agent or a model wrote, and any lockfile Braid regenerated. */
	private resolutionsFor(a: Attempt): Resolutions {
		// A saved resolution is only for the two commits it was written against.
		this.sql.exec("UPDATE reconciliations SET status = 'stale' WHERE attempt_id = ? AND status = 'resolved' AND (trunk_sha != ? OR COALESCE(attempt_sha, ?) != ?)", a.id, this.meta("head"), a.headSha, a.headSha);
		const resolved = this.rows("SELECT * FROM reconciliations WHERE attempt_id = ? AND status = 'resolved' ORDER BY id", a.id).map(this.toRecon);
		return { recon: resolved.filter((r) => r.resolvedBy !== "braid").pop() ?? null, map: new Map(resolved.flatMap((r) => r.resolutions.map((x) => [x.path, x.content] as [string, string]))) };
	}
	private authorOf(a: Attempt) { return { name: a.agent, email: `${a.agent.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@agents.braid.dev` }; }

	/** A landing conflicts with trunk as it is: open a reconciliation for it and take it out of the queue. */
	private openReconciliation(entry: any, a: Attempt, found: { path: string }[], trunkSha: string, attemptSha: string, lockfilesHandled: boolean) {
		const conflicts: Conflict[] = (found as any[]).map((c) => ({ ...c, ...(LOCKFILE.test(c.path) && lockfilesHandled ? { kind: "lockfile" as const, base: null, trunk: null, attempt: null, regions: [] } : {}), trunkWhy: this.trunkWhy(a.baseSha, c.path) }));
		const paths = conflicts.map((c) => c.path), by = String(entry.by);
		this.sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status IN ('open', 'resolving')", a.id);
		this.sql.exec("INSERT INTO reconciliations (attempt_id, intent_id, status, trunk_sha, attempt_sha, conflicts, resolutions, rationale, resolved_by, at) VALUES (?, ?, 'open', ?, ?, ?, '[]', '', '', ?)",
			a.id, a.intentId, trunkSha, attemptSha, json(conflicts), now());
		const id = this.rows<{ id: number }>("SELECT id FROM reconciliations ORDER BY id DESC LIMIT 1")[0].id;
		this.setStatus(a.id, "conflicted");
		this.unqueue(entry);
		this.log.commit({ events: [
			this.signalled(a.id, "reconcile", { paths, note: "Landing conflicted with trunk. Call `reconciliation` for both sides and their reasoning, then `resolve`." }),
			this.noted("conflict", by, `Landing ${a.id} conflicted with trunk on ${paths.join(", ")}; reconciliation R${id} opened`, a.intentId, a.id),
			this.settled("landing", "conflict", `Conflicts with trunk in ${paths.join(", ")}`, a, by, `R${id}`, String(entry.attempt_sha)),
		] });
		this.sendOn(id, a, "agent");
	}

	/**
	 * A project can ask for conflicts to be worked on without waiting for a person (trunk's braid.json:
	 * landing.conflicts = "auto"). The attempt's own agent is brought back first, if Braid can run it;
	 * failing that, or if the agent leaves the conflict open, the model is asked. A person is needed only
	 * when both have had their turn. Each is tried once for a reconciliation.
	 */
	private sendOn(reconId: number, a: Attempt, from: "agent" | "model") {
		if (this.policyAt?.policy.config?.landing?.conflicts !== "auto") return;
		const row = this.rows<any>("SELECT * FROM reconciliations WHERE id = ? AND status = 'open'", reconId)[0];
		if (!row || row.auto === "model" || (from === "agent" && row.auto)) return;
		const conflicts: Conflict[] = JSON.parse(row.conflicts);
		if (conflicts.some((c) => c.kind === "delete")) return; // neither can answer a deleted file through the tools
		const hosted = this.rows<{ hosted: string | null }>("SELECT hosted FROM attempts WHERE id = ?", a.id)[0]?.hosted;
		const kind: HostedKind | null = a.kind === "codex" ? "codex" : a.kind === "claude" ? "claude" : null;
		if (from === "agent" && kind && hosting(this.env)[kind] && hosted !== "starting" && hosted !== "running") {
			try {
				this.roomForAgent();
				this.sql.exec("UPDATE reconciliations SET auto = 'agent' WHERE id = ?", reconId);
				this.sql.exec("UPDATE attempts SET hosted = 'starting', hosted_detail = '' WHERE id = ?", a.id);
				this.log.commit({
					events: [this.noted("reconcile", "braid", `Bringing ${a.agent} back to attempt ${a.id} to reconcile R${reconId}, as this project asks`, a.intentId, a.id)],
					effects: [{ id: `agent.start:${a.id}`, type: "agent.start", lane: `agent:${a.id}`, data: { attemptId: a.id, kind, task: "reconcile" } }],
				});
				return;
			} catch {} // no room for another agent: the model is asked instead
		}
		if (!llmName(this.env)) return;
		this.sql.exec("UPDATE reconciliations SET auto = 'model', status = 'resolving' WHERE id = ?", reconId);
		this.log.commit({
			events: [this.noted("reconcile", "braid", `Asking ${llmName(this.env)} to reconcile R${reconId}, as this project asks`, a.intentId, a.id)],
			effects: [{ id: `model.reconcile:${reconId}`, type: "model.reconcile", lane: `model:${reconId}`, data: { reconId } }],
		});
	}

	/**
	 * "Land now": one landing, merged and pushed without waiting for any run. Also finishes a landing that an
	 * older version was pushing when it stopped.
	 */
	private async landAlone(entry: any): Promise<void> {
		const a = this.attempt(entry.attempt_id), intent = this.intent(a.intentId), by = String(entry.by);
		// A landing that was being pushed when this object stopped: trunk says whether it got there.
		if (entry.state === "pushing") {
			if ((await this.trunkLog()).some((c) => c.hash === entry.candidate_sha)) {
				if (!this.rows("SELECT 1 FROM landings WHERE sha = ?", entry.candidate_sha).length) await this.recordLanding(a, intent, by, entry.candidate_sha, entry.trunk_sha, JSON.parse(entry.reconciled || "[]"));
				return this.unqueue(entry);
			}
			this.sql.exec("UPDATE queue SET state = 'waiting', candidate_sha = NULL WHERE attempt_id = ? AND at = ?", a.id, entry.at);
			if (!entry.force) return; // it joins the next batch like any other
		}
		const g = this.gate(entry);
		if (g.kind === "gone") return this.unqueue(entry);
		if (g.kind === "refused") return this.refuse(entry, g.why);
		const res = this.resolutionsFor(a), trunkHead = this.meta("head");
		await this.policy();
		const result = await prepare({
			branch: this.branch,
			trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
			attempt: { remote: a.remote, token: await this.host.token(a.repo, "read", 600) },
			message: this.landingMessage(intent, a, res.recon), author: this.authorOf(a), resolutions: res.map,
			expect: { trunk: trunkHead, attempt: a.headSha },
		});
		// Building the merge takes seconds. A landing cancelled in that time must not go on to move trunk.
		if (!this.held(entry)) return;
		if (!result.ok && result.reason === "moved") {
			// Something was pushed since this object last looked. Look again; the next pass decides with what is there now.
			this.setNote(entry, `${result.what === "trunk" ? "trunk" : `attempt ${a.id}`} moved while landing; trying again`);
			await this.readTrunk();
			await this.observe(a.id);
			return;
		}
		if (!result.ok && result.reason === "nothing-to-land") return this.refuse(entry, `attempt ${a.id} has nothing that trunk does not already have`);
		if (!result.ok) return this.openReconciliation(entry, a, result.conflicts, result.trunkSha, result.attemptSha, false);
		// Written down before the push, so a landing that reaches trunk is recorded even if this object stops in between.
		this.sql.exec("UPDATE queue SET state = 'pushing', candidate_sha = ?, trunk_sha = ?, reconciled = ? WHERE attempt_id = ? AND at = ?", result.sha, result.parentSha, json(result.reconciled), a.id, entry.at);
		await result.push();
		await this.recordLanding(a, intent, by, result.sha, result.parentSha, result.reconciled, !!this.env.RUNNER);
		this.unqueue(entry);
	}

	/** Where merged commits wait while they are verified: one repository per project, made the first time it is needed. */
	private async staging(): Promise<{ repo: string; remote: string }> {
		const repo = `${this.meta("slug")}--landing`;
		if (!this.meta("staging_remote")) {
			const remote = await this.host.create(repo, `Braid: merges of ${this.meta("name")} waiting to be verified`).then((r) => r.remote, () => this.host.remote(repo));
			this.setMeta("staging_remote", remote);
		}
		return { repo, remote: this.meta("staging_remote") };
	}

	/**
	 * Take the landings that are ready, in the order they were asked for, and merge them one on top of
	 * the other. One that conflicts with trunk gets its reconciliation; one that conflicts only with a
	 * landing ahead of it waits for that landing. What merged is parked and becomes a batch to verify,
	 * or lands at once when there is nothing left to verify.
	 */
	private async formBatch(): Promise<"again" | "idle"> {
		const head = this.meta("head"), verifies = !!this.env.RUNNER, combining = await this.combining();
		const cap = Math.min(32, Math.max(1, Number((await this.policy()).config?.landing?.batch) || BATCH));
		const ready: any[] = [];
		for (const entry of this.rows<any>("SELECT * FROM queue WHERE force = 0 AND batch_id IS NULL ORDER BY at, attempt_id")) {
			const g = this.gate(entry);
			if (g.kind === "wait") this.setNote(entry, g.why);
			else if (g.kind === "refused") this.refuse(entry, g.why);
			else if (g.kind === "gone") this.unqueue(entry);
			else ready.push(this.rows<any>("SELECT * FROM queue WHERE attempt_id = ? AND at = ?", entry.attempt_id, entry.at)[0]);
		}
		const members: { entry: any; a: Attempt; intent: Intent; res: Resolutions }[] = [], intents = new Set<number>();
		for (const entry of ready) {
			const a = this.attempt(entry.attempt_id), res = this.resolutionsFor(a);
			// Two attempts at one intent: the first to land settles it, so the second is not merged alongside.
			if (intents.has(a.intentId)) { this.setNote(entry, "another attempt at the same intent is landing first"); continue; }
			// A reconciliation, or a regenerated lockfile, was written against trunk as it is: it can only go first.
			if (res.map.size && members.length) { this.setNote(entry, "goes first in the next batch: it was reconciled against trunk as it is now"); continue; }
			members.push({ entry, a, intent: this.intent(a.intentId), res });
			intents.add(a.intentId);
			if (members.length >= cap) break;
		}
		if (!members.length) return "idle";

		const built = await chain({
			branch: this.branch, expectTrunk: head, combining,
			trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
			members: await Promise.all(members.map(async (m) => ({
				id: m.a.id, attempt: { remote: m.a.remote, token: await this.host.token(m.a.repo, "read", 600) }, expect: String(m.entry.attempt_sha),
				message: this.landingMessage(m.intent, m.a, m.res.recon), author: this.authorOf(m.a), resolutions: m.res.map,
			}))),
		});
		// Something was pushed to trunk since this object last looked. Look again and start over.
		if (!built.ok) { await this.readTrunk(); return "again"; }
		// Building takes seconds. If a landing was cancelled or trunk was moved in that time, this chain is of the wrong things.
		if (this.meta("head") !== head || members.some((m) => !this.held(m.entry))) return "again";

		const merged: { m: (typeof members)[number]; step: Extract<ChainStep, { ok: true }> }[] = [], locks: { m: (typeof members)[number]; step: Extract<ChainStep, { reason: "conflict" }> }[] = [];
		for (const step of built.steps) {
			const m = members.find((x) => x.a.id === step.id)!;
			if (step.ok) merged.push({ m, step });
			else if (step.reason === "nothing-to-land") this.refuse(m.entry, `attempt ${m.a.id} has nothing that trunk does not already have`);
			else if (step.reason === "moved") {
				// The attempt was pushed to since it was last read. Read it; the next pass refuses the landing for the commit it was asked for.
				this.setNote(m.entry, `attempt ${m.a.id} moved while landing; reading it again`);
				this.log.commit({ effects: [this.observeEffect(m.a.id)] });
			} else if (!step.againstTrunk) this.setNote(m.entry, "conflicts with a landing ahead of it; it is tried again once that has landed");
			// Only lockfiles left in conflict: nobody should merge those by hand. A sandbox brings them up to date (see startLock).
			else if (verifies && step.conflicts.every((c) => LOCKFILE.test(c.path) && c.trunk !== null)) locks.push({ m, step });
			else this.openReconciliation(m.entry, m.a, step.conflicts, step.onto, step.attemptSha, verifies);
		}
		for (const { m, step } of locks) await this.startLock(m.entry, m.a, m.intent, m.res, step);
		if (!merged.length || !built.tip) return locks.length ? "again" : "idle";
		if (this.meta("head") !== head || merged.some((x) => !this.held(x.m.entry))) return "again";

		// What has already been run does not need running again: a lone attempt that starts from trunk's head
		// merges to exactly the tree that passed, and a project with no checks has nothing to run.
		const trunkRun = this.latestRun("trunk"), trunkRed = trunkRun?.sha === head && trunkRun.status === "fail";
		const nothing = !trunkRed && trunkRun?.sha === head && trunkRun.status === "pass" && trunkRun.nothingToRun && merged.every((x) => this.latestRun(x.m.a.id)?.nothingToRun);
		const direct = !verifies || nothing || (merged.length === 1 && merged[0].step.sameTree);
		const ref = `batch-${now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
		if (!direct) {
			const staging = await this.staging();
			await built.stage(staging.remote, await this.host.token(staging.repo, "write", 600), ref);
			if (this.meta("head") !== head || merged.some((x) => !this.held(x.m.entry))) return "again";
		}
		// The batch is written down in one go, before anything moves trunk.
		const id = this.rows<{ id: number }>("INSERT INTO batches (trunk_sha, tip_sha, ref, state, size, target_sha, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
			head, built.tip, ref, direct ? "pushing" : "verifying", merged.length, direct ? built.tip : null, now())[0].id;
		merged.forEach(({ m, step }, position) => {
			this.sql.exec("UPDATE queue SET batch_id = ?, position = ?, state = ?, candidate_sha = ?, trunk_sha = ?, reconciled = ?, combined = ?, note = ? WHERE attempt_id = ? AND at = ?",
				id, position, direct ? "pushing" : "verifying", step.sha, step.parentSha, json(step.reconciled), json(step.combined), direct ? "landing" : `verifying the merge with trunk at ${short(head)}${merged.length > 1 ? `, together with ${merged.length - 1} other landing${merged.length === 2 ? "" : "s"}` : ""}`, m.a.id, m.entry.at);
			if (!direct) this.sql.exec("INSERT OR REPLACE INTO candidates (attempt_id, sha, trunk_sha, attempt_sha, at, run_ref, run_sha) VALUES (?, ?, ?, ?, ?, ?, ?)", m.a.id, step.sha, head, m.a.headSha, now(), `batch:${id}`, built.tip);
		});
		if (direct) {
			await built.push();
			const batch = this.rows<any>("SELECT * FROM batches WHERE id = ?", id)[0];
			await this.recordBatch(batch, this.members(id));
			this.sql.exec("DELETE FROM batches WHERE id = ?", id);
			this.log.commit({ effects: [this.runEffect("trunk")] });
		}
		return "again";
	}

	/**
	 * Both sides changed dependencies and only lockfiles conflict: build the merge with trunk's lockfile, park it on the
	 * attempt's repository, and have a sandbox bring the lockfile up to date with the merged package.json. What comes
	 * back is kept as a resolution, and the landing then goes first in a batch like any reconciled one.
	 */
	private async startLock(entry: any, a: Attempt, intent: Intent, res: Resolutions, step: Extract<ChainStep, { reason: "conflict" }>) {
		const locks = step.conflicts.map((c) => c.path), by = String(entry.by);
		const interim = await prepare({
			branch: this.branch,
			trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
			attempt: { remote: a.remote, token: await this.host.token(a.repo, "read", 600) },
			message: this.landingMessage(intent, a, res.recon), author: this.authorOf(a),
			resolutions: new Map([...res.map, ...step.conflicts.map((c) => [c.path, c.trunk!] as [string, string])]),
			expect: { trunk: step.onto, attempt: step.attemptSha },
		});
		if (!interim.ok) return; // something moved; the next pass starts over
		await interim.stage(await this.host.token(a.repo, "write", 600));
		if (!this.held(entry)) return;
		this.sql.exec("UPDATE queue SET state = 'locking', candidate_sha = ?, trunk_sha = ?, note = ? WHERE attempt_id = ? AND at = ?", interim.sha, interim.parentSha, "regenerating the lockfile from the merged package.json", a.id, entry.at);
		await this.startRun(`lock:${a.id}`, { repo: a.repo, remote: a.remote, sha: interim.sha, branch: CANDIDATE }, locks);
		this.note("land", by, `Both attempt ${a.id} and trunk changed ${locks.join(", ")}; regenerating it from the merged package.json`, a.intentId, a.id);
	}

	private members(batchId: number) { return this.rows<any>("SELECT * FROM queue WHERE batch_id = ? ORDER BY position", batchId); }
	/** Take a batch apart without landing anything: its members go back in line and are merged again. */
	private dissolve(batch: any) {
		this.sql.exec("UPDATE queue SET batch_id = NULL, position = NULL, state = 'waiting', candidate_sha = NULL, note = '' WHERE batch_id = ?", batch.id);
		this.sql.exec("DELETE FROM batches WHERE id = ?", batch.id);
	}
	private async startBatchRun(batch: any, ref: string, sha: string) {
		const staging = await this.staging();
		await this.startRun(ref, { repo: staging.repo, remote: staging.remote, sha, branch: batch.ref });
	}

	/** One step for the batch being verified: wait, land it, or find which landing broke it. */
	private async batchStep(batch: any): Promise<"hold" | "again"> {
		const rows = this.members(batch.id), head = this.meta("head"), ids = rows.map((r) => r.attempt_id).join(", ");
		// Cut off around the push: trunk says whether it got there.
		if (batch.state === "pushing") {
			if ((await this.readTrunk()).some((c) => c.hash === batch.target_sha)) await this.recordBatch(batch, rows.filter((r) => r.state === "pushing"));
			this.dissolve(batch);
			this.log.commit({ effects: [this.runEffect("trunk")] });
			return "again";
		}
		// The batch stands only while trunk and every member are as they were when it was built. A landing
		// cancelled or sent back, an attempt pushed to, a "land now" that got ahead: build it again.
		const intact = head === batch.trunk_sha && rows.length === batch.size && rows.every((r) => {
			const a = this.attempt(r.attempt_id);
			return LIVE.has(a.status) && a.headSha === r.attempt_sha && this.intent(a.intentId).status === "open";
		});
		if (!intact) { this.dissolve(batch); return "again"; }
		const pending = (run: Run | null) => !!run && (run.status === "queued" || run.status === "running");
		const late = (run: Run) => now() - run.startedAt >= VERIFY_LIMIT_MS;
		const giveUp = (why: (id: string) => string) => { for (const r of rows) this.refuse(r, why(r.attempt_id)); this.sql.exec("DELETE FROM batches WHERE id = ?", batch.id); return "again" as const; };

		if (batch.state === "verifying") {
			const run = this.latestRun(`batch:${batch.id}`);
			if (!run || run.sha !== batch.tip_sha) {
				await this.startBatchRun(batch, `batch:${batch.id}`, batch.tip_sha);
				this.note("land", "braid", rows.length === 1 ? `Merged attempt ${ids} with trunk at ${short(head)} as ${short(batch.tip_sha)}; it lands if that passes verification`
					: `Merged attempts ${ids} with trunk at ${short(head)}, one on top of the other, as ${short(batch.tip_sha)}; they all land if that passes verification`);
				return "hold";
			}
			if (pending(run)) return late(run) ? giveUp((id) => `the merge of attempt ${id} with trunk was not verified within 45 minutes; land it again`) : "hold";
			if (run.status === "pass") return this.landBatch(batch, rows, rows.length - 1, run);
			if (run.status !== "fail") return giveUp((id) => `the merge of attempt ${id} with trunk could not be verified${run.error ? ` (${run.error})` : ""}; land it again`);
			if (rows.length === 1) { this.blame(rows[0], run, head); this.sql.exec("DELETE FROM batches WHERE id = ?", batch.id); return "again"; }
			// Something in the batch breaks it. Run every step at once to see which.
			this.sql.exec("UPDATE batches SET state = 'splitting' WHERE id = ?", batch.id);
			this.sql.exec("UPDATE queue SET note = ? WHERE batch_id = ?", "the landings verified together failed; each is being run to find which one", batch.id);
			this.note("land", "braid", `Attempts ${ids} failed verification when merged with trunk together (${this.failedSteps(run)}); running each step to find which one breaks it`);
		}

		const runs = rows.map((r) => this.latestRun(`batch:${batch.id}:${r.position}`));
		let started = false;
		for (const [i, r] of rows.entries()) {
			if (runs[i]?.sha === r.candidate_sha) continue;
			this.sql.exec("UPDATE candidates SET run_ref = ?, run_sha = ? WHERE attempt_id = ?", `batch:${batch.id}:${r.position}`, r.candidate_sha, r.attempt_id);
			await this.startBatchRun(batch, `batch:${batch.id}:${r.position}`, r.candidate_sha);
			started = true;
		}
		if (started) return "hold";
		if (runs.some(pending)) return runs.some((run) => pending(run) && late(run!)) ? giveUp((id) => `the merge of attempt ${id} with trunk was not verified within 45 minutes; land it again`) : "hold";
		const first = runs.findIndex((run) => run!.status !== "pass");
		if (first === -1) {
			// Every step passes on its own, the last one included: the failure did not repeat.
			this.note("land", "braid", `Attempts ${ids} failed once when verified together and passed when each step was run again; landing them`);
			return this.landBatch(batch, rows, rows.length - 1, runs.at(-1)!);
		}
		// The first step that does not pass is the one that breaks it. Those ahead of it are good and land;
		// those behind it were merged on top of it, so they go back in line.
		const parent = String(rows[first].trunk_sha);
		this.sql.exec("UPDATE candidates SET trunk_sha = ? WHERE attempt_id = ?", parent, rows[first].attempt_id);
		this.blame(rows[first], runs[first]!, parent);
		this.sql.exec("UPDATE queue SET batch_id = NULL, position = NULL, state = 'waiting', candidate_sha = NULL, note = '' WHERE batch_id = ? AND position > ?", batch.id, rows[first].position);
		if (first === 0) { this.sql.exec("DELETE FROM batches WHERE id = ?", batch.id); return "again"; }
		return this.landBatch(batch, rows.slice(0, first), first - 1, runs[first - 1]!);
	}

	/** The landing whose merge does not pass: refused, with the failing output sent to its agent. */
	private blame(row: any, run: Run, onto: string) {
		const a = this.attempt(row.attempt_id), trunkRun = this.latestRun("trunk");
		const trunkRed = trunkRun?.sha === this.meta("head") && trunkRun.status === "fail";
		if (run.status !== "fail") return this.refuse(row, `the merge of attempt ${a.id} with trunk could not be verified${run.error ? ` (${run.error})` : ""}; land it again`);
		this.signal(a.id, "merge-failed", {
			trunk: short(onto),
			failed: run.steps.filter((s) => s.status === "fail").map((s) => ({ step: s.name, command: s.command, exit_code: s.exitCode, output: s.tail.slice(-2000) })),
			note: "Your commit passes on its own but fails once merged with trunk. Merge trunk into your attempt (see `sync`), fix it, push, and checkpoint.",
		});
		this.refuse(row, `attempt ${a.id} passes on its own but failed verification when merged with trunk at ${short(onto)} (${this.failedSteps(run)})${trunkRed ? "; trunk itself is failing, and this attempt does not fix it" : ""}. Land it anyway with force`);
	}

	/** Move trunk to the step at `upto` of a batch, whose run passed, and record every landing up to it. */
	private async landBatch(batch: any, rows: any[], upto: number, passed: Run): Promise<"again"> {
		const target = String(rows[upto].candidate_sha), staging = await this.staging();
		// Written down before the push, so landings that reach trunk are recorded even if this object stops in between.
		this.sql.exec("UPDATE batches SET state = 'pushing', target_sha = ? WHERE id = ?", target, batch.id);
		this.sql.exec("UPDATE queue SET state = 'pushing', note = 'landing' WHERE batch_id = ? AND position <= ?", batch.id, rows[upto].position);
		const moved = await promoteFrom({
			branch: this.branch, sha: target, parentSha: batch.trunk_sha,
			trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
			staging: { remote: staging.remote, token: await this.host.token(staging.repo, "read", 600), ref: batch.ref },
		});
		if (!moved.ok) {
			// Trunk moved under it (a push from outside Braid): merge again.
			this.dissolve(batch);
			await this.readTrunk();
			return "again";
		}
		// Trunk is now the very commit that just passed. Its result stands for trunk, unless the project builds
		// a preview: that is made by running trunk itself.
		if (!passed.preview && !this.rows("SELECT 1 FROM runs WHERE ref = 'trunk' AND sha = ?", target).length) {
			this.sql.exec("INSERT INTO runs (ref, sha, status, steps, preview, nothing_to_run, error, started_at, finished_at) VALUES ('trunk', ?, 'pass', ?, 0, ?, NULL, ?, ?)", target, json(passed.steps), passed.nothingToRun ? 1 : 0, passed.startedAt, passed.finishedAt ?? now());
		}
		await this.recordBatch(batch, rows.slice(0, upto + 1));
		this.sql.exec("DELETE FROM batches WHERE id = ?", batch.id);
		this.log.commit({ effects: [this.runEffect("trunk")] });
		return "again";
	}

	/** Trunk has these landings: write each down in the order it landed. One already written down (by a try that was cut off) is left alone. */
	private async recordBatch(batch: any, rows: any[], unverified = false) {
		for (const r of rows) {
			if (this.rows("SELECT 1 FROM landings WHERE sha = ?", r.candidate_sha).length) continue;
			const a = this.attempt(r.attempt_id), intent = this.intent(a.intentId);
			await this.recordLanding(a, intent, String(r.by), String(r.candidate_sha), String(r.trunk_sha), JSON.parse(r.reconciled || "[]"), unverified, JSON.parse(r.combined || "[]"));
		}
		void batch;
	}

	/** Trunk has the landing commit: write down what it was, tell everyone affected, and keep the why. */
	private async recordLanding(a: Attempt, intent: Intent, by: string, sha: string, parentSha: string, reconciled: string[], unverified = false, combined: string[] = []) {
		// Kept with the attempt's decisions, so the lines it produced say how they came to stand next to trunk's.
		if (combined.length) this.sql.exec("INSERT INTO decisions (attempt_id, intent_id, agent, kind, title, body, files, sha, at) VALUES (?, ?, 'braid', 'note', ?, ?, ?, ?, ?)", a.id, intent.id, "Both sides' additions kept",
			`Trunk and this attempt both added lines at the same place in ${combined.join(", ")}. Neither changed the other's lines, so both were kept, trunk's first, and the result was verified before it landed.`, json(combined), sha, now());
		this.sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status IN ('open', 'resolving')", a.id);
		const files = a.files.map((f) => f.path);
		this.sql.exec("INSERT OR REPLACE INTO landings (sha, parent_sha, intent_id, attempt_id, agent, title, files, reconciled, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			sha, parentSha, intent.id, a.id, a.agent, intent.title, json(files), reconciled.length ? 1 : 0, now());
		this.sql.exec("UPDATE intents SET status = 'landed', landed_sha = ?, landed_attempt = ? WHERE id = ?", sha, a.id, intent.id);
		this.setStatus(a.id, "landed");
		this.setMeta("head", sha);
		this.log.commit({ events: [
			this.noted("land", by, `Landed I${intent.id} (${a.agent}, attempt ${a.id}) on trunk as ${short(sha)}${reconciled.length ? `, reconciled ${reconciled.join(", ")}` : ""}${combined.length ? `, keeping both sides' additions in ${combined.join(", ")}` : ""}${unverified ? ", forced without waiting for verification" : ""}`, intent.id, a.id),
			this.settled("landing", "landed", `Landed on trunk as ${short(sha)}`, a, by, sha, a.headSha),
		] });
		await this.retire(a.id);

		// The why is copied to the context repository after the landing, not as part of it. A copy that failed before is tried again now.
		this.log.requeueFailed("context.save");
		this.log.commit({ effects: [this.contextEffect(a.id)] });

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
		this.log.commit(this.trunkAdvanced(parentSha, sha, files));
	}

	/**
	 * Trunk moved by one commit that Braid made itself, so it knows which files changed. An attempt that
	 * was up to date and touches none of them is one commit further behind and nothing else: that is
	 * written down without reading its repository. The others are read again.
	 */
	private trunkAdvanced(parent: string, head: string, files: string[]): { events: NewEvent[]; effects: NewEffect[] } {
		const changed = new Set(files), events: NewEvent[] = [], effects: NewEffect[] = [];
		for (const row of this.rows<any>("SELECT id, intent_id, files, trunk_seen FROM attempts WHERE status IN ('working', 'ready', 'conflicted')")) {
			const touches = (JSON.parse(row.files) as { path: string }[]).some((f) => changed.has(f.path));
			if (row.trunk_seen === parent && !touches) events.push({ type: "attempt.trunk-advanced", attemptId: row.id, intentId: row.intent_id, data: { trunkSeen: head } });
			else effects.push(this.observeEffect(row.id));
		}
		this.trunkMovedAt = now();
		this.trunkAt = null;
		return { events, effects: [...effects, this.runEffect("trunk"), { ...this.spareEffect(), after: now() + SPARE_SETTLE_MS }, ...this.advanceEffect()] };
	}

	/**
	 * Take a landing back. Trunk gets one new commit that undoes it, the intent is open again, and
	 * the reason is kept with the attempt. The attempt itself is finished: its commits are in trunk's
	 * history, so the intent needs a new attempt. Asked for here; the worker does it in turn with the landings.
	 */
	async revertLanding(sha: string, by = "human", reason = "") {
		this.requireProject();
		const row = this.rows("SELECT * FROM landings WHERE sha = ?", sha)[0];
		if (!row) throw new BraidError(`no landing ${short(sha)}`, 404);
		const l = this.toLanding(row), why = redact(reason).trim();
		if (l.revertOf) throw new BraidError("that commit is itself a revert");
		if (l.revertedBy) throw new BraidError(`that landing was already reverted by ${short(l.revertedBy)}`);
		if (!why) throw new BraidError("say why the landing is being reverted: it is kept with the intent");
		this.log.commit({ effects: [{ id: `landing.revert:${l.sha}`, type: "landing.revert", lane: "landing", data: { sha: l.sha, by, reason: why } }] });
		return { queued: true };
	}

	private async doRevert(sha: string, by: string, why: string) {
		const row = this.rows("SELECT * FROM landings WHERE sha = ?", sha)[0];
		if (!row) return;
		const l = this.toLanding(row), intent = this.intent(l.intentId), a = { id: l.attemptId, intentId: intent.id };
		if (l.revertedBy) return; // done by an earlier try
		// A try that pushed the revert and was cut off before writing it down: trunk has the commit.
		const pushed = (await this.readTrunkQuietly()).find((c) => c.message.includes(`Braid-Reverts: ${l.sha}`));
		const result = pushed ? { ok: true as const, sha: pushed.hash, parentSha: pushed.parents[0] ?? "" } : await revert({
			branch: this.branch, sha: l.sha, parentSha: l.parentSha,
			trunk: { remote: this.meta("remote"), token: await this.host.token(this.trunk, "write", 600) },
			message: `Revert I${intent.id}: ${intent.title}\n\nReason: ${why}\n\nBraid-Reverts: ${l.sha}\nBraid-Intent: ${intent.id}`,
			author: { name: by, email: `${by.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}@people.braid.dev` },
		});
		if (!result.ok) {
			const said = `Later landings changed the same lines in ${result.conflicts.join(", ")}, so this landing cannot be taken out on its own. Open an intent to undo it by hand.`;
			this.log.commit({ events: [this.noted("land", by, `The landing of I${intent.id} (${short(l.sha)}) was not reverted: ${said}`, intent.id, l.attemptId), this.settled("revert", "refused", said, a, by, l.sha)] });
			this.broadcast();
			return;
		}
		this.sql.exec("UPDATE landings SET reverted_by = ? WHERE sha = ?", result.sha, l.sha);
		this.sql.exec("INSERT OR REPLACE INTO landings (sha, parent_sha, intent_id, attempt_id, agent, title, files, reconciled, at, revert_of) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
			result.sha, result.parentSha, intent.id, l.attemptId, by, `Revert I${intent.id}: ${intent.title}`, json(l.files), now(), l.sha);
		this.sql.exec("UPDATE intents SET status = 'open', landed_sha = NULL, landed_attempt = NULL WHERE id = ?", intent.id);
		this.setStatus(l.attemptId, "reverted");
		this.sql.exec("INSERT INTO decisions (attempt_id, intent_id, agent, kind, title, body, files, sha, at) VALUES (?, ?, ?, 'feedback', 'Landing reverted', ?, ?, ?, ?)", l.attemptId, intent.id, by, why, json(l.files), result.sha, now());
		this.setMeta("head", result.sha);
		const live = this.attempts().filter((o) => LIVE.has(o.status));
		const moved = this.trunkAdvanced(result.parentSha, result.sha, l.files);
		this.log.commit({
			events: [
				this.noted("land", by, `Reverted the landing of I${intent.id} (${short(l.sha)}) on trunk as ${short(result.sha)}: ${why}. I${intent.id} is open again`, intent.id, l.attemptId),
				this.settled("revert", "reverted", `Taken back out of trunk as ${short(result.sha)}`, a, by, l.sha),
				...live.map((o) => this.signalled(o.id, "trunk-moved", { reverted: `I${intent.id}: ${intent.title}`, reason: why, files: l.files, note: "A landing was taken back out of trunk. Call `checkpoint` to see whether this affects you." })),
				...moved.events,
			],
			effects: moved.effects,
		});
		this.broadcast();
		await this.advance();
	}

	/** Trunk's line as Artifacts has it now, without deciding anything from it. */
	private readTrunkQuietly() { return this.host.log(this.trunk, this.branch, 50); }

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

	/** Ask the configured model to reconcile, giving it both intents and both decision trails. It answers in its own time; the page shows "resolving" meanwhile. */
	async resolveWithModel(reconId: number) {
		const row = this.rows("SELECT * FROM reconciliations WHERE id = ?", reconId)[0];
		if (!row) throw new BraidError(`reconciliation ${reconId} not found`, 404);
		const r = this.toRecon(row);
		if (r.status === "resolved") throw new BraidError(`reconciliation R${reconId} is already resolved`);
		if (r.status === "resolving") return { resolving: true };
		this.sql.exec("UPDATE reconciliations SET status = 'resolving' WHERE id = ?", reconId);
		this.log.commit({ effects: [{ id: `model.reconcile:${reconId}`, type: "model.reconcile", lane: `model:${reconId}`, data: { reconId } }] });
		this.broadcast();
		return { resolving: true };
	}

	private async doModelReconcile(reconId: number) {
		const row = this.rows("SELECT * FROM reconciliations WHERE id = ?", reconId)[0];
		const r = row && this.toRecon(row);
		if (!r || r.status !== "resolving") return;
		const a = this.attempt(r.attemptId);
		try {
			const out = await resolveConflicts(this.env, { intent: this.intent(r.intentId), agent: a.agent, decisions: this.decisionsFor(a.id), conflicts: r.conflicts });
			await this.submitResolution(reconId, out.resolutions, out.rationale, out.model);
		} catch (e) {
			// Not tried again by itself: a model that answered badly once is asked again only when a person says so.
			const said = splitError(e).message;
			this.sql.exec("UPDATE reconciliations SET status = 'open' WHERE id = ? AND status = 'resolving'", reconId);
			this.log.commit({ events: [this.noted("reconcile", "braid", `The model did not resolve R${reconId}: ${said}`, r.intentId, r.attemptId), this.settled("reconcile", "failed", said, a, "braid", `R${reconId}`)] });
			this.broadcast();
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

/** Requests that may carry an Idempotency-Key. */
const KEYED = new Set(["createIntent", "join", "hostAgent", "rehost", "respond", "revertLanding", "land", "cancelLanding", "resolve", "resolveWithModel", "abandonIntent", "abandonAttempt", "restoreAttempt", "editIntent", "stopHosted", "review"]);
type Resolutions = { recon: Reconciliation | null; map: Map<string, string> };
type Observed = Pick<Attempt, "baseSha" | "headSha" | "files" | "behind" | "trunkConflicts"> & { trunkSeen: string };
const STALE_NOTE = "Braid has not finished reading your latest push, so this is what it knew before. Anything new arrives in heads_up on your next call.";

const RECONCILE_HELP =
	"Each conflicting file lists its `regions`: the places where trunk and your attempt changed the same lines. A region has trunk's text, your attempt's text, their common base, and a few unchanged lines `before` and `after` it. " +
	"`trunkWhy` is the intents that changed this file on trunk and the decisions behind them. Everything outside the regions has already been merged from both sides. " +
	"For each region, write the text that should stand there so that BOTH intents are satisfied, then call `resolve` with { resolutions: [{ path, regions: [text for region 1, text for region 2, ...] }], rationale }. " +
	"A conflict of kind `lockfile` needs nothing from you: Braid regenerates that file once the others are resolved. " +
	"If the fix needs changes outside the regions too, send the whole merged file as `content` instead of `regions` (call `reconciliation` with full: true for the complete base, trunk and attempt versions). " +
	"The rationale is recorded in the landing commit, so say concretely how each side's intent survives.";
