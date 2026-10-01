// Legal / lean-compliance gate.
//
// Proves the lean legal posture (no age gate, no forced terms popup, no
// marketing opt-in, no default deal-approval queue, no free manual refund
// surface, distributor attribution-only, buyer disclosure copy present,
// required policy documents present) against the product code.
//
// Hardened from the original text scanner:
//   - The raw-card term check is delegated to the shared SEMANTIC scanner
//     (scripts/lib/raw_card_terms.cjs via compliance_payment_scan.run). A
//     legal sentence stating that CVV is NOT stored is no longer a finding.
//   - Several regexes used `[^\\n]` (a JS regex class meaning "not a backslash
//     or the letter n", which spans lines) where `[^\n]` was intended. Fixed.
//   - The affiliate API block extraction fails explicitly when the route is
//     not found instead of slicing garbage.
//   - The seller KYC check is now an intentional, narrower invariant: a KYC
//     approval requirement must never apply outside production-like
//     environments (lean pilot/demo onboarding). The production-only approval
//     gate that exists in src/app.ts is reported as a WARNING carrying an
//     owner decision, not silently accepted and not falsely failed.
// Controls live in tests/release_tools/legal_gate.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const ast = require("./lib/ts_ast.cjs");
const paymentScan = require("./compliance_payment_scan.cjs");

const ts = ast.ts;
const root = process.cwd();
const requiredDocs = [
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
  "docs/ADMIN_LEGAL_OPS_POLICY.md"
];

const failures = [];
const warnings = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const has = (text, pattern) => (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern));
const norm = (text) => String(text).replace(/\s+/g, " ");

for (const doc of requiredDocs) if (!exists(doc)) failures.push("missing required document: " + doc);

const app = read("frontend/app.js");
const runtime = read("src/frontend_runtime.ts");
const server = read("src/app.ts");
const buyerTerms = norm(read("docs/BUYER_TERMS_HE.md"));
const privacy = norm(read("docs/PRIVACY_POLICY_HE.md"));
const sellerTerms = norm(read("docs/SELLER_TERMS_HE.md"));
const sellerKyc = norm(read("docs/SELLER_KYC_POLICY.md"));
const refundPolicy = norm(read("docs/CANCELLATION_REFUND_POLICY_HE.md"));
const distributionTerms = norm(read("docs/DISTRIBUTOR_TERMS_HE.md"));
const legalPages = norm(read("src/legal_pages.ts"));
const combinedProduct = app + "\n" + runtime + "\n" + server;
const combinedProductNoComments = ast.stripComments(app, "app.js") + "\n" + ast.stripComments(runtime, "frontend_runtime.ts") + "\n" + ast.stripComments(server, "app.ts");

for (const forbidden of ["שלם עכשיו", "התשלום בוצע", "רכישה הושלמה"]) {
  if (app.includes(forbidden)) failures.push("forbidden auth-hold copy appears in frontend: " + forbidden);
}

for (const forbidden of [/age[_-]?gate/i, /בן 18/, /18 ומעלה/, /אני בן.*18/, /גיל 18/]) {
  if (has(combinedProduct, forbidden) || has(buyerTerms + "\n" + privacy + "\n" + sellerTerms, forbidden)) failures.push("age gate / 18+ language found: " + forbidden);
}

if (/buyer_terms_accepted/.test(app + "\n" + server) || /buyer_terms_required/.test(server)) failures.push("forced buyer terms consent is still enforced in product flow");

if (/terms[^\n]{0,80}(modal|popup)|modal[^\n]{0,80}terms|popup[^\n]{0,80}terms/i.test(combinedProductNoComments)) failures.push("forced terms popup/modal pattern found");

for (const link of ["/app/terms", "/app/privacy", "/app/refunds", "/app/accessibility", "/app/seller-terms"]) {
  if (!app.includes(link) && !runtime.includes(link)) failures.push("missing policy link: " + link);
}

// Distribution-link terms keep the legacy /legal/affiliates compatibility path,
// but the product must not reintroduce a distributor/affiliate business role.
{
  if (!/slug:\s*"affiliates"/.test(legalPages)) failures.push("distribution-link legal page compatibility slug \"affiliates\" is missing from src/legal_pages.ts");
  if (!/title:\s*"תנאי לינקי הפצה"/.test(legalPages)) failures.push("distribution-link legal page must be titled תנאי לינקי הפצה");
  if (/title:\s*"תנאי מפיצים"/.test(legalPages)) failures.push("obsolete distributor-role title returned to the legal page");
  if (!/אין בסיטון משתמש או תפקיד עסקי בשם "מפיץ"/.test(legalPages)) failures.push("legal page must explicitly state that Siton has no distributor business role");
  if (!app.includes("/legal/affiliates")) failures.push("missing compatibility policy link: /legal/affiliates");
}

