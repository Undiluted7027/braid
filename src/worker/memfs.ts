// Minimal in-memory filesystem for isomorphic-git inside a Worker / Durable Object.
type Entry = { kind: "dir"; children: Set<string>; mtimeMs: number } | { kind: "file"; data: Uint8Array; mtimeMs: number };

function fsError(code: string, path: string) {
	const e = new Error(`${code}: ${path}`) as Error & { code: string };
	e.code = code;
	return e;
}

class Stats {
	private e: Entry;
	constructor(e: Entry) { this.e = e; }
	get size() { return this.e.kind === "file" ? this.e.data.byteLength : 0; }
	get mtimeMs() { return this.e.mtimeMs; }
	get ctimeMs() { return this.e.mtimeMs; }
	get mode() { return this.e.kind === "file" ? 0o100644 : 0o040000; }
	get ino() { return 0; }
	get uid() { return 0; }
	get gid() { return 0; }
	get dev() { return 0; }
	isFile() { return this.e.kind === "file"; }
	isDirectory() { return this.e.kind === "dir"; }
	isSymbolicLink() { return false; }
}

export class MemoryFS {
	private entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);
	private enc = new TextEncoder();
	private dec = new TextDecoder();

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.stat.bind(this),
		readlink: async (p: string) => { throw fsError("EINVAL", p); },
		symlink: async (_t: string, p: string) => { throw fsError("ENOSYS", p); },
		chmod: async () => {},
	};

	private norm(input: string) {
		const out: string[] = [];
		for (const part of input.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") out.pop();
			else out.push(part);
		}
		return "/" + out.join("/");
	}
	private parent(p: string) {
		const i = p.lastIndexOf("/");
		return i <= 0 ? "/" : p.slice(0, i);
	}
	private base(p: string) { return p.slice(p.lastIndexOf("/") + 1); }
	private dir(p: string) {
		const e = this.entries.get(p);
		if (!e) throw fsError("ENOENT", p);
		if (e.kind !== "dir") throw fsError("ENOTDIR", p);
		return e;
	}

	async mkdir(path: string, opts?: { recursive?: boolean } | number) {
		const p = this.norm(path);
		if (this.entries.has(p)) {
			if (typeof opts === "object" && opts?.recursive) return;
			throw fsError("EEXIST", p);
		}
		const parent = this.parent(p);
		if (!this.entries.has(parent)) {
			if (typeof opts === "object" && opts?.recursive) await this.mkdir(parent, { recursive: true });
			else throw fsError("ENOENT", parent);
		}
		this.entries.set(p, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
		this.dir(parent).children.add(this.base(p));
	}
	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
		const p = this.norm(path);
		const parent = this.parent(p);
		if (!this.entries.has(parent)) throw fsError("ENOENT", parent);
		const bytes = typeof data === "string" ? this.enc.encode(data) : data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
		this.entries.set(p, { kind: "file", data: bytes, mtimeMs: Date.now() });
		this.dir(parent).children.add(this.base(p));
	}
	async readFile(path: string, opts?: string | { encoding?: string }) {
		const p = this.norm(path);
		const e = this.entries.get(p);
		if (!e) throw fsError("ENOENT", p);
		if (e.kind !== "file") throw fsError("EISDIR", p);
		const encoding = typeof opts === "string" ? opts : opts?.encoding;
		return encoding ? this.dec.decode(e.data) : e.data;
	}
	async readdir(path: string) { return [...this.dir(this.norm(path)).children].sort(); }
	async unlink(path: string) {
		const p = this.norm(path);
		const e = this.entries.get(p);
		if (!e) throw fsError("ENOENT", p);
		if (e.kind !== "file") throw fsError("EISDIR", p);
		this.entries.delete(p);
		this.dir(this.parent(p)).children.delete(this.base(p));
	}
	async rmdir(path: string) {
		const p = this.norm(path);
		if (this.dir(p).children.size) throw fsError("ENOTEMPTY", p);
		this.entries.delete(p);
		this.dir(this.parent(p)).children.delete(this.base(p));
	}
	async stat(path: string) {
		const p = this.norm(path);
		const e = this.entries.get(p);
		if (!e) throw fsError("ENOENT", p);
		return new Stats(e);
	}
}
