// Shapes shared by the Worker and the UI.
export type IntentStatus = "open" | "landed" | "abandoned";
export type AttemptStatus = "working" | "ready" | "conflicted" | "landed" | "superseded" | "abandoned";
export type DecisionKind = "decision" | "assumption" | "rejected" | "question" | "note";

export interface Intent {
	id: number;
	title: string;
	goal: string;
	acceptance: string;
	status: IntentStatus;
	createdBy: string;
	createdAt: number;
	landedSha: string | null;
	landedAttempt: string | null;
}
export interface FileChange { path: string; status: "added" | "modified" | "deleted"; base: string | null; head: string | null }
export interface Check { name: string; status: "pass" | "fail"; detail: string; at: number }
export interface Attempt {
	id: string;
	intentId: number;
	agent: string;
	kind: string;
	repo: string;
	remote: string;
	baseSha: string;
	headSha: string;
	status: AttemptStatus;
	summary: string;
	files: FileChange[];
	claims: string[];
	/** Landings on trunk since this attempt's base. */
	behind: number;
	/** Paths that would conflict with trunk if this landed now. */
	trunkConflicts: string[];
	checks: Check[];
	createdAt: number;
	updatedAt: number;
	/** The latest session event, for a one-line "what is it doing now". */
	now?: { kind: SessionEvent["kind"]; tool: string | null; text: string; at: number } | null;
}
/** One thing an agent did, said, or was told during an attempt. */
export interface SessionEvent {
	id: number;
	attemptId: string;
	at: number;
	/** say: the agent's own words. tool: something it ran or called. result: what came back. braid: a Braid tool call. system: lifecycle. */
	kind: "say" | "tool" | "result" | "braid" | "system";
	tool: string | null;
	text: string;
}
export interface Decision {
	id: number;
	attemptId: string;
	intentId: number;
	agent: string;
	kind: DecisionKind;
	title: string;
	body: string;
	files: string[];
	sha: string;
	at: number;
}
export interface Overlap { a: string; b: string; path: string; severity: "claim" | "touch" | "conflict"; regions: number }
export interface ConflictContext { intentId: number; title: string; goal: string; agent: string; decisions: Decision[] }
export interface Conflict {
	path: string;
	kind: "content" | "delete";
	base: string | null;
	trunk: string | null;
	attempt: string | null;
	regions: { base: string; ours: string; theirs: string; oursLine: number }[];
	/** Why trunk looks the way it does here: the intents that landed changes to this path. */
	trunkWhy: ConflictContext[];
}
export interface Reconciliation {
	id: number;
	attemptId: string;
	intentId: number;
	status: "open" | "resolving" | "resolved";
	trunkSha: string;
	conflicts: Conflict[];
	resolutions: { path: string; content: string }[];
	rationale: string;
	resolvedBy: string;
	at: number;
}
export interface Landing {
	sha: string;
	parentSha: string;
	intentId: number;
	attemptId: string;
	agent: string;
	title: string;
	files: string[];
	reconciled: boolean;
	at: number;
}
export interface Activity { id: number; at: number; kind: string; actor: string; text: string; intentId: number | null; attemptId: string | null }
export interface ProjectInfo { slug: string; name: string; description: string; repo: string; remote: string; branch: string; head: string; contextRemote: string | null; llm: string | null }
/** One command run in the sandbox for a commit. `tail` is the end of its output. */
export interface RunStep { name: string; command: string; status: "running" | "pass" | "fail"; exitCode: number | null; ms: number; tail: string }
/** A verification of one commit of an attempt (or of trunk): what Braid ran and what happened. */
export interface Run {
	id: number; ref: string; sha: string;
	status: "queued" | "running" | "pass" | "fail" | "error" | "superseded";
	steps: RunStep[]; preview: boolean; nothingToRun: boolean; error: string | null; startedAt: number; finishedAt: number | null;
}
export interface State {
	/** Set when the instance has an admin token: the key that lets a sandboxed preview frame load each ref. */
	previewKeys?: Record<string, string>;
	project: ProjectInfo;
	/** The latest run for each ref (attempt id or "trunk"). */
	runs: Run[];
	intents: Intent[];
	attempts: Attempt[];
	decisions: Decision[];
	overlaps: Overlap[];
	reconciliations: Reconciliation[];
	landings: Landing[];
	activity: Activity[];
}
export interface JoinResult { attemptId: string; intentId: number; branch: string; remote: string; gitToken: string; agentToken: string; trunkRemote: string; trunkToken: string; mcpUrl: string; brief: string }
export interface DiffFile { path: string; status: FileChange["status"]; base: string | null; head: string | null; binary: boolean }
export interface BlameLine { text: string; sha: string | null }
export interface FileView { path: string; content: string | null; binary: boolean; blame: BlameLine[]; trail: Landing[] }
