// The planner: how intents stand to each other (they contradict, one waits for another, one repeats another),
// found before any agent starts, and a broad goal split into intents for a person to accept. Contradictions are
// decisions for a person; dependencies are order, not a problem; duplicates are a quiet note.
import { useState, type FormEvent, type ReactNode } from "react";
import type { Intent, Proposal, Relation, State } from "../shared/types";
import { api, ago } from "./api";
import { IntentId, Link, useAction } from "./App";
import { ask, Icon, Notice, type IconName } from "./Kit";
import { sentence, useAsked } from "./Later";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// An instance that has not been restarted since these fields were added leaves them out.
export const relationsOf = (state: State): Relation[] => state.relations ?? [];
export const proposalsOf = (state: State): Proposal[] => state.proposals ?? [];
const intentOf = (state: State, id: number) => state.intents.find((i) => i.id === id);
/** The model that plans, when one is set up. Splitting a goal and "look again" need it whether or not planning is on for every intent. */
export const plannerOf = (state: State) => state.project.policy?.planner ?? null;
const who = (r: Relation) => (r.source === "person" ? `Said by ${r.by}` : `Found by ${r.by}, a model`);

/**
 * Intents that cannot all land, as groups: if A clashes with B and B with C, that is one thing to decide, not two.
 * Ten intents that each want a different accent colour are one group with forty-five reasons.
 */
export function clashes(state: State): { key: string; intents: Intent[]; relations: Relation[] }[] {
	const rels = relationsOf(state).filter((r) => r.kind === "contradicts");
	const parent = new Map<number, number>();
	const find = (x: number): number => { const p = parent.get(x) ?? x; if (p === x) return x; const root = find(p); parent.set(x, root); return root; };
	for (const r of rels) parent.set(find(r.from), find(r.to));
	const groups = new Map<number, Relation[]>();
	for (const r of rels) groups.set(find(r.from), [...(groups.get(find(r.from)) ?? []), r]);
	return [...groups.values()].map((relations) => {
		const ids = [...new Set(relations.flatMap((r) => [r.from, r.to]))].sort((a, b) => a - b);
		return { key: ids.join("-"), intents: ids.map((id) => intentOf(state, id)).filter((i): i is Intent => !!i), relations };
	}).filter((g) => g.intents.length > 1);
}

/** How one intent stands to the others. */
export function standing(state: State, id: number) {
	const rels = relationsOf(state);
	return {
		clashes: rels.filter((r) => r.kind === "contradicts" && (r.from === id || r.to === id)),
		waitsFor: rels.filter((r) => r.kind === "depends" && r.from === id),
		waitedBy: rels.filter((r) => r.kind === "depends" && r.to === id),
		repeats: rels.filter((r) => r.kind === "duplicates" && r.from === id),
		repeatedBy: rels.filter((r) => r.kind === "duplicates" && r.to === id),
	};
}
/** For each criterion of an intent (1-based), the intents whose criteria it clashes with. */
export function clashingCriteria(state: State, id: number) {
	const out = new Map<number, number[]>();
	for (const r of relationsOf(state).filter((r) => r.kind === "contradicts" && (r.from === id || r.to === id))) {
		const mine = r.from === id ? r.fromCriteria : r.toCriteria, other = r.from === id ? r.to : r.from;
		for (const n of mine ?? []) out.set(n, [...(out.get(n) ?? []), other]);
	}
	return out;
}

function IntentRef({ state, id }: { state: State; id: number }) {
	const i = intentOf(state, id);
	return <Link to={`/p/${state.project.slug}/i/${id}`} className="iref"><IntentId id={id} /><span>{i?.title ?? `Intent ${id}`}</span></Link>;
}
const dismiss = (state: State, r: Relation) => api("POST", `/p/${state.project.slug}/relations/${r.id}/dismiss`, { by: "human" });

