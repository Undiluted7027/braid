import { RunChip, runFor } from "./Verify";
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { api, ago, navigate, useAsync, useProject } from "./api";
import { IntentPage } from "./Intent";
import { ProjectPage } from "./Project";
import { WhyPage } from "./Why";

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
	const go = (e: MouseEvent) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey) return;
		e.preventDefault();
		navigate(to);
	};
	return <a href={to} onClick={go} className={className}>{children}</a>;
}

/** Run a mutation; surface its failure next to the control that caused it. */
export function useAction() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try { await fn(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
	};
	return { busy, error, run };
}

function Projects() {
	const [version, setVersion] = useState(0);
	const { data, error } = useAsync(() => api<{ slug: string; name: string; description: string; createdAt: number }[]>("GET", "/projects"), [version]);
	const [slug, setSlug] = useState("");
	const [description, setDescription] = useState("");
	const [source, setSource] = useState<"starter" | "import" | "empty">("starter");
	const [url, setUrl] = useState("");
	const create = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (await create.run(() => api("POST", "/projects", { slug, name: slug, description, source, url }))) navigate(`/p/${slug}`);
		else setVersion((v) => v + 1);
	};
	return (
		<main className="page narrow">
			<h1>Projects</h1>
			<p className="lede">A project is a trunk repository on Cloudflare Artifacts. Every agent attempt is a fork of it.</p>
			{error && <p className="error">{error}</p>}
			<div className="list">
				{data?.map((p) => (
					<Link key={p.slug} to={`/p/${p.slug}`} className="list-row">
						<strong>{p.name}</strong><span className="dim">{p.description}</span><span className="spacer" /><span className="dim">{ago(p.createdAt)}</span>
					</Link>
				))}
				{data?.length === 0 && <p className="dim">No projects yet.</p>}
			</div>
			<form className="card form" onSubmit={submit}>
				<h2>New project</h2>
				<label>Name<input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="tally" pattern="[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]" required /></label>
				<label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this codebase is" /></label>
				<label>Trunk starts from
					<select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
						<option value="starter">A starter app (small, no build, previewable)</option>
						<option value="import">An existing git repository (import by URL)</option>
						<option value="empty">Nothing yet (I will push a repository)</option>
					</select>
				</label>
				{source === "import" && <label>Repository URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" type="url" required /></label>}
				{source === "empty" && <p className="dim small">From a local repository, <code>braid init {location.origin} --name {slug || "<name>"}</code> creates the project and pushes HEAD in one step.</p>}
				{create.error && <p className="error">{create.error}</p>}
				<button className="primary" disabled={create.busy}>{create.busy ? (source === "import" ? "Importing…" : "Creating repo…") : "Create project"}</button>
			</form>
		</main>
	);
}

function ProjectShell({ slug, rest }: { slug: string; rest: string[] }) {
	const { state, error, live } = useProject(slug);
	if (error && !state) return <main className="page narrow"><p className="error">{error}</p><Link to="/">All projects</Link></main>;
	if (!state) return <main className="page"><p className="dim">Loading…</p></main>;
	const tab = rest[0] === "why" ? "why" : rest[0] === "i" ? "intent" : "loom";
	return (
		<>
			<header className="project-bar">
				<Link to={`/p/${slug}`} className="project-name">{state.project.name}</Link>
				<nav>
					<Link to={`/p/${slug}`} className={tab !== "why" ? "on" : ""}>Work</Link>
					<Link to={`/p/${slug}/why`} className={tab === "why" ? "on" : ""}>Why</Link>
				</nav>
				<span className="spacer" />
				<span className="mono dim">trunk {state.project.head ? state.project.head.slice(0, 7) : "empty"}</span>
				<RunChip run={runFor(state, "trunk")} head={state.project.head} />
				<span className={`live ${live ? "on" : ""}`}>{live ? "live" : "reconnecting"}</span>
			</header>
			{tab === "why" ? <WhyPage state={state} /> : tab === "intent" ? <IntentPage state={state} intentId={Number(rest[1])} /> : <ProjectPage state={state} />}
		</>
	);
}

export function App() {
	const [path, setPath] = useState(location.pathname);
	useEffect(() => {
		const on = () => setPath(location.pathname);
		window.addEventListener("popstate", on);
		return () => window.removeEventListener("popstate", on);
	}, []);
	const seg = path.split("/").filter(Boolean);
	return (
		<>
			<header className="top-bar">
				<Link to="/" className="brand">
					<svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true"><path d="M4 8c12 0 12 16 24 16M4 24c12 0 12-16 24-16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>
					Braid
				</Link>
				<span className="dim">intents, not branches</span>
			</header>
			{seg[0] === "p" && seg[1] ? <ProjectShell key={seg[1]} slug={seg[1]} rest={seg.slice(2)} /> : <Projects />}
		</>
	);
}
