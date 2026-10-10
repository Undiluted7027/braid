// The models that write a review. One call with a structured answer; see review.ts for what the reviewer is shown and what is kept.
// Two providers, so that an attempt can be read by a model from a different maker than the agent that wrote it.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BraidError, type BraidEnv } from "./project";
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

export type Provider = "claude" | "openai";
export interface Reviewer { provider: Provider; model: string }
const viaGateway = (env: BraidEnv) => !!(env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_ID && env.AI_GATEWAY_ACCOUNT_ID);
const gateway = (env: BraidEnv) => `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}`;

/**
 * The models this instance can review with. Only ones that can be held to a structured answer and read a
 * whole diff: the small Workers AI model that can stand in for reconciliation is not asked to judge work.
 */
export function reviewers(env: BraidEnv): Reviewer[] {
	return [
		...(env.ANTHROPIC_API_KEY || viaGateway(env) ? [{ provider: "claude" as const, model: env.BRAID_REVIEW_MODEL ?? env.BRAID_MODEL ?? "claude-opus-5-5" }] : []),
		...(env.OPENAI_API_KEY || viaGateway(env) ? [{ provider: "openai" as const, model: env.BRAID_REVIEW_OPENAI_MODEL ?? env.HOSTED_CODEX_MODEL ?? "gpt-6.1-sol" }] : []),
	];
}

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
	const user = prompt(input);
	return who.provider === "openai" ? { ...(await askOpenAI(env, who.model, user)), model: who.model } : { ...(await askClaude(env, who.model, user)), model: who.model };
}

async function askClaude(env: BraidEnv, model: string, user: string): Promise<ReviewAnswer> {
	// Through AI Gateway the provider key lives in the gateway: send the gateway token and no key of our own.
	const client = viaGateway(env)
		? new Anthropic({ apiKey: "held-by-the-gateway", baseURL: `${gateway(env)}/anthropic`, defaultHeaders: { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`, "x-api-key": null } })
		: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
	const response = await client.messages.parse({
		model, max_tokens: 8000,
		output_config: { effort: "high", format: zodOutputFormat(Answer) },
		system: SYSTEM,
		messages: [{ role: "user", content: user }],
	});
	if (response.stop_reason === "refusal") throw new BraidError("the model declined to review this attempt", 502);
	if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new BraidError("the review did not fit in one response", 502);
	return response.parsed_output;
}

async function askOpenAI(env: BraidEnv, model: string, user: string): Promise<ReviewAnswer> {
	const through = viaGateway(env);
	const res = await fetch(through ? `${gateway(env)}/openai/responses` : "https://api.openai.com/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json", ...(through ? { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` } : { authorization: `Bearer ${env.OPENAI_API_KEY}` }) },
		body: JSON.stringify({
			model, instructions: SYSTEM, input: user, max_output_tokens: 8000, store: false,
			text: { format: { type: "json_schema", name: "review", strict: true, schema: ANSWER_SCHEMA } },
		}),
	});
	const body: any = await res.json().catch(() => null);
	if (!res.ok) throw new BraidError(`the reviewing model answered ${res.status}${body?.error?.message ? `: ${String(body.error.message).slice(0, 300)}` : ""}`, 502);
	const parts: any[] = (body?.output ?? []).flatMap((item: any) => (item?.type === "message" ? item.content ?? [] : []));
	if (parts.some((p) => p?.type === "refusal")) throw new BraidError("the model declined to review this attempt", 502);
	if (body?.status === "incomplete") throw new BraidError("the review did not fit in one response", 502);
	let parsed;
	try { parsed = Answer.safeParse(JSON.parse(parts.filter((p) => p?.type === "output_text").map((p) => p.text).join(""))); } catch { parsed = null; }
	if (!parsed?.success) throw new BraidError("the model returned an unusable review", 502);
	return parsed.data;
}
