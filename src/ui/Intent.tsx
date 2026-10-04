import { runFor, Verification } from "./Verify";
import { useEffect, useState } from "react";
import type { Attempt, Conflict, Decision, DiffFile, Intent, Reconciliation, State } from "../shared/types";
import { api, ago, intentColor, short, useAsync } from "./api";
import { Link, useAction } from "./App";
import { FileDiff } from "./Diff";
import { HostedChip, JoinCommand } from "./Project";
import { Session } from "./Session";

const LIVE = new Set(["working", "ready", "conflicted"]);
const touches = (d: Decision, path: string) => d.files.some((f) => f === path || path.startsWith(f.replace(/\/?\*?$/, "") + "/"));

/** `answer`, when given, puts a reply box under each question nobody has answered yet. */
export function Why({ decisions, empty = "No decisions recorded.", answer }: { decisions: Decision[]; empty?: string; answer?: (question: Decision, body: string) => Promise<unknown> }) {
	if (!decisions.length) return <p className="dim small">{empty}</p>;
	const answered = new Set(decisions.filter((d) => d.kind === "answer").map((d) => d.title.replace(/^Answer: /, "")));
	return (
		<ul className="why">
			{decisions.map((d) => (
				<li key={d.id} className={d.kind === "feedback" || d.kind === "answer" ? "from-person" : undefined}>
					<span className={`kind ${d.kind}`}>{d.kind}</span>
					<div>
						<strong>{d.title}</strong>{(d.kind === "feedback" || d.kind === "answer") && <span className="dim small"> · {d.agent}</span>}
						{d.body && <p>{d.body}</p>}
						{d.files.length > 0 && <p className="mono dim small">{d.files.join("  ")}</p>}
						{answer && d.kind === "question" && !answered.has(d.title) && <AnswerBox send={(body) => answer(d, body)} />}
					</div>
				</li>
			))}
		</ul>
	);
}

function AnswerBox({ send }: { send: (body: string) => Promise<unknown> }) {
	const [body, setBody] = useState("");
	const act = useAction();
	return (
		<form className="answer" onSubmit={(e) => { e.preventDefault(); act.run(() => send(body)); }}>
			<label className="small">The agent is asking you. Your answer is kept with its decisions.
				<textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
			</label>
			<div className="row"><button className="primary" disabled={act.busy || !body.trim()}>{act.busy ? "Sending…" : "Answer"}</button>{act.error && <span className="error">{act.error}</span>}</div>
		</form>
	);
}

/** Where a person talks back to an attempt: send it back with what to change, or just tell the agent something. */
function Respond({ a, state }: { a: Attempt; state: State }) {
	const slug = state.project.slug;
	const [body, setBody] = useState("");
	const [sent, setSent] = useState<string | null>(null);
	const act = useAction();
	const running = a.hosted === "starting" || a.hosted === "running";
	const canStart = !running && (a.kind === "claude" || a.kind === "codex") && state.project.hosting[a.kind === "codex" ? "codex" : "claude"];
	const [bringBack, setBringBack] = useState(true);
	const send = (kind: "feedback" | "message") => act.run(async () => {
		const r = await api<{ broughtBack: boolean; couldNot?: string }>("POST", `/p/${slug}/attempts/${a.id}/respond`, { kind, body, by: "human", bringBack: kind === "feedback" && canStart && bringBack });
		setBody("");
		setSent(r.broughtBack ? `Sent. ${a.agent} is starting again to act on it.` : r.couldNot ? `Sent, but ${a.agent} could not be started: ${r.couldNot}` : running ? `Sent. ${a.agent} sees it on its next step.` : `Sent. ${a.agent} sees it the next time it talks to Braid.`);
	});
	return (
		<div className="respond">
			<label className="small"><strong>Respond to {a.agent}</strong>
				<textarea rows={3} value={body} placeholder="What should change, or what should it know?" onChange={(e) => { setBody(e.target.value); setSent(null); }} />
			</label>
			<div className="row">
				<button className="primary" disabled={act.busy || !body.trim()} onClick={() => send("feedback")} title="The attempt goes back to working, and your note is kept with its decisions">Send back for changes</button>
				<button disabled={act.busy || !body.trim()} onClick={() => send("message")} title="The agent is told; the attempt's status does not change">Just tell it</button>
				{canStart && <label className="check small"><input type="checkbox" checked={bringBack} onChange={(e) => setBringBack(e.target.checked)} /> start {a.agent} again in a sandbox to act on it</label>}
			</div>
			{!canStart && !running && <p className="dim small">Braid is not running this agent, so it hears your note the next time it calls a Braid tool.</p>}
			{act.error && <p className="error">{act.error}</p>}
			{sent && <p className="small" role="status">{sent}</p>}
		</div>
	);
}

