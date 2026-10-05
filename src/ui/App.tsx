import { RunChip, runFor } from "./Verify";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import type { State } from "../shared/types";
import { api, ago, navigate, signIn, tryToken, useAsync, useProject, useSignedIn } from "./api";
export { useSignedIn };
import { Empty, HeroLoom, MiniLoom, StepArt } from "./Graphics";
import { BRANDS } from "./brands";
import { IntentPage } from "./Intent";
import { AskHost, Corners, Icon, Notice } from "./Kit";
import { ProjectPage } from "./Project";
import { WhyPage } from "./Why";

export function Link({ to, children, className, label }: { to: string; children: ReactNode; className?: string; label?: string }) {
	const go = (e: MouseEvent) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey) return;
		e.preventDefault();
		navigate(to);
	};
	return <a href={to} onClick={go} className={className} aria-label={label}>{children}</a>;
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

/** Braid's mark: two strands crossing. */
export function Mark({ size = 22 }: { size?: number }) {
	return (
		<svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className="mark">
			<path d="M4 9c12 0 12 14 24 14" fill="none" stroke="var(--i1)" strokeWidth="4" strokeLinecap="round" />
			<path d="M4 23c12 0 12-14 24-14" fill="none" stroke="var(--i2)" strokeWidth="4" strokeLinecap="round" />
		</svg>
	);
}
/** An intent's number in its colour. */
export function IntentId({ id }: { id: number }) {
	return <span className="intent-id" style={{ ["--c" as string]: `var(--i${((id - 1) % 8) + 1})` }}>I{id}</span>;
}
/**
 * Who made an attempt. Claude Code and Codex are shown by their own marks, named on hover and to
 * screen readers; any other agent gets a square with its initials. The text beside the mark is the
 * model the agent ran on when Braid knows it, and the agent's name otherwise.
 */
export function Agent({ name, kind, model }: { name: string; kind?: string; model?: string | null }) {
	const which = kind === "claude" || /claude/i.test(name) ? "claude" : kind === "codex" || /codex/i.test(name) ? "codex" : null;
	const brand = which && BRANDS[which];
	const product = brand ? brand.label : name;
	return (
		<span className="agent" title={model ? `${product} (${name}) on ${model}` : brand ? `${product} (${name}); the model was not reported` : name}>
			{brand
				? <svg className={`agent-brand ${which}`} viewBox="0 0 24 24" width="20" height="20" role="img" aria-label={brand.label} style={brand.color ? { color: brand.color } : undefined}><title>{brand.label}</title><path d={brand.path} fill="currentColor" /></svg>
				: <span className="agent-mark" aria-hidden="true">{name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase()}</span>}
			<span className={`agent-name ${model ? "mono" : ""}`}>{model ?? name}</span>
		</span>
	);
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
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		const open = (e: Event) => { done.current = (e as CustomEvent<(ok: boolean) => void>).detail; setToken(""); setWrong(false); ref.current?.showModal(); };
		window.addEventListener("braid:signin", open);
		return () => window.removeEventListener("braid:signin", open);
	}, []);
	const finish = (ok: boolean) => { done.current?.(ok); done.current = null; ref.current?.close(); };
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		const ok = await tryToken(token).catch(() => false);
		setBusy(false);
		if (ok) finish(true); else setWrong(true);
	};
	return (
		<dialog ref={ref} className="dialog signin" onCancel={() => finish(false)} aria-labelledby="signin-title">
			<form onSubmit={submit} className="form">
				<div className="row"><Mark size={26} /><h2 id="signin-title">Sign in to Braid</h2></div>
				<p className="dim">Changing anything on this instance needs its admin token, the value of the <code>BRAID_ADMIN_TOKEN</code> secret. Public projects can be read without it.</p>
				<label>Admin token<input type="password" value={token} onChange={(e) => { setToken(e.target.value); setWrong(false); }} autoFocus autoComplete="current-password" aria-invalid={wrong || undefined} aria-describedby={wrong ? "signin-wrong" : undefined} /></label>
				{wrong && <div id="signin-wrong"><Notice>That is not this instance's admin token. Check the secret and try again.</Notice></div>}
				<div className="row dialog-actions"><button type="button" onClick={() => finish(false)}>Cancel</button><button className="primary" disabled={!token || busy}>{busy ? "Checking…" : "Sign in"}</button></div>
			</form>
		</dialog>
	);
}

const STEPS: [string, ReactNode][] = [
	["State a goal once", <>An <em>intent</em> replaces the issue, the branch and the pull request.</>],
	["Agents attempt it side by side", <>Each attempt is a fork of trunk. Every commit is run in a sandbox, and agents hear early when their work will collide.</>],
	["You choose what lands", <>Trunk only takes what has been run, merged with what is already there. Collisions are resolved with both goals in view.</>],
	["Every line keeps its reason", <>The <em>Why</em> view traces each line on trunk to the intent and decisions behind it.</>],
];

