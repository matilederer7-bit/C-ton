// Mutation controls for scripts/money_tax_invoice_gate.cjs.
//
// The gate must PASS on the real repository and must FAIL when a money
// invariant is broken - regardless of how the code is formatted. Each mutation
// is applied to a disposable fixture copy; the repository is never touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFixtureRepo } = require("./support/fixture_repo.cjs");

const FIXTURE_FILES = [
  "src/platform_fee_money.ts",
  "src/runtime_config.ts",
  "src/vat_authority.ts",
  "src/schema_contract.ts",
  "src/seller_analytics.ts",
  "src/frontend_runtime.ts",
  "src/invoice_dispatch.ts",
  "src/app.ts",
  "src/payout_rail.ts",
  "src/migrations/019_platform_fee_money_events.sql",
  "docs/MONEY_TAX_INVOICE_CANON.md",
  "frontend/app.js",
  "tests/seller_deal_excel_export_validation.ts",
  "scripts/probes/platform_fee_probe.ts",
  "scripts/lib",
  "scripts/money_tax_invoice_gate.cjs"
];

function runGate(fixture) {
  const result = fixture.run("scripts/money_tax_invoice_gate.cjs");
  return { status: result.status, out: String(result.stdout || "") + String(result.stderr || "") };
}

test("money/tax gate passes on the real code and survives a pure reformat of the gross arithmetic", () => {
  const fixture = createFixtureRepo(FIXTURE_FILES);
  try {
    const clean = runGate(fixture);
    assert.equal(clean.status, 0, clean.out);
    assert.match(clean.out, /MONEY_TAX_INVOICE_CANON_PASS_WITH_MANUAL_CHECKS/);

    // Reformat only: same arithmetic, different shape. The old gate failed here.
    fixture.mutate("src/platform_fee_money.ts",
      "const productGross = Number(row.qty || 0) * Number(row.price_per_unit || 0);\n  const deliveryGross = Number(row.delivery_cost || 0);\n  const grossAmount = productGross + deliveryGross;",
      "const q = Number(row.qty || 0);\n  const unit = Number(row.price_per_unit || 0);\n  const productGross = q * unit;\n  const deliveryGross = Number(\n    row.delivery_cost || 0\n  );\n  const grossAmount = deliveryGross + productGross;");
    const reformatted = runGate(fixture);
    assert.equal(reformatted.status, 0, reformatted.out);
  } finally {
    fixture.cleanup();
  }
});

const MUTATIONS = [
  {
    name: "fee rate changed from 8% to 10%",
    file: "src/platform_fee_money.ts",
    from: "export const SITON_PLATFORM_FEE_RATE = 0.08;",
    to: "export const SITON_PLATFORM_FEE_RATE = 0.10;",
    expect: /fee rate|0\.08|fee vector/
  },
  {
    name: "fee base no longer excludes VAT",
    file: "src/platform_fee_money.ts",
    from: "const feeBaseAmount = roundMoney(Math.max(0, grossAmount - vatAmount));",
    to: "const feeBaseAmount = roundMoney(Math.max(0, grossAmount));",
    expect: /EXCLUDE buyer VAT/
  },
  {
    name: "seller net no longer subtracts the fee VAT",
    file: "src/platform_fee_money.ts",
    from: "const sellerNetAmount = roundMoney(grossAmount - platformFeeTotalAmount);",
    to: "const sellerNetAmount = roundMoney(grossAmount - platformFeeBaseAmount);",
    expect: /fee vector/
  },
  {
    name: "delivery dropped from gross",
    file: "src/platform_fee_money.ts",
    from: "const deliveryGross = Number(row.delivery_cost || 0);",
    to: "const deliveryGross = 0;",
    expect: /delivery_cost/
  },
  {
    name: "recovery event type removed from the TS union",
    file: "src/platform_fee_money.ts",
    from: "  | \"recovery_captured\"\n",
    to: "",
    expect: /PlatformFeeFinancialEventType/
  },
  {
    name: "VAT default changed to 17%",
    file: "src/runtime_config.ts",
    from: "readNumberEnv(\"SITON_PLATFORM_FEE_VAT_RATE\", 0.18)",
    to: "readNumberEnv(\"SITON_PLATFORM_FEE_VAT_RATE\", 0.17)",
    expect: /0\.18/
  },
  {
    name: "charge receipt eligible before completion",
    file: "src/invoice_dispatch.ts",
    from: "export const CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES = [\"DealCompleted\"] as const;",
    to: "export const CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES = [\"DealCompleted\", \"JoinedAuthorized\"] as const;",
    expect: /post-completion only/
  },
  {
    name: "invoice payload stops passing the fee VAT amount",
    file: "src/app.ts",
    from: "platformFeeVatAmount: money.platform_fee_vat_amount,",
    to: "platformFeeVatAmount: 0,",
    expect: /platformFeeVatAmount/
  },
  {
    name: "payout rail derives seller net from gross instead of the ledger",
    file: "src/payout_rail.ts",
    from: "COALESCE(SUM(seller_net_amount), 0) AS seller_net_payable",
    to: "COALESCE(SUM(gross_amount), 0) AS seller_net_payable",
    expect: /seller_net_payable/
  }
];

for (const mutation of MUTATIONS) {
  test("money/tax gate fails when: " + mutation.name, () => {
    const fixture = createFixtureRepo(FIXTURE_FILES);
    try {
      fixture.mutate(mutation.file, mutation.from, mutation.to);
      const result = runGate(fixture);
      assert.notEqual(result.status, 0, "gate should fail: " + mutation.name + "\n" + result.out);
      assert.match(result.out, /MONEY_TAX_INVOICE_CANON_FAIL/);
      assert.match(result.out, mutation.expect);
    } finally {
      fixture.cleanup();
    }
  });
}
