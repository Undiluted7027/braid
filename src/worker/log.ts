// Decide, then do. A command only records what was decided: its events, the state they lead to,
// its receipt and the side effects it asks for are written together, with no I/O in between.
// A worker performs the effects afterwards and reports what happened as further commands.
// Nothing here knows about Cloudflare, so it runs under Node in the tests.

export interface Sql { exec(query: string, ...args: any[]): { toArray(): any[] } }

export interface BraidEvent {
	seq: number; at: number; type: string; attemptId: string | null; intentId: number | null; actor: string;
	commandId: string | null; data: Record<string, any>;
}
export type NewEvent = { type: string; attemptId?: string | null; intentId?: number | null; actor?: string; data?: Record<string, any> };

export interface Receipt { commandId: string; type: string; status: "accepted" | "rejected"; seq: number; result: any; error: string | null; at: number }

export type EffectStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export interface Effect {
	id: string; type: string; lane: string; data: Record<string, any>; status: EffectStatus; tries: number;
	availableAt: number; createdAt: number; updatedAt: number; lastError: string | null; commandId: string | null;
}
/** `id` names the work, not the request: asking again while it waits changes nothing, and asking while it runs makes it run once more. */
export type NewEffect = { id: string; type: string; lane: string; data?: Record<string, any>; after?: number };

export interface Commit { committed: boolean; events: BraidEvent[]; receipt: Receipt | null }

const SETTLED = "('succeeded', 'failed', 'cancelled')";
/** Succeeded and cancelled effects are kept this long, for looking at what happened. Failed ones stay until they are tried again. */
const KEEP_SETTLED_MS = 7 * 24 * 3600_000;

export class Log {
	private sql: Sql;
	private transaction: <T>(fn: () => T) => T;
	private apply: (event: BraidEvent) => void;
	private now: () => number;
	private woke: () => void;
	private depth = 0;

	constructor(opts: { sql: Sql; transaction: <T>(fn: () => T) => T; apply: (event: BraidEvent) => void; now?: () => number; onEffects?: () => void }) {
		this.sql = opts.sql;
		this.transaction = opts.transaction;
		this.apply = opts.apply;
		this.now = opts.now ?? Date.now;
		this.woke = opts.onEffects ?? (() => {});
	}

	schema() {
		for (const statement of [
			`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, type TEXT, attempt_id TEXT, intent_id INTEGER, actor TEXT, command_id TEXT, data TEXT)`,
			`CREATE INDEX IF NOT EXISTS events_command ON events (command_id)`,
			`CREATE TABLE IF NOT EXISTS receipts (command_id TEXT PRIMARY KEY, type TEXT, status TEXT, seq INTEGER, result TEXT, error TEXT, at INTEGER)`,
			`CREATE TABLE IF NOT EXISTS effects (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, type TEXT, lane TEXT, data TEXT, status TEXT, tries INTEGER,
				available_at INTEGER, created_at INTEGER, updated_at INTEGER, last_error TEXT, command_id TEXT, again INTEGER DEFAULT 0)`,
			`CREATE INDEX IF NOT EXISTS effects_status ON effects (status, lane)`,
		]) this.sql.exec(statement);
	}

	private rows<T = any>(query: string, ...args: any[]): T[] { return this.sql.exec(query, ...args).toArray() as T[]; }
	private atomic<T>(fn: () => T): T {
		if (this.depth) return fn();
		this.depth++;
		try { return this.transaction(fn); } finally { this.depth--; }
	}

	private toEvent = (r: any): BraidEvent => ({ seq: r.seq, at: r.at, type: r.type, attemptId: r.attempt_id, intentId: r.intent_id, actor: r.actor, commandId: r.command_id, data: JSON.parse(r.data) });
	private toReceipt = (r: any): Receipt => ({ commandId: r.command_id, type: r.type, status: r.status, seq: r.seq, result: r.result === null ? null : JSON.parse(r.result), error: r.error, at: r.at });
	private toEffect = (r: any): Effect => ({
		id: r.id, type: r.type, lane: r.lane, data: JSON.parse(r.data), status: r.status, tries: r.tries, availableAt: r.available_at,
		createdAt: r.created_at, updatedAt: r.updated_at, lastError: r.last_error, commandId: r.command_id,
	});

