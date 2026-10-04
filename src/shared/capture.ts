// Turns what Claude Code and Codex print in headless mode into session events. Used by the launcher
// on a developer's machine (cli/braid.mjs) and by the hosted runner (src/worker/agent.ts).
// Erasable syntax only, so Node can import this file directly.

export interface CapturedEvent { kind: "say" | "tool" | "result" | "system"; tool?: string | null; text: string }

export const clip = (value: unknown, max = 1500): string => {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
};
// Braid tool calls are recorded by the server itself, so the launcher skips them.
const isBraid = (name: unknown) => /(^|_)braid(_|$)/.test(String(name));
const skipped = new Set<string>(); // ids of tool calls left out, so their results are left out too
const calls = new Map<string, { tool: string; command?: string }>(); // Claude tool call id -> { tool, command }, to decide what of its result to keep

// Output is the part of a session most likely to hold a secret and least likely to explain the work
// (file contents are in git already). A result is recorded as a status line; only commands whose
// output is about the work itself (git, tests, builds) add the tail of what they printed.
const SHOWN = /^(git (status|diff|log|show|add|commit|push|fetch|pull|merge|rebase|branch|checkout|switch|restore|stash|rev-parse|ls-files)\b|(pnpm|npm|yarn|bun) (test|run|typecheck|build|lint|install|i|ci|add)\b|node --test\b|(npx |pnpm exec )?(tsc|vitest|jest|eslint|vite build)\b|pytest\b|cargo (test|build|check|clippy)\b|go (test|build|vet)\b|make\b|ls\b|pwd$)/;
/** Codex reports commands wrapped in a shell invocation: `/bin/zsh -lc 'git status'`. */
const unwrap = (command: unknown) => String(command ?? "").match(/^\S*sh -l?c (['"])([\s\S]*)\1$/)?.[2] ?? String(command ?? "");
// Credential stores: a command that names one never has its output recorded, whatever the command is.
const SENSITIVE_PATH = /(^|[\s/"'=:])(\.env(\.\w+)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|\.ssh|\.gnupg|\.aws|\.dev\.vars|\.mcp\.json|\.braid|id_(rsa|dsa|ecdsa|ed25519)|(auth|credentials|secrets?|token)\.json|\S*\.(pem|key|p12|pfx|keystore|jks|ppk|asc))($|[\s/"':])|credentials/i;
export function showsOutput(command: string) {
	if (/[`<>]|\$\(/.test(command.replace(/\s2>&1/g, "")) || SENSITIVE_PATH.test(command) || /\bgit config\b/.test(command)) return false;
	// `2>&1` and a trailing `| tail -20` only shape the output; they do not change what it is about.
	const parts = command.replace(/\s2>&1/g, "").split(/&&|\|\||[;|\n]/).map((p) => p.trim()).filter((p) => p && !/^cd \S+$/.test(p) && !/^(head|tail)( -n ?\d+| -\d+)?$/.test(p));
	return parts.length > 0 && parts.every((p) => SHOWN.test(p));
}
const size = (n: number) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1000).toFixed(1)} kB` : `${(n / 1e6).toFixed(1)} MB`);
export function resultEvent({ output, failed, exit, command }: { output: unknown; failed: boolean; exit?: number | null; command?: string }): CapturedEvent {
	const text = String(output ?? "").trim();
	const status = failed ? `failed${exit ? ` (exit ${exit})` : ""}` : "ok";
	const lines = text ? text.split("\n") : [];
	const head = lines.length ? `${status} · ${lines.length} line${lines.length === 1 ? "" : "s"} · ${size(new TextEncoder().encode(text).length)}` : `${status} · no output`;
	const tail = command !== undefined && showsOutput(command) ? lines.slice(-8).join("\n").slice(-600) : "";
	return { kind: "result", tool: failed ? "error" : null, text: tail ? `${head}\n${tail}` : head };
}

/** Claude Code `--output-format stream-json` events. */
export function claudeEvents(e: any): CapturedEvent[] {
	if (e.type === "assistant") {
		return (e.message?.content ?? []).flatMap((b: any): CapturedEvent[] => {
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
		return (Array.isArray(e.message?.content) ? e.message.content : []).filter((b: any) => b.type === "tool_result" && !skipped.has(b.tool_use_id)).map((b: any) => {
			const output = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("\n");
			return resultEvent({ output, failed: !!b.is_error, command: calls.get(b.tool_use_id)?.command });
		});
	}
	if (e.type === "result") return [{ kind: "system", text: `finished: ${e.subtype ?? "done"}${e.num_turns ? `, ${e.num_turns} turns` : ""}` }];
	return [];
}

/** Codex `exec --json` events. */
export function codexEvents(e: any): CapturedEvent[] {
	const item = e.item;
	if (e.type === "item.completed" && item?.type === "agent_message" && item.text?.trim()) return [{ kind: "say", text: item.text }];
	if (item?.type === "command_execution") {
		if (e.type === "item.started") return [{ kind: "tool", tool: "shell", text: unwrap(item.command) }];
		if (e.type === "item.completed") return [resultEvent({ output: item.aggregated_output, failed: !!item.exit_code, exit: item.exit_code, command: unwrap(item.command) })];
		return [];
	}
	if (e.type === "item.completed" && item?.type === "file_change") return [{ kind: "tool", tool: "edit", text: (item.changes ?? []).map((c: any) => `${c.kind ?? "change"} ${c.path}`).join("\n") || "file change" }];
	if (e.type === "item.started" && item?.type === "mcp_tool_call" && !isBraid(item.server)) return [{ kind: "tool", tool: `${item.server}.${item.tool}`, text: Object.keys(item.arguments ?? {}).join(", ") || "(no arguments)" }];
	if (e.type === "turn.completed") return [{ kind: "system", text: `turn finished${e.usage?.output_tokens ? `, ${e.usage.output_tokens} output tokens` : ""}` }];
	if (e.type === "error" || e.type === "turn.failed") return [{ kind: "system", text: clip(e.message ?? e.error ?? e) }];
	return [];
}
