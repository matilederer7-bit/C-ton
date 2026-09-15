// Controls for scripts/legal_compliance_gate.cjs.
//
//   real repository                          => PASS (with the documented owner-decision warning)
//   legal prose that says CVV is NOT stored  => not a finding
//   code that handles a CVV field            => FAIL
//   unconditional seller KYC refusal         => FAIL
//   age gate / marketing opt-in surfaces     => FAIL
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFixtureRepo } = require("./support/fixture_repo.cjs");

const FIXTURE_FILES = [
  "frontend/app.js",
  "frontend/index.html",
  "src/frontend_runtime.ts",
  "src/app.ts",
  "src/legal_pages.ts",
  "src/admin_mission_control.ts",
  "src/payment_provider.ts",
  "docs/ACCESSIBILITY_COMPLIANCE.md",
  "docs/PRIVACY_DATA_MAP.md",
  "docs/PRIVACY_POLICY_HE.md",
  "docs/INFORMATION_SECURITY_POLICY.md",
  "docs/PAYMENT_SECURITY_AND_PCI_SCOPE.md",
  "docs/BUYER_TERMS_HE.md",
  "docs/CANCELLATION_REFUND_POLICY_HE.md",
  "docs/SELLER_TERMS_HE.md",
  "docs/SELLER_KYC_POLICY.md",
  "docs/DISTRIBUTOR_TERMS_HE.md",
  "docs/ADMIN_LEGAL_OPS_POLICY.md",
  "config/raw-card-term-allowlist.json",
  "scripts/lib",
  "scripts/compliance_payment_scan.cjs",
  "scripts/legal_compliance_gate.cjs"
];

function runGate(fixture) {
  const result = fixture.run("scripts/legal_compliance_gate.cjs");
  return { status: result.status, out: String(result.stdout || "") + String(result.stderr || "") };
}

test("legal gate passes on the real product, keeps the CVV disclosure sentence, and reports the production KYC step as an owner decision", () => {
  const fixture = createFixtureRepo(FIXTURE_FILES);
  try {
    assert.match(fixture.read("src/legal_pages.ts"), /CVV/, "fixture must carry the legal CVV disclosure sentence");
    const result = runGate(fixture);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /LEGAL_COMPLIANCE_GATE_PASS/);
    assert.match(result.out, /OWNER_DECISION seller publish requires verification_status=approved in production-like environments/);
    assert.doesNotMatch(result.out, /legal_pages/);
  } finally {
    fixture.cleanup();
  }
});

const MUTATIONS = [
  {
    name: "server code reads a CVV field from the request body",
    file: "src/app.ts",
    from: "app.get(\"/health\", async () => ({ ok: true }));",
    to: "app.get(\"/health\", async (req: any) => ({ ok: true, cvv: req.body?.cvv }));",
    expect: /forbidden raw payment term cvv/
  },
  {
    name: "seller KYC refusal is no longer restricted to production-like environments",
    file: "src/app.ts",
    from: "if (isProductionLike && String(prof.verification_status || \"pending\") !== \"approved\") {",
    to: "if (String(prof.verification_status || \"pending\") !== \"approved\") {",
    expect: /not restricted to production-like environments/
  },
  {
    name: "an age gate appears in the frontend",
    file: "frontend/app.js",
    from: "aria-live=\"polite\"",
    to: "aria-live=\"polite\" data-age-gate=\"18\"",
    expect: /age gate/
  },
  {
    name: "a marketing opt-in surface appears in the runtime",
    file: "src/frontend_runtime.ts",
    from: "app.get(\"/health/integrations\"",
    to: "app.get(\"/api/marketing_consent\", async () => ({ ok: true }));\n  app.get(\"/health/integrations\"",
    expect: /marketing opt-in/
  },
  {
    name: "buyer PII leaks into the distributor overview block",
    file: "src/frontend_runtime.ts",
    from: "app.get(\"/api/affiliate/overview\"",
    to: "app.get(\"/api/affiliate/overview\" /* buyer_phone */",
    expect: /buyer PII appears in distributor API block/
  }
];

for (const mutation of MUTATIONS) {
  test("legal gate fails when: " + mutation.name, () => {
    const fixture = createFixtureRepo(FIXTURE_FILES);
    try {
      fixture.mutate(mutation.file, mutation.from, mutation.to);
      const result = runGate(fixture);
      assert.notEqual(result.status, 0, "gate should fail: " + mutation.name + "\n" + result.out);
      assert.match(result.out, /LEGAL_COMPLIANCE_GATE_FAIL/);
      assert.match(result.out, mutation.expect);
    } finally {
      fixture.cleanup();
    }
  });
}
