// What the agent actually did: its words, the commands and tools it ran, and what came back,
// with the decisions it recorded placed where they happened.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Decision, SessionEvent } from "../shared/types";
import { api, onSession } from "./api";
import { Empty } from "./Graphics";
import { Icon, Notice, type IconName } from "./Kit";

const MARK: Record<SessionEvent["kind"], IconName> = { say: "say", tool: "chevron-right", result: "result", braid: "strands", system: "dot" };
const WHAT: Record<SessionEvent["kind"], string> = { say: "The agent said", tool: "The agent ran", result: "Came back", braid: "Braid tool", system: "Session" };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

type Row = { key: string; at: number; event?: SessionEvent; decision?: Decision };

function EventRow({ e }: { e: SessionEvent }) {
	const [open, setOpen] = useState(false);
	const lines = e.text.split("\n");
	const long = lines.length > 4 || e.text.length > 400;
	const shown = open || !long ? e.text : lines.slice(0, 4).join("\n").slice(0, 400);
	return (
		<li className={`ev ev-${e.kind} ${e.tool === "error" ? "ev-error" : ""}`}>
			<time className="ev-time">{clock(e.at)}</time>
			<span className="ev-mark"><Icon name={MARK[e.kind]} size={14} label={WHAT[e.kind]} /></span>
			<div className="ev-body">
				{e.tool && e.tool !== "error" && <span className="ev-tool">{e.tool}</span>}
				<span className={e.kind === "say" ? "ev-text" : "ev-text mono"}>{shown}{long && !open ? "…" : ""}</span>
				{long && <button className="ev-more" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Show less" : `Show all ${lines.length} lines`}</button>}
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

	if (error) return <Notice>{error}</Notice>;
	if (!events) return <Empty kind="loading" title="Loading the session…" />;
	if (!events.length) return <Empty title="No session recorded"><p>Agents started with <code>braid join --run</code> stream what they say and run. Others leave only their calls to Braid's tools.</p></Empty>;
	return (
		<>
			<p className="session-key dim">
				<span><Icon name="say" size={14} />said</span><span><Icon name="chevron-right" size={14} />ran</span><span><Icon name="result" size={14} />came back</span><span><Icon name="strands" size={14} />Braid tool</span><span><Icon name="decision" size={14} />decision recorded</span>
				<span className="spacer" /><span>{events.length} event{events.length === 1 ? "" : "s"}</span>
			</p>
			<ol className="session" ref={box} tabIndex={0} aria-label="Session transcript" onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
				{rows.map((r) => r.event ? <EventRow key={r.key} e={r.event} /> : (
					<li key={r.key} className="ev decision-mark">
						<time className="ev-time">{clock(r.at)}</time>
						<span className="ev-mark"><Icon name="decision" size={14} label="Decision recorded" /></span>
						<div className="ev-body"><span className="ev-tool">{r.decision!.kind}</span><strong>{r.decision!.title}</strong>{r.decision!.body && <span className="ev-text ev-why"> {r.decision!.body}</span>}</div>
					</li>
				))}
				{live && <li className="ev tail"><span className="ev-time" /><span className="ev-mark pulse"><Icon name="say" size={14} /></span><div className="ev-body">The agent is working. New events appear here.</div></li>}
			</ol>
		</>
	);
}
