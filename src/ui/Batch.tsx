// Landings are verified in batches: the ones that are ready are merged one on top of the other and checked
// with one run of the last merge. This file says that in words and draws it, wherever a queued landing is shown.
import type { Batch, QueuedLanding, Run, State } from "../shared/types";
import { short } from "./api";
import { IntentId, Link } from "./App";
import { Icon } from "./Kit";
import { sentence } from "./Later";

const names = (ids: string[]) => (ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`);
const RUN: Record<Run["status"], string> = { queued: "queued", running: "running", pass: "passed", fail: "failed", error: "could not run", superseded: "superseded" };
const tone = (s?: Run["status"]) => (s === "pass" ? "pass" : s === "fail" || s === "error" ? "conflict" : "working");

/** The batch an attempt's landing is in, where it stands in it, and the runs that decide it. */
export function batchFor(state: State, attemptId: string) {
	const batch = (state.batches ?? []).find((b) => b.members.includes(attemptId));
	if (!batch) return null;
	return { batch, place: batch.members.indexOf(attemptId) + 1, run: batchRun(state, batch), step: stepRun(state, batch, attemptId) };
}
/** The one run of a batch's last merge. */
export const batchRun = (state: State, b: Batch) => state.runs.find((r) => r.ref === `batch:${b.id}` && r.sha === b.tipSha) ?? null;
/** Once a failed batch is taken apart, the run of one member's own merge (trunk, the landings ahead of it, and it). */
export function stepRun(state: State, b: Batch, attemptId: string) {
	const c = state.candidates.find((x) => x.attemptId === attemptId && x.runRef.startsWith(`batch:${b.id}:`));
	return c ? state.runs.find((r) => r.ref === c.runRef && r.sha === c.runSha) ?? null : null;
}

/** What a queued landing is doing, as a short tag. */
export function queueLabel(state: State, q: QueuedLanding) {
	const b = q.batch === null ? null : (state.batches ?? []).find((x) => x.id === q.batch);
	if (b?.state === "splitting") return "finding what broke the batch";
	if (q.state === "verifying") return b && b.members.length > 1 ? `checking ${b.members.length} landings together` : "checking the merge with trunk";
	return q.state === "locking" ? "regenerating the lockfile" : q.state === "pushing" ? "landing now" : "waiting to land";
}

/** What is happening to a batch, in a sentence or two. `me` words it for someone looking at one of its attempts. */
export function batchWords(state: State, b: Batch, me?: string): string {
	const n = b.members.length, trunk = short(b.trunkSha), others = b.members.filter((m) => m !== me);
	if (b.state === "pushing") return n > 1 ? `The run passed. The ${n} landings are going onto trunk now, in this order.` : "The run passed. It is going onto trunk now.";
	if (b.state === "splitting") {
		const own = me ? stepRun(state, b, me) : null;
		const mine = !me ? "" : own?.status === "pass" ? ` Attempt ${me}'s own step passed, so it is not the one that broke it.`
			: own?.status === "fail" || own?.status === "error" ? ` Attempt ${me}'s own step failed too, so the failure is at or before it.`
			: ` Whether attempt ${me} is the cause is not known yet.`;
		return `These ${n} landings failed when checked together. Each one is now being run on its own step (trunk, the landings ahead of it, and it) to find which one breaks it. The ones before the first failure land, that one is refused with the failing checks, and the ones after it go back to waiting.${mine}`;
	}
	if (n === 1) return `It is merged with trunk at ${trunk} and that merge is being checked. It lands if the run passes.`;
	return me
		? `It is being checked together with attempt${others.length === 1 ? "" : "s"} ${names(others)}: the ${n} landings are merged in this order on top of trunk at ${trunk}, and the last merge is run once. If that run passes, all ${n} land. If it fails, each is run on its own to find which one breaks it, so a failure of this run is not yet a failure of this attempt.`
		: `${n} landings are merged in this order on top of trunk at ${trunk}, and the last merge is run once. If that run passes, all ${n} land. If it fails, each is run on its own to find which one breaks it.`;
}

/** The batch drawn as what it is: trunk, then each landing merged on top of the one before. */
export function BatchChain({ state, batch, me }: { state: State; batch: Batch; me?: string }) {
	const slug = state.project.slug, run = batchRun(state, batch);
	return (
		<div className="batch">
			<ol className="batch-chain" aria-label={`Batch of ${batch.members.length}, in landing order`}>
				<li className="batch-trunk"><span className="label">trunk</span><span className="mono">{short(batch.trunkSha)}</span></li>
				{batch.members.map((id, i) => {
					const a = state.attempts.find((x) => x.id === id);
					const step = batch.state === "splitting" ? stepRun(state, batch, id) : null;
					const inner = <>
						<span className="batch-n">{i + 1}</span>
						{a && <IntentId id={a.intentId} />}
						<span className="batch-id">attempt <span className="mono">{id}</span>{a ? <span className="dim"> · {a.agent}</span> : null}</span>
						{id === me && <span className="batch-me">this one</span>}
						{batch.state === "splitting" && <span className={`chip ${tone(step?.status)}`}>{step ? `own step ${RUN[step.status]}` : "own step queued"}</span>}
					</>;
					return (
						<li key={id} className={`batch-member ${id === me ? "me" : ""}`}>
							<Icon name="plus" size={12} className="batch-plus" />
							{a && id !== me ? <Link to={`/p/${slug}/i/${a.intentId}?attempt=${encodeURIComponent(id)}`} className="batch-box">{inner}</Link> : <span className="batch-box">{inner}</span>}
						</li>
					);
				})}
				<li className="batch-run">
					<Icon name="arrow" size={14} />
					<span className={`chip ${batch.state === "pushing" ? "pass" : batch.state === "splitting" ? "conflict" : tone(run?.status)}`}>
						{batch.state === "pushing" ? "passed, landing" : batch.state === "splitting" ? "failed together" : batch.members.length > 1 ? `one run: ${run ? RUN[run.status] : "queued"}` : `run ${run ? RUN[run.status] : "queued"}`}
					</span>
				</li>
			</ol>
			<p className="batch-words">{batchWords(state, batch, me)}</p>
		</div>
	);
}

/** The project page's view of the queue: what is being checked now, and what waits behind it and why. Absent when nothing has been asked to land. */
export function LandingQueue({ state }: { state: State }) {
	if (!state.queue.length) return null;
	const slug = state.project.slug, batches = state.batches ?? [];
	const waiting = state.queue.filter((q) => q.batch === null || !batches.some((b) => b.id === q.batch));
	return (
		<section className="panel queue" aria-labelledby="queue-h">
			<h2 id="queue-h" className="label"><Icon name="land" size={14} />Landing queue<span className="count">{state.queue.length}</span></h2>
			{batches.map((b) => <BatchChain key={b.id} state={state} batch={b} />)}
			{waiting.length > 0 && (
				<ul className="queue-waiting">
					{waiting.map((q) => {
						const a = state.attempts.find((x) => x.id === q.attemptId);
						return (
							<li key={q.attemptId}>
								<span className="chip quiet">{queueLabel(state, q)}</span>
								<span className="queue-who">{a && <IntentId id={a.intentId} />}{a ? <Link to={`/p/${slug}/i/${a.intentId}?attempt=${encodeURIComponent(a.id)}`}>attempt <span className="mono">{q.attemptId}</span></Link> : <span>attempt <span className="mono">{q.attemptId}</span></span>}{a && <span className="dim">· {a.agent}</span>}</span>
								<span className="queue-note">{q.note ? sentence(q.note) : "It is next to be merged with trunk."}</span>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