for (const requiredCopy of ["מחיר ליחידה", "כמות", "משלוח", "סך הכול", "תפיסת מסגרת בלבד"]) {
  if (!app.includes(requiredCopy)) failures.push("missing buyer price/auth-hold disclosure copy: " + requiredCopy);
}

if (!/90%/.test(app) || !/90%/.test(buyerTerms) || !/90%/.test(sellerTerms)) failures.push("90% rule is missing from buyer/seller surfaces");

if (/manual refund|refund button|free refund|כפתור החזר חופשי|החזר ידני חופשי/i.test(combinedProductNoComments) && !/אין כפתור החזר חופשי/.test(refundPolicy)) failures.push("manual free refund surface found");

if (/deal[^\n]{0,80}(approval queue|approval flow|required approval)|approval[^\n]{0,80}(every deal|all deals)/i.test(combinedProductNoComments)) failures.push("deal approval flow appears to be required");

// Seller KYC: lean onboarding. An approval requirement must never apply outside
// production-like environments. Each refusal site is located by AST and must be
// nested under a condition that references the production-like predicate.
{
  const serverFile = ast.parse(path.join(root, "src/app.ts"), server);
  const refusalSites = ast.collect(serverFile, (node) => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "code"
    && ast.stringLiteralValue(node.right) === "seller_kyc_not_approved");
  for (const site of refusalSites) {
    let guarded = false;
    let cursor = site.parent;
    while (cursor && !ts.isSourceFile(cursor)) {
      if (ts.isIfStatement(cursor) && /isProductionLike|IS_PRODUCTION_LIKE|productionLike/.test(cursor.expression.getText(serverFile))) { guarded = true; break; }
      if (ts.isFunctionLike(cursor)) break;
      cursor = cursor.parent;
    }
    const pos = serverFile.getLineAndCharacterOfPosition(site.getStart(serverFile));
    if (!guarded) failures.push("seller KYC approval refusal at src/app.ts:" + (pos.line + 1) + " is not restricted to production-like environments (lean onboarding requires no KYC gate in demo/pilot)");
    else warnings.push("OWNER_DECISION seller publish requires verification_status=approved in production-like environments (src/app.ts:" + (pos.line + 1) + "). Lean onboarding holds outside production; confirm the production approval step is intended before launch.");
  }
  if (/cannot publish.*basic approval/i.test(sellerKyc) || /manual admin approval requirement for every seller/i.test(server)) failures.push("heavy seller KYC/admin approval gate wording is present");
}

for (const forbidden of [/marketing_consent/i, /newsletter/i, /marketing opt[-_ ]?in/i, /שיווקי[^\n]{0,40}checkbox/, /דיוור עסקאות אחרות/]) {
  if (has(combinedProductNoComments, forbidden)) failures.push("marketing opt-in/product marketing surface found: " + forbidden);
}
if (!privacy.includes("C-ton אינה שולחת הודעות שיווקיות") || !privacy.includes("הודעות תפעוליות")) failures.push("privacy policy does not state no marketing and operational messages only");
if (!buyerTerms.includes("C-ton אינה שולחת הודעות שיווקיות")) failures.push("buyer terms do not state no marketing messages");

// Raw cardholder data: shared semantic scanner (identifiers, keys, columns,
// form fields), never prose.
{
  const scan = paymentScan.run();
  for (const hit of scan.findings) failures.push(hit.rel + ":" + hit.line + ": " + hit.kind + " \"" + hit.identifier + "\" matches forbidden raw payment term " + hit.term);
  for (const entry of scan.unusedAllowListEntries) failures.push("stale raw-card allow-list entry: " + entry.file + " " + entry.identifier);
}

const distributionModule = runtime + "\n" + app;
for (const term of ["commission", "balance", "withdrawal", "affiliate_fee", "distributor_commission"]) {
  const re = new RegExp("affiliate[^\\n]{0,80}" + term + "|distributor[^\\n]{0,80}" + term, "i");
  if (re.test(distributionModule)) failures.push("distribution-link module contains forbidden external-money term: " + term);
}
if (!/אינו מקבל מידע אישי|אינה כוללת.*מידע אישי|אין גישה.*מידע אישי/.test(distributionTerms)
    || !/אינה מחשבת.*עמלה|אין.*עמלה/.test(distributionTerms)
    || !/אין בסיטון משתמש או תפקיד עסקי בשם "מפיץ"/.test(distributionTerms)) {
  failures.push("distribution-link terms do not pin no-role / aggregate-only / no-commission posture");
}

