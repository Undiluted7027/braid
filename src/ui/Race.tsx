// Several agents at one intent, and what they made, side by side. One place to decide which attempt lands:
// the judges' pick and reasons, a column per attempt with what code measured, what the reviewer found and
// what the decision model reads, the pictures, the difference between any two, and the live previews.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Attempt, Comparison, DiffFile, Intent, Judgement, Likelihood, State } from "../shared/types";
import { api, ago, short, useAsync } from "./api";
import { Agent, Link, useAction } from "./App";
import { FileDiff } from "./Diff";
import { Empty } from "./Graphics";
import { ask, Icon, Notice, type IconName } from "./Kit";
import { sentence, useAsked } from "./Later";
import { clashingCriteria } from "./Plan";
import { flagsOf, policyOf, reviewOf } from "./Review";
import { runFor } from "./Verify";

const LIVE = new Set(["working", "ready", "conflicted"]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (ids: string[]) => (ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`);
const pct = (p: number) => `${Math.round(p * 100)}%`;
/** Under this, a citation is marked for a person to look at. */
export const LOW_SUPPORT = 0.5;

export const comparisonOf = (state: State, intentId: number): Comparison | null => (state.comparisons ?? []).find((c) => c.intentId === intentId) ?? null;
export const likelihoodOf = (state: State, a: Attempt): Likelihood | null => (state.likelihoods ?? []).find((l) => l.attemptId === a.id) ?? null;
const shotOf = (state: State, a: Attempt) => (state.shots ?? []).find((s) => s.attemptId === a.id) ?? null;
/** The attempts a comparison is about: everything at the intent that was not abandoned. */
export const racers = (state: State, intentId: number) => state.attempts.filter((a) => a.intentId === intentId && a.status !== "abandoned");
/** An intent is a race once more than one attempt at it has been made, or it has been compared. */
export const isRace = (state: State, intentId: number) => racers(state, intentId).length > 1 || !!comparisonOf(state, intentId);
/** A comparison is about particular commits. Attempts that have moved since make it about older ones. */
const movedSince = (state: State, c: Comparison) => c.attempts.filter((x) => { const a = state.attempts.find((y) => y.id === x.id); return a && LIVE.has(a.status) && a.headSha !== x.sha; }).map((x) => x.id);

/** The outcome of a comparison in a sentence a person can act on. `needs`: it is waiting for a person, and why. */
export function verdictOf(state: State, c: Comparison): { headline: string; detail: string; tone: "pass" | "touch" | "conflict" | "working"; needs: boolean } {
	const answered = c.judges.filter((j) => !j.error), n = c.attempts.length;
	const left = c.left.length ? ` It was compared without ${c.left.length === 1 ? `attempt ${c.left[0]}` : `attempts ${list(c.left)}`}, which ${c.left.length === 1 ? "was" : "were"} still being worked on when the wait ran out.` : "";
	if (c.status === "running") return { headline: `Comparing attempts ${list(c.attempts.map((x) => x.id))} now`, detail: "Each judge reads them side by side, by letter and in a different order, without being told who made which.", tone: "working", needs: false };
	if (c.status === "failed") return { headline: "The attempts could not be compared", detail: sentence(c.error ?? "No reason was recorded"), tone: "conflict", needs: true };
	if (n === 1 && !answered.length) return { headline: `Only attempt ${c.attempts[0].id} was ready, so there was nothing to compare it with`, detail: left.trim(), tone: "touch", needs: false };
	if (c.agreed && c.pick) return { headline: `${answered.length === 2 ? "Both judges" : `All ${answered.length} judges`} picked attempt ${c.pick}`, detail: left.trim(), tone: "pass", needs: false };
	if (c.pick && answered.length === 1) return { headline: `${answered[0].by} recommends attempt ${c.pick}`, detail: `One judge alone does not land an attempt: a person chooses.${left}`, tone: "touch", needs: true };
	if (answered.length && answered.every((j) => !j.pick)) return { headline: answered.length === 1 ? `${answered[0].by} would land none of them` : "The judges would land none of them", detail: `A person decides what happens next.${left}`, tone: "conflict", needs: true };
	return { headline: "The judges did not agree", detail: `${answered.map((j) => `${j.by} picked ${j.pick ? `attempt ${j.pick}` : "none"}`).join("; ")}. A person chooses.${left}`, tone: "touch", needs: true };
}

/** A race Braid is in the middle of: attempts still being waited for, or a comparison running or about to be made again. Its attempts are not each a person's to review yet. */
export function raceUnderWay(state: State, intent: Intent) {
	const c = comparisonOf(state, intent.id);
	return intent.status === "open" && racers(state, intent.id).filter((a) => LIVE.has(a.status)).length > 1 && (!!intent.raceUntil || c?.status === "running" || (!!c && movedSince(state, c).length > 0));
}
/** For the project page: what, if anything, a race is waiting for a person to do, in one line. */
export function raceNeed(state: State, intent: Intent): { label: string; text: string; tone: string; icon: IconName } | null {
	if (intent.status !== "open") return null;
	const c = comparisonOf(state, intent.id), live = racers(state, intent.id).filter((a) => LIVE.has(a.status));
	const veto = live.find((a) => a.heldFor === "signal");
	if (veto) return { label: "pick is doubted", tone: "touch", icon: "question", text: `Attempt ${veto.id} was picked at I${intent.id}, but the decision model is under this project's bar. ${sentence(veto.held)}` };
	if (!c || live.length < 2 && c.status !== "failed") return null;
	if (c.status === "running" || movedSince(state, c).length) return null;
	const v = verdictOf(state, c);
	if (c.status === "failed") return { label: "comparison failed", tone: "conflict", icon: "warning", text: `The ${plural(live.length, "attempt")} at I${intent.id} could not be compared. ${v.detail}` };
	if (v.needs) return { label: c.pick ? "one judge only" : "judges disagree", tone: "touch", icon: "conflict", text: `I${intent.id} “${intent.title}”: ${v.headline}. ${v.detail}` };
	// Agreed. Under a policy that lands by itself Braid acts; otherwise it is a person's to land.
	if (policyOf(state).landing === "auto") return null;
	return c.pick ? { label: "pick ready to land", tone: "ready", icon: "check", text: `I${intent.id} “${intent.title}”: ${v.headline} of ${c.attempts.length}. Nothing lands until you ask.` } : null;
}

/** The decision model's reading of one criterion: a small bar and a number, plainly the lesser reading beside the reviewer's. */
export function LikelyBar({ p, stale }: { p: number; stale?: boolean }) {
	const tone = p >= 0.8 ? "high" : p <= 0.3 ? "low" : "mid";
	return (
		<span className={`likely ${tone} ${stale ? "stale" : ""}`} title={`The decision model finds it ${pct(p)} likely that this criterion is met${stale ? ", for an earlier commit" : ""}. It is a quick signal, not a verdict: it cannot say why, and it is unsure about things a change leaves out.`}>
			<span className="likely-bar" aria-hidden="true"><i style={{ width: pct(p) }} /></span>
			<span className="likely-n">{pct(p)}</span>
		</span>
	);
}

function JudgeText({ judges, pick }: { judges: Judgement[]; pick: (j: Judgement) => string }) {
	const said = judges.map((j) => ({ by: j.by, text: pick(j).trim() })).filter((x) => x.text);
	if (!said.length) return <span className="dim">Nothing noted.</span>;
	// Two judges often say much the same. The first is shown; the others are one click away, not a second wall of text.
	return (
		<>
			<p><span className="race-by">{said[0].by}</span>{said[0].text}</p>
			{said.slice(1).map((s) => <details key={s.by} className="disclose"><summary>{s.by} on the same</summary><p>{s.text}</p></details>)}
		</>
	);
}

/** One attempt set against another: the difference between them, or their live previews side by side. */
function Pair({ state, attempts, first }: { state: State; attempts: Attempt[]; first: [string, string] }) {
	const slug = state.project.slug;
	const [a, setA] = useState(first[0]), [b, setB] = useState(first[1]);
	const [view, setView] = useState<"none" | "diff" | "preview">("none");
	const A = attempts.find((x) => x.id === a), B = attempts.find((x) => x.id === b);
	const { data: diff, error } = useAsync(() => (view === "diff" && A && B && a !== b ? api<DiffFile[]>("GET", `/p/${slug}/attempts/${a}/against/${b}`) : Promise.resolve(null)), [view, a, b, A?.headSha, B?.headSha]);
	const url = (x: Attempt) => { const key = state.previewKeys?.[x.id]; return `/preview/${slug}/${x.id}${key ? `~${key}` : ""}/`; };
	const pick = (value: string, set: (v: string) => void, label: string) => (
		<label className="inline">{label}<select value={value} onChange={(e) => set(e.target.value)}>{attempts.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.agent}</option>)}</select></label>
	);
	return (
		<section className="race-pair" aria-label="Two attempts side by side">
			<div className="race-pair-head">
				<h3>Two attempts, side by side</h3>
				{attempts.length > 2 && <span className="row">{pick(a, setA, "Attempt")}{pick(b, setB, "against")}</span>}
				<span className="row race-pair-views" role="group" aria-label="What to show">
					<button aria-pressed={view === "diff"} onClick={() => setView(view === "diff" ? "none" : "diff")}><Icon name="changes" />What {a} does differently from {b}</button>
					<button aria-pressed={view === "preview"} onClick={() => setView(view === "preview" ? "none" : "preview")}><Icon name="eye" />Live previews</button>
				</span>
			</div>
			{a === b && view !== "none" && <p className="dim">Pick two different attempts.</p>}
			{view === "diff" && a !== b && <>
				<p className="panel-lede">Attempt {b}'s version of each file is the starting point; green lines are what attempt {a} has instead or in addition. Files neither changed are left out.</p>
				{error && <Notice small>{error}</Notice>}
				{!diff && !error && <Empty kind="loading" title="Loading the difference…" />}
				{diff?.length === 0 && <Empty title="No difference"><p>The two attempts leave every file the same.</p></Empty>}
				{diff?.map((f) => <FileDiff key={`${a}-${b}-${f.path}`} file={f} open={diff.length <= 4} />)}
			</>}
			{view === "preview" && a !== b && A && B && (
				<div className="race-previews">
					{[A, B].map((x) => (
						<figure key={x.id}>
							<figcaption><Agent name={x.agent} kind={x.kind} model={x.model} /><span className="mono dim">{x.id}</span><span className="spacer" /><a className="button" href={url(x)} target="_blank" rel="noreferrer"><Icon name="external" />Open</a></figcaption>
							<iframe className="preview" src={url(x)} title={`Preview of attempt ${x.id}`} sandbox="allow-scripts allow-forms allow-modals" />
						</figure>
					))}
				</div>
			)}
		</section>
	);
}

