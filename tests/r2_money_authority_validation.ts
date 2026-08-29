import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  calculatePlatformFeeMoney,
  SITON_PLATFORM_FEE_RATE
} from "../src/platform_fee_money.js";

assert.equal(SITON_PLATFORM_FEE_RATE, 0.08);

const productPlusShipping = calculatePlatformFeeMoney({
  grossAmount: 135,
  vatAmount: 0
});
assert.equal(productPlusShipping.fee_base_amount, 135);
assert.equal(productPlusShipping.platform_fee_base_amount, 10.8);

const authoritativeBuyerVatExcluded = calculatePlatformFeeMoney({
  grossAmount: 135,
  vatAmount: 15
});
assert.equal(authoritativeBuyerVatExcluded.fee_base_amount, 120);
assert.equal(authoritativeBuyerVatExcluded.platform_fee_base_amount, 9.6);

const moneySource = await readFile("src/platform_fee_money.ts", "utf8");
assert.match(
  moneySource,
  /Number\(row\.qty \|\| 0\) \* Number\(row\.price_per_unit \|\| 0\) \+ Number\(row\.delivery_cost \|\| 0\)/
);
assert.match(moneySource, /vat_amount: 0/);
assert.doesNotMatch(moneySource, /distributor_commission|commission_rate/i);

const frontendSource = await readFile("src/frontend_runtime.ts", "utf8");
const serverMoneyAssignment = frontendSource.indexOf("authorizeInput.amount_minor = serverMoney");
assert.ok(serverMoneyAssignment >= 0, "provider amount must be overwritten with server-derived money");
assert.doesNotMatch(frontendSource, /authorizeInput\.(?:vat_amount|buyer_vat_amount)\s*=\s*body\./);
assert.doesNotMatch(frontendSource, /calculatePlatformFeeMoney\(\s*\{[^}]*vatAmount:\s*body\./s);

console.log("PASS 8% fee, shipping inclusion, VAT authority, and distributor zero");
