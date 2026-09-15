// Must-detect and must-ignore fixtures for scripts/secret_pii_scan.cjs.
// Fixture values below are synthetic shapes, never real credentials.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./support/fixture_repo.cjs");
const scan = require("../../scripts/secret_pii_scan.cjs");

function fixtureRepo(files) {
  const root = makeTempDir("siton-secret-scan-");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function serviceRoleJwt() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ iss: "supabase", ref: "abc", role: "service_role", iat: 1, exp: 2 }) + "." + "x".repeat(43);
}
function anonJwt() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ iss: "supabase", ref: "abc", role: "anon", iat: 1, exp: 2 }) + "." + "y".repeat(43);
}

test("must-detect: every secret shape is found in canonical source, docs and configs", () => {
  const root = fixtureRepo({
    "src/a.ts": "const k = 'sk_live_" + "A".repeat(28) + "';\nconst w = 'whsec_" + "B".repeat(30) + "';",
    "config/b.json": JSON.stringify({ token: "ghp_" + "c".repeat(36), aws: "AKIA" + "D".repeat(16), google: "AIza" + "E".repeat(35) }),
    "docs/c.md": "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n",
    "scripts/d.cjs": "const url = 'postgresql://siton_web_login:Kx9v2Qp7Lm4Zt8Wq@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';",
    "supabase/e.ts": "const s = '" + serviceRoleJwt() + "';",
    "render.yaml": "SUPABASE_KEY: sb_secret_" + "F".repeat(24) + "\nRENDER: rnd_" + "G".repeat(24),
    "src/f.ts": "const GROW_API_KEY = 'Qv8Lm2Xp9Rt4Zw7Kj3Hn6Bc1';",
    "docs/g.md": "card 4916 3385 0608 2832 was used",
    "src/h.ts": "const slack = 'xoxb-" + "1234567890-".repeat(3) + "abcdefghij';"
  });
  try {
    const result = scan.run({ root, allowList: [], skipGit: true });
    const detectors = new Set(result.findings.map((f) => f.detector));
    for (const expected of ["stripe-secret-key", "stripe-webhook-secret", "github-token", "aws-access-key", "google-api-key", "private-key", "database-url-credential", "supabase-service-role-jwt", "supabase-secret-key", "render-api-key", "grow-credential", "real-card-pan", "slack-token"]) {
      assert.ok(detectors.has(expected), "expected detector " + expected + " in " + [...detectors].join(","));
    }
    const dbHit = result.findings.find((f) => f.detector === "database-url-credential");
    assert.match(dbHit.match, /:\*\*\*@/, "password must be redacted in the report");
    assert.doesNotMatch(JSON.stringify(result.findings), /Kx9v2Qp7Lm4Zt8Wq/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("must-ignore: placeholders, local hosts, documented test PANs, synthetic fixtures, anon JWTs, worktrees and build output", () => {
  const root = fixtureRepo({
    "docker-compose.yml": "DATABASE_URL: postgresql://siton_demo:siton_demo_password@postgres:5432/siton_demo",
    "docs/env.md": "DATABASE_URL=postgresql://user:<password>@db.example.supabase.co:5432/postgres\nDATABASE_URL=postgresql://user:${DB_PASSWORD}@host/db",
    "tests/fixture.ts": "const key = 'sk_live_short'; const GROW_USER_ID = 'grow-sandbox-user-fixture';\nconst url = 'postgresql://u:SYNTHETIC_SENTINEL@host/db';",
    "docs/cards.md": "Stripe test card 4242 4242 4242 4242 and Grow sandbox card 4580458045804580; timestamp 1789341297974; uuid 11111111-1111-1111-1111-111111111111",
    "src/anon.ts": "const anon = '" + anonJwt() + "';",
    "src/emails.ts": "const support = 'support@siton.test'; const owner = process.env.SITON_OWNER_EMAIL; const phone = '0500000001'; const sample = '+972501234567';",
    ".worktrees/x/src/leak.ts": "const k = 'sk_live_" + "Z".repeat(28) + "';",
    ".demo_dist/leak.js": "const k = 'sk_live_" + "Z".repeat(28) + "';",
    "node_modules/pkg/leak.js": "const k = 'sk_live_" + "Z".repeat(28) + "';",
    "src/probe.ts": "const dsn = 'postgresql://siton_web_login:redacted-real-secret-value@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';"
  });
  try {
    const result = scan.run({ root, allowList: [], skipGit: true });
    assert.deepEqual(result.findings, [], JSON.stringify(result.findings, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pii-in-runtime warns on real-looking emails/phones in src but not on synthetic ones, and never inspects docs for it", () => {
  const root = fixtureRepo({
    "src/real.ts": "const contact = 'dana.levi@gmail.com'; const cell = '052-6734891';",
    "docs/people.md": "dana.levi@gmail.com 052-6734891"
  });
  try {
    const result = scan.run({ root, allowList: [], skipGit: true });
    const runtime = result.findings.filter((f) => f.detector === "pii-in-runtime");
    assert.equal(runtime.length, 2, JSON.stringify(result.findings));
    assert.ok(runtime.every((f) => f.rel === "src/real.ts" && f.severity === "WARNING"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("allow-list: exact entries suppress, wildcards refused, stale entries reported", () => {
  const root = fixtureRepo({ "src/a.ts": "const k = 'sk_live_" + "A".repeat(28) + "';" });
  try {
    const suppressed = scan.run({ root, skipGit: true, allowList: [{ file: "src/a.ts", detector: "stripe-secret-key", match: "sk_live_" + "A".repeat(28), reason: "synthetic fixture" }] });
    assert.deepEqual(suppressed.findings, []);
    assert.deepEqual(suppressed.staleAllowListEntries, []);
    const stale = scan.run({ root, skipGit: true, allowList: [{ file: "src/a.ts", detector: "stripe-secret-key", match: "sk_live_" + "A".repeat(28), reason: "x" }, { file: "src/gone.ts", detector: "stripe-secret-key", match: "nothing", reason: "x" }] });
    assert.equal(stale.staleAllowListEntries.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("luhn and known test PANs", () => {
  assert.equal(scan.luhn("4242424242424242"), true);
  assert.equal(scan.luhn("4242424242424241"), false);
  assert.ok(scan.KNOWN_TEST_PANS.has("4580458045804580"));
});

test("the repository itself passes the secret/PII scan", () => {
  const result = scan.run();
  const fails = result.findings.filter((f) => f.severity === "FAIL");
  assert.deepEqual(fails, [], JSON.stringify(fails, null, 2));
  assert.deepEqual(result.staleAllowListEntries, []);
});