/** Sending an attempt back with a note, started from something a judge said. */
function SendBack({ state, a, body: initial, close }: { state: State; a: Attempt; body: string; close: () => void }) {
	const [body, setBody] = useState(initial);
	const act = useAction();
	const running = a.hosted === "starting" || a.hosted === "running";
	const canStart = !running && (a.kind === "claude" || a.kind === "codex") && state.project.hosting[a.kind === "codex" ? "codex" : "claude"];
	const send = () => act.run(async () => { await api("POST", `/p/${state.project.slug}/attempts/${a.id}/respond`, { kind: "feedback", body, by: "human", bringBack: canStart }); close(); });
	return (
		<div className="panel decide form race-send">
			<h3>Send attempt {a.id} back to {a.agent}</h3>
			<label>What it should change<textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} autoFocus /></label>
			<p className="hint">The attempt returns to working and your note is kept with its decisions.{canStart ? ` ${a.agent} is started again in a sandbox to act on it.` : ""} It is compared again once it is ready.</p>
			{act.error && <Notice small>{act.error}</Notice>}
			<div className="row"><button className="primary" disabled={act.busy || !body.trim()} onClick={send}><Icon name="undo" />{act.busy ? "Sending…" : "Send back for changes"}</button><button onClick={close}>Cancel</button></div>
		</div>
	);
}

