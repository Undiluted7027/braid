// The card that explains whatever on the loom is being pointed at, focused or tapped: an attempt, a landing,
// a commit on trunk, or a tie between two attempts. One card is open at a time. It is placed once, when it
// opens, and filled from the latest state by key, so a live refresh changes its words and not its position.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Attempt, Overlap, State, TrunkCommit } from "../shared/types";
import { ago, short, useNarrow, useNow } from "./api";
import { Agent, IntentId, Link } from "./App";
import { Icon, type IconName } from "./Kit";
import { batchFor, batchWords, queueLabel } from "./Batch";
import { landingVerdict, neverStarted, reason } from "./Later";
import { runFor } from "./Verify";

export type CardTarget =
	| { kind: "attempt"; id: string }
	/** A landing, or the commit that took one back out. */
	| { kind: "landing"; sha: string }
	| { kind: "tie"; a: string; b: string }
	| { kind: "start" }
	| { kind: "outside"; sha: string };
const keyOf = (t: CardTarget) => (t.kind === "attempt" ? `a:${t.id}` : t.kind === "landing" ? `l:${t.sha}` : t.kind === "tie" ? `t:${t.a}|${t.b}` : t.kind === "outside" ? `o:${t.sha}` : "start");

const LIVE = new Set(["working", "ready", "conflicted"]);
const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STATUS: Record<Attempt["status"], string> = {
	working: "The agent is working on it",
	ready: "Ready for you to review",
	conflicted: "Collided with trunk when it tried to land",
	landed: "Landed on trunk",
	superseded: "Set aside: another attempt landed for this intent",
	abandoned: "Abandoned",
	reverted: "Landed, then taken back out of trunk",
};
export const TIE: Record<Overlap["severity"], { label: string; means: string }> = {
	conflict: { label: "will conflict", means: "They change the same lines. Whichever lands second will not merge cleanly, and Braid will open a reconciliation to resolve it with both goals in view." },
	touch: { label: "same file, mergeable", means: "They changed the same file in different places. Git can merge them; nothing needs doing." },
	claim: { label: "both plan to change a file", means: "Both agents have said they intend to change this file. Nothing has collided yet." },
};

type Tone = "good" | "bad" | "warn" | "";
function Fact({ icon, tone = "", children }: { icon: IconName; tone?: Tone; children: ReactNode }) {
	return <li className={tone}><Icon name={icon} size={14} /><span>{children}</span></li>;
}

/** What Braid's run of an attempt's current commit says, in words. */
function checks(state: State, a: Attempt): { tone: Tone; icon: IconName; text: string } {
	if (a.headSha === a.baseSha) return { tone: "", icon: "dot", text: "Nothing pushed yet, so nothing has been run" };
	const run = runFor(state, a.id);
	if (!run) return { tone: "", icon: "clock", text: "Its commit has not been run yet" };
	if (run.sha !== a.headSha) return { tone: "", icon: "clock", text: `Commit ${short(a.headSha)} is waiting to be run; the last run was of ${short(run.sha)}` };
	if (run.status === "pass") return { tone: "good", icon: "check", text: run.nothingToRun ? "Nothing to run: the repository defines no checks" : `Checks passed (${run.steps.map((s) => s.name).join(", ")})` };
	if (run.status === "fail") return { tone: "bad", icon: "x", text: `Checks failed: ${run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}` };
	if (run.status === "error") return { tone: "bad", icon: "warning", text: "The checks could not be run" };
	return { tone: "", icon: "running", text: run.status === "queued" ? "Checks are queued" : "Checks are running now" };
}

