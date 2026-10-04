import test from "node:test";
import assert from "node:assert/strict";
import { redact, secretValues } from "../src/shared/redact.ts";

const gone = (text, secret, values) => {
	const out = redact(text, values);
	assert.ok(!out.includes(secret), `${secret} survived in: ${out}`);
	return out;
};

test("redact: known key formats", () => {
	gone("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 here", "abcdefghijklmnopqrstuvwxyz");
	gone("ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abc");
	gone("aws AKIAIOSFODNN7EXAMPLE ok", "AKIAIOSFODNN7EXAMPLE");
	gone("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGci");
	gone("art_v1_0123456789abcdef0123456789abcdef?expires=1790000000", "0123456789abcdef");
	gone(`brd_${"ab".repeat(20)}`, "abab");
});

test("redact: credentials in URLs keep the host", () => {
	const out = gone("git fetch https://x:s3cretpass@example.com/repo.git main", "s3cretpass");
	assert.match(out, /https:\/\/\[redacted\]@example\.com\/repo\.git main/);
});

test("redact: authorization headers and private keys", () => {
	gone("extraheader = Authorization: Bearer abcdef0123456789abcdef", "abcdef0123456789");
	gone("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk");
	gone("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA", "MIIEpAIBAAKCAQEA"); // cut off before the end marker
});

test("redact: secret-looking assignments, but not ordinary code", () => {
	gone("DATABASE_PASSWORD=hunter2hunter2", "hunter2");
	gone('STRIPE_API_KEY: "live-value-123456"', "live-value");
	const code = "const agentToken = joined.agentToken; export GITHUB_TOKEN=$OTHER";
	assert.equal(redact(code), code);
});

test("redact: lower-case config and JSON forms", () => {
	gone("[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY\n", "wJalrXUtnFEMI");
	gone('{ "clientSecret": "abcd1234efgh5678" }', "abcd1234efgh5678");
	gone("password: correcthorsebattery", "correcthorsebattery");
	for (const code of ['const cacheKey = "user:profile:42";', "token: joined.agentToken,", 'sortKey: "createdAt-desc"', "const key = await crypto.subtle.importKey(raw);",
		'const TOKEN_KEY = "braid:admin-token";', "Bearer authentication is required here", "csrf_token = a1b2c3d4e5f6a7b8", "password: process.env.DB_PASSWORD"]) assert.equal(redact(code), code);
});

test("redact: more provider formats", () => {
	gone("glpat-abcdefghij0123456789", "abcdefghij0123456789");
	gone(`hf_${"a1".repeat(17)}`, "a1a1a1");
	gone("https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx");
});

test("redact: exact values, longest first", () => {
	const out = gone("the value is plainlookingvalue-extended", "plainlookingvalue", ["plainlookingvalue", "plainlookingvalue-extended"]);
	assert.equal(out, "the value is [redacted]");
	assert.equal(redact("short ab", ["ab"]), "short ab");
});

test("secretValues: named like secrets, not paths", () => {
	assert.deepEqual(secretValues({ MY_API_KEY: "0123456789", SSH_AUTH_SOCK: "/private/tmp/agent.sock", EDITOR: "vim-long-name", NPM_TOKEN: "short" }), ["0123456789"]);
});