/** One group of intents that cannot all land, under Needs you: what clashes, in the planner's words, and what a person can do about it. */
export function ClashRow({ state, group }: { state: State; group: ReturnType<typeof clashes>[number] }) {
	const act = useAction();
	const slug = state.project.slug, n = group.intents.length;
	const landed = group.intents.filter((i) => i.status === "landed");
	const abandon = (i: Intent) => act.run(async () => {
		const live = state.attempts.filter((a) => a.intentId === i.id && ["working", "ready", "conflicted"].includes(a.status)).length;
		if (await ask({ title: `Abandon I${i.id}, “${i.title}”?`, body: <p>{live ? `Its ${plural(live, "attempt")} in progress ${live === 1 ? "is" : "are"} abandoned too, and their agents stopped. ` : ""}The other{n > 2 ? "s stay" : " stays"} open.</p>, confirm: "Abandon intent", danger: true }) === null) return;
		await api("POST", `/p/${slug}/intents/${i.id}/abandon`, {});
	});
	const none = () => act.run(async () => {
		if (await ask({ title: n === 2 ? "These two do not contradict each other?" : `None of these ${n} contradict each other?`, body: <p>{group.relations.length === 1 ? "The contradiction is" : `All ${group.relations.length} contradictions between them are`} set aside and the planner will not raise {group.relations.length === 1 ? "it" : "them"} again. Use this when both can be true of one codebase.</p>, confirm: "They do not contradict" }) === null) return;
		for (const r of group.relations) await dismiss(state, r);
	});
	return (
		<div className="needs-row clash">
			<span className="chip conflict"><Icon name="conflict" size={12} />intents clash</span>
			<div className="needs-text">
				<p><strong>{n === 2 ? "These two intents cannot both land." : `These ${n} intents cannot all land.`}</strong> {landed.length ? `${landed.map((i) => `I${i.id}`).join(" and ")} ${landed.length === 1 ? "has" : "have"} already landed, so the open ${n - landed.length === 1 ? "one" : "ones"} would undo it.` : "They ask for opposite things of one codebase. Choose before agents spend work on both."}</p>
				<ul className="clash-intents">
					{group.intents.map((i) => (
						<li key={i.id}>
							<IntentRef state={state} id={i.id} />
							<span className={`chip ${i.status}`}>{i.status}</span>
							{!state.viewer && i.status === "open" && <button className="quiet" disabled={act.busy} onClick={() => abandon(i)}>Abandon this one</button>}
						</li>
					))}
				</ul>
				<p className="clash-why"><span className="label">{group.relations.length === 1 ? "Why" : `Why, in ${group.relations.length} pairs`}</span>{sentence(group.relations[0].why)} <span className="dim">{who(group.relations[0])}.</span></p>
				{group.relations.length > 1 && (
					<details className="disclose">
						<summary>The other {plural(group.relations.length - 1, "pair")}</summary>
						<ul className="clash-pairs">
							{group.relations.slice(1).map((r) => (
								<li key={r.id}><span className="mono">I{r.from} · I{r.to}</span><span>{sentence(r.why)}</span>{!state.viewer && <button className="link" disabled={act.busy} onClick={() => act.run(() => dismiss(state, r))}>Not a contradiction</button>}</li>
							))}
						</ul>
					</details>
				)}
				{act.error && <Notice small>{act.error}</Notice>}
			</div>
			{!state.viewer && <button disabled={act.busy} onClick={none}>{act.busy ? "Saving…" : "Not a contradiction"}</button>}
		</div>
	);
}

/** On an intent in a list: what it waits for, what waits for it, what it clashes with and what it may repeat, in a line each. */
export function StandingLines({ state, intent }: { state: State; intent: Intent }) {
	const s = standing(state, intent.id);
	const others = (rels: Relation[], pick: (r: Relation) => number) => rels.map((r, i) => <span key={r.id}>{i > 0 && (i === rels.length - 1 ? " and " : ", ")}<IntentRef state={state} id={pick(r)} /></span>);
	const unlanded = s.waitsFor.filter((r) => intentOf(state, r.to)?.status !== "landed");
	const lines: ReactNode[] = [];
	if (s.clashes.length) lines.push(<p key="c" className="stand clash"><Icon name="conflict" size={14} /><span>Cannot land together with {others(s.clashes, (r) => (r.from === intent.id ? r.to : r.from))}. A person chooses.</span></p>);
	if (unlanded.length) lines.push(<p key="w" className="stand order"><Icon name="clock" size={14} /><span>Lands after {others(unlanded, (r) => r.to)}. An attempt can start now; it waits to land.</span></p>);
	if (s.waitedBy.length && intent.status === "open") lines.push(<p key="b" className="stand order"><Icon name="arrow" size={14} /><span>{others(s.waitedBy, (r) => r.from)} {s.waitedBy.length === 1 ? "waits" : "wait"} for this to land.</span></p>);
	if (s.repeats.length) lines.push(<p key="d" className="stand quiet"><Icon name="copy" size={14} /><span>May ask for what {others(s.repeats, (r) => r.to)} already {s.repeats.length === 1 ? "does" : "do"}.</span></p>);
	return lines.length ? <div className="standing-lines">{lines}</div> : null;
}

