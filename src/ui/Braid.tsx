// The project at a glance: trunk on top, one strand per attempt leaving it and (when
// landed) rejoining it. Vertical ties between strands are overlaps Braid has detected.
// Everything drawn here explains itself in a card when pointed at, focused or tapped (LoomCard.tsx).
import type { Attempt, Overlap, State, TrunkCommit } from "../shared/types";
import { Agent } from "./App";
import { api, intentColor, navigate, useAsync, useNarrow } from "./api";
import { describe, useLoomCards, type CardTarget } from "./LoomCard";

const PAD = 28, TRUNK_Y = 38, LANE = 32, CURVE = 24;
const RANK = { claim: 1, touch: 2, conflict: 3 } as const;
const LIVE = new Set(["working", "ready", "conflicted"]);

export function Braid({ state }: { state: State }) {
	const slug = state.project.slug;
	// On a phone the names column would fill the screen, so it shrinks and the status moves to the strand's end.
	const narrow = useNarrow();
	const GUTTER = narrow ? 112 : 200;
	// Trunk's own commits: where it started, and anything pushed to it without going through an intent.
	const { data: history } = useAsync(() => api<TrunkCommit[]>("GET", `/p/${slug}/history`), [slug, state.project.head]);
	const outside = (history ?? []).filter((c) => c.kind === "outside");
	const cards = useLoomCards(state, history);
	const strands = state.attempts.filter((a) => a.status !== "abandoned").sort((a, b) => a.intentId - b.intentId || a.createdAt - b.createdAt);
	const attemptsByIntent = new Map<number, Attempt[]>();
	for (const a of strands) attemptsByIntent.set(a.intentId, [...(attemptsByIntent.get(a.intentId) ?? []), a]);
	const landingOf = new Map(state.landings.filter((l) => !l.revertOf).map((l) => [l.attemptId, l]));
	const reverts = state.landings.filter((l) => l.revertOf);
	const end = (a: Attempt) => landingOf.get(a.id)?.at ?? a.updatedAt;

	// Even spacing by order of events, so a burst of work and a long idle gap both stay readable.
	const times = [...new Set([...strands.flatMap((a) => [a.createdAt, LIVE.has(a.status) ? a.createdAt : end(a)]), ...state.landings.map((l) => l.at), ...outside.map((c) => c.at)])].sort((x, y) => x - y);
	// A quiet project gets room to breathe; a busy one packs its events closer and scrolls.
	const STEP = Math.round(Math.min(150, Math.max(68, 980 / (times.length + 3))));
	const x = (t: number) => GUTTER + PAD + STEP + times.findIndex((v) => v >= t) * STEP;
	const xNow = GUTTER + PAD + STEP + Math.max(times.length, 2) * STEP + 90;
	const width = xNow + PAD + 70;
	const laneByIntent = new Map([...attemptsByIntent.keys()].map((intentId, i) => [intentId, TRUNK_Y + 44 + i * LANE]));
	const lane = new Map(strands.map((a) => [a.id, laneByIntent.get(a.intentId)!]));
	const height = TRUNK_Y + 44 + Math.max(attemptsByIntent.size, 1) * LANE + 6;

	// Strongest overlap per pair of attempts.
	const ties = new Map<string, Overlap & { paths: string[] }>();
	for (const o of state.overlaps) {
		const key = `${o.a}|${o.b}`, prev = ties.get(key);
		if (!prev) ties.set(key, { ...o, paths: [o.path] });
		else { prev.paths.push(o.path); if (RANK[o.severity] > RANK[prev.severity]) prev.severity = o.severity; }
	}

	// A thing on the graph that goes somewhere: a click or Enter follows it, a finger's first tap shows its card instead.
	const goes = (target: CardTarget, to: string, point = false) => ({
		...cards.bind(target, { point }),
		role: "link", tabIndex: 0, "aria-label": describe(state, target),
		onClick: (e: React.MouseEvent<Element>) => { if (!cards.tapped(e, target)) navigate(to); },
		onKeyDown: (e: React.KeyboardEvent<Element>) => { if (e.key === "Enter") navigate(to); },
	});
	// A thing that only explains itself.
	const tells = (target: CardTarget, label: string) => ({
		...cards.bind(target), role: "img", tabIndex: 0, "aria-label": label,
		onClick: (e: React.MouseEvent<Element>) => { cards.tapped(e, target); },
	});
	const start = history?.find((c) => c.kind === "start");

	return (
		<div className="braid">
			<div className="braid-head">
				<h2 className="label">Attempts over time</h2>
				<p>Trunk runs along the top. Each strand is one agent's attempt at an intent: it leaves trunk where it forked and rejoins where it landed. Point at anything on the graph, or move to it with Tab, to see what it is; select a strand to open its intent.</p>
			</div>
			<div className="braid-scroll" tabIndex={0} role="group" aria-label="Attempts over time, scrollable">
			<svg width={width} height={height} role="group" aria-label="Attempts braiding into trunk">
				<line x1={GUTTER} y1={TRUNK_Y} x2={width - PAD} y2={TRUNK_Y} className="trunk" />
				<text x={18} y={TRUNK_Y + 4} className="lane-name" fontWeight={700}>trunk</text>
				<g className="node start" {...tells({ kind: "start" }, `Where trunk started${start ? `: ${start.subject}, by ${start.author}` : ""}.`)}>
					<circle cx={GUTTER + PAD} cy={TRUNK_Y} r={13} className="hit" />
					<circle cx={GUTTER + PAD} cy={TRUNK_Y} r={4} className="seed node-dot" />
					<text x={GUTTER + PAD} y={TRUNK_Y - 12} className="node-label" textAnchor="middle">start</text>
				</g>
				{[...attemptsByIntent].map(([intentId, attempts]) => {
					const y = laneByIntent.get(intentId)!;
					const latest = attempts[attempts.length - 1];
					return (
						<g key={intentId} className="lane-label">
							<text x={18} y={y + 4} className="lane-name">
								<tspan style={{ fill: intentColor(intentId) }} fontWeight={700}>I{intentId}</tspan>
							</text>
							<foreignObject x={46} y={y - 11} width={narrow ? GUTTER - 54 : GUTTER - 126} height={22} className="lane-agent">
								<span className="lane-agents">
									{attempts.map((a) => (
										<span key={a.id} className={`lane-agent-state ${a.status}`} title={`${a.agent}: ${a.status}`}>
											<Agent name={a.agent} kind={a.kind} model={a.model} />
										</span>
									))}
								</span>
							</foreignObject>
							{!narrow && <text x={GUTTER - 10} y={y + 4} className={`lane-status ${latest.status}`} textAnchor="end">{latest.status}</text>}
						</g>
					);
				})}

				{strands.map((a) => {
					const y = lane.get(a.id)!, color = intentColor(a.intentId), landed = landingOf.get(a.id);
					const x0 = x(a.createdAt) - STEP / 2;
					const x1 = landed ? x(landed.at) : LIVE.has(a.status) ? xNow : Math.max(x(end(a)), x0 + 2 * CURVE + 10);
					const out = `M ${x0} ${TRUNK_Y} C ${x0 + CURVE} ${TRUNK_Y}, ${x0} ${y}, ${x0 + CURVE} ${y}`;
					const back = landed ? ` L ${x1 - CURVE} ${y} C ${x1} ${y}, ${x1 - CURVE} ${TRUNK_Y}, ${x1} ${TRUNK_Y}` : ` L ${x1} ${y}`;
					const faded = a.status === "superseded";
					const liveEnd = !landed && LIVE.has(a.status);
					return (
						<g key={a.id} className={`strand ${a.status} ${cards.openKey === `a:${a.id}` ? "on" : ""}`} {...goes({ kind: "attempt", id: a.id }, `/p/${slug}/i/${a.intentId}`, true)}>
							<path d={out + back} className="hit" />
							<path d={out + back} style={{ stroke: color }} strokeOpacity={faded ? 0.3 : 1} strokeDasharray={faded ? "4 4" : undefined} className="strand-line" />
							{a.files.length > 0 && LIVE.has(a.status) && <text x={x1 + 12} y={y + 4} className="node-label">{narrow ? a.status : `${a.files.length} file${a.files.length === 1 ? "" : "s"}`}</text>}
							{liveEnd && <circle data-anchor cx={x1} cy={y} r={5} style={{ fill: color }} className={a.status === "working" ? "pulse" : ""} />}
							{!liveEnd && <circle data-anchor cx={x1} cy={y} r={1} fill="transparent" />}
							{!landed && !LIVE.has(a.status) && <text x={x1 + 6} y={y + 4} className="node-label">{a.status}</text>}
						</g>
					);
				})}

				{[...ties.values()].map((t, i) => {
					const ya = lane.get(t.a), yb = lane.get(t.b), first = state.attempts.find((a) => a.id === t.a);
					if (ya === undefined || yb === undefined || !first) return null;
					const tx = xNow - 26 - i * 16;
					return (
						<g key={`${t.a}|${t.b}`} className={`tie ${t.severity} ${cards.openKey === `t:${t.a}|${t.b}` ? "on" : ""}`} {...goes({ kind: "tie", a: t.a, b: t.b }, `/p/${slug}/i/${first.intentId}`)}>
							<line x1={tx} y1={ya} x2={tx} y2={yb} className="hit" />
							<line x1={tx} y1={ya} x2={tx} y2={yb} className="tie-line" />
							<circle cx={tx} cy={ya} r={3.5} /><circle cx={tx} cy={yb} r={3.5} />
						</g>
					);
				})}

				{strands.map((a) => {
					const l = landingOf.get(a.id);
					if (!l) return null;
					const cx = x(l.at), color = intentColor(a.intentId);
					return (
						<g key={l.sha} className={`node landing ${l.revertedBy ? "undone" : ""} ${cards.openKey === `l:${l.sha}` ? "on" : ""}`} style={{ ["--c" as string]: color }}
							{...goes({ kind: "landing", sha: l.sha }, l.files[0] ? `/p/${slug}/why?path=${encodeURIComponent(l.files[0])}` : `/p/${slug}/i/${l.intentId}`)}>
							<circle cx={cx} cy={TRUNK_Y} r={13} className="hit" />
							<circle cx={cx} cy={TRUNK_Y} r={6} className="node-dot" />
							{l.reconciled && <circle cx={cx} cy={TRUNK_Y} r={10} className="ring" />}
							<text x={cx} y={TRUNK_Y - (l.reconciled ? 16 : 12)} className="node-label strong" textAnchor="middle">I{a.intentId}</text>
						</g>
					);
				})}
				{reverts.map((l) => {
					const cx = x(l.at);
					return (
						<g key={l.sha} className={`node revert ${cards.openKey === `l:${l.sha}` ? "on" : ""}`} style={{ ["--c" as string]: intentColor(l.intentId) }} {...goes({ kind: "landing", sha: l.sha }, `/p/${slug}/i/${l.intentId}`)}>
							<circle cx={cx} cy={TRUNK_Y} r={13} className="hit" />
							<circle cx={cx} cy={TRUNK_Y} r={6} className="node-dot" />
							<path d={`M ${cx - 2.5} ${TRUNK_Y - 2.5} l 5 5 M ${cx + 2.5} ${TRUNK_Y - 2.5} l -5 5`} className="cross" />
							<text x={cx} y={TRUNK_Y - 12} className="node-label" textAnchor="middle">I{l.intentId} out</text>
						</g>
					);
				})}
				{outside.map((c) => {
					const cx = x(c.at);
					return (
						<g key={c.sha} className={`node outside ${cards.openKey === `o:${c.sha}` ? "on" : ""}`} {...tells({ kind: "outside", sha: c.sha }, `Pushed to trunk outside Braid: ${c.subject}, by ${c.author}.`)}>
							<circle cx={cx} cy={TRUNK_Y} r={13} className="hit" />
							<rect x={cx - 4.5} y={TRUNK_Y - 4.5} width={9} height={9} transform={`rotate(45 ${cx} ${TRUNK_Y})`} className="node-dot" />
						</g>
					);
				})}
				{strands.length === 0 && <text x={GUTTER + PAD + 30} y={TRUNK_Y + 48} className="lane-name">No attempts yet. Open an intent and add an agent to see its strand here.</text>}
			</svg>
			</div>
			<div className="legend">
				<span className="label">On trunk</span>
				<span><i className="key dot" /> landed</span>
				<span><i className="key ring" /> landed through a reconciliation</span>
				{reverts.length > 0 && <span><i className="key out" /> taken back out</span>}
				{outside.length > 0 && <span><i className="key diamond" /> pushed outside Braid</span>}
				<span className="label gap">Between strands</span>
				<span><i className="key conflict" /> will conflict</span>
				<span><i className="key touch" /> same file, mergeable</span>
				<span><i className="key claim" /> both plan to change a file</span>
			</div>
			{cards.card}
		</div>
	);
}
