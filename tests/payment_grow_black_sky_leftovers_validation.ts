// Black-Sky Grow leftovers:
//  (1) assertProductionRuntimeGuards validates the Grow reference keyring
//      (GROW_REFERENCE_ENCRYPTION_KEY_ID / GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS)
//      at startup — before, a malformed rotation config only surfaced as an
//      undecryptable sealed reference in the middle of a money operation;
//  (2) the payment_provider mapping keeps the adapter's configuration_fault tag
//      (it was dropped by executionResult);
//  (3) a pre-settle READ-ONLY lookup answering a bare HTTP 400/422 is NOT a
//      provider-declared outcome: it is a bounded pre-dispatch retry
//      (temporary_fail, dispatched:false), never a permanent_fail that the rails
//      turn into a fabricated charge_failed. An explicit parseable Grow
//      rejection stays declared (no over-correction).
// No network, no money: in-process stub transports only.
import assert from "node:assert/strict";

const GROW_KEY = "grow-sandbox-reference-encryption-key-48-characters!";
process.env.PAYMENT_PROVIDER = "grow";
process.env.PAYMENT_PROVIDER_MODE = "grow";
process.env.PAYMENT_ENVIRONMENT = "sandbox";
process.env.PAYMENT_PROVIDER_BASE_URL = "https://sandbox.meshulam.co.il/api/light/server/1.0";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "1000";
process.env.GROW_USER_ID = "grow-sandbox-user";
process.env.GROW_PAGE_CODE = "grow-sandbox-page";
process.env.GROW_REFERENCE_ENCRYPTION_KEY = GROW_KEY;
process.env.GROW_SUCCESS_URL = "https://siton-staging.example.invalid/pay/success";
process.env.GROW_CANCEL_URL = "https://siton-staging.example.invalid/pay/cancel";
process.env.GROW_NOTIFY_URL = "https://siton-staging.example.invalid/webhooks/payments/grow";

let transportReply: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: { status: 1, err: "", data: {} } });
const requested: string[] = [];
(globalThis as Record<string, unknown>).__SITON_GROW_TEST_TRANSPORT__ = async (request: { url: string }) => {
  requested.push(request.url);
  return transportReply(request.url);
};

const { assertProductionRuntimeGuards } = await import("../src/production_guards.js");
const { buildGrowPaymentAdapter, sealGrowReference } = await import("../src/grow_payment_adapter.js");
const { buildPaymentProvider } = await import(`../src/payment_provider.js?grow-leftovers-${Date.now()}`);

let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
  }
}

function growProduction(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APP_DEPLOYMENT_MODE: "production",
    RUNTIME_ROLE: "web",
    PAYMENT_PROVIDER: "grow",
    PAYMENT_PROVIDER_MODE: "grow",
    PAYMENT_ENVIRONMENT: "live",
    PAYMENT_PROVIDER_BASE_URL: "https://secure.meshulam.co.il/api/light/server/1.0",
    PAYMENT_PROVIDER_API_KEY: "grow-live-contract-api-key",
    GROW_USER_ID: "grow-live-contract-user",
    GROW_PAGE_CODE: "grow-live-contract-page",
    GROW_REFERENCE_ENCRYPTION_KEY: "grow-live-reference-key-32-characters-minimum",
    GROW_SUCCESS_URL: "https://siton.example.invalid/pay/success",
    GROW_CANCEL_URL: "https://siton.example.invalid/pay/cancel",
    GROW_NOTIFY_URL: "https://siton.example.invalid/webhooks/payments/grow",
    STORAGE_ADAPTER: "object",
    OBJECT_STORAGE_REGION: "us-east-1",
    OBJECT_STORAGE_BUCKET: "siton-production-private",
    OBJECT_STORAGE_ACCESS_KEY_ID: "production-access-key",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "production-secret-key",
    DATABASE_URL: "postgresql://placeholder.invalid/siton",
    CANONICAL_POSTGRES_RUNTIME: "1",
    ADMIN_API_KEY: "8f3c1d2e9a7b4c6d8e0f1a2b3c4d5e6f",
    SELLER_SESSION_SECRET: "0123456789abcdef0123456789abcdef0123",
    OTP_HASH_SALT: "9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f",
    OTP_TOKEN_SECRET: "4e7a1c9d2b8f6e3a5c0d7b9e1f4a8c2d6e0b3f5a",
    PAYMENT_WEBHOOK_SECRET: "whsec_contract_fixture",
    DISABLE_OUTBOX_WORKER: "1",
    SITON_VAT_MODE: "explicit",
    SITON_VAT_RATE_PRODUCT: "0.18",
    SITON_VAT_RATE_DELIVERY: "0.18",
    ...overrides
  };
}

