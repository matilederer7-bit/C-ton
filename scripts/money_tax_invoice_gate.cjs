const fs = require("fs");
const path = require("path");

const root = process.cwd();
const failures = [];
const manual = [];
const notes = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", ".tmp_test_dist", ".demo_dist", ".tmp_gate_logs"].includes(entry.name)) continue;
    if (entry.name.startsWith(".tmp")) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|cjs|mjs|sql|md)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const canonPath = "docs/MONEY_TAX_INVOICE_CANON.md";
assert(exists(canonPath), "missing docs/MONEY_TAX_INVOICE_CANON.md");

const canon = exists(canonPath) ? read(canonPath) : "";
const platformFee = read("src/platform_fee_money.ts");
const runtimeConfig = read("src/runtime_config.ts");
const invoiceDispatch = read("src/invoice_dispatch.ts");
const frontendRuntime = read("src/frontend_runtime.ts");
const sellerAnalytics = read("src/seller_analytics.ts");
const payoutRail = read("src/payout_rail.ts");
const app = read("src/app.ts");
const sellerExportTest = exists("tests/seller_deal_excel_export_validation.ts") ? read("tests/seller_deal_excel_export_validation.ts") : "";
const combinedRuntime = `${platformFee}\n${runtimeConfig}\n${invoiceDispatch}\n${frontendRuntime}\n${sellerAnalytics}\n${payoutRail}\n${app}`;

const vatSourceCount = (runtimeConfig.match(/export const SITON_PLATFORM_FEE_VAT_RATE\b/g) || []).length;
assert(vatSourceCount === 1, `expected one VAT_RATE source export, found ${vatSourceCount}`);
assert(/SITON_PLATFORM_FEE_VAT_RATE\s*=\s*readNumberEnv\("SITON_PLATFORM_FEE_VAT_RATE",\s*0\.18\)/.test(runtimeConfig), "VAT rate must default to 0.18 through runtime_config");

const feeSourceCount = (platformFee.match(/export const SITON_PLATFORM_FEE_RATE\s*=\s*0\.08/g) || []).length;
assert(feeSourceCount === 1, `expected one platform fee rate source export, found ${feeSourceCount}`);
assert(/feeBaseAmount\s*=\s*roundMoney\(Math\.max\(0,\s*grossAmount\)\)/.test(platformFee), "platform fee base must use charged gross, not gross minus VAT");
assert(/platformFeeVatAmount\s*=\s*roundMoney\(platformFeeBaseAmount\s*\*\s*SITON_PLATFORM_FEE_VAT_RATE\)/.test(platformFee), "platform fee VAT must use VAT_RATE constant");
assert(/sellerNetAmount\s*=\s*roundMoney\(grossAmount\s*-\s*platformFeeTotalAmount\)/.test(platformFee), "seller_net must subtract fee total including VAT");

assert(/Number\(row\.qty \|\| 0\)\s*\*\s*Number\(row\.price_per_unit \|\| 0\)\s*\+\s*Number\(row\.delivery_cost \|\| 0\)/.test(platformFee), "platform fee ledger must include delivery in gross");
assert(/event_type IN \('charge_captured','recovery_captured','refund_issued'\)/.test(platformFee), "platform fee ledger must include recovery and refund events");
assert(/args\.source_money_state === "RecoveredCharge" \? "recovery_captured" : "charge_captured"/.test(platformFee), "RecoveredCharge refund backfill must map to recovery_captured");

assert(/money_state IN \('ChargedSuccess','RecoveredCharge'\)/.test(sellerAnalytics), "seller analytics must count ChargedSuccess and RecoveredCharge");
assert(/p\.money_state IN \('ChargedSuccess','RecoveredCharge'\)/.test(frontendRuntime), "seller export/frontend runtime must count ChargedSuccess and RecoveredCharge");
assert(/p\.money_state === "ChargedSuccess"\s*\|\|\s*p\.money_state === "RecoveredCharge"/.test(frontendRuntime), "seller export eligibility must include ChargedSuccess and RecoveredCharge");
assert(/buyer_state === "Dropped"/.test(frontendRuntime) && /AuthReleased/.test(sellerAnalytics), "Dropped/AuthReleased exclusions must remain visible in reporting code");

