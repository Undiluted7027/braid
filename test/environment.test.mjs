import test from "node:test";
import assert from "node:assert/strict";
import { conventionalChecks, ENVIRONMENT, gradleInit, mavenFor, mavenSettings, MAVEN_MIRROR, imageInputs, LOCKFILE, lockOf, ownImageOf, parseJsonc, planFor, registriesFor, toolchainOf } from "../src/worker/environment.ts";
import { diffFlags } from "../src/worker/flags.ts";

/** A commit's files as a plain object: a name with no content is a directory or an empty file. */
const files = (map) => ({ has: async (p) => p in map, read: async (p) => (p in map ? map[p] : null) });

test("the toolchain comes from the commit's files, or from what its braid.json says", async () => {
	assert.equal(await toolchainOf(files({ "package.json": "{}" })), "node");
	assert.equal(await toolchainOf(files({ "pyproject.toml": "" })), "python");
	assert.equal(await toolchainOf(files({ "requirements.txt": "" })), "python");
	assert.equal(await toolchainOf(files({ "go.mod": "" })), "go");
	assert.equal(await toolchainOf(files({ "Cargo.toml": "" })), "rust");
	assert.equal(await toolchainOf(files({ "pom.xml": "" })), "java");
	assert.equal(await toolchainOf(files({ "build.gradle.kts": "" })), "java");
	assert.equal(await toolchainOf(files({})), "node", "nothing to go on: the plain image");
	// A front end beside a backend: every image has Node, so the other language decides.
	assert.equal(await toolchainOf(files({ "package.json": "{}", "pyproject.toml": "" })), "python");
	assert.equal(await toolchainOf(files({ "package.json": "{}", "go.mod": "" }), { environment: { image: "node" } }), "node", "said outright");
	assert.equal(await toolchainOf(files({ "go.mod": "" }), { environment: { image: "cobol" } }), "go", "a name Braid does not know is not followed");
});

test("a project laid out the usual way needs no settings: install and checks per language", async () => {
	const plan = async (map) => { const p = await planFor(files(map), null); return [p.toolchain, p.install, p.checks]; };
	assert.deepEqual(await plan({ "package.json": JSON.stringify({ scripts: { test: "node --test", build: "vite build", start: "x" } }), "pnpm-lock.yaml": "" }),
		["node", "pnpm install --frozen-lockfile", [["build", "pnpm run build"], ["test", "pnpm run test"]]]);
	assert.deepEqual(await plan({ "pyproject.toml": "[tool.ruff]\n[tool.mypy]\n", "uv.lock": "", tests: "" }),
		["python", "uv sync --frozen", [["typecheck", "uv run mypy ."], ["lint", "uv run ruff check ."], ["test", "uv run pytest"]]]);
	assert.deepEqual(await plan({ "requirements.txt": "flask\n", "requirements-dev.txt": "pytest\n", tests: "" }),
		["python", "python3 -m venv --system-site-packages .venv && .venv/bin/pip install --quiet -r requirements.txt -r requirements-dev.txt", [["test", ". .venv/bin/activate && python -m pytest"]]]);
	assert.deepEqual((await planFor(files({ "requirements.txt": "", "pyproject.toml": "[tool.ruff]\n[tool.mypy]\n" }), null)).checks, [["typecheck", ". .venv/bin/activate && python -m mypy ."], ["lint", ". .venv/bin/activate && ruff check ."]]);
	assert.deepEqual(await plan({ "pyproject.toml": "[project]\nname='x'\n", "poetry.lock": "", "conftest.py": "" }), ["python", "poetry install --no-interaction", [["test", "poetry run pytest"]]]);
	assert.deepEqual(await plan({ "pyproject.toml": "[project]\nname='x'\n" }), ["python", "python3 -m venv --system-site-packages .venv && .venv/bin/pip install --quiet -e .", []], "no tests, so nothing to run");
	assert.deepEqual(await plan({ "go.mod": "module x\n" }), ["go", "go mod download", [["vet", "go vet ./..."], ["build", "go build ./..."], ["test", "go test ./..."]]]);
	assert.deepEqual(await plan({ "Cargo.toml": "", "Cargo.lock": "" }), ["rust", "cargo fetch --locked", [["check", "cargo check --all-targets --locked"], ["test", "cargo test --locked"]]]);
	assert.deepEqual(await plan({ "Cargo.toml": "" }), ["rust", "cargo fetch", [["check", "cargo check --all-targets"], ["test", "cargo test"]]]);
	assert.deepEqual(await plan({ "pom.xml": "" }), ["java", null, [["test", "mvn --batch-mode --no-transfer-progress test"]]]);
	assert.deepEqual(await plan({ "build.gradle": "", gradlew: "" }), ["java", null, [["test", "sh ./gradlew --no-daemon test"]]]);
});

