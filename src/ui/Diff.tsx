import { diffLines } from "diff";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../shared/types";
import { Icon } from "./Kit";

type Row = { kind: "add" | "del" | "ctx" | "gap"; text: string; a?: number; b?: number; skipped?: number };
const CONTEXT = 3;

/** `reveal`: lines of the new version to show even when nothing near them changed (a reviewer pointed at them). */
function rows(base: string, head: string, reveal: number[] = []): Row[] {
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
	all.forEach((r, i) => { if (r.kind !== "ctx" || (r.b !== undefined && reveal.includes(r.b))) for (let j = i - CONTEXT; j <= i + CONTEXT; j++) keep.add(j); });
	const out: Row[] = [];
	all.forEach((r, i) => {
		if (keep.has(i)) out.push(r);
		else if (out[out.length - 1]?.kind === "gap") out[out.length - 1].skipped!++;
		else out.push({ kind: "gap", text: "", skipped: 1 });
	});
	return out;
}
const WORD = { added: "Added", modified: "Changed", deleted: "Deleted" } as const;

/** `cite`: a line of the new version someone was sent here to read (`n` changes each time they are sent). The file opens, the line is shown and marked, and it is scrolled into view. */
export function FileDiff({ file, open: initial = false, cite }: { file: DiffFile; open?: boolean; cite?: { line: number | null; n: number } }) {
	const [open, setOpen] = useState(initial || !!cite);
	const box = useRef<HTMLDivElement>(null);
	const body = useMemo(() => (file.binary ? [] : rows(file.base ?? "", file.head ?? "", cite?.line ? [cite.line] : [])), [file, cite?.line]);
	useEffect(() => {
		if (!cite) return;
		setOpen(true);
		// After the file has opened and laid out.
		const t = window.setTimeout(() => (box.current?.querySelector(".line.cited") ?? box.current)?.scrollIntoView({ block: "center" }), 60);
		return () => window.clearTimeout(t);
	}, [cite?.n]);
	const adds = body.filter((r) => r.kind === "add").length, dels = body.filter((r) => r.kind === "del").length;
	return (
		<div ref={box} className={`diff ${open ? "open" : ""} ${cite ? "has-cite" : ""}`}>
			<button className="diff-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<Icon name={open ? "chevron-down" : "chevron-right"} />
				<span className={`fstat ${file.status}`}>{WORD[file.status]}</span>
				<span className="mono diff-path">{file.path}</span>
				{!file.binary && <span className="mono diff-count"><span className="adds">+{adds}</span> <span className="dels">−{dels}</span></span>}
			</button>
			{open && (file.binary ? <div className="diff-note">Binary or very large file; not shown.</div> : (
				<pre className="diff-body" tabIndex={0} aria-label={`Changes to ${file.path}`}>
					{body.map((r, i) => r.kind === "gap" ? <div key={i} className="gap">{r.skipped} unchanged line{r.skipped === 1 ? "" : "s"}</div> : (
						<div key={i} className={`line ${r.kind} ${cite?.line && r.b === cite.line ? "cited" : ""}`}>
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
