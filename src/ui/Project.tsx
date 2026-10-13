import { RunChip, runFor, Verification } from "./Verify";
import { useState, type FormEvent } from "react";
import type { Attempt, Intent, State } from "../shared/types";
import { api, ago, short, useNow } from "./api";
import { Agent, IntentId, Link, useAction, useSignedIn as useMe, useTitle } from "./App";
import { batchFor, LandingQueue, queueLabel } from "./Batch";
import { Braid } from "./Braid";
import { DeleteProject } from "./DeleteProject";
import { Empty, MiniLoom } from "./Graphics";
import { ask, Command, Icon, Notice, type IconName } from "./Kit";
import { isRace, raceNeed, raceUnderWay, RaceLine, StartRace } from "./Race";
import { ClashRow, clashes, plannerOf, Proposals, SplitGoal, StandingLines } from "./Plan";
import { landingVerdict, neverStarted, reason, sentence, stuckOf, stuckWords } from "./Later";
import { currentReview, flagsOf, PolicyPanel, policyOf, reviewTag, tally } from "./Review";

const LIVE = new Set(["working", "ready", "conflicted"]);

/** The two ways to put an agent on an intent: Braid runs it in a sandbox, or you run it where you like. */
export function JoinCommand({ slug, intentId, hosting, state }: { slug: string; intentId: number; hosting: State["project"]["hosting"]; /** With the state, starting several agents at once is offered too. */ state?: State }) {
	const [agent, setAgent] = useState("claude-code");
	const start = useAction();
	// The request answers as soon as the attempt exists; the sandbox starts afterwards and the attempt's row says how that went.
	const [asked, setAsked] = useState<string | null>(null);
	const run = (kind: "claude" | "codex") => { setAsked(null); return start.run(async () => { await api("POST", `/p/${slug}/intents/${intentId}/host`, { kind }); setAsked(kind === "claude" ? "Claude Code" : "Codex"); }); };
	const me = useMe();
	// The launcher is one file served by this instance, so nothing has to be installed or published.
	const cmd = `curl -fsSLO ${location.origin}/braid.mjs\nnode braid.mjs join ${location.origin}/p/${slug} --intent ${intentId} --agent ${agent}${agent === "agent" ? "" : " --run"}`;
	return (
		<div className="join">
			{hosting.available && (
				<div className="join-way">
					<h4><Icon name="sandbox" />Run an agent here</h4>
					<p className="dim">Braid starts it in a sandbox on Cloudflare with a fresh fork of trunk, Braid's tools, and network access to this project and its model only.</p>
					<div className="row">
						<button className="primary" disabled={start.busy || !hosting.claude} onClick={() => run("claude")}>Run Claude Code</button>
						<button className="primary" disabled={start.busy || !hosting.codex} onClick={() => run("codex")}>Run Codex</button>
						{start.busy && <span className="dim" role="status">Asking…</span>}
					</div>
					{(!hosting.claude || !hosting.codex) && <p className="hint">{!hosting.claude && !hosting.codex ? "Neither can start: no model credentials are set on this instance." : `${hosting.claude ? "Codex" : "Claude Code"} cannot start: this instance has no credentials for it.`}</p>}
					{start.error && <Notice>{start.error}</Notice>}
					{asked && !start.busy && <p className="sent" role="status"><Icon name="check" />A new attempt was made for {asked} and its sandbox is starting. It is listed with this intent's attempts, which also say so if it could not start.</p>}
				</div>
			)}
			{hosting.available && state && !state.viewer && <StartRace state={state} intentId={intentId} />}
			<div className="join-way">
				<h4><Icon name="terminal" />{hosting.available ? "Or run one yourself" : "Run an agent yourself"}</h4>
				<p className="dim">Run this where the agent should work. It forks trunk into a new Artifacts repository, clones it, connects the agent to Braid over MCP{agent === "agent" ? ", and prints the directory to start your agent in" : ", and starts it"}. Needs Node 22.18 or newer and git.{me?.protected ? <> Set <code>BRAID_ADMIN_TOKEN</code> to this instance's admin token first.</> : ""}</p>
				<label className="inline">Agent
					<select value={agent} onChange={(e) => setAgent(e.target.value)}>
						<option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="agent">Another agent</option>
					</select>
				</label>
				<Command text={cmd} label="Copy command" />
			</div>
		</div>
	);
}

/** Where Braid itself is running the agent, and how that is going. */
export function HostedChip({ a }: { a: Attempt }) {
	if (!a.hosted) return null;
	return <span className={`chip ${a.hosted === "failed" ? "conflict" : a.hosted === "running" || a.hosted === "starting" ? "working" : "quiet"}`} title={a.hostedDetail || "Braid runs this agent in a sandbox on Cloudflare"}>{neverStarted(a) ? "agent did not start" : `sandbox ${a.hosted}`}</span>;
}

/** Trunk itself: where it is, how its last run went, and how to clone it (or fill it, when it is empty). */
function Trunk({ state }: { state: State }) {
	const { slug, remote, branch, head } = state.project;
	const [cmd, setCmd] = useState<string | null>(null);
	const act = useAction();
	const make = (push: boolean) => act.run(async () => {
		const c = await api<{ remote: string; branch: string; gitToken: string }>("POST", `/p/${slug}/${push ? "trunk" : "clone"}-credentials`, {});
		const auth = `git -c http.extraHeader="Authorization: Bearer ${c.gitToken}"`;
		setCmd(push ? `${auth} push ${c.remote} HEAD:refs/heads/${c.branch}` : `${auth} clone ${c.remote} ${slug}`);
	});
	const run = runFor(state, "trunk");
	return (
		<section className="panel side-panel" id="trunk" aria-labelledby="trunk-h">
			<h2 id="trunk-h" className="label">Trunk</h2>
			{head ? <>
				<p>The branch <span className="mono">{branch}</span> of a git repository on Cloudflare Artifacts, at <span className="mono">{short(head)}</span>.</p>
				<details className="disclose" open={run?.status === "fail" && run.sha === head}>
					<summary>Braid's run of this commit <RunChip run={run} head={head} /></summary>
					<Verification slug={slug} refName="trunk" run={run} head={head} readOnly={!!state.viewer} />
				</details>
			</> : <p>Trunk is empty. Run the push command in the repository whose HEAD should become trunk.</p>}
			<p className="mono remote" title="Trunk's git remote">{remote}</p>
			{!state.viewer && !cmd && <button disabled={act.busy} onClick={() => make(!head)}><Icon name={head ? "copy" : "push"} />{act.busy ? "Making the command…" : head ? "Make a clone command" : "Make a push command"}</button>}
			{cmd && <><Command text={cmd} label="Copy command" /><p className="hint">It carries a {head ? "read token that works for an hour" : "write token that works for 15 minutes"}. Do not share it.</p></>}
			{act.error && <Notice>{act.error}</Notice>}
		</section>
	);
}

type Need = { key: string; tone: string; icon: IconName; label: string; text: string; to: string; stuck?: State["stuck"][number]; clash?: ReturnType<typeof clashes>[number] };
/** Everything in the project that is waiting for a person, most urgent first. Each item goes to where it is handled. */
function needs(state: State): Need[] {
	const slug = state.project.slug, to = (intentId: number) => `/p/${slug}/i/${intentId}`;
	const live = state.attempts.filter((a) => LIVE.has(a.status));
	const items: Need[] = [];
	const auto = policyOf(state).landing === "auto";
	const trunkRun = runFor(state, "trunk");
	if (trunkRun?.sha === state.project.head && trunkRun.status === "fail") items.push({ key: "trunk", tone: "conflict", icon: "warning", label: "trunk is failing", text: `Braid's run of ${short(state.project.head)} failed (${trunkRun.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}). Only an attempt that fixes it will land.`, to: "#trunk" });
	// Work Braid gave up on comes first: until it is tried again, other things here may not move.
	for (const e of stuckOf(state)) {
		const a = e.attemptId ? state.attempts.find((x) => x.id === e.attemptId) : undefined;
		items.push({ key: `s${e.id}`, tone: "conflict", icon: "warning", label: "braid is stuck", text: stuckWords(e.type, e.attemptId).what, to: a ? to(a.intentId) : "", stuck: e });
	}
	// Intents that cannot all land: one thing to decide per group, before agents spend work on both sides.
	// A race is one thing to decide, not one per attempt: it is listed once, and only when it is waiting for a person.
	const raced = new Set<number>();
	for (const i of state.intents.filter((i) => i.status === "open" && isRace(state, i.id))) {
		const need = raceNeed(state, i);
		if (raceUnderWay(state, i)) raced.add(i.id);
		if (need) { raced.add(i.id); items.push({ key: `race${i.id}`, tone: need.tone, icon: need.icon, label: need.label, text: need.text, to: `${to(i.id)}#compare` }); }
	}
	for (const g of clashes(state)) items.push({ key: `c${g.key}`, tone: "conflict", icon: "conflict", label: "intents clash", text: "", to: "", clash: g });
	for (const r of state.reconciliations.filter((r) => r.status === "open")) {
		const a = state.attempts.find((x) => x.id === r.attemptId);
		if (a && LIVE.has(a.status)) items.push({ key: `r${r.id}`, tone: "conflict", icon: "conflict", label: "conflict to resolve", text: `Landing ${a.agent}'s attempt ${a.id} collided with trunk on ${r.conflicts.map((c) => c.path).join(", ")}.`, to: to(r.intentId) });
	}
	for (const a of live) {
		const asked = state.decisions.filter((d) => d.attemptId === a.id && d.kind === "question");
		const answered = new Set(state.decisions.filter((d) => d.attemptId === a.id && d.kind === "answer").map((d) => d.title.replace(/^Answer: /, "")));
		for (const q of asked.filter((q) => !answered.has(q.title))) items.push({ key: `q${q.id}`, tone: "touch", icon: "question", label: "question for you", text: `${a.agent} asks: ${q.title}`, to: to(a.intentId) });
		const run = runFor(state, a.id), queued = state.queue.some((q) => q.attemptId === a.id), verdict = landingVerdict(state, a);
		if (verdict?.outcome === "refused") items.push({ key: `n${verdict.id}`, tone: "conflict", icon: "land", label: "landing refused", text: `${a.agent}'s attempt ${a.id} did not land. ${reason(verdict.text)}`, to: to(a.intentId) });
		if (run?.sha === a.headSha && run.status === "fail") items.push({ key: `f${a.id}`, tone: "conflict", icon: "x", label: "checks failed", text: `${a.agent}'s attempt ${a.id} failed ${run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}.`, to: to(a.intentId) });
		else if (a.hosted === "failed") items.push({ key: `h${a.id}`, tone: "conflict", icon: "agent", label: neverStarted(a) ? "agent did not start" : "agent failed", text: neverStarted(a) ? `Braid could not start ${a.agent} on attempt ${a.id}. ${neverStarted(a)}` : `${a.agent} on attempt ${a.id}: ${a.hostedDetail}`, to: to(a.intentId) });
		else if (a.status === "ready" && !queued && verdict?.outcome !== "refused") {
			const who = `${a.agent}'s attempt ${a.id}`, flags = flagsOf(a), rv = currentReview(state, a), held = auto ? a.held ?? "" : "";
			// Under a policy that lands by itself, an attempt it is about to land, or is still waiting on checks or a review for, is not a person's yet.
			// So is one waiting for another intent to land first. One whose intent contradicts another is already listed above, as the clash.
			if (auto && (!held || a.heldFor === "checks" || a.heldFor === "review" || a.heldFor === "dependency" || a.heldFor === "contradiction" || a.heldFor === "race")) continue;
			// An attempt in a race that is already listed above, or that the decision model is holding, is covered by the race's own line.
			if (raced.has(a.intentId) || a.heldFor === "signal") continue;
			if (flags.length) items.push({ key: `g${a.id}`, tone: "touch", icon: "warning", label: "flagged for you", text: `${who}: ${sentence(flags[0].text)}${flags.length > 1 ? ` And ${flags.length - 1} more.` : ""}`, to: to(a.intentId) });
			else if (auto) items.push({ key: `p${a.id}`, tone: "touch", icon: "agent", label: a.heldFor === "choice" ? "pick an attempt" : a.heldFor === "review-failed" ? "review failed" : a.heldFor === "reviewer" ? "reviewer: your call" : a.heldFor === "question" ? "question waiting" : a.heldFor === "landing" ? "landing stopped" : a.heldFor === "checks-failed" ? "checks failed" : "not landed by braid", text: `${who} was not landed by Braid. ${sentence(held)}`, to: to(a.intentId) });
			else if (rv?.verdict === "approve") items.push({ key: `l${a.id}`, tone: "ready", icon: "check", label: "review passed", text: `${who} meets ${tally(rv).of === 1 ? "its criterion" : `all ${tally(rv).of} criteria`}. ${a.summary || rv.summary}`, to: to(a.intentId) });
			else if (rv?.verdict === "changes") items.push({ key: `l${a.id}`, tone: "touch", icon: "search", label: "changes asked", text: `${who}: the reviewer asks for changes. ${rv.changes || rv.summary}`, to: to(a.intentId) });
			else if (rv?.verdict === "person") items.push({ key: `l${a.id}`, tone: "touch", icon: "search", label: "reviewer: your call", text: `${who}: ${rv.summary || "the reviewer leaves it to a person."}`, to: to(a.intentId) });
			else items.push({ key: `l${a.id}`, tone: "ready", icon: "check", label: "ready to review", text: `${who}: ${a.summary || "marked ready"}`, to: to(a.intentId) });
		}
	}
	return items;
}

/** Work Braid gave up on: what it could not do, what that means, the error, and a way to have it tried again. */
function StuckRow({ item, state }: { item: Need; state: State }) {
	const e = item.stuck!, slug = state.project.slug;
	const act = useAction();
	const [again, setAgain] = useState(false);
	const words = stuckWords(e.type, e.attemptId);
	return (
		<div className="needs-row stuck">
			<span className={`chip ${item.tone}`}><Icon name={item.icon} size={12} />{item.label}</span>
			<div className="needs-text">
				<p><strong>{words.what}</strong> {words.means}</p>
				<p className="stuck-error"><span className="label">Error after {e.tries} tr{e.tries === 1 ? "y" : "ies"}, {ago(e.at)}</span><span className="mono">{e.error || "No message was recorded."}</span></p>
				{item.to && <p><Link to={item.to}>Open attempt {e.attemptId}'s intent</Link></p>}
				{act.error && <Notice small>{act.error}</Notice>}
			</div>
			{!state.viewer && (
				<button disabled={act.busy || again} onClick={async () => { if (await act.run(() => api("POST", `/p/${slug}/effects/retry`, { id: e.id }))) { setAgain(true); window.setTimeout(() => setAgain(false), 20_000); } }}>
					<Icon name={act.busy || again ? "running" : "undo"} className={act.busy || again ? "spin" : ""} />{act.busy ? "Asking…" : again ? "Trying again…" : "Try again"}
				</button>
			)}
		</div>
	);
}

function NeedsYou({ items, state }: { items: Need[]; state: State }) {
	if (!items.length) return null;
	return (
		<section className="panel decide needs" aria-labelledby="needs-h">
			<h2 id="needs-h"><span className="count solid">{items.length}</span>{items.length === 1 ? "One thing needs you" : "Things that need you"}</h2>
			<ul>
				{items.map((i) => {
					if (i.stuck) return <li key={i.key}><StuckRow item={i} state={state} /></li>;
					if (i.clash) return <li key={i.key}><ClashRow state={state} group={i.clash} /></li>;
					const inner = <><span className={`chip ${i.tone}`}><Icon name={i.icon} size={12} />{i.label}</span><span className="needs-text">{i.text}</span><Icon name="arrow" className="go" /></>;
					return <li key={i.key}>{i.to.startsWith("#") ? <a href={i.to}>{inner}</a> : <Link to={i.to}>{inner}</Link>}</li>;
				})}
			</ul>
		</section>
	);
}

/** Lets the owner open the project to anyone with the link, read-only. Off until someone turns it on. */
function Visibility({ state }: { state: State }) {
	const act = useAction();
	const { slug, public: open } = state.project;
	const toggle = () => act.run(async () => {
		if (!open && await ask({ title: "Make this project public?", body: <p>Anyone with the link will be able to read it without signing in: its intents, code, decisions, agent sessions and previews. They cannot change anything.</p>, confirm: "Make it public" }) === null) return;
		await api("POST", `/p/${slug}/public`, { public: !open, by: "human" });
	});
	return (
		<section className="panel side-panel" aria-labelledby="vis-h">
			<h2 id="vis-h" className="label">Who can read this</h2>
			<p className="row"><Icon name={open ? "globe" : "lock"} />{open ? "Anyone with the link, without signing in." : "Only people with the admin token."}</p>
			{open && <p className="mono remote">{location.origin}/p/{slug}</p>}
			<button disabled={act.busy} onClick={toggle}>{open ? "Make it private" : "Make it public (read-only)"}</button>
			{act.error && <Notice>{act.error}</Notice>}
		</section>
	);
}

function AttemptRow({ a, state }: { a: Attempt; state: State }) {
	const mine = state.overlaps.filter((o) => o.a === a.id || o.b === a.id);
	const conflicts = new Set(mine.filter((o) => o.severity === "conflict").map((o) => (o.a === a.id ? o.b : o.a)));
	const touches = new Set(mine.filter((o) => o.severity !== "conflict").map((o) => (o.a === a.id ? o.b : o.a)).filter((id) => !conflicts.has(id)));
	const decisions = state.decisions.filter((d) => d.attemptId === a.id).length;
	const now = useNow(a.id, a.now);
	const going = LIVE.has(a.status);
	const queued = state.queue.find((q) => q.attemptId === a.id);
	const batch = batchFor(state, a.id)?.batch;
	const verdict = landingVerdict(state, a);
	const flags = going ? flagsOf(a) : [], tag = reviewTag(state, a);
	return (
		<li className={`attempt-row ${a.status}`}>
			<span className="who"><Agent name={a.agent} kind={a.kind} model={a.model} /><span className="mono id" title={`Attempt ${a.id}`}>{a.id}</span></span>
			<span className="state"><span className={`chip ${queued ? (batch?.state === "splitting" ? "conflict" : "working") : a.status}`} title={queued ? (batch && batch.members.length > 1 ? `In a batch with attempts ${batch.members.filter((m) => m !== a.id).join(", ")}; see the landing queue above` : queued.note) : undefined}>{queued ? queueLabel(state, queued) : a.status}</span><HostedChip a={a} /></span>
			<span className="what">
				{a.status === "working" && now ? <span className="now mono" title={now.text}>{now.tool ? `${now.tool}: ` : ""}{now.text.split("\n")[0].slice(0, 140)}</span>
					: <span className="summary">{a.summary || (a.headSha === a.baseSha ? "Nothing pushed yet." : "No summary yet.")}</span>}
				<span className="facts">{a.files.length} file{a.files.length === 1 ? "" : "s"} changed · {decisions} decision{decisions === 1 ? "" : "s"} recorded</span>
				{going && !queued && policyOf(state).landing === "auto" && a.held && <span className="facts held-line"><Icon name={a.heldFor === "checks" || a.heldFor === "review" || a.heldFor === "dependency" || a.heldFor === "race" ? "clock" : "agent"} size={12} />{a.heldFor === "checks" || a.heldFor === "review" || a.heldFor === "dependency" || a.heldFor === "race" ? "Braid lands it by itself: " : "Not landed by Braid: "}{sentence(a.held).replace(/^./, (c) => c.toLowerCase())}</span>}
			</span>
			<span className="signals">
				{flags.length > 0 && <span className="chip flagged" title={flags.map((f) => f.text).join(" ")}><Icon name="warning" size={12} />{flags.length} flag{flags.length === 1 ? "" : "s"}</span>}
				{tag && going && <span className={`chip ${tag.tone}`} title={tag.title}>{tag.text}</span>}
				{verdict?.outcome === "refused" && <span className="chip conflict" title={reason(verdict.text)}>landing refused</span>}
				{going && <RunChip run={runFor(state, a.id)} head={a.headSha} />}
				{going && a.behind > 0 && <span className="chip quiet" title="Changes that landed on trunk after this attempt forked from it">{a.behind} behind trunk</span>}
				{going && a.trunkConflicts.length > 0 && <span className="chip conflict" title={a.trunkConflicts.join(", ")}>conflicts with trunk</span>}
				{conflicts.size > 0 && <span className="chip conflict">will conflict with {[...conflicts].join(", ")}</span>}
				{touches.size > 0 && <span className="chip touch">same files as {[...touches].join(", ")}</span>}
			</span>
		</li>
	);
}

function IntentCard({ intent, state }: { intent: Intent; state: State }) {
	const attempts = state.attempts.filter((a) => a.intentId === intent.id);
	const [joining, setJoining] = useState(false);
	const to = `/p/${state.project.slug}/i/${intent.id}`;
	return (
		<section className={`panel intent ${intent.status}`} aria-label={`Intent ${intent.id}: ${intent.title}`}>
			<div className="intent-top">
				<div className="intent-line">
					<Link to={to} className="intent-title"><IntentId id={intent.id} /><span>{intent.title}</span></Link>
					{intent.status === "landed" ? <span className="chip landed">landed <span className="mono">{short(intent.landedSha!)}</span></span> : <span className={`chip ${intent.status}`}>{intent.status}</span>}
				</div>
				<p className="goal">{intent.goal}</p>
				{attempts.length > 0 && <MiniLoom state={state} intentId={intent.id} className="spark" />}
				{intent.status === "open" && <StandingLines state={state} intent={intent} />}
				<RaceLine state={state} intent={intent} />
			</div>
			{attempts.length > 0 && <ul className="attempts">{attempts.map((a) => <AttemptRow key={a.id} a={a} state={state} />)}</ul>}
			<div className="intent-foot">
				{attempts.length === 0 && <span className="dim">{intent.status === "open" ? "No agent has attempted this yet." : "Closed without an attempt."}</span>}
				{attempts.length > 0 && <Link to={to} className="button"><Icon name="arrow" />{intent.status !== "open" ? "Open" : attempts.length > 1 ? `Compare ${attempts.length} attempts` : "Review the attempt"}</Link>}
				{intent.status === "open" && !state.viewer && <button onClick={() => setJoining(!joining)} aria-expanded={joining}><Icon name={joining ? "x" : "plus"} />{joining ? "Close" : "Add an agent"}</button>}
			</div>
			{joining && <JoinCommand slug={state.project.slug} intentId={intent.id} hosting={state.project.hosting} state={state} />}
		</section>
	);
}

function NewIntent({ slug, close }: { slug: string; close: () => void }) {
	const [f, setF] = useState({ title: "", goal: "", acceptance: "" });
	const create = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (await create.run(() => api("POST", `/p/${slug}/intents`, { ...f, by: "human" }))) close();
	};
	return (
		<form className="panel decide form" onSubmit={submit}>
			<h3>New intent</h3>
			<p className="dim">A goal, stated once. It replaces the issue, the branch and the pull request; agents read it as their brief.</p>
			<label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Add a dark mode" required autoFocus /></label>
			<label>Goal<textarea value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} placeholder="What should be true when this is done, and for whom" required rows={2} /></label>
			<label>Done when <span className="optional">optional</span><textarea value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} placeholder="How a reviewer can tell it is done" rows={2} /></label>
			{create.error && <Notice>{create.error}</Notice>}
			<div className="row"><button className="primary" disabled={create.busy}>{create.busy ? "Opening…" : "Open intent"}</button><button type="button" onClick={close}>Cancel</button></div>
		</form>
	);
}

