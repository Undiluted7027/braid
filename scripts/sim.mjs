#!/usr/bin/env node
// A scripted run of four concurrent agents against a running Braid instance.
// The "agents" are deterministic (no model calls), but everything else is real:
// Artifacts forks, git pushes, MCP calls, overlap detection, landing, reconciliation.
//
//   pnpm sim                     # against http://localhost:8787
//   BRAID_URL=https://... pnpm sim
//   pnpm sim --pause             # stop before each landing so you can watch the UI
//   pnpm sim --until=conflict    # leave the project mid-flight (also: --until=ready, --keep)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const BASE = process.env.BRAID_URL ?? "http://localhost:8787";
const PAUSE = process.argv.includes("--pause");
// --until=ready|conflict stops there and keeps the project, to look at a mid-flight state in the UI.
const UNTIL = process.argv.find((a) => a.startsWith("--until="))?.split("=")[1];
const KEEP = process.argv.includes("--keep") || PAUSE || !!UNTIL;
const stopAt = (phase) => { if (UNTIL === phase) { console.log(`\nStopped at "${phase}". Open ${BASE}/p/${slug}`); process.exit(0); } };
const slug = process.env.BRAID_PROJECT ?? `tally-${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, body) {
	const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error ?? JSON.stringify(data)}`);
	return data;
}
async function pause(what) {
	if (!PAUSE) return;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	await rl.question(`\n⏸  ${what} Press Enter to continue. `);
	rl.close();
}
const say = (who, text) => console.log(`${who.padEnd(12)} ${text}`);

