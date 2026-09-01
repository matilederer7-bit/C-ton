import assert from "node:assert/strict";
import "dotenv/config";

// R9A — provider environment safety + capability-level readiness + VAT
// authority fail-closed behavior. Pure config/module tests; no network.

process.env.APP_DEPLOYMENT_MODE = "demo-preview";

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
    failed += 1;
  }
}

const { assertProductionRuntimeGuards } = await import(`../src/production_guards.js?guards-${Date.now()}`);

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_DEPLOYMENT_MODE: "production",
    PAYMENT_ENVIRONMENT: "live",
    PAYMENT_PROVIDER: "stripe",
    PAYMENT_PROVIDER_MODE: "stripe",
    PAYMENT_PROVIDER_API_KEY: "sk_live_capability_value",
    PAYMENT_PROVIDER_PUBLIC_KEY: "pk_live_capability_value",
    PAYMENT_WEBHOOK_SECRET: "whsec_capability_value",
    PAYMENT_PROVIDER_BASE_URL: "https://api.stripe.com",
    STORAGE_ADAPTER: "object",
    OBJECT_STORAGE_REGION: "eu-central-1",
    OBJECT_STORAGE_BUCKET: "siton-prod",
    OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAREALVALUE",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "realsecretvalue",
    DATABASE_URL: "postgresql://cap-check",
    ADMIN_API_KEY: "admin-key-value",
    SELLER_SESSION_SECRET: "seller-secret-value",
    RUNTIME_ROLE: "web",
    DISABLE_OUTBOX_WORKER: "1",
    SITON_VAT_MODE: "explicit",
    SITON_VAT_RATE_PRODUCT: "0.18",
    SITON_VAT_RATE_DELIVERY: "0.18",
    ...overrides
  } as NodeJS.ProcessEnv;
}

await runTest("live payment environment is forbidden outside production deployment", async () => {
  assert.throws(
    () => assertProductionRuntimeGuards("web", {
      APP_DEPLOYMENT_MODE: "internal-runtime",
      PAYMENT_ENVIRONMENT: "live",
      STORAGE_ADAPTER: "local"
    } as NodeJS.ProcessEnv),
    /PAYMENT_ENVIRONMENT=live is only legal in production/
  );
});

await runTest("grow requires a declared sandbox/live environment and complete non-placeholder credentials", async () => {
  assert.throws(
    () => assertProductionRuntimeGuards("web", {
      APP_DEPLOYMENT_MODE: "internal-runtime",
      PAYMENT_PROVIDER: "grow",
      PAYMENT_ENVIRONMENT: "demo",
      STORAGE_ADAPTER: "local"
    } as NodeJS.ProcessEnv),
    /PAYMENT_PROVIDER=grow requires PAYMENT_ENVIRONMENT=sandbox or PAYMENT_ENVIRONMENT=live/
  );
  assert.throws(
    () => assertProductionRuntimeGuards("web", {
      APP_DEPLOYMENT_MODE: "internal-runtime",
      PAYMENT_PROVIDER: "grow",
      PAYMENT_ENVIRONMENT: "sandbox",
      GROW_USER_ID: "placeholder",
      GROW_PAGE_CODE: "pagecode-value",
      GROW_REFERENCE_ENCRYPTION_KEY: "a".repeat(40),
      PAYMENT_PROVIDER_BASE_URL: "https://sandbox.example",
      GROW_SUCCESS_URL: "https://app.example/success",
      GROW_CANCEL_URL: "https://app.example/cancel",
      GROW_NOTIFY_URL: "https://app.example/notify",
      STORAGE_ADAPTER: "local"
    } as NodeJS.ProcessEnv),
    /GROW_USER_ID cannot use a placeholder value/
  );
});

await runTest("production grow requires PAYMENT_ENVIRONMENT=live", async () => {
  assert.throws(
    () => assertProductionRuntimeGuards("worker", productionEnv({
      PAYMENT_PROVIDER: "grow",
      PAYMENT_PROVIDER_MODE: "grow",
      PAYMENT_ENVIRONMENT: "sandbox",
      GROW_USER_ID: "grow-user-value",
      GROW_PAGE_CODE: "grow-page-value",
      GROW_REFERENCE_ENCRYPTION_KEY: "k".repeat(40),
      PAYMENT_PROVIDER_BASE_URL: "https://secure.example",
      GROW_SUCCESS_URL: "https://app.example/success",
      GROW_CANCEL_URL: "https://app.example/cancel",
      GROW_NOTIFY_URL: "https://app.example/notify"
    })),
    /production cannot use PAYMENT_ENVIRONMENT=sandbox|requires PAYMENT_ENVIRONMENT=live/
  );
});

await runTest("production requires explicit VAT authority (fail closed)", async () => {
  assert.throws(
    () => assertProductionRuntimeGuards("web", productionEnv({ SITON_VAT_MODE: undefined })),
    /SITON_VAT_MODE=explicit/
  );
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", productionEnv()));
});