function AttemptCard({ state, a }: { state: State; a: Attempt }) {
	const slug = state.project.slug;
	const intent = state.intents.find((i) => i.id === a.intentId);
	const now = useNow(a.id, a.now);
	const going = LIVE.has(a.status);
	const decisions = state.decisions.filter((d) => d.attemptId === a.id);
	const answered = new Set(decisions.filter((d) => d.kind === "answer").map((d) => d.title.replace(/^Answer: /, "")));
	const asking = going ? decisions.filter((d) => d.kind === "question" && !answered.has(d.title)) : [];
	const landing = state.landings.find((l) => l.attemptId === a.id && !l.revertOf);
	const queued = state.queue.find((q) => q.attemptId === a.id), inBatch = batchFor(state, a.id);
	const last = landingVerdict(state, a), refused = last?.outcome === "refused" ? last : null;
	const run = checks(state, a);
	const mine = state.overlaps.filter((o) => o.a === a.id || o.b === a.id);
	const other = (o: Overlap) => (o.a === a.id ? o.b : o.a);
	const clash = [...new Set(mine.filter((o) => o.severity === "conflict").map(other))];
	const hostedGoing = a.hosted === "starting" || a.hosted === "running";
	return (
		<>
			<p className="lc-kicker">Attempt <span className="mono">{a.id}</span></p>
			<p className="lc-title"><IntentId id={a.intentId} /><span>{intent?.title ?? `Intent ${a.intentId}`}</span></p>
			<p className="lc-who"><Agent name={a.agent} kind={a.kind} model={a.model} /><span className="lc-dim">{a.model ? a.agent : ""}</span></p>
			<p className="lc-status"><span className={`chip ${queued ? "working" : a.status}`}>{queued ? queueLabel(state, queued) : a.status}</span><span>{STATUS[a.status]}{landing && a.status === "landed" ? ` ${ago(landing.at)}` : ""}.</span></p>
			{a.status === "working" && now && <p className="lc-now"><span className="lc-label">Right now</span><span className="mono">{now.tool ? `${now.tool}: ` : ""}{now.text.split("\n")[0].slice(0, 120)}</span></p>}
			{a.summary && <p className="lc-summary">{a.summary}</p>}
			<ul className="lc-facts">
				<Fact icon="changes">{a.files.length ? `${plural(a.files.length, "file")} changed` : "No files changed yet"} · {plural(decisions.length, "decision")} recorded</Fact>
				{asking.length > 0 && <Fact icon="question" tone="warn">Asks you: {asking[0].title}{asking.length > 1 ? ` (and ${asking.length - 1} more)` : ""}</Fact>}
				{(going || a.status === "landed") && <Fact icon={run.icon} tone={run.tone}>{run.text}</Fact>}
				{queued && !inBatch && <Fact icon="land">Asked to land by {queued.by}{queued.note ? `: ${queued.note}` : ""}</Fact>}
				{queued && inBatch && <Fact icon="land" tone={inBatch.batch.state === "splitting" ? "warn" : ""}>{inBatch.batch.members.length > 1 ? `Landing ${inBatch.place} of ${inBatch.batch.members.length} in a batch (${inBatch.batch.members.join(", then ")}). ` : "Asked to land. "}{batchWords(state, inBatch.batch, a.id)}</Fact>}
				{refused && <Fact icon="land" tone="bad">It was asked to land and did not. {reason(refused.text)}</Fact>}
				{going && <Fact icon="fork">{a.behind > 0 ? `${plural(a.behind, "landing")} behind trunk: trunk has moved since it forked` : "Up to date with trunk"}</Fact>}
				{going && a.trunkConflicts.length > 0 && <Fact icon="conflict" tone="bad">Would conflict with trunk on {a.trunkConflicts.join(", ")}</Fact>}
				{clash.length > 0 && <Fact icon="conflict" tone="bad">Will conflict with attempt{clash.length === 1 ? "" : "s"} {clash.join(", ")}</Fact>}
				{hostedGoing && <Fact icon="sandbox">Braid is running this agent in a sandbox</Fact>}
				{a.hosted === "failed" && <Fact icon="warning" tone="bad">{neverStarted(a) ? `Braid could not start the agent. ${neverStarted(a)}` : `The agent Braid was running stopped with an error${a.hostedDetail ? `: ${a.hostedDetail}` : ""}`}</Fact>}
			</ul>
			<p className="lc-links"><Link to={`/p/${slug}/i/${a.intentId}?attempt=${encodeURIComponent(a.id)}`}><Icon name="arrow" size={14} />Open the intent</Link></p>
		</>
	);
}

