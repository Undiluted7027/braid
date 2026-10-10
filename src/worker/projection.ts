// How each event changes the project's tables. This is the only place those tables are written for
// the kinds of event listed here, so replaying the log into empty tables gives the same rows.
import type { BraidEvent, Sql } from "./log.ts";

export function applyEvent(sql: Sql, e: BraidEvent) {
	switch (e.type) {
		case "activity.noted":
			sql.exec("INSERT INTO activity (at, kind, actor, text, intent_id, attempt_id) VALUES (?, ?, ?, ?, ?, ?)", e.at, e.data.kind, e.actor, e.data.text, e.intentId, e.attemptId);
			break;
		case "signal.sent":
			sql.exec("INSERT INTO signals (to_attempt, kind, body, at) VALUES (?, ?, ?, ?)", e.attemptId, e.data.kind, JSON.stringify(e.data.body ?? {}), e.at);
			break;
		case "signals.delivered":
			sql.exec("UPDATE signals SET seen = 1 WHERE to_attempt = ? AND seen = 0 AND id <= ?", e.attemptId, e.data.upTo);
			break;
		case "context.repo.created":
			sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('context_remote', ?)", e.data.remote);
			break;
		// An event this version does not know changes nothing here: it was written by a newer one.
	}
}
