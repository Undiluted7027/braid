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
	const landing = (sha: string | null) => state.landings.find((l) => l.sha === sha);
	const loaded = file && file.path === path ? file : null;
	const shown = landing(picked) ?? (loaded?.trail.length ? loaded.trail[loaded.trail.length - 1] : undefined);
	const intent = shown && state.intents.find((i) => i.id === shown.intentId);
	const decisions = shown ? state.decisions.filter((d) => d.attemptId === shown.attemptId) : [];
	const about = decisions.filter((d) => d.files.includes(path));
	const recon = shown && state.reconciliations.find((r) => r.attemptId === shown.attemptId && r.status === "resolved");
	const traced = loaded ? loaded.blame.filter((l) => landing(l.sha)).length : 0;

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
						const l = landing(line.sha);
						const first = l && loaded.blame[i - 1]?.sha !== line.sha;
						return (
							<div key={i} className={`bl ${l ? "traced" : ""} ${line.sha && line.sha === shown?.sha ? "on" : ""}`} onClick={() => l && setPicked(line.sha)}
								{...(first ? { role: "button", tabIndex: 0, "aria-label": `Lines from I${l.intentId}, starting at line ${i + 1}: show why`, onKeyDown: (e: { key: string; preventDefault: () => void }) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPicked(line.sha); } } } : {})}
								style={l ? { ["--c" as string]: intentColor(l.intentId) } : undefined}>
								<span className="who">{first ? `I${l.intentId}` : ""}</span>
								<span className="ln">{i + 1}</span>
								<span className="code-line">{line.text || " "}</span>
							</div>
						);
					})}
				</pre>}
			</section>
			<aside className="reason" aria-live="polite" style={intent ? { ["--c" as string]: intentColor(intent.id) } : undefined}>
				{!shown && <p className="dim"><Icon name="info" /> Lines from before Braid tracked this project carry no intent. Select a marked line to see why it exists.</p>}
				{shown && intent && <>
					<p className="label">Why these lines exist</p>
					<h2><IntentId id={intent.id} /><span>{intent.title}</span></h2>
					<p className="goal">{intent.goal}</p>
					<p className="reason-meta">Landed {ago(shown.at)} as <span className="mono">{short(shown.sha)}</span> by {shown.agent}, attempt {shown.attemptId}.</p>
					<p><Link to={`/p/${slug}/i/${intent.id}`} className="button"><Icon name="arrow" />Open the intent</Link></p>
					{recon && <div className="recon-note"><p className="label"><Icon name="reconcile" size={14} />Reconciled by {recon.resolvedBy}</p><p>{recon.rationale}</p></div>}
					<h3 className="label">Decisions about this file</h3>
					<Why decisions={about} empty="None recorded for this file specifically." />
					{decisions.length > about.length && <><h3 className="label">Other decisions in this attempt</h3><Why decisions={decisions.filter((d) => !about.includes(d))} /></>}
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
