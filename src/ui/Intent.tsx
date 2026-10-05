import { runFor, Verification } from "./Verify";
import { useEffect, useState } from "react";
import type { Attempt, Conflict, Decision, DecisionKind, DiffFile, Intent, Reconciliation, State } from "../shared/types";
import { api, ago, intentColor, short, useAsync } from "./api";
import { Agent, IntentId, Link, useAction, useTitle } from "./App";
import { FileDiff } from "./Diff";
import { Empty, MiniLoom } from "./Graphics";
import { ask, Icon, Notice, Tabs, type IconName, type Tab } from "./Kit";
import { HostedChip, JoinCommand } from "./Project";
import { Session } from "./Session";

const LIVE = new Set(["working", "ready", "conflicted"]);
const touches = (d: Decision, path: string) => d.files.some((f) => f === path || path.startsWith(f.replace(/\/?\*?$/, "") + "/"));
const KIND: Record<DecisionKind, [IconName, string]> = {
	decision: ["decision", "Decision"], assumption: ["assumption", "Assumption"], rejected: ["rejected", "Rejected"], question: ["question", "Question"],
	note: ["note", "Note"], feedback: ["feedback", "Feedback"], answer: ["answer", "Answer"],
};

/** The recorded why: what an agent decided, assumed, ruled out or asked, and what people told it. `answer`, when given, puts a reply box under each question nobody has answered yet. */
export function Why({ decisions, empty = "No decisions recorded.", answer }: { decisions: Decision[]; empty?: string; answer?: (question: Decision, body: string) => Promise<unknown> }) {
	if (!decisions.length) return <p className="dim">{empty}</p>;
	const answered = new Set(decisions.filter((d) => d.kind === "answer").map((d) => d.title.replace(/^Answer: /, "")));
	return (
		<ul className="decisions">
			{decisions.map((d) => {
				const person = d.kind === "feedback" || d.kind === "answer";
				return (
					<li key={d.id} className={`${d.kind} ${person ? "from-person" : ""}`}>
						<span className={`kind ${d.kind}`}><Icon name={KIND[d.kind][0]} size={12} />{KIND[d.kind][1]}</span>
						<div className="d-body">
							<strong>{d.title}</strong>{person && <span className="dim"> · from {d.agent}</span>}
							{d.body && <p>{d.body}</p>}
							{d.files.length > 0 && <p className="d-files">{d.files.map((f) => <span key={f} className="mono"><Icon name="file" size={12} />{f}</span>)}</p>}
							{answer && d.kind === "question" && !answered.has(d.title) && <AnswerBox send={(body) => answer(d, body)} />}
						</div>
					</li>
				);
			})}
		</ul>
	);
}

