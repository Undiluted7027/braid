// Model-backed reconciliation. The model is given what git never has: the goal of each
// side and the decisions behind the conflicting lines, and must keep both intents alive.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Conflict, Decision, Intent } from "../shared/types";
import { markedView } from "./gitops";
import { BraidError, type BraidEnv } from "./project";

// One replacement per conflict, not whole files: the answer stays small however large the file is,
// and the model cannot disturb lines that were never in conflict.
const Resolution = z.object({
	resolutions: z.array(z.object({ path: z.string(), regions: z.array(z.string()) })),
	rationale: z.string(),
});

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Which model will reconcile, or null when none is configured. */
const viaGateway = (env: BraidEnv) => !!(env.AI_GATEWAY_TOKEN && env.AI_GATEWAY_ID && env.AI_GATEWAY_ACCOUNT_ID);

export function llmName(env: BraidEnv): string | null {
	if (env.ANTHROPIC_API_KEY || viaGateway(env)) return env.BRAID_MODEL ?? "claude-opus-5-5";
	return env.AI ? WORKERS_AI_MODEL : null;
}

const SYSTEM = `You reconcile two concurrent code changes made by different agents for different intents.
A textual merge failed. For each conflicting file you are given the merged file with the conflicts marked in place, the intent each side was serving, and the decisions each agent recorded.
A conflict looks like this: "<<<<<<< trunk (conflict N)", trunk's lines, "||||||| base", the lines both started from, "=======", the attempt's lines, ">>>>>>> attempt". Everything outside those blocks is already merged from both sides; long unchanged stretches are left out and marked as such.
For every conflict, in order, give the lines that should replace the whole block so that BOTH intents are satisfied. Give only replacement lines: no markers, and none of the surrounding lines. An empty string removes the block.
Do not pick a side unless the decisions show one change makes the other unnecessary. Honor recorded decisions and constraints from both sides.
The rationale must say concretely how each intent survives in the merged result; it is recorded permanently in the landing commit.`;

const trail = (decisions: Decision[]) =>
	decisions.length ? decisions.map((d) => `- [${d.kind}] ${d.title}: ${d.body}${d.files.length ? ` (files: ${d.files.join(", ")})` : ""}`).join("\n") : "- (none recorded)";

function prompt(input: { intent: Intent; agent: string; decisions: Decision[]; conflicts: Conflict[] }) {
	const parts = [
		`## Attempt side: I${input.intent.id} "${input.intent.title}" by ${input.agent}`,
		`Goal: ${input.intent.goal}`,
		input.intent.acceptance ? `Acceptance: ${input.intent.acceptance}` : "",
		`Decisions:\n${trail(input.decisions)}`,
	];
	for (const c of input.conflicts.filter((c) => c.kind === "content")) {
		parts.push(`\n## Conflicting file: ${c.path}`);
		for (const w of c.trunkWhy) parts.push(`Trunk side: I${w.intentId} "${w.title}" by ${w.agent}\nGoal: ${w.goal}\nDecisions:\n${trail(w.decisions)}`);
		parts.push(`${c.regions.length} conflict${c.regions.length === 1 ? "" : "s"} in this file: answer with exactly ${c.regions.length} replacement${c.regions.length === 1 ? "" : "s"}.`,
			`<merged path="${c.path}">\n${markedView(c.base ?? "", c.trunk ?? "", c.attempt ?? "")}</merged>`);
	}
	return parts.filter(Boolean).join("\n\n");
}

export async function resolveConflicts(env: BraidEnv, input: { intent: Intent; agent: string; decisions: Decision[]; conflicts: Conflict[] }) {
	const model = llmName(env);
	if (!model) throw new BraidError("no model configured: set up AI Gateway, set ANTHROPIC_API_KEY, or bind Workers AI", 501);
	const user = prompt(input);

	if (env.ANTHROPIC_API_KEY || viaGateway(env)) {
		// Through AI Gateway the provider key lives in the gateway: send the gateway token and no key of our own.
		const client = viaGateway(env)
			? new Anthropic({
				apiKey: "held-by-the-gateway",
				baseURL: `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`,
				defaultHeaders: { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`, "x-api-key": null },
			})
			: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
		const response = await client.messages.parse({
			model,
			max_tokens: 16000,
			output_config: { effort: "high", format: zodOutputFormat(Resolution) },
			system: SYSTEM,
			messages: [{ role: "user", content: user }],
		});
		if (response.stop_reason === "refusal") throw new BraidError("the model declined to reconcile this conflict", 502);
		if (response.stop_reason === "max_tokens" || !response.parsed_output) throw new BraidError("the reconciliation did not fit in one response; resolve it from the agent or by hand", 502);
		return { ...response.parsed_output, model };
	}

	const out: any = await env.AI.run(WORKERS_AI_MODEL as any, {
		max_tokens: 8000,
		messages: [
			{ role: "system", content: `${SYSTEM}\nAnswer with only a JSON object: {"resolutions":[{"path":string,"regions":[string, ...]}],"rationale":string}` },
			{ role: "user", content: user },
		],
	} as any);
	const raw = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "");
	const parsed = Resolution.safeParse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) || "null"));
	if (!parsed.success) throw new BraidError("the model returned an unusable reconciliation; resolve it from the agent or by hand", 502);
	return { ...parsed.data, model };
}
