// Takes credentials out of text before it is shown, stored or committed. Used by the launcher
// (before anything leaves the machine) and again by the server. This is a backstop: the launcher
// also starts agents with a scrubbed environment and does not capture command output wholesale.
// Erasable syntax only, so `node cli/braid.mjs` can import this file directly.
//
// Sources compared when choosing patterns: garrytan/gstack lib/redact-patterns.ts (MIT), the
// gitleaks generic-api-key rule (MIT), and ellmos-ai/GARDENER sources.py. They disagree on keyword
// rules ("token = ..."): GARDENER leaves them out as too imprecise for an unattended step, gstack
// asks a person to confirm, gitleaks gates them on entropy and a list of harmless names. Nobody is
// watching here, so keyword matches use the gitleaks gates. Personal data patterns are left out.

const MARK = "[redacted]";

const PATTERNS: [RegExp, string | ((...m: string[]) => string)][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `[redacted private key]`],
	// user:password@ in any URL
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]*:[^\s@/]+@/gi, `$1${MARK}@`],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MARK], // JWT
	[/\bsk-ant-[A-Za-z0-9_-]{20,}/g, MARK],
	[/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, MARK],
	[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, MARK],
	[/\bgithub_pat_[A-Za-z0-9_]{30,}/g, MARK],
	[/\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, MARK],
	[/\b(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,}/g, MARK],
	[/\bAIza[0-9A-Za-z_-]{35}/g, MARK],
	[/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, MARK],
	[/\bnpm_[A-Za-z0-9]{36}\b/g, MARK],
	[/\bgl(?:pat|ptt|dt)-[A-Za-z0-9_-]{20,}/g, MARK], // GitLab
	[/\bgsk_[A-Za-z0-9]{20,}/g, MARK], // Groq
	[/\bhf_[A-Za-z0-9]{30,}/g, MARK], // Hugging Face
	[/\b(?:ntn_|secret_)[A-Za-z0-9]{40,}/g, MARK], // Notion
	[/\bdop_v1_[a-f0-9]{64}/g, MARK], // DigitalOcean
	[/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, MARK], // SendGrid
	[/\bGOCSPX-[A-Za-z0-9_-]{20,40}/g, MARK], // Google OAuth client secret
	[/\b[0-9]{6,16}:A[A-Za-z0-9_-]{34}(?![A-Za-z0-9_-])/g, MARK], // Telegram bot
	[/(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, `$1${MARK}`],
	[/(https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/)[0-9]+\/[A-Za-z0-9_-]+/g, `$1${MARK}`],
	[/\bart_v1_[a-f0-9]{16,}(?:\?expires=\d+)?/g, MARK], // Artifacts git tokens
	[/\bbrd_[a-f0-9]{40}\b/g, MARK], // Braid attempt tokens
];

/** Bits per character: random keys score high, words and repeated text low. */
function entropy(s: string) {
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
	return bits;
}
const keyLike = (v: string) => /\d/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 3;

// "Authorization: Bearer <token>", but not the word Bearer in a sentence.
PATTERNS.push([/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{16,})/gi, (all, scheme, gap, value) => (/\d/.test(value) ? `${scheme}${gap}${MARK}` : all)]);

// name = value, where the name says the value is a secret. Names that only sound like it are skipped
// (after the gitleaks allowlist), and so are values that read as code or prose rather than a key.
const HARMLESS_NAME = /(?:public|pub|primary|foreign|cache|sort|partition|hot|idx|bucket|natural|schema)[_.-]?key$|(?:csrf|public)[_.-]?token$|monkey$|turkey$/i;
const CODE_VALUE = /^(?:true|false|null|undefined|string|required|[A-Za-z_$][\w$]*(?:\.[\w$]+)+\W*)$/;
PATTERNS.push([
	/(^|[^A-Za-z0-9])((?:[A-Za-z0-9]+[_.-])*[A-Za-z0-9]*(?:key|token|secret|passw(?:or)?d|credentials?|creds))(["']?[ \t]*[=:][ \t]*)(["']?)([^\s"',;]{6,})/gi,
	(all, before, name, sep, quote, value) => {
		if (HARMLESS_NAME.test(name) || /^[$\[<{(]/.test(value) || CODE_VALUE.test(value)) return all;
		const secret = /passw/i.test(name) ? true : value.length >= 8 && keyLike(value);
		return secret ? `${before}${name}${sep}${quote}${MARK}` : all;
	},
]);

/** `values` are exact strings known to be secret (tokens the caller holds, sensitive environment values). */
export function redact(text: string, values: string[] = []): string {
	let out = text;
	for (const v of [...values].sort((a, b) => b.length - a.length)) {
		if (v.length >= 8) out = out.split(v).join(MARK);
	}
	for (const [pattern, to] of PATTERNS) out = out.replace(pattern, to as string);
	return out;
}

// Not SESSION: session ids turn up in ordinary paths, and masking them makes transcripts unreadable.
const SENSITIVE_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH|COOKIE|DSN|DATABASE_URL|PRIVATE/i;

/** The values in an environment worth redacting by exact match: named like secrets, and not file paths. */
export function secretValues(env: Record<string, string | undefined>): string[] {
	return Object.entries(env).flatMap(([name, value]) => (value && value.length >= 8 && !value.startsWith("/") && SENSITIVE_NAME.test(name) ? [value] : []));
}