class Agent {
	constructor(name, joined) { Object.assign(this, { name, ...joined, n: 0 }); }
	async call(tool, args = {}) {
		const res = await fetch(this.mcpUrl, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.agentToken}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++this.n, method: "tools/call", params: { name: tool, arguments: args } }),
		});
		const msg = await res.json();
		if (msg.error) throw new Error(`${tool}: ${msg.error.message}`);
		const text = msg.result.content[0].text;
		if (msg.result.isError) throw new Error(`${tool}: ${text}`);
		const out = JSON.parse(text);
		for (const h of out.heads_up ?? []) {
			if (h.kind === "overlap") say(this.name, `⚠ heads-up: ${h.severity} on ${h.path} with ${h.with.agent} (${h.with.intent})${h.with.why[0] ? ` — their reasoning: "${h.with.why[0].title}"` : ""}`);
			else if (h.kind === "message") say(this.name, `✉ from ${h.from.agent}: ${h.body}`);
			else say(this.name, `⚠ heads-up: ${h.kind} ${h.note ?? ""}`);
		}
		return out;
	}
	git(...args) { return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
	clone() {
		this.dir = mkdtempSync(join(tmpdir(), `braid-${this.name}-`));
		execFileSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${this.gitToken}`, "clone", "-q", this.remote, this.dir], { stdio: "pipe" });
		// Scope the credential to this remote only, so fetching trunk with its own token still works.
		this.git("config", `http.${this.remote}.extraHeader`, `Authorization: Bearer ${this.gitToken}`);
		this.git("config", "user.name", this.name);
		this.git("config", "user.email", `${this.name}@agents.braid.dev`);
	}
	edit(file, fn) {
		const path = join(this.dir, file);
		const before = readFileSync(path, "utf8");
		const after = fn(before);
		if (after === before) throw new Error(`${this.name}: edit to ${file} changed nothing`);
		writeFileSync(path, after);
	}
	async push(message) {
		this.git("add", "-A");
		this.git("commit", "-q", "-m", message);
		this.git("push", "-q", "origin", "HEAD:main");
		// Deployed, the push event reaches Braid on its own; calling checkpoint makes local runs identical.
		const cp = await this.call("checkpoint", { summary: message });
		say(this.name, `pushed "${message}" → ${cp.changed.length} file(s) changed, ${cp.overlaps.length} overlap(s)`);
		return cp;
	}
}

const replace = (from, to) => (s) => {
	if (!s.includes(from)) throw new Error(`pattern not found: ${from.slice(0, 40)}`);
	return s.replace(from, to);
};

// ── the four agents' work ────────────────────────────────────────────────────

async function darkModeToggle(a) {
	await a.call("brief");
	await a.call("claim", { paths: ["styles.css", "index.html", "app.js"], reason: "theme variables, a toggle button, and its handler" });
	await a.call("record", { kind: "decision", title: "Theme is a data-theme attribute on <html>", body: "Dark values override the existing CSS variables under [data-theme=dark], so no component styles change.", files: ["styles.css"] });
	a.edit("styles.css", replace("* { box-sizing: border-box; }", `[data-theme="dark"] {\n\t--bg: #151412;\n\t--card: #1f1e1b;\n\t--ink: #f1efe9;\n\t--muted: #9a958b;\n\t--line: #33312c;\n}\n\n* { box-sizing: border-box; }`));
	a.edit("index.html", replace(`<button id="add">Add counter</button>`, `<button id="theme">Dark mode</button>\n\t\t\t<button id="add">Add counter</button>`));
	await a.push("Add dark theme variables and a toggle button");
	await sleep(400);
	await a.call("record", { kind: "decision", title: "Theme lives in state.theme and is applied in render()", body: "render() is the single place the DOM is updated, so the theme attribute is set there. The toggle only flips state.theme and calls render().", files: ["app.js"] });
	await a.call("record", { kind: "rejected", title: "Not using prefers-color-scheme only", body: "The goal asks for a user-controlled toggle; the OS preference alone cannot be overridden.", files: ["styles.css"] });
	a.edit("app.js", replace(`\tnextId: 3,\n};`, `\tnextId: 3,\n\ttheme: "light",\n};`));
	a.edit("app.js", replace(`function render() {\n\tconst board = document.getElementById("board");`, `function render() {\n\tdocument.documentElement.dataset.theme = state.theme;\n\tconst board = document.getElementById("board");`));
	a.edit("app.js", replace(`document.getElementById("add").addEventListener("click", addCounter);\nrender();`, `document.getElementById("add").addEventListener("click", addCounter);\ndocument.getElementById("theme").addEventListener("click", () => {\n\tstate.theme = state.theme === "dark" ? "light" : "dark";\n\trender();\n});\nrender();`));
	await a.push("Toggle theme from state");
	await a.call("check", { name: "manual: toggle flips colors", status: "pass", detail: "Verified in the attempt preview." });
	await a.call("ready", { summary: "Dark mode toggle in the header; theme is part of state and applied in render()." });
}

async function darkModeAuto(a) {
	await a.call("brief");
	await a.call("claim", { paths: ["styles.css"], reason: "media-query based dark theme" });
	await a.call("record", { kind: "decision", title: "Follow the OS with prefers-color-scheme", body: "Zero JavaScript: a media query overrides the CSS variables. Smallest possible change.", files: ["styles.css"] });
	await a.call("record", { kind: "assumption", title: "A manual toggle is not required", body: "The goal says 'add a dark mode'; I am reading the toggle as optional.", files: ["styles.css"] });
	a.edit("styles.css", replace("* { box-sizing: border-box; }", `@media (prefers-color-scheme: dark) {\n\t:root {\n\t\t--bg: #151412;\n\t\t--card: #1f1e1b;\n\t\t--ink: #f1efe9;\n\t\t--muted: #9a958b;\n\t\t--line: #33312c;\n\t}\n}\n\n* { box-sizing: border-box; }`));
	await a.push("Dark theme via prefers-color-scheme");
	await a.call("ready", { summary: "CSS-only dark mode that follows the OS setting. No toggle." });
}

async function persistence(a) {
	await a.call("brief");
	await a.call("claim", { paths: ["app.js"], reason: "load and save state" });
	await a.call("record", { kind: "decision", title: "Persist the whole state object under one localStorage key", body: "state is small and already the single source of truth, so save() serialises all of it after every render and load() merges it back on startup.", files: ["app.js"] });
	await a.call("record", { kind: "assumption", title: "Anything added to state later should persist too", body: "Saving the whole object (not a field list) means new fields are persisted without touching save().", files: ["app.js"] });
	a.edit("app.js", replace(`function addCounter() {`, `const STORAGE_KEY = "tally:v1";\n\nfunction load() {\n\ttry {\n\t\tObject.assign(state, JSON.parse(localStorage.getItem(STORAGE_KEY)) || {});\n\t} catch {}\n}\n\nfunction save() {\n\ttry {\n\t\tlocalStorage.setItem(STORAGE_KEY, JSON.stringify(state));\n\t} catch {}\n}\n\nfunction addCounter() {`));
	a.edit("app.js", replace(`\tdocument.getElementById("total").textContent = "Total: " + total;\n}`, `\tdocument.getElementById("total").textContent = "Total: " + total;\n\tsave();\n}`));
	a.edit("app.js", replace(`document.getElementById("add").addEventListener("click", addCounter);\nrender();`, `document.getElementById("add").addEventListener("click", addCounter);\nload();\nrender();`));
	await a.push("Persist state to localStorage");
	await a.call("check", { name: "manual: counts survive reload", status: "pass", detail: "Verified in the attempt preview." });
	await a.call("ready", { summary: "State is saved after every render and restored on load." });
}

async function resetButton(a) {
	await a.call("brief");
	await a.call("claim", { paths: ["index.html", "app.js"], reason: "a reset-all button" });
	await a.call("record", { kind: "decision", title: "Reset zeroes counts but keeps the counters", body: "Deleting counters would lose the user's names; reset means 'start the day over'.", files: ["app.js"] });
	a.edit("index.html", replace(`<footer class="foot"><span id="total"></span></footer>`, `<footer class="foot"><span id="total"></span> <button id="reset">Reset all</button></footer>`));
	a.edit("app.js", replace(`function render() {`, `function resetAll() {\n\tfor (const counter of state.counters) counter.count = 0;\n\trender();\n}\n\nfunction render() {`));
	a.edit("app.js", replace(`document.getElementById("add").addEventListener("click", addCounter);`, `document.getElementById("add").addEventListener("click", addCounter);\ndocument.getElementById("reset").addEventListener("click", resetAll);`));
	await a.push("Add reset-all button");
	await a.call("ready", { summary: "Footer button that sets every count to zero." });
}

// ── run ──────────────────────────────────────────────────────────────────────

console.log(`Braid at ${BASE}, project "${slug}"\n`);
await http("POST", "/api/projects", { slug, name: "Tally", description: "Simulated run: four agents, three intents" });
const api = (method, path, body) => http(method, `/api/p/${slug}${path}`, body);

const dark = await api("POST", "/intents", { title: "Add a dark mode", goal: "Users can switch the app to a dark color scheme.", acceptance: "A visible control switches themes; all colors come from CSS variables." });
const persist = await api("POST", "/intents", { title: "Remember counters across reloads", goal: "Counter names and counts survive a page reload.", acceptance: "Reloading the page shows the same counters and counts." });
const reset = await api("POST", "/intents", { title: "Add a reset-all button", goal: "One click sets every counter back to zero.", acceptance: "Counters stay, counts go to 0." });

const enlist = async (intent, name, kind) => new Agent(name, await api("POST", `/intents/${intent.id}/join`, { agent: name, kind }));
const [claude, codex, sonnet, haiku] = await Promise.all([
	enlist(dark, "claude-code", "claude"), enlist(dark, "codex", "codex"), enlist(persist, "claude-2", "claude"), enlist(reset, "codex-2", "codex"),
]);
for (const a of [claude, codex, sonnet, haiku]) { a.clone(); say(a.name, `joined I${a.intentId} as attempt ${a.attemptId} → ${a.remote.split("/").pop()}`); }
await pause("Four attempts forked. Agents start working concurrently.");

console.log("\n— agents working concurrently —");
await Promise.all([darkModeToggle(claude), darkModeAuto(codex), persistence(sonnet), resetButton(haiku)]);

let state = await api("GET", "");
console.log("\n— overlaps Braid found while they worked —");
for (const o of state.overlaps) console.log(`  ${o.severity.padEnd(8)} ${o.path.padEnd(11)} ${o.a} ↔ ${o.b}`);

stopAt("ready");
await pause("All attempts are ready. Next: land persistence (I2).");
console.log("\n— landing —");
const land = async (agent) => {
	const r = await api("POST", `/attempts/${agent.attemptId}/land`, { by: "reviewer" });
	say("reviewer", r.landed ? `landed ${agent.attemptId} (${agent.name}) as ${r.sha.slice(0, 7)}` : `landing ${agent.attemptId} conflicted on ${r.conflicts.join(", ")} → reconciliation R${r.reconciliationId}`);
	return r;
};
await land(sonnet);
await pause("Next: choose the toggle attempt for dark mode (I1). It will conflict with what just landed.");
const conflicted = await land(claude);

stopAt("conflict");
if (!conflicted.landed) {
	// The agent whose landing conflicted reads both sides and why, then writes a version that keeps both intents.
	const { reconciliation } = await claude.call("reconciliation");
	for (const c of reconciliation.conflicts) {
		say(claude.name, `reading conflict in ${c.path}: ${c.regions.length} region(s); trunk side is ${c.trunkWhy.map((w) => `I${w.intentId} "${w.title}" (${w.decisions.length} decisions)`).join(", ")}`);
	}
	await pause("Reconciliation is open with both sides' reasoning. Next: the agent resolves it.");
	const c = reconciliation.conflicts.find((x) => x.path === "app.js");
	// Keep trunk's load()/save() and add the theme handler; load() must run before the first render so the saved theme applies.
	const merged = c.trunk.replace(
		`document.getElementById("add").addEventListener("click", addCounter);\nload();\nrender();`,
		`document.getElementById("add").addEventListener("click", addCounter);\ndocument.getElementById("theme").addEventListener("click", () => {\n\tstate.theme = state.theme === "dark" ? "light" : "dark";\n\trender();\n});\nload();\nrender();`,
	).replace(`\tnextId: 3,\n};`, `\tnextId: 3,\n\ttheme: "light",\n};`)
		.replace(`function render() {\n\tconst board`, `function render() {\n\tdocument.documentElement.dataset.theme = state.theme;\n\tconst board`);
	const done = await claude.call("resolve", {
		resolutions: [{ path: "app.js", content: merged }],
		rationale: "Kept I2's load() before the first render and save() after every render, and registered the theme toggle before load(). Because I2 persists the whole state object, state.theme is saved and restored with no extra code, so the chosen theme now survives reloads.",
	});
	say(claude.name, done.landed ? `resolved and landed as ${done.sha.slice(0, 7)}` : `still conflicted: ${JSON.stringify(done)}`);
}
await pause("Next: land the reset button (I3), which is now two landings behind.");
const late = await land(haiku);
if (!late.landed) {
	// The other way to reconcile: plain git. Merge trunk into the attempt, fix it in the working copy, push.
	const { trunk_url } = await haiku.call("sync");
	haiku.git("fetch", "-q", trunk_url, "main");
	try { haiku.git("merge", "FETCH_HEAD"); } catch { say(haiku.name, "git merge of trunk stopped on conflicts, resolving in the working copy"); }
	const trunkApp = haiku.git("show", "FETCH_HEAD:app.js");
	writeFileSync(join(haiku.dir, "app.js"), trunkApp
		.replace(`function render() {`, `function resetAll() {\n\tfor (const counter of state.counters) counter.count = 0;\n\trender();\n}\n\nfunction render() {`)
		.replace(`document.getElementById("add").addEventListener("click", addCounter);`, `document.getElementById("add").addEventListener("click", addCounter);\ndocument.getElementById("reset").addEventListener("click", resetAll);`));
	await haiku.call("record", { kind: "decision", title: "Merged trunk (I1, I2) into the attempt", body: "resetAll() calls render(), so the reset is persisted by I2's save() and keeps I1's theme. No change to either was needed.", files: ["app.js"] });
	await haiku.push("Merge trunk into attempt");
	await land(haiku);
}

state = await api("GET", "");
console.log("\n— result —");
for (const i of state.intents) console.log(`  I${i.id} ${i.status.padEnd(7)} ${i.title}${i.landedAttempt ? ` (attempt ${i.landedAttempt}, ${i.landedSha.slice(0, 7)})` : ""}`);
for (const a of state.attempts) console.log(`  attempt ${a.id} ${a.agent.padEnd(11)} ${a.status}`);
const view = await api("GET", `/file?path=app.js`);
const by = {};
for (const line of view.blame) by[line.sha ? `I${state.landings.find((l) => l.sha === line.sha).intentId}` : "seed"] = (by[line.sha ? `I${state.landings.find((l) => l.sha === line.sha).intentId}` : "seed"] ?? 0) + 1;
console.log(`  app.js on trunk: ${view.blame.length} lines, by origin ${JSON.stringify(by)}`);

const ok = state.intents.every((i) => i.status === "landed") && state.attempts.find((a) => a.agent === "codex").status === "superseded"
	&& view.content.includes("load();") && view.content.includes(`getElementById("theme")`) && view.content.includes("resetAll");
console.log(ok ? "\n✔ all three intents landed; both sides of the conflict survive on trunk" : "\n✘ unexpected end state");
console.log(`\nOpen ${BASE}/p/${slug}`);
if (!KEEP) { await api("DELETE", ""); console.log("(project and its Artifacts repos deleted; pass --keep to keep them)"); }
process.exit(ok ? 0 : 1);
