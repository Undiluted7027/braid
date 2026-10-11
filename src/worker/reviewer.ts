// The models that write a review. One call with a structured answer; see review.ts for what the reviewer is shown and what is kept.
// Two providers, so that an attempt can be read by a model from a different maker than the agent that wrote it.
import { z } from "zod";
import { BraidError, type BraidEnv } from "./project";
import { models, structured, type ModelPick, type Provider } from "./model";
import { prompt, SYSTEM, type ReviewAnswer, type ReviewInput } from "./review.ts";

const Answer = z.object({
	criteria: z.array(z.object({
		n: z.number(), verdict: z.enum(["met", "not_met", "unclear"]), basis: z.enum(["diff", "checks"]), why: z.string(),
		evidence: z.array(z.object({ path: z.string(), line: z.number().nullable() })),
	})),
	verdict: z.enum(["approve", "changes", "person"]),
	summary: z.string(), concerns: z.array(z.string()), changes: z.string(),
});
/** The same shape for a provider that wants a JSON Schema with every property required and nothing extra allowed. */
const ANSWER_SCHEMA = {
	type: "object", additionalProperties: false, required: ["criteria", "verdict", "summary", "concerns", "changes"],
	properties: {
		criteria: { type: "array", items: {
			type: "object", additionalProperties: false, required: ["n", "verdict", "basis", "why", "evidence"],
			properties: {
				n: { type: "integer" }, verdict: { type: "string", enum: ["met", "not_met", "unclear"] }, basis: { type: "string", enum: ["diff", "checks"] }, why: { type: "string" },
				evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "line"], properties: { path: { type: "string" }, line: { type: ["integer", "null"] } } } },
			},
		} },
		verdict: { type: "string", enum: ["approve", "changes", "person"] },
		summary: { type: "string" }, concerns: { type: "array", items: { type: "string" } }, changes: { type: "string" },
	},
};

export type { Provider };
export type Reviewer = ModelPick;
export const reviewers = models;

/**
 * Who reviews an attempt. A project can name a provider (trunk's braid.json: "reviewer": "claude" | "openai").
 * Otherwise it is a model from a different maker than the agent that wrote the attempt, where this instance has
 * one: a model is not asked to mark its own maker's work. Null when no model is configured.
 */
export function reviewerFor(env: BraidEnv, authorKind?: string, asked?: unknown): Reviewer | null {
	const all = reviewers(env), by = (p: Provider) => all.find((r) => r.provider === p);
	if (asked === "claude" || asked === "openai") return by(asked) ?? all[0] ?? null;
	const authors: Provider | null = authorKind === "claude" ? "claude" : authorKind === "codex" ? "openai" : null;
	return all.find((r) => r.provider !== authors) ?? all[0] ?? null;
}
/** Whether this instance can review at all, and with what by default. */
export const reviewerName = (env: BraidEnv): string | null => reviewerFor(env)?.model ?? null;

export async function reviewAttempt(env: BraidEnv, input: ReviewInput, pick?: Reviewer | null): Promise<ReviewAnswer & { model: string }> {
	const who = pick ?? reviewerFor(env);
	if (!who) throw new BraidError("no model configured to review with: set up AI Gateway, or set ANTHROPIC_API_KEY or OPENAI_API_KEY", 501);
	const answer = await structured<ReviewAnswer>(env, who, { system: SYSTEM, user: prompt(input), shape: Answer as any, schema: ANSWER_SCHEMA, name: "review", what: "review this attempt" });
	return { ...answer, model: who.model };
}
