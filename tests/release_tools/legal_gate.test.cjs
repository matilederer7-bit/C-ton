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
  "src/notification_templates.ts",
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
    expect: /no longer pins no distributor business role[^\n]*docs\/DISTRIBUTOR_TERMS_HE\.md/
  }
  ,
  // Second independent review pass (findings 1-4 on head 3f94796).
  {
    name: "a positive distributor role reuses the tail of the negation phrase",
    file: "src/legal_pages.ts",
    from: "יצירת הלינק או מסירתו אינה יוצרת בסיטון משתמש או תפקיד עסקי בשם \"מפיץ\".",
    to: "יצירת הלינק או מסירתו יוצרת בסיטון תפקיד עסקי בשם \"מפיץ\" הזכאי לעמלה.",
    expect: /distributor-role wording returned[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "the seller terms let the seller appoint a distributor",
    file: "docs/SELLER_TERMS_HE.md",
    from: "המוכר אחראי להוצאת מסמכים חשבונאיים",
    to: "המוכר רשאי למנות גורם לתפקיד עסקי בשם \"מפיץ\". המוכר אחראי להוצאת מסמכים חשבונאיים",
    expect: /distributor-role wording returned[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "'the link distributors get a commission' hides behind the verb allowance",
    file: "frontend/app.js",
    from: "ומפיצים לינק ישיר לקונים</h1>",
    to: "ומפיצים לינק ישיר לקונים</h1><p>המפיצים לינקים מקבלים עמלה</p>",
    expect: /distributor-role wording returned[^\n]*frontend\/app\.js:/
  },
  {
    name: "the fee becomes overridable with other wording (agreed otherwise in writing)",
    file: "src/legal_pages.ts",
    from: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%.",
    to: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%, אלא אם סוכם אחרת בכתב.",
    expect: /fixed 8% Siton fee overridable[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "a selected-seller reduced fee appears",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. מוכרים נבחרים זכאים לעמלה מופחתת.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "a contract exception is placed on the line BEFORE the fee paragraph",
    file: "docs/SELLER_TERMS_HE.md",
    from: "המוכר אחראי להוצאת מסמכים חשבונאיים אם אינו מחובר למערכת חשבוניות.",
    to: "המוכר אחראי להוצאת מסמכים חשבונאיים אם אינו מחובר למערכת חשבוניות.\n\nככל שלא הוסכם אחרת בהסכם כתוב בין C-ton למוכר:",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "English copy makes the fee overridable",
    file: "web/src/i18n/dictionaries/en.ts",
    from: "\"legal.nav.affiliates\": \"Distribution link terms\",",
    to: "\"legal.nav.affiliates\": \"Distribution link terms\",\n  \"legal.fee_note\": \"Siton charges 8% unless otherwise agreed in writing\",",
    expect: /English copy makes the fixed 8% Siton fee overridable/
  },
  {
    name: "the distribution-link terms document turns the no-commission sentence positive",
    file: "docs/DISTRIBUTOR_TERMS_HE.md",
    from: "C-ton אינה מחשבת, צוברת, גובה או משלמת עמלה לגורם חיצוני בגין הפצה",
    to: "C-ton מחשבת וצוברת עמלה לגורם חיצוני בגין הפצה ומשלמת אותה מדי חודש",
    expect: /positive external-distribution money statement[^\n]*docs\/DISTRIBUTOR_TERMS_HE\.md:/
  },
  {
    name: "the served /legal/affiliates page turns the no-commission sentence positive",
    file: "src/legal_pages.ts",
    from: "C-ton אינה מחשבת עמלה לגורם חיצוני בגין הפצה.",
    to: "C-ton מחשבת עמלה לגורם חיצוני בגין הפצה ומעבירה לו תשלום.",
    expect: /positive external-distribution money statement[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "the link viewer no-PII sentence is removed from the served page",
    file: "src/legal_pages.ts",
    from: "היא אינה כוללת מידע אישי על קונים.",
    to: "היא כוללת את פרטי הקונים.",
    expect: /no longer pins aggregate-only link viewer/
  },
  {
    name: "a notification template names a distributor",
    file: "src/notification_templates.ts",
    from: "\n",
    to: "\n// המפיץ שלך הביא 3 הצטרפויות\n",
    expect: /distributor-role wording returned[^\n]*src\/notification_templates\.ts:/
  },
  // Third independent review pass (P2 findings on head 9caf45d).
  {
    name: "the fee becomes 'as otherwise determined' between C-ton and the seller",
    file: "src/legal_pages.ts",
    from: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%.",
    to: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%, או כפי שנקבע אחרת בין C-ton למוכר.",
    expect: /fixed 8% Siton fee overridable[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "an override hides behind the lawful-exception wording",
    file: "src/legal_pages.ts",
    from: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%.",
    to: "עבור שירותי הפלטפורמה, C-ton גובה עמלה קבועה בשיעור 8%, אלא אם הדבר נדרש לפי דין או שנקבע אחרת בין הצדדים.",
    expect: /fixed 8% Siton fee overridable[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "buyer copy outside the legal documents adds an exception to 'no actual charge before success'",
    file: "frontend/index.html",
    from: "</body>",
    to: "<p>לא מתבצע חיוב בפועל עד סגירת העסקה בהצלחה, אלא אם צוין אחרת בעמוד העסקה.</p></body>",
    expect: /authorization-hold-only rule[^\n]*frontend\/index\.html:/
  },
  {
    name: "a plural commission to link owners is promised",
    file: "docs/PRIVACY_POLICY_HE.md",
    from: "## למה המידע נאסף",
    to: "C-ton משלמת עמלות לבעלי לינקי הפצה.\n\n## למה המידע נאסף",
    expect: /positive external-distribution money statement[^\n]*docs\/PRIVACY_POLICY_HE\.md:/
  },
  {
    name: "an unrelated earlier negation hides a positive commission after 'אך'",
    file: "docs/PRIVACY_POLICY_HE.md",
    from: "## למה המידע נאסף",
    to: "C-ton אינה מנפיקה חשבונית, אך מחשבת עמלה לגורם חיצוני בגין הפצה.\n\n## למה המידע נאסף",
    expect: /positive external-distribution money statement[^\n]*docs\/PRIVACY_POLICY_HE\.md:/
  },
  {
    name: "the verb 'distribute the link' is paired with a reward",
    file: "frontend/app.js",
    from: "ומפיצים לינק ישיר לקונים</h1>",
    to: "ומפיצים לינק ישיר לקונים ומקבלים עמלה</h1>",
    expect: /distribution wording tied to a fee[^\n]*frontend\/app\.js:/
  },
  // Fourth independent review pass (P1 + P2 findings on head d88a3da).
  {
    name: "the seller terms describe a 'fixed rate per deal' (fixed does not excuse a per-deal rate)",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton: שיעור קבוע לפי עסקה, כפי שמופיע בדף העסקה.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a 'fixed fee per seller'",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. העמלה קבועה לפי מוכר.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a hedged negation ('not necessarily for every deal')",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. העמלה היא 8%, ולא בהכרח לכל עסקה.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a reduced C-ton fee for selected sellers",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton מופחתת ל-5% למוכרים נבחרים.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a discount on the fee",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. C-ton מעניקה הנחה של 2% על העמלה.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a fee that varies by deal type",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton משתנה בהתאם לסוג העסקה.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe an 'up to 8%' fee",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton היא עד 8%.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a fee range",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלה של 5%–8%.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a fee declared not fixed",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. שיעור העמלה אינו קבוע.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "a commission per join that came through a distribution link",
    file: "docs/PRIVACY_POLICY_HE.md",
    from: "## למה המידע נאסף",
    to: "C-ton מחשבת עמלה לכל הצטרפות שהגיעה מלינק הפצה.\n\n## למה המידע נאסף",
    expect: /positive external-distribution money statement[^\n]*docs\/PRIVACY_POLICY_HE\.md:/
  },
  // Fifth review pass (P2 findings on head eb7c2b4).
  {
    name: "the seller terms describe a fee rate that is 'not the same for every deal'",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. שיעור העמלה אינו זהה לכל עסקה.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a fee that is 'not uniform per seller'",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. העמלה אינה אחידה לכל מוכר.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe an exception for premium deals",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. שיעורי העמלה לא ישתנו, למעט בעסקאות פרימיום.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a minimum fee ('not less than 8%')",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton לא תפחת מ-8%.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a minimum fee ('at least 8%')",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton היא לפחות 8%.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a minimum fee ('8% and above')",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton היא 8% ומעלה.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe an 18% premium fee (a VAT-like rate that is not VAT)",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton בעסקאות פרימיום היא 18%.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the seller terms describe a fee that varies by deal type",
    file: "docs/SELLER_TERMS_HE.md",
    from: "אין שיעור עמלה שונה לעסקה.",
    to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton משתנה בהתאם לסוג העסקה.",
    expect: /fixed 8% Siton fee overridable[^\n]*docs\/SELLER_TERMS_HE\.md:/
  },
  {
    name: "the legal page qualifies 'actual charge only after lock' with an exception",
    file: "src/legal_pages.ts",
    from: "חיוב בפועל אינו מתבצע לפני שהעסקה נסגרת להצטרפות וננעלת",
    to: "חיוב בפועל יתבצע רק לאחר שהעסקה ננעלה, אלא אם צוין אחרת בדף העסקה. חיוב בפועל אינו מתבצע לפני שהעסקה נסגרת להצטרפות וננעלת",
    expect: /authorization-hold-only rule[^\n]*src\/legal_pages\.ts:/
  },
  {
    name: "the legacy shell HTML links to Distributor terms",
    file: "frontend/index.html",
    from: "</body>",
    to: "<a>תנאי מפיצים</a></body>",
    expect: /distributor-role wording returned[^\n]*frontend\/index\.html:/
  }
];

// Negative controls: legitimate copy must not trip the rules (a gate that
// fires on ordinary wording gets weakened).
for (const control of [
  { name: "the negation written with Hebrew gershayim", file: "docs/DISTRIBUTOR_TERMS_HE.md", from: "אין בסיטון משתמש או תפקיד עסקי בשם \"מפיץ\"", to: "אין בסיטון משתמש או תפקיד עסקי בשם ״מפיץ״" },
  { name: "the verb 'distribute the link' with an object marker", file: "frontend/app.js", from: "ומפיצים לינק ישיר לקונים</h1>", to: "ומפיצים את הלינק בוואטסאפ</h1>" },
  { name: "an exception required by law next to the fee", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה, אלא אם הדבר נדרש לפי דין." },
  { name: "buyers who came through a link pay as usual", file: "docs/PRIVACY_POLICY_HE.md", from: "## למה המידע נאסף", to: "קונים שהגיעו דרך לינק הפצה מבצעים תשלום רגיל.\n\n## למה המידע נאסף" },
  { name: "'8% fixed for every deal'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. העמלה היא 8% קבוע לכל עסקה." },
  { name: "'the fee rate will not change'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. שיעור העמלה לא ישתנה." },
  { name: "'the fee is not adjusted per seller'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. העמלה אינה מותאמת לפי מוכר." },
  { name: "'the fee is computed from the price after the discount'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. העמלה מחושבת מהמחיר לאחר ההנחה." },
  { name: "'who distribute a link' with the ש prefix", file: "frontend/app.js", from: "ומפיצים לינק ישיר לקונים</h1>", to: "שמפיצים קישור ישיר לקונים</h1>" },
  { name: "the verb next to the 8% fee in a hero line", file: "frontend/app.js", from: "ומפיצים לינק ישיר לקונים</h1>", to: "ומפיצים לינק, ו־C-ton גובה 8% רק מעסקה מוצלחת</h1>" },
  { name: "'the fee rate is set by the system rules and does not change'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. שיעור העמלה נקבע בחוקת המערכת ואינו משתנה." },
  { name: "'C-ton charges no fee other than 8%'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. C-ton אינה גובה עמלה אחרת מלבד 8%." },
  { name: "'buyers get a group price' next to the verb", file: "frontend/app.js", from: "ומפיצים לינק ישיר לקונים</h1>", to: "ומפיצים לינק, והקונים מקבלים מחיר קבוצתי</h1>" },
  { name: "payment details passed to the clearing party", file: "docs/PRIVACY_POLICY_HE.md", from: "## למה המידע נאסף", to: "פרטי התשלום מועברים לגורם הסליקה.\n\n## למה המידע נאסף" },
  { name: "a refund condition next to 'actual charge'", file: "docs/CANCELLATION_REFUND_POLICY_HE.md", from: "\n", to: "\nהחזר יבוצע תוך 14 יום מחיוב בפועל, אלא אם המוצר כבר סופק.\n" },
  { name: "a fixed fee 'that cannot be changed' (ש-prefixed negation)", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. עמלה קבועה שלא ניתן לשנות." },
  { name: "'a fee rate that does not change'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. שיעור עמלה שאינו משתנה." },
  { name: "'the fee is computed according to the amount actually collected'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. עמלת C-ton מחושבת בהתאם לסכום שנגבה בפועל." },
  { name: "'the fee AMOUNT varies with participants; the rate is fixed 8%'", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. סכום העמלה בשקלים משתנה לפי מספר המשתתפים; השיעור קבוע 8%." },
  { name: "VAT at 18% on the fee", file: "docs/SELLER_TERMS_HE.md", from: "אין שיעור עמלה שונה לעסקה.", to: "אין שיעור עמלה שונה לעסקה. על עמלת C-ton יחול מע״מ בשיעור 18%." },
  { name: "Siton's own fee is also collected on link-sourced joins", file: "docs/PRIVACY_POLICY_HE.md", from: "## למה המידע נאסף", to: "עמלת C-ton נגבית גם על הצטרפויות שהגיעו מלינק הפצה.\n\n## למה המידע נאסף" }
]) {
  test("legal gate still passes on legitimate copy: " + control.name, () => {
    const fixture = createFixtureRepo(FIXTURE_FILES);
    try {
      fixture.mutate(control.file, control.from, control.to);
      const result = runGate(fixture);
      assert.equal(result.status, 0, result.out);
    } finally {
      fixture.cleanup();
    }
  });
}

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