/** The whole comparison for one intent. */
export function RaceView({ state, intent }: { state: State; intent: Intent }) {
	const slug = state.project.slug, policy = policyOf(state);
	const attempts = racers(state, intent.id).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
	const c = comparisonOf(state, intent.id);
	const live = attempts.filter((a) => LIVE.has(a.status)), ready = live.filter((a) => a.status === "ready"), working = live.filter((a) => a.status === "working");
	const landed = attempts.find((a) => a.status === "landed");
	const open = intent.status === "open", canAct = !state.viewer && open;
	const act = useAction(), land = useAction();
	const [landAsked, setLandAsked] = useState<string | null>(null);
	const [note, setNote] = useState<{ id: string; body: string } | null>(null);
	const [big, setBig] = useState<string | null>(null);
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => { if (big && !dialog.current?.open) dialog.current?.showModal(); }, [big]);
	// Asking for a comparison only starts it; it then shows as running, or a newer one replaces this one.
	const asked = useAsked(c?.status === "running", c?.id, 60_000);
	const stale = c && c.status === "done" ? movedSince(state, c) : [];
	const v = c ? verdictOf(state, c) : null;
	const judges = c?.status === "done" ? c.judges.filter((j) => !j.error) : [];
	const failedJudges = c?.status === "done" ? c.judges.filter((j) => j.error) : [];
	const veto = live.find((a) => a.heldFor === "signal");
	const chosen = landed ? state.decisions.find((d) => d.attemptId === landed.id && d.agent === "braid" && /^Chosen over/i.test(d.title)) : undefined;
	const clash = clashingCriteria(state, intent.id);
	const criteria = intent.criteria ?? [];

	const again = () => act.run(async () => {
		const n = Math.max(1, (policy.reviewers ?? []).length);
		if (await ask({ title: "Compare the ready attempts again?", body: <p>{n === 1 ? "The judge reads" : `Each of the ${n} judges reads`} every ready attempt in full, as it stands now. That is {plural(n, "large call")} to a model, which this instance pays for.</p>, confirm: "Compare again" }) === null) return;
		await api("POST", `/p/${slug}/intents/${intent.id}/compare`, {});
		asked.mark();
	});
	const landIt = (a: Attempt) => land.run(async () => {
		const others = live.filter((x) => x.id !== a.id).map((x) => x.id);
		const notPick = c?.pick && c.pick !== a.id && !stale.length;
		if (await ask({ title: `Land attempt ${a.id}?`, body: <p>{notPick ? `The judges picked attempt ${c!.pick}, not this one. ` : ""}{others.length ? `Landing it sets aside ${others.length === 1 ? `attempt ${others[0]}` : `attempts ${list(others)}`}: only one attempt lands for an intent.` : "It goes onto trunk once its merge has been checked."}</p>, confirm: `Land attempt ${a.id}`, danger: !!notPick }) === null) return;
		try { await api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human", sha: a.headSha }); } catch (e) {
			if (!/with force/.test((e as Error).message)) throw e;
			if (await ask({ title: "Land it without a passing run?", body: <p>{sentence((e as Error).message.replace(/[.;,]?\s*(?:run the verification again, or )?land it anyway with force\.?$/i, ""))}</p>, confirm: "Land it anyway", danger: true }) === null) throw e;
			await api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human", force: true, sha: a.headSha });
		}
		setLandAsked(a.id);
	});
	const go = (id: string) => document.getElementById(`attempt-${id}`)?.scrollIntoView({ block: "start" });
	const canCompare = canAct && ready.length >= 2 && c?.status !== "running";
	const compareButton = canCompare && <button disabled={act.busy || asked.pending} onClick={again}><Icon name={asked.pending ? "running" : "undo"} className={asked.pending ? "spin" : ""} />{asked.pending ? "Comparison asked for…" : c ? "Compare again" : "Compare now"}</button>;

	// ---- what is going on, said once at the top
	let top: ReactNode;
	if (landed) {
		const over = attempts.filter((a) => a.id !== landed.id).map((a) => a.id);
		top = <div className="race-top landed"><span className="chip landed">landed</span><div><h3>Attempt {landed.id} landed{over.length ? `, chosen over ${over.length === 1 ? `attempt ${over[0]}` : `attempts ${list(over)}`}` : ""}</h3>{chosen ? <p>{chosen.body}</p> : <p className="dim">A person landed it; no reason was recorded beyond the comparison below.</p>}<p className="dim">The other{over.length === 1 ? " attempt is" : " attempts are"} still below, to read.</p></div></div>;
	} else if (c?.status === "running" || asked.pending) {
		top = <div className="race-top running" role="status"><span className="chip working">comparing</span><div><h3>{c?.status === "running" ? v!.headline : "Comparison asked for"}</h3><p>{c?.status === "running" ? v!.detail : "The judges start in a moment."} {(policy.reviewers ?? []).length ? `The judges are ${list(policy.reviewers)}.` : ""} What code measured is already below.</p></div></div>;
	} else if (c && !stale.length) {
		const pick = c.pick ? attempts.find((a) => a.id === c.pick) : undefined;
		top = (
			<div className={`race-top ${v!.tone}`}>
				<span className={`chip ${v!.tone}`}>{c.status === "failed" ? "not compared" : c.agreed ? "judges agree" : c.pick ? "one judge" : "no pick"}</span>
				<div>
					<h3>{v!.headline}</h3>
					{v!.detail && <p>{v!.detail}</p>}
					{veto && <p className="race-veto"><Icon name="question" size={14} /><span><strong>The decision model is not convinced.</strong> {sentence(veto.held)} It can only stop a landing, never cause one: a person decides.</span></p>}
					{c.status === "done" && policy.landing === "auto" && c.agreed && !veto && pick && LIVE.has(pick.status) && <p className="dim">This project lands the pick by itself once nothing else holds it back.</p>}
					{failedJudges.map((j) => <p key={j.by} className="dim">{j.by} could not judge: {sentence(j.error ?? "")}</p>)}
					<p className="race-when">Compared {ago(c.finishedAt ?? c.at)}{judges.length ? ` by ${list(judges.map((j) => j.by))}` : ""}.</p>
				</div>
				{canAct && <div className="race-acts">
					{pick && LIVE.has(pick.status) && pick.status !== "conflicted" && <button className="primary" disabled={land.busy || !!landAsked || state.queue.some((q) => q.attemptId === pick.id)} onClick={() => landIt(pick)}><Icon name="land" />{landAsked === pick.id || state.queue.some((q) => q.attemptId === pick.id) ? "Waiting to land" : `Land attempt ${pick.id}`}</button>}
					{compareButton}
				</div>}
			</div>
		);
	} else if (stale.length) {
		top = <div className="race-top touch"><span className="chip quiet">out of date</span><div><h3>The comparison below is about earlier commits</h3><p>Attempt{stale.length === 1 ? "" : "s"} {list(stale)} {stale.length === 1 ? "has" : "have"} moved since. {policy.review ? "The attempts are compared again once the ones being worked on are ready." : "Ask for a new comparison when they are ready."}</p></div>{canAct && <div className="race-acts">{compareButton}</div>}</div>;
	} else {
		const until = intent.raceUntil;
		top = (
			<div className="race-top racing" role="status">
				<span className="chip working">racing</span>
				<div>
					<h3>{working.length ? `${ready.length ? `${ready.length} ready, ` : ""}${working.length} still being worked on` : ready.length >= 2 ? `${ready.length} attempts are ready and have not been compared` : "Waiting for a second attempt to be ready"}</h3>
					<p>{ready.length ? `Ready: ${list(ready.map((a) => a.id))}. ` : ""}{working.length ? `Being worked on: ${list(working.map((a) => a.id))}. ` : ""}{until ? `The ready ${ready.length === 1 ? "one is" : "ones are"} compared at ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} whether or not the rest are ready, or sooner if they all are.` : working.length ? `They are compared when all are ready, or ${policy.race?.wait ?? 30} minutes after the first one is.` : ""}</p>
					<p className="dim">The agents cannot see each other's work. A person's answers and edits to the intent go to all of them.{policy.signal ? " The decision model's numbers below move with every push." : ""}</p>
				</div>
				{canAct && <div className="race-acts">{compareButton}</div>}
			</div>
		);
	}
	const facts = (id: string) => (c && !stale.includes(id) ? c.facts.find((f) => f.attemptId === id) : undefined);

	return (
		<section className="race" id="compare" aria-labelledby="race-h">
			<div className="race-head">
				<h2 id="race-h">Compare the {plural(attempts.length, "attempt")}</h2>
				<p className="dim">One column per attempt. Decide here which one lands; each attempt in full is further down.</p>
			</div>
			<div className="panel decide race-panel">
				{top}
				{act.error && <Notice small>{act.error}</Notice>}
				{land.error && <Notice small>{land.error}</Notice>}
				{landAsked && <p className="sent" role="status"><Icon name="check" />Landing of attempt {landAsked} asked for. How it goes shows on that attempt, below.</p>}

				{judges.length > 0 && !stale.length && (
					<div className="race-judges">
						<div><h4 className="label">Why</h4><JudgeText judges={judges} pick={(j) => j.why} /></div>
						<div><h4 className="label">How the approaches differ</h4><JudgeText judges={judges} pick={(j) => j.differences} /></div>
					</div>
				)}

				<div className="race-scroll" tabIndex={0} role="group" aria-label="Attempts compared, scrollable">
					<table className={`race-table n${Math.min(attempts.length, 4)}`}>
						<thead>
							<tr>
								<th scope="col"><span className="sr-only">What is compared</span></th>
								{attempts.map((a) => {
									const shot = shotOf(state, a), picked = c?.status === "done" && c.pick === a.id && !stale.length;
									return (
										<th key={a.id} scope="col" className={`${picked ? "picked" : ""} ${a.status}`}>
											<div className="race-col">
												<div className="race-who"><Agent name={a.agent} kind={a.kind} model={a.model} /><span className="mono dim">attempt {a.id}</span></div>
												<div className="race-tags"><span className={`chip ${a.status}`}>{a.status}</span>{picked && <span className="chip pass"><Icon name="check" size={12} />{c!.agreed ? "the judges' pick" : "recommended"}</span>}{c?.left.includes(a.id) && !stale.length && <span className="chip quiet">not compared</span>}</div>
												{shot ? <button className="race-shot" onClick={() => setBig(a.id)} aria-label={`Picture of attempt ${a.id}, open larger`}><img src={`/api/p/${slug}/attempts/${a.id}/shot?v=${shot.at}`} alt={`Attempt ${a.id}'s page as it looked at commit ${short(shot.sha)}`} loading="lazy" />{shot.sha !== a.headSha && <span className="race-shot-old">earlier commit</span>}</button>
													: policy.shots ? <span className="race-noshot">No picture: this attempt has no preview to take one of.</span> : null}
												<div className="race-col-acts">
													<button onClick={() => go(a.id)}><Icon name="arrow" />Open</button>
													{canAct && a.status === "ready" && !picked && a.headSha !== a.baseSha && <button disabled={land.busy || !!landAsked} onClick={() => landIt(a)}><Icon name="land" />Land this one</button>}
												</div>
											</div>
										</th>
									);
								})}
							</tr>
						</thead>
						<tbody>
							{criteria.map((text, i) => (
								<tr key={`c${i}`}>
									<th scope="row" className={clash.has(i + 1) ? "clashing" : ""}><span className="crit-n">{i + 1}</span>{text}{clash.has(i + 1) && <span className="chip conflict crit-clash"><Icon name="conflict" size={12} />clashes with {[...new Set(clash.get(i + 1))].map((o) => `I${o}`).join(", ")}</span>}</th>
									{attempts.map((a) => {
										const r = reviewOf(state, a), cv = r?.status === "done" ? r.criteria[i] : undefined, l = likelihoodOf(state, a), p = l?.criteria[i]?.p;
										const old = !!r && r.sha !== a.headSha;
										return (
											<td key={a.id} className={cv ? (cv.verdict === "met" ? "good" : cv.verdict === "not_met" ? "bad" : "warn") : "none"}>
												{cv ? <><span className={`crit-cell ${old ? "old" : ""}`}><Icon name={cv.verdict === "met" ? "check" : cv.verdict === "not_met" ? "x" : "question"} size={14} />{cv.verdict === "met" ? "Met" : cv.verdict === "not_met" ? "Not met" : "Not shown"}</span>{cv.why && <p className="race-why">{cv.why}</p>}{old && <p className="race-note">The review is of an earlier commit.</p>}</>
													: <span className="crit-cell dim">{r?.status === "running" ? "being reviewed" : r?.status === "failed" ? "review failed" : "not reviewed"}</span>}
												{p !== undefined && <p className="race-signal"><span>Decision model</span><LikelyBar p={p} stale={l!.sha !== a.headSha} /></p>}
												{l && !l.criteria.length && i === 0 && <p className="race-note">The decision model could not read this commit.</p>}
											</td>
										);
									})}
								</tr>
							))}
							<tr>
								<th scope="row">Checks</th>
								{attempts.map((a) => { const run = runFor(state, a.id), f = facts(a.id), st = run && run.sha === a.headSha ? run.status : f?.checks ?? (a.headSha === a.baseSha ? "none" : "queued"); return <td key={a.id}><span className={`crit-cell ${st === "pass" ? "good-t" : st === "fail" || st === "error" ? "bad-t" : "dim"}`}><Icon name={st === "pass" ? "check" : st === "fail" || st === "error" ? "x" : "clock"} size={14} />{st === "pass" ? "passed" : st === "fail" ? "failed" : st === "error" ? "could not run" : st === "none" ? "nothing to run" : st}</span>{f?.checkMs ? <span className="race-note"> in {(f.checkMs / 1000).toFixed(1)} s</span> : null}</td>; })}
							</tr>
							<tr>
								<th scope="row">Flagged by Braid</th>
								{attempts.map((a) => { const n = flagsOf(a).length; return <td key={a.id}>{n ? <><span className="chip flagged"><Icon name="warning" size={12} />{plural(n, "flag")}</span><p className="race-note">{sentence(flagsOf(a)[0].text)}</p></> : <span className="dim">nothing</span>}</td>; })}
							</tr>
							<tr>
								<th scope="row">Size of the change</th>
								{attempts.map((a) => { const f = facts(a.id); return <td key={a.id}>{plural(f?.files ?? a.files.length, "file")}{f ? <span className="mono race-lines"> <span className="adds">+{f.added}</span> <span className="dels">−{f.removed}</span></span> : null}</td>; })}
							</tr>
							<tr>
								<th scope="row">Files only it touched</th>
								{attempts.map((a) => { const f = facts(a.id); return <td key={a.id}>{f ? (f.only.length ? <span className="mono race-files">{f.only.join(", ")}</span> : <span className="dim">none</span>) : <span className="dim">known once compared</span>}</td>; })}
							</tr>
							<tr>
								<th scope="row">Time to ready</th>
								{attempts.map((a) => { const f = facts(a.id), m = f?.minutes ?? (a.readyAt ? Math.round((a.readyAt - a.createdAt) / 60000) : null); return <td key={a.id}>{m === null ? <span className="dim">{a.status === "working" ? "still working" : "not recorded"}</span> : m < 1 ? "under a minute" : plural(m, "minute")}</td>; })}
							</tr>
							{attempts.some((a) => LIVE.has(a.status) && (a.behind > 0 || a.trunkConflicts.length > 0)) && (
								<tr>
									<th scope="row">Against trunk</th>
									{attempts.map((a) => <td key={a.id}>{!LIVE.has(a.status) ? <span className="dim">—</span> : a.trunkConflicts.length ? <span className="bad-text">would conflict on {a.trunkConflicts.join(", ")}</span> : a.behind ? `${plural(a.behind, "landing")} behind` : "up to date"}</td>)}
								</tr>
							)}
							{judges.length > 0 && !stale.length && (["strengths", "weaknesses", "keep"] as const).map((k) => (
								<tr key={k} className="race-judged">
									<th scope="row">{k === "strengths" ? "Strengths" : k === "weaknesses" ? "Weaknesses" : "Worth keeping"}<span className="race-note">{k === "keep" ? "Something in it worth carrying over even if it does not land." : "As the judges saw it."}</span></th>
									{attempts.map((a) => {
										const mine = judges.filter((j) => j.attempts.some((x) => x.id === a.id));
										const first = mine.map((j) => j.attempts.find((x) => x.id === a.id)![k]).find((t) => t.trim()) ?? "";
										const target = k === "keep" && c?.pick && c.pick !== a.id ? attempts.find((x) => x.id === c.pick) : a;
										return (
											<td key={a.id}>
												{mine.length ? <JudgeText judges={mine} pick={(j) => j.attempts.find((x) => x.id === a.id)![k]} /> : <span className="dim">Not compared.</span>}
												{canAct && first && k !== "strengths" && target && LIVE.has(target.status) && (
													<button className="link race-sendback" onClick={() => setNote({ id: target.id, body: k === "keep" ? `Worth carrying over from attempt ${a.id}: ${first}` : first })}>{k === "keep" && target.id !== a.id ? `Ask attempt ${target.id} to take this in` : `Send attempt ${a.id} back with this`}</button>
												)}
											</td>
										);
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{note && attempts.find((a) => a.id === note.id) && <SendBack key={`${note.id}:${note.body}`} state={state} a={attempts.find((a) => a.id === note.id)!} body={note.body} close={() => setNote(null)} />}
				{attempts.length >= 2 && <Pair state={state} attempts={attempts} first={[c?.pick && attempts.some((a) => a.id === c.pick) ? c.pick : attempts[0].id, attempts.find((a) => a.id !== (c?.pick ?? attempts[0].id))!.id]} />}
				<p className="race-foot">What code measured (checks, size, files, time) is fact. The reviewer's verdicts and the judges' reasons are models' readings. The decision model is a quick second signal that can only hold a landing back.</p>
			</div>
			<dialog ref={dialog} className="dialog race-big" onClose={() => setBig(null)} onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }} aria-label="Picture, larger">
				{big && (() => {
					const withShots = attempts.filter((a) => shotOf(state, a)), at = withShots.findIndex((a) => a.id === big), a = withShots[at], shot = a && shotOf(state, a);
					if (!a || !shot) return null;
					return <>
						<div className="race-big-head"><Agent name={a.agent} kind={a.kind} model={a.model} /><span className="mono dim">attempt {a.id} at {short(shot.sha)}</span><span className="spacer" />
							{withShots.length > 1 && <><button onClick={() => setBig(withShots[(at - 1 + withShots.length) % withShots.length].id)} aria-label="Previous attempt's picture"><Icon name="back" /></button><button onClick={() => setBig(withShots[(at + 1) % withShots.length].id)} aria-label="Next attempt's picture"><Icon name="arrow" /></button></>}
							<button onClick={() => dialog.current?.close()} autoFocus><Icon name="x" />Close</button></div>
						<img src={`/api/p/${slug}/attempts/${a.id}/shot?v=${shot.at}`} alt={`Attempt ${a.id}'s page as it looked at commit ${short(shot.sha)}`} />
					</>;
				})()}
			</dialog>
		</section>
	);
}

/** On an attempt that is one of several at its intent: say so, and lead to the comparison. */
export function OneOfSeveral({ state, a }: { state: State; a: Attempt }) {
	const others = racers(state, a.intentId).filter((x) => x.id !== a.id);
	if (!others.length) return null;
	const c = comparisonOf(state, a.intentId), compared = c?.status === "done" && c.attempts.some((x) => x.id === a.id && x.sha === a.headSha);
	return (
		<p className="one-of">
			<Icon name="strands" size={14} />
			<span>One of {others.length + 1} attempts at this intent{compared && c!.pick ? (c!.pick === a.id ? (c!.agreed ? ", and the judges' pick" : ", and the one recommended") : `; the judges ${c!.agreed ? "picked" : "leaned to"} attempt ${c!.pick}`) : ""}. <a href="#compare">See them compared</a></span>
		</p>
	);
}

/** The line-up for a race: which agents, on which models, with a way to change it before starting. */
export function StartRace({ state, intentId }: { state: State; intentId: number }) {
	const policy = policyOf(state), hosting = state.project.hosting, slug = state.project.slug;
	const [agents, setAgents] = useState<{ kind: "claude" | "codex"; model: string }[]>(() => (policy.race?.agents?.length ? policy.race.agents : [{ kind: "claude" as const, model: null }, { kind: "codex" as const, model: null }]).map((x) => ({ kind: x.kind, model: x.model ?? "" })));
	const act = useAction();
	const [started, setStarted] = useState(0);
	const set = (i: number, patch: Partial<{ kind: "claude" | "codex"; model: string }>) => setAgents(agents.map((x, j) => (j === i ? { ...x, ...patch } : x)));
	const going = racers(state, intentId).filter((a) => LIVE.has(a.status)).length;
	const missing = agents.some((x) => !hosting[x.kind === "codex" ? "codex" : "claude"]);
	const start = () => act.run(async () => {
		if (await ask({ title: `Start ${plural(agents.length, "agent")} on this intent?`, body: <p>Each runs in its own sandbox on Cloudflare with its own model session, all paid for by this instance: {plural(agents.length, "sandbox", "sandboxes")} and {plural(agents.length, "session")}. They cannot see each other's work. When they are ready, or {policy.race?.wait ?? 30} minutes after the first one is, they are compared.</p>, confirm: `Start ${plural(agents.length, "agent")}` }) === null) return;
		setStarted(0);
		await api("POST", `/p/${slug}/intents/${intentId}/race`, { agents: agents.map((x) => ({ kind: x.kind, ...(x.model.trim() ? { model: x.model.trim() } : {}) })), by: "human" });
		setStarted(agents.length);
	});
	return (
		<div className="join-way race-start">
			<h4><Icon name="strands" />Race several agents</h4>
			<p className="dim">Start more than one at once, each on its own fork and blind to the others, and have Braid compare what they make. The line-up below is this project's; change it for this race if you like.</p>
			<ul className="lineup">
				{agents.map((x, i) => (
					<li key={i}>
						<label className="inline"><span className="sr-only">Agent {i + 1}</span><select value={x.kind} onChange={(e) => set(i, { kind: e.target.value as "claude" | "codex" })}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
						<label className="inline lineup-model"><span className="sr-only">Model for agent {i + 1}</span><input value={x.model} onChange={(e) => set(i, { model: e.target.value })} placeholder="its usual model" spellCheck={false} autoComplete="off" /></label>
						<button className="quiet" onClick={() => setAgents(agents.filter((_, j) => j !== i))} disabled={agents.length <= 1} aria-label={`Remove agent ${i + 1}`}><Icon name="x" /></button>
					</li>
				))}
			</ul>
			<div className="row">
				<button onClick={() => setAgents([...agents, { kind: agents.length % 2 ? "codex" : "claude", model: "" }])} disabled={agents.length >= 6}><Icon name="plus" />Add an agent</button>
				<button className="primary" disabled={act.busy || missing || agents.length + going < 2} onClick={start}>{act.busy ? "Asking…" : `Start ${plural(agents.length, "agent")}`}</button>
			</div>
			<p className="hint">{missing ? "This instance has no credentials for one of these agents, so the race cannot start." : agents.length + going < 2 ? "A race needs at least two attempts going." : `That is ${plural(agents.length, "sandbox", "sandboxes")} and ${plural(agents.length, "model session")}${going ? `, beside the ${plural(going, "attempt")} already going` : ""}. Leave a model blank for the agent's usual one.`}</p>
			{act.error && <Notice>{sentence(act.error)}</Notice>}
			{started > 0 && !act.busy && <p className="sent" role="status"><Icon name="check" />{plural(started, "attempt")} made and their sandboxes are starting. They are listed with this intent's attempts.</p>}
		</div>
	);
}

/** On an intent in a list: that it is a race, and where it stands, in a line. */
export function RaceLine({ state, intent }: { state: State; intent: Intent }) {
	if (!isRace(state, intent.id)) return null;
	const all = racers(state, intent.id), c = comparisonOf(state, intent.id), live = all.filter((a) => LIVE.has(a.status));
	const landed = all.find((a) => a.status === "landed");
	const v = c ? verdictOf(state, c) : null, stale = c?.status === "done" && movedSince(state, c).length > 0;
	const text = landed ? `Attempt ${landed.id} landed${all.length > 1 ? `, chosen over ${list(all.filter((a) => a.id !== landed.id).map((a) => a.id))}` : ""}.`
		: c && !stale ? `${v!.headline}.`
		: `${plural(live.filter((a) => a.status === "ready").length, "attempt")} ready, ${live.filter((a) => a.status === "working").length} still being worked on${intent.raceUntil ? `; compared at ${new Date(intent.raceUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} at the latest` : ""}.`;
	return (
		<p className="race-line">
			<span className="chip quiet"><Icon name="strands" size={12} />race of {all.length}</span>
			<span>{text}</span>
			<Link to={`/p/${state.project.slug}/i/${intent.id}#compare`}>Compare them</Link>
		</p>
	);
}
