import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { handleMcp } from "./mcp";
import { splitError, type BraidEnv, type Project } from "./project";
import { previewKey, SHOT_MIME } from "./shot";

export { Project } from "./project";
export { GitGateway, ImageGateway, RegistryGateway, Runner } from "./runner";
export { AgentHost, AgentOutbound } from "./agent";

const REGISTRY = "~registry";
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]$/;
// Every Project method is async, so the RPC stub has the same shape as the class.
const project = (env: BraidEnv, slug: string) => env.PROJECT.get(env.PROJECT.idFromName(slug)) as unknown as Project;

const MIME: Record<string, string> = {
	html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
	json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
	ico: "image/x-icon", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", woff2: "font/woff2", wasm: "application/wasm",
};

/**
 * Started by Artifacts for every push in the namespace (see triggers.events in wrangler.jsonc).
 * Repo names are `<project>--trunk` or `<project>--i<intent>-a<n>-<id>`, so the project is the prefix.
 */
export class PushWorkflow extends WorkflowEntrypoint<BraidEnv, any> {
	async run(event: WorkflowEvent<any>, step: WorkflowStep) {
		// The trigger hands the Workflow the Artifacts event; accept it bare or wrapped.
		const p = event.payload ?? {};
		const repo: string | undefined = p.source?.repoName ?? p.event?.source?.repoName ?? p.repoName ?? p.repo_name;
		if (!repo?.includes("--")) {
			console.warn("PushWorkflow: no Braid repo in event", JSON.stringify(p).slice(0, 500));
			return;
		}
		await step.do("refresh attempt and recompute overlaps", () => project(this.env, repo.split("--")[0]).onPush(repo));
	}
}

const COOKIE = "braid_session";
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
/** Compare without stopping at the first difference. */
function same(a: string, b: string) {
	let diff = a.length ^ b.length;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
	return diff === 0;
}
/** What the browser holds after signing in: derived from the admin token, so the token itself is not kept in a cookie. */
const sessionValue = (token: string) => sha256(`braid-session:${token}`);

/**
 * Who may use this instance. With BRAID_ADMIN_TOKEN set, everything needs it: reads too, because
 * project state includes agent session transcripts. Without one, Braid is open, which is only
 * allowed on localhost unless BRAID_OPEN is "true".
 */
