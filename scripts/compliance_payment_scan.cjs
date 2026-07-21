const fs = require("fs");
const path = require("path");

const root = process.cwd();
const forbidden = [
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

const allowedDirs = new Set(["docs", "tests"]);
const ignoredDirs = new Set([".git", "node_modules", ".tmp_test_dist", ".demo_dist", ".tmp_gate_logs"]);
const ignoredFiles = new Set([
  path.normalize("scripts/compliance_payment_scan.cjs"),
  path.normalize("scripts/legal_compliance_gate.cjs"),
  path.normalize("src/legal_pages.ts")
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    if (entry.name.startsWith(".tmp")) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|cjs|mjs|sql|html|css)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function isAllowed(rel) {
  const first = rel.split(path.sep)[0];
  return allowedDirs.has(first) || ignoredFiles.has(path.normalize(rel));
}

const failures = [];
for (const rel of walk(root)) {
  if (isAllowed(rel)) continue;
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  for (const term of forbidden) {
    const re = new RegExp(`\\b${term}\\b`, "i");
    if (re.test(text)) failures.push(`${rel}: forbidden raw payment term "${term}"`);
  }
}

if (failures.length) {
  console.error("PAYMENT_COMPLIANCE_SCAN_FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PAYMENT_COMPLIANCE_SCAN_PASS");