for (const required of [
  "gross_amount",
  "platform_fee_base_amount",
  "platform_fee_vat_amount",
  "platform_fee_total_amount",
  "seller_net_amount"
]) {
  assert(sellerExportTest.includes(required) || frontendRuntime.includes(required), `seller export missing ${required}`);
}

assert(/platformFeeBaseAmount: money\.platform_fee_base_amount/.test(app), "invoice document enqueue must pass platform fee base");
assert(/platformFeeVatAmount: money\.platform_fee_vat_amount/.test(app), "invoice document enqueue must pass platform fee VAT");
assert(/platformFeeTotalAmount: money\.platform_fee_total_amount/.test(app), "invoice document enqueue must pass platform fee total");
assert(/CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES\s*=\s*\["DealCompleted"\]/.test(invoiceDispatch), "charge receipt eligibility must be post-completion only");
assert(!/AuthHeld[\s\S]{0,120}charge_receipt/.test(invoiceDispatch + "\n" + app), "auth hold must not enqueue charge_receipt");

assert(/FROM siton\.platform_fee_money_events/.test(payoutRail), "payout/settlement must use platform_fee_money_events");
assert(/COALESCE\(SUM\(m\.seller_net_amount\), 0\) AS seller_net_payable/.test(payoutRail), "payout/settlement must use seller_net from canonical ledger");

const forbiddenDistributorMoney = [
  /affiliate[^.\n]{0,80}commission/i,
  /distributor[^.\n]{0,80}commission/i,
  /affiliate[^.\n]{0,80}payout/i,
  /distributor[^.\n]{0,80}payout/i,
  /affiliate[^.\n]{0,80}balance/i,
  /distributor[^.\n]{0,80}balance/i
];
const distributorSurface = `${frontendRuntime}\n${read("frontend/app.js")}`;
for (const re of forbiddenDistributorMoney) {
  assert(!re.test(distributorSurface), `distributor surface contains forbidden money wording: ${re}`);
}

assert(canon.includes("C-ton charges the seller 8% plus VAT") || canon.includes("C-ton גובה מהמוכר 8%"), "canon must state C-ton charges seller 8% plus VAT");
assert(canon.includes("מספר הקצאה") && canon.includes("ספק חשבוניות"), "canon must include Israel invoice allocation/provider rule");
assert(canon.includes("RecoveredCharge is identical to `ChargedSuccess`") || canon.includes("`RecoveredCharge` is identical"), "canon must state RecoveredCharge counts as collected money");
assert(canon.includes("`Dropped`, `AuthReleased`, and `ChargeFailed` states are not revenue"), "canon must state Dropped/AuthReleased/ChargeFailed are not revenue");
assert(/seller sells the product or service to the buyer/i.test(canon), "canon must identify seller as buyer-facing seller");
assert(/C-ton is not presented as the product seller/i.test(canon), "canon must not present C-ton as product seller");

if (!/credit_note|refund_receipt/.test(invoiceDispatch)) {
  manual.push("MANUAL_CHECK refund/credit-note provider route: no static credit/refund document type found");
}
if (!/external_document_issued/.test(invoiceDispatch)) {
  manual.push("MANUAL_CHECK external invoice provider issuance cannot be proven statically");
}
manual.push("MANUAL_CHECK Israel tax allocation number issuance depends on the configured invoice provider in production");
manual.push("MANUAL_CHECK buyer-facing seller tax document content must be verified with the live invoice provider template");

for (const rel of walk(path.join(root, "src"))) {
  const text = read(rel);
  if (/C-ton[^.\n]{0,80}(seller of the product|product seller|sells the product to the buyer)/i.test(text)) {
    failures.push(`${rel}: text may present C-ton as product seller`);
  }
}

if (failures.length) {
  console.error("MONEY_TAX_INVOICE_CANON_FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  for (const item of manual) console.error(`- ${item}`);
  process.exit(1);
}

console.log("MONEY_TAX_INVOICE_CANON_PASS_WITH_MANUAL_CHECKS");
for (const note of notes) console.log(`- ${note}`);
for (const item of manual) console.log(`- ${item}`);