	// ── commands and events ──────────────────────────────────────────────────

	/**
	 * Write a decision. With a command, its id is the guard: a command seen before writes nothing and
	 * gets its first receipt back, so a retry or a worker that ran twice cannot apply twice.
	 */
	commit(input: { command?: { id: string; type: string }; events?: NewEvent[]; effects?: NewEffect[]; result?: unknown }): Commit {
		const out = this.atomic((): Commit => {
			const command = input.command, at = this.now();
			if (command) {
				const seen = this.receipt(command.id);
				if (seen) return { committed: false, events: this.byCommand(command.id), receipt: seen };
			}
			const events: BraidEvent[] = [];
			for (const e of input.events ?? []) {
				const row = this.rows("INSERT INTO events (at, type, attempt_id, intent_id, actor, command_id, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
					at, e.type, e.attemptId ?? null, e.intentId ?? null, e.actor ?? "braid", command?.id ?? null, JSON.stringify(e.data ?? {}))[0];
				const event = this.toEvent(row);
				this.apply(event);
				events.push(event);
			}
			for (const effect of input.effects ?? []) this.enqueue(effect, command?.id ?? null, at);
			let receipt: Receipt | null = null;
			if (command) {
				this.sql.exec("INSERT INTO receipts (command_id, type, status, seq, result, error, at) VALUES (?, ?, 'accepted', ?, ?, NULL, ?)",
					command.id, command.type, events.at(-1)?.seq ?? this.latest(), input.result === undefined ? null : JSON.stringify(input.result), at);
				receipt = this.receipt(command.id);
			}
			return { committed: true, events, receipt };
		});
		// Only once it is written: a worker must never see work whose decision could still be undone.
		if (out.committed && input.effects?.length) this.woke();
		return out;
	}

	/** Write down that a command was refused, so whoever sent it, or sends it again, gets the same answer. */
	reject(command: { id: string; type: string }, error: string): Receipt {
		return this.atomic(() => {
			const seen = this.receipt(command.id);
			if (seen) return seen;
			this.sql.exec("INSERT INTO receipts (command_id, type, status, seq, result, error, at) VALUES (?, ?, 'rejected', ?, NULL, ?, ?)", command.id, command.type, this.latest(), error, this.now());
			return this.receipt(command.id)!;
		});
	}

