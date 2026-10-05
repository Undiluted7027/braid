// The code, annotated with why: every line on trunk traces to the intent that landed it.
import { useEffect, useState } from "react";
import type { FileView, State, TrunkCommit } from "../shared/types";
import { api, ago, intentColor, navigate, short, useAsync } from "./api";
import { IntentId, Link, useTitle } from "./App";
import { Empty } from "./Graphics";
import { Why } from "./Intent";
import { Icon, Notice } from "./Kit";

/** Paths as a tree of folders. */
type Node = { folders: Map<string, Node>; files: { name: string; path: string }[] };
function nest(paths: string[]): Node {
	const root: Node = { folders: new Map(), files: [] };
	for (const path of paths) {
		const parts = path.split("/");
		let at = root;
		for (const part of parts.slice(0, -1)) {
			if (!at.folders.has(part)) at.folders.set(part, { folders: new Map(), files: [] });
			at = at.folders.get(part)!;
		}
		at.files.push({ name: parts[parts.length - 1], path });
	}
	return root;
}
/** Folders first, each one closed until opened, except those on the way to the file being shown. */
function Folder({ node, path, open, prefix = "" }: { node: Node; path: string; open: (p: string) => void; prefix?: string }) {
	return (
		<>
			{[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => (
				<details key={name} open={path.startsWith(`${prefix}${name}/`) || undefined}>
					<summary><Icon name="folder" size={14} /><span className="mono">{name}</span></summary>
					<div className="tree-kids"><Folder node={child} path={path} open={open} prefix={`${prefix}${name}/`} /></div>
				</details>
			))}
			{node.files.map((f) => <button key={f.path} className={f.path === path ? "on" : ""} aria-current={f.path === path || undefined} onClick={() => open(f.path)} title={f.path}><Icon name="file" size={14} /><span className="mono">{f.name}</span></button>)}
		</>
	);
}
const KIND: Record<TrunkCommit["kind"], string> = { landing: "landed", revert: "revert", attempt: "commit inside an attempt", start: "where trunk started", outside: "pushed outside Braid" };

