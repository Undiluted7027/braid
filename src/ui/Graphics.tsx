// Braid's drawings. Everything is made of the same few parts as the loom: a straight trunk, strands that
// leave it and rejoin it on an S-curve, nodes where something landed, and ties where two strands collide.
import { useId } from "react";
import type { Attempt, State } from "../shared/types";
import { intentColor } from "./api";

const LIVE = new Set(["working", "ready", "conflicted"]);

/** A strand from trunk (at `ty`) down to its lane `y`, running from x0 to x1, and back up if it landed. */
export function strand(x0: number, x1: number, ty: number, y: number, c: number, landed: boolean) {
	const out = `M ${x0} ${ty} C ${x0 + c} ${ty}, ${x0} ${y}, ${x0 + c} ${y}`;
	return out + (landed ? ` L ${x1 - c} ${y} C ${x1} ${y}, ${x1 - c} ${ty}, ${x1} ${ty}` : ` L ${x1} ${y}`);
}

function Dots({ id, pitch = 24 }: { id: string; pitch?: number }) {
	return <pattern id={id} width={pitch} height={pitch} patternUnits="userSpaceOnUse"><circle cx={pitch / 2} cy={pitch / 2} r="1" className="g-dot" /></pattern>;
}
function Hatch({ id }: { id: string }) {
	return <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" className="g-hatch" /></pattern>;
}

/** The picture on the home page: five attempts at four intents, one collision caught early, two landings. */
export function HeroLoom() {
	const id = useId();
	const T = 78, C = 26, G = 150;
	const lanes = [
		{ i: 1, who: "claude-code", y: 150, x0: 176, x1: 520, landed: true },
		{ i: 1, who: "codex", y: 204, x0: 214, x1: 380, landed: false, faded: true, note: "superseded" },
		{ i: 2, who: "claude-code", y: 258, x0: 262, x1: 640, landed: true },
		{ i: 3, who: "codex", y: 312, x0: 330, x1: 684, landed: false },
		{ i: 4, who: "claude-code", y: 366, x0: 400, x1: 684, landed: false },
	];
	return (
		<>
			<svg className="hero-loom wide" viewBox="0 0 760 420" role="img" aria-labelledby={`${id}-t`}>
				<title id={`${id}-t`}>Five agents attempt four intents beside trunk. Braid predicts one collision before it happens; two attempts have landed.</title>
				<defs><Dots id={`${id}-d`} /></defs>
				<rect x={G} width={760 - G} height="420" fill={`url(#${id}-d)`} />
				<line x1={G} y1={T} x2="760" y2={T} className="g-trunk" />
				<text x="0" y={T + 4} className="g-name strong">trunk</text>
				{lanes.map((l, n) => (
					<g key={n} style={{ ["--c" as string]: `var(--i${l.i})`, ["--n" as string]: n }}>
						<path d={strand(l.x0, l.x1, T, l.y, C, l.landed)} {...(l.faded ? { className: "g-strand faded" } : { pathLength: 1, className: "g-strand draw" })} />
						<text x="0" y={l.y + 4} className="g-name"><tspan className="g-id">I{l.i}</tspan> {l.who}{l.note && <tspan className="g-note"> · {l.note}</tspan>}</text>
						{[0.3, 0.52, 0.74].map((f) => !l.faded && <circle key={f} cx={l.x0 + C + (l.x1 - l.x0 - 2 * C) * f} cy={l.y} r="3" className="g-commit" />)}
						{l.landed && <circle cx={l.x1} cy={T} r="7" className="g-node" />}
						{!l.landed && !l.faded && <circle cx={l.x1} cy={l.y} r="5.5" className="g-node pulse" />}
					</g>
				))}
				<g className="g-tie bad"><line x1="466" y1="150" x2="466" y2="258" /><circle cx="466" cy="150" r="4.5" /><circle cx="466" cy="258" r="4.5" /></g>
				<g className="g-tie warn"><line x1="610" y1="312" x2="610" y2="366" /><circle cx="610" cy="312" r="4.5" /><circle cx="610" cy="366" r="4.5" /></g>
				<text x="520" y={T - 16} className="g-label" textAnchor="middle">I1 landed</text>
				<text x="640" y={T - 16} className="g-label" textAnchor="middle">I2 landed</text>
				<text x="478" y="208" className="g-label bad">will conflict</text>
				<text x="598" y="343" className="g-label warn" textAnchor="end">same file, mergeable</text>
				<text x="696" y="316" className="g-label">working</text>
				<text x="696" y="370" className="g-label">working</text>
			</svg>
			<svg className="hero-loom narrow" viewBox="0 0 358 176" aria-hidden="true">
				<defs><Dots id={`${id}-m`} /></defs>
				<rect width="358" height="176" fill={`url(#${id}-m)`} />
				<line x1="0" y1="28" x2="358" y2="28" className="g-trunk" />
				{[{ i: 1, y: 70, x0: 24, x1: 214, landed: true }, { i: 2, y: 110, x0: 70, x1: 296, landed: true }, { i: 3, y: 150, x0: 126, x1: 334, landed: false }].map((l, n) => (
					<g key={n} style={{ ["--c" as string]: `var(--i${l.i})`, ["--n" as string]: n }}>
						<path d={strand(l.x0, l.x1, 28, l.y, 20, l.landed)} pathLength={1} className="g-strand draw" />
						{l.landed ? <circle cx={l.x1} cy="28" r="6" className="g-node" /> : <circle cx={l.x1} cy={l.y} r="5" className="g-node pulse" />}
					</g>
				))}
				<g className="g-tie bad"><line x1="160" y1="70" x2="160" y2="110" /><circle cx="160" cy="70" r="4" /><circle cx="160" cy="110" r="4" /></g>
			</svg>
		</>
	);
}

