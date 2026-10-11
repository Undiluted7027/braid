// Shapes shared by the Worker and the UI.
export type IntentStatus = "open" | "landed" | "abandoned";
export type AttemptStatus = "working" | "ready" | "conflicted" | "landed" | "superseded" | "abandoned" | "reverted";
/** `feedback` and `answer` are written by people: a note an attempt was sent back with, and a reply to a question an agent recorded. */
export type DecisionKind = "decision" | "assumption" | "rejected" | "question" | "note" | "feedback" | "answer";

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
	/** "Done when" as separate things to check. Every attempt at the intent is reviewed against these. */
	criteria: string[];
}
/**
 * How two intents stand to each other, found before work starts. "contradicts": both cannot be true of one codebase
 * (`fromCriteria` and `toCriteria` are the criteria that clash, 1-based). "depends": `from` needs `to` to land first.
 * "duplicates": `from` asks for what `to` already does. `by` is the model that found it, or a person's name.
 */
export interface Relation {
	id: number; kind: "contradicts" | "depends" | "duplicates"; from: number; to: number; why: string;
	fromCriteria: number[]; toCriteria: number[]; by: string; source: "planner" | "person"; at: number;
}
/** A broad goal split into intents by the planner, for a person to accept, edit or drop. `dependsOn` are 1-based places in the same list. */
export interface Proposal {
	id: number; goal: string; status: "running" | "done" | "failed" | "accepted" | "dropped";
	intents: { title: string; goal: string; acceptance: string; dependsOn: number[] }[]; note: string;
	by: string; error: string | null; at: number;
}
/** Something about an attempt a person should look at whatever a reviewer says. Raised from the diff and the session, with no model. */
export interface Flag {
	kind: "tests-deleted" | "tests-changed" | "checks" | "lockfile" | "outside-claims" | "history" | "destructive";
	text: string; paths: string[];
}
/** One criterion as the reviewer found it. `basis`: judged from the diff (with lines as evidence), or from the project's checks having passed. */
export interface CriterionVerdict { text: string; verdict: "met" | "not_met" | "unclear"; basis: "diff" | "checks"; why: string; evidence: { path: string; line: number | null }[] }
/**
 * A reviewer's reading of one commit of an attempt against its intent's criteria. `verdict`: "approve" (every
 * criterion met, nothing for a person to weigh), "changes" (something specific the agent could change, in `changes`),
 * or "person". A review is for the commit in `sha`; once the attempt has another head it is about an older one.
 */
