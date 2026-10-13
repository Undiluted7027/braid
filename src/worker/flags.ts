// Things about an attempt that a person should look at whatever a reviewer says. Worked out from the
// diff and the session, with no model: a model can be talked round, these cannot.
import { claimMatches } from "./overlap.ts";
import { GENERATED } from "./gitops.ts";
import { ENVIRONMENT, lockOf } from "./environment.ts";
import type { FileChange, Flag } from "../shared/types.ts";

const TEST = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const CHECKS = /(^|\/)(braid\.json|\.github\/workflows\/[^/]+|tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s)$/;

/**
 * Flags from what an attempt changed. `scripts` is package.json's scripts before and after, when the
 * attempt changed that file: what a check runs can be changed there without touching a test.
 */
export function diffFlags(files: FileChange[], claims: string[], scripts?: { base: Record<string, string>; head: Record<string, string> } | null): Flag[] {
	const out: Flag[] = [];
	const flag = (kind: Flag["kind"], text: string, paths: string[]) => { if (paths.length) out.push({ kind, text, paths: paths.slice(0, 20) }); };
	const tests = files.filter((f) => TEST.test(f.path));
	flag("tests-deleted", "Deleted tests", tests.filter((f) => f.status === "deleted").map((f) => f.path));
	flag("tests-changed", "Changed tests that were already there", tests.filter((f) => f.status === "modified").map((f) => f.path));
	flag("checks", "Changed what Braid runs to check the work, or how", files.filter((f) => CHECKS.test(f.path) && !TEST.test(f.path)).map((f) => f.path));
	if (scripts) {
		const names = [...new Set([...Object.keys(scripts.base), ...Object.keys(scripts.head)])].filter((n) => scripts.base[n] !== scripts.head[n] && (n in scripts.base));
		if (names.length) out.push({ kind: "checks", text: `Changed or removed the package.json script${names.length === 1 ? "" : "s"} ${names.join(", ")}`, paths: ["package.json"] });
	}
	// A lockfile goes with a manifest in the same directory: package.json for Node's, pyproject.toml, Cargo.toml or go.mod for the others'.
	const changed = new Set(files.map((f) => f.path)), manifestOf = (path: string) => path.replace(/[^/]+$/, "") + (lockOf(path)?.manifest ?? "package.json");
	flag("lockfile", "Changed a lockfile without changing the manifest beside it", files.filter((f) => GENERATED.test(f.path) && !changed.has(manifestOf(f.path))).map((f) => f.path));
	flag("environment", "Changed what the project is run in", files.filter((f) => ENVIRONMENT.test(f.path)).map((f) => f.path));
	const outside = files.filter((f) => !claims.some((c) => claimMatches(c, f.path) || claimMatches(f.path, c))).map((f) => f.path);
	flag("outside-claims", claims.length ? "Changed files it did not say it would" : "Changed files without saying beforehand which ones", outside);
	return out;
}

const DESTRUCTIVE: [RegExp, string][] = [
	[/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(-[a-zA-Z-]+\s+)*(\/|~|\.\.|\*|\.git)(\s|\/?$|\/\*)/, "removed files wholesale"],
	[/\bgit\s+push\b[^|;&]*\s(--force(-with-lease)?|-f)\b/, "pushed over history"],
	[/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/, "piped a download into a shell"],
	[/\bsudo\s+\S/, "ran something as root"],
	[/\bchmod\s+(-[a-zA-Z]+\s+)*-?R?\s*777\b/, "opened up file permissions"],
	[/\bgit\s+(filter-branch|filter-repo)\b|\bgit\s+rebase\b[^|;&]*--root/, "rewrote history"],
];
/** Flags from what the agent ran, as its session recorded it. */
export function sessionFlags(events: { kind: string; text: string }[]): Flag[] {
	const seen = new Map<string, string[]>();
	for (const e of events) {
		if (e.kind !== "tool") continue;
		for (const [pattern, what] of DESTRUCTIVE) {
			if (pattern.test(e.text)) seen.set(what, [...(seen.get(what) ?? []), e.text.split("\n")[0].slice(0, 160)]);
		}
	}
	return [...seen].map(([what, commands]) => ({ kind: "destructive" as const, text: `In its session it ${what}: ${commands.slice(0, 3).join(" · ")}`, paths: [] }));
}