type Listed = { slug: string; name: string; description: string; createdAt: number; public: boolean };

/** One project on the home page, with its attempts drawn small once its state has arrived. */
function ProjectCard({ p }: { p: Listed }) {
	const { data } = useAsync(() => api<State>("GET", `/p/${p.slug}`), [p.slug]);
	const open = data?.intents.filter((i) => i.status === "open").length ?? 0;
	const live = data?.attempts.filter((a) => a.status === "working" || a.status === "ready" || a.status === "conflicted").length ?? 0;
	const conflicts = data?.reconciliations.filter((r) => r.status === "open").length ?? 0;
	return (
		<Link to={`/p/${p.slug}`} className="pcard">
			<span className="pcard-name">{p.name}{p.public && <span className="chip quiet"><Icon name="globe" size={12} />public</span>}</span>
			<span className="pcard-desc">{p.description || "No description."}</span>
			{data ? <MiniLoom state={data} /> : <span className="mini-loom placeholder" aria-hidden="true" />}
			<span className="pcard-meta">
				<span className="mono">/p/{p.slug}</span>
				{data && <span>{open} open intent{open === 1 ? "" : "s"}</span>}
				{data && live > 0 && <span>{live} attempt{live === 1 ? "" : "s"} in progress</span>}
				{conflicts > 0 && <span className="bad-text">{conflicts} conflict{conflicts === 1 ? "" : "s"}</span>}
				<span>created {ago(p.createdAt)}</span>
			</span>
		</Link>
	);
}

function Projects({ signedIn }: { signedIn: boolean }) {
	useTitle("");
	const [version, setVersion] = useState(0);
	const { data, error } = useAsync(() => api<Listed[]>("GET", "/projects"), [version, signedIn]);
	const [slug, setSlug] = useState("");
	const [description, setDescription] = useState("");
	const [source, setSource] = useState<"starter" | "import" | "empty">("starter");
	const [url, setUrl] = useState("");
	const create = useAction();
	const [adding, setAdding] = useState(false);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (await create.run(() => api("POST", "/projects", { slug, name: slug, description, source, url }))) navigate(`/p/${slug}`);
		else setVersion((v) => v + 1);
	};
	const startAdding = () => { setAdding(true); requestAnimationFrame(() => document.getElementById("projects")?.scrollIntoView({ block: "start" })); };
	return (
		<main>
			<section className="hero">
				<div className="hero-text">
					<p className="label">Intents, not branches</p>
					<h1>The git platform for many agents changing one codebase</h1>
					<p className="lede">Git merges text. It does not know what either side was trying to do. Braid keeps the why next to every change, and uses it while agents work, when their changes collide, and long afterwards.</p>
					<div className="row hero-actions">
						{signedIn ? <button className="primary big" onClick={startAdding}><Icon name="plus" />New project</button> : <button className="primary big" onClick={() => signIn()}>Sign in</button>}
						<a className="button big offset" href="#how">How it works<Icon name="chevron-down" /></a>
					</div>
				</div>
				<div className="hero-art"><HeroLoom /></div>
			</section>

			<section className="band" id="projects" aria-labelledby="projects-h">
				<div className="frame">
					<Corners />
					<div className="band-head">
						<div>
							<h2 id="projects-h">Projects{data && data.length > 0 && <span className="count">{data.length}</span>}</h2>
							<p className="dim">A project is a trunk repository on Cloudflare Artifacts. Every attempt is a fork of it.</p>
						</div>
						{signedIn ? !adding && <button className="primary" onClick={() => setAdding(true)}><Icon name="plus" />New project</button> : <button onClick={() => signIn()}>Sign in to create a project</button>}
					</div>
					{error && <Notice>{error}</Notice>}
					{signedIn && adding && (
						<form className="panel decide form new-project" onSubmit={submit}>
							<h3>New project</h3>
							<label>Name
								<input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="tally" pattern="[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]" required autoFocus aria-describedby="np-name" autoComplete="off" spellCheck={false} />
								<span className="hint" id="np-name">3 to 40 lowercase letters, numbers or single hyphens. It becomes the address <span className="mono">/p/{slug || "name"}</span>.</span>
							</label>
							<label>Description <span className="optional">optional</span><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this codebase is" /></label>
							<label>Trunk starts from
								<select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
									<option value="starter">A starter app (small, with tests, previewable)</option>
									<option value="import">An existing git repository (import by URL)</option>
									<option value="empty">Nothing yet (I will push a repository)</option>
								</select>
							</label>
							{source === "import" && <label>Repository URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" type="url" required /></label>}
							{source === "empty" && <p className="hint">The project page then shows the command that pushes a local repository into it.</p>}
							{create.error && <Notice>{create.error}</Notice>}
							<div className="row"><button className="primary" disabled={create.busy}>{create.busy ? (source === "import" ? "Importing the repository…" : "Creating the repository…") : "Create project"}</button><button type="button" onClick={() => setAdding(false)}>Cancel</button></div>
						</form>
					)}
					{!data && !error && <Empty kind="loading" title="Loading projects…" />}
					{data && data.length > 0 && <div className="pgrid">{data.map((p) => <ProjectCard key={p.slug} p={p} />)}</div>}
					{data?.length === 0 && (
						<Empty title={signedIn ? "No projects yet" : "No public projects on this instance"}>
							{signedIn ? <p>Create one to get a trunk repository agents can fork. <button className="link" onClick={() => setAdding(true)}>New project</button></p> : <p><button className="link" onClick={() => signIn()}>Sign in</button> to see the rest.</p>}
						</Empty>
					)}
				</div>
			</section>

			<section className="band" id="how" aria-labelledby="how-h">
				<div className="frame">
					<Corners />
					<div className="band-head"><div><h2 id="how-h">How it works</h2><p className="dim">One goal, several attempts, one trunk that only takes what has been run.</p></div></div>
					<ol className="how">
						{STEPS.map(([title, body], n) => (
							<li key={title} style={{ ["--c" as string]: `var(--i${n + 1})` }}>
								<StepArt step={(n + 1) as 1 | 2 | 3 | 4} />
								<span className="label"><span className="step-n">{n + 1}</span> of 4</span>
								<strong>{title}</strong>
								<p>{body}</p>
							</li>
						))}
					</ol>
				</div>
			</section>
			<footer className="foot"><Mark size={18} /><span>Braid runs on Cloudflare Workers and Artifacts.</span></footer>
		</main>
	);
}

