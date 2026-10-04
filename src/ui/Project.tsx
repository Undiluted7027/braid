import { useState, type FormEvent } from "react";
import type { Attempt, Intent, State } from "../shared/types";
import { api, ago, intentColor, short, useNow } from "./api";
import { Link, useAction } from "./App";
import { Braid } from "./Braid";
import { DeleteProject } from "./DeleteProject";

const LIVE = new Set(["working", "ready", "conflicted"]);

export function JoinCommand({ slug, intentId }: { slug: string; intentId: number }) {
	const [agent, setAgent] = useState("claude-code");
	const cmd = `npx braid join ${location.origin}/p/${slug} --intent ${intentId} --agent ${agent}`;
	const [copied, setCopied] = useState(false);
	return (
		<div className="join">
			<p className="small">Run this where the agent should work. It forks trunk into a new Artifacts repo, clones it, and connects the agent to Braid over MCP.</p>
			<div className="row">
				<select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
					<option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="agent">Other</option>
				</select>
				<code className="cmd">{cmd}</code>
				<button onClick={() => { navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
			</div>
		</div>
	);
}

function TrunkRemote({ remote }: { remote: string }) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState(false);
	const copy = async () => {
		setError(false);
		try {
			await navigator.clipboard.writeText(remote);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			setError(true);
		}
	};
	return (
		<section className="card">
			<h2>Clone trunk</h2>
			<p className="small dim">Use this git remote to clone the project’s code.</p>
			<div className="row">
				<code className="cmd">{remote}</code>
				<button onClick={copy} aria-label="Copy trunk remote URL">{copied ? "Copied" : "Copy"}</button>
			</div>
			{error && <p className="error" role="alert">Could not copy. Select and copy the URL above.</p>}
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
			<span className="dim small">{a.files.length} file{a.files.length === 1 ? "" : "s"} · {decisions} decision{decisions === 1 ? "" : "s"}</span>
			<span className="spacer" />
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
					<button onClick={() => setJoining(!joining)}>{joining ? "Close" : "Add an agent"}</button>
					{attempts.length > 0 && <Link to={`/p/${state.project.slug}/i/${intent.id}`} className="button">{attempts.length > 1 ? `Compare ${attempts.length} attempts` : "Review"}</Link>}
				</div>
			)}
			{joining && <JoinCommand slug={state.project.slug} intentId={intent.id} />}
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
	return (
		<main className="page">
			{!state.project.head && <p className="warn">Trunk is empty. Push a first commit to <span className="mono">{state.project.remote}</span>, or run <code>braid init</code> from a local repository, before starting attempts.</p>}
			<Braid state={state} />
			<div className="columns">
				<div className="col-main">
					<div className="row section-head"><h2>Intents</h2><span className="spacer" /><NewIntent slug={state.project.slug} /></div>
					{state.intents.length === 0 && <p className="dim">An intent is a goal, stated once. Agents attempt it; you choose what lands.</p>}
					{open.map((i) => <IntentCard key={i.id} intent={i} state={state} />)}
					{done.length > 0 && <h3 className="dim">Closed</h3>}
					{done.map((i) => <IntentCard key={i.id} intent={i} state={state} />)}
					<DeleteProject state={state} />
				</div>
				<aside className="col-side">
					<TrunkRemote remote={state.project.remote} />
					<h2>Activity</h2>
					<ol className="activity">
						{state.activity.map((e) => (
							<li key={e.id} className={e.kind}>
								<span className="icon" aria-hidden="true">{ICON[e.kind] ?? "·"}</span>
								<span>{e.text} <span className="dim small">{ago(e.at)}</span></span>
							</li>
						))}
					</ol>
				</aside>
			</div>
		</main>
	);
}
