// Money / tax / invoice canon gate.
//
// Proves the money canon (docs/MONEY_TAX_INVOICE_CANON.md) against the code
// WITHOUT depending on source formatting. The previous version grepped for
// exact expression shapes such as
//   Number(row.qty || 0) * Number(row.price_per_unit || 0) + Number(row.delivery_cost || 0)
// and failed on master after a harmless three-line refactor of the same
// arithmetic. That is a brittle gate: it proved a phrase, not an invariant.
//
// Every check below is one of:
//   EXECUTABLE  - run the real exported arithmetic and assert numeric vectors
//   AST         - declarations, identifiers, literal values, property wiring
//   BOUNDED SQL - order-insensitive parse of a SQL IN (...) list
//   CANON DOC   - the documented statement itself (the doc is the canon)
// Controls for this gate live in tests/release_tools/money_tax_gate.test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ast = require("./lib/ts_ast.cjs");
const policy = require("./lib/repo_scan_policy.cjs");

const ts = ast.ts;
const root = process.cwd();
const failures = [];
const manual = [];
const notes = [];

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));
const assert = (condition, message) => { if (!condition) failures.push(message); };
const norm = (text) => String(text).replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// 1. Canon document must exist and state the rules (CANON DOC).
// ---------------------------------------------------------------------------
const canonPath = "docs/MONEY_TAX_INVOICE_CANON.md";
assert(exists(canonPath), "missing " + canonPath);
const canon = exists(canonPath) ? norm(read(canonPath)) : "";
assert(canon.includes("fee_calculation_base = max(0, charged_gross_total - buyer_vat_amount)"), "canon must exclude buyer-side VAT from the fee calculation base");
assert(canon.includes("C-ton charges the seller 8% plus VAT") || canon.includes("C-ton גובה מהמוכר 8%"), "canon must state C-ton charges seller 8% plus VAT");
assert(canon.includes("מספר הקצאה") && canon.includes("ספק חשבוניות"), "canon must include Israel invoice allocation/provider rule");
assert(/`RecoveredCharge` is identical/.test(canon), "canon must state RecoveredCharge counts as collected money");
assert(/`Dropped`, `AuthReleased`, and `ChargeFailed` states are not revenue/.test(canon), "canon must state Dropped/AuthReleased/ChargeFailed are not revenue");
assert(/seller sells the product or service to the buyer/i.test(canon), "canon must identify seller as buyer-facing seller");
assert(/C-ton is not presented as the product seller/i.test(canon), "canon must not present C-ton as product seller");

// ---------------------------------------------------------------------------
// 2. Canonical constants (AST): one exported source each, with the canon value.
// ---------------------------------------------------------------------------
const runtimeConfigFile = ast.parse(path.join(root, "src/runtime_config.ts"));
const vatExports = ast.exportedVariables(runtimeConfigFile, "SITON_PLATFORM_FEE_VAT_RATE");
assert(vatExports.length === 1, "expected exactly one exported SITON_PLATFORM_FEE_VAT_RATE, found " + vatExports.length);
if (vatExports.length === 1) {
  const init = vatExports[0].initializer;
  const call = init && ts.isCallExpression(init) ? init : null;
  const envName = call ? ast.stringLiteralValue(call.arguments[0]) : null;
  const fallback = call ? ast.numericLiteralValue(call.arguments[1]) : null;
  assert(call && ts.isIdentifier(call.expression) && call.expression.text === "readNumberEnv", "VAT rate must be read through readNumberEnv");
  assert(envName === "SITON_PLATFORM_FEE_VAT_RATE", "VAT rate env name must be SITON_PLATFORM_FEE_VAT_RATE");
  assert(fallback === 0.18, "VAT rate default must be 0.18 (found " + fallback + ")");
}

const feeFile = ast.parse(path.join(root, "src/platform_fee_money.ts"));
const feeExports = ast.exportedVariables(feeFile, "SITON_PLATFORM_FEE_RATE");
assert(feeExports.length === 1, "expected exactly one exported SITON_PLATFORM_FEE_RATE, found " + feeExports.length);
if (feeExports.length === 1) assert(ast.numericLiteralValue(feeExports[0].initializer) === 0.08, "platform fee rate must be the literal 0.08");