/** One small drawing for each of the four ideas on the home page. */
export function StepArt({ step }: { step: 1 | 2 | 3 | 4 }) {
	const id = useId();
	return (
		<svg className="step-art" viewBox="0 0 200 84" aria-hidden="true" style={{ ["--c" as string]: `var(--i${step})` }}>
			<defs><Dots id={`${id}-d`} pitch={12} /></defs>
			<rect width="200" height="84" fill={`url(#${id}-d)`} />
			{step === 1 && <>
				<line x1="8" y1="20" x2="192" y2="20" className="g-trunk" />
				<line x1="52" y1="20" x2="52" y2="40" className="g-leader" />
				<rect x="34" y="40" width="132" height="34" rx="3" className="g-card" />
				<circle cx="48" cy="52" r="4" className="g-node" />
				<line x1="60" y1="52" x2="120" y2="52" className="g-text strong" />
				<line x1="44" y1="63" x2="152" y2="63" className="g-text" />
			</>}
			{step === 2 && <>
				<line x1="8" y1="16" x2="192" y2="16" className="g-trunk" />
				<path d={strand(26, 178, 16, 42, 14, false)} className="g-strand" />
				<path d={strand(52, 178, 16, 68, 14, false)} className="g-strand" />
				{[92, 136].map((x) => <circle key={x} cx={x} cy="42" r="2.6" className="g-commit" />)}
				{[110, 150].map((x) => <circle key={x} cx={x} cy="68" r="2.6" className="g-commit" />)}
				<circle cx="178" cy="42" r="4.5" className="g-node" /><circle cx="178" cy="68" r="4.5" className="g-node" />
				<g className="g-tie warn"><line x1="124" y1="42" x2="124" y2="68" /><circle cx="124" cy="42" r="3" /><circle cx="124" cy="68" r="3" /></g>
			</>}
			{step === 3 && <>
				<line x1="8" y1="20" x2="192" y2="20" className="g-trunk" />
				<path d="M 8 62 L 126 62 C 146 62, 126 20, 146 20" className="g-strand" />
				<line x1="100" y1="6" x2="100" y2="78" className="g-leader" />
				<rect x="91" y="53" width="18" height="18" rx="3" className="g-gate" />
				<path d="M95.5 62.5l3 3 6-6.5" className="g-check" />
				<circle cx="146" cy="20" r="6" className="g-node" />
			</>}
			{step === 4 && <>
				<line x1="22" y1="6" x2="22" y2="78" className="g-trunk" />
				<circle cx="22" cy="42" r="6" className="g-node" />
				<path d="M 28 42 C 46 42, 40 42, 58 42" className="g-strand thin" />
				{[14, 28, 42, 56, 70].map((y, n) => <line key={y} x1="70" y1={y} x2={[150, 176, 132, 164, 118][n]} y2={y} className="g-text" />)}
				<line x1="60" y1="24" x2="60" y2="60" className="g-strand" />
			</>}
		</svg>
	);
}

/**
 * A project's attempts in one glance: the loom with no words. With `intentId`, only that intent's strands,
 * still placed on the whole project's timeline so their position against trunk is true.
 */
