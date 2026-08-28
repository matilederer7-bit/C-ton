import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { calculatePlatformFeeMoney } from "../src/platform_fee_money.js";
import { SITON_PLATFORM_FEE_VAT_RATE } from "../src/runtime_config.js";

function read(path: string) {
  return readFileSync(path, "utf8");
}

async function run(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
}

await run("platform fee canon: gross 1000 -> 80 + VAT -> seller net 905.6", () => {
  const money = calculatePlatformFeeMoney({ grossAmount: 1000 });
  assert.equal(money.platform_fee_base_amount, 80);
  assert.equal(SITON_PLATFORM_FEE_VAT_RATE, 0.18);
  assert.equal(money.platform_fee_vat_amount, 14.4);
  assert.equal(money.platform_fee_total_amount, 94.4);
  assert.equal(money.seller_net_amount, 905.6);
});

await run("buyer VAT is excluded from the 8% fee base", () => {
  const money = calculatePlatformFeeMoney({ grossAmount: 118, vatAmount: 18 });
  assert.equal(money.fee_base_amount, 100);
  assert.equal(money.platform_fee_base_amount, 8);
  assert.equal(money.platform_fee_vat_amount, 1.44);
  assert.equal(money.platform_fee_total_amount, 9.44);
  assert.equal(money.seller_net_amount, 108.56);
});

await run("shipping is included in charged gross and fee base", () => {
  const product = 900;
  const shipping = 100;
  const money = calculatePlatformFeeMoney({ grossAmount: product + shipping });
  assert.equal(money.gross_amount, 1000);
  assert.equal(money.fee_base_amount, 1000);
  assert.equal(money.platform_fee_base_amount, 80);
});

await run("non-revenue states are not treated as settlement states in reporting", () => {
  const sellerAnalytics = read("src/seller_analytics.ts");
  const frontendRuntime = read("src/frontend_runtime.ts");
  assert.match(sellerAnalytics, /money_state IN \('ChargedSuccess','RecoveredCharge'\)/);
  assert.match(frontendRuntime, /p\.money_state === "ChargedSuccess"\s*\|\|\s*p\.money_state === "RecoveredCharge"/);
  assert.match(sellerAnalytics, /AuthReleased/);
  assert.match(frontendRuntime, /buyer_state === "Dropped"/);
});

await run("auth hold is not invoice eligible and refund path has document route", () => {
  const invoiceDispatch = read("src/invoice_dispatch.ts");
  const app = read("src/app.ts");
  assert.match(invoiceDispatch, /CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES = \["DealCompleted"\]/);
  assert.doesNotMatch(`${invoiceDispatch}\n${app}`, /AuthHeld[\s\S]{0,120}charge_receipt/);
  assert.match(invoiceDispatch, /refund_receipt|credit_note/);
});

await run("seller export, invoice document, and payout use canonical fields", () => {
  const frontendRuntime = read("src/frontend_runtime.ts");
  const app = read("src/app.ts");
  const payoutRail = read("src/payout_rail.ts");
  for (const field of [
    "gross_amount",
    "platform_fee_base_amount",
    "platform_fee_vat_amount",
    "platform_fee_total_amount",
    "seller_net_amount"
  ]) {
    assert.ok(frontendRuntime.includes(field), `seller export missing ${field}`);
  }
  assert.match(app, /platformFeeBaseAmount: money\.platform_fee_base_amount/);
  assert.match(app, /platformFeeVatAmount: money\.platform_fee_vat_amount/);
  assert.match(app, /platformFeeTotalAmount: money\.platform_fee_total_amount/);
  assert.match(payoutRail, /FROM siton\.platform_fee_money_events/);
  assert.match(payoutRail, /seller_net_payable/);
});

await run("distributor attribution does not create money rail", () => {
  const frontendRuntime = read("src/frontend_runtime.ts");
  const sellerAnalytics = read("src/seller_analytics.ts");
  assert.match(sellerAnalytics, /attributed_gross/);
  assert.match(sellerAnalytics, /measurement_only: true/);
  assert.doesNotMatch(`${frontendRuntime}\n${sellerAnalytics}`, /distributor[^.\n]{0,80}(commission|payout|balance)/i);
});

console.log("All money tax invoice canon validation checks passed.");