{
  // The only remaining affiliate route is the anonymous visit recorder. It
  // measures clicks/entries by source code and must never touch buyer PII.
  const routeStart = runtime.indexOf('app.post("/api/affiliate/links/visit"');
  if (routeStart < 0) failures.push("legacy affiliate visit route not found in src/frontend_runtime.ts (cannot verify distribution-link PII boundary)");
  else {
    const routeEnd = runtime.indexOf("\n  });\n", routeStart);
    const affiliateBlock = runtime.slice(routeStart, routeEnd > routeStart ? routeEnd : routeStart + 4000);
    for (const pii of ["buyer_id", "buyer_phone", "buyer_email", "buyer_name", "delivery_address"]) {
      if (affiliateBlock.includes(pii)) failures.push("buyer PII appears in distribution-link API block: " + pii);
    }
  }
}

// ── Distribution-link model and the fixed 8% fee (owner rules) ─────────────
// Siton has no distributor/affiliate business role, and its fee is a system
// constant with no per-deal or written-contract override; a buyer join is an
// authorization hold only. These rules are enforced over EVERY surface a
// reader can see — the served legal pages, the Hebrew legal documents, the
// legacy shell, runtime-rendered copy, API copy, the React app and the i18n
// sources — line by line, so restoring old wording anywhere (a title, a nav
// label, a heading, a definition, an override placed before or after "8%")
// fails. A missing surface fails closed.
{
  const SURFACE_FILES = [
    "src/legal_pages.ts", "frontend/app.js", "src/frontend_runtime.ts", "src/app.ts",
    "src/seller_analytics.ts", "src/distribution_hub.ts",
    "docs/DISTRIBUTOR_TERMS_HE.md", "docs/SELLER_TERMS_HE.md", "docs/BUYER_TERMS_HE.md",
    "docs/PRIVACY_POLICY_HE.md", "docs/CANCELLATION_REFUND_POLICY_HE.md",
    "web/src/i18n/dictionaries/he.ts", "web/src/i18n/dictionaries/en.ts",
    "scripts/i18n/seed.he.json", "scripts/i18n/extracted.he.json", "scripts/i18n/en.json"
  ];
  const SURFACE_TREES = ["web/src"];
  const SURFACE_EXT = /\.(?:ts|tsx|js|jsx|cjs|mjs|json|html|md)$/;
  const surfaces = new Map();
  for (const rel of SURFACE_FILES) {
    if (!exists(rel)) { failures.push("distribution-link rule surface missing: " + rel); continue; }
    surfaces.set(rel, read(rel));
  }
  for (const docRel of fs.readdirSync(path.join(root, "docs")).filter((name) => /_HE\.md$/.test(name)).map((name) => "docs/" + name)) {
    if (!surfaces.has(docRel)) surfaces.set(docRel, read(docRel));
  }
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) { failures.push("distribution-link rule surface tree missing: " + rel); return; }
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = rel + "/" + entry.name;
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(child); }
      else if (SURFACE_EXT.test(entry.name) && !surfaces.has(child)) surfaces.set(child, read(child));
    }
  };
  for (const tree of SURFACE_TREES) walk(tree);

  // The only Hebrew "distributor" words a reader may meet: the explicit
  // negation ("no business role named distributor") and the verb "distribute
  // a link". Anything else is the role coming back.
  const ALLOWED_DISTRIBUTOR_WORDS = [/תפקיד עסקי בשם "?מפיץ"?/g, /מפיצים לינק/g];
  const ENGLISH_ROLE = /\b(?:distributors?|affiliates?)\b/i;
  const ENGLISH_DICTIONARIES = new Set(["web/src/i18n/dictionaries/en.ts", "scripts/i18n/en.json"]);
  const FEE_OR_CHARGE = /עמל|8%|8 אחוז|חיוב|תפיסת מסגרת/;
  const EXCEPTION = /אלא אם (?:כן )?(?:נקבע|יוסכם|הוסכם|צוין|יצוין)|ככל שלא (?:נקבע|הוסכם|צוין)|הסכם כתוב|בהסכם|לפי הסכם|שיעור (?:ה)?עמלה (?:ש)?(?:ייקבע|יקבע|יוגדר|ישתנה|יכול להשתנות|מותאם)|(?:ייקבע|יקבע|יוגדר|תיקבע|תוגדר) (?:לכל|בכל|ברמת|לפי) עסקה/;
  for (const [rel, text] of surfaces) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const where = rel + ":" + (index + 1);
      let stripped = line;
      for (const allowed of ALLOWED_DISTRIBUTOR_WORDS) stripped = stripped.replace(allowed, "");
      if (/מפיצ|מפיץ/.test(stripped)) failures.push("distributor-role wording returned (no distributor business role exists): " + where);
      if (ENGLISH_DICTIONARIES.has(rel)) {
        const entry = /^\s*"[^"]+"\s*:\s*"(.*)"\s*,?\s*$/.exec(line);
        if (entry && ENGLISH_ROLE.test(entry[1])) failures.push("distributor/affiliate role wording returned in English copy: " + where);
      }
      // An exception clause is a finding when the fee / charge it qualifies is
      // on the same line or one of the two lines before it (a following
      // sentence such as "8%. Unless otherwise agreed in writing." counts).
      if (EXCEPTION.test(line) && FEE_OR_CHARGE.test(lines.slice(Math.max(0, index - 2), index + 1).join("\n"))) {
        failures.push("legal copy makes the fixed 8% Siton fee overridable or adds an exception to the authorization-hold-only rule: " + where);
      }
    });
  }

  const quoteNorm = (text) => norm(text).replace(/״/g, "\"");
  const pins = [
    ["src/legal_pages.ts", "אין שיעור עמלה שונה לעסקה", "the fixed 8% fee (no per-deal rate)"],
    ["docs/SELLER_TERMS_HE.md", "אין שיעור עמלה שונה לעסקה", "the fixed 8% fee (no per-deal rate)"],
    ["frontend/app.js", "אין שיעור עמלה שונה לעסקה", "the fixed 8% fee (no per-deal rate)"],
    ["src/legal_pages.ts", "בהצטרפות לעסקה מתבצעת תפיסת מסגרת אשראי בלבד", "authorization hold only on join"],
    ["src/legal_pages.ts", "חיוב בפועל אינו מתבצע לפני שהעסקה נסגרת להצטרפות וננעלת", "no charge before close/lock"],
    ["docs/DISTRIBUTOR_TERMS_HE.md", "אין בסיטון משתמש או תפקיד עסקי בשם \"מפיץ\"", "no distributor business role"]
  ];
  for (const [rel, phrase, rule] of pins) {
    if (surfaces.has(rel) && !quoteNorm(surfaces.get(rel)).includes(phrase)) failures.push("legal copy no longer pins " + rule + ": " + rel);
  }
  if (!/8%[^\n]{0,260}למעט רכיב המע"מ של הלקוח/.test(quoteNorm(read("src/legal_pages.ts")))
      || !/8%[^\n]{0,260}למעט רכיב המע"מ של הלקוח/.test(quoteNorm(read("docs/SELLER_TERMS_HE.md")))) {
    failures.push("legal copy does not pin the 8% fee base to collected amount excluding the customer's VAT component");
  }
}

