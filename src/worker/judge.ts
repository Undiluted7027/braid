// The models that compare attempts at one intent. One call each with a structured answer; see race.ts for what a
// judge is shown and what is kept. Every model this instance has is asked, so that with two makers no attempt is
// judged only by its own maker's model.
import { z } from "zod";
import { BraidError, type BraidEnv } from "./project";
import { models, structured, type ModelPick } from "./model";
import { JUDGE_SYSTEM, judgePrompt, letter, type JudgeAnswer, type JudgeInput } from "./race.ts";

const Answer = z.object({
	pick: z.string(), ranking: z.array(z.string()), why: z.string(), differences: z.string(),
	attempts: z.array(z.object({ letter: z.string(), strengths: z.string(), weaknesses: z.string(), keep: z.string() })),
});
const ANSWER_SCHEMA = {
	type: "object", additionalProperties: false, required: ["pick", "ranking", "why", "differences", "attempts"],
	properties: {
		pick: { type: "string" }, ranking: { type: "array", items: { type: "string" } }, why: { type: "string" }, differences: { type: "string" },
		attempts: { type: "array", items: { type: "object", additionalProperties: false, required: ["letter", "strengths", "weaknesses", "keep"],
			properties: { letter: { type: "string" }, strengths: { type: "string" }, weaknesses: { type: "string" }, keep: { type: "string" } } } },
	},
};

export const judges = (env: BraidEnv): ModelPick[] => models(env);

/** `turn` rotates the order the attempts are shown in, so that two judges do not both read the same one first. */
export async function judgeRace(env: BraidEnv, input: JudgeInput, who: ModelPick, turn = 0): Promise<JudgeAnswer & { model: string }> {
	if (input.entrants.length < 2) throw new BraidError("a comparison needs at least two attempts");
	const n = input.entrants.length, order = input.entrants.map((_, i) => (i + turn) % n);
	const images = order.flatMap((i) => (input.entrants[i].shot ? [{ label: `Picture ${letter(i)}`, ...input.entrants[i].shot! }] : []));
	const answer = await structured<JudgeAnswer>(env, who, { system: JUDGE_SYSTEM, user: judgePrompt(input, order), images, shape: Answer as any, schema: ANSWER_SCHEMA, name: "comparison", what: "compare these attempts" });
	return { ...answer, model: who.model };
}