function AnswerBox({ send }: { send: (body: string) => Promise<unknown> }) {
	const [body, setBody] = useState("");
	const act = useAction();
	return (
		<form className="answer" onSubmit={(e) => { e.preventDefault(); act.run(() => send(body)); }}>
			<label>Your answer<textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="The agent is waiting on this" /></label>
			<p className="hint">It is kept with the attempt's decisions, and the agent is told.</p>
			<div className="row"><button className="primary" disabled={act.busy || !body.trim()}>{act.busy ? "Sending…" : "Send answer"}</button></div>
			{act.error && <Notice>{act.error}</Notice>}
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
			<label>Respond to {a.agent}
				<textarea rows={3} value={body} placeholder="What should change, or what should it know?" onChange={(e) => { setBody(e.target.value); setSent(null); }} />
			</label>
			<div className="row">
				<button className="primary" disabled={act.busy || !body.trim()} onClick={() => send("feedback")}><Icon name="undo" />Send back for changes</button>
				<button disabled={act.busy || !body.trim()} onClick={() => send("message")}><Icon name="message" />Just tell it</button>
				{canStart && <label className="check"><input type="checkbox" checked={bringBack} onChange={(e) => setBringBack(e.target.checked)} />Start {a.agent} again in a sandbox to act on it</label>}
			</div>
			<p className="hint"><strong>Send back</strong> returns the attempt to working and keeps your note with its decisions. <strong>Just tell it</strong> leaves the status as it is.{!canStart && !running && " Braid is not running this agent, so it hears you the next time it calls a Braid tool."}</p>
			{act.error && <Notice>{act.error}</Notice>}
			{sent && <p className="sent" role="status"><Icon name="check" />{sent}</p>}
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
	const answeredCount = c.regions.filter((_, i) => answer.pieces[i] !== undefined).length;
	return (
		<div className="conflict-block">
			<h3><Icon name="file" /><span className="mono">{c.path}</span>
				{c.kind === "content" && <span className="conflict-count">{answer.whole !== null ? "editing the whole file" : `${answeredCount} of ${c.regions.length} conflict${c.regions.length === 1 ? "" : "s"} answered`}</span>}
			</h3>
			{c.kind === "content" && <p className="dim">The rest of this file merged cleanly from both sides.</p>}
			{c.kind === "lockfile" ? <p className="dim">Both sides changed dependencies. Nothing to do here: once the other files are resolved, Braid regenerates this file from the merged <code>package.json</code> in a sandbox.</p>
			: c.kind === "delete" ? <Notice>One side deleted this file and the other edited it. That cannot be resolved here yet: have the agent merge trunk into the attempt with git (its <code>sync</code> tool).</Notice> : <>
				<div className="sides">
					<div className="side trunk-side">
						<h4 className="label">Why trunk has its version</h4>
						{c.trunkWhy.map((w) => (
							<div key={w.intentId} className="side-why">
								<p className="side-intent"><IntentId id={w.intentId} /><strong>{w.title}</strong><span className="dim">by {w.agent}</span></p>
								<p className="goal">{w.goal}</p>
								<Why decisions={w.decisions} />
							</div>
						))}
						{c.trunkWhy.length === 0 && <p className="dim">This file was changed on trunk outside Braid, so no reason is recorded.</p>}
					</div>
					<div className="side attempt-side">
						<h4 className="label">Why attempt {attempt.id} has its version</h4>
						<div className="side-why">
							<p className="side-intent"><IntentId id={attempt.intentId} /><span className="dim">by {attempt.agent}</span></p>
							<Why decisions={attemptWhy} />
						</div>
					</div>
				</div>
				{answer.whole === null ? c.regions.map((r, i) => (
					<fieldset className={`region-block ${answer.pieces[i] !== undefined ? "answered" : ""}`} key={i}>
						<legend>Conflict {i + 1} of {c.regions.length} <span className="dim">at line {r.oursLine} on trunk</span>{answer.pieces[i] !== undefined && <span className="chip pass">answered</span>}</legend>
						{r.before && <pre className="ctx" aria-label="Unchanged lines before">{r.before}</pre>}
						<div className="sides region">
							<div className="pane trunk-pane"><span className="label">On trunk</span><pre tabIndex={0}>{r.ours || "(nothing here)"}</pre></div>
							<div className="pane attempt-pane"><span className="label">In the attempt</span><pre tabIndex={0}>{r.theirs || "(nothing here)"}</pre></div>
						</div>
						<details className="disclose"><summary>What both sides started from</summary><pre className="ctx">{r.base || "(nothing here)"}</pre></details>
						<div className="editor">
							<div className="editor-head">
								<label htmlFor={`${c.path}-${i}`}>What should stand here</label>
								<div className="picks" role="group" aria-label="Start from">
									<span className="dim">Start from</span>
									{([["Trunk's", r.ours], ["The attempt's", r.theirs], ["Both, trunk first", r.ours + r.theirs], ["Both, attempt first", r.theirs + r.ours], ["Neither", ""]] as const).map(([name, text]) => (
										<button key={name} type="button" aria-pressed={answer.pieces[i] === text} onClick={() => set(i, text)}>{name}</button>
									))}
								</div>
							</div>
							<textarea id={`${c.path}-${i}`} className="mono" value={answer.pieces[i] ?? ""} placeholder="Pick a starting point, then edit it so both changes survive" onChange={(e) => set(i, e.target.value)} rows={rows(answer.pieces[i] ?? r.ours + r.theirs)} spellCheck={false} />
							{answer.pieces[i] === "" && <p className="hint">Nothing will stand here: both sides' lines are removed.</p>}
						</div>
						{r.after && <pre className="ctx" aria-label="Unchanged lines after">{r.after}</pre>}
					</fieldset>
				)) : (
					<div className="editor whole">
						<div className="editor-head"><label htmlFor={`${c.path}-whole`}>The whole file, conflicts marked</label><button type="button" onClick={() => onChange({ ...answer, whole: null })}>Back to one conflict at a time</button></div>
						<p className="hint">Replace each block from <code>{"<<<<<<<"}</code> to <code>{">>>>>>>"}</code> with what should stand there. Change other lines too if the fix needs it.</p>
						<textarea id={`${c.path}-whole`} className="mono" value={answer.whole} onChange={(e) => onChange({ ...answer, whole: e.target.value })} rows={28} spellCheck={false} />
					</div>
				)}
				{answer.whole === null && <p className="row whole-switch"><button type="button" disabled={act.busy} onClick={() => act.run(async () => onChange({ ...answer, whole: (await api<{ text: string }>("GET", markedUrl)).text }))}><Icon name="edit" />{act.busy ? "Loading the file…" : "Edit the whole file instead"}</button><span className="dim">for a fix that needs changes outside the conflicts</span></p>}
				{act.error && <Notice>{act.error}</Notice>}
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
			<section className="panel recon resolved" aria-label={`Reconciliation ${r.id}`}>
				<h2><Icon name="reconcile" />Reconciliation R{r.id}<span className={`chip ${r.status === "stale" ? "quiet" : "landed"}`}>{r.status === "stale" ? "not used" : `resolved by ${r.resolvedBy}`}</span></h2>
				{r.status === "stale" && <Notice tone="warn" small>Trunk or the attempt moved before this resolution landed, so it was set aside. It was written by {r.resolvedBy}.</Notice>}
				<p className="label">How both intents survive</p>
				<p className="rationale">{r.rationale}</p>
				{r.resolvedBy !== "braid" && r.resolutions.length > 0 && <p className="dim">What the resolution changed in trunk's version of each file:</p>}
				{r.resolvedBy !== "braid" && r.resolutions.map((x) => <FileDiff key={x.path} file={{ path: x.path, status: "modified", base: r.conflicts.find((c) => c.path === x.path)?.trunk ?? "", head: x.content, binary: false }} />)}
			</section>
		);
	}
	const unanswered = r.conflicts.filter((c) => !complete(c, answers[c.path])).length;
	const blocked = [unanswered > 0 && `answer the conflicts in ${unanswered} file${unanswered === 1 ? "" : "s"}`, !rationale.trim() && "say how both intents survive"].filter(Boolean) as string[];
	const resolving = r.status === "resolving";
	if (state.viewer) {
		return (
			<section className="panel recon" aria-label={`Reconciliation ${r.id}`}>
				<h2><span className="chip conflict">conflict</span>Attempt {r.attemptId} and trunk changed the same lines</h2>
				<p className="lede">Landing stopped on {r.conflicts.map((c) => c.path).join(", ")}. Someone signed in has to resolve it with both intents in view.</p>
			</section>
		);
	}
	return (
		<section className="panel recon open" aria-label={`Reconciliation ${r.id}`}>
			<h2><span className="chip conflict">conflict</span>Attempt {r.attemptId} and trunk changed the same lines</h2>
			<p className="lede">Git could not merge these lines. Each side is shown with the intent it served and the decisions behind it, so the resolution can keep both. The merged result is run in a sandbox before it lands.</p>
			<div className="recon-auto">
				<span className="label">Let something else resolve it</span>
				{state.project.llm && (
					<button disabled={act.busy || resolving} onClick={() => act.run(() => api("POST", `${base}/auto`))}>
						<Icon name="reconcile" />{act.busy || resolving ? "Reconciling…" : `Reconcile with ${state.project.llm}`}
					</button>
				)}
				{canBringBack && (
					<button disabled={act.busy || agentBusy} onClick={() => act.run(() => api("POST", `/p/${state.project.slug}/attempts/${r.attemptId}/rehost`, { task: "reconcile" }))}>
						<Icon name="agent" />{agentBusy ? `${owner!.agent} is reconciling…` : `Have ${owner!.agent} reconcile`}
					</button>
				)}
				<span className="dim">The agent on attempt {r.attemptId} can also answer through its <code>reconciliation</code> and <code>resolve</code> tools, or by merging trunk with git.</span>
			</div>
			{r.conflicts.map((c) => (
				<ConflictView key={c.path} c={c} attempt={attempt} answer={answerOf(c)} onChange={(v) => setAnswers({ ...answers, [c.path]: v })} markedUrl={`${base}/marked?path=${encodeURIComponent(c.path)}`}
					attemptWhy={mine.filter((d) => touches(d, c.path)).length ? mine.filter((d) => touches(d, c.path)) : mine} />
			))}
			<div className="recon-land">
				<label>How both intents survive
					<textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} placeholder="Kept I2's save-after-render and registered the theme toggle before load, so…" />
					<span className="hint">Recorded in the landing commit and shown in the Why view.</span>
				</label>
				{act.error && <Notice>{act.error}</Notice>}
				<div className="row">
					<button className="primary" disabled={act.busy || resolving || blocked.length > 0}
						onClick={() => act.run(async () => {
							const body = { by: "human", rationale, resolutions: r.conflicts.filter((c) => c.kind === "content").map((c) => { const a = answerOf(c); return a.whole !== null ? { path: c.path, content: a.whole } : { path: c.path, regions: a.pieces }; }) };
							try { await api("POST", `${base}/resolve`, body); } catch (e) {
								// Keeping one side whole drops the other intent's change; that needs a deliberate yes.
								if (!/keeps only one side/.test((e as Error).message)) throw e;
								if (await ask({ title: "This keeps only one side", body: <p>{(e as Error).message.split(". Write")[0]}. The other intent's change would be dropped.</p>, confirm: "Land it anyway", danger: true }) === null) throw e;
								await api("POST", `${base}/resolve`, { ...body, oneSided: true });
							}
						})}>
						<Icon name="land" />{act.busy ? "Landing…" : "Land this resolution"}
					</button>
					{blocked.length > 0 && <span className="hint" role="status">To land: {blocked.join(", and ")}.</span>}
				</div>
			</div>
		</section>
	);
}

function EditIntent({ intent, slug, done }: { intent: Intent; slug: string; done: () => void }) {
	const [title, setTitle] = useState(intent.title), [goal, setGoal] = useState(intent.goal), [acceptance, setAcceptance] = useState(intent.acceptance);
	const act = useAction();
	return (
		<form className="panel decide form edit-intent" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/p/${slug}/intents/${intent.id}/edit`, { title, goal, acceptance, by: "human" }))) done(); }}>
			<h3>Edit I{intent.id}</h3>
			<label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
			<label>Goal<textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} required /></label>
			<label>Done when <span className="optional">optional</span><textarea rows={2} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} /></label>
			<p className="hint">Agents working on this intent are told what changed.</p>
			{act.error && <Notice>{act.error}</Notice>}
			<div className="row"><button className="primary" disabled={act.busy || !title.trim() || !goal.trim()}>{act.busy ? "Saving…" : "Save changes"}</button><button type="button" onClick={done}>Cancel</button></div>
		</form>
	);
}

type TabId = "changes" | "checks" | "why" | "session" | "preview";
const WAITING = { verifying: "running the merge with trunk", locking: "regenerating the lockfile", pushing: "landing now", waiting: "waiting to land" } as const;

function AttemptColumn({ a, state, canLand }: { a: Attempt; state: State; canLand: boolean }) {
	const slug = state.project.slug;
	const { data: diff, error: diffError } = useAsync(() => api<DiffFile[]>("GET", `/p/${slug}/attempts/${a.id}/diff`), [a.id, a.headSha, a.baseSha]);
	const decisions = state.decisions.filter((d) => d.attemptId === a.id);
	const [tab, setTab] = useState<TabId>("changes");
	const key = state.previewKeys?.[a.id];
	const previewUrl = `/preview/${slug}/${a.id}${key ? `~${key}` : ""}/`;
	const [frame, setFrame] = useState(0);
	useEffect(() => setFrame((f) => f + 1), [a.headSha]);
	const land = useAction(), drop = useAction(), halt = useAction();
	const run = runFor(state, a.id);
	const going = LIVE.has(a.status), hostedGoing = a.hosted === "starting" || a.hosted === "running";
	const nothingPushed = a.headSha === a.baseSha;
	// The commit on screen is the one that lands: if the attempt has moved since, Braid refuses.
	const landIt = () => land.run(async () => {
		if (a.status === "working" && await ask({ title: `Land attempt ${a.id} as it is?`, body: <p>{a.agent} has not marked it ready, so it may be unfinished.</p>, confirm: "Land it" }) === null) return;
		try { await api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human", sha: a.headSha }); } catch (e) {
			// Landing something that did not pass needs a second, deliberate yes.
			if (!/with force/.test((e as Error).message)) throw e;
			if (await ask({ title: "Land it without a passing run?", body: <p>{(e as Error).message.replace(/[.;] [Ll]and it anyway with force$/, "")}.</p>, confirm: "Land it anyway", danger: true }) === null) throw e;
			await api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human", force: true, sha: a.headSha });
		}
	});
	const queued = state.queue.find((q) => q.attemptId === a.id);
	// A merge result only says something while trunk is still where the merge was made.
	const candidate = state.candidates.find((c) => c.attemptId === a.id && c.attemptSha === a.headSha && c.trunkSha === state.project.head);
	const mergeRun = candidate ? state.runs.find((r) => r.ref === `land:${a.id}` && r.sha === candidate.sha) ?? null : null;
	const failing = run?.status === "fail" && run.sha === a.headSha ? "the failed checks" : mergeRun?.status === "fail" ? "the merge with trunk" : null;
	const skipQueue = () => land.run(async () => {
		if (await ask({ title: `Land attempt ${a.id} now?`, body: <p>It lands without waiting for its run to finish, so trunk may take something that does not pass.</p>, confirm: "Land now", danger: true }) === null) return;
		await api("POST", `/p/${slug}/attempts/${a.id}/land`, { by: "human", force: true, sha: a.headSha });
	});
	const abandon = () => drop.run(async () => {
		if (await ask({ title: `Abandon attempt ${a.id}?`, body: <p>{hostedGoing ? `${a.agent} is running and will be stopped. ` : ""}You can reopen it while the intent is open.</p>, confirm: "Abandon attempt", danger: true }) === null) return;
		await api("POST", `/p/${slug}/attempts/${a.id}/abandon`, {});
	});
	const answered = new Set(decisions.filter((d) => d.kind === "answer").map((d) => d.title.replace(/^Answer: /, "")));
	const unanswered = going && decisions.some((d) => d.kind === "question" && !answered.has(d.title));
	const sessionLive = a.hosted ? hostedGoing : a.status === "working";
	const byId = new Map(state.attempts.map((x) => [x.id, x]));
	const collisions = state.overlaps.filter((o) => o.a === a.id || o.b === a.id).map((o) => ({ ...o, other: byId.get(o.a === a.id ? o.b : o.a)! })).filter((o) => o.other);
	const checkState = mergeRun?.status === "fail" ? "fail" : run && run.sha === a.headSha ? run.status : going ? "queued" : null;
	const tabs: Tab<TabId>[] = [
		{ id: "changes", label: "Changes", icon: "changes", badge: diff ? <span className="n">{diff.length}</span> : null },
		{ id: "checks", label: "Checks", icon: "check", badge: <>{!nothingPushed && checkState && <span className={`dot ${checkState}`} title={run ? `Braid's run: ${run.status}` : "Not run yet"} />}{collisions.length > 0 && <span className="n warn" title="Collisions with other attempts">{collisions.length}</span>}</> },
		{ id: "why", label: "Why", icon: "decision", badge: unanswered ? <span className="n ask" title="The agent asked a question">asks</span> : decisions.length > 0 ? <span className="n">{decisions.length}</span> : null },
		{ id: "session", label: "Session", icon: "terminal", badge: sessionLive ? <span className="dot running" title="The agent is working" /> : null },
		{ id: "preview", label: "Preview", icon: "eye" },
	];

	return (
		<section className={`panel attempt ${a.status}`} aria-label={`Attempt ${a.id} by ${a.agent}`}>
			<header className="attempt-head">
				<div className="attempt-top">
					<h2><Agent name={a.agent} kind={a.kind} model={a.model} /><span className="id">attempt <span className="mono">{a.id}</span></span></h2>
					<span className={`chip ${a.status}`}>{a.status}</span>
					<HostedChip a={a} />
					<span className="spacer" />
					<div className="attempt-actions">
						{!state.viewer && hostedGoing && <button disabled={halt.busy} onClick={() => halt.run(() => api("POST", `/p/${slug}/attempts/${a.id}/stop`, {}))}><Icon name="stop" />Stop agent</button>}
						{!state.viewer && going && <button className="quiet" disabled={drop.busy} onClick={abandon}>Abandon</button>}
						{a.status === "abandoned" && canLand && <button disabled={drop.busy} onClick={() => drop.run(() => api("POST", `/p/${slug}/attempts/${a.id}/restore`, {}))}><Icon name="undo" />Reopen</button>}
						{canLand && going && a.status !== "conflicted" && (
							<button className="primary" disabled={land.busy || !!queued || nothingPushed} onClick={landIt}>
								<Icon name="land" />{land.busy ? "Landing…" : queued ? "Waiting to land" : "Land this"}
							</button>
						)}
					</div>
				</div>
				{a.summary && <p className="attempt-summary">{a.summary}</p>}
				<p className="attempt-meta">
					<span title="The trunk commit it forked from, and the commit it is at now"><Icon name="fork" size={14} /><span className="mono">{short(a.baseSha)} → {short(a.headSha)}</span></span>
					<span><Icon name="clock" size={14} />updated {ago(a.updatedAt)}</span>
					{a.behind > 0 && going && <span title="Changes that landed on trunk after this attempt forked from it">{a.behind} landing{a.behind === 1 ? "" : "s"} behind trunk</span>}
				</p>
				{canLand && a.status === "conflicted" && <Notice tone="warn" small>This attempt collided with trunk when it tried to land. Resolve the conflict above and it lands.</Notice>}
				{canLand && going && a.status !== "conflicted" && nothingPushed && <p className="hint">Nothing has been pushed yet, so there is nothing to land.</p>}
				{(land.error || drop.error || halt.error) && <Notice>{land.error ?? drop.error ?? halt.error}</Notice>}
				{a.hosted === "failed" && <Notice tone="warn" small>The agent Braid was running failed: {a.hostedDetail}</Notice>}
				{queued && (
					<div className="landing-wait" role="status">
						<span className="chip working">{WAITING[queued.state]}</span>
						<span>Landing was asked for by {queued.by}{queued.note ? `: ${queued.note}. It lands by itself when that is done.` : "."}</span>
						{!state.viewer && queued.state !== "pushing" && <span className="row">
							<button disabled={land.busy} onClick={skipQueue}>Land now</button>
							<button disabled={drop.busy} onClick={() => drop.run(() => api("POST", `/p/${slug}/attempts/${a.id}/cancel-landing`, { by: "human" }))}>Cancel landing</button>
						</span>}
					</div>
				)}
				{!state.viewer && going && failing && !hostedGoing && state.project.hosting[a.kind === "codex" ? "codex" : "claude"] && (
					<p className="row"><button disabled={halt.busy} onClick={() => halt.run(() => api("POST", `/p/${slug}/attempts/${a.id}/rehost`, { task: "fix" }))}><Icon name="agent" />Have {a.agent} fix {failing}</button></p>
				)}
				{going && a.status !== "conflicted" && a.trunkConflicts.length > 0 && <Notice tone="warn" small>Landing now would conflict with trunk on <span className="mono">{a.trunkConflicts.join(", ")}</span>. Braid will open a reconciliation so you can resolve it.</Notice>}
			</header>

			<Tabs tabs={tabs} value={tab} onChange={setTab} label={`Attempt ${a.id}`} idBase={`a${a.id}`} />

			<div className="tabpanel" role="tabpanel" id={`a${a.id}-panel`} aria-labelledby={`a${a.id}-tab-${tab}`}>
				{tab === "changes" && <>
					{diffError && <Notice>{diffError}</Notice>}
					{!diff && !diffError && <Empty kind="loading" title="Loading the changes…" />}
					{diff?.length === 0 && (going
						? <Empty title="Nothing pushed yet"><p>The files this attempt changes against trunk appear here once the agent pushes.</p></Empty>
						: <Empty title="Nothing was pushed"><p>This attempt ended without changing any file.</p></Empty>)}
					{diff && diff.length > 0 && <p className="panel-lede">What this attempt changes, against the trunk commit it forked from.</p>}
					{diff?.map((f) => <FileDiff key={f.path + (f.head ?? "")} file={f} open={diff.length <= 3} />)}
				</>}

				{tab === "checks" && <>
					{nothingPushed && <Empty title={going ? "Nothing to run yet" : "Nothing was run"}><p>Braid runs every commit in a sandbox. {going ? "Nothing has been pushed, so nothing has been run." : "This attempt never pushed one."}</p></Empty>}
					{!nothingPushed && <>
						<h3>Run by Braid in a sandbox</h3>
						<Verification slug={slug} refName={a.id} run={run} head={a.headSha} readOnly={!!state.viewer} />
					</>}
					{going && candidate && mergeRun && <>
						<h3>Merged with trunk at <span className="mono">{short(candidate.trunkSha)}</span></h3>
						<Verification slug={slug} refName={`land:${a.id}`} run={mergeRun} head={candidate.sha} fixed />
					</>}
					{a.checks.length > 0 && <>
						<h3>Reported by the agent</h3>
						<ul className="checks">{a.checks.map((c) => <li key={c.name} className={c.status}><Icon name={c.status === "pass" ? "check" : "x"} label={c.status === "pass" ? "Passed" : "Failed"} /><span><strong>{c.name}</strong> <span className="dim">{c.detail}</span></span></li>)}</ul>
					</>}
					{collisions.length > 0 && <>
						<h3>Collisions with other attempts</h3>
						<ul className="collisions">
							{collisions.map((o) => {
								const theirs = state.decisions.filter((d) => d.attemptId === o.other.id && touches(d, o.path));
								const intent = state.intents.find((i) => i.id === o.other.intentId)!;
								return (
									<li key={`${o.a}${o.b}${o.path}`}>
										<span className={`chip ${o.severity}`}>{o.severity === "conflict" ? "will conflict" : o.severity === "touch" ? "same file, mergeable" : "both plan to change"}</span>
										<div>
											<p><span className="mono">{o.path}</span> with <Link to={`/p/${slug}/i/${intent.id}`}><span style={{ color: intentColor(intent.id), fontWeight: 600 }}>I{intent.id}</span> {intent.title}</Link> <span className="dim">({o.other.agent}, attempt {o.other.id})</span></p>
											{theirs.length > 0 && <p className="dim">Their reasoning: {theirs.map((d) => d.title).join("; ")}</p>}
										</div>
									</li>
								);
							})}
						</ul>
					</>}
				</>}

				{tab === "why" && <>
					{decisions.length > 0 && <p className="panel-lede">What {a.agent} decided, assumed, ruled out and asked while working, and what people told it.</p>}
					<Why decisions={decisions} empty="This agent has not recorded any decisions yet."
						answer={going && canLand ? (q, body) => api("POST", `/p/${slug}/attempts/${a.id}/respond`, { kind: "answer", question: q.id, body, by: "human", bringBack: !!a.hosted && !hostedGoing }) : undefined} />
				</>}

				{tab === "session" && <Session slug={slug} attemptId={a.id} decisions={decisions} live={sessionLive} />}

				{tab === "preview" && <>
					<div className="row preview-bar">
						<span className="dim">The attempt's app, running from {run?.preview && run.sha === a.headSha ? "the build Braid made of this commit" : "its repository"}. It cannot reach Braid as you.</span>
						<span className="spacer" />
						<a className="button" href={previewUrl} target="_blank" rel="noreferrer"><Icon name="external" />Open in a new tab</a>
					</div>
					<iframe key={frame} className="preview" src={previewUrl} title={`Preview of attempt ${a.id}`} sandbox="allow-scripts allow-forms allow-modals" />
				</>}
			</div>

			{going && canLand && <div className="respond-bar"><Respond a={a} state={state} /></div>}
		</section>
	);
}

const ORDER = (a: Attempt) => (a.status === "landed" ? 0 : LIVE.has(a.status) ? 1 : 2);

export function IntentPage({ state, intentId }: { state: State; intentId: number }) {
	const intent = state.intents.find((i) => i.id === intentId);
	const [joining, setJoining] = useState(false);
	useTitle(intent ? `I${intent.id} ${intent.title} · ${state.project.name}` : state.project.name);
	const edits = !state.viewer;
	const [editing, setEditing] = useState(false);
	const act = useAction();
	const slug = state.project.slug;
	if (!intent) return <main className="page narrow"><h1 className="sr-only">Intent not found</h1><Empty kind="broken" title={`There is no intent I${intentId} in this project`}><p><Link to={`/p/${slug}`} className="button"><Icon name="back" />Back to {state.project.name}</Link></p></Empty></main>;
	const attempts = state.attempts.filter((a) => a.intentId === intentId).sort((a, b) => ORDER(a) - ORDER(b));
	const recons = state.reconciliations.filter((r) => r.intentId === intentId);
	const landing = state.landings.find((l) => l.intentId === intentId && !l.revertOf && !l.revertedBy);
	const reverts = state.landings.filter((l) => l.intentId === intentId && l.revertOf);
	const liveCount = attempts.filter((a) => LIVE.has(a.status)).length;
	const abandon = () => act.run(async () => {
		if (await ask({ title: `Abandon I${intent.id}?`, body: <p>{liveCount > 0 ? `Its ${liveCount} attempt${liveCount === 1 ? "" : "s"} in progress ${liveCount === 1 ? "is" : "are"} abandoned too, and their agents stopped.` : "Nothing lands for it. Its attempts stay readable."}</p>, confirm: "Abandon intent", danger: true }) === null) return;
		await api("POST", `/p/${slug}/intents/${intent.id}/abandon`, {});
	});
	const revert = () => act.run(async () => {
		const reason = await ask({ title: `Take I${intent.id} back out of trunk?`, body: <p>Trunk gets a new commit that undoes it, and the intent opens again.</p>, confirm: "Revert landing", danger: true, input: { label: "Why? This is kept with the intent.", placeholder: "It broke…" } });
		if (!reason) return;
		await api("POST", `/p/${slug}/landings/${landing!.sha}/revert`, { by: "human", reason });
	});
	const open = intent.status === "open";
	return (
		<main className="page">
			<header className="ihead">
				<Link to={`/p/${slug}`} className="backlink"><Icon name="back" size={14} />{state.project.name}</Link>
				<div className="ihead-top">
					<h1><IntentId id={intent.id} /><span>{intent.title}</span></h1>
					<span className={`chip ${intent.status}`}>{intent.status}</span>
					<span className="spacer" />
					{edits && <div className="ihead-actions">
						{open && !editing && <button onClick={() => setEditing(true)}><Icon name="edit" />Edit</button>}
						{open && <button className="quiet" disabled={act.busy} onClick={abandon}>Abandon</button>}
						{landing && <button disabled={act.busy} onClick={revert}><Icon name="undo" />{act.busy ? "Reverting…" : "Revert landing"}</button>}
						{open && <button className="primary" onClick={() => setJoining(!joining)} aria-expanded={joining}><Icon name={joining ? "x" : "plus"} />{joining ? "Close" : "Add an agent"}</button>}
					</div>}
				</div>
				{act.error && <Notice>{act.error}</Notice>}
				{editing ? <EditIntent intent={intent} slug={slug} done={() => setEditing(false)} /> : (
					<div className="brief">
						<div><span className="label">Goal</span><p className="goal">{intent.goal}</p></div>
						{intent.acceptance && <div><span className="label">Done when</span><p className="goal">{intent.acceptance}</p></div>}
					</div>
				)}
				{reverts.map((r) => <Notice key={r.sha} tone="warn" small>A landing of this intent was taken back out of trunk as <span className="mono">{short(r.sha)}</span> by {r.agent}, {ago(r.at)}. The reason is in that attempt's decisions.</Notice>)}
				{landing && (
					<div className="landed-note">
						<Icon name="land" />
						<p>Landed on trunk as <span className="mono">{short(landing.sha)}</span> from attempt {landing.attemptId} by {landing.agent}, {ago(landing.at)}. <Link to={`/p/${slug}/why?path=${encodeURIComponent(landing.files[0] ?? "")}`}>See it in the code</Link>
							{state.project.contextRemote && <span className="dim context"> Its decisions and session transcript are committed to the context repository, <span className="mono">{state.project.contextRemote}</span>, under <span className="mono">intents/{intent.id}/</span>.</span>}</p>
					</div>
				)}
				{joining && <JoinCommand slug={slug} intentId={intent.id} hosting={state.project.hosting} />}
				{attempts.length > 0 && <div className="ihead-loom"><span className="label">This intent against trunk</span><MiniLoom state={state} intentId={intent.id} /></div>}
			</header>
			{recons.filter((r) => r.status !== "resolved").map((r) => <ReconPanel key={r.id} r={r} state={state} />)}
			<div className="section-head"><h2>Attempts{attempts.length > 0 && <span className="count">{attempts.length}</span>}</h2>{attempts.length > 1 && <span className="dim">Each is one agent's try at this goal. Compare them, then land one.</span>}</div>
			{attempts.length === 0 && (
				<Empty title="No attempts yet">
					<p>{open ? "Add an agent to start one. Add several to compare approaches." : "This intent was closed before any agent attempted it."}</p>
					{edits && open && !joining && <p><button className="primary" onClick={() => setJoining(true)}><Icon name="plus" />Add an agent</button></p>}
				</Empty>
			)}
			<div className={`compare n${Math.min(attempts.length, 2)}`}>
				{attempts.map((a) => <AttemptColumn key={a.id} a={a} state={state} canLand={edits && open} />)}
			</div>
			{recons.filter((r) => r.status === "resolved").map((r) => <ReconPanel key={r.id} r={r} state={state} />)}
		</main>
	);
}
