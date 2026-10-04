// What the agent actually did: its words, the commands and tools it ran, and what came back,
// with the decisions it recorded placed where they happened.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Decision, SessionEvent } from "../shared/types";
import { api, onSession } from "./api";

const MARK: Record<SessionEvent["kind"], string> = { say: "●", tool: "→", result: "←", braid: "◆", system: "·" };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

type Row = { key: string; at: number; event?: SessionEvent; decision?: Decision };

function EventRow({ e }: { e: SessionEvent }) {
	const [open, setOpen] = useState(false);
	const lines = e.text.split("\n");
	const long = lines.length > 4 || e.text.length > 400;
	const shown = open || !long ? e.text : lines.slice(0, 4).join("\n").slice(0, 400);
	return (
		<li className={`ev ev-${e.kind} ${e.tool === "error" ? "ev-error" : ""}`}>
			<span className="ev-time">{clock(e.at)}</span>
			<span className="ev-mark" aria-hidden="true">{MARK[e.kind]}</span>
			<div className="ev-body">
				{e.tool && e.tool !== "error" && <span className="ev-tool">{e.tool}</span>}
				<span className={e.kind === "say" ? "ev-text" : "ev-text mono"}>{shown}</span>
				{long && <button className="ev-more" onClick={() => setOpen(!open)}>{open ? "less" : `more (${lines.length} lines)`}</button>}
			</div>
		</li>
	);
}

export function Session({ slug, attemptId, decisions, live }: { slug: string; attemptId: string; decisions: Decision[]; live: boolean }) {
	const [events, setEvents] = useState<SessionEvent[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const box = useRef<HTMLOListElement>(null);
	const pinned = useRef(true);

	useEffect(() => {
		let stale = false;
		api<SessionEvent[]>("GET", `/p/${slug}/attempts/${attemptId}/session`).then((e) => { if (!stale) setEvents(e); }, (e) => { if (!stale) setError(e.message); });
		// Events can arrive while the first fetch is in flight; merge by id.
		const off = onSession(attemptId, (fresh) => setEvents((have) => {
			const seen = new Set((have ?? []).map((e) => e.id));
			return [...(have ?? []), ...fresh.filter((e) => !seen.has(e.id))];
		}));
		return () => { stale = true; off(); };
	}, [slug, attemptId]);

	const rows = useMemo<Row[]>(() => [
		...(events ?? []).map((event) => ({ key: `e${event.id}`, at: event.at, event })),
		...decisions.map((decision) => ({ key: `d${decision.id}`, at: decision.at, decision })),
	].sort((a, b) => a.at - b.at), [events, decisions]);

	// Follow the tail while the reader is at the bottom; stay put once they scroll up.
	useEffect(() => { if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [rows.length]);

	if (error) return <p className="error">{error}</p>;
	if (!events) return <p className="dim small">Loading session…</p>;
	if (!events.length) return <p className="dim small">No session recorded. Agents started with <code>braid join --run</code> stream theirs; others leave only their Braid calls.</p>;
	return (
		<ol className="session" ref={box} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
			{rows.map((r) => r.event ? <EventRow key={r.key} e={r.event} /> : (
				<li key={r.key} className="ev decision-mark">
					<span className="ev-time">{clock(r.at)}</span>
					<span className="ev-mark" aria-hidden="true">¶</span>
					<div className="ev-body"><span className="ev-tool">{r.decision!.kind}</span><strong>{r.decision!.title}</strong>{r.decision!.body && <span className="ev-text dim"> {r.decision!.body}</span>}</div>
				</li>
			))}
			{live && <li className="ev tail dim"><span className="ev-time" /><span className="ev-mark pulse">●</span><div className="ev-body">live</div></li>}
		</ol>
	);
}
