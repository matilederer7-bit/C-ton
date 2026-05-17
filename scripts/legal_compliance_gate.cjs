const fs = require("fs");
const path = require("path");

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
const notes = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const has = (text, pattern) => (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern));

for (const doc of requiredDocs) {
  if (!exists(doc)) failures.push(`missing required document: ${doc}`);
}

const app = read("frontend/app.js");
const runtime = read("src/frontend_runtime.ts");
const server = read("src/app.ts");
const buyerTerms = read("docs/BUYER_TERMS_HE.md");
const privacy = read("docs/PRIVACY_POLICY_HE.md");
const sellerTerms = read("docs/SELLER_TERMS_HE.md");
const sellerKyc = read("docs/SELLER_KYC_POLICY.md");
const refundPolicy = read("docs/CANCELLATION_REFUND_POLICY_HE.md");
const distributorTerms = read("docs/DISTRIBUTOR_TERMS_HE.md");
const combinedProduct = `${app}\n${runtime}\n${server}`;

for (const forbidden of ["שלם עכשיו", "התשלום בוצע", "רכישה הושלמה"]) {
  if (app.includes(forbidden)) failures.push(`forbidden auth-hold copy appears in frontend: ${forbidden}`);
}

for (const forbidden of [/age[_-]?gate/i, /בן 18/, /18 ומעלה/, /אני בן.*18/, /גיל 18/]) {
  if (has(combinedProduct, forbidden) || has(`${buyerTerms}\n${privacy}\n${sellerTerms}`, forbidden)) {
    failures.push(`age gate / 18+ language found: ${forbidden}`);
  }
}

if (/buyer_terms_accepted/.test(`${app}\n${server}`) || /buyer_terms_required/.test(server)) {
  failures.push("forced buyer terms consent is still enforced in product flow");
}

if (/terms[^\\n]{0,80}(modal|popup)|modal[^\\n]{0,80}terms|popup[^\\n]{0,80}terms/i.test(combinedProduct)) {
  failures.push("forced terms popup/modal pattern found");
}

for (const link of ["/app/terms", "/app/privacy", "/app/refunds", "/app/accessibility", "/app/seller-terms", "/app/distributor-terms"]) {
  if (!app.includes(link) && !runtime.includes(link)) failures.push(`missing policy link: ${link}`);
}

for (const requiredCopy of ["מחיר ליחידה", "כמות", "משלוח", "סך הכול", "תפיסת מסגרת בלבד"]) {
  if (!app.includes(requiredCopy)) failures.push(`missing buyer price/auth-hold disclosure copy: ${requiredCopy}`);
}

if (!/90%/.test(app) || !/90%/.test(buyerTerms) || !/90%/.test(sellerTerms)) {
  failures.push("90% rule is missing from buyer/seller surfaces");
}

if (/manual refund|refund button|free refund|כפתור החזר חופשי|החזר ידני חופשי/i.test(combinedProduct) && !/אין כפתור החזר חופשי/.test(refundPolicy)) {
  failures.push("manual free refund surface found");
}

if (/deal[^\\n]{0,80}(approval queue|approval flow|required approval)|approval[^\\n]{0,80}(every deal|all deals)/i.test(combinedProduct)) {
  failures.push("deal approval flow appears to be required");
}

if (/seller_kyc_not_approved/.test(server) || /cannot publish.*basic approval/i.test(sellerKyc) || /manual admin approval requirement for every seller/i.test(server)) {
  failures.push("heavy seller KYC/admin approval gate is still present");
}

for (const forbidden of [/marketing_consent/i, /newsletter/i, /marketing opt[-_ ]?in/i, /שיווקי[^\\n]{0,40}checkbox/, /דיוור עסקאות אחרות/]) {
  if (has(combinedProduct, forbidden)) failures.push(`marketing opt-in/product marketing surface found: ${forbidden}`);
}
if (!privacy.includes("C-ton אינה שולחת הודעות שיווקיות") || !privacy.includes("הודעות תפעוליות")) {
  failures.push("privacy policy does not state no marketing and operational messages only");
}
if (!buyerTerms.includes("C-ton אינה שולחת הודעות שיווקיות")) {
  failures.push("buyer terms do not state no marketing messages");
}

const paymentTerms = [
  "card_number",
  "credit_card_number",
  "cvv",
  "cvc",
  "raw_card",
  "pan",
  "expiry_month",
  "expiry_year",
  "full_card",
  "cardholder_data"
];
const ignoredDirs = new Set([".git", "node_modules", ".tmp_test_dist", ".demo_dist", ".tmp_gate_logs"]);
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name) || entry.name.startsWith(".tmp")) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|cjs|mjs|sql|html|css)$/.test(entry.name)) out.push(rel);
  }
  return out;
}
for (const rel of walk(root)) {
  const first = rel.split(path.sep)[0];
  if (first === "docs" || first === "tests" || rel === path.join("scripts", "compliance_payment_scan.cjs") || rel === path.join("scripts", "legal_compliance_gate.cjs")) continue;
  const text = read(rel);
  for (const term of paymentTerms) {
    if (new RegExp(`\\b${term}\\b`, "i").test(text)) failures.push(`${rel}: forbidden raw payment term ${term}`);
  }
}

const distributorModule = `${runtime}\n${app}`;
for (const term of ["commission", "balance", "withdrawal", "affiliate_fee", "distributor_commission"]) {
  const re = new RegExp(`affiliate[^\\n]{0,80}${term}|distributor[^\\n]{0,80}${term}`, "i");
  if (re.test(distributorModule)) failures.push(`distributor module contains forbidden money term: ${term}`);
}
if (!/(אינו מקבל מידע אישי|לא יקבל מידע אישי)/.test(distributorTerms) || !distributorTerms.includes("אין עמלה")) {
  failures.push("distributor terms do not pin attribution-only/no-PII/no-commission posture");
}

const affiliateBlock = runtime.slice(runtime.indexOf('app.get("/api/affiliate/overview"'), runtime.indexOf("// ---------------------------------------------------------------------------", runtime.indexOf('app.get("/api/affiliate/overview"')));
for (const pii of ["buyer_id", "buyer_phone", "buyer_email", "buyer_name", "delivery_address"]) {
  if (affiliateBlock.includes(pii)) failures.push(`buyer PII appears in distributor API block: ${pii}`);
}

if (!app.includes("sellerPublishCriticalTermsAccepted") || !app.includes("sellerPublishThresholdAccepted")) {
  failures.push("seller publish operational confirmations are missing");
}
if (!server.includes("seller_critical_terms_accepted") || !server.includes("seller_threshold_90_accepted")) {
  failures.push("server publish endpoint does not require seller critical-terms and 90% confirmations");
}
if (!sellerKyc.includes("basic identification details") || !sellerKyc.includes("can continue automatically")) {
  failures.push("lean seller identification policy is missing or too heavy");
}
for (const required of ["לא חוקי", "מזויף", "מפר זכויות", "להסיר עסקה", "לחסום מוכר", "בדיעבד"]) {
  if (!sellerTerms.includes(required)) failures.push(`seller terms missing enforcement/product legality language: ${required}`);
}

const indexHtml = read("frontend/index.html");
if (!app.includes("aria-live=\"polite\"") || !indexHtml.includes("skip-link") || !indexHtml.includes("main-content")) {
  failures.push("accessibility baseline is incomplete");
}

if (failures.length) {
  console.error("LEGAL_COMPLIANCE_GATE_FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("LEGAL_COMPLIANCE_GATE_PASS");
for (const note of notes) console.log(`- ${note}`);
