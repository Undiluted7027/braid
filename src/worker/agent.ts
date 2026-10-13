// Runs a coding agent for one attempt inside Cloudflare: a Linux sandbox with the attempt cloned,
// Claude Code or Codex started headless in it, and its session streamed into the project.
// The sandbox has no Internet access and holds no credentials. Everything it sends goes through
// AgentOutbound below, which decides what it may reach and adds the tokens outside the sandbox.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { claudeEvents, codexEvents, type CapturedEvent } from "../shared/capture";
import { redact } from "../shared/redact";
import { ArtifactsHost } from "./host";
import { handleMcp } from "./mcp";
import type { BraidEnv, Project } from "./project";
import { gradleInit, mavenSettings, registriesFor, type Maven, type Toolchain } from "./environment.ts";
import { TOOL_ENV } from "./runner";

export type HostedKind = "claude" | "codex" | "selftest";
export interface HostJob {
	slug: string; attemptId: string; kind: HostedKind; agent: string;
	repo: string; remote: string; trunkRepo: string; trunkRemote: string; branch: string;
	agentToken: string; brief: string;
	/** Why the agent is being started: a new attempt, or brought back to an attempt that needs something. */
	task: "work" | "reconcile" | "fix" | "respond";
	/** The model to run the agent on, when the attempt was started with one. Otherwise the instance's model for that agent. */
	model?: string;
	/** What the attempt's code needs to be run in. It decides the sandbox image and which package registries can be read. */
	toolchain?: Toolchain;
	/** For a Java project: the mirror its packages come from, as trunk has it. */
	maven?: Maven;
}
interface OutboundProps { slug: string; gitHost: string; repo: string; repoPath: string; trunkRepo: string; trunkPath: string; agentToken: string; kind: HostedKind; registries: string[] }

/** A hostname that exists only inside the sandbox: requests to it are answered by this Worker. */
const BRAID_HOST = "braid.internal";
const GATEWAY_HOST = "gateway.ai.cloudflare.com";
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// The CA alone replaces the system trust store, which works because every HTTPS request is intercepted.
const TRUST = { NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, CURL_CA_BUNDLE: CA, SSL_CERT_FILE: CA, NPM_CONFIG_CAFILE: CA, REQUESTS_CA_BUNDLE: CA, PIP_CERT: CA, CARGO_HTTP_CAINFO: CA };
const REPO = "/workspace/repo", TASK = "/workspace/task";
const POLL_MS = 4000;
const MAX_RUN_MS = 45 * 60 * 1000;
const INACTIVITY_MS = 30 * 60 * 1000;

/** Which hosted agents this instance can run, from the credentials it has been given. */
export function hosting(env: BraidEnv) {
	const gateway = !!(env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_ID && env.AI_GATEWAY_ACCOUNT_ID);
	return { available: !!env.AGENT, claude: !!env.AGENT && (gateway || !!env.ANTHROPIC_API_KEY), codex: !!env.AGENT && (gateway || !!env.OPENAI_API_KEY), via: gateway ? "AI Gateway" : "provider keys" };
}
const gatewayPath = (env: BraidEnv) => `/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}`;
const useGateway = (env: BraidEnv) => !!(env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_ID && env.AI_GATEWAY_ACCOUNT_ID);

