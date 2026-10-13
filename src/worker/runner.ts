// Verifies an attempt by running it: one sandbox per ref, a fresh Linux instance per run.
// The instance has no Internet access and holds no credentials. It can reach exactly two things,
// both through this Worker: the one repository it is verifying (read-only) and the package registries of its toolchain.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { redact } from "../shared/redact";
import type { Run, RunStep } from "../shared/types";
import { ArtifactsHost } from "./host";
import type { BraidEnv, Project } from "./project";
import { gradleInit, lockOf, mavenSettings, planFor, registriesFor, type Files, type Maven, type OwnImage, type Toolchain } from "./environment.ts";

/** What to run, as trunk defines it: its braid.json, and the checks it has by convention (by name). An attempt cannot drop a check by editing these. */
export interface RunPolicy { config: any | null; checks: string[];
	/** Where a Java project's packages come from, as trunk has it (see mavenFor). */
	maven?: Maven }
export interface RunJob { slug: string; ref: string; repo: string; remote: string; branch: string; sha: string; runId: number; policy?: RunPolicy;
	/** The toolchain this commit needs, worked out from its own files before the sandbox is started: it decides the image. */
	toolchain?: Toolchain;
	/** Instead of verifying: bring these lockfiles up to date with the commit's manifest and hand them back. */
	regenerate?: string[];
	/**
	 * The commit brings its own image (a Dockerfile, or an image by name). `key` names the built image in the project's
	 * store: commits whose Dockerfile and manifests are the same share one. `allowed` is trunk's say on whether images
	 * may be built at all, since building one needs the Internet.
	 */
	own?: { image: OwnImage; key: string; allowed: boolean } }

const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const WORK = "/workspace";
const STEP_SECONDS = 600;
const TAIL = 6000;
const MAX_RUN_MS = 60 * 60 * 1000;
const MAX_PREVIEW_FILE = 1_900_000; // a SQLite value holds 2 MB
const MAX_PREVIEW_TOTAL = 40_000_000;
/** Building an image may take longer than a check does. */
const BUILD_SECONDS = 1500;
/** A hostname that exists only inside a sandbox: built images are sent to it and fetched from it. */
const IMAGES_HOST = "images.braid.internal";
const IMAGE_CHUNK = 1_500_000; // a SQLite value holds 2 MB
/** The most one built image may take, compressed, and how many a project keeps. */
const MAX_IMAGE_BYTES = 3_000_000_000, MAX_IMAGES = 3;
/** An image that has stood this long is built again: what it was built from (a base image, a package index) has moved on. */
const IMAGE_TTL_MS = 7 * 24 * 3600_000;
/** Start Docker inside a sandbox and wait for it. The flags are the ones a Cloudflare sandbox needs: it may not touch packet filtering or forwarding. */
const DOCKER_UP = `(dockerd --iptables=false --ip6tables=false --ip-forward=false > /var/log/dockerd.log 2>&1 &); for i in $(seq 1 200); do docker version >/dev/null 2>&1 && break; sleep 0.2; done; docker version >/dev/null 2>&1`;
/** The name the project's image has inside a sandbox, as an image and as the container the checks are run in. */
const ENV_IMAGE = "braid-env";
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

/**
 * Where a built image goes when it leaves the sandbox that built it, and where the sandbox that runs the checks
 * fetches it from. `write` is only given to the building sandbox, and only for the one image it was asked to build.
 */