/** How one conflicted file is being answered: a replacement for each conflict, or the whole file edited by hand. */
type Answer = { whole: string | null; pieces: (string | undefined)[] };
const complete = (c: Conflict, a: Answer | undefined) => c.kind !== "content" || (!!a && (a.whole !== null || a.pieces.length === c.regions.length && a.pieces.every((p) => p !== undefined)));

function ConflictView({ c, answer, onChange, attemptWhy, attempt, markedUrl }: { c: Conflict; answer: Answer; onChange: (a: Answer) => void; attemptWhy: Decision[]; attempt: Attempt; markedUrl: string }) {
	const act = useAction();
	const set = (i: number, text: string) => onChange({ ...answer, pieces: c.regions.map((_, j) => (j === i ? text : answer.pieces[j])) });
	const rows = (text: string) => Math.min(Math.max(text.split("\n").length, 3), 24);
	return (
		<div className="conflict-block">
			<h3 className="mono">{c.path} <span className="dim small">{c.kind === "content" ? `${c.regions.length} conflict${c.regions.length === 1 ? "" : "s"}; the rest of the file is merged from both sides` : ""}</span></h3>
			{c.kind === "lockfile" ? <p className="dim">Both sides changed dependencies. Nothing to do here: once the other files are resolved, Braid regenerates this file from the merged <code>package.json</code> in a sandbox.</p>
			: c.kind === "delete" ? <p className="error">One side deleted this file and the other edited it. Merge trunk into the attempt with git instead (the agent's <code>sync</code> tool).</p> : <>
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
				{answer.whole === null ? c.regions.map((r, i) => (
					<div className="region-block" key={i}>
						<p className="small dim">Conflict {i + 1} of {c.regions.length}, at line {r.oursLine} on trunk</p>
						{r.before && <pre className="mono ctx" aria-label="Unchanged lines before">{r.before}</pre>}
						<div className="sides region">
							<pre className="mono"><span className="dim">trunk</span>{"\n"}{r.ours || "(nothing here)"}</pre>
							<pre className="mono"><span className="dim">attempt</span>{"\n"}{r.theirs || "(nothing here)"}</pre>
						</div>
						<details className="small"><summary>What both started from</summary><pre className="mono ctx">{r.base || "(nothing here)"}</pre></details>
						<label className="editor">
							<span className="row"><strong>What should stand here</strong><span className="spacer" />
								<button type="button" onClick={() => set(i, r.ours)}>Trunk's</button>
								<button type="button" onClick={() => set(i, r.theirs)}>The attempt's</button>
								<button type="button" onClick={() => set(i, r.ours + r.theirs)}>Both, trunk first</button>
								<button type="button" onClick={() => set(i, r.theirs + r.ours)}>Both, attempt first</button>
								<button type="button" onClick={() => set(i, "")}>Neither</button></span>
							<textarea className="mono" value={answer.pieces[i] ?? ""} placeholder="Pick a starting point, then edit it so both changes survive" onChange={(e) => set(i, e.target.value)} rows={rows(answer.pieces[i] ?? r.ours + r.theirs)} spellCheck={false} />
							{answer.pieces[i] === "" && <span className="small dim">These lines will be removed.</span>}
						</label>
						{r.after && <pre className="mono ctx" aria-label="Unchanged lines after">{r.after}</pre>}
					</div>
				)) : (
					<label className="editor">
						<span className="row"><strong>The whole file, conflicts marked</strong><span className="spacer" /><button type="button" onClick={() => onChange({ ...answer, whole: null })}>Back to one conflict at a time</button></span>
						<span className="small dim">Replace each block from <code>{"<<<<<<<"}</code> to <code>{">>>>>>>"}</code> with what should stand there. Change other lines too if the fix needs it.</span>
						<textarea className="mono" value={answer.whole} onChange={(e) => onChange({ ...answer, whole: e.target.value })} rows={28} spellCheck={false} />
					</label>
				)}
				{answer.whole === null && <p className="row small"><button type="button" disabled={act.busy} onClick={() => act.run(async () => onChange({ ...answer, whole: (await api<{ text: string }>("GET", markedUrl)).text }))}>Edit the whole file instead</button><span className="dim">for a fix that needs changes outside the conflicts</span>{act.error && <span className="error">{act.error}</span>}</p>}
			</>}
		</div>
	);
}

function ReconPanel({ r, state }: { r: Reconciliation; state: State }) {
	const attempt = state.attempts.find((a) => a.id === r.attemptId)!;
	const mine = state.decisions.filter((d) => d.attemptId === r.attemptId);
	const [answers, setAnswers] = useState<Record<string, Answer>>({});
	const answerOf = (c: Conflict): Answer => answers[c.path] ?? { whole: null, pieces: [] };
	const [rationale, setRationale] = useState("");
	const act = useAction();
	const base = `/p/${state.project.slug}/reconciliations/${r.id}`;
	const owner = attempt as Attempt | undefined;
	const agentBusy = owner?.hosted === "starting" || owner?.hosted === "running";
	const canBringBack = !!owner && state.project.hosting[owner.kind === "codex" ? "codex" : "claude"];

	if (r.status === "resolved" || r.status === "stale") {
		return (
			<section className="card recon resolved">
				<h2>⚯ Reconciliation R{r.id} <span className={`chip ${r.status === "stale" ? "quiet" : "landed"}`}>{r.status === "stale" ? "not used" : `resolved by ${r.resolvedBy}`}</span></h2>
				{r.status === "stale" && <p className="warn small">Trunk or the attempt moved before this resolution landed, so it was set aside. It was written by {r.resolvedBy}.</p>}
				<p>{r.rationale}</p>
				{r.resolvedBy !== "braid" && <p className="small dim">What the resolution changed in trunk's version of each file:</p>}
				{r.resolvedBy !== "braid" && r.resolutions.map((x) => <FileDiff key={x.path} file={{ path: x.path, status: "modified", base: r.conflicts.find((c) => c.path === x.path)?.trunk ?? "", head: x.content, binary: false }} />)}
			</section>
		);
	}
	return (
		<section className="card recon">
			<h2>⚯ Reconciliation R{r.id}: attempt {r.attemptId} against trunk {short(r.trunkSha)}</h2>
			<p className="lede">Git could not merge these lines. Each side is shown with the intent it served and the decisions behind it. The resolution has to keep both. The merged result is run in a sandbox before it lands.</p>
			{r.conflicts.map((c) => (
				<ConflictView key={c.path} c={c} attempt={attempt} answer={answerOf(c)} onChange={(v) => setAnswers({ ...answers, [c.path]: v })} markedUrl={`${base}/marked?path=${encodeURIComponent(c.path)}`}
					attemptWhy={mine.filter((d) => touches(d, c.path)).length ? mine.filter((d) => touches(d, c.path)) : mine} />
			))}
			<label>How both intents survive (recorded in the landing commit)
				<textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} placeholder="Kept I2's save-after-render and registered the theme toggle before load, so…" />
			</label>
			{act.error && <p className="error">{act.error}</p>}
			<div className="row">
				<button className="primary" disabled={act.busy || r.status === "resolving" || !rationale.trim() || !r.conflicts.every((c) => complete(c, answers[c.path]))}
					title="Every conflict needs an answer, and the rationale says how both intents survive"
					onClick={() => act.run(async () => {
						const body = { by: "human", rationale, resolutions: r.conflicts.filter((c) => c.kind === "content").map((c) => { const a = answerOf(c); return a.whole !== null ? { path: c.path, content: a.whole } : { path: c.path, regions: a.pieces }; }) };
						try { await api("POST", `${base}/resolve`, body); } catch (e) {
							// Keeping one side whole drops the other intent's change; that needs a deliberate yes.
							if (!/keeps only one side/.test((e as Error).message) || !window.confirm(`${(e as Error).message.split(". Write")[0]}.\n\nLand it anyway?`)) throw e;
							await api("POST", `${base}/resolve`, { ...body, oneSided: true });
						}
					})}>
					Land this resolution
				</button>
				{state.project.llm && (
					<button disabled={act.busy || r.status === "resolving"} onClick={() => act.run(() => api("POST", `${base}/auto`))}>
						{act.busy || r.status === "resolving" ? "Reconciling…" : `Reconcile with ${state.project.llm}`}
					</button>
				)}
				{canBringBack && (
					<button disabled={act.busy || agentBusy} onClick={() => act.run(() => api("POST", `/p/${state.project.slug}/attempts/${r.attemptId}/rehost`, { task: "reconcile" }))}>
						{agentBusy ? `${owner!.agent} is reconciling…` : `Have ${owner!.agent} reconcile`}
					</button>
				)}
				<span className="dim small">The agent on attempt {r.attemptId} can also answer through its <code>reconciliation</code> and <code>resolve</code> tools, or by merging trunk with git.</span>
			</div>
		</section>
	);
}

function EditIntent({ intent, slug, done }: { intent: Intent; slug: string; done: () => void }) {
	const [title, setTitle] = useState(intent.title), [goal, setGoal] = useState(intent.goal), [acceptance, setAcceptance] = useState(intent.acceptance);
	const act = useAction();
	return (
		<form className="edit-intent" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/p/${slug}/intents/${intent.id}/edit`, { title, goal, acceptance, by: "human" }))) done(); }}>
			<label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
			<label>Goal<textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
			<label>Acceptance<textarea rows={2} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} /></label>
			<div className="row"><button className="primary" disabled={act.busy || !title.trim() || !goal.trim()}>{act.busy ? "Saving…" : "Save"}</button><span className="dim small">Agents working on this intent are told what changed.</span></div>
			{act.error && <p className="error">{act.error}</p>}
		</form>
	);
}

function AttemptColumn({ a, state, canLand }: { a: Attempt; state: State; canLand: boolean }) {
	const slug = state.project.slug;
	const { data: diff } = useAsync(() => api<DiffFile[]>("GET", `/p/${slug}/attempts/${a.id}/diff`), [a.id, a.headSha, a.baseSha]);
	const decisions = state.decisions.filter((d) => d.attemptId === a.id);
	const [preview, setPreview] = useState(false);
	const key = state.previewKeys?.[a.id];
	const previewUrl = `/preview/${slug}/${a.id}${key ? `~${key}` : ""}/`;
	const [showSession, setShowSession] = useState(true);
	const [frame, setFrame] = useState(0);
	useEffect(() => setFrame((f) => f + 1), [a.headSha]);
	const land = useAction(), drop = useAction(), halt = useAction();
	const run = runFor(state, a.id);
	// The commit on screen is the one that lands: if the attempt has moved since, Braid refuses.
	const landIt = () => land.run(async () => {
		if (a.status === "working" && !window.confirm(`${a.agent} has not marked attempt ${a.id} ready. Land it as it is?`)) return;
		try { await api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human", sha: a.headSha }); } catch (e) {
			// Landing something that did not pass needs a second, deliberate yes.
			if (!/with force/.test((e as Error).message) || !window.confirm(`${(e as Error).message.replace(/[.;] [Ll]and it anyway with force$/, "")}.\n\nLand it anyway, without verification?`)) throw e;
			await api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human", force: true, sha: a.headSha });
		}
	});
	const queued = state.queue.find((q) => q.attemptId === a.id);
	// A merge result only says something while trunk is still where the merge was made.
	const candidate = state.candidates.find((c) => c.attemptId === a.id && c.attemptSha === a.headSha && c.trunkSha === state.project.head);
	const mergeRun = candidate ? state.runs.find((r) => r.ref === `land:${a.id}` && r.sha === candidate.sha) ?? null : null;
	const failing = run?.status === "fail" && run.sha === a.headSha ? "the failed checks" : mergeRun?.status === "fail" ? "the merge with trunk" : null;
	const skipQueue = () => land.run(async () => {
		if (!window.confirm(`Land attempt ${a.id} now, without waiting for verification?`)) return;
		await api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human", force: true, sha: a.headSha });
	});
	const byId = new Map(state.attempts.map((x) => [x.id, x]));
	const collisions = state.overlaps.filter((o) => o.a === a.id || o.b === a.id).map((o) => ({ ...o, other: byId.get(o.a === a.id ? o.b : o.a)! })).filter((o) => o.other);

	return (
		<section className={`card attempt ${a.status}`}>
			<div className="row">
				<h2>{a.agent} <span className="mono dim">{a.id}</span></h2>
				<span className={`chip ${a.status}`}>{a.status}</span>
				<HostedChip a={a} />
				<span className="spacer" />
				{(a.hosted === "starting" || a.hosted === "running") && <button disabled={halt.busy} onClick={() => halt.run(() => api("POST", `/p/${slug}/attempts/${a.id}/stop`, {}))}>Stop agent</button>}
				{LIVE.has(a.status) && <button disabled={drop.busy} onClick={() => { if (window.confirm(`Abandon attempt ${a.id}?${a.hosted === "starting" || a.hosted === "running" ? ` ${a.agent} is running and will be stopped.` : ""} You can reopen it while the intent is open.`)) drop.run(() => api("POST", `/p/${slug}/attempts/${a.id}/abandon`, {})); }}>Abandon</button>}
				{a.status === "abandoned" && canLand && <button disabled={drop.busy} onClick={() => drop.run(() => api("POST", `/p/${slug}/attempts/${a.id}/restore`, {}))}>Reopen</button>}
				{canLand && a.status === "conflicted" && <span className="small dim">resolve the reconciliation above to land</span>}
				{canLand && LIVE.has(a.status) && a.status !== "conflicted" && (
					<button className="primary" disabled={land.busy || !!queued || a.headSha === a.baseSha} onClick={landIt}>
						{land.busy ? "Landing…" : queued ? "Waiting to land" : "Land this"}
					</button>
				)}
			</div>
			{(land.error || drop.error || halt.error) && <p className="error">{land.error ?? drop.error ?? halt.error}</p>}
			{a.hosted === "failed" && <p className="warn small">The hosted agent failed: {a.hostedDetail}</p>}
			{queued && (
				<div className="row landing-wait" role="status">
					<span className="chip quiet">{queued.state === "verifying" ? "verifying the merge" : queued.state === "locking" ? "regenerating the lockfile" : queued.state === "pushing" ? "landing" : "waiting to land"}</span>
					<span className="small">Landing asked for by {queued.by}{queued.note ? `: ${queued.note}. It lands by itself when that is done.` : "."}</span>
					<span className="spacer" />
					{queued.state !== "pushing" && <button disabled={land.busy} onClick={skipQueue}>Land now</button>}
					{queued.state !== "pushing" && <button disabled={drop.busy} onClick={() => drop.run(() => api("POST", `/p/${slug}/attempts/${a.id}/cancel-landing`, { by: "human" }))}>Cancel landing</button>}
				</div>
			)}
			{LIVE.has(a.status) && failing && a.hosted !== "starting" && a.hosted !== "running" && state.project.hosting[a.kind === "codex" ? "codex" : "claude"] && (
				<p className="row"><button disabled={halt.busy} onClick={() => halt.run(() => api("POST", `/p/${slug}/attempts/${a.id}/rehost`, { task: "fix" }))}>Have {a.agent} fix {failing}</button></p>
			)}
			<p className="small dim mono">base {short(a.baseSha)} → head {short(a.headSha)} · updated {ago(a.updatedAt)}{a.behind > 0 && LIVE.has(a.status) ? ` · ${a.behind} landing${a.behind === 1 ? "" : "s"} behind trunk` : ""}</p>
			{a.summary && <p>{a.summary}</p>}

			{LIVE.has(a.status) && a.status !== "conflicted" && a.trunkConflicts.length > 0 && <p className="warn">Landing now would conflict with trunk on <span className="mono">{a.trunkConflicts.join(", ")}</span>. Braid will open a reconciliation.</p>}
			{a.headSha !== a.baseSha && <>
				<h3>Verified by Braid</h3>
				<Verification slug={slug} refName={a.id} run={run} head={a.headSha} />
			</>}
			{LIVE.has(a.status) && candidate && mergeRun && <>
				<h3>Merged with trunk at <span className="mono">{short(candidate.trunkSha)}</span></h3>
				<Verification slug={slug} refName={`land:${a.id}`} run={mergeRun} head={candidate.sha} fixed />
			</>}
			{a.checks.length > 0 && <h3>Reported by the agent</h3>}
			{a.checks.length > 0 && <ul className="checks">{a.checks.map((c) => <li key={c.name} className={c.status}><strong>{c.status === "pass" ? "✓" : "✕"}</strong> {c.name} <span className="dim">{c.detail}</span></li>)}</ul>}

			<h3>Why</h3>
			<Why decisions={decisions} empty="This agent has not recorded any decisions yet."
				answer={LIVE.has(a.status) ? (q, body) => api("POST", `/p/${slug}/attempts/${a.id}/respond`, { kind: "answer", question: q.id, body, by: "human", bringBack: !!a.hosted && a.hosted !== "starting" && a.hosted !== "running" }) : undefined} />
			{LIVE.has(a.status) && canLand && <Respond a={a} state={state} />}

			<div className="row section-head">
				<h3>Session</h3><span className="spacer" />
				<button onClick={() => setShowSession(!showSession)}>{showSession ? "Hide" : "Show"}</button>
			</div>
			{showSession && <Session slug={slug} attemptId={a.id} decisions={decisions} live={a.hosted ? a.hosted === "starting" || a.hosted === "running" : a.status === "working"} />}

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
				{run?.preview && run.sha === a.headSha && <span className="chip pass" title="Served from the build Braid made of this commit">built</span>}
				<button onClick={() => setPreview(!preview)}>{preview ? "Hide" : "Run it"}</button>
				<a className="button" href={previewUrl} target="_blank" rel="noreferrer">Open</a>
			</div>
			{preview && <iframe key={frame} className="preview" src={previewUrl} title={`Preview of attempt ${a.id}`} sandbox="allow-scripts allow-forms allow-modals" />}

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
	const landing = state.landings.find((l) => l.intentId === intentId && !l.revertOf && !l.revertedBy);
	const reverts = state.landings.filter((l) => l.intentId === intentId && l.revertOf);
	const [editing, setEditing] = useState(false);
	const act = useAction();
	const abandon = () => { if (window.confirm(`Abandon I${intent.id}? Its ${attempts.filter((a) => LIVE.has(a.status)).length} live attempt(s) are abandoned too and their agents stopped.`)) act.run(() => api("POST", `/p/${state.project.slug}/intents/${intent.id}/abandon`, {})); };
	const revert = () => {
		const reason = window.prompt(`Take I${intent.id} back out of trunk? Trunk gets a new commit that undoes it, and the intent opens again.\n\nWhy? (kept with the intent)`);
		if (reason?.trim()) act.run(() => api("POST", `/p/${state.project.slug}/landings/${landing!.sha}/revert`, { by: "human", reason }));
	};
	return (
		<main className="page">
			<div className="intent-head" style={{ borderLeftColor: intentColor(intent.id) }}>
				<div className="row">
					<h1><span className="mono" style={{ color: intentColor(intent.id) }}>I{intent.id}</span> {intent.title}</h1>
					<span className={`chip ${intent.status}`}>{intent.status}</span>
					<span className="spacer" />
					{intent.status === "open" && <button onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>}
					{intent.status === "open" && <button disabled={act.busy} onClick={abandon}>Abandon</button>}
					{intent.status === "open" && <button onClick={() => setJoining(!joining)}>{joining ? "Close" : "Add an agent"}</button>}
					{landing && <button disabled={act.busy} onClick={revert}>{act.busy ? "Reverting…" : "Revert landing"}</button>}
				</div>
				{act.error && <p className="error">{act.error}</p>}
				{editing ? <EditIntent intent={intent} slug={state.project.slug} done={() => setEditing(false)} /> : <>
					<p className="goal">{intent.goal}</p>
					{intent.acceptance && <p className="small"><strong>Acceptance:</strong> {intent.acceptance}</p>}
				</>}
				{reverts.map((r) => <p key={r.sha} className="warn small">A landing of this intent was taken back out of trunk as <span className="mono">{short(r.sha)}</span> by {r.agent}, {ago(r.at)}. The reason is in that attempt's decisions.</p>)}
				{landing && state.project.contextRemote && <p className="small dim">Its decisions and session transcript are committed to the context repo: <span className="mono">{state.project.contextRemote}</span> under <span className="mono">intents/{intent.id}/</span></p>}
				{landing && <p className="small">Landed on trunk as <span className="mono">{short(landing.sha)}</span> from attempt {landing.attemptId} ({landing.agent}), {ago(landing.at)}. <Link to={`/p/${state.project.slug}/why?path=${encodeURIComponent(landing.files[0] ?? "")}`}>See it in the code</Link></p>}
				{joining && <JoinCommand slug={state.project.slug} intentId={intent.id} hosting={state.project.hosting} />}
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
