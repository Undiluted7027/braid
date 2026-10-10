// Landing, reverting, reconciling with a model and starting an agent are written down by the server and done
// afterwards. The answer to the request says only "asked"; how it turned out arrives in the project state
// (`queue`, `outcomes`, `stuck`, and the attempt or reconciliation itself). These helpers read that.
import { useEffect, useState } from "react";
import type { Attempt, Outcome, State } from "../shared/types";

const LIVE = new Set(["working", "ready", "conflicted"]);
// An instance that has not been restarted since these fields were added leaves them out.
export const outcomesOf = (state: State): Outcome[] => state.outcomes ?? [];
export const stuckOf = (state: State): State["stuck"] => state.stuck ?? [];

/**
 * The gap between "the server said it wrote the request down" and "the state shows it". Call `mark()` when
 * the request has answered. `pending` is then true until `seen` is true or `token` differs from what it was
 * at the mark (pass the id of the newest outcome of that kind, so a result of either sort ends the wait
 * without comparing this browser's clock to the server's). It also ends after `limit`, so a result that
 * never arrives does not leave the page saying "asked" for ever.
 */
export function useAsked(seen: boolean, token: unknown = null, limit = 30_000) {
	const [asked, setAsked] = useState<{ token: unknown } | null>(null);
	const done = !!asked && (seen || asked.token !== token);
	useEffect(() => { if (done) setAsked(null); }, [done]);
	useEffect(() => {
		if (!asked) return;
		const t = window.setTimeout(() => setAsked(null), limit);
		return () => window.clearTimeout(t);
	}, [asked, limit]);
	return { pending: !!asked && !done, mark: () => setAsked({ token }) };
}

/** A server sentence, made to stand on its own: capital first, full stop last. */
export const sentence = (text: string) => {
	const t = text.trim().replace(/[.;,]+$/, "");
	return t ? `${t[0].toUpperCase()}${t.slice(1)}.` : "";
};
/** Whether a refusal is one the person may overrule ("…land it anyway with force"). */
export const forceable = (text: string) => /with force\.?$/i.test(text.trim());
/** The refusal without the instruction to force it, which the page offers as a button instead. */
export const reason = (text: string) => sentence(text.trim().replace(/[.;,]?\s*(?:run the verification again, or )?land it anyway with force\.?$/i, ""));

/**
 * How the last landing asked for this attempt turned out, when that still says something about the attempt
 * as it is now: it was refused or cancelled, nothing newer has been asked, and the attempt has not moved since.
 * A landing that conflicted is not returned: it shows as the reconciliation it opened.
 */
export function landingVerdict(state: State, a: Attempt): Outcome | null {
	if (!LIVE.has(a.status) || state.queue.some((q) => q.attemptId === a.id)) return null;
	const last = outcomesOf(state).find((o) => o.kind === "landing" && o.attemptId === a.id);
	if (!last || (last.outcome !== "refused" && last.outcome !== "cancelled")) return null;
	// The verdict names the commit it was about. Once the attempt has another head, it is about an earlier one.
	return last.sha && last.sha !== a.headSha ? null : last;
}

/** The last word on taking a landing back out, while that landing is still on trunk. */
export const revertVerdict = (state: State, landingSha: string) => {
	const last = outcomesOf(state).find((o) => o.kind === "revert" && o.ref === landingSha);
	return last?.outcome === "refused" ? last : null;
};
/** Why the model's last try at a reconciliation failed, if it did. */
export const modelVerdict = (state: State, reconId: number) => {
	const last = outcomesOf(state).find((o) => o.kind === "reconcile" && o.ref === `R${reconId}`);
	return last?.outcome === "failed" ? last : null;
};
/** "could not start: <why>" on an agent Braid never got running, as the why alone. */
export const neverStarted = (a: Attempt) => (a.hosted === "failed" && /^could not start/i.test(a.hostedDetail ?? "") ? sentence((a.hostedDetail ?? "").replace(/^could not start:?\s*/i, "")) || "No reason was given." : null);

/** Work Braid gave up on, in a person's words: what it could not do, and what that means for them. */
export function stuckWords(type: string, attemptId: string | null): { what: string; means: string } {
	const on = attemptId ? ` for attempt ${attemptId}` : "";
	switch (type) {
		case "context.save": return { what: `Braid could not copy a landing's reasons to the context repository${on}.`, means: "The landing itself is on trunk. Its decisions and session transcript are not in the context repository yet." };
		case "run.start": return { what: `Braid could not start the checks${on}.`, means: "That commit stays unverified, and an unverified attempt does not land by itself." };
		case "attempt.observe": return { what: `Braid could not read ${attemptId ? `attempt ${attemptId}'s` : "an attempt's"} repository after a push.`, means: "What is shown for that attempt (its commit, files and overlaps) may be out of date." };
		case "trunk.observe": return { what: "Braid could not read trunk.", means: "Commits pushed to trunk outside Braid may be missing here, and attempts may look less far behind than they are." };
		case "queue.advance": return { what: "Braid could not move the landing queue.", means: "Landings that have been asked for are waiting and will not go through until this works." };
		case "landing.revert": return { what: `Braid could not take a landing back out of trunk${on}.`, means: "The landing is still on trunk and its intent is still closed." };
		case "fork.spare": return { what: "Braid could not prepare a spare fork of trunk.", means: "Nothing is lost. The next attempt will take longer to start." };
		case "repo.remove": return { what: "Braid could not remove a repository that is no longer needed.", means: "Nothing is broken. The unused repository still exists on Artifacts." };
		case "agent.start": return { what: `Braid could not start the agent${on}.`, means: "Nobody is working on that attempt." };
		case "agent.stop": return { what: `Braid could not stop the agent${on}.`, means: "It may still be running in its sandbox." };
		case "model.reconcile": return { what: `Braid could not ask the model to reconcile${on}.`, means: "The conflict is still open. It can be resolved by hand, or by the attempt's agent." };
		default: return { what: `Braid could not finish a piece of background work (${type})${on}.`, means: "Something this project expects may not have happened." };
	}
}
