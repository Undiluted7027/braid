// The code, annotated with why: every line on trunk traces to the intent that landed it.
import { useEffect, useState } from "react";
import type { FileView, State, TrunkCommit } from "../shared/types";
import { api, ago, intentColor, navigate, short, useAsync } from "./api";
import { Link, useTitle } from "./App";
import { Why } from "./Intent";

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
function Folder({ node, path, open, depth, prefix = "" }: { node: Node; path: string; open: (p: string) => void; depth: number; prefix?: string }) {
	return (
		<>
			{[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => (
				<details key={name} open={path.startsWith(`${prefix}${name}/`) || undefined} style={{ paddingLeft: depth ? 12 : 0 }}>
					<summary className="mono">{name}/</summary>
					<Folder node={child} path={path} open={open} depth={depth + 1} prefix={`${prefix}${name}/`} />
				</details>
			))}
			{node.files.map((f) => <button key={f.path} className={`mono ${f.path === path ? "on" : ""}`} style={{ marginLeft: depth ? 12 : 0 }} onClick={() => open(f.path)} title={f.path}>{f.name}</button>)}
		</>
	);
}

export function WhyPage({ state }: { state: State }) {
	const slug = state.project.slug;
	const [path, setPath] = useState(new URLSearchParams(location.search).get("path") ?? "");
	const [picked, setPicked] = useState<string | null>(null);
	const { data: tree } = useAsync(() => api<string[]>("GET", `/p/${slug}/tree?ref=trunk`), [slug, state.project.head]);
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
	const shown = landing(picked) ?? (file?.trail.length ? file.trail[file.trail.length - 1] : undefined);
	const intent = shown && state.intents.find((i) => i.id === shown.intentId);
	const decisions = shown ? state.decisions.filter((d) => d.attemptId === shown.attemptId) : [];
	const about = decisions.filter((d) => d.files.includes(path));
	const recon = shown && state.reconciliations.find((r) => r.attemptId === shown.attemptId && r.status === "resolved");

	return (
		<main className="page why-page">
			<h1 className="sr-only">{state.project.name}: why each line on trunk exists</h1>
			<nav className="tree" aria-label="Files on trunk">
				<input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${tree?.length ?? 0} files`} aria-label="Filter files" />
				<div className="tree-files">
					{filter ? files.map((p) => <button key={p} className={`mono ${p === path ? "on" : ""}`} onClick={() => open(p)} title={p}>{p}</button>)
						: <Folder node={nest(tree ?? [])} path={path} open={open} depth={0} />}
					{tree && files.length === 0 && <p className="dim small">No file matches.</p>}
				</div>
				<h3>Trunk history</h3>
				<label className="check small"><input type="checkbox" checked={allCommits} onChange={(e) => setAllCommits(e.target.checked)} /> show the commits inside each attempt</label>
				<ol className="history">
					{commits.map((c) => (
						<li key={c.sha} className={c.kind}>
							{c.intentId
								? <Link to={`/p/${slug}/i/${c.intentId}`}><span className="mono" style={{ color: intentColor(c.intentId) }}>I{c.intentId}</span> {c.kind === "landing" ? state.intents.find((i) => i.id === c.intentId)?.title ?? c.subject : c.subject}</Link>
								: <span>{c.subject}</span>}
							<span className="dim small"><span className="mono">{short(c.sha)}</span> · {c.author} · {ago(c.at)} · {c.kind === "landing" ? "landed" : c.kind === "revert" ? "revert" : c.kind === "attempt" ? `in attempt ${c.attemptId}` : c.kind === "start" ? "where trunk started" : "pushed outside Braid"}</span>
						</li>
					))}
					{history && commits.length === 0 && <li className="dim small">No commits yet.</li>}
				</ol>
			</nav>
			<section className="code">
				<div className="row"><h2 className="mono">{path}</h2><span className="spacer" />
					{file && <span className="dim small">{file.trail.length ? `changed by ${file.trail.map((l) => `I${l.intentId}`).join(", ")}` : "unchanged since the seed commit"}</span>}</div>
				{error && <p className="error">{error}</p>}
				{file?.binary && <p className="dim">Binary file.</p>}
				<pre className="blame">
					{file?.blame.map((line, i) => {
						const l = landing(line.sha);
						return (
							<div key={i} className={`bl ${line.sha && line.sha === shown?.sha ? "on" : ""}`} onClick={() => line.sha && setPicked(line.sha)}
								{...(l ? { role: "button", tabIndex: 0, "aria-label": `Line ${i + 1}, from I${l.intentId}: show why`, onKeyDown: (e: { key: string }) => { if (e.key === "Enter" || e.key === " ") setPicked(line.sha); } } : {})}
								style={l ? { borderLeftColor: intentColor(l.intentId), cursor: "pointer" } : undefined}>
								<span className="who" style={l ? { color: intentColor(l.intentId) } : undefined}>{l ? `I${l.intentId}` : ""}</span>
								<span className="ln">{i + 1}</span>
								<span className="code-line">{line.text || " "}</span>
							</div>
						);
					})}
				</pre>
			</section>
			<aside className="reason">
				{!shown && <p className="dim">Lines from the seed commit carry no intent. Click a colored line to see why it exists.</p>}
				{shown && intent && <>
					<p className="small dim">Why these lines exist</p>
					<h2><span className="mono" style={{ color: intentColor(intent.id) }}>I{intent.id}</span> {intent.title}</h2>
					<p className="goal">{intent.goal}</p>
					<p className="small dim">Landed {ago(shown.at)} as <span className="mono">{short(shown.sha)}</span> by {shown.agent}, attempt {shown.attemptId}. <Link to={`/p/${slug}/i/${intent.id}`}>Open the intent</Link></p>
					{recon && <div className="recon-note"><strong>⚯ Reconciled by {recon.resolvedBy}</strong><p>{recon.rationale}</p></div>}
					<h3>Decisions about this file</h3>
					<Why decisions={about} empty="None recorded for this file specifically." />
					{decisions.length > about.length && <><h3>Other decisions in this attempt</h3><Why decisions={decisions.filter((d) => !about.includes(d))} /></>}
				</>}
			</aside>
		</main>
	);
}
