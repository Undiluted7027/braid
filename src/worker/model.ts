// Asking a model for a structured answer. Two providers, both through AI Gateway when it is set up
// (the provider keys then live in the gateway) or with their own keys. Used by the reviewer and the planner.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { BraidError, type BraidEnv } from "./project";

export type Provider = "claude" | "openai";
export interface ModelPick { provider: Provider; model: string }
const viaGateway = (env: BraidEnv) => !!(env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_ID && env.AI_GATEWAY_ACCOUNT_ID);
const gateway = (env: BraidEnv) => `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}`;

/**
 * The models this instance can ask to judge or plan. Only ones that can be held to a structured answer and read a
 * long prompt: the small Workers AI model that can stand in for reconciliation is not among them.
 */
export function models(env: BraidEnv): ModelPick[] {
	return [
		...(env.ANTHROPIC_API_KEY || viaGateway(env) ? [{ provider: "claude" as const, model: env.BRAID_REVIEW_MODEL ?? env.BRAID_MODEL ?? "claude-opus-5-5" }] : []),
		...(env.OPENAI_API_KEY || viaGateway(env) ? [{ provider: "openai" as const, model: env.BRAID_REVIEW_OPENAI_MODEL ?? env.HOSTED_CODEX_MODEL ?? "gpt-6.1-sol" }] : []),
	];
}

/**
 * One call, one answer in the given shape. `schema` is the same shape as `shape` written as a JSON Schema with every
 * property required and nothing extra allowed, for the provider that wants that. `what` names the task in error messages.
 */
export async function structured<T>(env: BraidEnv, who: ModelPick, ask: { system: string; user: string; shape: z.ZodType<T>; schema: object; name: string; what: string; maxTokens?: number }): Promise<T> {
	const max = ask.maxTokens ?? 8000;
	if (who.provider === "claude") {
		// Through AI Gateway the provider key lives in the gateway: send the gateway token and no key of our own.
		const client = viaGateway(env)
			? new Anthropic({ apiKey: "held-by-the-gateway", baseURL: `${gateway(env)}/anthropic`, defaultHeaders: { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`, "x-api-key": null } })
			: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
		const response = await client.messages.parse({
			model: who.model, max_tokens: max,
			output_config: { effort: "high", format: zodOutputFormat(ask.shape as any) },
			system: ask.system,
			messages: [{ role: "user", content: ask.user }],
		});
		if (response.stop_reason === "refusal") throw new BraidError(`the model declined to ${ask.what}`, 502);
		if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new BraidError(`the model's answer did not fit in one response (${ask.what})`, 502);
		return response.parsed_output as T;
	}
	const through = viaGateway(env);
	const res = await fetch(through ? `${gateway(env)}/openai/responses` : "https://api.openai.com/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json", ...(through ? { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` } : { authorization: `Bearer ${env.OPENAI_API_KEY}` }) },
		body: JSON.stringify({
			model: who.model, instructions: ask.system, input: ask.user, max_output_tokens: max, store: false,
			text: { format: { type: "json_schema", name: ask.name, strict: true, schema: ask.schema } },
		}),
	});
	const body: any = await res.json().catch(() => null);
	if (!res.ok) throw new BraidError(`the model answered ${res.status}${body?.error?.message ? `: ${String(body.error.message).slice(0, 300)}` : ""}`, 502);
	const parts: any[] = (body?.output ?? []).flatMap((item: any) => (item?.type === "message" ? item.content ?? [] : []));
	if (parts.some((p) => p?.type === "refusal")) throw new BraidError(`the model declined to ${ask.what}`, 502);
	if (body?.status === "incomplete") throw new BraidError(`the model's answer did not fit in one response (${ask.what})`, 502);
	let parsed;
	try { parsed = ask.shape.safeParse(JSON.parse(parts.filter((p) => p?.type === "output_text").map((p) => p.text).join(""))); } catch { parsed = null; }
	if (!parsed?.success) throw new BraidError(`the model returned an answer that could not be used (${ask.what})`, 502);
	return parsed.data;
}