function ProjectShell({ slug, rest }: { slug: string; rest: string[] }) {
	const { state, error, live } = useProject(slug);
	const bar = (inner?: ReactNode) => (
		<header className="shell">
			<Link to="/" className="brand" label="Braid, all projects"><Mark />Braid</Link>
			{inner}
		</header>
	);
	if (error && !state) return <>{bar()}<main className="page narrow"><Empty kind="broken" title="This project could not be opened"><p>{error}</p><p><Link to="/" className="button"><Icon name="back" />All projects</Link></p></Empty></main></>;
	if (!state) return <>{bar()}<main className="page"><Empty kind="loading" title="Loading the project…" /></main></>;
	const tab = rest[0] === "why" ? "why" : "work";
	const run = runFor(state, "trunk");
	return (
		<>
			{bar(<>
				<span className="crumb" aria-hidden="true">/</span>
				<Link to={`/p/${slug}`} className="project-name">{state.project.name}</Link>
				<nav aria-label="Project">
					<Link to={`/p/${slug}`} className={tab === "work" ? "on" : ""}><Icon name="strands" />Work</Link>
					<Link to={`/p/${slug}/why`} className={tab === "why" ? "on" : ""}><Icon name="search" />Why</Link>
				</nav>
				<span className="spacer" />
				<span className="trunk-state" title="The commit trunk is at, and whether Braid's run of it passed">
					<span className="label">trunk</span><span className="mono">{state.project.head ? state.project.head.slice(0, 7) : "empty"}</span><RunChip run={run} head={state.project.head} />
				</span>
				<span className={`live ${live ? "on" : ""}`} role="status">{live ? "Live" : "Reconnecting…"}</span>
			</>)}
			{state.viewer && (
				<p className="viewer-bar" role="status"><Icon name="eye" /><span>You are reading a public project. It updates as agents work and changes land.</span><button onClick={() => signIn()}>Sign in to change it</button></p>
			)}
			{rest[0] === "why" ? <WhyPage state={state} /> : rest[0] === "i" ? <IntentPage state={state} intentId={Number(rest[1])} /> : <ProjectPage state={state} />}
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
	const inProject = seg[0] === "p" && !!seg[1];
	return (
		<>
			<a className="skip" href="#main">Skip to content</a>
			{!inProject && (
				<header className="shell">
					<Link to="/" className="brand"><Mark />Braid</Link>
					<span className="tagline">intents, not branches</span>
					<span className="spacer" />
					<a className="shell-link" href="#how">How it works</a>
					{me && !me.signedIn && <button onClick={() => signIn()}>Sign in</button>}
				</header>
			)}
			<div id="main" tabIndex={-1}>
				{inProject ? <ProjectShell key={seg[1]} slug={seg[1]} rest={seg.slice(2)} /> : <Projects signedIn={me?.signedIn ?? true} />}
			</div>
			<SignIn />
			<AskHost />
		</>
	);
}
