import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

async function run(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("production runtime cannot fall back to mock-backed payment provider", async () => {
  process.env.APP_DEPLOYMENT_MODE = "production";
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.PAYMENT_PROVIDER_MODE;
  delete process.env.PAYMENT_PROVIDER_BASE_URL;
  delete process.env.PAYMENT_PROVIDER_API_KEY;
  delete process.env.PAYMENT_PROVIDER_PUBLIC_KEY;
  delete process.env.PAYMENT_WEBHOOK_SECRET;
  delete process.env.STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION;

  const { buildPaymentProvider } = await import(`../src/payment_provider.js?prod-mock-guard-${Date.now()}`);
  assert.throws(
    () => buildPaymentProvider(),
    /production payment provider cannot use mock-backed mode/i
  );
});

await run("production provider-ready mode has fail-fast env and webhook-secret guards", async () => {
  const source = await readFile("src/payment_provider.ts", "utf8");
  assert.match(source, /PAYMENT_PROVIDER_MODE === "provider-ready"/);
  assert.match(source, /isProductionRuntime\(\)[\s\S]*PAYMENT_PROVIDER_BASE_URL[\s\S]*requires PAYMENT_PROVIDER_BASE_URL in production/);
  assert.match(source, /isProductionRuntime\(\)[\s\S]*PAYMENT_PROVIDER_API_KEY[\s\S]*requires PAYMENT_PROVIDER_API_KEY in production/);
  assert.match(source, /isProductionRuntime\(\)[\s\S]*PAYMENT_WEBHOOK_SECRET[\s\S]*PAYMENT_WEBHOOK_SECRET_IS_DEFAULT[\s\S]*requires a non-default PAYMENT_WEBHOOK_SECRET in production/);
});

await run("production Stripe mode requires secrets and blocks raw-card tokenization", async () => {
  const source = await readFile("src/payment_provider.ts", "utf8");
  assert.match(source, /PAYMENT_PROVIDER === "stripe" \|\| PAYMENT_PROVIDER_MODE === "stripe"/);
  assert.match(source, /PAYMENT_PROVIDER=stripe requires PAYMENT_PROVIDER_API_KEY in production/);
  assert.match(source, /PAYMENT_PROVIDER=stripe requires PAYMENT_PROVIDER_PUBLIC_KEY in production/);
  assert.match(source, /PAYMENT_PROVIDER=stripe requires a non-default PAYMENT_WEBHOOK_SECRET in production/);
  assert.match(source, /STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION must be disabled in production/);
});

await run("provider readiness status distinguishes mock-backed from live transport", async () => {
  const providerSource = await readFile("src/payment_provider.ts", "utf8");
  const readinessSource = await readFile("src/operational_readiness.ts", "utf8");
  assert.match(providerSource, /mock_backed: provider\.mode === "mock-backed"/);
  assert.match(providerSource, /authorization_transport_live: provider\.mode !== "mock-backed" && provider\.configured/);
  assert.match(providerSource, /webhook_verification_live: provider\.mode === "stripe" && provider\.configured/);
  assert.match(readinessSource, /core-money-rail-ready/);
  assert.match(readinessSource, /can_activate_now: payment\.mode !== "mock-backed" && payment\.configured \? "partially" : "no"/);
  assert.match(readinessSource, /blocked-by-missing-provider-env/);
});

await run("demo preview remains the only default mock-backed runtime", async () => {
  const runtimeSource = await readFile("src/runtime_config.ts", "utf8");
  const providerSource = await readFile("src/payment_provider.ts", "utf8");
  assert.match(runtimeSource, /APP_DEPLOYMENT_MODE = process\.env\.APP_DEPLOYMENT_MODE \|\| "demo-preview"/);
  assert.match(runtimeSource, /PAYMENT_PROVIDER_MODE = process\.env\.PAYMENT_PROVIDER_MODE \|\| "mock-backed"/);
  assert.match(providerSource, /if \(isProductionRuntime\(\)\) \{[\s\S]*production payment provider cannot use mock-backed mode/);
});

process.exit(0);