const KINDS: { value: string; label: string; icon: IconName }[] = [
	{ value: "waits", label: "This intent must land after…", icon: "clock" },
	{ value: "before", label: "This intent must land before…", icon: "arrow" },
	{ value: "contradicts", label: "This intent cannot land together with…", icon: "conflict" },
	{ value: "duplicates", label: "This intent may ask for the same as…", icon: "copy" },
];

/** A person says how two intents stand: the kind, the other intent, and why. */
function AddRelation({ state, intent, close }: { state: State; intent: Intent; close: () => void }) {
	const [kind, setKind] = useState("waits");
	const candidates = state.intents.filter((i) => i.id !== intent.id && i.status !== "abandoned");
	const [other, setOther] = useState(candidates[0]?.id ?? 0);
	const [why, setWhy] = useState("");
	const act = useAction();
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		// "Must land before" is the other intent depending on this one, so it is said from the other side.
		const [on, to, k] = kind === "before" ? [other, intent.id, "depends"] : [intent.id, other, kind === "waits" ? "depends" : kind];
		if (await act.run(() => api("POST", `/p/${state.project.slug}/intents/${on}/relations`, { kind: k, other: to, why, by: "human" }))) close();
	};
	if (!candidates.length) return <p className="dim">There is no other intent in this project to relate it to.</p>;
	return (
		<form className="panel decide form add-relation" onSubmit={submit}>
			<h3>Say how I{intent.id} stands to another intent</h3>
			<label>How<select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
			<label>Which intent<select value={other} onChange={(e) => setOther(Number(e.target.value))}>{candidates.map((i) => <option key={i.id} value={i.id}>I{i.id} {i.title} ({i.status})</option>)}</select></label>
			<label>Why<textarea rows={2} value={why} onChange={(e) => setWhy(e.target.value)} required placeholder={kind === "contradicts" ? "What cannot both be true" : kind === "duplicates" ? "What they both ask for" : "What the later one needs from the earlier"} /><span className="hint">Agents on both intents are told, with this reason.{(kind === "waits" || kind === "before") && " The later one is not landed until the earlier has landed."}</span></label>
			{act.error && <Notice>{act.error}</Notice>}
			<div className="row"><button className="primary" disabled={act.busy || !why.trim()}>{act.busy ? "Saving…" : "Save"}</button><button type="button" onClick={close}>Cancel</button></div>
		</form>
	);
}

