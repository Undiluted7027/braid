import { diffLines } from "diff";
import { useMemo, useState } from "react";
import type { DiffFile } from "../shared/types";
import { Icon } from "./Kit";

type Row = { kind: "add" | "del" | "ctx" | "gap"; text: string; a?: number; b?: number; skipped?: number };
const CONTEXT = 3;

function rows(base: string, head: string): Row[] {
	const all: Row[] = [];
	let a = 1, b = 1;
	for (const part of diffLines(base, head)) {
		for (const text of part.value.replace(/\n$/, "").split("\n")) {
			if (part.added) all.push({ kind: "add", text, b: b++ });
			else if (part.removed) all.push({ kind: "del", text, a: a++ });
			else all.push({ kind: "ctx", text, a: a++, b: b++ });
		}
	}
	// Keep only context near a change, and say how much was left out.
	const keep = new Set<number>();
	all.forEach((r, i) => { if (r.kind !== "ctx") for (let j = i - CONTEXT; j <= i + CONTEXT; j++) keep.add(j); });
	const out: Row[] = [];
	all.forEach((r, i) => {
		if (keep.has(i)) out.push(r);
		else if (out[out.length - 1]?.kind === "gap") out[out.length - 1].skipped!++;
		else out.push({ kind: "gap", text: "", skipped: 1 });
	});
	return out;
}
const WORD = { added: "Added", modified: "Changed", deleted: "Deleted" } as const;

export function FileDiff({ file, open: initial = false }: { file: DiffFile; open?: boolean }) {
	const [open, setOpen] = useState(initial);
	const body = useMemo(() => (file.binary ? [] : rows(file.base ?? "", file.head ?? "")), [file]);
	const adds = body.filter((r) => r.kind === "add").length, dels = body.filter((r) => r.kind === "del").length;
	return (
		<div className={`diff ${open ? "open" : ""}`}>
			<button className="diff-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<Icon name={open ? "chevron-down" : "chevron-right"} />
				<span className={`fstat ${file.status}`}>{WORD[file.status]}</span>
				<span className="mono diff-path">{file.path}</span>
				{!file.binary && <span className="mono diff-count"><span className="adds">+{adds}</span> <span className="dels">−{dels}</span></span>}
			</button>
			{open && (file.binary ? <div className="diff-note">Binary or very large file; not shown.</div> : (
				<pre className="diff-body" tabIndex={0} aria-label={`Changes to ${file.path}`}>
					{body.map((r, i) => r.kind === "gap" ? <div key={i} className="gap">{r.skipped} unchanged line{r.skipped === 1 ? "" : "s"}</div> : (
						<div key={i} className={`line ${r.kind}`}>
							<span className="ln">{r.a ?? ""}</span><span className="ln">{r.b ?? ""}</span>
							<span className="sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
							<span className="code">{r.text || " "}</span>
						</div>
					))}
				</pre>
			))}
		</div>
	);
}
