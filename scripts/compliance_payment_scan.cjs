// Payment / raw-card compliance scan (npm run scan:payment).
//
// Invariant: no canonical runtime source HANDLES raw cardholder data. The
// check is semantic (identifiers, keys, columns, form fields) through
// scripts/lib/raw_card_terms.cjs, so a legal sentence stating that CVV is NOT
// stored is not a finding, while `body.cvv`, `cvv: string`, a `card_number`
// column or `<input name="cvv">` is.
//
// File selection goes through the canonical repository-scan policy
// (scripts/lib/repo_scan_policy.cjs): .git, .worktrees, node_modules, build
// output, temporary review directories and generated artefacts are never
// inspected; every real source directory is.
//
// docs/ and tests/ are out of scope by design: documentation describes the
// posture and tests carry hostile fixtures that PROVE rejection. Their own
// controls live in tests/release_tools/raw_card_terms.test.cjs.
const fs = require("node:fs");
const policy = require("./lib/repo_scan_policy.cjs");
const rawCard = require("./lib/raw_card_terms.cjs");

const root = process.cwd();
const OUT_OF_SCOPE_TOP_LEVEL = new Set(["docs", "tests"]);
// Scanner infrastructure legitimately names the forbidden terms (detector
// ids, the shared term module). Nothing else is exempt.
const SELF = new Set([
  "scripts/compliance_payment_scan.cjs",
  "scripts/legal_compliance_gate.cjs",
  "scripts/lib/raw_card_terms.cjs",
  "scripts/logging_hygiene_gate.cjs",
  "scripts/secret_pii_scan.cjs"
]);

function run(options = {}) {
  const scanRoot = options.root || root;
  const files = policy.walkRepository(scanRoot, {
    extensions: policy.CODE_EXTENSIONS,
    includeFile: (rel) => !OUT_OF_SCOPE_TOP_LEVEL.has(rel.split("/")[0]) && !SELF.has(rel)
  });
  const findings = [];
  for (const file of files) {
    const source = fs.readFileSync(file.abs, "utf8");
    findings.push(...rawCard.scanFile(file.rel, source));
  }
  const allowList = options.allowList || rawCard.loadAllowList(scanRoot);
  const applied = rawCard.applyAllowList(findings, allowList);
  return { scanned: files.length, findings: applied.findings, unusedAllowListEntries: applied.unusedAllowListEntries };
}

if (require.main === module) {
  const result = run();
  const failures = result.findings.map((hit) => hit.rel + ":" + hit.line + ": " + hit.kind + " \"" + hit.identifier + "\" matches forbidden raw payment term \"" + hit.term + "\"");
  for (const entry of result.unusedAllowListEntries) failures.push("stale raw-card allow-list entry: " + entry.file + " " + entry.identifier + " (remove it)");
  if (failures.length) {
    console.error("PAYMENT_COMPLIANCE_SCAN_FAIL");
    for (const failure of failures) console.error("- " + failure);
    process.exit(1);
  }
  console.log("PAYMENT_COMPLIANCE_SCAN_PASS");
  console.log("SCANNED_FILES=" + result.scanned);
  console.log("SCAN_POLICY=scripts/lib/repo_scan_policy.cjs");
}

module.exports = { run };
