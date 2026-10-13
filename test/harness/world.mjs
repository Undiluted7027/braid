// A small world for the project object to live in under Node: real git repositories in a temporary
// folder served over git's own HTTP backend (so landing pushes and fetches for real), a stand-in for
// the Artifacts binding that reads them, a database, an alarm the test fires by hand, and runners and
// agent hosts that only write down what they were asked.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Project } from "../../src/worker/project.ts";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitBytes = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
const quiet = (fn, otherwise = null) => { try { return fn(); } catch { return otherwise; } };

/** Serve every repository under `root` the way a git host does. In its own process: the tests call git synchronously, which would stop a server living here from answering. */
function serve(root) {
	const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname, root], { stdio: ["ignore", "pipe", "inherit"] });
	return new Promise((resolve, reject) => {
		child.stdout.once("data", (d) => resolve({ port: Number(String(d).trim()), stop: () => child.kill() }));
		child.once("error", reject);
	});
}

export async function world(env = {}) {
	const root = mkdtempSync(join(tmpdir(), "braid-test-"));
	const server = await serve(root), origin = `http://127.0.0.1:${server.port}`;
	const path = (name) => join(root, `${name}.git`), remote = (name) => `${origin}/${name}.git`;
	const failing = new Map(); // operation name -> how many more times it throws

	const failIfAsked = (op) => {
		const left = failing.get(op) ?? 0;
		if (left > 0) { failing.set(op, left - 1); throw new Error(`ArtifactsError: ${op} failed (asked for by the test)`); }
	};
	const meta = (dir, hash) => {
		const raw = quiet(() => git(dir, "log", "-1", "--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%at%x00%B", hash));
		if (!raw) return null;
		const [h, tree, parents, name, email, at, message] = raw.split("\0");
		return { hash: h, treeHash: tree, message: message.replace(/\n+$/, "\n"), author: { name, email }, parents: parents ? parents.split(" ") : [], authoredAt: Number(at) };
	};
	const handle = (name) => {
		const dir = path(name);
		const ref = { name, remote: remote(name), token: "tok?expires=9", defaultBranch: "main" };
		return {
			[Symbol.dispose]() {},
			async info() { return ref; },
			async createToken(scope) { failIfAsked("token"); return { plaintext: `${scope}-tok?expires=9` }; },
			async fork(to) {
				failIfAsked("fork");
				if (existsSync(path(to))) throw new Error("repo already exists");
				git(root, "clone", "--quiet", "--bare", dir, path(to));
				git(path(to), "config", "http.receivepack", "true");
				return { ...ref, name: to, remote: remote(to) };
			},
			async log({ ref: at, limit }) {
				failIfAsked("log");
				const target = /^[0-9a-f]{40}$/.test(at) ? at : `refs/heads/${at}`;
				const hashes = quiet(() => git(dir, "log", "--first-parent", `-n${limit}`, "--format=%H", target), "");
				return hashes ? hashes.split("\n").map((h) => meta(dir, h)) : [];
			},
			async readCommit(hash) { return meta(dir, hash); },
			async readTree(hash) {
				const out = quiet(() => git(dir, "ls-tree", hash));
				if (out === null) return null;
				return out.split("\n").filter(Boolean).map((line) => {
					const [info, file] = line.split("\t"), [mode, , oid] = info.split(" ");
					return { name: file, mode, hash: oid, type: mode === "040000" ? "tree" : mode === "100755" ? "exec" : mode === "120000" ? "symlink" : mode === "160000" ? "gitlink" : "blob" };
				});
			},
			async readBlob(hash) { const b = quiet(() => gitBytes(dir, "cat-file", "blob", hash)); return b ? new Blob([b]) : null; },
			async readFile({ ref: at, path: file }) { const b = quiet(() => gitBytes(dir, "show", `${/^[0-9a-f]{40}$/.test(at) ? at : `refs/heads/${at}`}:${file}`)); return b ? new Blob([b]) : null; },
		};
	};
	const artifacts = {
		async create(name) {
			if (existsSync(path(name))) throw new Error("repo already exists");
			git(root, "init", "--quiet", "--bare", "-b", "main", path(name));
			git(path(name), "config", "http.receivepack", "true");
			return { name, remote: remote(name), token: "tok?expires=9", defaultBranch: "main" };
		},
		async get(name) { if (!existsSync(path(name))) throw Object.assign(new Error("repo not found"), { code: "NOT_FOUND" }); return handle(name); },
		async delete(name) { rmSync(path(name), { recursive: true, force: true }); },
	};

	const runs = [], agents = [];
	const namespace = (make) => ({ idFromName: (name) => name, get: (name) => make(name) });
	const db = new DatabaseSync(":memory:");
	let alarm = null;
	const sql = { exec: (query, ...args) => {
		// The schema comes as many statements in one string; everything else is one statement, possibly returning rows.
		if (!args.length && /;\s*\S/.test(query)) { db.exec(query); return { toArray: () => [] }; }
		const rows = db.prepare(query).all(...args);
		return { toArray: () => rows };
	} };
	const ctx = {
		storage: {
			sql,
			transactionSync(fn) { db.exec("BEGIN"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
			async setAlarm(at) { alarm = at; },
			async deleteAlarm() { alarm = null; },
			async deleteAll() { for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) db.exec(`DROP TABLE ${t.name}`); },
		},
		getWebSockets: () => [], acceptWebSocket() {}, waitUntil() {},
	};
	const fullEnv = {
		ARTIFACTS: artifacts, SPARE_FORKS: "0",
		RUNNER: namespace((name) => ({ async start(job) { failIfAsked("run.start"); runs.push(job); }, async file() { return null; }, async clear() {} })),
		AGENT: namespace((name) => ({ async start(job) { failIfAsked("agent.start"); agents.push({ what: "start", name, job }); }, async stop(why) { agents.push({ what: "stop", name, why }); }, async clear() {} })),
		...env,
	};
	// No test calls a real model. A test that is about reviewing or planning puts its own stand-in in these places.
	const standIns = (p) => {
		p.planner = async () => ({ relations: [], model: "stand-in" });
		p.splitter = async () => { throw new Error("[501] no stand-in for splitting a goal in this test"); };
		p.reviewer = async () => { throw new Error("[501] no stand-in for reviewing in this test"); };
		// No judges, no decision model and no browser unless a test puts them here.
		p.judgesFor = () => [];
		p.judge = async () => { throw new Error("[501] no stand-in for judging in this test"); };
		p.signaller = null; p.supporter = null; p.shooter = null;
		return p;
	};
	let project = standIns(new Project(ctx, fullEnv));

	const w = {
		root, origin, remote, runs, agents, db,
		get project() { return project; },
		/** The same storage, a new process: what a restart of the object looks like. */
		restart() { const before = project; project = standIns(new Project(ctx, fullEnv)); Object.assign(project, { planner: before.planner, splitter: before.splitter, reviewer: before.reviewer, judgesFor: before.judgesFor, judge: before.judge, signaller: before.signaller, supporter: before.supporter, shooter: before.shooter }); return project; },
		/** Make the next `times` calls of an Artifacts operation fail. */
		fail(op, times = 1) { failing.set(op, times); },
		/** Fire the alarm until no work is left that is due now. Work scheduled for later stays, unless `later` is given. */
		async settle({ later = false } = {}) {
			for (let i = 0; i < 200 && alarm !== null && (later || alarm <= Date.now() + 50); i++) {
				// Work put off (a retry waiting out its delay) is waited for, up to a few seconds each time.
				if (alarm > Date.now()) await new Promise((r) => setTimeout(r, Math.min(alarm - Date.now(), 3000)));
				alarm = null;
				await project.alarm();
			}
		},
		rows: (query, ...args) => db.prepare(query).all(...args).map((r) => ({ ...r })),
		async state() { return project.state(); },
		git, 
		/** A working copy of a repository, as an agent or a person would have it. */
		clone(name, as = name) { const dir = join(root, "work", `${as}-${Math.random().toString(36).slice(2, 7)}`); mkdirSync(dirname(dir), { recursive: true }); git(root, "clone", "--quiet", remote(name), dir); return dir; },
		/** Write files, commit and push to the branch. Returns the commit. */
		push(dir, files, message = "work") {
			for (const [file, content] of Object.entries(files)) {
				if (content === null) { rmSync(join(dir, file), { force: true }); continue; }
				mkdirSync(dirname(join(dir, file)), { recursive: true });
				writeFileSync(join(dir, file), content);
			}
			git(dir, "add", "-A"); git(dir, "commit", "--quiet", "-m", message); git(dir, "push", "--quiet", "origin", "HEAD:main");
			return git(dir, "rev-parse", "HEAD");
		},
		read: (dir, file) => readFileSync(join(dir, file), "utf8"),
		head: (name, ref = "main") => quiet(() => git(path(name), "rev-parse", `refs/heads/${ref}`)),
		/** Report the latest run of `ref` as finished, the way a runner would. */
		async finish(ref, status = "pass", extra = {}) {
			const run = db.prepare("SELECT * FROM runs WHERE ref = ? ORDER BY id DESC LIMIT 1").get(ref);
			if (!run) throw new Error(`no run for ${ref}`);
			await project.runUpdate(run.id, { status, finishedAt: Date.now(), steps: [{ name: "test", command: "npm test", status: status === "pass" ? "pass" : "fail", exitCode: status === "pass" ? 0 : 1, ms: 5, tail: status === "pass" ? "ok" : "1 failing" }], ...extra });
			return run;
		},
		/** Call one of an agent's tools, as its MCP client would. */
		tool: (joined, name, args = {}) => project.agent(joined.agentToken, name, args),
		async close() { server.stop(); rmSync(root, { recursive: true, force: true }); },
	};
	return w;
}
