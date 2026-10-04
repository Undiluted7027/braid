// What Braid found when it ran a commit in a sandbox: each step, how long it took, and the end of its output.
import { useState } from "react";
import type { Run, State } from "../shared/types";
import { api, short } from "./api";
import { useAction } from "./App";

const seconds = (ms: number) => (ms < 950 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 9950 ? 1 : 0)} s`);
const LABEL: Record<Run["status"], string> = { queued: "queued", running: "running", pass: "passed", fail: "failed", error: "could not run", superseded: "superseded" };
const tone = (status: Run["status"]) => (status === "pass" ? "pass" : status === "fail" || status === "error" ? "conflict" : "quiet");

export const runFor = (state: State, ref: string) => state.runs.find((r) => r.ref === ref) ?? null;

/** One-word state of a ref's verification, for lists. `head` is the commit the ref is at now. */
export function RunChip({ run, head }: { run: Run | null; head: string }) {
	if (!run) return null;
	const stale = run.sha !== head;
	const failed = run.steps.filter((s) => s.status === "fail").map((s) => s.name);
	return (
		<span className={`chip ${stale ? "quiet" : tone(run.status)}`} title={`Verified in a sandbox at ${short(run.sha)}`}>
			{stale ? "verification pending" : run.status === "fail" ? `failed ${failed.join(", ")}` : run.status === "pass" ? (run.nothingToRun ? "nothing to verify" : "verified") : `verification ${LABEL[run.status]}`}
		</span>
	);
}

export function Verification({ slug, refName, run, head }: { slug: string; refName: string; run: Run | null; head: string }) {
	const [open, setOpen] = useState<string | null>(null);
	const again = useAction();
	const rerun = <button disabled={again.busy} onClick={() => again.run(() => api("POST", `/p/${slug}/runs`, { ref: refName }))}>{run ? "Run again" : "Verify now"}</button>;
	if (!run) return <div className="row"><p className="dim small">This commit has not been run yet.</p><span className="spacer" />{rerun}</div>;
	const active = run.status === "queued" || run.status === "running";
	return (
		<div className="verify">
			<div className="row">
				<span className={`chip ${tone(run.status)}`}>{LABEL[run.status]}</span>
				<span className="small dim">commit <span className="mono">{short(run.sha)}</span>, in a sandbox with no network access beyond its own repository and the package registry</span>
				<span className="spacer" />
				{!active && rerun}
			</div>
			{run.sha !== head && <p className="warn small">This result is for an earlier commit. The current one, <span className="mono">{short(head)}</span>, is waiting to be verified.</p>}
			{again.error && <p className="error">{again.error}</p>}
			{run.error && <p className="error">{run.error}</p>}
			{run.status === "pass" && run.nothingToRun && <p className="dim small">The repository defines no checks (no <code>braid.json</code>, and no typecheck, lint, test or build script).</p>}
			<ol className="steps">
				{run.steps.map((s) => (
					<li key={s.name} className={`step ${s.status}`}>
						<button className="step-head" onClick={() => setOpen(open === s.name ? null : s.name)} aria-expanded={open === s.name}>
							<span className="step-mark" aria-hidden="true">{s.status === "pass" ? "✓" : s.status === "fail" ? "✕" : "…"}</span>
							<strong>{s.name}</strong>
							<span className="mono dim">{s.command}</span>
							<span className="spacer" />
							<span className="dim small">{s.status === "running" ? "running" : `${s.status === "fail" ? `exit ${s.exitCode} · ` : ""}${seconds(s.ms)}`}</span>
						</button>
						{(open === s.name || (open === null && s.status === "fail")) && <pre className="step-out">{s.tail.trim() || "(no output)"}</pre>}
					</li>
				))}
			</ol>
		</div>
	);
}