async function access(request: Request, env: BraidEnv, url: URL): Promise<"ok" | "denied" | "unconfigured"> {
	const token = env.BRAID_ADMIN_TOKEN;
	if (!token) return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || env.BRAID_OPEN === "true" ? "ok" : "unconfigured";
	if (same(request.headers.get("authorization") ?? "", `Bearer ${token}`)) return "ok";
	const cookie = (request.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
	return same(cookie, await sessionValue(token)) ? "ok" : "denied";
}
const refuse = (how: "denied" | "unconfigured") => how === "denied"
	? Response.json({ error: "this Braid instance needs its admin token" }, { status: 401 })
	: Response.json({ error: "this Braid instance has no admin token. Set the BRAID_ADMIN_TOKEN secret, or set BRAID_OPEN to \"true\" to run it open to anyone." }, { status: 503 });

async function api(request: Request, env: BraidEnv, url: URL): Promise<Response> {
	const seg = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
	if (seg[0] === "login" && request.method === "POST") {
		const given = String(((await request.json().catch(() => ({}))) as any)?.token ?? "");
		if (!env.BRAID_ADMIN_TOKEN || !same(given, env.BRAID_ADMIN_TOKEN)) return Response.json({ error: "wrong admin token" }, { status: 401 });
		return Response.json({ ok: true }, { headers: {
			"set-cookie": `${COOKIE}=${await sessionValue(env.BRAID_ADMIN_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${url.protocol === "https:" ? "; Secure" : ""}`,
		} });
	}
	// Launchers and agents sign these two with their attempt token, which the project checks.
	const byAttemptToken = request.method === "POST" && seg[0] === "p" && (seg[2] === "credentials" || seg[2] === "session") && seg.length === 3;
	const allowed = byAttemptToken ? "ok" : await access(request, env, url);
	if (allowed === "denied" && request.method === "GET") return visitor(request, env, url, seg);
	if (allowed !== "ok") return refuse(allowed);
	if (seg[0] === "me") return Response.json({ signedIn: true, protected: !!env.BRAID_ADMIN_TOKEN });
	const body = async () => ((await request.json().catch(() => ({}))) ?? {}) as Record<string, any>;
	const { method } = request;
	const registry = project(env, REGISTRY);

	if (seg[0] === "projects" && seg.length === 1) {
		if (method === "GET") return Response.json(await registry.listProjects());
		if (method === "POST") {
			const b = await body();
			const slug = String(b.slug ?? "").toLowerCase();
			if (!SLUG.test(slug)) return Response.json({ error: "slug must be 3-40 characters: lowercase letters, digits, single hyphens" }, { status: 400 });
			await registry.registerProject(slug, String(b.name || slug), String(b.description ?? ""));
			try {
				await project(env, slug).init({ slug, name: String(b.name || slug), description: String(b.description ?? ""), source: b.source, url: b.url, branch: b.branch, review: b.review, plan: b.plan });
			} catch (e) {
				await registry.unregisterProject(slug);
				throw e;
			}
			return Response.json({ slug }, { status: 201 });
		}
	}

	// Take in a project exported from another instance on the same Artifacts namespace.
	if (seg[0] === "projects" && seg[1] === "import" && method === "POST") {
		const b = await body();
		const slug = String(b.dump?.meta?.find?.((m: any) => m.k === "slug")?.v ?? "");
		if (!SLUG.test(slug)) return Response.json({ error: "this is not a Braid project export" }, { status: 400 });
		const moved = await project(env, slug).importState(b.dump);
		await registry.registerProject(moved.slug, moved.name, moved.description);
		return Response.json({ slug }, { status: 201 });
	}

	if (seg[0] !== "p" || !seg[1]) return Response.json({ error: "not found" }, { status: 404 });
	const slug = seg[1], p = project(env, slug), rest = seg.slice(2), q = url.searchParams;

	if (rest[0] === "ws") return p.fetch(request);
	if (method === "GET") {
		if (rest.length === 0) {
			const state = await p.state(url.origin);
			const token = env.BRAID_ADMIN_TOKEN;
			if (token) state.previewKeys = Object.fromEntries(await Promise.all(["trunk", ...state.attempts.map((a) => a.id)].map(async (ref) => [ref, await previewKey(token, slug, ref)])));
			return Response.json(state);
		}
		if (rest[0] === "export") return Response.json(await p.exportState());
		if (rest[0] === "events") return Response.json(await p.events(Number(q.get("after")) || 0, Number(q.get("limit")) || 500));
		const read = await reads(p, rest, q);
		if (read) return read;
	}
	if (method === "DELETE" && rest.length === 0) {
		await p.destroy(q.get("repos") === "keep");
		await registry.unregisterProject(slug);
		return Response.json({ deleted: true });
	}
	if (method === "POST") {
		const b = await body();
		// A request that carries a key is done once however often it is sent.
		const key = (request.headers.get("idempotency-key") ?? "").slice(0, 100);
		const once = async (name: string, ...args: unknown[]): Promise<any> => (await (key ? p.keyed(key, name, args) : (p as any)[name](...args))) ?? { ok: true };
		if (rest[0] === "effects" && rest[1] === "retry") return Response.json(await p.retryEffect(String(b.id ?? "")));
		if (rest[0] === "intents" && rest.length === 1) return Response.json(await once("createIntent", b), { status: 201 });
		if (rest[0] === "intents" && rest[2] === "join") return Response.json(await once("join", { intentId: Number(rest[1]), agent: b.agent, kind: b.kind, origin: url.origin }), { status: 201 });
		if (rest[0] === "intents" && rest[2] === "host") return Response.json(await once("hostAgent", Number(rest[1]), b.kind === "codex" ? "codex" : b.kind === "selftest" ? "selftest" : "claude", typeof b.model === "string" ? b.model : undefined), { status: 201 });
		if (rest[0] === "intents" && rest[2] === "race") return Response.json(await once("race", Number(rest[1]), Array.isArray(b.agents) ? b.agents : undefined, b.by), { status: 201 });
		if (rest[0] === "intents" && rest[2] === "compare") return Response.json(await once("compare", Number(rest[1])));
		if (rest[0] === "attempts" && rest[2] === "rehost") return Response.json(await once("rehost", rest[1], b.task === "fix" ? "fix" : b.task === "respond" ? "respond" : "reconcile"), { status: 201 });
		if (rest[0] === "attempts" && rest[2] === "stop") return Response.json(await once("stopHosted", rest[1]));
		if (rest[0] === "intents" && rest[2] === "edit") return Response.json(await once("editIntent", Number(rest[1]), b));
		if (rest[0] === "attempts" && rest[2] === "respond") return Response.json(await once("respond", rest[1], b));
		if (rest[0] === "attempts" && rest[2] === "restore") return Response.json(await once("restoreAttempt", rest[1], b.by));
		if (rest[0] === "landings" && rest[2] === "revert") return Response.json(await once("revertLanding", rest[1], b.by, String(b.reason ?? "")));
		if (rest[0] === "intents" && rest[2] === "abandon") return Response.json(await once("abandonIntent", Number(rest[1]), b.by));
		if (rest[0] === "attempts" && rest[2] === "land") return Response.json(await once("land", rest[1], b.by, !!b.force, typeof b.sha === "string" ? b.sha : undefined));
		if (rest[0] === "attempts" && rest[2] === "review") return Response.json(await once("review", rest[1]));
		if (rest[0] === "attempts" && rest[2] === "cancel-landing") return Response.json(await once("cancelLanding", rest[1], b.by));
		if (rest[0] === "runs") return Response.json(await p.verify(String(b.ref ?? "trunk"), true));
		if (rest[0] === "attempts" && rest[2] === "abandon") return Response.json(await once("abandonAttempt", rest[1], b.by));
		if (rest[0] === "reconciliations" && rest[2] === "resolve") return Response.json(await once("resolve", Number(rest[1]), b.resolutions ?? [], String(b.rationale ?? ""), b.by, b.oneSided === true));
		if (rest[0] === "reconciliations" && rest[2] === "auto") return Response.json(await once("resolveWithModel", Number(rest[1])));
		if (rest[0] === "push") return Response.json((await p.onPush(String(b.repo))) ?? { ok: true });
		// Session events from an agent's launcher, authenticated by the attempt token.
		if (rest[0] === "session") return Response.json(await p.ingest((request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""), b.events, b.model));
		if (rest[0] === "trunk-credentials") return Response.json(await p.trunkCredentials());
		if (rest[0] === "clone-credentials") return Response.json(await p.cloneCredentials());
		if (rest[0] === "review") return Response.json(await p.setReview(b.review === true, b.by));
		if (rest[0] === "planning") return Response.json(await p.setPlan(b.plan === true, b.by));
		if (rest[0] === "plan" && rest.length === 1) return Response.json(await once("proposeSplit", String(b.goal ?? ""), b.by), { status: 201 });
		if (rest[0] === "proposals" && rest[2] === "accept") return Response.json(await once("acceptProposal", Number(rest[1]), b), { status: 201 });
		if (rest[0] === "proposals" && rest[2] === "drop") return Response.json(await once("dropProposal", Number(rest[1])));
		if (rest[0] === "relations" && rest[2] === "dismiss") return Response.json(await once("dismissRelation", Number(rest[1]), b.by));
		if (rest[0] === "intents" && rest[2] === "plan") return Response.json(await once("plan", Number(rest[1])));
		if (rest[0] === "intents" && rest[2] === "relations") return Response.json(await once("relateIntents", Number(rest[1]), b), { status: 201 });
		if (rest[0] === "public") {
			const made = await p.setPublic(b.public === true, b.by);
			await registry.markPublic(slug, made.public);
			return Response.json(made);
		}
		if (rest[0] === "context-credentials") return Response.json(await p.contextCredentials());
		if (rest[0] === "credentials") return Response.json(await p.credentials(String(b.agentToken ?? "")));
	}
	return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * Someone who has not signed in. They can read the projects whose owner made them public, live, and
 * nothing else: no writes, no export, no credentials, no other project.
 */
async function visitor(request: Request, env: BraidEnv, url: URL, seg: string[]): Promise<Response> {
	if (seg[0] === "me") return Response.json({ signedIn: false, protected: true });
	if (seg[0] === "projects" && seg.length === 1) return Response.json(await project(env, REGISTRY).listProjects(true));
	if (seg[0] !== "p" || !seg[1]) return refuse("denied");
	const slug = seg[1], p = project(env, slug), rest = seg.slice(2);
	if (!SLUG.test(slug) || !(await p.isPublic())) return refuse("denied");
	if (rest[0] === "ws" && rest.length === 1) return p.fetch(request);
	if (rest.length === 0) {
		const state = await p.state(), token = env.BRAID_ADMIN_TOKEN!;
		state.viewer = true;
		state.previewKeys = Object.fromEntries(await Promise.all(["trunk", ...state.attempts.map((a) => a.id)].map(async (ref) => [ref, await previewKey(token, slug, ref)])));
		return Response.json(state);
	}
	return (await reads(p, rest, url.searchParams)) ?? refuse("denied");
}

/** The read-only views of one project, shared by the API and by previews that are allowed to read it. */
async function reads(p: Project, rest: string[], q: URLSearchParams): Promise<Response | null> {
	if (rest[0] === "attempts" && rest[2] === "session") return Response.json(await p.session(rest[1], Number(q.get("after") ?? 0)));
	if (rest[0] === "attempts" && rest[2] === "diff") return Response.json(await p.diff(rest[1]));
	if (rest[0] === "attempts" && rest[2] === "against" && rest[3]) return Response.json(await p.against(rest[1], rest[3]));
	if (rest[0] === "attempts" && rest[2] === "shot") {
		const shot = await p.shot(rest[1]);
		return shot ? new Response(shot.bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": SHOT_MIME, "cache-control": "private, max-age=31536000, immutable", etag: `"${shot.sha}"` } }) : new Response("no picture of this attempt", { status: 404 });
	}
	if (rest[0] === "reconciliations" && rest[2] === "marked") return Response.json(await p.marked(Number(rest[1]), q.get("path") ?? ""));
	if (rest[0] === "tree") return Response.json(await p.tree(q.get("ref") ?? "trunk"));
	if (rest[0] === "history") return Response.json(await p.history(Number(q.get("limit") ?? 200), q.get("inside") === "1"));
	if (rest[0] === "file") return Response.json(await p.file(q.get("path") ?? ""));
	return null;
}

/**
 * A preview whose repository says `"preview": { "api": "braid" }` gets its /api/ calls answered by this
 * instance: reads only, and only of the project the preview belongs to. That is what lets Braid's own
 * UI be previewed against real data. The code asking is an attempt's, so it gets nothing it could
 * change and nothing from other projects.
 */
async function previewApi(request: Request, env: BraidEnv, slug: string, path: string, q: URLSearchParams): Promise<Response> {
	const seg = path.split("/").filter(Boolean).slice(1); // after "api"
	const p = project(env, slug);
	const cors = (r: Response) => { const out = new Response(r.body, r); out.headers.set("access-control-allow-origin", "*"); return out; };
	if (request.method === "OPTIONS") return cors(new Response(null, { status: 204, headers: { "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET" } }));
	const readOnly = () => cors(Response.json({ error: "this is a preview: it can read this project and change nothing" }, { status: 403 }));
	if (request.method !== "GET") return readOnly();
	if (seg[0] === "projects" && seg.length === 1) return cors(Response.json((await project(env, REGISTRY).listProjects()).filter((x) => x.slug === slug)));
	if (seg[0] !== "p" || seg[1] !== slug) return readOnly();
	const rest = seg.slice(2);
	if (rest[0] === "ws" && rest.length === 1) return p.fetch(request);
	if (rest.length === 0) return cors(Response.json(await p.state()));
	return cors((await reads(p, rest, q)) ?? Response.json({ error: "not found" }, { status: 404 }));
}

/**
 * Put in front of a built page. The page is served under /preview/<project>/<ref>/ but was built to
 * live at the root of a site, so requests it makes to "/..." are sent under the preview path, and its
 * router is shown the path it expects. The base element keeps the page's relative links pointing at
 * the preview once the address has been rewritten.
 */
const shim = (base: string) => `<base href="${base}/"><script>(function(){var B=${JSON.stringify(base)};
function fix(u){try{var x=new URL(u,document.baseURI);if(x.host===location.host&&x.pathname!==B&&x.pathname.indexOf(B+"/")!==0)x.pathname=B+x.pathname;return x.href}catch(e){return u}}
var p=location.pathname;if(p===B||p.indexOf(B+"/")===0){try{history.replaceState(history.state,"",(p.slice(B.length)||"/")+location.search+location.hash)}catch(e){}}
var f=window.fetch;window.fetch=function(i,o){if(typeof i==="string"||i instanceof URL)i=fix(String(i));else if(i instanceof Request)i=new Request(fix(i.url),i);return f.call(this,i,o)};
var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(u);return xo.apply(this,arguments)};
var W=window.WebSocket;window.WebSocket=function(u,pr){return pr===undefined?new W(fix(u)):new W(fix(u),pr)};window.WebSocket.prototype=W.prototype;
if(window.EventSource){var E=window.EventSource;window.EventSource=function(u,c){return new E(fix(u),c)};window.EventSource.prototype=E.prototype}
document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(a&&!e.defaultPrevented&&a.host===location.host&&!a.target){a.href=fix(a.href)}});
})();</script>`;

/** Serve a ref's preview: the build Braid made of it, or its files straight out of Artifacts when there is nothing to build. */
async function preview(request: Request, env: BraidEnv, url: URL): Promise<Response> {
	const [, , slug, refAndKey = "", ...parts] = url.pathname.split("/");
	// `<ref>~<key>`: files inside the frame are fetched without cookies, so the key is part of every relative URL.
	const [ref, key = ""] = refAndKey.split("~");
	const allowed = env.BRAID_ADMIN_TOKEN && same(key, await previewKey(env.BRAID_ADMIN_TOKEN, slug, ref)) ? "ok" : await access(request, env, url);
	if (allowed !== "ok") return refuse(allowed);
	let path = decodeURIComponent(parts.join("/"));
	if (path === "" || path.endsWith("/")) path += "index.html";
	const file = await project(env, slug).raw(ref, path);
	if (!file) return new Response("not found in this attempt", { status: 404 });
	if ("proxy" in file) return previewApi(request, env, slug, path, url.searchParams);
	const ext = file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase();
	let body: BodyInit = file.bytes as Uint8Array<ArrayBuffer>;
	const base = `/preview/${slug}/${refAndKey}`;
	// Built sites usually link their assets from the site root; point those at this preview instead.
	if (file.built && ext === "html") {
		const html = new TextDecoder().decode(file.bytes).replace(/\b(src|href)=(["'])\/(?!\/)/g, `$1=$2${base}/`);
		body = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => head + shim(base)) : shim(base) + html;
	}
	// Agent-written code runs here; give it an opaque origin so it cannot call the Braid API as the viewer.
	let csp = "sandbox allow-scripts allow-forms allow-modals";
	// A preview that can read the project must not be able to send what it reads anywhere else.
	if (file.api) csp += `; default-src ${url.origin} data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src ${url.origin} ${url.origin.replace(/^http/, "ws")}; form-action 'none'`;
	return new Response(body, {
		headers: {
			"content-type": MIME[ext] ?? "application/octet-stream",
			"cache-control": "no-store",
			// The frame has an opaque origin, and module scripts and fonts are fetched with CORS even from their own site.
			"access-control-allow-origin": "*",
			"content-security-policy": csp,
		},
	});
}

export default {
	async fetch(request: Request, env: BraidEnv): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname.startsWith("/api/")) return await api(request, env, url);
			if (url.pathname.startsWith("/preview/")) return await preview(request, env, url);
			if (url.pathname.startsWith("/mcp/")) {
				const slug = url.pathname.split("/")[2];
				const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
				return await handleMcp(request, project(env, slug), token);
			}
			return new Response("not found", { status: 404 });
		} catch (e: any) {
			// Errors cross the Durable Object boundary as plain Errors; BraidError puts its status in the message.
			const { status, message } = splitError(e);
			if (status === 500) console.error(e?.stack ?? e);
			return Response.json({ error: message }, { status });
		}
	},
} satisfies ExportedHandler<BraidEnv>;