// ---------------------------------------------------------------------------
// 3. Fee arithmetic (EXECUTABLE): run the real function through tsx.
// ---------------------------------------------------------------------------
{
  const probe = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/probes/platform_fee_probe.ts")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DOTENV_CONFIG_QUIET: "true", NODE_ENV: "test" },
    timeout: 60000
  });
  let vectors = null;
  if (probe.status === 0) {
    const lastLine = String(probe.stdout || "").trim().split(/\r?\n/).pop();
    try { vectors = JSON.parse(lastLine); } catch { vectors = null; }
  }
  assert(vectors, "platform fee probe failed to execute: " + String(probe.stderr || probe.stdout || "").slice(0, 300));
  if (vectors) {
    const close = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
    assert(vectors.fee_rate === 0.08, "executed fee rate is " + vectors.fee_rate);
    assert(vectors.fee_vat_rate === 0.18, "executed fee VAT rate default is " + vectors.fee_vat_rate);
    const a = vectors.no_vat_100;
    assert(close(a.fee_base_amount, 100) && close(a.platform_fee_base_amount, 8) && close(a.platform_fee_vat_amount, 1.44) && close(a.platform_fee_total_amount, 9.44) && close(a.seller_net_amount, 90.56), "fee vector (100 gross, 0 VAT) must be 8 / 1.44 / 9.44 / 90.56, got " + JSON.stringify(a));
    const b = vectors.vat_118;
    assert(close(b.fee_base_amount, 100) && close(b.platform_fee_base_amount, 8) && close(b.seller_net_amount, 108.56), "fee base must EXCLUDE buyer VAT: 118 gross with 18 VAT must yield fee base 100, fee 8, net 108.56, got " + JSON.stringify(b));
    const c = vectors.refund_sign;
    assert(close(c.platform_fee_total_amount, -9.44) && close(c.seller_net_amount, -90.56), "refund sign must negate fee and net symmetrically, got " + JSON.stringify(c));
    const d = vectors.negative_vat_clamped;
    assert(close(d.vat_amount, 0) && close(d.fee_base_amount, 50), "negative VAT input must clamp to 0, got " + JSON.stringify(d));
  }
}

