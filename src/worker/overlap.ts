// Where two attempts at different intents meet: files both changed, and paths one plans to change
// that the other has changed or also plans to. Computed for one pair at a time, so a push costs
// the pairs it is part of and not every pair in the project.
import { predict } from "./gitops.ts";
import type { Attempt, Overlap } from "../shared/types.ts";

export const RANK = { claim: 1, touch: 2, conflict: 3 } as const;
const key = (o: Overlap) => `${o.a}|${o.b}|${o.path}`;

export function claimMatches(pattern: string, path: string) {
	const p = pattern.replace(/\*+$/, "").replace(/\/$/, "");
	return p === "" || path === p || path.startsWith(p + "/") || (pattern.endsWith("*") && path.startsWith(p));
}

type Side = Pick<Attempt, "id" | "intentId" | "baseSha" | "files" | "claims" | "repo">;
/** The pair is always written with the smaller id first, so it has one row whoever computed it. */
const ordered = <T extends { id: string }>(x: T, y: T): [T, T] => (x.id < y.id ? [x, y] : [y, x]);

/** One row per pair and path, the strongest kind winning. */
export function strongest(list: Overlap[]): Overlap[] {
	const out = new Map<string, Overlap>();
	for (const o of list) {
		const prev = out.get(key(o));
		if (!prev || RANK[o.severity] > RANK[prev.severity]) out.set(key(o), o);
	}
	return [...out.values()];
}

/** What can be told without reading a file: one side says it will change a path the other changed or also plans to. */
export function claimOverlaps(x: Side, y: Side): Overlap[] {
	if (x.intentId === y.intentId) return []; // competing attempts at one intent are alternatives, not collisions
	const [a, b] = ordered(x, y), out: Overlap[] = [];
	for (const [p, q] of [[a, b], [b, a]] as const) {
		for (const claim of p.claims) {
			for (const path of [...q.files.map((f) => f.path), ...q.claims]) {
				if (claimMatches(claim, path) || claimMatches(path, claim)) out.push({ a: a.id, b: b.id, path: claimMatches(claim, path) ? path : claim, severity: "claim", regions: 0 });
			}
		}
	}
	return strongest(out);
}

/**
 * Files both attempts changed, each merged three ways to see whether they would conflict.
 * `order` is a commit's distance behind trunk's head; `text` reads a blob as text.
 */
export async function fileOverlaps(x: Side, y: Side, order: Map<string, number>, text: (repo: string, hash: string | null) => Promise<string | null>): Promise<Overlap[]> {
	if (x.intentId === y.intentId) return [];
	const [a, b] = ordered(x, y), out: Overlap[] = [];
	const bFiles = new Map(b.files.map((f) => [f.path, f]));
	for (const fa of a.files) {
		const fb = bFiles.get(fa.path);
		if (!fb) continue;
		if (fa.head === fb.head) { out.push({ a: a.id, b: b.id, path: fa.path, severity: "touch", regions: 0 }); continue; }
		// Merge against the older of the two bases: it is an ancestor of both.
		const aOlder = (order.get(a.baseSha) ?? Infinity) >= (order.get(b.baseSha) ?? Infinity);
		const base = aOlder ? await text(a.repo, fa.base) : await text(b.repo, fb.base);
		const p = predict(base, await text(a.repo, fa.head), await text(b.repo, fb.head));
		out.push({ a: a.id, b: b.id, path: fa.path, severity: p.conflict ? "conflict" : "touch", regions: p.regions });
	}
	return out;
}

/** What changed for one attempt between two sets of its overlaps: the rows that are new, or stronger than before. */
export function risen(before: Overlap[], after: Overlap[]): { overlap: Overlap; had: Overlap | null }[] {
	const prev = new Map(before.map((o) => [key(o), o]));
	return after.flatMap((o) => {
		const had = prev.get(key(o)) ?? null;
		return had && RANK[had.severity] >= RANK[o.severity] ? [] : [{ overlap: o, had }];
	});
}