function LandingCard({ state, sha }: { state: State; sha: string }) {
	const slug = state.project.slug;
	const l = state.landings.find((x) => x.sha === sha);
	if (!l) return null;
	const intent = state.intents.find((i) => i.id === l.intentId);
	const a = state.attempts.find((x) => x.id === l.attemptId);
	const recon = state.reconciliations.find((r) => r.attemptId === l.attemptId && r.status === "resolved");
	const undone = l.revertedBy ? state.landings.find((x) => x.sha === l.revertedBy) : null;
	const why = l.files[0] ? `/p/${slug}/why?path=${encodeURIComponent(l.files[0])}` : null;
	return (
		<>
			<p className="lc-kicker">{l.revertOf ? "Taken back out of trunk" : "Landed on trunk"}</p>
			<p className="lc-title"><IntentId id={l.intentId} /><span>{intent?.title ?? l.title}</span></p>
			{/* A revert is recorded under whoever took the landing out, which is not the attempt's agent. */}
			<p className="lc-who">{a && !l.revertOf ? <Agent name={a.agent} kind={a.kind} model={a.model} /> : <strong>{l.agent}</strong>}<span className="lc-dim">{l.revertOf ? `took out attempt ${l.attemptId}'s landing` : `attempt ${l.attemptId}`}</span></p>
			<ul className="lc-facts">
				<Fact icon="clock"><time dateTime={new Date(l.at).toISOString()}>{ago(l.at)}</time> · {when(l.at)}</Fact>
				<Fact icon={l.revertOf ? "undo" : "land"}>Commit <span className="mono">{short(l.sha)}</span>{l.revertOf && <> undoes landing <span className="mono">{short(l.revertOf)}</span>; the intent opened again</>}</Fact>
				{!l.revertOf && l.files.length > 0 && <Fact icon="file"><span className="mono">{l.files.slice(0, 3).join(", ")}</span>{l.files.length > 3 ? ` and ${l.files.length - 3} more` : ""}</Fact>}
				{l.reconciled && <Fact icon="reconcile" tone="warn">Went through a reconciliation{recon ? `, resolved by ${recon.resolvedBy}` : ""}: it collided with trunk and both sides were kept</Fact>}
				{l.revertedBy && <Fact icon="undo" tone="bad">Taken back out{undone ? ` ${ago(undone.at)}` : ""} as <span className="mono">{short(l.revertedBy)}</span></Fact>}
			</ul>
			{l.reconciled && recon?.rationale && <p className="lc-summary"><span className="lc-label">How both intents survive</span>{recon.rationale}</p>}
			<p className="lc-links">
				{why && !l.revertOf && <Link to={why}><Icon name="search" size={14} />See why in the code</Link>}
				<Link to={`/p/${slug}/i/${l.intentId}`}><Icon name="arrow" size={14} />Open the intent</Link>
			</p>
		</>
	);
}

