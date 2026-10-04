// Model-backed reconciliation. The model is given what git never has: the goal of each
// side and the decisions behind the conflicting lines, and must keep both intents alive.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Conflict, Decision, Intent } from "../shared/types";
import { BraidError, type BraidEnv } from "./project";

const Resolution = z.object({
	resolutions: z.array(z.object({ path: z.string(), content: z.string() })),
	rationale: z.string(),
});

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Which model will reconcile, or null when none is configured. */
export function llmName(env: BraidEnv): string | null {
	if (env.ANTHROPIC_API_KEY) return env.BRAID_MODEL ?? "claude-opus-5-5";
	return env.AI ? WORKERS_AI_MODEL : null;
}

const SYSTEM = `You reconcile two concurrent code changes made by different agents for different intents.
A textual merge failed. You are given, for each conflicting file: the common base, the version on trunk, the version in the attempt, the intent each side was serving, and the decisions each agent recorded.
Produce the full final content of every conflicting file such that BOTH intents are satisfied. Do not pick a side unless the decisions show one change makes the other unnecessary.
Honor recorded decisions and constraints from both sides. Keep everything unrelated to the conflict exactly as it is. No conflict markers.
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
	for (const c of input.conflicts) {
		parts.push(`\n## Conflicting file: ${c.path}`);
		for (const w of c.trunkWhy) parts.push(`Trunk side: I${w.intentId} "${w.title}" by ${w.agent}\nGoal: ${w.goal}\nDecisions:\n${trail(w.decisions)}`);
		parts.push(`<base>\n${c.base ?? ""}</base>`, `<trunk>\n${c.trunk ?? ""}</trunk>`, `<attempt>\n${c.attempt ?? ""}</attempt>`);
	}
	return parts.filter(Boolean).join("\n\n");
}

export async function resolveConflicts(env: BraidEnv, input: { intent: Intent; agent: string; decisions: Decision[]; conflicts: Conflict[] }) {
	const model = llmName(env);
	if (!model) throw new BraidError("no model configured: set ANTHROPIC_API_KEY (wrangler secret put ANTHROPIC_API_KEY) or bind Workers AI", 501);
	const user = prompt(input);

	if (env.ANTHROPIC_API_KEY) {
		const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
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
			{ role: "system", content: `${SYSTEM}\nAnswer with only a JSON object: {"resolutions":[{"path":string,"content":string}],"rationale":string}` },
			{ role: "user", content: user },
		],
	} as any);
	const raw = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "");
	const parsed = Resolution.safeParse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) || "null"));
	if (!parsed.success) throw new BraidError("the model returned an unusable reconciliation; resolve it from the agent or by hand", 502);
	return { ...parsed.data, model };
}