if (!app.includes("sellerPublishCriticalTermsAccepted") || !app.includes("sellerPublishThresholdAccepted")) failures.push("seller publish operational confirmations are missing");
if (!server.includes("seller_critical_terms_accepted") || !server.includes("seller_threshold_90_accepted")) failures.push("server publish endpoint does not require seller critical-terms and 90% confirmations");
if (!sellerKyc.includes("basic identification details") || !sellerKyc.includes("can continue automatically")) failures.push("lean seller identification policy is missing or too heavy");
for (const required of ["לא חוקי", "מזויף", "מפר זכויות", "להסיר עסקה", "לחסום מוכר", "בדיעבד"]) {
  if (!sellerTerms.includes(required)) failures.push("seller terms missing enforcement/product legality language: " + required);
}

const indexHtml = read("frontend/index.html");
if (!app.includes("aria-live=\"polite\"") || !indexHtml.includes("skip-link") || !indexHtml.includes("main-content")) failures.push("accessibility baseline is incomplete");

if (failures.length) {
  console.error("LEGAL_COMPLIANCE_GATE_FAIL");
  for (const failure of failures) console.error("- " + failure);
  for (const warning of warnings) console.error("- WARNING " + warning);
  process.exit(1);
}

console.log(warnings.length ? "LEGAL_COMPLIANCE_GATE_PASS_WITH_WARNINGS" : "LEGAL_COMPLIANCE_GATE_PASS");
for (const warning of warnings) console.log("- WARNING " + warning);
