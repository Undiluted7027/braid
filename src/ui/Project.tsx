import { RunChip, runFor } from "./Verify";
import { useState, type FormEvent } from "react";
import type { Attempt, Intent, State } from "../shared/types";
import { api, ago, intentColor, short, useNow } from "./api";
import { Link, useAction, useSignedIn as useMe, useTitle } from "./App";
import { Braid } from "./Braid";
import { DeleteProject } from "./DeleteProject";

const LIVE = new Set(["working", "ready", "conflicted"]);

export function JoinCommand({ slug, intentId, hosting }: { slug: string; intentId: number; hosting: State["project"]["hosting"] }) {
	const [agent, setAgent] = useState("claude-code");
	const start = useAction();
	const run = (kind: "claude" | "codex") => start.run(() => api("POST", `/p/${slug}/intents/${intentId}/host`, { kind }));
	const me = useMe();
	// The launcher is one file served by this instance, so nothing has to be installed or published.
	const cmd = `curl -fsSLO ${location.origin}/braid.mjs\nnode braid.mjs join ${location.origin}/p/${slug} --intent ${intentId} --agent ${agent}${agent === "agent" ? "" : " --run"}`;
	const [copied, setCopied] = useState(false);
	return (
		<div className="join">
			{hosting.available && <>
				<p className="small">Run an agent here, in a sandbox on Cloudflare. It gets a fresh fork of trunk, Braid's tools, and network access to this project and its model only.</p>
				<div className="row">
					<button className="primary" disabled={start.busy || !hosting.claude} onClick={() => run("claude")}>Run Claude Code</button>
					<button className="primary" disabled={start.busy || !hosting.codex} onClick={() => run("codex")}>Run Codex</button>
					{start.busy && <span className="dim small">Starting…</span>}
					{(!hosting.claude || !hosting.codex) && <span className="dim small">{!hosting.claude && !hosting.codex ? "No model credentials are set on this instance." : `No credentials for ${hosting.claude ? "Codex" : "Claude Code"}.`}</span>}
				</div>
				{start.error && <p className="error">{start.error}</p>}
				<p className="small join-or">Or run one yourself:</p>
			</>}
			<p className="small">Run this where the agent should work (needs Node 22.18 or newer and git). It forks trunk into a new Artifacts repo, clones it, connects the agent to Braid over MCP{agent === "agent" ? ", and prints the directory to start your agent in" : ", and starts it"}.{me?.protected ? <> Set <code>BRAID_ADMIN_TOKEN</code> to this instance's admin token first.</> : ""}</p>
			<div className="row">
				<select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
					<option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="agent">Other</option>
				</select>
				<code className="cmd multi">{cmd}</code>
				<button onClick={() => { navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
			</div>
		</div>
	);
}

/** Where Braid itself is running the agent, and how that is going. */
export function HostedChip({ a }: { a: Attempt }) {
	if (!a.hosted) return null;
	const going = a.hosted === "starting" || a.hosted === "running";
	return <span className={`chip ${a.hosted === "failed" ? "conflict" : "quiet"}`} title={a.hostedDetail || "Braid runs this agent in a sandbox on Cloudflare"}>{going ? `sandbox ${a.hosted}` : `sandbox ${a.hosted}`}</span>;
}

/** A command with a button that copies it. */
function Command({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState(false);
	const copy = async () => {
		setError(false);
		try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError(true); }
	};
	return (
		<>
			<div className="row"><code className="cmd multi">{text}</code><button onClick={copy} aria-label={label}>{copied ? "Copied" : "Copy"}</button></div>
			{error && <p className="error" role="alert">Could not copy. Select the text above.</p>}
		</>
	);
}

/** Cloning needs a credential, so the command is made on request with a read token that lasts an hour. */
function TrunkRemote({ state }: { state: State }) {
	const { slug, remote, branch, head } = state.project;
	const [cmd, setCmd] = useState<string | null>(null);
	const act = useAction();
	const make = (push: boolean) => act.run(async () => {
		const c = await api<{ remote: string; branch: string; gitToken: string }>("POST", `/p/${slug}/${push ? "trunk" : "clone"}-credentials`, {});
		const auth = `git -c http.extraHeader="Authorization: Bearer ${c.gitToken}"`;
		setCmd(push ? `${auth} push ${c.remote} HEAD:refs/heads/${c.branch}` : `${auth} clone ${c.remote} ${slug}`);
	});
	return (
		<section className="card">
			<h2>{head ? "Clone trunk" : "Push a repository"}</h2>
			<p className="small dim">{head ? <>Trunk is a git repository on Cloudflare Artifacts, branch <span className="mono">{branch}</span>.</> : "Trunk is empty. Run the command in the repository whose HEAD should become trunk."}</p>
			<p className="mono small remote">{remote}</p>
			{!state.viewer && !cmd && <button disabled={act.busy} onClick={() => make(!head)}>{act.busy ? "Making…" : head ? "Make a clone command" : "Make a push command"}</button>}
			{cmd && <><Command text={cmd} label="Copy the command" /><p className="small dim">It carries a {head ? "read token that works for an hour" : "write token that works for 15 minutes"}. Do not share it.</p></>}
			{act.error && <p className="error">{act.error}</p>}
		</section>
	);
}

/** Everything in the project that is waiting for a person, most urgent first. Each item goes to where it is handled. */
function NeedsYou({ state }: { state: State }) {
	const slug = state.project.slug, to = (intentId: number) => `/p/${slug}/i/${intentId}`;
	const live = state.attempts.filter((a) => LIVE.has(a.status));
	const items: { key: string; tone: string; label: string; text: string; to: string }[] = [];
	const trunkRun = runFor(state, "trunk");
	if (trunkRun?.sha === state.project.head && trunkRun.status === "fail") items.push({ key: "trunk", tone: "conflict", label: "trunk is failing", text: `Verification of ${short(state.project.head)} failed (${trunkRun.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}). Only an attempt that fixes it will land.`, to: `/p/${slug}` });
	for (const r of state.reconciliations.filter((r) => r.status === "open")) {
		const a = state.attempts.find((x) => x.id === r.attemptId);
		if (a && LIVE.has(a.status)) items.push({ key: `r${r.id}`, tone: "conflict", label: "conflict to resolve", text: `Landing ${a.agent}'s attempt ${a.id} collided with trunk on ${r.conflicts.map((c) => c.path).join(", ")}.`, to: to(r.intentId) });
	}
	for (const a of live) {
		const asked = state.decisions.filter((d) => d.attemptId === a.id && d.kind === "question");
		const answered = new Set(state.decisions.filter((d) => d.attemptId === a.id && d.kind === "answer").map((d) => d.title.replace(/^Answer: /, "")));
		for (const q of asked.filter((q) => !answered.has(q.title))) items.push({ key: `q${q.id}`, tone: "touch", label: "question", text: `${a.agent} asks: ${q.title}`, to: to(a.intentId) });
		const run = runFor(state, a.id), queued = state.queue.some((q) => q.attemptId === a.id);
		if (run?.sha === a.headSha && run.status === "fail") items.push({ key: `f${a.id}`, tone: "conflict", label: "checks failed", text: `${a.agent}'s attempt ${a.id} failed ${run.steps.filter((s) => s.status === "fail").map((s) => s.name).join(", ")}.`, to: to(a.intentId) });
		else if (a.hosted === "failed") items.push({ key: `h${a.id}`, tone: "conflict", label: "agent failed", text: `${a.agent} on attempt ${a.id}: ${a.hostedDetail}`, to: to(a.intentId) });
		else if (a.status === "ready" && !queued) items.push({ key: `l${a.id}`, tone: "ready", label: "ready to review", text: `${a.agent}'s attempt ${a.id}: ${a.summary || "marked ready"}`, to: to(a.intentId) });
	}
	if (!items.length) return null;
	return (
		<section className="needs" aria-label="Needs you">
			<h2>Needs you <span className="count">{items.length}</span></h2>
			<ul>{items.map((i) => <li key={i.key}><Link to={i.to}><span className={`chip ${i.tone}`}>{i.label}</span><span className="needs-text">{i.text}</span></Link></li>)}</ul>
		</section>
	);
}

/** Lets the owner open the project to anyone with the link, read-only. Off until someone turns it on. */
function Visibility({ state }: { state: State }) {
	const act = useAction();
	const { slug, public: open } = state.project;
	const toggle = () => {
		if (!open && !window.confirm("Anyone with the link will be able to read this project without signing in: its intents, code, decisions, agent sessions and previews. They cannot change anything.\n\nMake it public?")) return;
		act.run(() => api("POST", `/p/${slug}/public`, { public: !open, by: "human" }));
	};
	return (
		<section className="card">
			<h2>Who can read this</h2>
			<p className="small">{open ? <>Anyone with the link, without signing in: <span className="mono">{location.origin}/p/{slug}</span></> : "Only people with the admin token."}</p>
			<button disabled={act.busy} onClick={toggle}>{open ? "Make it private" : "Make it public (read-only)"}</button>
			{act.error && <p className="error">{act.error}</p>}
		</section>
	);
}

function AttemptRow({ a, state }: { a: Attempt; state: State }) {
	const mine = state.overlaps.filter((o) => o.a === a.id || o.b === a.id);
	const conflicts = new Set(mine.filter((o) => o.severity === "conflict").map((o) => (o.a === a.id ? o.b : o.a)));
	const touches = new Set(mine.filter((o) => o.severity !== "conflict").map((o) => (o.a === a.id ? o.b : o.a)));
	const decisions = state.decisions.filter((d) => d.attemptId === a.id).length;
	const now = useNow(a.id, a.now);
	return (
		<div className={`attempt-row ${a.status}`}>
			<span className="mono dim">{a.id}</span>
			<strong>{a.agent}</strong>
			<span className={`chip ${a.status}`}>{a.status}</span>
			<HostedChip a={a} />
			<span className="dim small">{a.files.length} file{a.files.length === 1 ? "" : "s"} · {decisions} decision{decisions === 1 ? "" : "s"}</span>
			<span className="spacer" />
			{LIVE.has(a.status) && <RunChip run={runFor(state, a.id)} head={a.headSha} />}
			{LIVE.has(a.status) && a.behind > 0 && <span className="chip quiet" title="Landings on trunk since this attempt's base">{a.behind} behind</span>}
			{LIVE.has(a.status) && a.trunkConflicts.length > 0 && <span className="chip conflict">conflicts with trunk</span>}
			{conflicts.size > 0 && <span className="chip conflict">will conflict with {[...conflicts].join(", ")}</span>}
			{touches.size > 0 && <span className="chip touch">overlaps {[...touches].join(", ")}</span>}
			{a.status === "working" && now && <p className="now mono" title={now.text}>{now.tool ? `${now.tool}: ` : ""}{now.text.split("\n")[0].slice(0, 140)}</p>}
		</div>
	);
}

function IntentCard({ intent, state }: { intent: Intent; state: State }) {
	const attempts = state.attempts.filter((a) => a.intentId === intent.id);
	const [joining, setJoining] = useState(false);
	return (
		<section className={`card intent ${intent.status}`} style={{ borderLeftColor: intentColor(intent.id) }}>
			<div className="row">
				<Link to={`/p/${state.project.slug}/i/${intent.id}`} className="intent-title">
					<span className="mono" style={{ color: intentColor(intent.id) }}>I{intent.id}</span> {intent.title}
				</Link>
				<span className="spacer" />
				{intent.status === "landed" ? <span className="chip landed">landed {short(intent.landedSha!)}</span> : <span className={`chip ${intent.status}`}>{intent.status}</span>}
			</div>
			<p className="goal">{intent.goal}</p>
			{attempts.map((a) => <AttemptRow key={a.id} a={a} state={state} />)}
			{intent.status === "open" && (
				<div className="row actions">
					{!state.viewer && <button onClick={() => setJoining(!joining)}>{joining ? "Close" : "Add an agent"}</button>}
					{attempts.length > 0 && <Link to={`/p/${state.project.slug}/i/${intent.id}`} className="button">{attempts.length > 1 ? `Compare ${attempts.length} attempts` : "Review"}</Link>}
				</div>
			)}
			{joining && <JoinCommand slug={state.project.slug} intentId={intent.id} hosting={state.project.hosting} />}
		</section>
	);
}

function NewIntent({ slug }: { slug: string }) {
	const [open, setOpen] = useState(false);
	const [f, setF] = useState({ title: "", goal: "", acceptance: "" });
	const create = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (await create.run(() => api("POST", `/p/${slug}/intents`, { ...f, by: "human" }))) { setF({ title: "", goal: "", acceptance: "" }); setOpen(false); }
	};
	if (!open) return <button className="primary" onClick={() => setOpen(true)}>New intent</button>;
	return (
		<form className="card form" onSubmit={submit}>
			<h2>New intent</h2>
			<label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Add a dark mode" required autoFocus /></label>
			<label>Goal<textarea value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} placeholder="What should be true when this is done, and for whom" required rows={2} /></label>
			<label>Acceptance<textarea value={f.acceptance} onChange={(e) => setF({ ...f, acceptance: e.target.value })} placeholder="How a reviewer can tell it is done" rows={2} /></label>
			{create.error && <p className="error">{create.error}</p>}
			<div className="row"><button className="primary" disabled={create.busy}>Open intent</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
		</form>
	);
}

const ICON: Record<string, string> = { land: "●", conflict: "✕", overlap: "≈", why: "¶", push: "↑", claim: "◌", ready: "✓", reconcile: "⚯", message: "✉", intent: "＋", attempt: "→", check: "✓", project: "＊" };

export function ProjectPage({ state }: { state: State }) {
	const open = state.intents.filter((i) => i.status === "open"), done = state.intents.filter((i) => i.status !== "open");
	const me = useMe();
	const [shown, setShown] = useState(30);
	useTitle(state.project.name);
	return (
		<main className="page">
			<h1 className="sr-only">{state.project.name}: work in progress</h1>
			{state.project.description && <p className="dim project-desc">{state.project.description}</p>}
			{!state.project.head && <p className="warn">Trunk is empty. Push a repository into it (see "Push a repository") before starting attempts.</p>}
			<NeedsYou state={state} />
			<Braid state={state} />
			<div className="columns">
				<div className="col-main">
					<div className="row section-head"><h2>Intents</h2><span className="spacer" />{!state.viewer && <NewIntent slug={state.project.slug} />}</div>
					{state.intents.length === 0 && <p className="dim">An intent is a goal, stated once. Agents attempt it; you choose what lands.</p>}
					{open.map((i) => <IntentCard key={i.id} intent={i} state={state} />)}
					{done.length > 0 && <h3 className="dim">Closed</h3>}
					{done.map((i) => <IntentCard key={i.id} intent={i} state={state} />)}
					{!state.viewer && <DeleteProject state={state} />}
				</div>
				<aside className="col-side">
					<TrunkRemote state={state} />
					{!state.viewer && me?.protected && <Visibility state={state} />}
					<h2>Activity</h2>
					<ol className="activity">
						{state.activity.slice(0, shown).map((e) => (
							<li key={e.id} className={e.kind}>
								<span className="icon" aria-hidden="true">{ICON[e.kind] ?? "·"}</span>
								<span>{e.intentId ? <Link to={`/p/${state.project.slug}/i/${e.intentId}`}>{e.text}</Link> : e.text} <span className="dim small">{ago(e.at)}</span></span>
							</li>
						))}
					</ol>
					{state.activity.length > shown && <button onClick={() => setShown(shown + 60)}>Show older activity</button>}
				</aside>
			</div>
		</main>
	);
}