test("trunk says which checks there are; the commit says what it is run in and how", async () => {
	// The attempt deleted its tests directory and its ruff settings. Trunk had both checks, so both still run.
	const trunk = { config: null, checks: await conventionalChecks(files({ "pyproject.toml": "[tool.ruff]\n", "uv.lock": "", tests: "" })) };
	assert.deepEqual(trunk.checks, ["lint", "test"]);
	assert.deepEqual((await planFor(files({ "pyproject.toml": "", "uv.lock": "" }), null, trunk)).checks, [["lint", "uv run ruff check ."], ["test", "uv run pytest"]]);
	// The same for a Node project whose attempt removed the test script.
	const node = { config: null, checks: await conventionalChecks(files({ "package.json": JSON.stringify({ scripts: { test: "x", typecheck: "y" } }) })) };
	assert.deepEqual((await planFor(files({ "package.json": JSON.stringify({ scripts: { typecheck: "y" } }), "package-lock.json": "" }), null, node)).checks, [["typecheck", "npm run typecheck"], ["test", "npm run test"]]);
	// A check the attempt adds is run too.
	assert.deepEqual((await planFor(files({ "pyproject.toml": "[tool.mypy]\n[tool.ruff]\n", "uv.lock": "", tests: "" }), null, trunk)).checks.map((c) => c[0]), ["typecheck", "lint", "test"]);
	// Trunk's braid.json decides the checks outright; the attempt's own copy is not asked, except for what it is run in.
	const set = { config: { install: "make deps", checks: { unit: "make test" } }, checks: [] };
	const own = { checks: { unit: "true" }, environment: { image: "go" } };
	assert.deepEqual(await planFor(files({ "package.json": "{}" }), own, set), { toolchain: "go", install: "make deps", checks: [["unit", "make test"]] });
	// The attempt moves the project from Node to Go: it is run as Go, and trunk's "test" still has to pass.
	const was = { config: null, checks: ["test", "build"] };
	assert.deepEqual(await planFor(files({ "go.mod": "" }), null, was), { toolchain: "go", install: "go mod download", checks: [["vet", "go vet ./..."], ["build", "go build ./..."], ["test", "go test ./..."]] });
});

