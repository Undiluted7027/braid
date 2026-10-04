#!/usr/bin/env node
// braid: put a coding agent to work on an intent.
//
//   braid init <braid-url> --name <slug> [--from <dir>] [--description <text>]
//       Create a project whose trunk is the HEAD of a local git repository (default: this one).
//   braid join <project-url> --intent <n> [--agent <name>] [--dir <path>] [--run]
//       Fork trunk into a new attempt, clone it, and wire the agent to Braid over MCP.
//       --run starts the agent headless right away (claude or codex, from --agent). It runs
//       unattended with shell access, so use it on code you trust. It gets a scrubbed environment
//       (--pass-env NAME,NAME lets more through), and what Braid records of its session is the
//       agent's words and commands, with output reduced to a status line and redacted.
//   braid <tool> ['<json args>']
//       Call a Braid tool from inside an attempt directory, for agents without MCP.
//       e.g.  braid brief   |   braid checkpoint '{"summary":"toggle works"}'
//   braid auth
//       Refresh the attempt's git credential.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { redact, secretValues } from "../src/shared/redact.ts";

const TOOLS = ["brief", "claim", "record", "checkpoint", "peek", "message", "check", "ready", "reconciliation", "resolve", "sync"];
const fail = (message) => { console.error(`braid: ${message}`); process.exit(1); };
const flag = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : (process.argv[i + 1] ?? true);
};

function findAttempt(from = process.cwd()) {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		const file = join(dir, ".braid", "attempt.json");
		if (existsSync(file)) return { dir, ...JSON.parse(readFileSync(file, "utf8")) };
		if (dir === dirname(dir)) fail("not inside a Braid attempt (no .braid/attempt.json found). Run `braid join` first.");
	}
}

async function callTool(attempt, tool, args) {
	const res = await fetch(attempt.mcpUrl, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${attempt.agentToken}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
	});
	const msg = await res.json();
	if (msg.error) fail(msg.error.message);
	const text = msg.result.content[0].text;
	if (msg.result.isError) fail(text);
	return text;
}

// Credentials go to git through its environment or the clone's own config, never in a URL or on a command line.
const withHeader = (token) => ({ ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });

/** Give the clone its two credentials, each scoped to its own remote: write on the attempt, read on trunk. */
function setCredentials(dir, cred) {
	const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"] });
	git("config", `http.${cred.remote}.extraHeader`, `Authorization: Bearer ${cred.gitToken}`);
	if (!cred.trunkRemote) return;
	try { git("remote", "add", "trunk", cred.trunkRemote); } catch { git("remote", "set-url", "trunk", cred.trunkRemote); }
	git("config", `http.${cred.trunkRemote}.extraHeader`, `Authorization: Bearer ${cred.trunkToken}`);
}

// What a headless agent inherits: enough to run and to sign in to its own provider, nothing else.
const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|LANG|LC_\w+|TZ|TMPDIR|XDG_\w+|NO_COLOR|FORCE_COLOR|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;
const ENV_AGENT = /^(ANTHROPIC_|CLAUDE|OPENAI_|CODEX_)/;
function agentEnv(extra) {
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => ENV_KEEP.test(name) || ENV_AGENT.test(name) || extra.includes(name)));
}

const PROMPT = `You are working on a Braid attempt. Read BRAID.md in this directory first and follow its protocol exactly.
The braid MCP server is connected in this session: call its tools directly (brief, claim, record, checkpoint, ready, ...) and use the shell form only if an MCP call fails.
Do the work the intent asks for, commit, push with the command given in BRAID.md, checkpoint after every push, record your decisions as you make them, and finish by marking the attempt ready.`;

