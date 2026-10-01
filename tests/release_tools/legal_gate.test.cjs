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
  "src/seller_analytics.ts",
  "src/distribution_hub.ts",
  "web/src",
  "scripts/i18n/seed.he.json",
  "scripts/i18n/extracted.he.json",
  "scripts/i18n/en.json",
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
    name: "buyer PII leaks into the affiliate visit recorder block",
    file: "src/frontend_runtime.ts",
    from: "app.post(\"/api/affiliate/links/visit\"",
    to: "app.post(\"/api/affiliate/links/visit\" /* buyer_phone */",
    expect: /buyer PII appears in distribution-link API block/
  },
  {
    name: "the distribution-link terms compatibility link disappears from the frontend",
    file: "frontend/app.js",
    from: "href=\"/legal/affiliates\"",
    to: "href=\"/legal/partners\"",
    all: true,
    expect: /missing compatibility policy link: \/legal\/affiliates/
  },
  {
    name: "the distribution-link terms compatibility page is removed",
    file: "src/legal_pages.ts",
    from: "slug: \"affiliates\"",
    to: "slug: \"affiliates_removed\"",
    expect: /distribution-link legal page compatibility slug/
  },
  {
    name: "the obsolete distributor-role title returns",
    file: "src/legal_pages.ts",
    from: "title: \"תנאי לינקי הפצה\"",
    to: "title: \"תנאי מפיצים\"",
    expect: /obsolete distributor-role title/
  },
  {
    name: "the legal page stops saying that Siton has no distributor business role",
    file: "src/legal_pages.ts",
    from: "אין בסיטון משתמש או תפקיד עסקי בשם \"מפיץ\".",
    to: "מפיץ הוא משתמש עסקי במערכת.",
    expect: /no distributor business role/
  },
  {
    name: "the fixed 8 percent fee becomes contract-overridable again",
    file: "src/legal_pages.ts",
    from: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%.",
    to: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%, אלא אם נקבע אחרת בהסכם כתוב.",
    expect: /fixed 8% Siton fee overridable/
  },
  // Independent review of PR #159: the rules must hold on every surface and in
  // every position, not only for the exact strings above.
  {
    name: "the pre-PR override wording returns with the exception BEFORE the 8%",
    file: "src/legal_pages.ts",
    from: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%.",
    to: "ככל שלא נקבע אחרת בהסכם כתוב, עמלת C-ton היא 8% מהסכום שנגבה בפועל.",
    expect: /fixed 8% Siton fee overridable[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "the seller terms document makes the fee contract-overridable",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה, אלא אם נקבע אחרת בהסכם כתוב.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms card in the legacy shell makes the fee contract-overridable",
    file: "frontend/app.js",
    from: "אין שיעור עמלה שונה לעסקה ואין בסיטון",
    to: "אלא אם נקבע אחרת בהסכם כתוב. ואין בסיטון",
    expect: /fixed 8% Siton fee overridable[^\n]*frontend\/app\.js:/
  },
  {
    name: "the seller terms document allows a per-deal fee rate",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "שיעור העמלה ייקבע לכל עסקה.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:|no longer pins the fixed 8% fee/
  },
  {
    name: "the join copy regains an exception to the authorization-hold-only rule",
    file: "src/legal_pages.ts",
    from: "בהצטרפות לעסקה מתבצעת תפיסת מסגרת אשראי בלבד.",
    to: "בשלב הראשון מתבצעת תפיסת מסגרת אשראי בלבד, אלא אם צוין במפורש אחרת ובכפוף לדין.",
    expect: /authorization-hold-only rule[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "the distributor role definition returns while the negation phrase stays",
    file: "src/legal_pages.ts",
    from: "לינק הפצה\nקישור ייחודי לעסקה",
    to: "מפיץ\nמשתמש או גורם שמפיץ לינק ייחודי לעסקה.\n\nלינק הפצה\nקישור ייחודי לעסקה",
    expect: /distributor-role wording returned[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "the legal page nav label returns to Distributor terms",
    file: "src/legal_pages.ts",
    from: "navLabel: \"תנאי לינקי הפצה\"",
    to: "navLabel: \"תנאי מפיצים\"",
    expect: /distributor-role wording returned[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "the distribution-link terms document heading returns to Distributor terms",
    file: "docs/DISTRIBUTOR_TERMS_HE.md",
    from: "# תנאי לינקי הפצה",
    to: "# תנאי מפיצים",
    expect: /distributor-role wording returned[^\n]*docs\/DISTRIBUTOR_TERMS_HE\.md:/
  },
  {
    name: "the Hebrew i18n dictionary nav label returns to Distributor terms",
    file: "web/src/i18n/dictionaries/he.ts",
    from: "\"legal.nav.affiliates\": \"תנאי לינקי הפצה\"",
    to: "\"legal.nav.affiliates\": \"תנאי מפיצים\"",
    expect: /distributor-role wording returned[^\n]*web\/src\/i18n\/dictionaries\/he\.ts:/
  },
  {
    name: "the English i18n dictionary nav label returns to Distributor terms",
    file: "web/src/i18n/dictionaries/en.ts",
    from: "\"legal.nav.affiliates\": \"Distribution link terms\"",
    to: "\"legal.nav.affiliates\": \"Distributor terms\"",
    expect: /role wording returned in English copy[^\n]*web\/src\/i18n\/dictionaries\/en\.ts:/
  },
  {
    name: "a React page hard-codes distributor wording",
    file: "web/src/pages/distribution.tsx",
    from: "<DistributionDisclaimer text={payload.disclaimer_he} />",
    to: "<p>מפיצים מובילים</p><DistributionDisclaimer text={payload.disclaimer_he} />",
    expect: /distributor-role wording returned[^\n]*web\/src\/pages\/distribution\.tsx:/
  },
  {
    name: "the seller analytics API disclaimer names distributors again",
    file: "src/seller_analytics.ts",
    from: "תשלום לגורם חיצוני בגין הפצה",
    to: "תשלום למפיצים",
    expect: /distributor-role wording returned[^\n]*src\/seller_analytics\.ts:/
  },
  {
    name: "the no-distributor-role statement disappears from the distribution-link terms document",
    file: "docs/DISTRIBUTOR_TERMS_HE.md",
    from: "אין בסיטון משתמש או תפקיד עסקי בשם \"מפיץ\".",
    to: "הלינק נמסר לגורם חיצוני.",
    expect: /no-role \/ aggregate-only \/ no-commission posture|no longer pins no distributor business role/
  }
];

// Negative control: the verb "distribute a link" is ordinary seller copy, not a role.
test("legal gate still passes when seller copy uses the verb 'distribute a link'", () => {
  const fixture = createFixtureRepo(FIXTURE_FILES);
  try {
    assert.match(fixture.read("frontend/app.js"), /ומפיצים לינק ישיר לקונים/);
    const result = runGate(fixture);
    assert.equal(result.status, 0, result.out);
    assert.doesNotMatch(result.out, /distributor-role wording returned/);
  } finally {
    fixture.cleanup();
  }
});

for (const mutation of MUTATIONS) {
  test("legal gate fails when: " + mutation.name, () => {
    const fixture = createFixtureRepo(FIXTURE_FILES);
    try {
      fixture.mutate(mutation.file, mutation.from, mutation.to, { all: Boolean(mutation.all) });
      const result = runGate(fixture);
      assert.notEqual(result.status, 0, "gate should fail: " + mutation.name + "\n" + result.out);
      assert.match(result.out, /LEGAL_COMPLIANCE_GATE_FAIL/);
      assert.match(result.out, mutation.expect);
    } finally {
      fixture.cleanup();
    }
  });
}