export interface Review {
	id: number; attemptId: string; intentId: number; sha: string;
	status: "running" | "done" | "failed";
	verdict: "approve" | "changes" | "person" | null;
	criteria: CriterionVerdict[]; summary: string; concerns: string[]; changes: string;
	/** The model that reviewed. */
	by: string; error: string | null; at: number; finishedAt: number | null;
}
export interface FileChange { path: string; status: "added" | "modified" | "deleted"; base: string | null; head: string | null }
export interface Check { name: string; status: "pass" | "fail"; detail: string; at: number }
export interface Attempt {
	/** The model the agent ran on, when Braid was told: it starts hosted agents itself, and the launcher reads it from the agent's output. */
	model: string | null;
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
	flags: Flag[];
	/** Under a project that lands by itself: why this attempt has not been landed, in words. Empty when that does not apply. */
	held: string;
	/**
	 * What kind of thing is holding it. "checks", "review" and "dependency" are things Braid is waiting for and will act on by itself;
	 * every other kind needs a person. Empty when `held` is.
	 */
	heldFor: "" | "checks" | "review" | "checks-failed" | "review-failed" | "no-reviewer" | "flags" | "question" | "choice" | "landing" | "reviewer" | "contradiction" | "dependency" | "person";
	/** Landings on trunk since this attempt's base. */
	behind: number;
	/** Paths that would conflict with trunk if this landed now. */
	trunkConflicts: string[];
	checks: Check[];
	createdAt: number;
	updatedAt: number;
	/** The latest session event, for a one-line "what is it doing now". */
	/** Set when Braid itself runs the agent. */
	hosted?: Hosted | null;
	hostedDetail?: string;
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
	/** `lockfile`: both sides changed dependencies. Nobody merges it by hand: Braid regenerates it from the merged package.json. */
	kind: "content" | "delete" | "lockfile";
	base: string | null;
	trunk: string | null;
	attempt: string | null;
	/** Each place the two sides disagree, with a few agreed lines before and after it. `ours` is trunk, `theirs` the attempt. */
	regions: { base: string; ours: string; theirs: string; oursLine: number; before?: string; after?: string }[];
	/** Why trunk looks the way it does here: the intents that landed changes to this path. */
	trunkWhy: ConflictContext[];
}
export interface Reconciliation {
	id: number;
	attemptId: string;
	intentId: number;
	/** `stale`: resolved, but trunk or the attempt moved before it landed, so it was not used. */
	status: "open" | "resolving" | "resolved" | "stale";
	trunkSha: string;
	/** The attempt commit the conflict was found at. A resolution is only used for these two commits. */
	attemptSha: string | null;
	/** Set when the project sends conflicts on without waiting for a person: who was last asked. */
	auto: "agent" | "model" | null;
	conflicts: Conflict[];
	resolutions: { path: string; content: string }[];
	rationale: string;
	resolvedBy: string;
	at: number;
}
export interface Landing {
	/** Set on a landing that was taken back: the commit that reverted it. */
	revertedBy: string | null;
	/** Set on the commit that took a landing back: the landing it reverted. */
	revertOf: string | null;
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
export interface ProjectInfo { slug: string; name: string; description: string; repo: string; remote: string; branch: string; head: string; contextRemote: string | null; llm: string | null
	/** Which agents this instance can run itself. */
	hosting: { available: boolean; claude: boolean; codex: boolean; via: string };
	/** Anyone with the link may read this project without signing in. */
	public: boolean;
	/**
	 * How the project is run, from trunk's braid.json. `landing`: "auto" lands an attempt without a person once it is ready,
	 * its checks pass, its review finds every criterion met and nothing is flagged. `review`: attempts are reviewed when marked ready.
	 * `conflicts`: "auto" sends a conflict to the agent and then the model before a person.
	 * `reviewers`: the models this instance can review with. With two, an attempt is read by one from a different maker than its agent.
	 * `plan`: each intent is looked at next to the others when it is opened or edited, by `planner`.
	 */
	policy: { landing: "person" | "auto"; review: boolean; conflicts: "person" | "auto"; reviewers: string[]; plan: boolean; planner: string | null };
}
/** One command run in the sandbox for a commit. `tail` is the end of its output. */
export interface RunStep { name: string; command: string; status: "running" | "pass" | "fail"; exitCode: number | null; ms: number; tail: string }
/** A verification of one commit of an attempt (or of trunk): what Braid ran and what happened. */
export interface Run {
	id: number; ref: string; sha: string;
	status: "queued" | "running" | "pass" | "fail" | "error" | "superseded";
	steps: RunStep[]; preview: boolean;
	/** The preview's /api/ calls are answered by this Braid instance, read-only (braid.json: preview.api = "braid"). */
	previewApi: boolean; nothingToRun: boolean; error: string | null; startedAt: number; finishedAt: number | null;
}
export interface State {
	/** Set for someone who has not signed in and is reading a public project: they can look, not change. */
	viewer?: boolean;
	/** Set when the instance has an admin token: the key that lets a sandboxed preview frame load each ref. */
	previewKeys?: Record<string, string>;
	project: ProjectInfo;
	/** The latest run for each ref: an attempt id, "trunk", or "batch:<id>" for a batch of landings merged with trunk ("batch:<id>:<n>" for one step of it), "lock:<attempt id>" for a lockfile being regenerated. */
	runs: Run[];
	/** Attempts someone asked to land, in the order they will be tried. */
	queue: QueuedLanding[];
	/** The last merge with trunk that was built for an attempt and sent to be verified. */
	candidates: { attemptId: string; sha: string; trunkSha: string; attemptSha: string; /** The run that decides it: the batch's, or this attempt's own step once a failed batch is taken apart. */ runRef: string; runSha: string }[];
	/** Landings being merged and verified together, in the order they will land. */
	batches: Batch[];
	intents: Intent[];
	attempts: Attempt[];
	decisions: Decision[];
	overlaps: Overlap[];
	reconciliations: Reconciliation[];
	landings: Landing[];
	activity: Activity[];
	/** How open intents stand to each other and to what has landed. Relations a person dismissed, or whose intents are gone, are left out. */
	relations: Relation[];
	/** Goals the planner was asked to split, newest first. */
	proposals: Proposal[];
	/** The latest review of each attempt. */
	reviews: Review[];
	/** How things asked for turned out, newest first. A request only answers "queued"; this is where its result shows. */
	outcomes: Outcome[];
	/** Work Braid gave up on after several tries. Each can be tried again. */
	stuck: { id: string; type: string; error: string; tries: number; at: number; attemptId: string | null }[];
}
/**
 * The result of something that was asked for and done later by the worker.
 * landing: landed, conflict, refused or cancelled. revert: reverted or refused. reconcile and agent: failed.
 * `ref` is the landing commit, or "R<id>" for a reconciliation.
 */
export interface Outcome {
	id: number; kind: "landing" | "revert" | "reconcile" | "agent"; outcome: string; text: string;
	attemptId: string | null; intentId: number | null; by: string; ref: string; at: number;
	/** For a landing: the attempt's head when this was decided. Once the attempt has a different head, the outcome is about an older commit. */
	sha: string;
}
/**
 * A landing that has been asked for and not happened yet. An attempt lands once its own commit has passed
 * in a sandbox and, when trunk has moved since, once its merge with trunk has passed too.
 */
export interface QueuedLanding {
	attemptId: string; by: string; at: number;
	/** The commit the person asked to land. If the attempt moves, the request is dropped. */
	attemptSha: string;
	state: "waiting" | "locking" | "verifying" | "pushing";
	/** What it is waiting for, in words. */
	note: string;
	/** The batch it is being verified in, if it is in one. */
	batch: number | null;
}
/**
 * Several landings merged one on top of the other and verified with one run of the last. If that passes they
 * all land. If it fails ("splitting"), every step is run at once: those before the first failure land, that one
 * is refused, and the rest go back in the queue.
 */
export interface Batch { id: number; trunkSha: string; tipSha: string; state: "verifying" | "splitting" | "pushing"; members: string[]; at: number }
export type LandOutcome =
	| { landed: true; sha: string }
	| { landed: false; reconciliationId: number; conflicts: string[] }
	| { landed: false; queued: true; waiting: string };
/** An agent Braid is running for an attempt in a sandbox, and how that went. */
export type Hosted = "starting" | "running" | "finished" | "failed" | "stopped";
export interface JoinResult { attemptId: string; intentId: number; branch: string; remote: string; gitToken: string; agentToken: string; trunkRemote: string; trunkToken: string; mcpUrl: string; brief: string }
export interface DiffFile { path: string; status: FileChange["status"]; base: string | null; head: string | null; binary: boolean }
/** One commit on trunk. `intentId` is set when Braid knows which intent it belongs to: a landing, a revert, or a commit made in an attempt that landed. */
export interface TrunkCommit { sha: string; subject: string; author: string; at: number; kind: "landing" | "revert" | "attempt" | "outside" | "start"; intentId: number | null; attemptId: string | null }
/** A line of a trunk file. `sha` is the landing that put it there (so its intent), `origin` says exactly where it was written. */
export interface BlameLine { text: string; sha: string | null; origin?: string }
/**
 * Where a run of lines was written: a commit an agent made inside its attempt, the merge that
 * landed it (lines written while reconciling), a revert, or a commit pushed to trunk outside Braid.
 * For an attempt's commit it also says what the agent decided around then and where in its session to look.
 */
export interface LineOrigin {
	key: string;
	kind: "attempt" | "reconcile" | "merge" | "revert" | "outside" | "start";
	landingSha: string | null;
	attemptId: string | null;
	commit: { sha: string; subject: string; author: string; at: number } | null;
	/** Decisions recorded while this commit was being made, the ones about this file first. */
	decisionIds: number[];
	/** Where in the session this file was edited on the way to this commit (or first touched, if no edit was captured). */
	eventId: number | null;
}
export interface FileView { path: string; content: string | null; binary: boolean; blame: BlameLine[]; trail: Landing[]; origins: Record<string, LineOrigin> }