test("each toolchain may read its own registries and Node's, and nothing else", () => {
	assert.deepEqual(registriesFor("node"), ["registry.npmjs.org"]);
	assert.deepEqual(registriesFor("python"), ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
	assert.deepEqual(registriesFor("go"), ["registry.npmjs.org", "proxy.golang.org", "sum.golang.org"]);
	assert.ok(registriesFor("rust").includes("static.crates.io") && registriesFor("java").includes("repo.maven.apache.org"));
});

test("lockfiles Braid regenerates, and the files that say what a project is run in", () => {
	for (const path of ["pnpm-lock.yaml", "web/package-lock.json", "uv.lock", "api/poetry.lock", "Cargo.lock", "go.sum"]) assert.ok(LOCKFILE.test(path), path);
	for (const path of ["yarn.lock", "locks/uv.lock.bak", "Cargo.toml"]) assert.ok(!LOCKFILE.test(path), path);
	assert.deepEqual([lockOf("api/uv.lock").command, lockOf("api/uv.lock").toolchain, lockOf("go.sum").manifest, lockOf("README.md")], ["uv lock", "python", "go.mod", null]);
	for (const path of ["Dockerfile", "api/Dockerfile.dev", "docker-compose.yml", "compose.yaml", ".devcontainer/devcontainer.json", ".tool-versions", "mise.toml", ".python-version", "rust-toolchain.toml", ".nvmrc"]) assert.ok(ENVIRONMENT.test(path), path);
	for (const path of ["docs/Dockerfile.md.txt/readme", "src/compose.ts", "README.md"]) assert.ok(!ENVIRONMENT.test(path), path);
});

test("a change to what the project is run in is flagged, and a lockfile is judged against its own manifest", () => {
	const change = (path, status = "modified") => ({ path, status, base: "a", head: "b" });
	const kinds = (list, claims = list.map((f) => f.path)) => diffFlags(list, claims).map((f) => [f.kind, f.paths]);
	assert.deepEqual(kinds([change("Dockerfile"), change("src/app.py")]), [["environment", ["Dockerfile"]]]);
	assert.deepEqual(kinds([change("docker-compose.yml", "added"), change(".python-version")]), [["environment", ["docker-compose.yml", ".python-version"]]]);
	assert.deepEqual(kinds([change("uv.lock"), change("pyproject.toml")]), [], "the lockfile moved with its manifest");
	assert.deepEqual(kinds([change("uv.lock"), change("package.json")]), [["lockfile", ["uv.lock"]]], "another language's manifest does not account for it");
	assert.deepEqual(kinds([change("Cargo.lock")]), [["lockfile", ["Cargo.lock"]]]);
	assert.deepEqual(kinds([change("api/go.sum"), change("api/go.mod")]), []);
});

test("a commit can bring its own image: a Dockerfile or an image named in braid.json, or a devcontainer", async () => {
	const own = async (map, config) => ownImageOf(files(map), config);
	assert.deepEqual(await own({}, { environment: { dockerfile: "Dockerfile" } }), { image: { kind: "dockerfile", dockerfile: "Dockerfile", context: "." }, explicit: true });
	assert.deepEqual(await own({}, { environment: { dockerfile: "docker/dev.Dockerfile", context: "." } }), { image: { kind: "dockerfile", dockerfile: "docker/dev.Dockerfile", context: "." }, explicit: true });
	assert.deepEqual((await own({}, { environment: { dockerfile: "api/Dockerfile" } })).image.context, "api", "built in the Dockerfile's own directory unless told otherwise");
	assert.deepEqual(await own({}, { environment: { image: "python:3.13-slim" } }), { image: { kind: "image", image: "python:3.13-slim" }, explicit: true });
	assert.deepEqual((await own({}, { environment: { image: "ghcr.io/acme/dev@sha256:" + "a".repeat(64) } })).image.kind, "image");
	// One of Braid's own images by name is not an image to pull.
	assert.equal(await own({}, { environment: { image: "python" } }), null);
	assert.equal(await own({ Dockerfile: "FROM x" }, null), null, "a Dockerfile alone is not followed: most are for shipping, not for running checks");
	// Paths that leave the repository, and names that are not image names, are not followed.
	for (const bad of [{ dockerfile: "../Dockerfile" }, { dockerfile: "/etc/passwd" }, { dockerfile: "a b" }, { dockerfile: "x; rm -rf /" }, { image: "python:3 && curl evil" }, { image: "-v /:/host alpine" }, { image: "UPPER/case" }])
		assert.equal(await own({}, { environment: bad }), null, JSON.stringify(bad));
	// A devcontainer, with comments and trailing commas as those files have. Paths in it are relative to its own directory.
	const dev = `{\n  // the team's environment\n  "name": "api",\n  "build": { "dockerfile": "Dockerfile", "context": ".." }, /* built from the root */\n  "features": {},\n}`;
	assert.deepEqual(await own({ ".devcontainer/devcontainer.json": dev }, null), { image: { kind: "dockerfile", dockerfile: ".devcontainer/Dockerfile", context: "." }, explicit: false });
	assert.deepEqual(await own({ ".devcontainer.json": '{ "image": "mcr.microsoft.com/devcontainers/python:3.13" }' }, {}), { image: { kind: "image", image: "mcr.microsoft.com/devcontainers/python:3.13" }, explicit: false });
	assert.equal(await own({ ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "../../outside/Dockerfile" } }' }, null), null);
	assert.equal(await own({ ".devcontainer/devcontainer.json": dev }, { environment: { devcontainer: false } }), null, "a project can say its devcontainer is not for checks");
	assert.deepEqual((await own({ ".devcontainer/devcontainer.json": dev }, { environment: { image: "node:24" } })).image, { kind: "image", image: "node:24" }, "what braid.json says comes first");
	assert.deepEqual(parseJsonc('{ "a": "// not a comment", "b": [1, 2,], }'), { a: "// not a comment", b: [1, 2] });
});

test("two commits share a built image when the Dockerfile and the manifests beside it are the same", async () => {
	const image = { kind: "dockerfile", dockerfile: "Dockerfile", context: "." };
	const base = { Dockerfile: "FROM python:3.13\nCOPY requirements.txt .\nRUN pip install -r requirements.txt\n", "requirements.txt": "flask\n", "app.py": "print(1)\n" };
	const key = (map, img = image) => imageInputs(files(map), img);
	assert.equal(await key(base), await key({ ...base, "app.py": "print(2)\n", "tests/test_app.py": "" }), "source changes do not rebuild it: the commit is mounted into the image");
	assert.notEqual(await key(base), await key({ ...base, "requirements.txt": "flask\npytest\n" }));
	assert.notEqual(await key(base), await key({ ...base, Dockerfile: base.Dockerfile + "RUN true\n" }));
	assert.notEqual(await key(base), await key(base, { ...image, context: "api" }));
	assert.notEqual(await key({}, { kind: "image", image: "python:3.13" }), await key({}, { kind: "image", image: "python:3.12" }));
});

test("where a Java project's packages come from: its braid.json, its own Maven settings, or Google's mirror", async () => {
	const google = "maven-central.storage-download.googleapis.com";
	assert.deepEqual(await mavenFor(files({ "pom.xml": "" })), { mirror: MAVEN_MIRROR, hosts: [google] });
	assert.deepEqual(await mavenFor(files({}), { environment: { maven: "https://repo.acme.example/maven2" } }), { mirror: "https://repo.acme.example/maven2/", hosts: ["repo.acme.example"] });
	// The project's own settings file names its mirrors: the sandbox may reach them and Maven is left to the project.
	const own = `<settings><mirrors>\n<!-- <mirror><url>https://old.example/m2</url></mirror> -->\n<mirror><id>corp</id><mirrorOf>*</mirrorOf><url> https://nexus.acme.example/repository/maven-public/ </url></mirror>\n<mirror><id>two</id><url>https://second.example/m2</url></mirror></mirrors></settings>`;
	assert.deepEqual(await mavenFor(files({ ".mvn/settings.xml": own })), { mirror: null, hosts: ["nexus.acme.example", "second.example"] });
	assert.deepEqual((await mavenFor(files({ ".mvn/settings.xml": own }), { environment: { maven: "https://said.example/m2/" } })).hosts, ["said.example"], "what braid.json says comes first");
	// Anything that is not a plain https address of a host is not followed, and the default stands.
	for (const bad of ["http://plain.example/m2", "https://user:pass@host.example/m2", "https://host.example/m2?x=1", "https://localhost/m2", "https://host.example:8443/m2", "file:///etc", "not a url", 7])
		assert.deepEqual(await mavenFor(files({}), { environment: { maven: bad } }), { mirror: MAVEN_MIRROR, hosts: [google] }, String(bad));
	assert.deepEqual(await mavenFor(files({ ".mvn/settings.xml": "<settings><mirrors><mirror><url>http://plain.example</url></mirror></mirrors></settings>" })), { mirror: MAVEN_MIRROR, hosts: [google] });
	assert.match(mavenSettings("https://a.example/m2/?x=<y>&z"), /<mirrorOf>central<\/mirrorOf>\n      <url>https:\/\/a\.example\/m2\/\?x=&lt;y&gt;&amp;z<\/url>/);
	assert.match(gradleInit(MAVEN_MIRROR), /def braidMirror = "https:\/\/maven-central\.storage-download\.googleapis\.com\/maven2\/"/);
});