// ---- (1) keyring validated at startup -------------------------------------
await check("precondition: the valid Grow production fixture passes the guards", () => {
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", growProduction()));
  assert.doesNotThrow(() => assertProductionRuntimeGuards("web", growProduction({
    GROW_REFERENCE_ENCRYPTION_KEY_ID: "k2026",
    GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: "k2025:previous-live-reference-key-32-characters-min"
  })));
});
await check("an invalid GROW_REFERENCE_ENCRYPTION_KEY_ID is refused at startup", () => {
  assert.throws(() => assertProductionRuntimeGuards("web", growProduction({ GROW_REFERENCE_ENCRYPTION_KEY_ID: "bad kid with spaces!" })), /GROW_REFERENCE_ENCRYPTION_KEY_ID/);
});
await check("a short previous rotation key is refused at startup", () => {
  assert.throws(() => assertProductionRuntimeGuards("web", growProduction({ GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: "old:short" })), /GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS/);
});
await check("one key id naming two different secrets is refused at startup", () => {
  assert.throws(() => assertProductionRuntimeGuards("web", growProduction({
    GROW_REFERENCE_ENCRYPTION_KEY_ID: "k1",
    GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: "k1:a-different-previous-reference-key-32-characters"
  })), /GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS/);
});
await check("a placeholder previous rotation key is refused at startup", () => {
  assert.throws(() => assertProductionRuntimeGuards("web", growProduction({ GROW_REFERENCE_ENCRYPTION_PREVIOUS_KEYS: "old:placeholder-reference-key-32-characters-minimum" })), /placeholder/);
});

// ---- (2) configuration_fault survives the provider mapping -----------------
const provider = buildPaymentProvider();
const confirmed = sealGrowReference({ process_id: "p-1", process_token: "pt-1", transaction_id: "tx-1", transaction_token: "txt-1" }, GROW_KEY);
const processOnly = sealGrowReference({ process_id: "p-2", process_token: "pt-2" }, GROW_KEY);

await check("settle answered 403: UNKNOWN (dispatched) and the configuration_fault tag reaches the rails", async () => {
  transportReply = () => ({ status: 403, body: { status: 0, err: "forbidden" } });
  const result = await provider.capture({ authorization_id: confirmed, amount_minor: 5000, correlation_id: "corr-cf-1" });
  assert.equal(result.result_class, "unknown");
  assert.equal(result.dispatched, true);
  assert.equal((result as any).configuration_fault, true);
});
await check("pre-settle lookup answered 403: pre-dispatch retry, no settle sent, configuration_fault tagged", async () => {
  requested.length = 0;
  transportReply = () => ({ status: 403, body: { status: 0, err: "forbidden" } });
  const result = await provider.capture({ authorization_id: processOnly, amount_minor: 5000, correlation_id: "corr-cf-2" });
  assert.equal(result.result_class, "temporary_fail");
  assert.equal(result.dispatched, false);
  assert.equal((result as any).configuration_fault, true);
  assert.equal(requested.some((url) => url.endsWith("/settleSuspendedTransaction")), false);
});
await check("negative: a genuine settle success carries no configuration_fault tag", async () => {
  transportReply = () => ({ status: 200, body: { status: 1, err: "", data: {} } });
  const result = await provider.capture({ authorization_id: confirmed, amount_minor: 5000, correlation_id: "corr-cf-3" });
  assert.equal(result.result_class, "success");
  assert.equal("configuration_fault" in result, false);
});

// ---- (3) pre-settle lookup 400/422 is not a declared outcome ---------------
const config = {
  base_url: "https://sandbox.meshulam.co.il/api/light/server/1.0",
  environment: "sandbox",
  user_id: "sandbox-user",
  page_code: "sandbox-page",
  api_key: "sandbox-api-key",
  reference_encryption_key: GROW_KEY,
  success_url: "https://example.invalid/pay/success",
  cancel_url: "https://example.invalid/pay/cancel",
  notify_url: "https://example.invalid/webhooks/payments/grow",
  timeout_ms: 1000,
  paths: { create: "/createPaymentProcess", process_info: "/getPaymentProcessInfo", settle: "/settleSuspendedTransaction", refund: "/refundTransaction", transaction_info: "/getTransactionInfo", approve: "/approveTransaction" }
};
for (const status of [400, 422]) {
  await check(`pre-settle lookup HTTP ${status}: bounded pre-dispatch retry (never a declared capture failure), no settle sent`, async () => {
    const urls: string[] = [];
    const adapter = buildGrowPaymentAdapter({ config, transport: async (request) => { urls.push(request.url); return { status, body: { status: 0, err: "bad request" } }; } });
    const result = await adapter.capture(processOnly, 5000);
    assert.equal(result.result_class, "temporary_fail", `lookup ${status}`);
    assert.equal(result.dispatched, false);
    assert.equal(result.retryable, true);
    assert.equal(urls.some((url) => url.endsWith("/settleSuspendedTransaction")), false);
  });
}
await check("negative: an explicit parseable Grow rejection of the lookup stays a declared failure (dispatched:false)", async () => {
  const adapter = buildGrowPaymentAdapter({ config, transport: async () => ({ status: 200, body: { status: 0, err: { id: 400, message: "process not found" }, data: "" } }) });
  const result = await adapter.capture(processOnly, 5000);
  assert.equal(result.result_class, "permanent_fail");
  assert.equal(result.dispatched, false);
});

process.exit(failed ? 1 : 0);
