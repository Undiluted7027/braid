import { useEffect, useState } from "react";
import type { Attempt, Conflict, Decision, DiffFile, Reconciliation, State } from "../shared/types";
import { api, ago, intentColor, short, useAsync } from "./api";
import { Link, useAction } from "./App";
import { FileDiff } from "./Diff";
import { JoinCommand } from "./Project";
import { Session } from "./Session";

const LIVE = new Set(["working", "ready", "conflicted"]);
const touches = (d: Decision, path: string) => d.files.some((f) => f === path || path.startsWith(f.replace(/\/?\*?$/, "") + "/"));

export function Why({ decisions, empty = "No decisions recorded." }: { decisions: Decision[]; empty?: string }) {
	if (!decisions.length) return <p className="dim small">{empty}</p>;
	return (
		<ul className="why">
			{decisions.map((d) => (
				<li key={d.id}>
					<span className={`kind ${d.kind}`}>{d.kind}</span>
					<div>
						<strong>{d.title}</strong>
						{d.body && <p>{d.body}</p>}
						{d.files.length > 0 && <p className="mono dim small">{d.files.join("  ")}</p>}
					</div>
				</li>
			))}
		</ul>
	);
}

function ConflictView({ c, value, onChange, attemptWhy, attempt }: { c: Conflict; value: string; onChange: (v: string) => void; attemptWhy: Decision[]; attempt: Attempt }) {
	return (
		<div className="conflict-block">
			<h3 className="mono">{c.path}</h3>
			{c.kind === "delete" ? <p className="error">One side deleted this file and the other edited it. Merge trunk into the attempt with git instead (the agent's <code>sync</code> tool).</p> : <>
				<div className="sides">
					<div className="side">
						<h4>On trunk</h4>
						{c.trunkWhy.map((w) => (
							<div key={w.intentId} className="side-why">
								<p><span className="mono" style={{ color: intentColor(w.intentId) }}>I{w.intentId}</span> <strong>{w.title}</strong> <span className="dim">by {w.agent}</span></p>
								<p className="goal">{w.goal}</p>
								<Why decisions={w.decisions} />
							</div>
						))}
						{c.trunkWhy.length === 0 && <p className="dim small">Changed on trunk outside Braid.</p>}
					</div>
					<div className="side">
						<h4>In attempt {attempt.id}</h4>
						<div className="side-why">
							<p><span className="mono" style={{ color: intentColor(attempt.intentId) }}>I{attempt.intentId}</span> <span className="dim">by {attempt.agent}</span></p>
							<Why decisions={attemptWhy} />
						</div>
					</div>
				</div>
				{c.regions.map((r, i) => (
					<div className="sides region" key={i}>
						<pre className="mono"><span className="dim">trunk, line {r.oursLine}</span>{"\n"}{r.ours || "(nothing)"}</pre>
						<pre className="mono"><span className="dim">attempt</span>{"\n"}{r.theirs || "(nothing)"}</pre>
					</div>
				))}
				<label className="editor">
					<span className="row"><strong>Reconciled file</strong><span className="spacer" />
						<button type="button" onClick={() => onChange(c.trunk ?? "")}>Start from trunk</button>
						<button type="button" onClick={() => onChange(c.attempt ?? "")}>Start from attempt</button></span>
					<textarea className="mono" value={value} onChange={(e) => onChange(e.target.value)} rows={14} spellCheck={false} />
				</label>
			</>}
		</div>
	);
}

function ReconPanel({ r, state }: { r: Reconciliation; state: State }) {
	const attempt = state.attempts.find((a) => a.id === r.attemptId)!;
	const mine = state.decisions.filter((d) => d.attemptId === r.attemptId);
	const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(r.conflicts.map((c) => [c.path, c.trunk ?? ""])));
	const [rationale, setRationale] = useState("");
	const act = useAction();
	const base = `/p/${state.project.slug}/reconciliations/${r.id}`;

	if (r.status === "resolved") {
		return (
			<section className="card recon resolved">
				<h2>⚯ Reconciliation R{r.id} <span className="chip landed">resolved by {r.resolvedBy}</span></h2>
				<p>{r.rationale}</p>
				<p className="mono dim small">{r.conflicts.map((c) => c.path).join("  ")}</p>
			</section>
		);
	}
	return (
		<section className="card recon">
			<h2>⚯ Reconciliation R{r.id}: attempt {r.attemptId} against trunk {short(r.trunkSha)}</h2>
			<p className="lede">Git could not merge these lines. Each side is shown with the intent it served and the decisions behind it. The resolution has to keep both.</p>
			{r.conflicts.map((c) => (
				<ConflictView key={c.path} c={c} attempt={attempt} value={text[c.path] ?? ""} onChange={(v) => setText({ ...text, [c.path]: v })}
					attemptWhy={mine.filter((d) => touches(d, c.path)).length ? mine.filter((d) => touches(d, c.path)) : mine} />
			))}
			<label>How both intents survive (recorded in the landing commit)
				<textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} placeholder="Kept I2's save-after-render and registered the theme toggle before load, so…" />
			</label>
			{act.error && <p className="error">{act.error}</p>}
			<div className="row">
				<button className="primary" disabled={act.busy || r.status === "resolving"}
					onClick={() => act.run(() => api("POST", `${base}/resolve`, { by: "human", rationale, resolutions: r.conflicts.map((c) => ({ path: c.path, content: text[c.path] })) }))}>
					Land this resolution
				</button>
				{state.project.llm && (
					<button disabled={act.busy || r.status === "resolving"} onClick={() => act.run(() => api("POST", `${base}/auto`))}>
						{act.busy || r.status === "resolving" ? "Reconciling…" : `Reconcile with ${state.project.llm}`}
					</button>
				)}
				<span className="dim small">The agent on attempt {r.attemptId} can also answer through its <code>reconciliation</code> and <code>resolve</code> tools, or by merging trunk with git.</span>
			</div>
		</section>
	);
}

