// R9C — financial constitution boundary/rounding proof (pure, no DB).
//
//   Siton commission = EXACTLY 8% of the authoritative charge base.
//   Applicable delivery is INCLUDED in the base. Authoritative buyer VAT is
//   EXCLUDED from the base. Distributor payout / commission = ZERO.
//
// Exhaustive cent-level sweep: for every gross from 0.01 to 5,000.00 ILS the
// computed fee equals the exact integer-arithmetic 8% (no float drift, no
// half-cent tie ambiguity), seller net + fee total always reconciles to the
// gross to the cent, VAT is removed from the base before the 8% is applied,
// refund mirrors are exact negatives, and the snapshot carries no distributor
// or affiliate revenue field.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculatePlatformFeeMoney, roundMoney, SITON_PLATFORM_FEE_RATE } from "../src/platform_fee_money.js";
import { SITON_PLATFORM_FEE_VAT_RATE } from "../src/runtime_config.js";

let passed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const cents = (amount: number) => Math.round(amount * 100);
// Exact integer 8%: cents*8 is an integer, so cents*8/100 never lands on a
// half-cent tie — Math.round here is exact (no float ambiguity possible).
const exactFeeCents = (baseCents: number) => Math.round((baseCents * 8) / 100);
const exactPercentCents = (valueCents: number, rate: number) => Math.round(valueCents * rate * 1e6) / 1e6; // rate applied in cent space
const vatOnFeeCents = (feeCents: number) => Math.round(exactPercentCents(feeCents, SITON_PLATFORM_FEE_VAT_RATE));

await run("commission rate is a literal 0.08 in source (no env override, no per-deal override)", async () => {
  assert.equal(SITON_PLATFORM_FEE_RATE, 0.08);
  const source = await readFile("src/platform_fee_money.ts", "utf8");
  assert.match(source, /export const SITON_PLATFORM_FEE_RATE = 0\.08;/);
  assert.doesNotMatch(source, /process\.env\.SITON_PLATFORM_FEE_RATE/);
});

await run("exhaustive cent sweep 0.01…5,000.00: fee = exact 8% of the VAT-exclusive base, net + fee reconciles to the cent", () => {
  let checked = 0;
  let tiesUp = 0;
  let tiesDown = 0;
  for (let grossCents = 1; grossCents <= 500_000; grossCents += 1) {
    const gross = grossCents / 100;
    const snap = calculatePlatformFeeMoney({ grossAmount: gross, vatAmount: 0 });
    const feeBase = cents(snap.platform_fee_base_amount);
    const expectedFee = exactFeeCents(grossCents);
    if (feeBase !== expectedFee) {
      throw new Error(`fee drift at gross ${gross}: got ${feeBase} cents, exact 8% is ${expectedFee} cents`);
    }
    const feeVat = cents(snap.platform_fee_vat_amount);
    const vatTie = (expectedFee * Math.round(SITON_PLATFORM_FEE_VAT_RATE * 100)) % 100 === 50;
    if (vatTie) {
      // 18% of a 2-decimal fee CAN land on an exact half-cent (e.g. fee 1.25 →
      // 0.225). roundMoney uses binary-float Math.round, so ties resolve by
      // float representation (0.22 here, 0.23 elsewhere) — a documented LOW
      // finding (≤ 1 agora, seller net still reconciles), not the 8% base.
      const expectedUp = vatOnFeeCents(expectedFee);
      if (feeVat !== expectedUp && feeVat !== expectedUp - 1) throw new Error(`fee-VAT off by more than a tie at gross ${gross}`);
      if (feeVat === expectedUp) tiesUp += 1; else tiesDown += 1;
    } else if (feeVat !== vatOnFeeCents(expectedFee)) {
      throw new Error(`fee-VAT drift at gross ${gross}: got ${feeVat}, expected ${vatOnFeeCents(expectedFee)}`);
    }
    const total = cents(snap.platform_fee_total_amount);
    if (total !== feeBase + feeVat) throw new Error(`fee total not base+vat at gross ${gross}`);
    if (cents(snap.platform_fee_amount) !== total) throw new Error(`platform_fee_amount != total at gross ${gross}`);
    if (cents(snap.seller_net_amount) + total !== grossCents) {
      throw new Error(`net + fee != gross at ${gross}: ${snap.seller_net_amount} + ${snap.platform_fee_total_amount}`);
    }
    if (cents(snap.fee_base_amount) !== grossCents) throw new Error(`base != gross without VAT at ${gross}`);
    checked += 1;
  }
  assert.equal(checked, 500_000);
  console.log(`INFO fee-VAT half-cent ties in sweep: rounded_up=${tiesUp} rounded_down=${tiesDown} (8% base itself: zero ties, zero drift)`);
});

