// Braid's first reading of an attempt: a reviewer's verdict on each of the intent's criteria, Braid's own flags,
// and (when the project lands by itself) why an attempt has not been landed. A person reads this first and the diff second.
import type { ReactNode } from "react";
import type { Attempt, CriterionVerdict, Flag, Intent, Review, State } from "../shared/types";
import { api, ago, short } from "./api";
import { Agent, useAction } from "./App";
import { ask, Icon, Notice, type IconName } from "./Kit";
import { sentence, useAsked } from "./Later";
import { clashingCriteria } from "./Plan";
import { likelihoodOf, LikelyBar, LOW_SUPPORT } from "./Race";
import { runFor } from "./Verify";

const LIVE = new Set(["working", "ready", "conflicted"]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// An instance that has not been restarted since these fields were added leaves them out.
export const flagsOf = (a: Attempt): Flag[] => a.flags ?? [];
export const reviewOf = (state: State, a: Attempt): Review | null => (state.reviews ?? []).find((r) => r.attemptId === a.id) ?? null;
export const policyOf = (state: State) => state.project.policy ?? { landing: "person" as const, review: false, conflicts: "person" as const };
/** A finished review of the commit the attempt is at now: the only kind that says something about what would land. */
export const currentReview = (state: State, a: Attempt) => { const r = reviewOf(state, a); return r && r.status === "done" && r.sha === a.headSha ? r : null; };
export const tally = (r: Review) => ({ met: r.criteria.filter((c) => c.verdict === "met").length, of: r.criteria.length });

const MARK: Record<CriterionVerdict["verdict"], { word: string; icon: IconName; tone: string }> = {
	met: { word: "Met", icon: "check", tone: "good" },
	not_met: { word: "Not met", icon: "x", tone: "bad" },
	unclear: { word: "Not shown", icon: "question", tone: "warn" },
};
const VERDICT: Record<NonNullable<Review["verdict"]>, { chip: string; tone: string; says: string }> = {
	approve: { chip: "review passed", tone: "pass", says: "Every criterion is met, and the reviewer found nothing a person needs to weigh." },
	changes: { chip: "changes asked", tone: "touch", says: "The reviewer asks for something specific to change before this lands." },
	person: { chip: "your call", tone: "touch", says: "The reviewer leaves this one to a person." },
};
const FLAG: Record<Flag["kind"], string> = {
	"tests-deleted": "Tests were deleted",
	"tests-changed": "Existing tests were changed",
	checks: "The checks themselves were changed",
	lockfile: "The lockfile changed on its own",
	"outside-claims": "It changed files it did not say it would",
	history: "It rewrote its own history",
	destructive: "It ran something destructive",
};

/** The review in a few words, for a list: its verdict, or why there is none to go on. */
export function reviewTag(state: State, a: Attempt): { text: string; tone: string; title: string } | null {
	const r = reviewOf(state, a);
	if (!r) return null;
	if (r.status === "running") return { text: "being reviewed", tone: "working", title: `${r.by || "The reviewer"} is reading commit ${short(r.sha)}` };
	if (r.status === "failed") return { text: "review failed", tone: "conflict", title: r.error ?? "The review could not be made" };
	if (r.sha !== a.headSha) return { text: "review out of date", tone: "quiet", title: `The review is of ${short(r.sha)}; the attempt is now at ${short(a.headSha)}` };
	const t = tally(r), v = VERDICT[r.verdict ?? "person"];
	return { text: `${v.chip} · ${t.met}/${t.of}`, tone: v.tone, title: `${t.met} of ${plural(t.of, "criterion", "criteria")} met. ${r.summary}` };
}

/** What Braid itself found that a person should look at. It sits apart from the review: these are facts about the diff and the session, and no reviewer can waive them. */
export function FlagBox({ a }: { a: Attempt }) {
	const flags = flagsOf(a);
	if (!flags.length) return null;
	return (
		<section className="flags" aria-label={`${plural(flags.length, "flag")} raised by Braid`}>
			<h3><Icon name="warning" />{flags.length === 1 ? "Braid flagged one thing for a person" : `Braid flagged ${flags.length} things for a person`}</h3>
			<ul>
				{flags.map((f, i) => (
					<li key={i}>
						<strong>{FLAG[f.kind] ?? "Flagged"}.</strong> {sentence(f.text)}
						{f.paths.length > 0 && <span className="flag-paths">{f.paths.slice(0, 6).map((p) => <span key={p} className="mono"><Icon name="file" size={12} />{p}</span>)}{f.paths.length > 6 && <span className="dim">and {f.paths.length - 6} more</span>}</span>}
					</li>
				))}
			</ul>
			<p className="hint">Found by Braid in the diff and the session, without a model. They are not the reviewer's opinion and no review can set them aside: a person has to look.</p>
		</section>
	);
}

/** Under a project that lands by itself: why this attempt has not been landed. */
export function Held({ state, a }: { state: State; a: Attempt }) {
	if (policyOf(state).landing !== "auto" || !a.held || !LIVE.has(a.status)) return null;
	const waiting = a.heldFor === "checks" || a.heldFor === "review" || a.heldFor === "dependency" || a.heldFor === "race";
	return (
		<p className={`held ${waiting ? "waiting" : "person"}`} role="status">
			<Icon name={waiting ? "clock" : "agent"} />
			<span><strong>{waiting ? "Braid lands this by itself once it is plainly good." : "Braid has not landed this by itself."}</strong> {sentence(a.held)}{!waiting && " It is waiting for a person."}</span>
		</p>
	);
}

function Evidence({ c, onCite, toChecks }: { c: CriterionVerdict; onCite?: (path: string, line: number | null) => void; toChecks?: () => void }) {
	if (c.basis === "checks") return <p className="crit-basis"><Icon name="check" size={12} />Judged from the project's checks having passed, not from particular lines.{toChecks && <> <button className="link" onClick={toChecks}>See the checks</button></>}</p>;
	if (!c.evidence.length) return <p className="crit-basis"><Icon name="changes" size={12} />Judged from the diff; the reviewer pointed at no particular lines.</p>;
	// The decision model also reads each citation. A low number is a reason to look, not a finding: it is noisy line by line.
	const doubted = c.evidence.filter((e) => typeof e.support === "number" && e.support < LOW_SUPPORT);
	const at = (e: CriterionVerdict["evidence"][number]) => `${e.path}${e.line ? `:${e.line}` : ""}`;
	return (
		<>
			<p className="crit-basis"><Icon name="changes" size={12} />Judged from the diff:
				{c.evidence.map((e, i) => {
					const low = typeof e.support === "number" && e.support < LOW_SUPPORT;
					const inner = <>{at(e)}{low && <span className="cite-doubt" aria-label="worth a look">?</span>}</>;
					return onCite
						? <button key={i} className={`cite mono ${low ? "doubt" : ""}`} onClick={() => onCite(e.path, e.line)} title={low ? "Worth a look: the decision model did not read this line as showing the criterion. Show it in the changes" : "Show these lines in the changes"}>{inner}</button>
						: <span key={i} className={`cite mono ${low ? "doubt" : ""}`}>{inner}</span>;
				})}
			</p>
			{doubted.length > 0 && <p className="crit-doubt"><span className="cite-doubt" aria-hidden="true">?</span>Worth a look: the decision model did not read {doubted.map(at).join(", ")} as showing this criterion ({doubted.map((e) => `${Math.round(e.support! * 100)}%`).join(", ")}). It judges one line at a time and is often wrong that way, so this marks the citation for you; it does not change the reviewer's verdict.</p>}
		</>
	);
}

/** The review of one attempt, in full. `onCite` takes the reader to cited lines in the changes; `toChecks` to the checks. */
export function ReviewPanel({ state, a, intent, onCite, toChecks }: { state: State; a: Attempt; intent: Intent; onCite: (path: string, line: number | null) => void; toChecks: () => void }) {
	const slug = state.project.slug, r = reviewOf(state, a), policy = policyOf(state), model = (policy.reviewers ?? []).join(" or ");
	const act = useAction();
	// Asking for a review only writes it down; it then shows as "running".
	const asked = useAsked(r?.status === "running", r?.id, 45_000);
	const going = LIVE.has(a.status), pushed = a.headSha !== a.baseSha;
	const canAsk = !state.viewer && going && pushed && !!model;
	const again = (label: string) => canAsk && (
		<button disabled={act.busy || asked.pending} onClick={() => act.run(async () => { await api("POST", `/p/${slug}/attempts/${a.id}/review`, {}); asked.mark(); })}>
			<Icon name={asked.pending ? "running" : "undo"} className={asked.pending ? "spin" : ""} />{act.busy ? "Asking…" : asked.pending ? "Review asked for…" : label}
		</button>
	);
	const criteria = intent.criteria ?? [];
	const signal = likelihoodOf(state, a);
	const list = (verdicts: CriterionVerdict[] | null) => (
		<ol className="criteria">
			{(verdicts ?? criteria.map((text) => ({ text, verdict: null, basis: "diff" as const, why: "", evidence: [] }))).map((c, i) => {
				const m = c.verdict ? MARK[c.verdict] : null;
				return (
					<li key={i} className={m?.tone ?? "none"}>
						<span className="crit-mark">{m ? <><Icon name={m.icon} size={14} />{m.word}</> : <span className="dim">Not judged</span>}</span>
						<div className="crit-body">
							<p className="crit-text"><span className="crit-n">{i + 1}</span>{c.text}</p>
							{c.why && <p className="crit-why">{c.why}</p>}
							{signal?.criteria[i] && <p className="crit-signal"><span>Decision model, a second reading:</span><LikelyBar p={signal.criteria[i].p} stale={signal.sha !== a.headSha} /><span>likely met</span></p>}
							{c.verdict && <Evidence c={c as CriterionVerdict} onCite={onCite} toChecks={toChecks} />}
						</div>
					</li>
				);
			})}
		</ol>
	);

	if (!r) {
		const run = runFor(state, a.id);
		const why: ReactNode = !pushed ? "Nothing has been pushed, so there is nothing to review."
			: !going ? "This attempt was not reviewed."
			: !model ? "No model is set up on this instance, so attempts are not reviewed. A person reads them against the criteria below."
			: !policy.review ? "Reviews are turned off for this project. A person reads each attempt against the criteria below."
			: a.status === "working" ? "A review is made when the agent marks the attempt ready."
			: !run || run.sha !== a.headSha || run.status === "queued" || run.status === "running" ? "It will be reviewed as soon as this commit's checks have finished."
			: run.status !== "pass" ? "Its checks did not pass, so it has not been reviewed."
			: "It has not been reviewed yet.";
		return (
			<div className="review none">
				<div className="review-head"><p><strong>No review yet.</strong> {why}</p>{policy.review && again("Review this commit now")}</div>
				{act.error && <Notice small>{act.error}</Notice>}
				{criteria.length > 0 && <><h3>What it will be judged by</h3>{list(null)}</>}
			</div>
		);
	}
	const stale = r.sha !== a.headSha, v = r.verdict ? VERDICT[r.verdict] : null, t = tally(r);
	const flags = flagsOf(a).length;
	return (
		<div className={`review ${r.status} ${stale ? "stale" : ""}`}>
			{r.status === "running" && (
				<div className="review-head">
					<p role="status"><Icon name="running" className="spin" /><strong>Being reviewed.</strong> {r.by || "The reviewer"} is reading commit <span className="mono">{short(r.sha)}</span> against {plural(criteria.length, "criterion", "criteria")}. Started {ago(r.at)}.</p>
				</div>
			)}
			{r.status === "failed" && <>
				<Notice><strong>This commit could not be reviewed.</strong> {sentence(r.error ?? "No reason was recorded")} Nothing below is a judgement of it.</Notice>
				<div className="review-head"><p className="dim">Tried by {r.by || "the reviewer"} on commit <span className="mono">{short(r.sha)}</span>, {ago(r.at)}.</p>{again("Review again")}</div>
			</>}
			{r.status === "done" && v && <>
				{stale && <Notice tone="warn" small><strong>This review is of an earlier commit.</strong> It read <span className="mono">{short(r.sha)}</span>; the attempt is now at <span className="mono">{short(a.headSha)}</span>, so what follows may no longer hold.{policy.review && going ? " The new commit is reviewed once its checks have finished." : ""}</Notice>}
				<div className="review-head">
					<div className="review-verdict">
						<span className={`chip ${stale ? "quiet" : v.tone}`}>{v.chip}</span>
						<p><strong>{t.met} of {plural(t.of, "criterion", "criteria")} met.</strong> {v.says}</p>
					</div>
					{again("Review again")}
				</div>
				{r.verdict === "changes" && r.changes && <div className="review-changes"><span className="label">What the reviewer asks for</span><p>{r.changes}</p></div>}
				{r.summary && <p className="review-summary">{r.summary}</p>}
				{r.verdict === "approve" && flags > 0 && !stale && <Notice tone="warn" small>The reviewer passed it, but Braid flagged {plural(flags, "thing")} above. A review cannot set those aside.</Notice>}
			</>}
			{act.error && <Notice small>{act.error}</Notice>}
			{r.status === "done" ? <><h3>Against each criterion</h3>{list(r.criteria)}</> : criteria.length > 0 && <><h3>What it is judged by</h3>{list(null)}</>}
			{r.status === "done" && r.concerns.length > 0 && <>
				<h3>Other things the reviewer noticed</h3>
				<ul className="concerns">{r.concerns.map((c, i) => <li key={i}><Icon name="info" size={14} /><span>{c}</span></li>)}</ul>
			</>}
			{r.status === "done" && <p className="review-by">Reviewed by <span className="mono">{r.by}</span>, a model, on commit <span className="mono">{short(r.sha)}</span>, {ago(r.finishedAt ?? r.at)}. It is a first reading, not a decision{policy.landing === "auto" ? ": under this project's policy Braid lands only what passes it with nothing flagged." : "; a person lands."}</p>}
		</div>
	);
}

/** The intent's criteria as the numbered list every attempt is judged by, with each reviewed attempt's standing beside it. */
export function CriteriaTable({ state, intent, attempts }: { state: State; intent: Intent; attempts: Attempt[] }) {
	const criteria = intent.criteria ?? [];
	if (!criteria.length) return null;
	const cols = attempts.filter((a) => a.status !== "abandoned" || reviewOf(state, a)).map((a) => ({ a, r: reviewOf(state, a) }));
	const any = cols.some((c) => c.r);
	const fromGoal = !intent.acceptance.trim();
	const clash = clashingCriteria(state, intent.id);
	const go = (id: string) => document.getElementById(`attempt-${id}`)?.scrollIntoView({ block: "start" });
	return (
		<section className="criteria-box" aria-labelledby="crit-h">
			<div className="criteria-head">
				<h2 id="crit-h" className="label">Done when</h2>
				<p className="dim">{fromGoal ? "No “Done when” was written, so the goal itself is what every attempt is judged by." : `Every attempt is judged by ${criteria.length === 1 ? "this" : `these ${criteria.length}`}, in this order.`}{any && cols.length > 1 ? " Each column is one attempt's review." : ""}</p>
			</div>
			<div className="criteria-scroll" tabIndex={any ? 0 : undefined} role={any ? "group" : undefined} aria-label={any ? "Criteria by attempt, scrollable" : undefined}>
				<table className="criteria-table">
					{any && (
						<thead>
							<tr>
								<th scope="col"><span className="sr-only">Criterion</span></th>
								{cols.map(({ a, r }) => (
									<th key={a.id} scope="col">
										<button className="crit-col" onClick={() => go(a.id)} title={`Go to attempt ${a.id}`}><Agent name={a.agent} kind={a.kind} model={a.model} /><span className="mono dim">{a.id}</span></button>
										{r?.status === "done" && r.sha !== a.headSha && <span className="crit-old">older commit</span>}
									</th>
								))}
							</tr>
						</thead>
					)}
					<tbody>
						{criteria.map((text, i) => (
							<tr key={i}>
								<th scope="row" className={clash.has(i + 1) ? "clashing" : ""}><span className="crit-n">{i + 1}</span>{text}{clash.has(i + 1) && <span className="chip conflict crit-clash" title="Another intent asks for the opposite; see how this intent stands, below"><Icon name="conflict" size={12} />clashes with {[...new Set(clash.get(i + 1))].map((o) => `I${o}`).join(", ")}</span>}</th>
								{any && cols.map(({ a, r }) => {
									const c = r?.status === "done" ? r.criteria[i] : undefined, m = c ? MARK[c.verdict] : null;
									return (
										<td key={a.id} className={`${m?.tone ?? "none"} ${r && r.sha !== a.headSha ? "old" : ""}`} title={c?.why}>
											{m ? <span className="crit-cell"><Icon name={m.icon} size={14} />{m.word}</span>
												: r?.status === "running" ? <span className="crit-cell dim"><Icon name="running" size={14} className="spin" />reading</span>
												: <span className="crit-cell dim">{r?.status === "failed" ? "review failed" : "not reviewed"}</span>}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
					{any && (
						<tfoot>
							<tr>
								<th scope="row" className="label">Verdict and flags</th>
								{cols.map(({ a, r }) => {
									const tag = reviewTag(state, a), flags = flagsOf(a).length;
									return <td key={a.id}><span className="crit-foot">{tag ? <span className={`chip ${tag.tone}`} title={tag.title}>{tag.text.split(" · ")[0]}</span> : <span className="dim">no review</span>}{flags > 0 && <span className="chip flagged"><Icon name="warning" size={12} />{plural(flags, "flag")}</span>}</span></td>;
								})}
							</tr>
						</tfoot>
					)}
				</table>
			</div>
		</section>
	);
}

/** How this project is run: who lands, whether attempts are reviewed, and who works on conflicts. */
export function PolicyPanel({ state }: { state: State }) {
	const policy = policyOf(state), model = (policy.reviewers ?? []).join(" or "), slug = state.project.slug;
	const act = useAction();
	const toggle = () => act.run(async () => {
		if (!policy.review && await ask({ title: "Turn reviews on?", body: <p>Every attempt marked ready will be read by {model} against its intent's criteria once its checks pass. Each review is a call to the model, which this instance pays for.</p>, confirm: "Turn reviews on" }) === null) return;
		if (policy.review && policy.landing === "auto" && await ask({ title: "Turn reviews off?", body: <p>This project lands by itself only what a review has passed. With reviews off, nothing lands by itself and every attempt waits for a person.</p>, confirm: "Turn reviews off" }) === null) return;
		await api("POST", `/p/${slug}/review`, { review: !policy.review });
	});
	const planning = useAction(), planner = policy.planner ?? null;
	const togglePlan = () => planning.run(async () => {
		if (!policy.plan && await ask({ title: "Turn planning on?", body: <p>Every intent will be read by {planner} next to the project's other intents when it is opened or edited, to find goals that clash, must land in order, or repeat each other. Each reading is a call to the model, which this instance pays for.</p>, confirm: "Turn planning on" }) === null) return;
		await api("POST", `/p/${slug}/planning`, { plan: !policy.plan });
	});
	return (
		<section className="panel side-panel policy" aria-labelledby="policy-h">
			<h2 id="policy-h" className="label">How this project is run</h2>
			<dl>
				<div>
					<dt><Icon name="land" size={14} />Who lands</dt>
					<dd>{policy.landing === "auto"
						? <><strong>Braid, when it is plainly good.</strong> It lands an attempt by itself when the agent marked it ready, its checks passed, the review found every criterion met, nothing is flagged, no question is open, and it is the only attempt at its intent. Everything else waits for a person.</>
						: <><strong>A person.</strong> Nothing lands until someone asks for it.</>}</dd>
				</div>
				<div>
					<dt><Icon name="strands" size={14} />Planning</dt>
					<dd>{!planner ? <><strong>None.</strong> No model is set up on this instance, so nobody reads intents next to each other.</>
						: policy.plan ? <><strong>On.</strong> Each intent is read by <span className="mono">{planner}</span> next to the others when it is opened or edited, to find goals that clash, must land in order, or repeat each other, before any agent starts.</>
						: <><strong>Off.</strong> Intents are not read next to each other. A person can still say how two stand, or split a goal.</>}</dd>
				</div>
				<div>
					<dt><Icon name="search" size={14} />Reviews</dt>
					<dd>{!model ? <><strong>None.</strong> No model is set up on this instance.</>
						: policy.review ? <><strong>On.</strong> Each attempt marked ready is read by <span className="mono">{model}</span> against its intent's “Done when”, after its checks.{(policy.reviewers ?? []).length > 1 && " The reader is a model from a different maker than the agent that wrote the attempt."}</>
						: <><strong>Off.</strong> A person reads each attempt against its intent's “Done when”.</>}
						{policy.landing === "auto" && policy.review && <> When the reviewer asks for changes, the attempt goes back to its agent, at most twice.</>}</dd>
				</div>
				<div>
					<dt><Icon name="fork" size={14} />Races</dt>
					<dd><strong>{(policy.race?.agents ?? []).length ? (policy.race.agents.map((x) => `${x.kind === "codex" ? "Codex" : "Claude Code"}${x.model ? ` on ${x.model}` : ""}`).join(" against ")) : "No line-up set"}.</strong> A race starts these on one intent, each blind to the others. Once one is ready the rest are waited for {policy.race?.wait ?? 30} minutes, then the ready ones are compared{(policy.reviewers ?? []).length ? ` by ${(policy.reviewers ?? []).join(" and ")}` : ""}.{policy.landing === "auto" ? " Braid lands the pick by itself only when at least two judges agree." : ""}</dd>
				</div>
				<div>
					<dt><Icon name="question" size={14} />Decision model</dt>
					<dd>{policy.signal ? <><strong><span className="mono">{policy.signal}</span>, as a second reading.</strong> On every push it says how likely each criterion is met, in well under a second. It can only hold a landing back, never cause one{policy.landing === "auto" ? <>: the pick of a race is not landed by Braid unless it gives every criterion at least {Math.round((policy.likelihood ?? 0.9) * 100)}%</> : null}. It cannot say why, and it is unsure about things a change leaves out.</> : <><strong>None.</strong> Only the reviewer and the judges read attempts.</>}</dd>
				</div>
				<div>
					<dt><Icon name="eye" size={14} />Pictures</dt>
					<dd>{policy.shots ? <><strong>On.</strong> Braid takes a picture of each attempt's preview at each commit, for comparing attempts by eye.</> : <><strong>Off.</strong> This instance cannot take pictures of previews.</>}</dd>
				</div>
				<div>
					<dt><Icon name="conflict" size={14} />Conflicts</dt>
					<dd>{policy.conflicts === "auto" ? <><strong>The agent first, then the model,</strong> and a person only after both.</> : <><strong>A person</strong> resolves them, or asks the agent or the model to.</>}</dd>
				</div>
			</dl>
			{!state.viewer && model && <button disabled={act.busy} onClick={toggle}>{act.busy ? "Saving…" : policy.review ? "Turn reviews off" : "Turn reviews on"}</button>}
			{!state.viewer && planner && <button disabled={planning.busy} onClick={togglePlan}>{planning.busy ? "Saving…" : policy.plan ? "Turn planning off" : "Turn planning on"}</button>}
			{act.error && <Notice small>{act.error}</Notice>}
			{planning.error && <Notice small>{planning.error}</Notice>}
			<p className="hint">Set in trunk's <code>braid.json</code>: who lands and who resolves conflicts under <code>landing</code> (<code>policy</code>, <code>conflicts</code>, and <code>likelihood</code> for the decision model's bar); the line-up and the wait under <code>race</code> (<code>agents</code>, <code>wait</code>); <code>"signal": false</code> turns the decision model off.</p>
		</section>
	);
}