export class ImageGateway extends WorkerEntrypoint<BraidEnv, { slug: string; key: string; write: boolean }> {
	async fetch(request: Request): Promise<Response> {
		const { slug, key, write } = this.ctx.props, url = new URL(request.url);
		if (url.pathname !== `/${key}`) return new Response("Braid: this sandbox may only reach its own image\n", { status: 403 });
		const store = this.env.RUNNER.get(this.env.RUNNER.idFromName(`${slug}/~images`)) as unknown as Runner;
		if (request.method === "PUT" && write && request.body) {
			const upload = await store.imageBegin(key);
			// The body arrives in pieces of a few kilobytes. They are copied once, into the piece of the image being filled:
			// joining them up one by one copied the same bytes thousands of times and ran this call out of processor time.
			let n = 0, total = 0, used = 0, chunk = new Uint8Array(IMAGE_CHUNK);
			for await (const piece of request.body as unknown as AsyncIterable<Uint8Array>) {
				for (let at = 0; at < piece.byteLength; ) {
					const take = Math.min(IMAGE_CHUNK - used, piece.byteLength - at);
					chunk.set(piece.subarray(at, at + take), used);
					used += take; at += take;
					if (used === IMAGE_CHUNK) {
						if ((total += IMAGE_CHUNK) > MAX_IMAGE_BYTES) return new Response(`Braid: the image is larger than ${MAX_IMAGE_BYTES / 1e9} GB compressed\n`, { status: 413 });
						await store.imagePut(upload, n++, chunk);
						chunk = new Uint8Array(IMAGE_CHUNK); used = 0;
					}
				}
			}
			if (used) { await store.imagePut(upload, n++, chunk.slice(0, used)); total += used; }
			if (!total) return new Response("Braid: nothing was sent\n", { status: 400 });
			await store.imageCommit(key, upload, n, total);
			return Response.json({ chunks: n, bytes: total });
		}
		if (request.method !== "GET") return new Response("Braid: this sandbox may only fetch its image\n", { status: 403 });
		const found = await store.imageFind(key);
		if (!found) return new Response("Braid: no such image\n", { status: 404 });
		let i = 0;
		return new Response(new ReadableStream({ async pull(c) { if (i >= found.chunks) return c.close(); c.enqueue(new Uint8Array(await store.imageGet(found.upload, i++))); } }), { headers: { "content-length": String(found.bytes) } });
	}
}

interface Busy { at: number; job?: RunJob }
interface Plan { install: string | null; checks: [string, string][]; previewDir: string | null; previewApi: boolean }
/** Where each toolchain's tools look for the certificate that vouches for the sandbox's gateway. Java keeps its own store and has it added (see `trust`). */
const TRUST = { GIT_SSL_CAINFO: CA, NODE_EXTRA_CA_CERTS: CA, NPM_CONFIG_CAFILE: CA, SSL_CERT_FILE: CA, REQUESTS_CA_BUNDLE: CA, PIP_CERT: CA, CARGO_HTTP_CAINFO: CA, CURL_CA_BUNDLE: CA };
/**
 * Where the images keep their toolchains (see the Dockerfile). Said again here because a command started in a sandbox on
 * Cloudflare is not given everything the image's own ENV lines set: Rust's tools ran there without knowing where Rust was.
 */
