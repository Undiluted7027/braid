// What a project needs in order to be run: which toolchain its sandbox must have, how its dependencies are
// installed, which checks it has, and which package registries the sandbox may read. Worked out from the
// files of the commit being run. Free of Worker-only imports, so it is tested with a made-up set of files.

export const TOOLCHAINS = ["node", "python", "go", "rust", "java"] as const;
export type Toolchain = (typeof TOOLCHAINS)[number];
export const isToolchain = (x: unknown): x is Toolchain => (TOOLCHAINS as readonly string[]).includes(x as string);

/** How the files of a commit are looked at: by the sandbox (the files on disk) or by the project (the repository in Artifacts). */
export interface Files { has(path: string): Promise<boolean>; read(path: string): Promise<string | null> }

/**
 * Every sandbox image has Node, so a project with a package.json beside another language's manifest (a Python
 * backend with a JavaScript front end) is run in the other language's image.
 */
const MARKERS: [Toolchain, string[]][] = [
	["go", ["go.mod"]],
	["rust", ["Cargo.toml"]],
	["java", ["pom.xml", "build.gradle", "build.gradle.kts"]],
	["python", ["pyproject.toml", "requirements.txt", "setup.py", "uv.lock", "poetry.lock"]],
	["node", ["package.json"]],
];

/** The toolchain a commit needs: what its braid.json says (environment.image), otherwise what its files show. */
export async function toolchainOf(files: Files, config?: any | null): Promise<Toolchain> {
	if (isToolchain(config?.environment?.image)) return config.environment.image;
	for (const [toolchain, markers] of MARKERS) {
		for (const m of markers) if (await files.has(m)) return toolchain;
	}
	return "node";
}

