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
const distributorTerms = norm(read("docs/DISTRIBUTOR_TERMS_HE.md"));
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

for (const link of ["/app/terms", "/app/privacy", "/app/refunds", "/app/accessibility", "/app/seller-terms", "/app/distributor-terms"]) {
  if (!app.includes(link) && !runtime.includes(link)) failures.push("missing policy link: " + link);
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

const distributorModule = runtime + "\n" + app;
for (const term of ["commission", "balance", "withdrawal", "affiliate_fee", "distributor_commission"]) {
  const re = new RegExp("affiliate[^\\n]{0,80}" + term + "|distributor[^\\n]{0,80}" + term, "i");
  if (re.test(distributorModule)) failures.push("distributor module contains forbidden money term: " + term);
}
if (!/(אינו מקבל מידע אישי|לא יקבל מידע אישי)/.test(distributorTerms) || !distributorTerms.includes("אין עמלה")) failures.push("distributor terms do not pin attribution-only/no-PII/no-commission posture");

{
  const routeStart = runtime.indexOf('app.get("/api/affiliate/overview"');
  if (routeStart < 0) failures.push("affiliate overview route not found in src/frontend_runtime.ts (cannot verify distributor PII boundary)");
  else {
    const separator = runtime.indexOf("// ---------------------------------------------------------------------------", routeStart);
    const affiliateBlock = runtime.slice(routeStart, separator > routeStart ? separator : routeStart + 20000);
    for (const pii of ["buyer_id", "buyer_phone", "buyer_email", "buyer_name", "delivery_address"]) {
      if (affiliateBlock.includes(pii)) failures.push("buyer PII appears in distributor API block: " + pii);
    }
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