await run("VAT is excluded from the 8% base for every buyer-VAT split (sweep of gross and VAT portions)", () => {
  let checked = 0;
  for (let grossCents = 100; grossCents <= 120_000; grossCents += 37) {
    for (const vatShare of [0, 0.17, 0.18, 0.5]) {
      const vatCents = Math.floor(grossCents * vatShare);
      const snap = calculatePlatformFeeMoney({ grossAmount: grossCents / 100, vatAmount: vatCents / 100 });
      const baseCents = grossCents - vatCents;
      assert.equal(cents(snap.fee_base_amount), baseCents, `base must be gross − VAT at gross ${grossCents} vat ${vatCents}`);
      assert.equal(cents(snap.platform_fee_base_amount), exactFeeCents(baseCents), `8% applies to the VAT-exclusive base at gross ${grossCents} vat ${vatCents}`);
      assert.equal(cents(snap.vat_amount), vatCents);
      assert.equal(cents(snap.seller_net_amount) + cents(snap.platform_fee_total_amount), grossCents, "seller net + fee total reconciles to gross even with VAT");
      checked += 1;
    }
  }
  assert.ok(checked > 10_000);
});

await run("delivery is included in the charge base (qty × price + delivery)", () => {
  const qty = 3, price = 10, delivery = 25;
  const gross = qty * price + delivery; // 55.00
  const snap = calculatePlatformFeeMoney({ grossAmount: gross, vatAmount: 0 });
  assert.equal(snap.platform_fee_base_amount, 4.4, "8% of 55.00 including delivery = 4.40");
  const withoutDelivery = calculatePlatformFeeMoney({ grossAmount: qty * price, vatAmount: 0 });
  assert.equal(withoutDelivery.platform_fee_base_amount, 2.4);
  assert.ok(snap.platform_fee_base_amount > withoutDelivery.platform_fee_base_amount, "delivery raises the fee base");
});

await run("boundaries: zero gross → all zero; VAT ≥ gross → zero base; huge gross exact; refund sign mirrors exactly", () => {
  const zero = calculatePlatformFeeMoney({ grossAmount: 0, vatAmount: 0 });
  for (const key of ["gross_amount", "fee_base_amount", "platform_fee_base_amount", "platform_fee_total_amount", "seller_net_amount"] as const) {
    assert.equal(zero[key], 0, key);
  }
  const vatDominant = calculatePlatformFeeMoney({ grossAmount: 10, vatAmount: 12 });
  assert.equal(vatDominant.fee_base_amount, 0);
  assert.equal(vatDominant.platform_fee_base_amount, 0);
  const huge = calculatePlatformFeeMoney({ grossAmount: 1_000_000, vatAmount: 0 });
  assert.equal(huge.platform_fee_base_amount, 80_000);
  assert.equal(cents(huge.seller_net_amount) + cents(huge.platform_fee_total_amount), 100_000_000);
  const charge = calculatePlatformFeeMoney({ grossAmount: 123.45, vatAmount: 0 });
  const refund = calculatePlatformFeeMoney({ grossAmount: 123.45, vatAmount: 0, sign: -1 });
  for (const key of ["gross_amount", "fee_base_amount", "platform_fee_base_amount", "platform_fee_vat_amount", "platform_fee_total_amount", "platform_fee_amount", "seller_net_amount"] as const) {
    assert.equal(cents(refund[key]), -cents(charge[key]), `${key} refund mirror`);
  }
});

await run("roundMoney is cent-exact on the non-tie values the 8% rail produces (ties are the documented LOW finding above)", () => {
  assert.equal(roundMoney(12.34 * 0.08), 0.99);
  assert.equal(roundMoney(0.63 * 0.08), 0.05);
  assert.equal(roundMoney(99.99 * 0.08), 8);
  assert.equal(roundMoney(1000 * 0.08), 80);
  assert.equal(roundMoney(55 * 0.08), 4.4);
});

await run("snapshot carries the 8% rate and NO distributor / affiliate revenue field", () => {
  const snap = calculatePlatformFeeMoney({ grossAmount: 1000, vatAmount: 0 }) as Record<string, unknown>;
  assert.equal(snap.platform_fee_rate, 0.08);
  for (const key of Object.keys(snap)) {
    assert.doesNotMatch(key, /distributor|affiliate|commission_share|referral/i, `forbidden revenue field ${key}`);
  }
  assert.equal(snap.platform_fee_base_amount, 80);
  assert.equal(snap.seller_net_amount, 1000 - Number(snap.platform_fee_total_amount));
});

console.log(`PLATFORM_FEE_BOUNDARY_ROUNDING_VALIDATION passed=${passed}`);