// ---------------------------------------------------------------------------
// 4. Gross includes delivery (AST): the charge-context loader reads qty,
//    price_per_unit and delivery_cost and produces gross_amount.
// ---------------------------------------------------------------------------
{
  const loader = ast.findFunction(feeFile, "loadParticipantChargeContext");
  assert(loader, "loadParticipantChargeContext must exist in src/platform_fee_money.ts");
  if (loader) {
    const names = ast.namesIn(loader);
    for (const required of ["qty", "price_per_unit", "delivery_cost", "gross_amount"]) {
      assert(names.has(required), "platform fee charge context must reference " + required + " (delivery must be part of gross)");
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Event types (AST + migration CHECK): the TS union and the database CHECK
//    constraint agree on exactly {charge_captured, recovery_captured, refund_issued}.
// ---------------------------------------------------------------------------
{
  const expected = ["charge_captured", "recovery_captured", "refund_issued"];
  const union = ast.unionStringMembers(ast.findTypeAlias(feeFile, "PlatformFeeFinancialEventType"));
  assert(union && [...union].sort().join(",") === [...expected].sort().join(","), "PlatformFeeFinancialEventType must be exactly " + expected.join("/") + ", found " + JSON.stringify(union));
  const migration = read("src/migrations/019_platform_fee_money_events.sql");
  const check = norm(migration).match(/event_type\s+IN\s*\(([^)]*)\)/i);
  const dbValues = check ? [...check[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort() : null;
  assert(dbValues && dbValues.join(",") === [...expected].sort().join(","), "migration 019 event_type CHECK must list exactly " + expected.join("/"));
}

// ---------------------------------------------------------------------------
// 6. Recovery backfill mapping (AST): a conditional keyed on RecoveredCharge
//    selects recovery_captured, otherwise charge_captured.
// ---------------------------------------------------------------------------
{
  const conditionals = ast.collect(feeFile, (node) => ts.isConditionalExpression(node)
    && ast.stringLiteralValue(node.whenTrue) === "recovery_captured"
    && ast.stringLiteralValue(node.whenFalse) === "charge_captured"
    && /RecoveredCharge/.test(node.condition.getText(feeFile)));
  assert(conditionals.length >= 1, "RecoveredCharge refund backfill must map to recovery_captured (conditional not found)");
}

// ---------------------------------------------------------------------------
// 7. Collected-money states in reporting SQL (BOUNDED SQL, order-insensitive).
// ---------------------------------------------------------------------------
function moneyStateInLists(source) {
  return [...norm(source).matchAll(/money_state\s+IN\s*\(([^)]*)\)/gi)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort().join(","));
}
const collected = ["ChargedSuccess", "RecoveredCharge"].sort().join(",");
assert(moneyStateInLists(read("src/seller_analytics.ts")).includes(collected), "seller analytics must count ChargedSuccess and RecoveredCharge together");
const frontendRuntimeSource = read("src/frontend_runtime.ts");
assert(moneyStateInLists(frontendRuntimeSource).includes(collected), "seller export/frontend runtime SQL must count ChargedSuccess and RecoveredCharge together");
{
  const frontendFile = ast.parse(path.join(root, "src/frontend_runtime.ts"), frontendRuntimeSource);
  const comparisons = ast.collect(frontendFile, (node) => ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    && /money_state$/.test(node.left.getText(frontendFile)) && ast.stringLiteralValue(node.right) !== null)
    .map((node) => ast.stringLiteralValue(node.right));
  assert(comparisons.includes("ChargedSuccess") && comparisons.includes("RecoveredCharge"), "seller export eligibility must compare money_state to both ChargedSuccess and RecoveredCharge");
  const buyerStateComparisons = ast.collect(frontendFile, (node) => ts.isBinaryExpression(node) && /buyer_state$/.test(node.left.getText(frontendFile)) && ast.stringLiteralValue(node.right) === "Dropped");
  assert(buyerStateComparisons.length >= 1, "Dropped exclusion must remain visible in seller reporting code");
  assert(/AuthReleased/.test(read("src/seller_analytics.ts")), "AuthReleased exclusion must remain visible in seller analytics");
}

// ---------------------------------------------------------------------------
// 8. Seller export fields (presence in runtime or its validation suite).
// ---------------------------------------------------------------------------
const sellerExportTest = exists("tests/seller_deal_excel_export_validation.ts") ? read("tests/seller_deal_excel_export_validation.ts") : "";
for (const required of ["gross_amount", "platform_fee_base_amount", "platform_fee_vat_amount", "platform_fee_total_amount", "seller_net_amount"]) {
  assert(sellerExportTest.includes(required) || frontendRuntimeSource.includes(required), "seller export missing " + required);
}

// ---------------------------------------------------------------------------
// 9. Invoice document wiring (AST): app.ts passes the three fee amounts from
//    the money snapshot into the invoice enqueue payload.
// ---------------------------------------------------------------------------
{
  const appFile = ast.parse(path.join(root, "src/app.ts"));
  // Every enqueue site must wire the amount from the snapshot field. One site
  // hard-coding a number while another stays correct is still a violation.
  for (const [property, field] of [["platformFeeBaseAmount", "platform_fee_base_amount"], ["platformFeeVatAmount", "platform_fee_vat_amount"], ["platformFeeTotalAmount", "platform_fee_total_amount"]]) {
    const sites = ast.propertyAssignments(appFile, property);
    const wired = sites.length >= 1 && sites.every((node) => ts.isPropertyAccessExpression(node.initializer) && node.initializer.name.text === field);
    assert(wired, "invoice document enqueue must pass " + property + " from the money snapshot " + field + " at every enqueue site (" + sites.length + " sites)");
  }
}

// ---------------------------------------------------------------------------
// 10. Receipt eligibility (AST) and auth-hold safety (comment-stripped).
// ---------------------------------------------------------------------------
{
  const invoiceSource = read("src/invoice_dispatch.ts");
  const invoiceFile = ast.parse(path.join(root, "src/invoice_dispatch.ts"), invoiceSource);
  const eligible = ast.exportedVariables(invoiceFile, "CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES");
  assert(eligible.length === 1, "CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES must be exported exactly once");
  if (eligible.length === 1) {
    let init = eligible[0].initializer;
    if (init && ts.isAsExpression(init)) init = init.expression;
    const values = init && ts.isArrayLiteralExpression(init) ? init.elements.map((element) => ast.stringLiteralValue(element)) : null;
    assert(values && values.length === 1 && values[0] === "DealCompleted", "charge receipt eligibility must be post-completion only (DealCompleted), found " + JSON.stringify(values));
  }
  const stripped = ast.stripComments(invoiceSource, "invoice_dispatch.ts") + "\n" + ast.stripComments(read("src/app.ts"), "app.ts");
  assert(!/AuthHeld[\s\S]{0,120}charge_receipt/.test(stripped), "auth hold must not enqueue charge_receipt");
  if (!/credit_note|refund_receipt/.test(invoiceSource)) manual.push("MANUAL_CHECK refund/credit-note provider route: no static credit/refund document type found");
  if (!/external_document_issued/.test(invoiceSource)) manual.push("MANUAL_CHECK external invoice provider issuance cannot be proven statically");
}

// ---------------------------------------------------------------------------
// 11. Payout rail reads seller net from the canonical ledger (BOUNDED SQL).
// ---------------------------------------------------------------------------
{
  const payout = norm(read("src/payout_rail.ts"));
  assert(/FROM\s+siton\.platform_fee_money_events/i.test(payout), "payout/settlement must use platform_fee_money_events");
  // Every SQL alias `... AS seller_net_payable` must aggregate the ledger's
  // seller_net_amount. A single derivation from gross (or any other column)
  // is a violation even when another site is still correct.
  const aliasSites = [...payout.matchAll(/(.{0,120}?)\s+AS\s+seller_net_payable\b/gi)];
  assert(aliasSites.length >= 1, "payout/settlement must derive seller_net_payable in SQL");
  for (const site of aliasSites) {
    assert(/SUM\s*\(\s*(?:\w+\.)?seller_net_amount\s*\)/i.test(site[1]), "seller_net_payable must be SUM(seller_net_amount) from the canonical ledger, found: " + site[0].trim().slice(-100));
  }
}

// ---------------------------------------------------------------------------
// 12. Distributor surface carries no money wording; C-ton is never the seller.
// ---------------------------------------------------------------------------
{
  const distributorSurface = ast.stripComments(frontendRuntimeSource, "frontend_runtime.ts") + "\n" + read("frontend/app.js");
  for (const re of [/affiliate[^.\n]{0,80}commission/i, /distributor[^.\n]{0,80}commission/i, /affiliate[^.\n]{0,80}payout/i, /distributor[^.\n]{0,80}payout/i, /affiliate[^.\n]{0,80}balance/i, /distributor[^.\n]{0,80}balance/i]) {
    assert(!re.test(distributorSurface), "distributor surface contains forbidden money wording: " + re);
  }
  for (const file of policy.walkRepository(root, { roots: ["src"], extensions: /\.(ts|tsx|js|cjs|mjs|sql)$/ })) {
    const text = fs.readFileSync(file.abs, "utf8");
    if (/C-ton[^.\n]{0,80}(seller of the product|product seller|sells the product to the buyer)/i.test(text)) failures.push(file.rel + ": text may present C-ton as product seller");
  }
}

manual.push("MANUAL_CHECK Israel tax allocation number issuance depends on the configured invoice provider in production");
manual.push("MANUAL_CHECK buyer-facing seller tax document content must be verified with the live invoice provider template");

if (failures.length) {
  console.error("MONEY_TAX_INVOICE_CANON_FAIL");
  for (const failure of failures) console.error("- " + failure);
  for (const item of manual) console.error("- " + item);
  process.exit(1);
}

console.log("MONEY_TAX_INVOICE_CANON_PASS_WITH_MANUAL_CHECKS");
console.log("- executable fee vectors: pass (100/0 VAT, 118/18 VAT, refund sign, negative VAT clamp)");
for (const note of notes) console.log("- " + note);
for (const item of manual) console.log("- " + item);
