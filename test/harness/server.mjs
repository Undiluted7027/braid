// git's own HTTP backend behind a small server, for the tests' repositories. Prints its port.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

const root = process.argv[2];
const backend = join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git-http-backend");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const server = createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	const cgi = spawn(backend, [], { env: { ...ENV, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: req.method, PATH_INFO: url.pathname,
		QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "t", REMOTE_ADDR: "127.0.0.1",
		...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}), ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}) } });
	req.pipe(cgi.stdin);
	const chunks = [];
	cgi.stdout.on("data", (c) => chunks.push(c));
	cgi.on("close", () => {
		const out = Buffer.concat(chunks), cut = out.indexOf("\r\n\r\n");
		const head = out.subarray(0, cut).toString().split("\r\n"), body = out.subarray(cut + 4);
		let status = 200;
		for (const line of head) {
			const [name, ...rest] = line.split(": ");
			if (name.toLowerCase() === "status") status = parseInt(rest.join(": "), 10); else if (name) res.setHeader(name, rest.join(": "));
		}
		res.writeHead(status).end(body);
	});
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));