export class AgentOutbound extends WorkerEntrypoint<BraidEnv, OutboundProps> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url), p = this.ctx.props, env = this.env;
		const refuse = (why: string) => new Response(`Braid: ${why}\n`, { status: 403 });
		if (url.protocol !== "https:") return refuse(`${url.hostname} is reachable only over HTTPS`);

		// Braid itself. The attempt's token is added here, so the agent never holds it.
		if (url.hostname === BRAID_HOST) {
			if (url.pathname !== `/mcp/${p.slug}`) return refuse("only this project's Braid tools are reachable");
			return handleMcp(request, env.PROJECT.get(env.PROJECT.idFromName(p.slug)) as unknown as Project, p.agentToken);
		}

		// Git: read and write its own attempt, read trunk, nothing else.
		if (url.hostname === p.gitHost) {
			const speaks = (path: string, service: string) =>
				(request.method === "GET" && url.pathname === `${path}/info/refs` && url.search === `?service=${service}`) || (request.method === "POST" && url.pathname === `${path}/${service}`);
			const own = speaks(p.repoPath, "git-upload-pack") || speaks(p.repoPath, "git-receive-pack");
			if (!own && !speaks(p.trunkPath, "git-upload-pack")) return refuse("this sandbox may fetch and push its own attempt and fetch trunk");
			const headers = new Headers(request.headers);
			headers.set("authorization", `Bearer ${await new ArtifactsHost(env.ARTIFACTS).token(own ? p.repo : p.trunkRepo, own ? "write" : "read", 600)}`);
			return fetch(new Request(request, { headers }));
		}

		// The model: only the calls this agent makes to its own provider, so the sandbox cannot spend on
		// anything else the gateway or the key could reach. The key or gateway token is added here and
		// whatever placeholder the agent sent is dropped.
		const headers = new Headers(request.headers);
		const calls = p.kind === "claude" ? /^\/v1\/messages(\/count_tokens)?$/ : p.kind === "codex" ? /^\/(v1\/)?responses$/ : null;
		const provider = p.kind === "claude" ? "anthropic" : "openai", modelHost = p.kind === "claude" ? "api.anthropic.com" : "api.openai.com";
		const viaGateway = useGateway(env) && url.hostname === GATEWAY_HOST && url.pathname.startsWith(`${gatewayPath(env)}/${provider}/`);
		if (viaGateway || (!useGateway(env) && url.hostname === modelHost)) {
			const path = viaGateway ? url.pathname.slice(`${gatewayPath(env)}/${provider}`.length) : url.pathname;
			if (request.method !== "POST" || !calls?.test(path)) return refuse(`only this agent's model calls are reachable on ${url.hostname}`);
		}
		if (viaGateway) {
			headers.delete("x-api-key");
			headers.delete("authorization");
			headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`);
			return fetch(new Request(request, { headers }));
		}
		if (!useGateway(env) && p.kind === "claude" && url.hostname === "api.anthropic.com" && env.ANTHROPIC_API_KEY) {
			headers.delete("authorization");
			headers.set("x-api-key", env.ANTHROPIC_API_KEY);
			return fetch(new Request(request, { headers }));
		}
		if (!useGateway(env) && p.kind === "codex" && url.hostname === "api.openai.com" && env.OPENAI_API_KEY) {
			headers.set("authorization", `Bearer ${env.OPENAI_API_KEY}`);
			return fetch(new Request(request, { headers }));
		}

		// Packages, read-only, so the agent can install and run the project's own checks.
		if ((p.registries ?? ["registry.npmjs.org"]).includes(url.hostname) && (request.method === "GET" || request.method === "HEAD")) return fetch(request);
		return refuse(`${url.hostname} is not reachable from this sandbox`);
	}
}

// Runs the agent in its own process group, recording its process id when it starts and its exit code when it ends.
const TASK_SCRIPT = `dir=$1; shift
setsid sh -c 'echo "$$" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log" </dev/null
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

const PROMPT = `You are working on a Braid attempt, in a sandbox on Cloudflare. Read BRAID.md in this directory first and follow its protocol exactly.
The braid MCP server is connected: call its tools directly (brief, claim, record, checkpoint, ready, ...).
Do the work the intent asks for, commit, push with the command given in BRAID.md, checkpoint after every push, record your decisions as you make them, wait for Braid's verification of your last commit, and finish by marking the attempt ready.`;

const TASKS = {
	work: PROMPT,
	reconcile: `You are back on a Braid attempt you already worked on, in a sandbox on Cloudflare. Read BRAID.md first.
Landing this attempt conflicted with trunk: another intent changed the same lines. Call the braid \`reconciliation\` tool to get both versions, their base, and the intent and decisions behind the trunk side.
Write a version of each conflicted file that satisfies BOTH intents, then call \`resolve\` with the resolutions and a rationale that says concretely how each side's intent survives. Record the decision. Do not start other work.`,
	fix: `You are back on a Braid attempt you already worked on, in a sandbox on Cloudflare. Read BRAID.md first.
Braid ran your last commit in a clean sandbox and it failed, either on its own or once merged with trunk. Call \`checkpoint\` to see which steps failed and their output (\`verification\`, and \`merged_with_trunk\` inside it). If it is the merge that fails, merge trunk into your attempt first (see \`sync\`). Before you edit a file you have not claimed, \`claim\` it: a change outside what an attempt said it would touch is flagged for a person. Fix the cause, commit, push, checkpoint again, wait for verification to pass, then mark the attempt ready. Record what you changed and why.`,
	respond: `You are back on a Braid attempt you already worked on, in a sandbox on Cloudflare. Read BRAID.md first.
The attempt was read and sent back with a note, by a person or by the project's reviewer, or a question you recorded was answered: the notes are at the end of BRAID.md, and arrive in \`heads_up\` on your first tool call. Call \`brief\`, then do what they ask. If a note answers a question you recorded, carry on from it.
Before you edit a file you have not claimed, \`claim\` it: a change outside what an attempt said it would touch is flagged for a person, and would stop this attempt landing by itself.
Record how you addressed each note, commit, push, checkpoint, wait for verification to pass, then mark the attempt ready again. Do not start other work.`,
};

// Stands in for an agent when checking the plumbing: it speaks, uses Braid's tools, commits, pushes and probes what it can reach.
const SELFTEST = `
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const say = (text) => console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
const sh = (c) => { try { return "ok " + execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim().split("\\n").pop().slice(0, 80); } catch (e) { return "refused " + String(e.stderr || e.message).trim().split("\\n").pop().slice(-80); } };
const get = async (u) => { try { return "status " + (await fetch(u, { signal: AbortSignal.timeout(8000) })).status; } catch (e) { return "blocked " + (e.cause?.code ?? e.message); } };
let id = 0;
const tool = async (name, args = {}) => {
	const r = await fetch(process.env.BRAID_MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
	const m = await r.json();
	return m.result?.isError ? "error " + m.result.content[0].text : JSON.parse(m.result.content[0].text);
};
say("Self-test: checking Braid tools, git and what this sandbox can reach.");
const brief = await tool("brief");
say("brief -> " + (typeof brief === "string" ? brief : "ok, " + brief.others.length + " other live attempts"));
await tool("claim", { paths: ["HOSTED_SELFTEST.md"], reason: "self-test marker" });
appendFileSync("HOSTED_SELFTEST.md", "Written by the hosted self-test at " + new Date().toISOString() + "\\n");
say("commit -> " + sh("git add HOSTED_SELFTEST.md && git commit -q -m 'hosted self-test' && git rev-parse --short HEAD"));
say("push own attempt -> " + sh("git push origin HEAD:" + process.env.BRAID_BRANCH + " 2>&1"));
say("fetch trunk -> " + sh("git fetch trunk " + process.env.BRAID_BRANCH + " 2>&1 && echo fetched"));
say("push trunk -> " + sh("git push trunk HEAD:refs/heads/selftest 2>&1"));
say("internet -> " + (await get("https://example.com/")));
say("registry -> " + (await get("https://registry.npmjs.org/left-pad")));
say("secrets in env -> " + (Object.entries(process.env).filter(([k, v]) => /art_v1_|brd_|sk-/.test(v) || /TOKEN|SECRET/.test(k)).map(([k]) => k).join(",") || "none"));
say("git config credentials -> " + sh("git config --list | grep -ci authorization || true"));
await tool("record", { kind: "note", title: "Hosted self-test ran", body: "Tools, git and isolation were exercised from inside the sandbox.", files: ["HOSTED_SELFTEST.md"] });
const cp = await tool("checkpoint", { summary: "hosted self-test" });
say("checkpoint -> " + (typeof cp === "string" ? cp : "head " + cp.head.slice(0, 7) + ", verification " + cp.verification.status));
console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: 1 }));
`;

export class AgentHost extends DurableObject<BraidEnv> {
	constructor(ctx: DurableObjectState, env: BraidEnv) {
		super(ctx, env);
		// The timeout does not survive a restart of this object, so set it again for a container that is still running.
		if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(INACTIVITY_MS));
	}

	private get kv() { return this.ctx.storage.kv; }
	private project(job: HostJob) { return this.env.PROJECT.get(this.env.PROJECT.idFromName(job.slug)) as unknown as Project; }

	/** Queue the agent and return; the alarm sets up the sandbox and then follows the agent until it exits. */
	async start(job: HostJob) {
		if (this.kv.get("phase") === "running" || this.kv.get("phase") === "new") throw new Error("[409] an agent is already running for this attempt");
		this.kv.put("job", job);
		this.kv.put("phase", "new");
		this.kv.put("offset", 0);
		this.kv.put("startedAt", Date.now());
		await this.ctx.storage.setAlarm(Date.now());
	}

	async stop(why = "stopped by a person") {
		const job = this.kv.get<HostJob>("job");
		if (!job || this.kv.get("phase") === "done") return;
		await this.finish(job, "stopped", why);
	}

	async clear() {
		await this.ctx.storage.deleteAlarm();
		if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
		await this.ctx.storage.deleteAll();
	}

	async alarm() {
		const job = this.kv.get<HostJob>("job"), phase = this.kv.get<string>("phase");
		if (!job || phase === "done") return;
		try {
			if (phase === "new") {
				await this.launch(job);
				this.kv.put("phase", "running");
			} else {
				const container = this.ctx.container;
				if (!container?.running) return await this.finish(job, "failed", "the sandbox stopped before the agent finished");
				await this.forward(job);
				const code = await this.read(`${TASK}/exit-code`);
				if (code !== null) {
					await this.forward(job, true);
					const stderr = code.trim() === "0" ? "" : redact((await this.read(`${TASK}/stderr.log`)) ?? "").slice(-800);
					return await this.finish(job, code.trim() === "0" ? "finished" : "failed", code.trim() === "0" ? "" : `exited with code ${code.trim()}${stderr ? `: ${stderr}` : ""}`);
				}
				if (Date.now() - (this.kv.get<number>("startedAt") ?? 0) > MAX_RUN_MS) return await this.finish(job, "stopped", "ran longer than 45 minutes");
			}
			await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
		} catch (e) {
			await this.finish(job, "failed", redact(String((e as Error)?.message ?? e)).slice(0, 500));
		}
	}

	private async finish(job: HostJob, state: "finished" | "failed" | "stopped", detail: string) {
		this.kv.put("phase", "done");
		await this.ctx.storage.deleteAlarm();
		if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
		await this.project(job).hostedDone(job.attemptId, state, detail);
	}

	private async exec(argv: string[], cwd = "/workspace", env: Record<string, string> = {}, stdin?: string) {
		const p = await this.ctx.container!.exec(argv, { cwd, env: { HOME: "/root", ...TOOL_ENV, ...TRUST, ...env }, stderr: "combined", ...(stdin === undefined ? {} : { stdin: new Blob([stdin]).stream() }) });
		const out = await p.output();
		return { code: out.exitCode, text: new TextDecoder().decode(out.stdout) };
	}
	private async must(what: string, argv: string[], cwd?: string, stdin?: string) {
		const r = await this.exec(argv, cwd, {}, stdin);
		if (r.code !== 0) throw new Error(`${what} failed: ${r.text.trim().split("\n").pop()}`);
	}
	private async read(path: string): Promise<string | null> {
		const r = await this.exec(["cat", path]);
		return r.code === 0 ? r.text : null;
	}

	/** Start the sandbox, clone the attempt, give the agent its brief and its tools, and start it in the background. */
	private async launch(job: HostJob) {
		const container = this.ctx.container;
		if (!container) throw new Error("no container is configured for hosted agents");
		if (container.running) await container.destroy().catch(() => {});
		const git = new URL(job.remote), env = this.env;
		const props: OutboundProps = { slug: job.slug, gitHost: git.hostname, repo: job.repo, repoPath: git.pathname, trunkRepo: job.trunkRepo, trunkPath: new URL(job.trunkRemote).pathname, agentToken: job.agentToken, kind: job.kind, registries: [...registriesFor(job.toolchain ?? "node"), ...(job.maven?.hosts ?? [])] };
		const images = container.images as Record<string, typeof container.images.agent>;
		container.start({ image: (job.toolchain && job.toolchain !== "node" && images[job.toolchain]) || images.agent, enableInternet: false, instance: "standard-2" });
		const outbound = this.ctx.exports.AgentOutbound({ props });
		await container.interceptAllOutboundHttp(outbound);
		await container.interceptOutboundHttps("*", outbound);
		await container.setInactivityTimeout(INACTIVITY_MS);

		const mcp = `https://${BRAID_HOST}/mcp/${job.slug}`;
		await this.must("clone", ["git", "clone", "-q", job.remote, REPO]);
		// A Java project's agent is given the same mirror, and the same trust in the gateway, as its checks are.
		if (job.toolchain === "java") {
			await this.must("java trust", ["sh", "-c", `keytool -importcert -noprompt -trustcacerts -cacerts -storepass changeit -alias braid-sandbox -file ${CA} >/dev/null 2>&1 || true`]);
			if (job.maven?.mirror) await this.must("java mirror", ["sh", "-c", `mkdir -p "$HOME/.m2" "$HOME/.gradle" && printf %s "$0" > "$HOME/.m2/settings.xml" && printf %s "$1" > "$HOME/.gradle/init.gradle"`, mavenSettings(job.maven.mirror), gradleInit(job.maven.mirror)]);
		}
		await this.must("git setup", ["sh", "-c", `git config user.name "$0" && git config user.email "$0@agents.braid.dev" && git remote add trunk "$1" && mkdir -p ${TASK} && printf '\\nBRAID.md\\n.mcp.json\\n' >> .git/info/exclude`, job.agent, job.trunkRemote], REPO);
		await this.must("write brief", ["sh", "-c", "cat > BRAID.md"], REPO, `${job.brief}

## Tools

The \`braid\` MCP server is connected. Use its tools: brief, claim, record, checkpoint, peek, message, check, ready, reconciliation, resolve, sync.

## Git

- This directory is your attempt: a private fork of trunk. \`origin\` is already authenticated.
- \`trunk\` is the project's trunk, read-only: \`git fetch trunk ${job.branch}\` then \`git merge FETCH_HEAD\` brings your attempt up to date.
- Push with \`git push origin HEAD:${job.branch}\`, then call \`checkpoint\`.
- Do not commit BRAID.md or .mcp.json (they are ignored locally).
- You are in a sandbox${job.toolchain && job.toolchain !== "node" ? ` with ${job.toolchain === "python" ? "Python (uv, poetry, pytest, ruff, mypy)" : job.toolchain === "go" ? "Go" : job.toolchain === "rust" ? "Rust (cargo, clippy, rustfmt)" : "Java (a JDK and Maven)"} and Node` : ""}: it can reach Braid, this repository, trunk, the model and the package registr${registriesFor(job.toolchain ?? "node").length > 1 ? "ies" : "y"} (${registriesFor(job.toolchain ?? "node").join(", ")}), and nothing else.
`);
		await this.must("write mcp config", ["sh", "-c", "cat > .mcp.json"], REPO, JSON.stringify({ mcpServers: { braid: { type: "http", url: mcp } } }));

		const model = job.model || (job.kind === "codex" ? (env.HOSTED_CODEX_MODEL || "gpt-6.1-sol") : (env.HOSTED_CLAUDE_MODEL || "claude-sonnet-5-5"));
		let argv: string[], agentEnv: Record<string, string> = {};
		if (job.kind === "selftest") {
			await this.must("write self-test", ["sh", "-c", `cat > ${TASK}/selftest.mjs`], REPO, SELFTEST);
			argv = ["node", `${TASK}/selftest.mjs`];
			agentEnv = { BRAID_MCP: mcp, BRAID_BRANCH: job.branch };
		} else if (job.kind === "codex") {
			const base = useGateway(env) ? `https://${GATEWAY_HOST}${gatewayPath(env)}/openai` : "https://api.openai.com/v1";
			argv = ["codex", "exec", "--json", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "--model", model,
				"--config", 'model_provider="braid"', "--config", `model_providers.braid={ name = "Braid", base_url = ${JSON.stringify(base)}, wire_api = "responses" }`,
				"--config", "analytics.enabled=false", "--config", "check_for_update_on_startup=false", "--config", "features.plugins=false",
				"--config", `mcp_servers.braid.url=${JSON.stringify(mcp)}`, "--config", `mcp_servers.braid.default_tools_approval_mode="approve"`, "--", TASKS[job.task]];
		} else {
			argv = ["claude", "--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence", "--model", model, "--mcp-config", ".mcp.json", "--strict-mcp-config",
				// Who did the work is recorded by Braid in the landing commit; the agent adds no trailer of its own.
				"--settings", JSON.stringify({ includeCoAuthoredBy: false }), "--", TASKS[job.task]];
			agentEnv = { ANTHROPIC_API_KEY: "provided-by-worker", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", IS_SANDBOX: "1", ...(useGateway(env) ? { ANTHROPIC_BASE_URL: `https://${GATEWAY_HOST}${gatewayPath(env)}/anthropic` } : {}) };
		}
		// Not awaited to completion: the script outlives this call and the alarm follows it through its files.
		await container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", TASK, ...argv], { cwd: REPO, env: { HOME: "/root", CI: "true", ...TOOL_ENV, ...TRUST, ...agentEnv }, stdout: "ignore", stderr: "ignore" });
		await this.project(job).hostedEvents(job.attemptId, [{ kind: "system", text: `${job.kind === "selftest" ? "self-test" : job.kind === "codex" ? "codex" : "claude"} started on attempt ${job.attemptId} in a Cloudflare sandbox${job.kind === "selftest" ? "" : ` (${model})`}${job.task === "work" ? "" : job.task === "reconcile" ? ", to reconcile with trunk" : job.task === "respond" ? ", to act on the note it was sent" : ", to fix failed verification"}` }], "running", job.kind === "selftest" ? undefined : model);
	}

	/** Read what the agent has printed since last time and pass it on as session events. */
	private async forward(job: HostJob, all = false) {
		const offset = this.kv.get<number>("offset") ?? 0;
		const p = await this.ctx.container!.exec(["sh", "-c", `tail -c +$(( $1 + 1 )) "$0" 2>/dev/null || true`, `${TASK}/stdout.log`, String(offset)], { stderr: "ignore" });
		const bytes = new Uint8Array((await p.output()).stdout);
		// Only whole lines; a line still being written is picked up next time.
		const end = all ? bytes.length : bytes.lastIndexOf(10) + 1;
		if (end <= 0) return;
		const toEvents = job.kind === "codex" ? codexEvents : claudeEvents;
		const events: CapturedEvent[] = [];
		for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
			if (!line.trim()) continue;
			try { events.push(...toEvents(JSON.parse(line))); } catch { events.push({ kind: "system", text: line.slice(0, 1500) }); }
		}
		this.kv.put("offset", offset + end);
		for (let i = 0; i < events.length; i += 100) await this.project(job).hostedEvents(job.attemptId, events.slice(i, i + 100));
	}
}
