import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { handleMcp } from "./mcp";
import { splitError, type BraidEnv, type Project } from "./project";

export { Project } from "./project";

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
/** Lets a sandboxed preview frame load one ref. Its requests carry no cookie, so the key travels in the path. */
async function previewKey(token: string, slug: string, ref: string) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`preview:${slug}:${ref}`))).slice(0, 32);
}

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
	if (allowed !== "ok") return refuse(allowed);
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
				await project(env, slug).init({ slug, name: String(b.name || slug), description: String(b.description ?? ""), source: b.source, url: b.url, branch: b.branch });
			} catch (e) {
				await registry.unregisterProject(slug);
				throw e;
			}
			return Response.json({ slug }, { status: 201 });
		}
	}

	if (seg[0] !== "p" || !seg[1]) return Response.json({ error: "not found" }, { status: 404 });
	const slug = seg[1], p = project(env, slug), rest = seg.slice(2), q = url.searchParams;

	if (rest[0] === "ws") return p.fetch(request);
	if (method === "GET") {
		if (rest.length === 0) {
			const state = await p.state();
			const token = env.BRAID_ADMIN_TOKEN;
			if (token) state.previewKeys = Object.fromEntries(await Promise.all(["trunk", ...state.attempts.map((a) => a.id)].map(async (ref) => [ref, await previewKey(token, slug, ref)])));
			return Response.json(state);
		}
		if (rest[0] === "attempts" && rest[2] === "session") return Response.json(await p.session(rest[1], Number(q.get("after") ?? 0)));
		if (rest[0] === "attempts" && rest[2] === "diff") return Response.json(await p.diff(rest[1]));
		if (rest[0] === "tree") return Response.json(await p.tree(q.get("ref") ?? "trunk"));
		if (rest[0] === "file") return Response.json(await p.file(q.get("path") ?? ""));
	}
	if (method === "DELETE" && rest.length === 0) {
		await p.destroy();
		await registry.unregisterProject(slug);
		return Response.json({ deleted: true });
	}
	if (method === "POST") {
		const b = await body();
		if (rest[0] === "intents" && rest.length === 1) return Response.json(await p.createIntent(b as any), { status: 201 });
		if (rest[0] === "intents" && rest[2] === "join") return Response.json(await p.join({ intentId: Number(rest[1]), agent: b.agent, kind: b.kind, origin: url.origin }), { status: 201 });
		if (rest[0] === "intents" && rest[2] === "abandon") return Response.json((await p.abandonIntent(Number(rest[1]), b.by)) ?? { ok: true });
		if (rest[0] === "attempts" && rest[2] === "land") return Response.json(await p.land(rest[1], b.by));
		if (rest[0] === "attempts" && rest[2] === "abandon") return Response.json((await p.abandonAttempt(rest[1], b.by)) ?? { ok: true });
		if (rest[0] === "reconciliations" && rest[2] === "resolve") return Response.json(await p.resolve(Number(rest[1]), b.resolutions ?? [], String(b.rationale ?? ""), b.by));
		if (rest[0] === "reconciliations" && rest[2] === "auto") return Response.json(await p.resolveWithModel(Number(rest[1])));
		if (rest[0] === "push") return Response.json((await p.onPush(String(b.repo))) ?? { ok: true });
		// Session events from an agent's launcher, authenticated by the attempt token.
		if (rest[0] === "session") return Response.json(await p.ingest((request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""), b.events));
		if (rest[0] === "trunk-credentials") return Response.json(await p.trunkCredentials());
		if (rest[0] === "context-credentials") return Response.json(await p.contextCredentials());
		if (rest[0] === "credentials") return Response.json(await p.credentials(String(b.agentToken ?? "")));
	}
	return Response.json({ error: "not found" }, { status: 404 });
}

/** Serve any file from trunk or an attempt straight out of Artifacts: a live preview with no build. */
async function preview(request: Request, env: BraidEnv, url: URL): Promise<Response> {
	const [, , slug, refAndKey = "", ...parts] = url.pathname.split("/");
	// `<ref>~<key>`: files inside the frame are fetched without cookies, so the key is part of every relative URL.
	const [ref, key = ""] = refAndKey.split("~");
	const allowed = env.BRAID_ADMIN_TOKEN && same(key, await previewKey(env.BRAID_ADMIN_TOKEN, slug, ref)) ? "ok" : await access(request, env, url);
	if (allowed !== "ok") return refuse(allowed);
	let path = decodeURIComponent(parts.join("/"));
	if (path === "" || path.endsWith("/")) path += "index.html";
	const bytes = await project(env, slug).raw(ref, path);
	if (!bytes) return new Response("not found in this attempt", { status: 404 });
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return new Response(bytes as Uint8Array<ArrayBuffer>, {
		headers: {
			"content-type": MIME[ext] ?? "application/octet-stream",
			"cache-control": "no-store",
			// Agent-written code runs here; give it an opaque origin so it cannot call the Braid API as the viewer.
			"content-security-policy": "sandbox allow-scripts allow-forms allow-modals",
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
