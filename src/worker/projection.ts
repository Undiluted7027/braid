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
		case "trunk.moved":
			sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('head', ?)", e.data.head);
			break;
		// What a reading of an attempt's repository found. Written on its own columns, so it cannot undo a claim, a check or a status change.
		case "attempt.observed":
			sql.exec("UPDATE attempts SET base_sha = ?, head_sha = ?, files = ?, behind = ?, trunk_conflicts = ?, trunk_seen = ?, updated_at = ? WHERE id = ?",
				e.data.baseSha, e.data.headSha, JSON.stringify(e.data.files), e.data.behind, JSON.stringify(e.data.trunkConflicts), e.data.trunkSeen, e.at, e.attemptId);
			break;
		case "attempt.status":
			sql.exec("UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?", e.data.status, e.at, e.attemptId);
			break;
		case "attempt.claimed":
			sql.exec("UPDATE attempts SET claims = ?, updated_at = ? WHERE id = ?", JSON.stringify(e.data.claims), e.at, e.attemptId);
			break;
		case "reconciliation.dropped":
			sql.exec("DELETE FROM reconciliations WHERE attempt_id = ? AND status IN ('open', 'resolving')", e.attemptId);
			break;
		// All of one attempt's overlaps at once: its pairs with everyone else.
		case "overlaps.changed":
			sql.exec("DELETE FROM overlaps WHERE a = ? OR b = ?", e.attemptId, e.attemptId);
			for (const o of e.data.overlaps) sql.exec("INSERT OR REPLACE INTO overlaps (a, b, path, severity, regions) VALUES (?, ?, ?, ?, ?)", o.a, o.b, o.path, o.severity, o.regions);
			break;
		case "spare.ready":
			sql.exec("INSERT OR REPLACE INTO spares (repo, remote, base_sha, at) VALUES (?, ?, ?, ?)", e.data.repo, e.data.remote, e.data.base, e.at);
			break;
		case "spare.taken": case "spare.dropped":
			sql.exec("DELETE FROM spares WHERE repo = ?", e.data.repo);
			break;
		// Trunk gained one commit that changed nothing this attempt touches.
		case "attempt.trunk-advanced":
			sql.exec("UPDATE attempts SET behind = behind + 1, trunk_seen = ? WHERE id = ?", e.data.trunkSeen, e.attemptId);
			break;
		case "outcome.recorded":
			sql.exec("INSERT INTO outcomes (kind, outcome, text, attempt_id, intent_id, by, ref, sha, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", e.data.kind, e.data.outcome, e.data.text, e.attemptId, e.intentId, e.actor, e.data.ref ?? "", e.data.sha ?? "", e.at);
			break;
		case "attempt.flagged":
			sql.exec("UPDATE attempts SET flags = ? WHERE id = ?", JSON.stringify(e.data.flags), e.attemptId);
			break;
		// An event this version does not know changes nothing here: it was written by a newer one.
	}
}
