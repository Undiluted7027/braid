import test from "node:test";
import assert from "node:assert/strict";
import { agentEnv, claudeEvents, codexEvents, resultEvent, showsOutput } from "../cli/braid.mjs";

test("showsOutput: only commands whose output is about the work", () => {
	for (const c of ["git status", "cd app && pnpm test", "pnpm typecheck && node --test test/*.test.mjs", "git diff | ls", "git push origin HEAD:main 2>&1 | tail -3", "pnpm test 2>&1 | tail -n 20"]) assert.equal(showsOutput(c), true, c);
	for (const c of ["cat .env", "env", "git status && cat ~/.aws/credentials", "printenv | grep KEY", "echo $(cat .env)", "git log > /tmp/x; cat /tmp/x", "node -e 'console.log(process.env)'", "git diff .env", "git status | tail -f /etc/passwd", "pnpm test 2>&1 > out.txt", "git show HEAD:config/secrets.json", "git log -p -- deploy.pem", "git diff ~/.aws/credentials", ""]) assert.equal(showsOutput(c), false, c);
});

test("resultEvent: output is reduced to a status line unless the command is shown", () => {
	const hidden = resultEvent({ output: "API_KEY=abc\nDB=xyz\n", failed: false, command: "cat .env" });
	assert.equal(hidden.text, "ok · 2 lines · 18 B");
	const shown = resultEvent({ output: "a\nb\nc", failed: true, exit: 1, command: "pnpm test" });
	assert.equal(shown.text, "failed (exit 1) · 3 lines · 5 B\na\nb\nc");
	assert.equal(shown.tool, "error");
	assert.equal(resultEvent({ output: "", failed: false, command: "git add ." }).text, "ok · no output");
	assert.equal(resultEvent({ output: "file body", failed: false }).text, "ok · 1 line · 9 B"); // a non-shell tool such as Read
});

test("claudeEvents: file contents and command output do not pass through", () => {
	const call = (id, name, input) => claudeEvents({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
	const result = (id, content) => claudeEvents({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
	assert.deepEqual(call("w", "Write", { file_path: "a.js", content: "SECRET BODY" }), [{ kind: "tool", tool: "Write", text: "a.js" }]);
	call("r", "Read", { file_path: ".env" });
	assert.ok(!JSON.stringify(result("r", "TOKEN=hunter2hunter2")).includes("hunter2"));
	call("b", "Bash", { command: "git status" });
	assert.match(result("b", "On branch main")[0].text, /On branch main/);
	assert.deepEqual(call("m", "mcp__braid__record", { title: "x" }), []);
	assert.deepEqual(result("m", "anything"), []);
});

test("codexEvents: shell wrapper is removed and output follows the same rule", () => {
	assert.equal(codexEvents({ type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc 'cat .env'" } })[0].text, "cat .env");
	const done = codexEvents({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'cat .env'", aggregated_output: "TOKEN=hunter2hunter2", exit_code: 0 } });
	assert.equal(done[0].text, "ok · 1 line · 20 B");
});

test("agentEnv: keeps what an agent needs, drops the rest", () => {
	const saved = { ...process.env };
	Object.assign(process.env, { AWS_SECRET_ACCESS_KEY: "nope", GITHUB_TOKEN: "nope", ANTHROPIC_API_KEY: "kept", EXTRA_ONE: "asked" });
	const env = agentEnv(["EXTRA_ONE"]);
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(env.GITHUB_TOKEN, undefined);
	assert.equal(env.ANTHROPIC_API_KEY, "kept");
	assert.equal(env.EXTRA_ONE, "asked");
	assert.equal(env.PATH, saved.PATH);
	for (const k of ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "EXTRA_ONE"]) delete process.env[k];
	if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
});