export function WhyPage({ state }: { state: State }) {
	const slug = state.project.slug;
	const [path, setPath] = useState(new URLSearchParams(location.search).get("path") ?? "");
	const [picked, setPicked] = useState<string | null>(null);
	const { data: tree, error: treeError } = useAsync(() => api<string[]>("GET", `/p/${slug}/tree?ref=trunk`), [slug, state.project.head]);
	const { data: file, error } = useAsync(() => (path ? api<FileView>("GET", `/p/${slug}/file?path=${encodeURIComponent(path)}`) : Promise.resolve(null)), [slug, path, state.project.head]);
	useEffect(() => { if (!path && tree?.length) setPath(tree.find((p) => p.endsWith(".js")) ?? tree[0]); }, [tree, path]);
	const open = (p: string) => { setPath(p); setPicked(null); navigate(`/p/${slug}/why?path=${encodeURIComponent(p)}`); };

	const [filter, setFilter] = useState("");
	useTitle(`${path || "Why"} · ${state.project.name}`);
	const files = tree?.filter((p) => p.toLowerCase().includes(filter.toLowerCase())) ?? [];
	const [allCommits, setAllCommits] = useState(false);
	const { data: history } = useAsync(() => api<TrunkCommit[]>("GET", `/p/${slug}/history${allCommits ? "?inside=1" : ""}`), [slug, state.project.head, allCommits]);
	const commits = history ?? [];
	const landing = (sha: string | null | undefined) => state.landings.find((l) => l.sha === sha);
	const loaded = file && file.path === path ? file : null;
	// What is selected is a run of lines with one origin: a commit inside an attempt, a reconciliation, or a push from outside Braid.
	const key = (line: { sha: string | null; origin?: string }) => line.origin ?? line.sha ?? null;
	const lastTraced = loaded ? [...loaded.blame].reverse().find((l) => landing(l.sha)) : undefined;
	const pickedKey = picked ?? (lastTraced ? key(lastTraced) : null);
	const origin = pickedKey && loaded ? loaded.origins[pickedKey] : undefined;
	const shown = landing(origin ? origin.landingSha : pickedKey);
	const intent = shown && state.intents.find((i) => i.id === shown.intentId);
	const decisions = shown ? state.decisions.filter((d) => d.attemptId === shown.attemptId) : [];
	// Decisions the agent recorded while writing these very lines come first; the rest of the attempt's reasoning follows.
	const here = origin ? decisions.filter((d) => origin.decisionIds.includes(d.id)) : [];
	const about = decisions.filter((d) => !here.includes(d) && d.files.includes(path));
	const rest = decisions.filter((d) => !here.includes(d) && !about.includes(d));
	const recon = shown && state.reconciliations.find((r) => r.attemptId === shown.attemptId && r.status === "resolved");
	const traced = loaded ? loaded.blame.filter((l) => landing(l.sha)).length : 0;
	const outside = origin?.kind === "outside" ? origin : undefined;

	return (
		<main className="page why-page">
			<header className="why-head">
				<h1>Why each line on trunk exists</h1>
				<p className="dim">Lines are marked with the intent that landed them. Select a marked line to read the goal and the decisions behind it.</p>
			</header>
			<nav className="tree" aria-label="Files on trunk">
				<h2 className="label">Files on trunk</h2>
				<label className="search"><Icon name="search" /><span className="sr-only">Filter files</span><input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${tree?.length ?? 0} files`} /></label>
				{treeError && <Notice>{treeError}</Notice>}
				<div className="tree-files">
					{filter ? files.map((p) => <button key={p} className={p === path ? "on" : ""} onClick={() => open(p)} title={p}><Icon name="file" size={14} /><span className="mono">{p}</span></button>)
						: <Folder node={nest(tree ?? [])} path={path} open={open} />}
					{tree && tree.length > 0 && files.length === 0 && <p className="dim">No file matches “{filter}”.</p>}
					{tree?.length === 0 && <p className="dim">Trunk has no files yet.</p>}
				</div>
			</nav>
			<section className="code" aria-label={path || "File"}>
				<div className="code-head">
					<h2 className="mono">{path || "No file"}</h2>
					{loaded && !loaded.binary && <span className="dim">{loaded.trail.length ? <>{traced} of {loaded.blame.length} lines traced to {loaded.trail.map((l) => `I${l.intentId}`).filter((v, i, all) => all.indexOf(v) === i).join(", ")}</> : "Unchanged since trunk started, so no intent is recorded for it."}</span>}
				</div>
				{error && <Notice>{error}</Notice>}
				{loaded?.binary && <Empty title="This is a binary file"><p>There are no lines to trace.</p></Empty>}
				{!loaded && !error && path && <Empty kind="loading" title={`Reading ${path} from trunk…`} />}
				{tree?.length === 0 && <Empty title="Trunk is empty"><p>Once something lands, its lines appear here with their reasons.</p></Empty>}
				{loaded && !loaded.binary && <pre className="blame" tabIndex={0} aria-label={`${path}, each line marked with its intent`}>
					{loaded.blame.map((line, i) => {
						const l = landing(line.sha), k = key(line), out = !l && !!line.origin;
						const first = (l || out) && key(loaded.blame[i - 1] ?? { sha: null }) !== k;
						return (
							<div key={i} className={`bl ${l ? "traced" : out ? "traced outside" : ""} ${k && k === pickedKey ? "on" : ""}`} onClick={() => (l || out) && setPicked(k)}
								{...(first ? { role: "button", tabIndex: 0, "aria-label": l ? `Lines from I${l.intentId}, starting at line ${i + 1}: show why` : `Lines pushed outside Braid, starting at line ${i + 1}: show the commit`, onKeyDown: (e: { key: string; preventDefault: () => void }) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPicked(k); } } } : {})}
								style={l ? { ["--c" as string]: intentColor(l.intentId) } : undefined}>
								<span className="who">{first ? (l ? `I${l.intentId}` : "out") : ""}</span>
								<span className="ln">{i + 1}</span>
								<span className="code-line">{line.text || " "}</span>
							</div>
						);
					})}
				</pre>}
			</section>
			<aside className="reason" aria-live="polite" style={intent ? { ["--c" as string]: intentColor(intent.id) } : undefined}>
				{!shown && !outside && <p className="dim"><Icon name="info" /> Lines from before Braid tracked this project carry no intent. Select a marked line to see why it exists.</p>}
				{outside?.commit && <>
					<p className="label">Where these lines came from</p>
					<h2><span>{outside.commit.subject}</span></h2>
					<p className="reason-meta">Pushed to trunk outside Braid by {outside.commit.author}, {ago(outside.commit.at)}, as <span className="mono">{short(outside.commit.sha)}</span>.</p>
					<p className="dim">No intent or decisions were recorded for it. The commit message is all the why there is.</p>
				</>}
				{shown && intent && <>
					<p className="label">Why these lines exist</p>
					<h2><IntentId id={intent.id} /><span>{intent.title}</span></h2>
					<p className="goal">{intent.goal}</p>
					<p className="reason-meta">Landed {ago(shown.at)} as <span className="mono">{short(shown.sha)}</span> by {shown.agent}, attempt {shown.attemptId}.</p>
					<p><Link to={`/p/${slug}/i/${intent.id}`} className="button"><Icon name="arrow" />Open the intent</Link></p>
					{origin?.kind === "attempt" && origin.commit && (
						<div className="moment">
							<p className="label">When these lines were written</p>
							<p>In the commit <strong>{origin.commit.subject}</strong> <span className="mono dim">{short(origin.commit.sha)}</span>, {ago(origin.commit.at)}.</p>
							{origin.eventId !== null
								? <p><Link to={`/p/${slug}/i/${intent.id}?attempt=${shown.attemptId}&event=${origin.eventId}`} className="button"><Icon name="say" />See this moment in the session</Link></p>
								: <p className="dim">No session was captured for this attempt, so there is no moment to show.</p>}
						</div>
					)}
					{(origin?.kind === "reconcile" || origin?.kind === "merge") && (
						<div className="moment">
							<p className="label">When these lines were written</p>
							<p>{origin.kind === "reconcile" ? "While reconciling this attempt with trunk: these lines are in neither side as they were." : "By the merge that landed the attempt."}</p>
						</div>
					)}
					{recon && (origin?.kind === "reconcile" || !origin) && <div className="recon-note"><p className="label"><Icon name="reconcile" size={14} />Reconciled by {recon.resolvedBy}</p><p>{recon.rationale}</p></div>}
					{here.length > 0 && <><h3 className="label">Decided while writing these lines</h3><Why decisions={here} /></>}
					<h3 className="label">{here.length ? "Other decisions about this file" : "Decisions about this file"}</h3>
					<Why decisions={about} empty={here.length ? "None." : "None recorded for this file specifically."} />
					{rest.length > 0 && <><h3 className="label">Other decisions in this attempt</h3><Why decisions={rest} /></>}
				</>}
			</aside>
			<section className="history-box" aria-labelledby="hist-h">
				<h2 id="hist-h" className="label">Trunk history</h2>
				<label className="check"><input type="checkbox" checked={allCommits} onChange={(e) => setAllCommits(e.target.checked)} />Show the commits inside each attempt</label>
				<ol className="history">
					{commits.map((c) => (
						<li key={c.sha} className={c.kind} style={c.intentId ? { ["--c" as string]: intentColor(c.intentId) } : undefined}>
							{c.intentId
								? <Link to={`/p/${slug}/i/${c.intentId}`}><span className="mono hist-id">I{c.intentId}</span> {c.kind === "landing" ? state.intents.find((i) => i.id === c.intentId)?.title ?? c.subject : c.subject}</Link>
								: <span>{c.subject}</span>}
							<span className="hist-meta"><span className="mono">{short(c.sha)}</span> · {c.author} · {ago(c.at)} · {c.kind === "attempt" ? `in attempt ${c.attemptId}` : KIND[c.kind]}</span>
						</li>
					))}
					{history && commits.length === 0 && <li className="dim none">No commits yet.</li>}
				</ol>
			</section>
		</main>
	);
}
