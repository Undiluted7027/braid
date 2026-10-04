#!/usr/bin/env node
// braid: put a coding agent to work on an intent.
//
//   braid init <braid-url> --name <slug> [--from <dir>] [--description <text>]
//       Create a project whose trunk is the HEAD of a local git repository (default: this one).
//   braid join <project-url> --intent <n> [--agent <name>] [--dir <path>] [--run]
//       Fork trunk into a new attempt, clone it, and wire the agent to Braid over MCP.
//       --run starts the agent headless right away (claude or codex, from --agent). It runs
//       unattended with shell access inside the attempt directory, so use it on code you trust.
//   braid <tool> ['<json args>']
//       Call a Braid tool from inside an attempt directory, for agents without MCP.
//       e.g.  braid brief   |   braid checkpoint '{"summary":"toggle works"}'
//   braid auth
//       Refresh the attempt's git credential.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

function scopeCredential(dir, remote, gitToken) {
	// Scoped to this remote, so fetching trunk with its own token (the sync tool) is unaffected.
	execFileSync("git", ["-C", dir, "config", `http.${remote}.extraHeader`, `Authorization: Bearer ${gitToken}`]);
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
	execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${joined.gitToken}`, "clone", "-q", joined.remote, dir], { stdio: "inherit" });
	scopeCredential(dir, joined.remote, joined.gitToken);
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
	const env = { ...process.env, BRAID_AGENT_TOKEN: joined.agentToken };
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
		for (const e of events) {
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

/** Claude Code `--output-format stream-json` events. */
function claudeEvents(e) {
	if (e.type === "assistant") {
		return (e.message?.content ?? []).flatMap((b) => {
			if (b.type === "text" && b.text.trim()) return [{ kind: "say", text: clip(b.text, 4000) }];
			// ToolSearch only loads tool definitions; it says nothing about the work.
			if (b.type === "tool_use" && (isBraid(b.name) || b.name === "ToolSearch")) skipped.add(b.id);
			else if (b.type === "tool_use") {
				const i = b.input ?? {};
				return [{ kind: "tool", tool: b.name, text: clip(i.command ?? i.file_path ?? i.pattern ?? i.path ?? i) }];
			}
			return [];
		});
	}
	if (e.type === "user") {
		return (Array.isArray(e.message?.content) ? e.message.content : []).filter((b) => b.type === "tool_result" && !skipped.has(b.tool_use_id)).map((b) => {
			const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("\n");
			return { kind: "result", tool: b.is_error ? "error" : null, text: clip(text.trim() || "(no output)") };
		});
	}
	if (e.type === "result") return [{ kind: "system", text: `finished: ${e.subtype ?? "done"}${e.num_turns ? `, ${e.num_turns} turns` : ""}` }];
	return [];
}

/** Codex `exec --json` events. */
function codexEvents(e) {
	const item = e.item;
	if (e.type === "item.completed" && item?.type === "agent_message" && item.text?.trim()) return [{ kind: "say", text: clip(item.text, 4000) }];
	if (item?.type === "command_execution") {
		if (e.type === "item.started") return [{ kind: "tool", tool: "shell", text: clip(item.command) }];
		if (e.type === "item.completed") return [{ kind: "result", tool: item.exit_code ? "error" : null, text: clip(item.aggregated_output || `(exit ${item.exit_code})`) }];
		return [];
	}
	if (e.type === "item.completed" && item?.type === "file_change") return [{ kind: "tool", tool: "edit", text: clip((item.changes ?? []).map((c) => `${c.kind ?? "change"} ${c.path}`).join("\n") || item) }];
	if (e.type === "item.started" && item?.type === "mcp_tool_call" && !isBraid(item.server)) return [{ kind: "tool", tool: `${item.server}.${item.tool}`, text: clip(item.arguments ?? "") }];
	if (e.type === "turn.completed") return [{ kind: "system", text: `turn finished${e.usage?.output_tokens ? `, ${e.usage.output_tokens} output tokens` : ""}` }];
	if (e.type === "error" || e.type === "turn.failed") return [{ kind: "system", text: clip(e.message ?? e.error ?? e) }];
	return [];
}

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
	execFileSync("git", ["-C", from, "-c", `http.extraHeader=Authorization: Bearer ${cred.gitToken}`, "push", "-q", cred.remote, `HEAD:refs/heads/${cred.branch}`], { stdio: "inherit" });
	await post(`/p/${slug}/push`, { repo: `${slug}--trunk` });
	console.log(`Project ${slug} created with trunk at ${head.slice(0, 7)}\n${url.origin}/p/${slug}`);
}

const command = process.argv[2];
if (command === "join") await joinCommand();
else if (command === "init") await initCommand();
else if (command === "auth") {
	const a = findAttempt();
	const res = await fetch(`${a.base}/api/p/${a.project}/credentials`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentToken: a.agentToken }) });
	const cred = await res.json();
	if (!res.ok) fail(cred.error);
	scopeCredential(a.dir, cred.remote, cred.gitToken);
	console.log("git credential refreshed");
} else if (TOOLS.includes(command)) {
	let args = {};
	if (process.argv[3]) { try { args = JSON.parse(process.argv[3]); } catch { fail("tool arguments must be one JSON object"); } }
	console.log(await callTool(findAttempt(), command, args));
} else {
	console.log(`braid init <braid-url> --name <slug> [--from <dir>]\nbraid join <project-url> --intent <n> [--agent <name>] [--dir <path>] [--run] [--token <admin token>]\nbraid <${TOOLS.join("|")}> ['<json args>']\nbraid auth`);
	process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
}
