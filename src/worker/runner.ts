// Verifies an attempt by running it: one sandbox per ref, a fresh Linux instance per run.
// The instance has no Internet access and holds no credentials. It can reach exactly two things,
// both through this Worker: the one repository it is verifying (read-only) and the package registries of its toolchain.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { redact } from "../shared/redact";
import type { Run, RunStep } from "../shared/types";
import { ArtifactsHost } from "./host";
import type { BraidEnv, Project } from "./project";
import { lockOf, planFor, registriesFor, type Files, type Toolchain } from "./environment.ts";

/** What to run, as trunk defines it: its braid.json, and the checks it has by convention (by name). An attempt cannot drop a check by editing these. */
export interface RunPolicy { config: any | null; checks: string[] }
export interface RunJob { slug: string; ref: string; repo: string; remote: string; branch: string; sha: string; runId: number; policy?: RunPolicy;
	/** The toolchain this commit needs, worked out from its own files before the sandbox is started: it decides the image. */
	toolchain?: Toolchain;
	/** Instead of verifying: bring these lockfiles up to date with the commit's manifest and hand them back. */
	regenerate?: string[] }

const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const WORK = "/workspace";
const STEP_SECONDS = 600;
const TAIL = 6000;
const MAX_RUN_MS = 60 * 60 * 1000;
const MAX_PREVIEW_FILE = 1_900_000; // a SQLite value holds 2 MB
const MAX_PREVIEW_TOTAL = 40_000_000;
const PREVIEW_DIRS = ["dist/client", "dist", "build", "out"];

/** Adds the read token to git fetches of one repository; everything else to that host is refused. */
export class GitGateway extends WorkerEntrypoint<BraidEnv, { repo: string; path: string }> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url), { repo, path } = this.ctx.props;
		const fetching = (request.method === "GET" && url.pathname === `${path}/info/refs` && url.search === "?service=git-upload-pack")
			|| (request.method === "POST" && url.pathname === `${path}/git-upload-pack`);
		if (!fetching) return new Response("Braid: this sandbox may only fetch its own repository", { status: 403 });
		const headers = new Headers(request.headers);
		headers.set("authorization", `Bearer ${await new ArtifactsHost(this.env.ARTIFACTS).token(repo, "read", 600)}`);
		return fetch(new Request(request, { headers }));
	}
}

/** Lets package downloads through and nothing else. */
export class RegistryGateway extends WorkerEntrypoint<BraidEnv> {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") return new Response("Braid: the sandbox may only read from the package registry", { status: 403 });
		return fetch(request);
	}
}

interface Busy { at: number; job?: RunJob }
interface Plan { install: string | null; checks: [string, string][]; previewDir: string | null; previewApi: boolean }
/** Where each toolchain's tools look for the certificate that vouches for the sandbox's gateway. Java keeps its own store and has it added (see `trust`). */
const TRUST = { GIT_SSL_CAINFO: CA, NODE_EXTRA_CA_CERTS: CA, NPM_CONFIG_CAFILE: CA, SSL_CERT_FILE: CA, REQUESTS_CA_BUNDLE: CA, PIP_CERT: CA, CARGO_HTTP_CAINFO: CA, CURL_CA_BUNDLE: CA };