/** On the intent page: how this intent stands to the others, each with its reason, and what a person can do about it. */
export function Standing({ state, intent }: { state: State; intent: Intent }) {
	const s = standing(state, intent.id), slug = state.project.slug, policy = state.project.policy, planner = plannerOf(state);
	const [adding, setAdding] = useState(false);
	const act = useAction();
	const all = [...s.clashes, ...s.waitsFor, ...s.waitedBy, ...s.repeats, ...s.repeatedBy];
	// Asking the planner to look again only starts it; what it finds changes the relations.
	const looking = useAsked(false, all.map((r) => r.id).join(","), 40_000);
	const again = () => act.run(async () => {
		if (await ask({ title: `Have ${planner} look at I${intent.id} again?`, body: <p>It reads this intent next to every other open or landed one and reports what clashes, what must land first and what repeats. That is one call to the model, which this instance pays for.</p>, confirm: "Look again" }) === null) return;
		await api("POST", `/p/${slug}/intents/${intent.id}/plan`, {});
		looking.mark();
	});
	const drop = (r: Relation, what: string) => act.run(async () => {
		if (await ask({ title: "This does not hold?", body: <p>{what} is set aside{r.source === "planner" ? ", and the planner will not raise it again" : ""}.</p>, confirm: "It does not hold" }) === null) return;
		await dismiss(state, r);
	});
	const row = (r: Relation, tone: string, icon: IconName, label: string, otherId: number, extra?: ReactNode) => {
		const mine = r.from === intent.id ? r.fromCriteria : r.toCriteria, theirs = r.from === intent.id ? r.toCriteria : r.fromCriteria;
		return (
			<li key={r.id} className={tone}>
				<span className={`chip ${tone === "clash" ? "conflict" : tone === "order" ? "working" : "quiet"}`}><Icon name={icon} size={12} />{label}</span>
				<div className="stand-body">
					<p className="stand-other"><IntentRef state={state} id={otherId} /><span className={`chip ${intentOf(state, otherId)?.status ?? "quiet"}`}>{intentOf(state, otherId)?.status ?? "gone"}</span></p>
					<p>{sentence(r.why)}</p>
					{extra}
					{r.kind === "contradicts" && (mine?.length > 0 || theirs?.length > 0) && <p className="stand-meta">{mine?.length ? `This intent's criterion ${mine.join(", ")}` : "This intent"} against {theirs?.length ? `I${otherId}'s criterion ${theirs.join(", ")}` : `I${otherId}`}; marked in “Done when” above.</p>}
					<p className="stand-meta">{who(r)}, {ago(r.at)}.</p>
				</div>
				{!state.viewer && <button className="quiet" disabled={act.busy} onClick={() => drop(r, label === "clashes with" ? "The contradiction" : label.startsWith("may") ? "The note" : "The order")}>This does not hold</button>}
			</li>
		);
	};
	const open = intent.status === "open";
	return (
		<section className="standing" aria-labelledby="stand-h">
			<div className="standing-head">
				<h2 id="stand-h" className="label">How this intent stands to the others</h2>
				{!state.viewer && open && <span className="row">
					{planner && <button disabled={act.busy || looking.pending} onClick={again}><Icon name={looking.pending ? "running" : "search"} className={looking.pending ? "spin" : ""} />{looking.pending ? "Looking…" : "Look again"}</button>}
					{!adding && <button onClick={() => setAdding(true)}><Icon name="plus" />Add by hand</button>}
				</span>}
			</div>
			{looking.pending && <p className="recon-model" role="status"><Icon name="running" className="spin" />{planner} is reading this intent next to the others. Anything it finds appears here.</p>}
			{act.error && <Notice small>{act.error}</Notice>}
			{all.length === 0 && <p className="dim">{policy?.plan && planner ? `${planner} read it next to the others and found nothing that clashes with it, must land before it, or repeats it.` : planner ? "Planning is off for this project, so nobody has read this intent next to the others." : "No model is set up to plan, so nobody has read this intent next to the others. A person can say how it stands."}</p>}
			{all.length > 0 && (
				<ul className="stand-list">
					{s.clashes.map((r) => { const o = r.from === intent.id ? r.to : r.from; return row(r, "clash", "conflict", "clashes with", o, <p className="stand-meta strong">{intentOf(state, o)?.status === "landed" ? `I${o} has landed, so landing this would undo it.` : "Both cannot land. A person chooses; Braid lands neither by itself."}</p>); })}
					{s.waitsFor.map((r) => row(r, "order", "clock", "lands after", r.to, <p className="stand-meta strong">{intentOf(state, r.to)?.status === "landed" ? `I${r.to} has landed, so nothing holds this back now.` : `An attempt at this intent can be made now, but it is not landed until I${r.to} has landed. “Land now” on the attempt overrides that.`}</p>))}
					{s.waitedBy.map((r) => row(r, "order", "arrow", "lands before", r.from, <p className="stand-meta strong">I{r.from} is not landed until this one has.</p>))}
					{s.repeats.map((r) => row(r, "quiet", "copy", "may repeat", r.to))}
					{s.repeatedBy.map((r) => row(r, "quiet", "copy", "may be repeated by", r.from))}
				</ul>
			)}
			{adding && <AddRelation state={state} intent={intent} close={() => setAdding(false)} />}
		</section>
	);
}

type Draft = Proposal["intents"];
/** Move an item in the list and keep every "after" pointing at the same intent. Returns null if that would put an intent before one it comes after. */
function moved(list: Draft, from: number, to: number): Draft | null {
	const order = list.map((_, i) => i);
	order.splice(to, 0, order.splice(from, 1)[0]);
	const place = new Map(order.map((old, now) => [old + 1, now + 1]));
	const out = order.map((old) => ({ ...list[old], dependsOn: list[old].dependsOn.map((d) => place.get(d)!).sort((a, b) => a - b) }));
	return out.every((it, i) => it.dependsOn.every((d) => d < i + 1)) ? out : null;
}
function removed(list: Draft, at: number): Draft {
	return list.filter((_, i) => i !== at).map((it) => ({ ...it, dependsOn: it.dependsOn.filter((d) => d !== at + 1).map((d) => (d > at + 1 ? d - 1 : d)) }));
}

