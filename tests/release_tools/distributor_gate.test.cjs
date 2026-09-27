// Controls for scripts/distributor_attribution_only_gate.cjs.
//
//   attribution-only src/                              => PASS
//   distributor money identifier in src/               => FAIL (money check)
//   removed distributor identity token in src/         => FAIL (identity residue)
//   the same token in src/migrations or legal_pages.ts => not a finding
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFixtureRepo } = require("./support/fixture_repo.cjs");

const GATE = "scripts/distributor_attribution_only_gate.cjs";

function fixture() {
  const repo = createFixtureRepo([GATE], { nodeModules: false });
  repo.write("src/attribution.ts", [
    'const affiliateClicks = 42;',
    'app.post("/api/affiliate/links/visit", handler);',
    'const shareLink = `/app/deal/${dealId}?ref=${sourceCode}`;'
  ].join("\n"));
  repo.write("src/migrations/048_internal_identity_sessions.sql", "CREATE TABLE IF NOT EXISTS siton.distributor_sessions (session_id UUID);\n");
  repo.write("src/legal_pages.ts", 'const legacyLink = "/app/distributor-terms";\n');
  return repo;
}

function runGate(repo) {
  const result = repo.run(GATE);
  return { status: result.status, out: String(result.stdout || "") + String(result.stderr || "") };
}

test("distributor gate self-test passes", () => {
  const repo = fixture();
  try {
    const result = repo.run(GATE, ["--self-test"]);
    assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
    assert.match(String(result.stdout), /self-test: PASS/);
  } finally {
    repo.cleanup();
  }
});

test("distributor gate passes attribution-only code and exempts migrations plus legal text", () => {
  const repo = fixture();
  try {
    const result = runGate(repo);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /money check PASS/);
    assert.match(result.out, /identity residue check PASS/);
    assert.doesNotMatch(result.out, /048_internal_identity_sessions|legal_pages/);
  } finally {
    repo.cleanup();
  }
});

const RESIDUE = [
  ["distributor_identity", 'import { resolveDistributorContext } from "./distributor_identity.js";'],
  ["/api/distributor/", 'app.get("/api/distributor/session", handler);'],
  ["distributor_sessions", 'await c.query("DELETE FROM siton.distributor_sessions");'],
  ["DISTRIBUTOR_SESSION_SECRET", 'const secret = process.env.DISTRIBUTOR_SESSION_SECRET;'],
  ["requireDistributor", 'const ctx = await requireDistributor(req, reply);'],
  ["distributor_auth_unavailable", 'return reply.code(503).send({ error: "distributor_auth_unavailable" });'],
  ["/app/affiliate", 'app.get("/app/affiliate", sendShell);'],
  ["/app/distributor-terms", 'app.get("/app/distributor-terms", sendShell);'],
  ["/api/affiliate/overview", 'app.get("/api/affiliate/overview", handler);'],
  ["distributor-auth", 'app.post("/api/admin/distributor-auth/:affiliateId/provision", handler);']
];

for (const [token, line] of RESIDUE) {
  test("distributor gate fails on identity residue: " + token, () => {
    const repo = fixture();
    try {
      repo.write("src/residue.ts", line + "\n");
      const result = runGate(repo);
      assert.notEqual(result.status, 0, "gate should fail on " + token + "\n" + result.out);
      assert.match(result.out, /identity residue check FAIL/);
      assert.match(result.out, new RegExp("src[\\\\/]residue\\.ts:1 forbidden identity token: " + token.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
      assert.match(result.out, /money check PASS/, "the money check must stay intact");
    } finally {
      repo.cleanup();
    }
  });
}

test("distributor gate still fails on a distributor money identifier", () => {
  const repo = fixture();
  try {
    repo.write("src/money.ts", "const distributorCommissionRate = 0.05;\n");
    const result = runGate(repo);
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /money check FAIL/);
    assert.match(result.out, /src[\\/]money\.ts:1 forbidden token: distributorCommission/);
    assert.match(result.out, /identity residue check PASS/);
  } finally {
    repo.cleanup();
  }
});