export class Runner extends DurableObject<BraidEnv> {
	constructor(ctx: DurableObjectState, env: BraidEnv) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, body BLOB)");
	}

	/** Queue a run and return at once; the work happens in the alarm. A newer job replaces one still waiting. */
	async start(job: RunJob) {
		await this.ctx.storage.put("next", job);
		const busy = await this.ctx.storage.get<Busy>("busy");
		// A run that has been going longer than any run can was lost with its object; the alarm clears it.
		if (!busy || !(Date.now() - busy.at <= MAX_RUN_MS)) await this.ctx.storage.setAlarm(Date.now());
	}

	async alarm() {
		// Only one alarm runs at a time, so a run still marked busy here did not finish: the object
		// was restarted under it (a deploy, a crash, the time limit). Say so, or it would stay "running" for good.
		const lost = await this.ctx.storage.get<Busy>("busy");
		if (lost) {
			await this.ctx.storage.delete("busy");
			if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
			if (lost.job) await this.report(lost.job, { status: "error", error: "the run was interrupted before it finished; run it again", finishedAt: Date.now() }).catch(() => {});
		}
		const job = await this.ctx.storage.get<RunJob>("next");
		if (!job) return;
		await this.ctx.storage.delete("next");
		await this.ctx.storage.put("busy", { at: Date.now(), job } satisfies Busy);
		try {
			await this.run(job);
		} catch (e) {
			await this.report(job, { status: "error", error: redact(String((e as Error)?.message ?? e)).slice(0, 500), finishedAt: Date.now() });
		} finally {
			await this.ctx.storage.delete("busy");
			const container = this.ctx.container;
			if (container?.running) await container.destroy().catch(() => {});
			if (await this.ctx.storage.get("next")) await this.ctx.storage.setAlarm(Date.now());
		}
	}

	private project(job: RunJob) { return this.env.PROJECT.get(this.env.PROJECT.idFromName(job.slug)) as unknown as Project; }
	private report(job: RunJob, patch: Partial<Run>) { return this.project(job).runUpdate(job.runId, patch); }

	private async run(job: RunJob) {
		const container = this.ctx.container;
		if (!container) throw new Error("no container is configured for the runner");
		if (container.running) await container.destroy().catch(() => {});

		const host = new URL(job.remote);
		await container.interceptOutboundHttps(host.hostname, this.ctx.exports.GitGateway({ props: { repo: job.repo, path: host.pathname } }));
		const toolchain: Toolchain = job.toolchain ?? "node";
		for (const registry of registriesFor(toolchain)) await container.interceptOutboundHttps(registry, this.ctx.exports.RegistryGateway({ props: {} }));
		// An instance deployed before an image existed for this toolchain runs it in the Node image, where its first step says what is missing.
		const images = container.images as Record<string, typeof container.images.runner>;
		container.start({ image: (toolchain !== "node" && images[toolchain]) || images.runner, enableInternet: false, instance: "standard-2" });

		const steps: RunStep[] = [];
		const env = { CI: "true", HOME: "/root", ...TRUST, NPM_CONFIG_UPDATE_NOTIFIER: "false", GIT_TERMINAL_PROMPT: "0", WRANGLER_SEND_METRICS: "false", DO_NOT_TRACK: "1",
			PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1", UV_NO_PROGRESS: "1", PYTHONUNBUFFERED: "1", CARGO_TERM_COLOR: "never", GOFLAGS: "-buildvcs=false" };
		const decode = (b: ArrayBuffer) => new TextDecoder().decode(b);
		const exec = async (argv: string[], cwd?: string) => {
			// `timeout` stops the command and everything it started.
			const p = await container.exec(["timeout", "--kill-after=5", String(STEP_SECONDS), ...argv], { cwd, env, stderr: "combined" });
			const out = await p.output();
			return { code: out.exitCode, text: decode(out.stdout) };
		};
		/** Run one named step, report it as running and then with its result. */
		const step = async (name: string, command: string, argv: string[], cwd?: string) => {
			const s: RunStep = { name, command, status: "running", exitCode: null, ms: 0, tail: "" };
			steps.push(s);
			await this.report(job, { status: "running", steps });
			const began = Date.now();
			const r = await exec(argv, cwd);
			Object.assign(s, { status: r.code === 0 ? "pass" : "fail", exitCode: r.code, ms: Date.now() - began, tail: redact(r.text).slice(-TAIL) });
			await this.report(job, { steps });
			return r.code === 0;
		};
		const finish = (patch: Partial<Run>) => this.report(job, { steps, finishedAt: Date.now(), toolchain, ...patch });
		const superseded = async () => !!(await this.ctx.storage.get("next"));

		// The exact commit: a shallow fetch of the sha, so a push that lands mid-run cannot change what is verified.
		const cloned = await step("clone", `git fetch ${job.sha.slice(0, 7)}`, ["sh", "-c",
			`git init -q ${WORK} && cd ${WORK} && git remote add origin "$0" && (git fetch -q --depth=1 origin "$1" || git fetch -q --depth=50 origin "$2") && git checkout -q "$1"`, job.remote, job.sha, job.branch]);
		if (!cloned) return finish({ status: "error", error: "could not fetch the commit" });

		// Java does not read a certificate from the environment: the gateway's is added to its store before anything is fetched.
		if (toolchain === "java") await exec(["sh", "-c", `keytool -importcert -noprompt -trustcacerts -cacerts -storepass changeit -alias braid-sandbox -file ${CA} >/dev/null 2>&1 || true`]);

		if (job.regenerate) {
			// Resolve only: the registry is asked what each dependency resolves to, and nothing from a package is run.
			const files: Record<string, string> = {};
			for (const path of job.regenerate) {
				const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".", name = path.slice(path.lastIndexOf("/") + 1);
				const command = lockOf(name)?.command;
				if (!command) return finish({ status: "error", error: `Braid cannot regenerate ${name}` });
				if (!(await step(`lockfile ${path}`.slice(0, 40), command, ["sh", "-c", command], `${WORK}/${dir}`))) return finish({ status: "fail" });
				const out = await exec(["cat", path], WORK);
				if (out.code !== 0 || out.text.length > MAX_PREVIEW_FILE) return finish({ status: "error", error: `could not read ${path} back` });
				files[path] = out.text;
			}
			await this.project(job).lockfiles(job.runId, files);
			return finish({ status: "pass", nothingToRun: true });
		}

		const plan = await this.plan(exec, toolchain, job.policy);
		if (plan.install && !(await step("install", plan.install, ["sh", "-c", plan.install], WORK))) return finish({ status: "fail" });
		for (const [name, command] of plan.checks) {
			if (await superseded()) return finish({ status: "superseded" });
			await step(name, command, ["sh", "-c", command], WORK);
		}

		const passed = steps.every((s) => s.status === "pass");
		let preview = false;
		if (plan.previewDir && steps.find((s) => s.name === "build")?.status !== "fail") preview = await this.savePreview(container, plan.previewDir);
		return finish({ status: passed ? "pass" : "fail", preview, previewApi: preview && plan.previewApi, nothingToRun: plan.checks.length === 0 });
	}

	/**
	 * What to run: how the commit's own files say it is installed and checked, with trunk deciding which checks there are
	 * (see planFor). With a policy, trunk's braid.json decides and this commit's own copy only says what it is run in.
	 */
	private async plan(exec: (argv: string[], cwd?: string) => Promise<{ code: number; text: string }>, toolchain: Toolchain, policy?: RunPolicy): Promise<Plan> {
		const files: Files = {
			has: async (path) => (await exec(["test", "-e", path], WORK)).code === 0,
			read: async (path) => { const r = await exec(["cat", path], WORK); return r.code === 0 ? r.text : null; },
		};
		const json = async (file: string) => { try { return JSON.parse((await files.read(file)) ?? "null"); } catch { return null; } };
		const own = await json("braid.json"), config = policy ? policy.config : own;
		const { install, checks } = await planFor(files, own, policy ?? null, toolchain);
		let previewDir: string | null = typeof config?.preview?.dir === "string" ? config.preview.dir : null;
		// Decided before the build, from what the project says or where builds usually land; checked again after.
		if (!previewDir && config?.preview !== false) previewDir = checks.some(([name]) => name === "build") && (await files.has("package.json")) ? "auto" : (await files.has("index.html")) ? "." : null;
		return { install, checks, previewDir, previewApi: config?.preview?.api === "braid" };
	}

	/** Copy the built site out of the instance into this object, so the preview outlives the sandbox. */
	private async savePreview(container: Container, wanted: string): Promise<boolean> {
		let dir = wanted;
		const probe = async (d: string) => (await (await container.exec(["test", "-f", `${d}/index.html`], { cwd: WORK })).exitCode) === 0;
		if (dir === "auto") {
			dir = "";
			for (const d of PREVIEW_DIRS) if (await probe(d)) { dir = d; break; }
			if (!dir) return false;
		} else if (!/^[\w./-]+$/.test(dir) || dir.includes("..") || !(await probe(dir))) return false;

		// node_modules and .git only matter when the site is the repository root.
		// Cut off just past the limit, so an enormous build output is never read into memory.
		const tar = await container.exec(["sh", "-c", `tar -cf - --exclude=./node_modules --exclude=./.git -C "$0" . | head -c ${MAX_PREVIEW_TOTAL + 1_000_000}`, dir], { cwd: WORK, stderr: "ignore" });
		const bytes = new Uint8Array((await tar.output()).stdout);
		if (bytes.byteLength > MAX_PREVIEW_TOTAL) return false;
		this.ctx.storage.sql.exec("DELETE FROM files");
		let total = 0, count = 0;
		for (const f of untar(bytes)) {
			if (f.body.byteLength > MAX_PREVIEW_FILE || (total += f.body.byteLength) > MAX_PREVIEW_TOTAL) continue;
			this.ctx.storage.sql.exec("INSERT OR REPLACE INTO files (path, body) VALUES (?, ?)", f.path, f.body);
			count++;
		}
		return count > 0;
	}

	/** A file of the saved preview. Unknown paths without an extension get index.html, as a single-page app expects. */
	async file(path: string): Promise<{ path: string; body: ArrayBuffer } | null> {
		const get = (p: string) => this.ctx.storage.sql.exec<{ path: string; body: ArrayBuffer }>("SELECT path, body FROM files WHERE path = ?", p).toArray()[0] ?? null;
		return get(path) ?? (/\.[a-z0-9]+$/i.test(path) ? null : get("index.html"));
	}

	async clear() {
		await this.ctx.storage.deleteAlarm();
		if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
		await this.ctx.storage.deleteAll();
	}
}