/** One goal the planner was asked to split: while it is being made, when it failed, ready to read and edit, and after it was accepted. */
function ProposalCard({ state, p }: { state: State; p: Proposal }) {
	const slug = state.project.slug;
	const act = useAction();
	// What the person has changed, kept here so a live refresh of the state does not undo it.
	const [draft, setDraft] = useState<Draft | null>(null);
	const [editing, setEditing] = useState(false);
	const list = draft ?? p.intents;
	const set = (i: number, patch: Partial<Draft[number]>) => setDraft(list.map((it, j) => (j === i ? { ...it, ...patch } : it)));
	const head = <p className="proposal-goal"><span className="label">The goal</span>“{p.goal}”</p>;
	if (p.status === "running") return <article className="panel proposal running" aria-label="Goal being split">{head}<p className="recon-model" role="status"><Icon name="running" className="spin" />{p.by || "The planner"} is splitting this into intents that can be attempted side by side. Nothing is opened until you accept what it proposes. Asked {ago(p.at)}.</p></article>;
	if (p.status === "failed") return (
		<article className="panel proposal failed" aria-label="Goal that could not be split">
			{head}
			<Notice><strong>This goal could not be split.</strong> {sentence(p.error ?? "No reason was recorded")} Nothing was opened.</Notice>
			{act.error && <Notice small>{act.error}</Notice>}
			{!state.viewer && <div className="row"><button disabled={act.busy} onClick={() => act.run(() => api("POST", `/p/${slug}/proposals/${p.id}/drop`, {}))}>Dismiss</button><span className="hint">Write the goal again under “Split a goal” to try once more, or open intents by hand.</span></div>}
		</article>
	);
	if (p.status === "accepted") return <p className="proposal-done"><Icon name="check" size={14} /><span>Accepted {ago(p.at)}: “{p.goal}” was opened as {plural(p.intents.length, "intent")}{p.intents.length ? ` (${p.intents.map((i) => i.title).join("; ")})` : ""}.</span></p>;
	if (p.status === "dropped") return null;
	const accept = () => act.run(async () => {
		if (state.project.policy?.plan && await ask({ title: `Open these ${plural(list.length, "intent")}?`, body: <p>Agents can start on them as soon as they are open. Planning is on, so each one is also read next to the project's other intents, which is a call to the model for each.</p>, confirm: `Open ${plural(list.length, "intent")}` }) === null) return;
		await api("POST", `/p/${slug}/proposals/${p.id}/accept`, { intents: list, by: "human" });
	});
	return (
		<article className="panel decide proposal" aria-label="Proposed intents">
			{head}
			<p className="proposal-lede"><strong>{p.by || "The planner"} proposes {plural(list.length, "intent")}.</strong> {p.note} Nothing is open yet: read them, change what is wrong, then open them or drop the proposal.</p>
			<ol className="proposal-list">
				{list.map((it, i) => (
					<li key={i}>
						<span className="crit-n">{i + 1}</span>
						{editing ? (
							<div className="proposal-edit form">
								<label>Title<input value={it.title} onChange={(e) => set(i, { title: e.target.value })} required /></label>
								<label>Goal<textarea rows={2} value={it.goal} onChange={(e) => set(i, { goal: e.target.value })} required /></label>
								<label>Done when<textarea rows={Math.min(8, Math.max(2, it.acceptance.split("\n").length))} value={it.acceptance} onChange={(e) => set(i, { acceptance: e.target.value })} /><span className="hint">One thing to check per line. Every attempt is judged by these.</span></label>
								{i > 0 && (
									<fieldset className="proposal-after"><legend>Lands after</legend>
										{list.slice(0, i).map((b, j) => <label key={j} className="check"><input type="checkbox" checked={it.dependsOn.includes(j + 1)} onChange={(e) => set(i, { dependsOn: e.target.checked ? [...it.dependsOn, j + 1].sort((x, y) => x - y) : it.dependsOn.filter((d) => d !== j + 1) })} />{j + 1}. {b.title}</label>)}
									</fieldset>
								)}
								<div className="row">
									<button type="button" disabled={i === 0 || !moved(list, i, i - 1)} onClick={() => setDraft(moved(list, i, i - 1))} title={i > 0 && !moved(list, i, i - 1) ? "It lands after the one above, so it cannot go before it" : undefined}><Icon name="push" />Move up</button>
									<button type="button" disabled={i === list.length - 1 || !moved(list, i, i + 1)} onClick={() => setDraft(moved(list, i, i + 1))} title={i < list.length - 1 && !moved(list, i, i + 1) ? "The one below lands after it, so it cannot go after it" : undefined}>Move down</button>
									<button type="button" className="danger" disabled={list.length === 1} onClick={() => setDraft(removed(list, i))}><Icon name="trash" />Leave this one out</button>
								</div>
							</div>
						) : (
							<div className="proposal-item">
								<p className="proposal-title">{it.title}</p>
								<p className="goal">{it.goal}</p>
								{it.acceptance.trim() && <><span className="label">Done when</span><ul className="proposal-criteria">{it.acceptance.split("\n").map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean).map((l, k) => <li key={k}>{l}</li>)}</ul></>}
								{it.dependsOn.length > 0 ? <p className="stand order"><Icon name="clock" size={14} /><span>Lands after {it.dependsOn.map((d) => `${d}. ${list[d - 1]?.title ?? "?"}`).join(" and ")}.</span></p> : list.length > 1 && <p className="stand quiet"><Icon name="strands" size={14} /><span>Can be attempted alongside the others.</span></p>}
							</div>
						)}
					</li>
				))}
			</ol>
			{act.error && <Notice>{act.error}</Notice>}
			{!state.viewer && (
				<div className="row proposal-actions">
					<button className="primary" disabled={act.busy || list.some((it) => !it.title.trim() || !it.goal.trim())} onClick={accept}><Icon name="plus" />{act.busy ? "Opening…" : `Open ${list.length === 1 ? "this intent" : `these ${list.length} intents`}`}</button>
					<button disabled={act.busy} onClick={() => setEditing(!editing)}><Icon name={editing ? "check" : "edit"} />{editing ? "Done editing" : "Edit"}</button>
					{draft && <button className="quiet" disabled={act.busy} onClick={() => { setDraft(null); setEditing(false); }}>Undo my changes</button>}
					<span className="spacer" />
					<button className="quiet" disabled={act.busy} onClick={() => act.run(async () => { if (await ask({ title: "Drop this proposal?", body: <p>Nothing was opened, and nothing will be.</p>, confirm: "Drop it", danger: true }) !== null) await api("POST", `/p/${slug}/proposals/${p.id}/drop`, {}); })}>Drop the proposal</button>
				</div>
			)}
		</article>
	);
}

/** Where a broad goal is written to be split. */
export function SplitGoal({ state, close }: { state: State; close: () => void }) {
	const [goal, setGoal] = useState("");
	const act = useAction();
	const planner = plannerOf(state);
	return (
		<form className="panel decide form" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/p/${state.project.slug}/plan`, { goal, by: "human" }))) close(); }}>
			<h3>Split a goal into intents</h3>
			<p className="dim">Write what you want in your own words, as broad as it is. {planner} reads it next to the project and proposes separate intents, each with its own “Done when”, and says which must land before which. You read, edit and accept the proposal before anything is opened.</p>
			<label>The goal<textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Let people give each counter a colour of its own, and show a small chart of all the counts" required autoFocus /></label>
			<p className="hint">This is one call to the model, which this instance pays for.</p>
			{act.error && <Notice>{act.error}</Notice>}
			<div className="row"><button className="primary" disabled={act.busy || !goal.trim()}>{act.busy ? "Asking…" : "Propose intents"}</button><button type="button" onClick={close}>Cancel</button></div>
		</form>
	);
}

/** The proposals worth showing: any being made, waiting to be read, or failed, and the last accepted one as a line. */
export function Proposals({ state }: { state: State }) {
	const all = proposalsOf(state);
	const live = all.filter((p) => p.status === "running" || p.status === "done" || p.status === "failed");
	const lastAccepted = all.find((p) => p.status === "accepted");
	if (!live.length && !lastAccepted) return null;
	return <div className="proposals">{live.map((p) => <ProposalCard key={p.id} state={state} p={p} />)}{lastAccepted && !live.length && <ProposalCard state={state} p={lastAccepted} />}</div>;
}
