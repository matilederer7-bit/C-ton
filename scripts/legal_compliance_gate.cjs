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

for (const doc of requiredDocs) {
  if (!exists(doc)) failures.push(`missing required document: ${doc}`);
}

const app = read("frontend/app.js");
const runtime = read("src/frontend_runtime.ts");
const server = read("src/app.ts");

for (const forbidden of ["שלם עכשיו", "התשלום בוצע", "רכישה הושלמה"]) {
  if (app.includes(forbidden)) failures.push(`forbidden auth-hold copy appears in frontend: ${forbidden}`);
}

if (!/90%/.test(app) || !/90%/.test(read("docs/BUYER_TERMS_HE.md")) || !/90%/.test(read("docs/SELLER_TERMS_HE.md"))) {
  failures.push("90% rule is missing from buyer/seller surfaces");
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

for (const link of ["/app/terms", "/app/privacy", "/app/refunds", "/app/accessibility", "/app/seller-terms", "/app/distributor-terms"]) {
  if (!app.includes(link) && !runtime.includes(link)) failures.push(`missing policy link: ${link}`);
}

const affiliateBlock = runtime.slice(runtime.indexOf('app.get("/api/affiliate/overview"'), runtime.indexOf("// ---------------------------------------------------------------------------", runtime.indexOf('app.get("/api/affiliate/overview"')));
for (const pii of ["buyer_id", "buyer_phone", "buyer_email", "buyer_name", "delivery_address"]) {
  if (affiliateBlock.includes(pii)) failures.push(`buyer PII appears in distributor API block: ${pii}`);
}

if (!app.includes("sellerPublishCriticalTermsAccepted") || !app.includes("sellerPublishThresholdAccepted")) {
  failures.push("seller publish checkboxes are missing");
}
if (!server.includes("seller_critical_terms_accepted") || !server.includes("seller_threshold_90_accepted")) {
  failures.push("server publish endpoint does not require both seller legal confirmations");
}

if (!server.includes("seller_kyc_not_approved") || !server.includes("ensureSellerActionAllowed")) {
  failures.push("BLOCKER: seller_status/KYC gate before real-money publish is missing");
} else {
  notes.push("seller_status/KYC gate detected before publish");
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