async function joinCommand() {
	const target = process.argv[3];
	const intent = Number(flag("intent"));
	const agent = String(flag("agent", "claude-code"));
	let url;
	try { url = new URL(target); } catch { fail("usage: braid join <project-url> --intent <n> [--agent <name>] [--dir <path>] [--run]"); }
	const slug = url.pathname.split("/").filter(Boolean)[1];
	if (!slug || !intent) fail("usage: braid join <project-url> --intent <n> [--agent <name>] [--dir <path>] [--run]");
	const admin = flag("token", process.env.BRAID_ADMIN_TOKEN);

	const res = await fetch(`${url.origin}/api/p/${slug}/intents/${intent}/join`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${admin}` } : {}) },
		body: JSON.stringify({ agent, kind: agent.startsWith("codex") ? "codex" : agent.startsWith("claude") ? "claude" : "agent" }),
	});
	const joined = await res.json();
	if (!res.ok) fail(joined.error ?? `join failed (${res.status})`);

	// The command agents without MCP use; absolute, so it works from any attempt directory.
	const self = resolve(process.argv[1]);
	const sh = `node ${self}`;
	const dir = resolve(String(flag("dir", `${slug}-i${intent}-${agent}-${joined.attemptId.split(".")[1]}`)));
	execFileSync("git", ["clone", "-q", joined.remote, dir], { stdio: "inherit", env: withHeader(joined.gitToken) });
	setCredentials(dir, joined);
	execFileSync("git", ["-C", dir, "config", "user.name", agent]);
	execFileSync("git", ["-C", dir, "config", "user.email", `${agent}@agents.braid.dev`]);

	mkdirSync(join(dir, ".braid"), { recursive: true });
	writeFileSync(join(dir, ".braid", "attempt.json"), JSON.stringify({ project: slug, base: url.origin, attemptId: joined.attemptId, intentId: joined.intentId, mcpUrl: joined.mcpUrl, agentToken: joined.agentToken, remote: joined.remote }, null, "\t"));
	writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { braid: { type: "http", url: joined.mcpUrl, headers: { Authorization: `Bearer ${joined.agentToken}` } } } }, null, "\t"));
	writeFileSync(join(dir, "BRAID.md"), `${joined.brief}

## Tools

If your client loaded the \`braid\` MCP server, use its tools. Otherwise every tool is also a shell command:
\`${sh} <tool> '<json arguments>'\`, for example \`${sh} brief\` or \`${sh} record '{"kind":"decision","title":"...","body":"...","files":["app.js"]}'\`.

Tools: ${TOOLS.join(", ")}.

## Git

- This directory is your attempt: a private fork of trunk. \`origin\` is already authenticated.
- \`trunk\` is the project's trunk, read-only: \`git fetch trunk ${joined.branch}\` then \`git merge FETCH_HEAD\` brings your attempt up to date.
- Push with \`git push origin HEAD:${joined.branch}\`, then call \`checkpoint\`.
- Do not commit BRAID.md, .mcp.json, or .braid/ (they are ignored locally).
`);
	// Local-only ignore: these files describe the session, not the change.
	appendFileSync(join(dir, ".git", "info", "exclude"), "\nBRAID.md\n.mcp.json\n.braid/\n");

	console.log(`Attempt ${joined.attemptId} on I${joined.intentId} is ready in ${dir}`);
	if (!flag("run")) {
		console.log(`\nStart your agent there:\n  cd ${dir}\n  claude "Read BRAID.md and do the work"        # Claude Code picks up .mcp.json\n  codex "Read BRAID.md and do the work"         # Codex and others: tools are shell commands, see BRAID.md`);
		return;
	}
	const env = { ...agentEnv(String(flag("pass-env", "")).split(",")), BRAID_AGENT_TOKEN: joined.agentToken };
	// Exact values that must never reach the transcript: this attempt's tokens and anything secret-looking in our own environment.
	const secrets = [joined.agentToken, joined.gitToken, joined.trunkToken, ...(typeof admin === "string" ? [admin] : []), ...secretValues(process.env)].filter(Boolean)
		.flatMap((v) => [v, v.split("?expires=")[0]]);
	const clean = (e) => ({ ...e, text: clip(redact(e.text, secrets), e.kind === "say" ? 4000 : 1500) });
	const [cmd, args] = agent.startsWith("codex")
		? // Codex's workspace sandbox keeps .git read-only by default, which blocks commits; open it for this attempt.
		["codex", ["exec", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-c", `sandbox_workspace_write.writable_roots=["${join(dir, ".git")}"]`, "-c", `mcp_servers.braid.url="${joined.mcpUrl}"`, "-c", `mcp_servers.braid.bearer_token_env_var="BRAID_AGENT_TOKEN"`,
			// Headless Codex cannot answer approval prompts, so without this every Braid tool call is refused.
			"-c", `mcp_servers.braid.default_tools_approval_mode="approve"`, "--json", PROMPT]]
		: ["claude", ["-p", PROMPT, "--output-format", "stream-json", "--verbose", "--mcp-config", ".mcp.json", "--permission-mode", "acceptEdits", "--allowedTools", "mcp__braid", "Bash", "Read", "Edit", "Write", "Glob", "Grep"]];
	console.log(`Starting ${cmd} headless…\n`);
	// No stdin: `codex exec` otherwise waits for piped input forever when not attached to a terminal.
	const child = spawn(cmd, args, { cwd: dir, env, stdio: ["ignore", "pipe", "inherit"] });

	// Both CLIs emit one JSON event per line. Turn each into session events, show them here, and stream them to Braid.
	const toEvents = agent.startsWith("codex") ? codexEvents : claudeEvents;
	let queue = [], sending = Promise.resolve();
	const flush = () => {
		if (!queue.length) return sending;
		const events = queue;
		queue = [];
		sending = sending.then(() => fetch(`${url.origin}/api/p/${slug}/session`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${joined.agentToken}` },
			body: JSON.stringify({ events }),
		})).catch(() => {}); // a dropped batch must not stop the agent
		return sending;
	};
	const timer = setInterval(flush, 700);
	const emit = (events) => {
		for (const e of events.map(clean)) {
			console.log(`${e.kind === "say" ? "●" : e.kind === "tool" ? "→" : e.kind === "result" ? "←" : "·"} ${e.tool ? `[${e.tool}] ` : ""}${e.text.split("\n").slice(0, 6).join("\n  ")}`);
			queue.push({ ...e, at: Date.now() });
		}
		if (queue.length >= 25) flush();
	};
	emit([{ kind: "system", text: `${cmd} started on attempt ${joined.attemptId}` }]);
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop();
		for (const line of lines) {
			if (!line.trim()) continue;
			let event;
			try { event = JSON.parse(line); } catch { emit([{ kind: "system", text: line }]); continue; }
			emit(toEvents(event));
		}
	});
	child.on("exit", async (code) => {
		clearInterval(timer);
		emit([{ kind: "system", text: `${cmd} exited with code ${code ?? 0}` }]);
		await flush();
		process.exit(code ?? 0);
	});
}

const clip = (value, max = 1500) => {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
};
// Braid tool calls are recorded by the server itself, so the launcher skips them.
const isBraid = (name) => /(^|_)braid(_|$)/.test(String(name));
const skipped = new Set(); // ids of tool calls left out, so their results are left out too
const calls = new Map(); // Claude tool call id -> { tool, command }, to decide what of its result to keep

// Output is the part of a session most likely to hold a secret and least likely to explain the work
// (file contents are in git already). A result is recorded as a status line; only commands whose
// output is about the work itself (git, tests, builds) add the tail of what they printed.
const SHOWN = /^(git (status|diff|log|show|add|commit|push|fetch|pull|merge|rebase|branch|checkout|switch|restore|stash|rev-parse|ls-files)\b|(pnpm|npm|yarn|bun) (test|run|typecheck|build|lint|install|i|ci|add)\b|node --test\b|(npx |pnpm exec )?(tsc|vitest|jest|eslint|vite build)\b|pytest\b|cargo (test|build|check|clippy)\b|go (test|build|vet)\b|make\b|ls\b|pwd$)/;
/** Codex reports commands wrapped in a shell invocation: `/bin/zsh -lc 'git status'`. */
const unwrap = (command) => String(command ?? "").match(/^\S*sh -l?c (['"])([\s\S]*)\1$/)?.[2] ?? String(command ?? "");
// Credential stores: a command that names one never has its output recorded, whatever the command is.
const SENSITIVE_PATH = /(^|[\s/"'=:])(\.env(\.\w+)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|\.ssh|\.gnupg|\.aws|\.dev\.vars|\.mcp\.json|\.braid|id_(rsa|dsa|ecdsa|ed25519)|(auth|credentials|secrets?|token)\.json|\S*\.(pem|key|p12|pfx|keystore|jks|ppk|asc))($|[\s/"':])|credentials/i;
function showsOutput(command) {
	if (/[`<>]|\$\(/.test(command.replace(/\s2>&1/g, "")) || SENSITIVE_PATH.test(command) || /\bgit config\b/.test(command)) return false;
	// `2>&1` and a trailing `| tail -20` only shape the output; they do not change what it is about.
	const parts = command.replace(/\s2>&1/g, "").split(/&&|\|\||[;|\n]/).map((p) => p.trim()).filter((p) => p && !/^cd \S+$/.test(p) && !/^(head|tail)( -n ?\d+| -\d+)?$/.test(p));
	return parts.length > 0 && parts.every((p) => SHOWN.test(p));
}
const size = (n) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1000).toFixed(1)} kB` : `${(n / 1e6).toFixed(1)} MB`);
function resultEvent({ output, failed, exit, command }) {
	const text = String(output ?? "").trim();
	const status = failed ? `failed${exit ? ` (exit ${exit})` : ""}` : "ok";
	const lines = text ? text.split("\n") : [];
	const head = lines.length ? `${status} · ${lines.length} line${lines.length === 1 ? "" : "s"} · ${size(Buffer.byteLength(text))}` : `${status} · no output`;
	const tail = command !== undefined && showsOutput(command) ? lines.slice(-8).join("\n").slice(-600) : "";
	return { kind: "result", tool: failed ? "error" : null, text: tail ? `${head}\n${tail}` : head };
}

/** Claude Code `--output-format stream-json` events. */
function claudeEvents(e) {
	if (e.type === "assistant") {
		return (e.message?.content ?? []).flatMap((b) => {
			if (b.type === "text" && b.text.trim()) return [{ kind: "say", text: b.text }];
			// ToolSearch only loads tool definitions; it says nothing about the work.
			if (b.type === "tool_use" && (isBraid(b.name) || b.name === "ToolSearch")) skipped.add(b.id);
			else if (b.type === "tool_use") {
				const i = b.input ?? {};
				calls.set(b.id, { tool: b.name, command: b.name === "Bash" ? String(i.command ?? "") : undefined });
				// What was run or which file was touched; never the content written.
				return [{ kind: "tool", tool: b.name, text: String(i.command ?? i.file_path ?? i.pattern ?? i.path ?? Object.keys(i).join(", ")) }];
			}
			return [];
		});
	}
	if (e.type === "user") {
		return (Array.isArray(e.message?.content) ? e.message.content : []).filter((b) => b.type === "tool_result" && !skipped.has(b.tool_use_id)).map((b) => {
			const output = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("\n");
			return resultEvent({ output, failed: !!b.is_error, command: calls.get(b.tool_use_id)?.command });
		});
	}
	if (e.type === "result") return [{ kind: "system", text: `finished: ${e.subtype ?? "done"}${e.num_turns ? `, ${e.num_turns} turns` : ""}` }];
	return [];
}

/** Codex `exec --json` events. */
function codexEvents(e) {
	const item = e.item;
	if (e.type === "item.completed" && item?.type === "agent_message" && item.text?.trim()) return [{ kind: "say", text: item.text }];
	if (item?.type === "command_execution") {
		if (e.type === "item.started") return [{ kind: "tool", tool: "shell", text: unwrap(item.command) }];
		if (e.type === "item.completed") return [resultEvent({ output: item.aggregated_output, failed: !!item.exit_code, exit: item.exit_code, command: unwrap(item.command) })];
		return [];
	}
	if (e.type === "item.completed" && item?.type === "file_change") return [{ kind: "tool", tool: "edit", text: (item.changes ?? []).map((c) => `${c.kind ?? "change"} ${c.path}`).join("\n") || "file change" }];
	if (e.type === "item.started" && item?.type === "mcp_tool_call" && !isBraid(item.server)) return [{ kind: "tool", tool: `${item.server}.${item.tool}`, text: Object.keys(item.arguments ?? {}).join(", ") || "(no arguments)" }];
	if (e.type === "turn.completed") return [{ kind: "system", text: `turn finished${e.usage?.output_tokens ? `, ${e.usage.output_tokens} output tokens` : ""}` }];
	if (e.type === "error" || e.type === "turn.failed") return [{ kind: "system", text: clip(e.message ?? e.error ?? e) }];
	return [];
}

// Exported for tests; the commands below only run when this file is the entry point.
export { agentEnv, claudeEvents, codexEvents, resultEvent, showsOutput };

async function initCommand() {
	let url;
	try { url = new URL(process.argv[3]); } catch { fail("usage: braid init <braid-url> --name <slug> [--from <dir>] [--description <text>]"); }
	const slug = String(flag("name", "")), from = resolve(String(flag("from", ".")));
	if (!slug) fail("usage: braid init <braid-url> --name <slug> [--from <dir>] [--description <text>]");
	const admin = flag("token", process.env.BRAID_ADMIN_TOKEN);
	const post = async (path, body) => {
		const res = await fetch(`${url.origin}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${admin}` } : {}) }, body: JSON.stringify(body) });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) fail(data.error ?? `${path} failed (${res.status})`);
		return data;
	};
	const head = execFileSync("git", ["-C", from, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	await post("/projects", { slug, name: slug, description: String(flag("description", "")), source: "empty" });
	const cred = await post(`/p/${slug}/trunk-credentials`, {});
	execFileSync("git", ["-C", from, "push", "-q", cred.remote, `HEAD:refs/heads/${cred.branch}`], { stdio: "inherit", env: withHeader(cred.gitToken) });
	await post(`/p/${slug}/push`, { repo: `${slug}--trunk` });
	console.log(`Project ${slug} created with trunk at ${head.slice(0, 7)}\n${url.origin}/p/${slug}`);
}

const command = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) ? process.argv[2] : "(imported)";
if (command === "(imported)") {}
else if (command === "join") await joinCommand();
else if (command === "init") await initCommand();
else if (command === "auth") {
	const a = findAttempt();
	const res = await fetch(`${a.base}/api/p/${a.project}/credentials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentToken: a.agentToken }) });
	const cred = await res.json();
	if (!res.ok) fail(cred.error);
	setCredentials(a.dir, cred);
	console.log("git credentials refreshed (origin, and trunk for fetching)");
} else if (TOOLS.includes(command)) {
	let args = {};
	if (process.argv[3]) { try { args = JSON.parse(process.argv[3]); } catch { fail("tool arguments must be one JSON object"); } }
	console.log(await callTool(findAttempt(), command, args));
} else {
	console.log(`braid init <braid-url> --name <slug> [--from <dir>]\nbraid join <project-url> --intent <n> [--agent <name>] [--dir <path>] [--run] [--pass-env NAME,NAME] [--token <admin token>]\nbraid <${TOOLS.join("|")}> ['<json args>']\nbraid auth`);
	process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
}
