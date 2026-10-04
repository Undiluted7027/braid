import { RunChip, runFor } from "./Verify";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { api, ago, navigate, signIn, tryToken, useAsync, useProject, useSignedIn } from "./api";
export { useSignedIn };
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

/** The page's name in the tab and in history. */
export function useTitle(title: string) {
	useEffect(() => { document.title = title ? `${title} · Braid` : "Braid: intents, not branches"; }, [title]);
}

/** Asks for the admin token when something needs it. Opened by `signIn()` in api.ts. */
function SignIn() {
	const ref = useRef<HTMLDialogElement>(null);
	const done = useRef<((ok: boolean) => void) | null>(null);
	const [token, setToken] = useState("");
	const [wrong, setWrong] = useState(false);
	useEffect(() => {
		const open = (e: Event) => { done.current = (e as CustomEvent<(ok: boolean) => void>).detail; setToken(""); setWrong(false); ref.current?.showModal(); };
		window.addEventListener("braid:signin", open);
		return () => window.removeEventListener("braid:signin", open);
	}, []);
	const finish = (ok: boolean) => { done.current?.(ok); done.current = null; ref.current?.close(); };
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (await tryToken(token)) finish(true); else setWrong(true);
	};
	return (
		<dialog ref={ref} className="signin" onCancel={() => finish(false)} aria-labelledby="signin-title">
			<form onSubmit={submit} className="form">
				<h2 id="signin-title">Sign in</h2>
				<p className="small dim">Changing anything on this Braid instance needs its admin token (the <code>BRAID_ADMIN_TOKEN</code> secret). Public projects can be read without it.</p>
				<label>Admin token<input type="password" value={token} onChange={(e) => { setToken(e.target.value); setWrong(false); }} autoFocus autoComplete="current-password" /></label>
				{wrong && <p className="error" role="alert">That is not this instance's admin token.</p>}
				<div className="row"><button className="primary" disabled={!token}>Sign in</button><button type="button" onClick={() => finish(false)}>Cancel</button></div>
			</form>
		</dialog>
	);
}

function Projects({ signedIn }: { signedIn: boolean }) {
	useTitle("");
	const [version, setVersion] = useState(0);
	const { data, error } = useAsync(() => api<{ slug: string; name: string; description: string; createdAt: number; public: boolean }[]>("GET", "/projects"), [version, signedIn]);
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
			<section className="intro">
				<h1>A git platform for many agents changing one codebase at once</h1>
				<p className="lede">Git merges text. It does not know what either side was trying to do. Braid keeps the <em>why</em> next to every change and uses it while agents work, when their changes collide, and afterwards.</p>
				<ol className="how">
					<li><strong>State a goal once.</strong> An <em>intent</em> replaces the issue, the branch and the pull request.</li>
					<li><strong>Agents attempt it side by side.</strong> Each <em>attempt</em> is a fork of trunk. Braid runs every commit in a sandbox and tells agents when their work is about to collide, with the other agent's reasoning.</li>
					<li><strong>You choose what lands.</strong> Trunk only takes what has been run, merged with what is already there. A collision is resolved with both goals in view.</li>
					<li><strong>Every line keeps its reason.</strong> The <em>Why</em> view traces each line on trunk to the intent and decisions that put it there.</li>
				</ol>
			</section>
			<h2>Projects</h2>
			<p className="dim small">A project is a trunk repository on Cloudflare Artifacts. Every agent attempt is a fork of it.</p>
			{error && <p className="error">{error}</p>}
			<div className="list">
				{data?.map((p) => (
					<Link key={p.slug} to={`/p/${p.slug}`} className="list-row">
						<strong>{p.name}</strong>{p.name !== p.slug && <span className="mono dim small">{p.slug}</span>}{p.public && <span className="chip quiet">public</span>}
						<span className="dim desc">{p.description}</span><span className="spacer" /><span className="mono dim small">/p/{p.slug}</span><span className="dim small">{ago(p.createdAt)}</span>
					</Link>
				))}
				{data?.length === 0 && <p className="dim">{signedIn ? "No projects yet. Create the first one below." : "No public projects on this instance. Sign in to see the rest."}</p>}
			</div>
			{!signedIn && <p className="row"><button className="primary" onClick={() => signIn()}>Sign in to create a project</button></p>}
			{signedIn && <form className="card form" onSubmit={submit}>
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
				{source === "empty" && <p className="dim small">The project page then shows the command that pushes a local repository into it.</p>}
				{create.error && <p className="error">{create.error}</p>}
				<button className="primary" disabled={create.busy}>{create.busy ? (source === "import" ? "Importing…" : "Creating repo…") : "Create project"}</button>
			</form>}
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
			{state.viewer && (
				<p className="viewer-bar" role="status">You are reading a public project. It is live: agents and landings appear as they happen. <button onClick={() => signIn()}>Sign in</button> to change it.</p>
			)}
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
	const me = useSignedIn();
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
				<span className="dim tagline">intents, not branches</span>
				<span className="spacer" />
				{me && !me.signedIn && <button onClick={() => signIn()}>Sign in</button>}
			</header>
			{seg[0] === "p" && seg[1] ? <ProjectShell key={seg[1]} slug={seg[1]} rest={seg.slice(2)} /> : <Projects signedIn={me?.signedIn ?? true} />}
			<SignIn />
		</>
	);
}
