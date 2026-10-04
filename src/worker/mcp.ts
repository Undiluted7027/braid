// The agent-facing surface: a stateless MCP server (Streamable HTTP, JSON responses).
// Any MCP-capable coding agent connects with its attempt token as the bearer.
import { splitError, type Project } from "./project";

const str = { type: "string" } as const;
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
	name, description, inputSchema: { type: "object", properties, required },
});

export const TOOLS = [
	tool("brief", "Start here. Your intent, the protocol, what trunk looks like, and every other agent working right now with the reasoning behind their work."),
	tool("claim", "Declare the paths you expect to change, before editing. Other agents are told immediately, and you are told who already plans or has changes there.",
		{ paths: { type: "array", items: str, description: "Files or directories, e.g. src/app.js or src/ui/" }, reason: str }, ["paths"]),
	tool("record", "Record why. Call this whenever you make a real choice: what you decided, what you rejected, what you assumed. It is kept with the change forever and shown to agents whose work touches the same files.",
		{ kind: { type: "string", enum: ["decision", "assumption", "rejected", "question", "note"] }, title: str, body: str, files: { type: "array", items: str, description: "Paths this reasoning is about" } }, ["title"]),
	tool("checkpoint", "Call after every push. Braid re-reads your attempt and reports changed files, how far trunk has moved, and overlaps or predicted conflicts with other agents, including their reasoning.",
		{ summary: { type: "string", description: "One or two sentences on where the attempt stands" } }),
	tool("peek", "Look at another attempt: its intent, decisions, changed files, and optionally its version of one file.",
		{ attempt: { type: "string", description: "Attempt id, e.g. 2.1" }, path: str }, ["attempt"]),
	tool("message", "Send a note to another agent (attempt id) or to all live agents. They see it on their next call.",
		{ to: { type: "string", description: "Attempt id, or 'all'" }, body: str }, ["body"]),
	tool("check", "Report the result of a check you ran (tests, lint, manual verification).",
		{ name: str, status: { type: "string", enum: ["pass", "fail"] }, detail: str }, ["name", "status"]),
	tool("ready", "Mark the attempt ready to land once the goal is met and your commits are pushed.", { summary: str }, ["summary"]),
	tool("reconciliation", "If landing conflicted: each place trunk and your attempt changed the same lines (both versions, their base, a few lines around), and why trunk's side exists (the other intent and its decisions). `full` adds the whole base, trunk and attempt files.",
		{ full: { type: "boolean" } }),
	tool("resolve", "Answer a reconciliation: for each conflicting file, one replacement per conflict region (or the whole merged file), such that both intents are satisfied, plus a rationale. Braid puts the replacements in place, verifies the merge in a sandbox and lands it, so check what you send. An answer that just takes one side is refused unless one_sided is true.",
		{ resolutions: { type: "array", items: { type: "object", properties: { path: str, regions: { type: "array", items: str, description: "One replacement per conflict region, in order" }, content: { type: "string", description: "The whole merged file, instead of regions" } }, required: ["path"] } }, rationale: str, one_sided: { type: "boolean" } }, ["resolutions", "rationale"]),
	tool("sync", "How to merge the current trunk into your attempt with git."),
];

const INSTRUCTIONS = "Braid coordinates several agents changing one codebase at once. Call `brief` first. Claim paths before editing, record every decision, checkpoint after every push, and read `heads_up` in every response.";

const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string, status = 200) => Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });

export async function handleMcp(request: Request, project: Project, token: string): Promise<Response> {
	if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
	const msg = (await request.json().catch(() => null)) as { id?: unknown; method?: string; params?: any } | null;
	if (!msg?.method) return rpcError(null, -32700, "parse error", 400);
	if (msg.id === undefined) return new Response(null, { status: 202 }); // notification

	switch (msg.method) {
		case "initialize":
			return rpc(msg.id, {
				protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "braid", version: "0.1.0" },
				instructions: INSTRUCTIONS,
			});
		case "ping":
			return rpc(msg.id, {});
		case "tools/list":
			return rpc(msg.id, { tools: TOOLS });
		case "tools/call": {
			if (!token) return rpcError(msg.id, -32001, "missing bearer token", 401);
			try {
				const result = await project.agent(token, String(msg.params?.name), msg.params?.arguments ?? {});
				return rpc(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
			} catch (e) {
				// Tool failures are results the agent should read, not protocol errors.
				return rpc(msg.id, { isError: true, content: [{ type: "text", text: splitError(e).message }] });
			}
		}
		default:
			return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
	}
}