export function MiniLoom({ state, intentId, className = "" }: { state: Pick<State, "attempts" | "landings">; intentId?: number; className?: string }) {
	const W = 320, T = 7, C = 8;
	const all = state.attempts.filter((a) => a.status !== "abandoned");
	const shown = all.filter((a) => intentId === undefined || a.intentId === intentId).sort((a, b) => a.intentId - b.intentId || a.createdAt - b.createdAt);
	const landingOf = new Map(state.landings.filter((l) => !l.revertOf && !l.revertedBy).map((l) => [l.attemptId, l]));
	const end = (a: Attempt) => landingOf.get(a.id)?.at ?? a.updatedAt;
	const times = [...new Set([...all.flatMap((a) => [a.createdAt, LIVE.has(a.status) ? a.createdAt : end(a)]), ...state.landings.map((l) => l.at)])].sort((x, y) => x - y);
	const x = (t: number) => 18 + (Math.max(0, times.findIndex((v) => v >= t)) / Math.max(1, times.length - 1)) * (W - 74);
	const gap = Math.min(9, 30 / Math.max(1, shown.length - 1));
	const H = T + 12 + (shown.length - 1) * gap + 7;
	const landed = shown.filter((a) => landingOf.has(a.id)).length, live = shown.filter((a) => LIVE.has(a.status)).length;
	const label = shown.length ? `${shown.length} attempt${shown.length === 1 ? "" : "s"}: ${landed} landed, ${live} in progress` : "No attempts yet";
	return (
		<svg className={`mini-loom ${className}`} viewBox={`0 0 ${W} ${Math.max(H, 26)}`} role="img" aria-label={label}>
			<line x1="4" y1={T} x2={W - 4} y2={T} className="g-trunk" />
			<circle cx="8" cy={T} r="2.5" className="g-seed" />
			{shown.map((a, i) => {
				const y = T + 12 + i * gap, l = landingOf.get(a.id), going = LIVE.has(a.status);
				const x0 = x(a.createdAt) - 4;
				const x1 = l ? Math.max(x(l.at) + 8, x0 + 2 * C + 6) : going ? W - 14 : Math.max(x(end(a)), x0 + 2 * C + 6);
				return (
					<g key={a.id} style={{ ["--c" as string]: intentColor(a.intentId) }}>
						<path d={strand(x0, x1, T, y, C, !!l)} className={`g-strand ${!l && !going ? "faded" : ""}`} />
						{l ? <circle cx={x1} cy={T} r="3.5" className="g-node" /> : going && <circle cx={x1} cy={y} r="3" className={`g-node ${a.status === "working" ? "pulse" : ""}`} />}
					</g>
				);
			})}
		</svg>
	);
}

/** The drawing beside an empty, loading or failed area. */
export function StateArt({ kind }: { kind: "empty" | "loading" | "broken" | "done" }) {
	const id = useId();
	return (
		<svg className={`state-art ${kind}`} viewBox="0 0 200 64" aria-hidden="true">
			<defs><Hatch id={`${id}-h`} /></defs>
			<rect x="0.5" y="0.5" width="199" height="63" rx="3" fill={`url(#${id}-h)`} className="g-frame" />
			<line x1="14" y1="20" x2="186" y2="20" className="g-trunk" />
			<circle cx="20" cy="20" r="3" className="g-seed" />
			{kind === "empty" && <path d={strand(52, 150, 20, 46, 14, true)} className="g-ghost" />}
			{kind === "loading" && <path d={strand(52, 170, 20, 46, 14, false)} className="g-ghost shimmer" />}
			{kind === "done" && <><path d={strand(52, 150, 20, 46, 14, true)} className="g-strand ok" /><circle cx="150" cy="20" r="5" className="g-node ok" /></>}
			{kind === "broken" && <>
				<path d={strand(52, 112, 20, 46, 14, false)} className="g-strand bad" />
				<path d="M120 39l10 14M130 39l-10 14" className="g-strand bad thin" />
				<path d="M140 46h30" className="g-ghost" />
			</>}
		</svg>
	);
}

/** An area with nothing in it yet: what it is for, and the first thing to do. */
export function Empty({ kind = "empty", title, children }: { kind?: "empty" | "loading" | "broken" | "done"; title: string; children?: React.ReactNode }) {
	return (
		<div className={`empty ${kind}`} role={kind === "loading" ? "status" : undefined}>
			<StateArt kind={kind} />
			<div><p className="empty-title">{title}</p>{children && <div className="empty-body">{children}</div>}</div>
		</div>
	);
}