const ICON: Record<string, IconName> = { land: "land", conflict: "conflict", overlap: "overlap", why: "decision", push: "push", claim: "claim", ready: "check", reconcile: "reconcile", message: "message", intent: "intent", attempt: "fork", check: "check", project: "dot", compare: "strands", plan: "search", feedback: "feedback", revert: "undo" };

export function ProjectPage({ state }: { state: State }) {
	const open = state.intents.filter((i) => i.status === "open"), done = state.intents.filter((i) => i.status !== "open");
	const me = useMe();
	const [shown, setShown] = useState(20);
	const [adding, setAdding] = useState(false);
	const [splitting, setSplitting] = useState(false);
	useTitle(state.project.name);
	const items = needs(state);
	const live = state.attempts.filter((a) => LIVE.has(a.status)).length;
	const landed = state.landings.filter((l) => !l.revertOf && !l.revertedBy).length;
	return (
		<main className="page">
			<header className="phead">
				<div>
					<h1>{state.project.name}{state.project.public && <span className="chip quiet"><Icon name="globe" size={12} />public</span>}</h1>
					{state.project.description && <p className="lede">{state.project.description}</p>}
				</div>
				<dl className="stats">
					<div><dt>Open intents</dt><dd>{open.length}</dd></div>
					<div><dt>Attempts in progress</dt><dd>{live}</dd></div>
					<div><dt>Landed on trunk</dt><dd>{landed}</dd></div>
					<div className={items.length ? "hot" : ""}><dt>Need you</dt><dd>{items.length}</dd></div>
				</dl>
			</header>
			{!state.project.head && <Notice tone="warn">Trunk is empty. Push a repository into it before starting attempts: <a href="#trunk">make a push command</a>.</Notice>}
			<NeedsYou items={items} state={state} />
			<LandingQueue state={state} />
			<Braid state={state} />
			<div className="columns">
				<div className="col-main">
					<div className="section-head">
						<h2>Intents{state.intents.length > 0 && <span className="count">{open.length} open</span>}</h2>
						{!state.viewer && !adding && !splitting && <span className="row section-actions">
							{plannerOf(state) && <button onClick={() => setSplitting(true)} title="Write a broad goal and have it split into intents for you to accept"><Icon name="fork" />Split a goal</button>}
							<button className="primary" onClick={() => setAdding(true)}><Icon name="plus" />New intent</button>
						</span>}
					</div>
					{adding && <NewIntent slug={state.project.slug} close={() => setAdding(false)} />}
					{splitting && <SplitGoal state={state} close={() => setSplitting(false)} />}
					<Proposals state={state} />
					{state.intents.length === 0 && !adding && (
						<Empty title="No intents yet">
							<p>An intent is a goal, stated once. Agents attempt it; you choose what lands.</p>
							{!state.viewer && <p><button className="primary" onClick={() => setAdding(true)}><Icon name="plus" />New intent</button></p>}
						</Empty>
					)}
					{state.intents.length > 0 && open.length === 0 && !adding && <Empty kind="done" title="Nothing open">{!state.viewer && <p>Every intent has landed or been closed. <button className="link" onClick={() => setAdding(true)}>Open a new one</button></p>}</Empty>}
					{open.map((i) => <IntentCard key={i.id} intent={i} state={state} />)}
					{done.length > 0 && <h3 className="label closed-label">Closed <span className="count">{done.length}</span></h3>}
					{done.map((i) => <IntentCard key={i.id} intent={i} state={state} />)}
				</div>
				<aside className="col-side">
					<PolicyPanel state={state} />
					<Trunk state={state} />
					{!state.viewer && me?.protected && <Visibility state={state} />}
					<section className="panel side-panel" aria-labelledby="act-h">
						<h2 id="act-h" className="label">Activity</h2>
						{state.activity.length === 0 && <p className="dim">Nothing has happened yet.</p>}
						<ol className="activity">
							{state.activity.slice(0, shown).map((e) => (
								<li key={e.id} className={e.kind}>
									<Icon name={ICON[e.kind] ?? "dot"} />
									<span className="act-text">{e.intentId ? <Link to={`/p/${state.project.slug}/i/${e.intentId}`}>{e.text}</Link> : e.text}{e.actor === "policy" && <span className="act-by" title="Braid did this itself, under this project's landing policy"> by Braid's policy</span>}{e.actor === "reviewer" && <span className="act-by" title="Done by the reviewer, a model"> by the reviewer</span>}</span>
									<time className="act-time" dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>{ago(e.at).replace(" ago", "")}</time>
								</li>
							))}
						</ol>
						{state.activity.length > shown && <button onClick={() => setShown(shown + 60)}>Show older activity ({state.activity.length - shown} more)</button>}
					</section>
				</aside>
			</div>
			{!state.viewer && <DeleteProject state={state} />}
		</main>
	);
}