/** The registries a sandbox may read from, and nothing else on the Internet. Reads only. */
export const REGISTRIES: Record<Toolchain, string[]> = {
	node: ["registry.npmjs.org"],
	python: ["pypi.org", "files.pythonhosted.org"],
	go: ["proxy.golang.org", "sum.golang.org"],
	rust: ["crates.io", "index.crates.io", "static.crates.io"],
	java: ["repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "services.gradle.org"],
};
/** Node's registry is always allowed: every image has Node, and many projects of another language have a front end. */
export const registriesFor = (toolchain: Toolchain): string[] => [...new Set([...REGISTRIES.node, ...REGISTRIES[toolchain]])];

export interface EnvPlan { toolchain: Toolchain; install: string | null; checks: [string, string][] }
/** The order checks are run and shown in, whatever the language calls them. */
const ORDER = ["typecheck", "lint", "check", "vet", "build", "test"];
const NODE_SCRIPTS = ["typecheck", "lint", "test", "build"];

/**
 * How one toolchain installs and checks a project, from its files alone: no setting needed for a project laid out
 * the usual way. `checks` maps a check's name to its command; a name is only there when the project has that check.
 */
async function conventional(toolchain: Toolchain, files: Files): Promise<{ install: string | null; checks: Record<string, string>; /** Every check this toolchain knows by name, as this project would run it, whether or not the project shows it. */ all: Record<string, string> }> {
	const text = async (path: string) => (await files.read(path)) ?? "";
	if (toolchain === "node") {
		let pkg: any = null;
		try { pkg = JSON.parse((await files.read("package.json")) ?? "null"); } catch {}
		if (!pkg) return { install: null, checks: {}, all: {} };
		const pnpm = await files.has("pnpm-lock.yaml");
		const install = pnpm ? "pnpm install --frozen-lockfile" : (await files.has("package-lock.json")) ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
		const run = pnpm ? "pnpm" : "npm";
		const all = Object.fromEntries(NODE_SCRIPTS.map((s) => [s, `${run} run ${s}`]));
		return { install, checks: Object.fromEntries(NODE_SCRIPTS.filter((s) => pkg.scripts?.[s]).map((s) => [s, all[s]])), all };
	}
	if (toolchain === "python") {
		const pyproject = await text("pyproject.toml");
		// A virtual environment that can also see what the image has (pytest, ruff, mypy), for projects that do not list them.
		const venv = "python3 -m venv --system-site-packages .venv";
		// `module` runs a tool as a module of the project's Python, so that it sees the project's packages.
		let install: string | null, run: string, module = "";
		if (await files.has("uv.lock")) { install = "uv sync --frozen"; run = "uv run "; }
		else if (await files.has("poetry.lock")) { install = "poetry install --no-interaction"; run = "poetry run "; }
		else {
			const wanted = [(await files.has("requirements.txt")) ? "-r requirements.txt" : "", (await files.has("requirements-dev.txt")) ? "-r requirements-dev.txt" : "",
				pyproject || (await files.has("setup.py")) ? "-e ." : ""].filter(Boolean);
			install = `${venv}${wanted.length ? ` && .venv/bin/pip install --quiet ${wanted.join(" ")}` : ""}`;
			run = ". .venv/bin/activate && "; module = "python -m ";
		}
		// ruff is a program, not a module: it is found on the path either way.
		const all = { typecheck: `${run}${module}mypy .`, lint: `${run}ruff check .`, test: `${run}${module}pytest` }, checks: Record<string, string> = {};
		if (/\[tool\.mypy\]/.test(pyproject) || (await files.has("mypy.ini"))) checks.typecheck = all.typecheck;
		if (/\[tool\.ruff/.test(pyproject) || (await files.has("ruff.toml")) || (await files.has(".ruff.toml"))) checks.lint = all.lint;
		if ((await files.has("tests")) || (await files.has("test")) || /\[tool\.pytest/.test(pyproject) || (await files.has("pytest.ini")) || (await files.has("conftest.py"))) checks.test = all.test;
		return { install, checks, all };
	}
	if (toolchain === "go") {
		const checks = { vet: "go vet ./...", build: "go build ./...", test: "go test ./..." };
		return { install: "go mod download", checks, all: checks };
	}
	if (toolchain === "rust") {
		const locked = (await files.has("Cargo.lock")) ? " --locked" : "";
		const checks = { check: `cargo check --all-targets${locked}`, test: `cargo test${locked}` };
		return { install: `cargo fetch${locked}`, checks, all: checks };
	}
	// Java: Maven, or Gradle through the project's own wrapper when it has one.
	const checks = { test: (await files.has("pom.xml")) ? "mvn --batch-mode --no-transfer-progress test" : `${(await files.has("gradlew")) ? "sh ./gradlew" : "gradle"} --no-daemon test` };
	return { install: null, checks, all: checks };
}

/** The checks a commit has by convention, by name. The project works this out for trunk, so that an attempt cannot drop one. */
export async function conventionalChecks(files: Files, config?: any | null): Promise<string[]> {
	return Object.keys((await conventional(await toolchainOf(files, config), files)).checks);
}

/**
 * What to run for a commit. Its toolchain and how it installs come from its own files: an attempt that changes them
 * needs its own version to be run. Which checks run is trunk's to say: `trunk` is trunk's braid.json and the checks
 * trunk has by convention, and a check trunk has is run even if the commit no longer shows it. Without `trunk` (trunk
 * itself being run, or a project with nothing on trunk yet) the commit's own files decide everything.
 */
export async function planFor(files: Files, own: any | null, trunk?: { config: any | null; checks: string[] } | null, toolchain?: Toolchain): Promise<EnvPlan> {
	const config = trunk ? trunk.config : own;
	const chain = toolchain ?? (await toolchainOf(files, own));
	const usual = await conventional(chain, files);
	const install = typeof config?.install === "string" ? config.install : usual.install;
	if (config?.checks && typeof config.checks === "object") {
		return { toolchain: chain, install, checks: Object.entries(config.checks).map(([name, command]) => [name.slice(0, 40), String(command)]) };
	}
	// A check trunk has and this commit no longer shows is still run, as this commit's layout would run it.
	const node = chain === "node" ? ((await files.has("pnpm-lock.yaml")) ? "pnpm" : "npm") : null;
	const names = [...new Set([...Object.keys(usual.checks), ...(trunk?.checks ?? [])])];
	const checks = names
		.map((name): [string, string] | null => { const command = usual.checks[name] ?? usual.all[name] ?? (node && NODE_SCRIPTS.includes(name) ? `${node} run ${name}` : null); return command ? [name, command] : null; })
		.filter((c): c is [string, string] => !!c)
		.sort((a, b) => (ORDER.indexOf(a[0]) + 1 || 99) - (ORDER.indexOf(b[0]) + 1 || 99));
	return { toolchain: chain, install, checks };
}

/** Lockfiles Braid can bring up to date itself when both sides changed dependencies, and the command that does it without running anything from a package. */
export const LOCK_COMMANDS: Record<string, { command: string; toolchain: Toolchain; manifest: string }> = {
	"pnpm-lock.yaml": { command: "pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts", toolchain: "node", manifest: "package.json" },
	"package-lock.json": { command: "npm install --package-lock-only --ignore-scripts --no-audit --no-fund", toolchain: "node", manifest: "package.json" },
	"uv.lock": { command: "uv lock", toolchain: "python", manifest: "pyproject.toml" },
	"poetry.lock": { command: "poetry lock --no-interaction", toolchain: "python", manifest: "pyproject.toml" },
	"Cargo.lock": { command: "cargo generate-lockfile", toolchain: "rust", manifest: "Cargo.toml" },
	"go.sum": { command: "go mod tidy", toolchain: "go", manifest: "go.mod" },
};
export const LOCKFILE = new RegExp(`(^|/)(${Object.keys(LOCK_COMMANDS).map((n) => n.replace(/\./g, "\\.")).join("|")})$`);
export const lockOf = (path: string) => LOCK_COMMANDS[path.slice(path.lastIndexOf("/") + 1)] ?? null;

/** Files that say what a project is run in. A change to one is for a person to look at: it changes what every check means. */
export const ENVIRONMENT = /(^|\/)(Dockerfile[^/]*|[^/]*\.dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|\.devcontainer\/[^/]+|\.devcontainer\.json|\.tool-versions|\.mise\.toml|mise\.toml|\.python-version|\.nvmrc|\.node-version|rust-toolchain(\.toml)?)$/;

/**
 * A project's own image: what a commit asks to be run in when the images Braid has are not enough. Either a
 * Dockerfile in the repository, which Braid builds, or an image by name, which it pulls. Both need the Internet,
 * so they are only followed in a project whose trunk allows that for building images (see `ownImageOf`).
 */
export type OwnImage = { kind: "dockerfile"; dockerfile: string; context: string } | { kind: "image"; image: string };

const PATH = /^[\w.@+-][\w.@+/-]*$/;
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[\w.-]{1,128})?(@sha256:[0-9a-f]{64})?$/;
const safePath = (p: unknown): string | null => (typeof p === "string" && PATH.test(p) && !p.split("/").includes("..") && p.length < 200 ? p.replace(/^\.\//, "") : null);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
/** A path written relative to a directory of the repository, as a path from its root. Null if it leaves the repository. */
function under(dir: string, relative: unknown): string | null {
	if (typeof relative !== "string" || relative.startsWith("/")) return null;
	const parts: string[] = dir === "." ? [] : dir.split("/");
	for (const part of relative.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(part);
	}
	return safePath(parts.join("/") || ".") ?? (parts.length ? null : ".");
}
/** devcontainer.json is JSON with comments and trailing commas. */
export function parseJsonc(text: string): any {
	const bare = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1");
	try { return JSON.parse(bare); } catch { return null; }
}

/**
 * The image a commit asks for, from its own files. `explicit` is true when its braid.json says so
 * (`"environment": { "dockerfile": "Dockerfile" }` or `{ "image": "python:3.13-slim" }`), and false when it comes from a
 * devcontainer, which is followed only where the project has already allowed images to be built.
 */
export async function ownImageOf(files: Files, config?: any | null): Promise<{ image: OwnImage; explicit: boolean } | null> {
	const env = config?.environment;
	const dockerfile = safePath(env?.dockerfile);
	if (dockerfile) return { image: { kind: "dockerfile", dockerfile, context: safePath(env?.context) ?? dirOf(dockerfile) }, explicit: true };
	if (typeof env?.image === "string" && !isToolchain(env.image) && IMAGE.test(env.image) && env.image.length < 250) return { image: { kind: "image", image: env.image }, explicit: true };
	if (env?.devcontainer === false) return null;
	for (const path of [".devcontainer/devcontainer.json", ".devcontainer.json"]) {
		const text = await files.read(path);
		if (!text) continue;
		const dev = parseJsonc(text), base = dirOf(path);
		const file = under(base, dev?.build?.dockerfile ?? dev?.dockerFile);
		if (file && file !== ".") return { image: { kind: "dockerfile", dockerfile: file, context: under(base, dev?.build?.context ?? dev?.context ?? ".") ?? base }, explicit: false };
		if (typeof dev?.image === "string" && IMAGE.test(dev.image)) return { image: { kind: "image", image: dev.image }, explicit: false };
	}
	return null;
}

/** Manifests a Dockerfile usually copies in to install dependencies: an image built before one of these changed is built again. */
export const IMAGE_INPUTS = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "requirements.txt", "requirements-dev.txt", "pyproject.toml", "uv.lock", "poetry.lock",
	"go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock"];
/** What decides whether two commits can share one built image: the Dockerfile's text (or the image's name) and the manifests beside it. */
export async function imageInputs(files: Files, image: OwnImage): Promise<string> {
	const parts: string[] = [image.kind, image.kind === "dockerfile" ? `${image.dockerfile}\n${image.context}\n${(await files.read(image.dockerfile)) ?? ""}` : image.image];
	if (image.kind === "dockerfile") {
		const dir = image.context === "." ? "" : `${image.context}/`;
		for (const name of IMAGE_INPUTS) { const text = await files.read(dir + name); if (text !== null) parts.push(`${name}\n${text}`); }
	}
	return parts.join("\n\0\n");
}

/**
 * Where Java's packages come from. Maven Central answers 403 to requests from Cloudflare's network, so a Java project
 * on a deployed instance needs a mirror. In order: what the project says in braid.json (`"environment": { "maven":
 * "https://…/maven2/" }`), the mirrors in its own `.mvn/settings.xml`, and failing both, Google's mirror of Maven Central.
 * Read from trunk: it decides which hosts a sandbox may reach, and an attempt does not get to add one.
 */
export const MAVEN_MIRROR = "https://maven-central.storage-download.googleapis.com/maven2/";
export interface Maven {
	/** The mirror Braid points Maven and Gradle at. Null when the project's own settings file names its mirrors: Braid then only lets the sandbox reach them. */
	mirror: string | null;
	hosts: string[];
}
function mirrorUrl(value: unknown): URL | null {
	if (typeof value !== "string" || value.length > 300) return null;
	try { const u = new URL(value.trim()); return u.protocol === "https:" && !u.username && !u.password && !u.search && /^[a-z0-9.-]+$/.test(u.hostname) && u.hostname.includes(".") && (!u.port || u.port === "443") ? u : null; } catch { return null; }
}
export async function mavenFor(files: Files, config?: any | null): Promise<Maven> {
	const said = mirrorUrl(config?.environment?.maven);
	if (said) return { mirror: said.href.replace(/\/?$/, "/"), hosts: [said.hostname] };
	const settings = await files.read(".mvn/settings.xml");
	if (settings) {
		const hosts = [...settings.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<mirror>[\s\S]*?<url>\s*([^<\s]+)\s*<\/url>[\s\S]*?<\/mirror>/g)].map((m) => mirrorUrl(m[1])?.hostname).filter((h): h is string => !!h);
		if (hosts.length) return { mirror: null, hosts: [...new Set(hosts)].slice(0, 6) };
	}
	return { mirror: MAVEN_MIRROR, hosts: [new URL(MAVEN_MIRROR).hostname] };
}
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A Maven settings file for the sandbox's user: everything asked of Maven Central goes to the mirror. */
export const mavenSettings = (mirror: string) => `<settings>\n  <mirrors>\n    <mirror>\n      <id>braid-mirror</id>\n      <mirrorOf>central</mirrorOf>\n      <url>${xml(mirror)}</url>\n    </mirror>\n  </mirrors>\n</settings>\n`;
/** The same for Gradle, as an init script: repositories that point at Maven Central are pointed at the mirror. */
export const gradleInit = (mirror: string) => `def braidMirror = ${JSON.stringify(mirror)}
def braidCentral = ["repo.maven.apache.org", "repo1.maven.org"]
def braidPoint = { repos -> repos.all { repo -> if (repo instanceof MavenArtifactRepository && braidCentral.contains(repo.url.host)) repo.url = uri(braidMirror) } }
settingsEvaluated { settings ->
	braidPoint(settings.pluginManagement.repositories)
	braidPoint(settings.dependencyResolutionManagement.repositories)
}
allprojects { braidPoint(buildscript.repositories); braidPoint(repositories) }
`;
