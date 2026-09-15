// Positive and negative controls for the semantic raw-card term scanner and
// the payment compliance scan built on it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir } = require("./support/fixture_repo.cjs");
const rawCard = require("../../scripts/lib/raw_card_terms.cjs");
const paymentScan = require("../../scripts/compliance_payment_scan.cjs");

const detect = (file, source) => rawCard.scanFile(file, source);

test("identifiers, keys, columns and form fields named after cardholder data are detected", () => {
  const positives = [
    ["a.ts", "const value = request.body.cvv;"],
    ["a.ts", "interface Card { cardNumber: string }"],
    ["a.ts", "type T = { expiry_month: number }"],
    ["a.ts", "const payload = { cvc: code };"],
    ["a.ts", "const raw = row[\"card_number\"];"],
    ["a.ts", "function storePan(pan: string) {}"],
    ["a.ts", "const sql = `INSERT INTO siton.cards (card_number) VALUES ($1)`;"],
    ["a.ts", "const sql = `SELECT c.cvv FROM siton.cards c WHERE c.id = ${id}`;"],
    ["a.sql", "ALTER TABLE siton.participants ADD COLUMN cvv TEXT;"],
    ["a.html", "<input type=\"text\" name=\"cvv\" />"],
    ["a.html", "<div id=\"cardNumber\"></div>"],
    ["a.html", "<script>const x = form.cvc;</script>"],
    ["a.css", ".card-number-input { }"],
    ["a.css", "input[name=\"cvv\"] { }"],
    ["a.js", "module.exports = { fullCard: true };"]
  ];
  for (const [file, source] of positives) {
    const hits = detect(file, source);
    assert.ok(hits.length >= 1, "expected detection in " + file + ": " + source);
  }
});

test("prose disclosures, comments, SQL literals and unrelated identifiers are not findings", () => {
  const negatives = [
    ["a.ts", "const disclosure = \"C-ton אינה שומרת פרטי אשראי גולמיים, כגון מספר כרטיס מלא, CVV או נתוני אימות מלאים.\";"],
    ["a.ts", "const notice = 'We never store your card number or CVV.';"],
    ["a.ts", "// cvv is never accepted here\nconst ok = true;"],
    ["a.ts", "const sql = `SELECT note FROM siton.notes WHERE note = 'contains CVV text'`;"],
    ["a.ts", "const panel = 1; const expandPanel = () => {}; const span = document.createElement('span');"],
    ["a.ts", "const company = 'x'; const occupancy = 2; const participant = 3;"],
    ["a.sql", "-- we do not store cvv\n/* nor card_number */\nCREATE TABLE siton.t (id INT);"],
    ["a.sql", "INSERT INTO siton.site_content (body) VALUES ('CVV is never stored');"],
    ["a.html", "<p>אנחנו לא שומרים CVV</p>"],
    ["a.css", ".panel { color: red }"]
  ];
  for (const [file, source] of negatives) {
    const hits = detect(file, source);
    assert.equal(hits.length, 0, "unexpected finding in " + file + ": " + JSON.stringify(hits));
  }
});

test("matchIdentifier normalises camelCase and snake_case segments", () => {
  assert.equal(rawCard.matchIdentifier("cardNumber"), "card_number");
  assert.equal(rawCard.matchIdentifier("CARD_NUMBER"), "card_number");
  assert.equal(rawCard.matchIdentifier("raw_pan_in_json"), "pan");
  assert.equal(rawCard.matchIdentifier("expiryYear"), "expiry_year");
  assert.equal(rawCard.matchIdentifier("panel"), null);
  assert.equal(rawCard.matchIdentifier("expandable"), null);
  assert.equal(rawCard.matchIdentifier("cvvless"), null);
});

test("allow-list requires file + identifier + reason, refuses wildcards, and reports stale entries", () => {
  const findings = [{ rel: "src/x.ts", line: 1, term: "pan", kind: "identifier", identifier: "raw_pan_in_json" }];
  const applied = rawCard.applyAllowList(findings, [{ file: "src/x.ts", identifier: "raw_pan_in_json", reason: "evidence field" }]);
  assert.equal(applied.findings.length, 0);
  assert.equal(applied.unusedAllowListEntries.length, 0);
  const stale = rawCard.applyAllowList([], [{ file: "src/x.ts", identifier: "gone", reason: "r" }]);
  assert.equal(stale.unusedAllowListEntries.length, 1);
  assert.throws(() => rawCard.applyAllowList(findings, [{ file: "src/*.ts", identifier: "raw_pan_in_json", reason: "r" }]), /wildcards/);
  assert.throws(() => rawCard.applyAllowList(findings, [{ file: "src/x.ts", identifier: "raw_pan_in_json" }]), /reason/);
});

test("payment compliance scan detects a violation in canonical source and ignores the same text under .worktrees and temp dirs", () => {
  const root = makeTempDir("siton-payment-scan-");
  try {
    const violation = "export function handle(body: { cvv: string }) { return body.cvv; }\n";
    const files = {
      "src/checkout.ts": violation,
      "src/nested/deep/checkout.ts": violation,
      ".worktrees/review/src/checkout.ts": violation,
      ".tmp_review/src/checkout.ts": violation,
      ".demo_dist/src/checkout.js": violation,
      "node_modules/x/checkout.js": violation,
      "docs/PAYMENT_SECURITY_AND_PCI_SCOPE.md": "cvv is never stored",
      "tests/hostile_fixture.ts": violation,
      "src/legal_pages.ts": "export const t = `C-ton does not store CVV or the full card number.`;\n"
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const result = paymentScan.run({ root, allowList: [] });
    const flagged = result.findings.map((hit) => hit.rel).sort();
    assert.deepEqual([...new Set(flagged)], ["src/checkout.ts", "src/nested/deep/checkout.ts"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real repository passes the payment compliance scan with only documented allow-list entries", () => {
  const result = paymentScan.run();
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unusedAllowListEntries, []);
  assert.ok(result.scanned > 100, "scan covered " + result.scanned + " files");
});
