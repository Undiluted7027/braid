import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// runner.ts imports cloudflare:workers, which Node cannot load, so take the one pure function out of the source.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(new URL("../src/worker/runner.ts", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export function* untar"));
const { untar } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(body))}`);

test("untar: reads files from a real tar archive, including nested and long paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "braid-untar-"));
	const long = `${"deep/".repeat(30)}file-with-a-long-name.txt`;
	mkdirSync(join(dir, "assets"), { recursive: true });
	mkdirSync(join(dir, long, ".."), { recursive: true });
	writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
	writeFileSync(join(dir, "assets/app.js"), "x".repeat(1500)); // spans more than one 512-byte block
	writeFileSync(join(dir, "empty.txt"), "");
	writeFileSync(join(dir, long), "far down");
	const tar = execFileSync("tar", ["-cf", "-", "-C", dir, "."], { maxBuffer: 1 << 24, env: { ...process.env, COPYFILE_DISABLE: "1" } }); // no macOS resource-fork entries
	const files = new Map([...untar(new Uint8Array(tar))].map((f) => [f.path, new TextDecoder().decode(f.body)]));
	assert.equal(files.get("index.html"), "<h1>hi</h1>");
	assert.equal(files.get("assets/app.js").length, 1500);
	assert.equal(files.get("empty.txt"), "");
	assert.equal(files.get(long), "far down");
	assert.equal(files.size, 4);
});