	receipt(commandId: string): Receipt | null {
		const r = this.rows("SELECT * FROM receipts WHERE command_id = ?", commandId)[0];
		return r ? this.toReceipt(r) : null;
	}
	latest(): number { return this.rows<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events")[0]?.seq ?? 0; }
	after(seq: number, limit = 500): BraidEvent[] { return this.rows("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", seq, Math.min(Math.max(limit, 1), 2000)).map(this.toEvent); }
	private byCommand(commandId: string): BraidEvent[] { return this.rows("SELECT * FROM events WHERE command_id = ? ORDER BY seq", commandId).map(this.toEvent); }

	// ── the outbox ───────────────────────────────────────────────────────────

	private enqueue(effect: NewEffect, commandId: string | null, at: number) {
		const have = this.rows<{ status: EffectStatus }>("SELECT status FROM effects WHERE id = ?", effect.id)[0];
		const data = JSON.stringify(effect.data ?? {}), available = effect.after ?? at;
		if (!have) {
			this.sql.exec("INSERT INTO effects (id, type, lane, data, status, tries, available_at, created_at, updated_at, last_error, command_id, again) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL, ?, 0)",
				effect.id, effect.type, effect.lane, data, available, at, at, commandId);
		} else if (have.status === "running") {
			// It is reading the world as it was a moment ago. Once it finishes it goes round again with what is asked now.
			this.sql.exec("UPDATE effects SET again = 1, data = ?, command_id = ?, updated_at = ? WHERE id = ?", data, commandId, at, effect.id);
		} else if (have.status !== "pending") {
			// Settled work asked for again is new work. It goes to the back of its lane.
			this.sql.exec("DELETE FROM effects WHERE id = ?", effect.id);
			this.sql.exec("INSERT INTO effects (id, type, lane, data, status, tries, available_at, created_at, updated_at, last_error, command_id, again) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL, ?, 0)",
				effect.id, effect.type, effect.lane, data, available, at, at, commandId);
		}
	}

	/** A lane does one thing at a time, in the order asked. An earlier effect waiting out a retry still holds back the later ones. */
	private claimable(due: boolean) {
		return `c.status = 'pending' ${due ? "AND c.available_at <= ?" : ""} AND NOT EXISTS (
			SELECT 1 FROM effects AS o WHERE o.lane = c.lane AND (o.status = 'running' OR (o.status = 'pending' AND o.n < c.n)))`;
	}

	/** Take up to `max` effects to run now, at most one from each lane. */
	claim(max: number): Effect[] {
		const out: Effect[] = [];
		while (out.length < max) {
			const at = this.now();
			const row = this.rows(`UPDATE effects SET status = 'running', tries = tries + 1, updated_at = ?, last_error = NULL
				WHERE n = (SELECT c.n FROM effects AS c WHERE ${this.claimable(true)} ORDER BY c.available_at, c.n LIMIT 1) RETURNING *`, at, at)[0];
			if (!row) break;
			out.push(this.toEffect(row));
		}
		return out;
	}

	/** When the next effect can be taken, or null when nothing is waiting. */
	nextAt(): number | null {
		return this.rows<{ at: number | null }>(`SELECT MIN(c.available_at) AS at FROM effects AS c WHERE ${this.claimable(false)}`)[0]?.at ?? null;
	}

	effect(id: string): Effect | null {
		const r = this.rows("SELECT * FROM effects WHERE id = ?", id)[0];
		return r ? this.toEffect(r) : null;
	}
	effects(status?: EffectStatus): Effect[] {
		return (status ? this.rows("SELECT * FROM effects WHERE status = ? ORDER BY n", status) : this.rows("SELECT * FROM effects ORDER BY n")).map(this.toEffect);
	}

	succeed(id: string) {
		const at = this.now();
		// Asked for again while it ran: it is not done until it has seen what was asked last.
		const again = this.rows(`UPDATE effects SET status = 'pending', again = 0, tries = 0, available_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND again = 1 RETURNING id`, at, at, id).length;
		if (!again) this.sql.exec("UPDATE effects SET status = 'succeeded', updated_at = ?, last_error = NULL WHERE id = ? AND status = 'running'", at, id);
		this.woke();
	}
	retry(id: string, error: string, delayMs: number) {
		const at = this.now();
		this.sql.exec("UPDATE effects SET status = 'pending', again = 0, available_at = ?, updated_at = ?, last_error = ? WHERE id = ? AND status = 'running'", at + Math.max(0, delayMs), at, error.slice(0, 2000), id);
		this.woke();
	}
	fail(id: string, error: string) {
		this.sql.exec("UPDATE effects SET status = 'failed', again = 0, updated_at = ?, last_error = ? WHERE id = ? AND status = 'running'", this.now(), error.slice(0, 2000), id);
		this.woke();
	}
	/** Drop work that is no longer wanted. One already running finishes, and its result is the executor's to ignore. */
	cancel(where: { lane?: string; type?: string }, reason: string): string[] {
		const ids = this.rows<{ id: string }>("UPDATE effects SET status = 'cancelled', again = 0, updated_at = ?, last_error = ? WHERE status = 'pending' AND (? IS NULL OR lane = ?) AND (? IS NULL OR type = ?) RETURNING id",
			this.now(), reason, where.lane ?? null, where.lane ?? null, where.type ?? null, where.type ?? null).map((r) => r.id);
		if (ids.length) this.woke();
		return ids;
	}
	/** Give failed work of one kind another go. */
	requeueFailed(type: string): number {
		const at = this.now();
		const n = this.rows("UPDATE effects SET status = 'pending', tries = 0, available_at = ?, updated_at = ? WHERE status = 'failed' AND type = ? RETURNING id", at, at, type).length;
		if (n) this.woke();
		return n;
	}

	/**
	 * Called when the process starts: nothing can be running, so whatever is marked running was cut off.
	 * Work that only reads, or checks what is true before it acts, goes back in line. Work tied to
	 * something the old process held cannot simply happen again, and is dropped for its owner to notice.
	 */
	recover(replaySafe: (type: string) => boolean): { requeued: Effect[]; lost: Effect[] } {
		return this.atomic(() => {
			const cut = this.effects("running"), at = this.now();
			const requeued = cut.filter((e) => replaySafe(e.type)), lost = cut.filter((e) => !replaySafe(e.type));
			for (const e of requeued) this.sql.exec("UPDATE effects SET status = 'pending', again = 0, available_at = ?, updated_at = ?, last_error = 'cut off when the process ended; trying again' WHERE id = ?", at, at, e.id);
			for (const e of lost) this.sql.exec("UPDATE effects SET status = 'cancelled', again = 0, updated_at = ?, last_error = 'the process ended before this finished' WHERE id = ?", at, e.id);
			return { requeued, lost };
		});
	}

	prune(): number {
		return this.rows("DELETE FROM effects WHERE status IN ('succeeded', 'cancelled') AND updated_at < ? RETURNING id", this.now() - KEEP_SETTLED_MS).length;
	}
	unsettled(): number { return this.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM effects WHERE status NOT IN ${SETTLED}`)[0].n; }
}

export interface Executor {
	/** False for work tied to something only the running process holds: it is not repeated after a restart. */
	replaySafe: boolean;
	/** `willRetry` is false on the last try, when a failure should be reported instead of waited out. */
	run(effect: Effect, ctx: { willRetry: boolean }): Promise<void>;
}

export interface DrainOptions {
	concurrency?: number; maxTries?: number;
	/** Stop taking new work at this time; what is running is still waited for. */
	until?: number; now?: () => number;
	/** An effect that has used all its tries. */
	onFailed?: (effect: Effect, error: string) => void;
}

/** Run effects until nothing can be taken: several lanes at once, each lane in order. Returns how many were run. */
export async function drain(log: Log, executors: Record<string, Executor>, opts: DrainOptions = {}): Promise<number> {
	const concurrency = opts.concurrency ?? 6, maxTries = opts.maxTries ?? 5, now = opts.now ?? Date.now;
	const running = new Set<Promise<void>>();
	let ran = 0;
	const one = async (effect: Effect) => {
		const executor = executors[effect.type];
		if (!executor) return log.fail(effect.id, `nothing knows how to do "${effect.type}"`);
		const last = effect.tries >= maxTries;
		try {
			await executor.run(effect, { willRetry: !last });
			log.succeed(effect.id);
		} catch (e) {
			const error = String((e as Error)?.message ?? e);
			if (!last) return log.retry(effect.id, error, Math.min(30_000, 250 * 2 ** (effect.tries - 1)));
			log.fail(effect.id, error);
			try { opts.onFailed?.(effect, error); } catch {}
		}
	};
	for (;;) {
		if (opts.until === undefined || now() < opts.until) {
			for (const effect of log.claim(concurrency - running.size)) {
				ran++;
				const p: Promise<void> = one(effect).finally(() => running.delete(p));
				running.add(p);
			}
		}
		if (!running.size) return ran;
		await Promise.race(running);
	}
}
