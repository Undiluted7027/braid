// The model that plans. See plan.ts for what it is shown and what is kept.
import { z } from "zod";
import { BraidError, type BraidEnv } from "./project";
import { models, structured, type ModelPick } from "./model";
import { PLAN_SYSTEM, planPrompt, SPLIT_SYSTEM, splitPrompt, type PlanAnswer, type PlanInput, type SplitAnswer, type SplitInput } from "./plan.ts";

const Relations = z.object({ relations: z.array(z.object({
	other: z.number(), kind: z.enum(["contradicts", "depends_on", "duplicates"]), why: z.string(), mine: z.array(z.number()), theirs: z.array(z.number()),
})) });
const RELATIONS_SCHEMA = { type: "object", additionalProperties: false, required: ["relations"], properties: { relations: { type: "array", items: {
	type: "object", additionalProperties: false, required: ["other", "kind", "why", "mine", "theirs"],
	properties: { other: { type: "integer" }, kind: { type: "string", enum: ["contradicts", "depends_on", "duplicates"] }, why: { type: "string" }, mine: { type: "array", items: { type: "integer" } }, theirs: { type: "array", items: { type: "integer" } } },
} } } };
const Split = z.object({ intents: z.array(z.object({ title: z.string(), goal: z.string(), done_when: z.array(z.string()), depends_on: z.array(z.number()) })), note: z.string() });
const SPLIT_SCHEMA = { type: "object", additionalProperties: false, required: ["intents", "note"], properties: {
	intents: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "goal", "done_when", "depends_on"],
		properties: { title: { type: "string" }, goal: { type: "string" }, done_when: { type: "array", items: { type: "string" } }, depends_on: { type: "array", items: { type: "integer" } } } } },
	note: { type: "string" },
} };

/** The model that plans, or null when none is configured. */
export const plannerFor = (env: BraidEnv): ModelPick | null => models(env)[0] ?? null;
const need = (env: BraidEnv) => { const who = plannerFor(env); if (!who) throw new BraidError("no model configured to plan with: set up AI Gateway, or set ANTHROPIC_API_KEY or OPENAI_API_KEY", 501); return who; };

export async function planIntent(env: BraidEnv, input: PlanInput): Promise<PlanAnswer & { model: string }> {
	const who = need(env);
	return { ...(await structured<PlanAnswer>(env, who, { system: PLAN_SYSTEM, user: planPrompt(input), shape: Relations as any, schema: RELATIONS_SCHEMA, name: "relations", what: "plan this intent", maxTokens: 4000 })), model: who.model };
}
export async function splitGoal(env: BraidEnv, input: SplitInput): Promise<SplitAnswer & { model: string }> {
	const who = need(env);
	return { ...(await structured<SplitAnswer>(env, who, { system: SPLIT_SYSTEM, user: splitPrompt(input), shape: Split as any, schema: SPLIT_SCHEMA, name: "intents", what: "split this goal" })), model: who.model };
}
