// Looking at intents before anyone works on them: which ask for opposite things, which need another to land
// first, which are the same thing twice; and splitting a broad goal into intents. This file is what the planner
// is shown and what is kept of its answer. Free of Worker-only imports.
import type { Intent } from "../shared/types.ts";

export type Standing = Pick<Intent, "id" | "title" | "goal" | "criteria"> & { status: "open" | "landed" };
export interface PlanInput { intent: Standing; others: Standing[] }
export interface PlanAnswer {
	relations: { other: number; kind: "contradicts" | "depends_on" | "duplicates"; why: string; mine: number[]; theirs: number[] }[];
}
/** A relation as it will be stored: `from` is the intent that was planned. For "depends", `from` needs `to` to land first. */
export interface Found { kind: "contradicts" | "depends" | "duplicates"; from: number; to: number; why: string; fromCriteria: number[]; toCriteria: number[] }

export const PLAN_SYSTEM = `You look at one new intent for a software project next to the project's other intents, before any agent starts work, for the people who own the project.
An intent is a goal with numbered criteria. Several agents will work on different intents at the same time and each change lands on one shared trunk. Your job is to find, for the NEW intent only, the other intents it cannot simply sit beside.

Report a relation only when you can say exactly why:
- "contradicts": both cannot be true of the same codebase at once. Landing one undoes or blocks the other (two different values for the same thing, one adds what the other removes, incompatible designs for the same part). Give the criterion numbers that clash on each side: "mine" for the new intent, "theirs" for the other. Two intents that merely touch the same file or area do NOT contradict; nor do two that could both be satisfied by one careful change.
- "depends_on": the new intent cannot be done, or cannot be checked, until the other has landed (it builds on something the other introduces). Only for intents that are still open. Do not report a dependency just because the work would be easier afterwards.
- "duplicates": the new intent asks for the same outcome as the other, so one of them is unnecessary.

Most pairs of intents are unrelated, and an empty list is the usual and correct answer. Do not report a relation you would have to argue for. For an intent that has already landed, only "contradicts" (the new intent would undo it) and "duplicates" (it is already done) make sense.
"why" is one or two plain sentences a person can act on, naming the concrete thing that clashes or is needed.`;

const show = (i: Standing) => `### I${i.id}: ${i.title}${i.status === "landed" ? " (already landed)" : ""}\nGoal: ${i.goal}\nCriteria:\n${i.criteria.map((c, n) => `${n + 1}. ${c}`).join("\n")}`;
export function planPrompt(input: PlanInput): string {
	return [`# The new intent\n${show(input.intent)}`, `# The project's other intents\n${input.others.map(show).join("\n\n")}`, `Answer for I${input.intent.id} only. Use the other intent's number (without the "I") as "other".`].join("\n\n");
}

/** Whether `from` already leads to `to` through "depends" edges. */
export function reaches(edges: [number, number][], from: number, to: number): boolean {
	const seen = new Set<number>(), stack = [from];
	while (stack.length) {
		const at = stack.pop()!;
		if (at === to) return true;
		if (seen.has(at)) continue;
		seen.add(at);
		for (const [a, b] of edges) if (a === at) stack.push(b);
	}
	return false;
}

/**
 * What is kept of a planner's answer. A relation must name a real other intent and say why. A contradiction must
 * point at criteria on both sides. A dependency must be on an open intent and must not close a circle with the
 * dependencies already recorded. One relation per pair: a contradiction outranks the others.
 */
export function settleRelations(answer: PlanAnswer, input: PlanInput, depends: [number, number][]): Found[] {
	const me = input.intent, byId = new Map(input.others.map((o) => [o.id, o]));
	const rank = { contradicts: 3, duplicates: 2, depends: 1 } as const, out = new Map<number, Found>();
	const valid = (ns: unknown, of: Standing) => [...new Set((Array.isArray(ns) ? ns : []).filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= of.criteria.length))].sort((a, b) => a - b);
	for (const r of answer.relations ?? []) {
		const other = byId.get(r.other), why = String(r.why ?? "").trim().slice(0, 600);
		if (!other || other.id === me.id || why.length < 12) continue;
		const kind = r.kind === "depends_on" ? "depends" as const : r.kind;
		const mine = valid(r.mine, me), theirs = valid(r.theirs, other);
		if (kind === "contradicts" && (!mine.length || !theirs.length)) continue;
		if (kind === "depends" && (other.status !== "open" || reaches(depends, other.id, me.id))) continue;
		const found: Found = { kind, from: me.id, to: other.id, why, fromCriteria: kind === "depends" ? [] : mine, toCriteria: kind === "depends" ? [] : theirs };
		const had = out.get(other.id);
		if (!had || rank[kind] > rank[had.kind]) out.set(other.id, found);
	}
	return [...out.values()];
}

// ── splitting a goal ─────────────────────────────────────────────────────────

export interface SplitInput { goal: string; files: string[]; open: { id: number; title: string }[] }
export interface SplitAnswer { intents: { title: string; goal: string; done_when: string[]; depends_on: number[] }[]; note: string }
export interface Proposed { title: string; goal: string; acceptance: string; dependsOn: number[] }

export const SPLIT_SYSTEM = `You turn one broad goal for a software project into intents that different coding agents can work on at the same time, for the people who own the project.
An intent is a goal one agent can finish and one person can check: a title, a goal of a sentence or two, and "done when" criteria, each a single thing that can be seen in the diff or checked by running the project.

- Split along lines that let agents work without editing the same lines: by part of the system, not by step. If the goal is already one piece of work, answer with one intent.
- Fewer is better. Do not invent work the goal does not ask for (no "add tests", "update docs" or "refactor" intents unless the goal says so; put testing in the criteria of the intent it belongs to).
- "depends_on" lists the numbers (1-based, in your own list) of intents that must land before this one can be done. Only earlier ones. Prefer intents that do not depend on each other.
- Write criteria a reviewer can judge from a diff: concrete and observable, not "works well".
- Use the file list to name real places, and do not propose what an open intent already covers.
"note" is one or two sentences on how you split it and anything the person should decide first.`;

export function splitPrompt(input: SplitInput): string {
	return [`# The goal\n${input.goal}`, `# Files in the repository (${input.files.length}${input.files.length >= 400 ? ", the first 400" : ""})\n${input.files.join("\n") || "(empty)"}`,
		`# Intents already open\n${input.open.length ? input.open.map((i) => `- I${i.id}: ${i.title}`).join("\n") : "(none)"}`].join("\n\n");
}

/** What is kept of a split: at most eight intents, each with a title and a goal; dependencies only on earlier ones, so they cannot circle. */
export function settleSplit(answer: SplitAnswer): { intents: Proposed[]; note: string } {
	const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);
	const kept = (answer.intents ?? []).filter((i) => clip(i.title, 10) && clip(i.goal, 10)).slice(0, 8);
	return {
		note: clip(answer.note, 600),
		intents: kept.map((i, n) => ({
			title: clip(i.title, 120), goal: clip(i.goal, 1000),
			acceptance: (i.done_when ?? []).map((c) => clip(c, 300)).filter(Boolean).slice(0, 10).map((c) => `- ${c}`).join("\n"),
			dependsOn: [...new Set((i.depends_on ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= n))],
		})),
	};
}