await runTest("real notification delivery fails closed (no real adapter exists)", async () => {
  assert.throws(
    () => assertProductionRuntimeGuards("worker", {
      APP_DEPLOYMENT_MODE: "internal-runtime",
      STORAGE_ADAPTER: "local",
      NOTIFICATION_PROVIDER: "twilio",
      NOTIFICATION_PROVIDER_MODE: "real"
    } as NodeJS.ProcessEnv),
    /requires a verified real notification adapter/
  );
  assert.throws(
    () => assertProductionRuntimeGuards("worker", {
      APP_DEPLOYMENT_MODE: "internal-runtime",
      STORAGE_ADAPTER: "local",
      NOTIFICATION_DELIVERY_ENABLED: "1"
    } as NodeJS.ProcessEnv),
    /NOTIFICATION_DELIVERY_ENABLED=1 requires NOTIFICATION_PROVIDER_MODE=real/
  );
});

await runTest("capability readiness is truthful: mock has full local capabilities, grow reports its gaps", async () => {
  process.env.PAYMENT_PROVIDER = "mockpay";
  process.env.PAYMENT_PROVIDER_MODE = "mock-backed";
  const providerModule = await import(`../src/payment_provider.js?caps-mock-${Date.now()}`);
  const mock = providerModule.buildPaymentProvider();
  const capabilities = providerModule.paymentProviderCapabilities(mock);
  assert.equal(capabilities.release, true);
  assert.equal(capabilities.status, true);
  assert.equal(capabilities.webhook_verification, false);
  const summary = providerModule.getPaymentProviderSummary(mock);
  assert.equal(summary.real_activation_ready, false, "mock-backed is never real-activation ready");
  assert.ok(Array.isArray(summary.capability_gaps));

  const grow = providerModule.buildGrowCanonicalPaymentProvider();
  const growGaps = providerModule.missingMandatoryCapabilities(grow);
  assert.deepEqual(growGaps.sort(), ["release", "webhook_parsing", "webhook_verification"].sort());
});

await runTest("grow in a real provider environment fails closed without native capabilities", async () => {
  // runtime_config captures env at first import, so the grow construction must
  // run in a fresh child process with the grow environment.
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(new URL("../src/payment_provider.js", import.meta.url).href)}).then((m) => {
         try { m.buildPaymentProvider(); console.log("NO_THROW"); }
         catch (e) { console.log("THREW:" + e.message); }
       }).catch((e) => { console.log("IMPORT_FAIL:" + e.message); process.exit(2); });`
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PAYMENT_PROVIDER: "grow",
        PAYMENT_PROVIDER_MODE: "grow",
        PAYMENT_ENVIRONMENT: "sandbox"
      }
    }
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert.match(output, /THREW:.*cannot start in a real provider environment without verified Grow-native capabilities/, output);
});

await runTest("VAT authority: synthetic zero is explicit, explicit mode computes per-component VAT", async () => {
  delete process.env.SITON_VAT_MODE;
  const vatModule = await import(`../src/vat_authority.js?vat-${Date.now()}`);
  const synthetic = vatModule.computeCustomerChargeVat({ productGrossAmount: 118, deliveryGrossAmount: 59 });
  assert.equal(synthetic.vat_mode, "synthetic_zero");
  assert.equal(synthetic.vat_amount, 0);

  process.env.SITON_VAT_MODE = "explicit";
  process.env.SITON_VAT_RATE_PRODUCT = "0.18";
  process.env.SITON_VAT_RATE_DELIVERY = "0";
  const explicit = vatModule.computeCustomerChargeVat({ productGrossAmount: 118, deliveryGrossAmount: 59 });
  assert.equal(explicit.vat_mode, "explicit");
  assert.equal(explicit.product_vat_amount, 18);
  assert.equal(explicit.delivery_vat_amount, 0);
  assert.equal(explicit.vat_amount, 18);

  process.env.SITON_VAT_MODE = "synthetic_zero";
  assert.throws(
    () => vatModule.assertVatAuthorityForRealMoney("test-context"),
    /requires SITON_VAT_MODE=explicit/
  );
  delete process.env.SITON_VAT_MODE;
  delete process.env.SITON_VAT_RATE_PRODUCT;
  delete process.env.SITON_VAT_RATE_DELIVERY;
});

await runTest("explicit VAT keeps the 8% fee base VAT-exclusive", async () => {
  process.env.SITON_VAT_MODE = "explicit";
  process.env.SITON_VAT_RATE_PRODUCT = "0.18";
  process.env.SITON_VAT_RATE_DELIVERY = "0.18";
  const vatModule = await import(`../src/vat_authority.js?vat-fee-${Date.now()}`);
  const feeModule = await import(`../src/platform_fee_money.js?fee-${Date.now()}`);
  const vat = vatModule.computeCustomerChargeVat({ productGrossAmount: 118, deliveryGrossAmount: 0 });
  const money = feeModule.calculatePlatformFeeMoney({ grossAmount: 118, vatAmount: vat.vat_amount });
  assert.equal(money.fee_base_amount, 100);
  assert.equal(money.platform_fee_base_amount, 8, "8% of the VAT-exclusive base");
  delete process.env.SITON_VAT_MODE;
  delete process.env.SITON_VAT_RATE_PRODUCT;
  delete process.env.SITON_VAT_RATE_DELIVERY;
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
