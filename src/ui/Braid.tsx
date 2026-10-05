// The project at a glance: trunk on top, one strand per attempt leaving it and (when
// landed) rejoining it. Vertical ties between strands are overlaps Braid has detected.
import type { Attempt, Overlap, State } from "../shared/types";
import { intentColor, navigate, useNarrow } from "./api";

const PAD = 28, TRUNK_Y = 38, LANE = 32, CURVE = 24;
const RANK = { claim: 1, touch: 2, conflict: 3 } as const;
const LIVE = new Set(["working", "ready", "conflicted"]);

export function Braid({ state }: { state: State }) {
	// On a phone the names column would fill the screen, so it shrinks and the status moves to the strand's end.
	const narrow = useNarrow();
	const GUTTER = narrow ? 112 : 200;
	const strands = state.attempts.filter((a) => a.status !== "abandoned").sort((a, b) => a.intentId - b.intentId || a.createdAt - b.createdAt);
	const landingOf = new Map(state.landings.filter((l) => !l.revertOf).map((l) => [l.attemptId, l]));
	const end = (a: Attempt) => landingOf.get(a.id)?.at ?? a.updatedAt;

	// Even spacing by order of events, so a burst of work and a long idle gap both stay readable.
	const times = [...new Set([...strands.flatMap((a) => [a.createdAt, LIVE.has(a.status) ? a.createdAt : end(a)]), ...state.landings.map((l) => l.at)])].sort((x, y) => x - y);
	// A quiet project gets room to breathe; a busy one packs its events closer and scrolls.
	const STEP = Math.round(Math.min(150, Math.max(68, 980 / (times.length + 3))));
	const x = (t: number) => GUTTER + PAD + STEP + times.findIndex((v) => v >= t) * STEP;
	const xNow = GUTTER + PAD + STEP + Math.max(times.length, 2) * STEP + 90;
	const width = xNow + PAD + 70;
	const lane = new Map(strands.map((a, i) => [a.id, TRUNK_Y + 44 + i * LANE]));
	const height = TRUNK_Y + 44 + Math.max(strands.length, 1) * LANE + 6;

	// Strongest overlap per pair of attempts.
	const ties = new Map<string, Overlap & { paths: string[] }>();
	for (const o of state.overlaps) {
		const key = `${o.a}|${o.b}`, prev = ties.get(key);
		if (!prev) ties.set(key, { ...o, paths: [o.path] });
		else { prev.paths.push(o.path); if (RANK[o.severity] > RANK[prev.severity]) prev.severity = o.severity; }
	}

	return (
		<div className="braid">
			<div className="braid-head">
				<h2 className="label">Attempts over time</h2>
				<p>Trunk runs along the top. Each strand is one agent's attempt at an intent: it leaves trunk where it forked and rejoins where it landed. Select a strand to open its intent.</p>
			</div>
			<div className="braid-scroll" tabIndex={0} role="group" aria-label="Attempts over time, scrollable">
			<svg width={width} height={height} role="img" aria-label="Attempts braiding into trunk">
				<line x1={GUTTER} y1={TRUNK_Y} x2={width - PAD} y2={TRUNK_Y} className="trunk" />
				<text x={18} y={TRUNK_Y + 4} className="lane-name" fontWeight={700}>trunk</text>
				<circle cx={GUTTER + PAD} cy={TRUNK_Y} r={4} className="seed" />
				<text x={GUTTER + PAD} y={TRUNK_Y - 12} className="node-label" textAnchor="middle">seed</text>

				{strands.map((a) => {
					const y = lane.get(a.id)!, color = intentColor(a.intentId), landed = landingOf.get(a.id);
					const x0 = x(a.createdAt) - STEP / 2;
					const x1 = landed ? x(landed.at) : LIVE.has(a.status) ? xNow : Math.max(x(end(a)), x0 + 2 * CURVE + 10);
					const out = `M ${x0} ${TRUNK_Y} C ${x0 + CURVE} ${TRUNK_Y}, ${x0} ${y}, ${x0 + CURVE} ${y}`;
					const back = landed ? ` L ${x1 - CURVE} ${y} C ${x1} ${y}, ${x1 - CURVE} ${TRUNK_Y}, ${x1} ${TRUNK_Y}` : ` L ${x1} ${y}`;
					const faded = a.status === "superseded";
					return (
						<g key={a.id} className={`strand ${a.status}`} role="link" tabIndex={0} aria-label={`I${a.intentId}, attempt ${a.id} by ${a.agent}: ${a.status}`}
							onClick={() => navigate(`/p/${state.project.slug}/i/${a.intentId}`)} onKeyDown={(e) => { if (e.key === "Enter") navigate(`/p/${state.project.slug}/i/${a.intentId}`); }}>
							<title>{`Open I${a.intentId}: attempt ${a.id} by ${a.agent} (${a.status})`}</title>
							<text x={18} y={y + 4} className="lane-name">
								<tspan style={{ fill: color }} fontWeight={700}>I{a.intentId}</tspan>
								<tspan dx={6}>{narrow && a.agent.length > 10 ? `${a.agent.slice(0, 9)}…` : a.agent}</tspan>
							</text>
							{!narrow && <text x={GUTTER - 10} y={y + 4} className={`lane-status ${a.status}`} textAnchor="end">{a.status}</text>}
							<path d={out + back} style={{ stroke: color }} strokeOpacity={faded ? 0.3 : 1} strokeDasharray={faded ? "4 4" : undefined} className="strand-line" />
							{a.files.length > 0 && LIVE.has(a.status) && <text x={x1 + 12} y={y + 4} className="node-label">{narrow ? a.status : `${a.files.length} file${a.files.length === 1 ? "" : "s"}`}</text>}
							{landed && <>
								<circle cx={x1} cy={TRUNK_Y} r={6} style={{ fill: color }} />
								{landed.reconciled && <circle cx={x1} cy={TRUNK_Y} r={10} className="ring" style={{ stroke: color }} />}
								<text x={x1} y={TRUNK_Y - (landed.reconciled ? 16 : 12)} className="node-label strong" textAnchor="middle">I{a.intentId}</text>
							</>}
							{!landed && LIVE.has(a.status) && <circle cx={x1} cy={y} r={5} style={{ fill: color }} className={a.status === "working" ? "pulse" : ""} />}
							{!landed && !LIVE.has(a.status) && <text x={x1 + 6} y={y + 4} className="node-label">{a.status}</text>}
						</g>
					);
				})}

				{[...ties.values()].map((t, i) => {
					const ya = lane.get(t.a), yb = lane.get(t.b);
					if (ya === undefined || yb === undefined) return null;
					const tx = xNow - 26 - i * 16;
					return (
						<g key={`${t.a}|${t.b}`} className={`tie ${t.severity}`}>
							<title>{`${t.severity}: ${t.paths.join(", ")}`}</title>
							<line x1={tx} y1={ya} x2={tx} y2={yb} />
							<circle cx={tx} cy={ya} r={3.5} /><circle cx={tx} cy={yb} r={3.5} />
						</g>
					);
				})}
				{strands.length === 0 && <text x={GUTTER + PAD + 30} y={TRUNK_Y + 48} className="lane-name">No attempts yet. Open an intent and add an agent to see its strand here.</text>}
			</svg>
			</div>
			<div className="legend">
				<span className="label">Ties between strands</span>
				<span><i className="key conflict" /> will conflict</span>
				<span><i className="key touch" /> same file, mergeable</span>
				<span><i className="key claim" /> both plan to change a file</span>
				<span><i className="key ring" /> landed through a reconciliation</span>
			</div>
		</div>
	);
}