/** Regular files in a tar archive (ustar, with GNU and pax long names). */
export function* untar(bytes: Uint8Array): Generator<{ path: string; body: Uint8Array }> {
	const text = (from: number, len: number) => { const s = new TextDecoder().decode(bytes.subarray(from, from + len)); const end = s.indexOf("\0"); return end === -1 ? s : s.slice(0, end); };
	let longName = "";
	for (let at = 0; at + 512 <= bytes.length; ) {
		const name = text(at, 100);
		if (!name) break;
		const size = parseInt(text(at + 124, 12).trim() || "0", 8), type = text(at + 156, 1), prefix = text(at + 345, 155);
		const body = bytes.subarray(at + 512, at + 512 + size);
		at += 512 + Math.ceil(size / 512) * 512;
		if (type === "L") { longName = new TextDecoder().decode(body).replace(/\0+$/, ""); continue; }
		// pax extended header: records of "<length> key=value\n"; only the path matters here.
		if (type === "x") { longName = new TextDecoder().decode(body).match(/^\d+ path=(.*)$/m)?.[1] ?? ""; continue; }
		if (type === "g") continue;
		const path = (longName || (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, "");
		longName = "";
		if ((type === "0" || type === "") && path && !path.endsWith("/")) yield { path, body };
	}
}