export const TOOL_ENV = { CARGO_HOME: "/opt/cargo", RUSTUP_HOME: "/opt/rustup", PATH: "/opt/cargo/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };

export class Runner extends DurableObject<BraidEnv> {
	constructor(ctx: DurableObjectState, env: BraidEnv) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, body BLOB)");
		// Used by one object per project (named "<project>/~images"): the images its sandboxes have built.
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, upload TEXT, chunks INTEGER, bytes INTEGER, built_at INTEGER, used_at INTEGER)");
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS image_chunks (upload TEXT, n INTEGER, body BLOB, PRIMARY KEY (upload, n))");
	}

	// ── the project's built images ───────────────────────────────────────────

	/** Whether an image for this key is there and fresh enough to use. Finding one counts as using it. */
	async imageFind(key: string): Promise<{ upload: string; chunks: number; bytes: number } | null> {
		const row = this.ctx.storage.sql.exec<{ upload: string; chunks: number; bytes: number; built_at: number }>("SELECT upload, chunks, bytes, built_at FROM images WHERE key = ?", key).toArray()[0];
		if (!row || Date.now() - row.built_at > IMAGE_TTL_MS) return null;
		this.ctx.storage.sql.exec("UPDATE images SET used_at = ? WHERE key = ?", Date.now(), key);
		return { upload: row.upload, chunks: row.chunks, bytes: row.bytes };
	}
	/** An upload is written under its own name and only becomes the image once all of it has arrived. */
	async imageBegin(key: string): Promise<string> {
		// What an upload that never finished left behind.
		this.ctx.storage.sql.exec("DELETE FROM image_chunks WHERE upload NOT IN (SELECT upload FROM images) AND upload LIKE ? AND upload < ?", `${key}:%`, `${key}:${Date.now() - 3600_000}`);
		return `${key}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
	}
	async imagePut(upload: string, n: number, bytes: Uint8Array) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO image_chunks (upload, n, body) VALUES (?, ?, ?)", upload, n, bytes); }
	async imageCommit(key: string, upload: string, chunks: number, bytes: number) {
		const sql = this.ctx.storage.sql, at = Date.now();
		const before = sql.exec<{ upload: string }>("SELECT upload FROM images WHERE key = ?", key).toArray()[0]?.upload;
		sql.exec("INSERT OR REPLACE INTO images (key, upload, chunks, bytes, built_at, used_at) VALUES (?, ?, ?, ?, ?, ?)", key, upload, chunks, bytes, at, at);
		if (before) sql.exec("DELETE FROM image_chunks WHERE upload = ?", before);
		// A project keeps a few images: the ones used least recently go.
		for (const old of sql.exec<{ key: string; upload: string }>("SELECT key, upload FROM images ORDER BY used_at DESC LIMIT -1 OFFSET ?", MAX_IMAGES).toArray()) {
			sql.exec("DELETE FROM image_chunks WHERE upload = ?", old.upload);
			sql.exec("DELETE FROM images WHERE key = ?", old.key);
		}
	}
	async imageGet(upload: string, n: number): Promise<ArrayBuffer> { return this.ctx.storage.sql.exec<{ body: ArrayBuffer }>("SELECT body FROM image_chunks WHERE upload = ? AND n = ?", upload, n).one().body; }
	async imageList() { return this.ctx.storage.sql.exec<{ key: string; bytes: number; built_at: number; used_at: number }>("SELECT key, bytes, built_at, used_at FROM images ORDER BY used_at DESC").toArray(); }

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

		const host = new URL(job.remote), toolchain: Toolchain = job.toolchain ?? "node";
		const own = job.regenerate ? null : job.own ?? null;
		const images = container.images as Record<string, typeof container.images.runner>;
		const gitGateway = this.ctx.exports.GitGateway({ props: { repo: job.repo, path: host.pathname } });
		/** Start the sandbox the commit is run in: no Internet, and only its repository, its registries and (for its own image) the image store. */
		const startSandbox = async () => {
			await container.interceptOutboundHttps(host.hostname, gitGateway);
			const registries = [...registriesFor(toolchain), ...(toolchain === "java" ? job.policy?.maven?.hosts ?? [] : [])];
			for (const registry of new Set(registries)) await container.interceptOutboundHttps(registry, this.ctx.exports.RegistryGateway({ props: {} }));
			if (own) await container.interceptOutboundHttps(IMAGES_HOST, this.ctx.exports.ImageGateway({ props: { slug: job.slug, key: own.key, write: false } }));
			// An instance deployed before an image existed for this toolchain runs it in the Node image, where its first step says what is missing.
			container.start({ image: own ? images.dind : (toolchain !== "node" && images[toolchain]) || images.runner, enableInternet: false, instance: "standard-2" });
		};

		const steps: RunStep[] = [];
		const env = { CI: "true", HOME: "/root", ...TOOL_ENV, ...TRUST, NPM_CONFIG_UPDATE_NOTIFIER: "false", GIT_TERMINAL_PROMPT: "0", WRANGLER_SEND_METRICS: "false", DO_NOT_TRACK: "1",
			PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1", UV_NO_PROGRESS: "1", PYTHONUNBUFFERED: "1", CARGO_TERM_COLOR: "never", GOFLAGS: "-buildvcs=false" };
		const decode = (b: ArrayBuffer) => new TextDecoder().decode(b);
		const exec = async (argv: string[], cwd?: string, seconds = STEP_SECONDS) => {
			// `timeout` stops the command and everything it started.
			const p = await container.exec(["timeout", "--kill-after=5", String(seconds), ...argv], { cwd, env, stderr: "combined" });
			const out = await p.output();
			return { code: out.exitCode, text: decode(out.stdout) };
		};
		/** Run one named step, report it as running and then with its result. */
		const step = async (name: string, command: string, argv: string[], cwd?: string, seconds?: number) => {
			const s: RunStep = { name, command, status: "running", exitCode: null, ms: 0, tail: "" };
			steps.push(s);
			await this.report(job, { status: "running", steps });
			const began = Date.now();
			const r = await exec(argv, cwd, seconds);
			Object.assign(s, { status: r.code === 0 ? "pass" : "fail", exitCode: r.code, ms: Date.now() - began, tail: redact(r.text).slice(-TAIL) });
			await this.report(job, { steps });
			return r.code === 0;
		};
		const finish = (patch: Partial<Run>) => this.report(job, { steps, finishedAt: Date.now(), toolchain: own ? (own.image.kind === "dockerfile" ? own.image.dockerfile : own.image.image) : toolchain, ...patch });
		const superseded = async () => !!(await this.ctx.storage.get("next"));
		// The exact commit: a shallow fetch of the sha, so a push that lands mid-run cannot change what is verified.
		const CLONE = ["sh", "-c", `git init -q ${WORK} && cd ${WORK} && git remote add origin "$0" && (git fetch -q --depth=1 origin "$1" || git fetch -q --depth=50 origin "$2") && git checkout -q "$1"`, job.remote, job.sha, job.branch];
		const what = own ? (own.image.kind === "dockerfile" ? `the image built from ${own.image.dockerfile}` : `the image ${own.image.image}`) : "";

		if (own) {
			if (!images.dind) return finish({ status: "error", error: "this Braid instance was deployed before it could build a project's own image; deploy it again" });
			if (!own.allowed) return finish({ status: "error", error: `This commit asks to be run in ${what}. Getting that needs Internet access, which this project has not allowed: set "environment": { "internet": "build" } in trunk's braid.json to allow it while images are built (never while checks run).` });
			const store = this.env.RUNNER.get(this.env.RUNNER.idFromName(`${job.slug}/~images`)) as unknown as Runner;
			if (!(await store.imageFind(own.key))) {
				// Built in a sandbox of its own, the only one that is ever given the Internet. It holds the commit and no
				// credential, and it is thrown away as soon as the image has been sent to the project's store.
				await container.interceptOutboundHttps(host.hostname, gitGateway);
				await container.interceptOutboundHttps(IMAGES_HOST, this.ctx.exports.ImageGateway({ props: { slug: job.slug, key: own.key, write: true } }));
				container.start({ image: images.dind, enableInternet: true, instance: "standard-2" });
				const ready = await exec(["sh", "-c", `${DOCKER_UP} || { tail -8 /var/log/dockerd.log; exit 1; }`]);
				if (ready.code !== 0) return finish({ status: "error", error: `Docker did not start in the sandbox: ${redact(ready.text).slice(-300)}` });
				if ((await exec(CLONE)).code !== 0) return finish({ status: "error", error: "could not fetch the commit" });
				const built = own.image.kind === "dockerfile"
					? await step("build image", `docker build -f ${own.image.dockerfile} ${own.image.context}`, ["sh", "-c", `docker build --network=host --progress=plain -f "$0" -t ${ENV_IMAGE} "$1" 2>&1`, own.image.dockerfile, own.image.context], WORK, BUILD_SECONDS)
					: await step("build image", `docker pull ${own.image.image}`, ["sh", "-c", `docker pull -q "$0" 2>&1 && docker tag "$0" ${ENV_IMAGE}`, own.image.image], WORK, BUILD_SECONDS);
				if (!built) {
					// Under `wrangler dev` the sandbox is an ordinary container, which may not start containers of its own.
					const s = steps.at(-1)!;
					if (/operation not permitted/.test(s.tail)) s.tail += "\n\nDocker could not start a container inside this sandbox. That works on a deployed instance; it does not under `wrangler dev`.";
					return finish({ status: "fail" });
				}
				// The checks will be run through a shell in it, as the project's own tools are.
				const usable = await exec(["sh", "-c", `docker run --rm --network=none --entrypoint sh ${ENV_IMAGE} -c true 2>&1`]);
				if (usable.code !== 0) return finish({ status: "error", error: `${what} has no shell to run the checks with: ${redact(usable.text).slice(-200)}` });
				const sent = await exec(["bash", "-c", `set -o pipefail; docker save ${ENV_IMAGE} | zstd -T0 -3 | curl -sS --fail-with-body --cacert ${CA} -T - https://${IMAGES_HOST}/${own.key}`], WORK, BUILD_SECONDS);
				if (sent.code !== 0) return finish({ status: "error", error: `the built image could not be kept: ${redact(sent.text).slice(-300)}` });
				await container.destroy().catch(() => {});
			}
		}

		await startSandbox();
		const cloned = await step("clone", `git fetch ${job.sha.slice(0, 7)}`, CLONE);
		if (!cloned) return finish({ status: "error", error: "could not fetch the commit" });
		/** How a command of the project's is run: in the sandbox itself, or in the project's own image inside it. */
		let inside = (command: string): string[] => ["sh", "-c", command];
		if (own) {
			// The project's image, fetched from the store, with the commit mounted where it was cloned and the gateway's certificate
			// handed in. Every command of the project's is then run in that one container, so what an install does is there for the checks.
			const flags = Object.entries({ CI: "true", ...TRUST }).map(([k, v]) => `-e ${k}=${v}`).join(" ");
			const loaded = await step("load image", `use ${what}`, ["bash", "-c",
				`set -o pipefail; ${DOCKER_UP} && curl -sS --fail --cacert ${CA} https://${IMAGES_HOST}/${own.key} | zstd -dc | docker load >/dev/null && chmod -R a+rwX ${WORK} && ` +
				`docker run -d --name ${ENV_IMAGE} --network=host -v ${WORK}:${WORK} -v ${CA}:${CA}:ro -w ${WORK} ${flags} --entrypoint sh ${ENV_IMAGE} -c 'while :; do sleep 3600; done' >/dev/null && docker exec ${ENV_IMAGE} sh -c 'echo ready in $(pwd)'`], WORK);
			if (!loaded) return finish({ status: "error", error: `could not start ${what} in the sandbox` });
			inside = (command) => ["docker", "exec", "-w", WORK, ENV_IMAGE, "sh", "-c", command];
		}

		// Java does not read a certificate from the environment: the gateway's is added to its store before anything is fetched.
		// And Maven and Gradle are pointed at the project's mirror, in the settings of the sandbox's own user. A project with a mirror in its own settings file is left to it.
		const mirror = toolchain === "java" && !own ? job.policy?.maven?.mirror : null;
		if (mirror) await exec(["sh", "-c", `mkdir -p "$HOME/.m2" "$HOME/.gradle" && printf %s "$0" > "$HOME/.m2/settings.xml" && printf %s "$1" > "$HOME/.gradle/init.gradle"`, mavenSettings(mirror), gradleInit(mirror)]);
		if (toolchain === "java" && !own) await exec(["sh", "-c", `keytool -importcert -noprompt -trustcacerts -cacerts -storepass changeit -alias braid-sandbox -file ${CA} >/dev/null 2>&1 || true`]);

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
		if (plan.install && !(await step("install", plan.install, inside(plan.install), WORK))) return finish({ status: "fail" });
		for (const [name, command] of plan.checks) {
			if (await superseded()) return finish({ status: "superseded" });
			await step(name, command, inside(command), WORK);
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
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, body BLOB)");
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, upload TEXT, chunks INTEGER, bytes INTEGER, built_at INTEGER, used_at INTEGER)");
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS image_chunks (upload TEXT, n INTEGER, body BLOB, PRIMARY KEY (upload, n))");
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