function TieCard({ state, a, b }: { state: State; a: string; b: string }) {
	const slug = state.project.slug;
	const pairs = state.overlaps.filter((o) => (o.a === a && o.b === b) || (o.a === b && o.b === a));
	const sides = [a, b].map((id) => state.attempts.find((x) => x.id === id));
	if (!pairs.length || !sides[0] || !sides[1]) return null;
	const worst = (["conflict", "touch", "claim"] as const).find((s) => pairs.some((o) => o.severity === s))!;
	return (
		<>
			<p className="lc-kicker">Two attempts, {plural(pairs.length, "file")} in common</p>
			<p className="lc-status"><span className={`chip ${worst}`}>{TIE[worst].label}</span></p>
			<p className="lc-summary">{TIE[worst].means}</p>
			<ul className="lc-files">
				{pairs.map((o) => <li key={o.path}><span className="mono">{o.path}</span><span className={`lc-sev ${o.severity}`}>{o.severity === "conflict" ? (o.regions > 0 ? `collides in ${plural(o.regions, "place")}` : "will conflict") : o.severity === "touch" ? "mergeable" : "planned"}</span></li>)}
			</ul>
			<ul className="lc-sides">
				{sides.map((s) => {
					const intent = state.intents.find((i) => i.id === s!.intentId);
					return (
						<li key={s!.id}>
							<Link to={`/p/${slug}/i/${s!.intentId}?attempt=${encodeURIComponent(s!.id)}`}>
								<span className="lc-title small"><IntentId id={s!.intentId} /><span>{intent?.title ?? `Intent ${s!.intentId}`}</span></span>
								<span className="lc-dim">attempt {s!.id} by {s!.agent} · {s!.status}</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</>
	);
}

function CommitCard({ state, commit, start }: { state: State; commit: TrunkCommit | null; start: boolean }) {
	return (
		<>
			<p className="lc-kicker">{start ? "Where trunk started" : "Pushed to trunk outside Braid"}</p>
			{commit && <p className="lc-title"><span>{commit.subject}</span></p>}
			<p className="lc-summary">{start
				? "The commit this project's trunk began with. Lines that are still as they were here belong to no intent, so the Why view has no reason for them."
				: "Someone pushed this straight to trunk with git. It belongs to no intent, so Braid has no goal or decisions for it."}</p>
			{commit && (
				<ul className="lc-facts">
					<Fact icon="agent">{commit.author}</Fact>
					<Fact icon="clock"><time dateTime={new Date(commit.at).toISOString()}>{ago(commit.at)}</time> · {when(commit.at)}</Fact>
					<Fact icon="fork">Commit <span className="mono">{short(commit.sha)}</span></Fact>
				</ul>
			)}
			<p className="lc-links"><Link to={`/p/${state.project.slug}/why`}><Icon name="search" size={14} />Open the Why view</Link></p>
		</>
	);
}

/** One sentence for a screen reader, since the card itself is only a description of the thing in focus. */
export function describe(state: State, t: CardTarget): string {
	if (t.kind === "attempt") {
		const a = state.attempts.find((x) => x.id === t.id);
		if (!a) return "";
		const intent = state.intents.find((i) => i.id === a.intentId);
		return `Attempt ${a.id} at I${a.intentId}, ${intent?.title ?? ""}, by ${a.agent}. ${STATUS[a.status]}. Opens the intent.`;
	}
	if (t.kind === "landing") {
		const l = state.landings.find((x) => x.sha === t.sha);
		if (!l) return "";
		return `${l.revertOf ? "Revert of" : "Landing of"} I${l.intentId}, ${l.title}, by ${l.agent}, ${ago(l.at)}${l.reconciled ? ", through a reconciliation" : ""}${l.revertedBy ? ", later taken back out" : ""}. Opens ${l.revertOf || !l.files[0] ? "the intent" : "its lines in the Why view"}.`;
	}
	if (t.kind === "tie") {
		const pairs = state.overlaps.filter((o) => (o.a === t.a && o.b === t.b) || (o.a === t.b && o.b === t.a));
		const worst = (["conflict", "touch", "claim"] as const).find((s) => pairs.some((o) => o.severity === s)) ?? "claim";
		return `Attempts ${t.a} and ${t.b}: ${TIE[worst].label} on ${pairs.map((o) => o.path).join(", ")}. Opens attempt ${t.a}'s intent.`;
	}
	return t.kind === "start" ? "Where trunk started." : "A commit pushed to trunk outside Braid.";
}

type Anchor = { x: number; top: number; bottom: number };
type Open = { target: CardTarget; key: string; at: Anchor; via: "pointer" | "focus" | "touch"; el: Element };
const rectOf = (el: Element): Anchor => {
	const r = (el.querySelector("[data-anchor]") ?? el).getBoundingClientRect();
	return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
};

/**
 * Cards for one drawing of the loom. `bind(target)` gives the handlers for the thing on the graph; render
 * `card` anywhere (it is drawn on top of the page). `tapped` tells a click handler that the click was a
 * finger's first tap, which shows the card and should not also navigate.
 */
export function useLoomCards(state: State, history: TrunkCommit[] | null = null) {
	const [open, setOpen] = useState<Open | null>(null);
	const [place, setPlace] = useState<CSSProperties | null>(null);
	const timer = useRef<number | undefined>(undefined);
	const live = useRef<Open | null>(null);
	live.current = open;
	const pointer = useRef("mouse");
	const box = useRef<HTMLDivElement>(null);
	const id = useId();
	const narrow = useNarrow();
	const clear = () => window.clearTimeout(timer.current);
	const show = (target: CardTarget, el: Element, at: Anchor, via: Open["via"], wait: number) => {
		clear();
		const key = keyOf(target);
		if (live.current?.key === key) return;
		const go = () => { setPlace(null); setOpen({ target, key, at, via, el }); };
		if (wait) timer.current = window.setTimeout(go, wait); else go();
	};
	const hide = (wait = 0) => { clear(); if (wait) timer.current = window.setTimeout(() => setOpen(null), wait); else setOpen(null); };
	useEffect(() => clear, []);

	/** `point`: anchor the card where the pointer met the thing (a long strand), not at its middle. `hoverOnly`: no focus or touch, for small drawings inside a link. */
	const bind = (target: CardTarget, opts: { point?: boolean; hoverOnly?: boolean } = {}) => {
		const key = keyOf(target);
		const hover = {
			onPointerEnter: (e: PointerEvent<Element>) => {
				if (e.pointerType === "touch") return;
				// Moving from one thing to the next switches quickly; the first card waits long enough not to flash while the pointer passes over.
				show(target, e.currentTarget, opts.point ? { x: e.clientX, top: e.clientY - 6, bottom: e.clientY + 6 } : rectOf(e.currentTarget), "pointer", live.current ? 70 : 160);
			},
			onPointerLeave: (e: PointerEvent<Element>) => { if (e.pointerType !== "touch" && live.current?.via !== "focus") hide(180); else clear(); },
		};
		if (opts.hoverOnly) return hover;
		return {
			...hover,
			"data-loom-target": key,
			"aria-describedby": open?.key === key ? id : undefined,
			onPointerDown: (e: PointerEvent<Element>) => { pointer.current = e.pointerType; },
			onFocus: (e: FocusEvent<Element>) => { if (e.currentTarget.matches(":focus-visible")) show(target, e.currentTarget, rectOf(e.currentTarget), "focus", 0); },
			onBlur: () => { if (live.current?.via === "focus") hide(); },
			onKeyDown: (e: KeyboardEvent<Element>) => { if (e.key === "Escape" && live.current) { e.stopPropagation(); hide(); } },
		};
	};
	const tapped = (e: MouseEvent<Element>, target: CardTarget) => {
		if (pointer.current !== "touch") return false;
		e.preventDefault();
		if (live.current?.key === keyOf(target)) hide(); else show(target, e.currentTarget, rectOf(e.currentTarget), "touch", 0);
		return true;
	};

	const sheet = narrow;
	// Place the card once it has a size: under the thing if there is room, otherwise above, and always inside the window.
	useLayoutEffect(() => {
		if (!open || sheet || !box.current) return;
		const w = box.current.offsetWidth, h = box.current.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight, gap = 12;
		const left = Math.round(Math.min(Math.max(open.at.x - w / 2, 8), Math.max(8, vw - w - 8)));
		const below = open.at.bottom + gap + h <= vh - 8, above = open.at.top - gap - h >= 8;
		setPlace(below || !above ? { left, top: Math.round(Math.min(open.at.bottom + gap, Math.max(8, vh - h - 8))) } : { left, bottom: Math.round(vh - open.at.top + gap) });
	}, [open?.key, open?.at, sheet]);

	useEffect(() => {
		if (!open) return;
		const inCard = (n: EventTarget | null) => n instanceof Node && !!box.current?.contains(n);
		const key = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") hide(); };
		const down = (e: globalThis.PointerEvent) => { if (!inCard(e.target) && !(e.target instanceof Element && e.target.closest("[data-loom-target]"))) hide(); };
		// A card opened by the keyboard follows its thing when the page scrolls it into view; one opened by the pointer is left behind, so it closes.
		const scroll = (e: Event) => {
			if (inCard(e.target)) return;
			const o = live.current;
			if (o?.via === "focus" && o.el.isConnected) setOpen({ ...o, at: rectOf(o.el) }); else if (!sheet) hide();
		};
		const resize = () => hide();
		document.addEventListener("keydown", key);
		document.addEventListener("pointerdown", down);
		window.addEventListener("scroll", scroll, true);
		window.addEventListener("resize", resize);
		return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", down); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize); };
	}, [open?.key, sheet]);

	let body: ReactNode = null;
	if (open) {
		const t = open.target;
		if (t.kind === "attempt") { const a = state.attempts.find((x) => x.id === t.id); body = a ? <AttemptCard state={state} a={a} /> : null; }
		else if (t.kind === "landing") body = state.landings.some((l) => l.sha === t.sha) ? <LandingCard state={state} sha={t.sha} /> : null;
		else if (t.kind === "tie") body = state.overlaps.some((o) => (o.a === t.a && o.b === t.b) || (o.a === t.b && o.b === t.a)) ? <TieCard state={state} a={t.a} b={t.b} /> : null;
		else if (t.kind === "start") body = <CommitCard state={state} commit={history?.find((c) => c.kind === "start") ?? null} start />;
		else body = <CommitCard state={state} commit={history?.find((c) => c.sha === t.sha) ?? null} start={false} />;
	}
	// The thing the card was about is gone (abandoned, or an overlap that no longer holds): close rather than show an empty card.
	const gone = !!open && !body;
	useEffect(() => { if (gone) setOpen(null); }, [gone]);

	const card = open && body ? createPortal(
		<div ref={box} id={id} className={`loom-card ${sheet ? "sheet" : ""}`} role={open.via === "touch" || sheet ? "group" : "tooltip"} aria-label={open.via === "touch" || sheet ? "Details" : undefined}
			style={sheet ? undefined : place ?? { left: 0, top: 0, visibility: "hidden" }}
			onPointerEnter={clear} onPointerLeave={(e) => { if (e.pointerType !== "touch" && open.via === "pointer") hide(180); }}
			onClick={(e) => { if ((e.target as Element).closest("a")) hide(); }}>
			{(sheet || open.via === "touch") && <button className="lc-close quiet" onClick={() => hide()} aria-label="Close details"><Icon name="x" /></button>}
			{body}
		</div>, document.body) : null;

	return { bind, tapped, card, openKey: open?.key ?? null, keyOf };
}
