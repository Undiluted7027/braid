// What Braid found when it ran a commit in a sandbox: each step, how long it took, and the end of its output.
import { useState } from "react";
import type { Run, State } from "../shared/types";
import { api, short } from "./api";
import { useAction } from "./App";
import { Icon, Notice } from "./Kit";

const seconds = (ms: number) => (ms < 950 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 9950 ? 1 : 0)} s`);
const LABEL: Record<Run["status"], string> = { queued: "queued", running: "running", pass: "passed", fail: "failed", error: "could not run", superseded: "superseded" };
const tone = (status: Run["status"]) => (status === "pass" ? "pass" : status === "fail" || status === "error" ? "conflict" : status === "running" || status === "queued" ? "working" : "quiet");

export const runFor = (state: State, ref: string) => state.runs.find((r) => r.ref === ref) ?? null;

/** One-word state of a ref's verification, for lists. `head` is the commit the ref is at now. */
export function RunChip({ run, head }: { run: Run | null; head: string }) {
	if (!run) return null;
	const stale = run.sha !== head;
	const failed = run.steps.filter((s) => s.status === "fail").map((s) => s.name);
	return (
		<span className={`chip ${stale ? "quiet" : tone(run.status)}`} title={stale ? `The last run was of ${short(run.sha)}; ${short(head)} is waiting its turn` : `Braid ran ${short(run.sha)} in a sandbox`}>
			{stale ? "run pending" : run.status === "fail" ? `failed ${failed.join(", ")}` : run.status === "pass" ? (run.nothingToRun ? "nothing to run" : "checks passed") : `checks ${LABEL[run.status]}`}
		</span>
	);
}

/**
 * `fixed`: the run is of a commit Braid built (an attempt merged with trunk), so there is nothing to run again by hand.
 * `readOnly`: the reader may look, not start a run.
 */
export function Verification({ slug, refName, run, head, fixed = false, readOnly = false }: { slug: string; refName: string; run: Run | null; head: string; fixed?: boolean; readOnly?: boolean }) {
	const [open, setOpen] = useState<string | null>(null);
	const again = useAction();
	const rerun = readOnly ? null : <button disabled={again.busy} onClick={() => again.run(() => api("POST", `/p/${slug}/runs`, { ref: refName }))}><Icon name="play" />{again.busy ? "Starting…" : run ? "Run again" : "Run now"}</button>;
	if (!run) return <div className="verify"><div className="row"><p className="dim">This commit has not been run yet.</p><span className="spacer" />{rerun}</div>{again.error && <Notice>{again.error}</Notice>}</div>;
	const active = run.status === "queued" || run.status === "running";
	return (
		<div className="verify">
			<div className="row">
				<span className={`chip ${tone(run.status)}`}>{LABEL[run.status]}</span>
				<span className="dim">Commit <span className="mono">{short(run.sha)}</span>, run in a sandbox that can reach only its own repository and the package registry.</span>
				<span className="spacer" />
				{!active && !fixed && rerun}
			</div>
			{run.sha !== head && <Notice tone="warn" small>This result is for an earlier commit. The current one, <span className="mono">{short(head)}</span>, is waiting to be run.</Notice>}
			{again.error && <Notice>{again.error}</Notice>}
			{run.error && <Notice>{run.error}</Notice>}
			{run.status === "pass" && run.nothingToRun && <p className="dim">The repository defines no checks: no <code>braid.json</code>, and no typecheck, lint, test or build script.</p>}
			{run.steps.length > 0 && (
				<ol className="steps">
					{run.steps.map((s) => {
						const shown = open === s.name || (open === null && s.status === "fail");
						return (
							<li key={s.name} className={`step ${s.status}`}>
								<button className="step-head" onClick={() => setOpen(shown ? "" : s.name)} aria-expanded={shown}>
									<Icon name={s.status === "pass" ? "check" : s.status === "fail" ? "x" : "running"} className={s.status === "running" ? "spin" : ""} label={s.status === "pass" ? "Passed" : s.status === "fail" ? "Failed" : "Running"} />
									<strong>{s.name}</strong>
									<span className="mono step-cmd">{s.command}</span>
									<span className="step-time">{s.status === "running" ? "running" : `${s.status === "fail" ? `exit ${s.exitCode} · ` : ""}${seconds(s.ms)}`}</span>
									<Icon name={shown ? "chevron-down" : "chevron-right"} />
								</button>
								{shown && <pre className="step-out" tabIndex={0}>{s.tail.trim() || "(no output)"}</pre>}
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}
