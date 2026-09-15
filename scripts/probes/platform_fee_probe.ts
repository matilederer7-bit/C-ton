// Executable probe used by scripts/money_tax_invoice_gate.cjs.
// Loads the real fee arithmetic and prints canonical vectors as JSON.
import { calculatePlatformFeeMoney, SITON_PLATFORM_FEE_RATE } from "../../src/platform_fee_money.ts";
import { SITON_PLATFORM_FEE_VAT_RATE } from "../../src/runtime_config.ts";

const vectors = {
  fee_rate: SITON_PLATFORM_FEE_RATE,
  fee_vat_rate: SITON_PLATFORM_FEE_VAT_RATE,
  no_vat_100: calculatePlatformFeeMoney({ grossAmount: 100, vatAmount: 0 }),
  vat_118: calculatePlatformFeeMoney({ grossAmount: 118, vatAmount: 18 }),
  refund_sign: calculatePlatformFeeMoney({ grossAmount: 100, vatAmount: 0, sign: -1 }),
  negative_vat_clamped: calculatePlatformFeeMoney({ grossAmount: 50, vatAmount: -10 })
};
process.stdout.write(JSON.stringify(vectors));