function AttemptColumn({ a, state, canLand }: { a: Attempt; state: State; canLand: boolean }) {
	const slug = state.project.slug;
	const { data: diff } = useAsync(() => api<DiffFile[]>("GET", `/p/${slug}/attempts/${a.id}/diff`), [a.id, a.headSha, a.baseSha]);
	const decisions = state.decisions.filter((d) => d.attemptId === a.id);
	const [preview, setPreview] = useState(false);
	const [showSession, setShowSession] = useState(true);
	const [frame, setFrame] = useState(0);
	useEffect(() => setFrame((f) => f + 1), [a.headSha]);
	const land = useAction(), drop = useAction();
	const byId = new Map(state.attempts.map((x) => [x.id, x]));
	const collisions = state.overlaps.filter((o) => o.a === a.id || o.b === a.id).map((o) => ({ ...o, other: byId.get(o.a === a.id ? o.b : o.a)! })).filter((o) => o.other);

	return (
		<section className={`card attempt ${a.status}`}>
			<div className="row">
				<h2>{a.agent} <span className="mono dim">{a.id}</span></h2>
				<span className={`chip ${a.status}`}>{a.status}</span>
				<span className="spacer" />
				{LIVE.has(a.status) && <button disabled={drop.busy} onClick={() => drop.run(() => api("POST", `/p/${slug}/attempts/${a.id}/abandon`, {}))}>Abandon</button>}
				{canLand && LIVE.has(a.status) && (
					<button className="primary" disabled={land.busy || a.headSha === a.baseSha} onClick={() => land.run(() => api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human" }))}>
						{land.busy ? "Landing…" : "Land this"}
					</button>
				)}
			</div>
			{(land.error || drop.error) && <p className="error">{land.error ?? drop.error}</p>}
			<p className="small dim mono">base {short(a.baseSha)} → head {short(a.headSha)} · updated {ago(a.updatedAt)}{a.behind > 0 && LIVE.has(a.status) ? ` · ${a.behind} landing${a.behind === 1 ? "" : "s"} behind trunk` : ""}</p>
			{a.summary && <p>{a.summary}</p>}

			{LIVE.has(a.status) && a.trunkConflicts.length > 0 && <p className="warn">Landing now would conflict with trunk on <span className="mono">{a.trunkConflicts.join(", ")}</span>. Braid will open a reconciliation.</p>}
			{a.checks.length > 0 && <ul className="checks">{a.checks.map((c) => <li key={c.name} className={c.status}><strong>{c.status === "pass" ? "✓" : "✕"}</strong> {c.name} <span className="dim">{c.detail}</span></li>)}</ul>}

			<h3>Why</h3>
			<Why decisions={decisions} empty="This agent has not recorded any decisions yet." />

			<div className="row section-head">
				<h3>Session</h3><span className="spacer" />
				<button onClick={() => setShowSession(!showSession)}>{showSession ? "Hide" : "Show"}</button>
			</div>
			{showSession && <Session slug={slug} attemptId={a.id} decisions={decisions} live={a.status === "working"} />}

			{collisions.length > 0 && <>
				<h3>Collisions with other intents</h3>
				<ul className="collisions">
					{collisions.map((o) => {
						const theirs = state.decisions.filter((d) => d.attemptId === o.other.id && touches(d, o.path));
						const intent = state.intents.find((i) => i.id === o.other.intentId)!;
						return (
							<li key={`${o.a}${o.b}${o.path}`}>
								<span className={`chip ${o.severity}`}>{o.severity === "conflict" ? "will conflict" : o.severity === "touch" ? "mergeable" : "planned"}</span>
								<span className="mono">{o.path}</span> with <Link to={`/p/${slug}/i/${intent.id}`}><span style={{ color: intentColor(intent.id) }}>I{intent.id}</span> {intent.title}</Link> <span className="dim">({o.other.agent})</span>
								{theirs.length > 0 && <p className="small dim">Their reasoning: {theirs.map((d) => d.title).join("; ")}</p>}
							</li>
						);
					})}
				</ul>
			</>}

			<div className="row section-head">
				<h3>Preview</h3><span className="spacer" />
				<button onClick={() => setPreview(!preview)}>{preview ? "Hide" : "Run it"}</button>
				<a className="button" href={`/preview/${slug}/${a.id}/`} target="_blank" rel="noreferrer">Open</a>
			</div>
			{preview && <iframe key={frame} className="preview" src={`/preview/${slug}/${a.id}/`} title={`Preview of attempt ${a.id}`} sandbox="allow-scripts allow-forms allow-modals" />}

			<h3>Changes {diff && <span className="dim">({diff.length})</span>}</h3>
			{diff?.length === 0 && <p className="dim small">Nothing pushed yet.</p>}
			{diff?.map((f) => <FileDiff key={f.path + (f.head ?? "")} file={f} open={diff.length <= 2} />)}
		</section>
	);
}

export function IntentPage({ state, intentId }: { state: State; intentId: number }) {
	const intent = state.intents.find((i) => i.id === intentId);
	const [joining, setJoining] = useState(false);
	if (!intent) return <main className="page narrow"><p className="error">No intent I{intentId} in this project.</p></main>;
	const attempts = state.attempts.filter((a) => a.intentId === intentId);
	const recons = state.reconciliations.filter((r) => r.intentId === intentId);
	const landing = state.landings.find((l) => l.intentId === intentId);
	return (
		<main className="page">
			<div className="intent-head" style={{ borderLeftColor: intentColor(intent.id) }}>
				<div className="row">
					<h1><span className="mono" style={{ color: intentColor(intent.id) }}>I{intent.id}</span> {intent.title}</h1>
					<span className={`chip ${intent.status}`}>{intent.status}</span>
					<span className="spacer" />
					{intent.status === "open" && <button onClick={() => setJoining(!joining)}>{joining ? "Close" : "Add an agent"}</button>}
				</div>
				<p className="goal">{intent.goal}</p>
				{intent.acceptance && <p className="small"><strong>Acceptance:</strong> {intent.acceptance}</p>}
				{landing && state.project.contextRemote && <p className="small dim">Its decisions and session transcript are committed to the context repo: <span className="mono">{state.project.contextRemote}</span> under <span className="mono">intents/{intent.id}/</span></p>}
				{landing && <p className="small">Landed on trunk as <span className="mono">{short(landing.sha)}</span> from attempt {landing.attemptId} ({landing.agent}), {ago(landing.at)}. <Link to={`/p/${state.project.slug}/why?path=${encodeURIComponent(landing.files[0] ?? "")}`}>See it in the code</Link></p>}
				{joining && <JoinCommand slug={state.project.slug} intentId={intent.id} />}
			</div>
			{recons.filter((r) => r.status !== "resolved").map((r) => <ReconPanel key={r.id} r={r} state={state} />)}
			{attempts.length === 0 && <p className="dim">No attempts yet. Add an agent to start one; add several to compare approaches.</p>}
			<div className="compare" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(attempts.length, 1), 3)}, minmax(0, 1fr))` }}>
				{attempts.map((a) => <AttemptColumn key={a.id} a={a} state={state} canLand={intent.status === "open"} />)}
			</div>
			{recons.filter((r) => r.status === "resolved").map((r) => <ReconPanel key={r.id} r={r} state={state} />)}
		</main>
	);
}
