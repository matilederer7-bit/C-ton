import assert from "node:assert/strict";
import { assertProductionRuntimeGuards } from "../src/production_guards.js";

function production(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APP_DEPLOYMENT_MODE: "production",
    RUNTIME_ROLE: "web",
    PAYMENT_PROVIDER: "stripe",
    PAYMENT_PROVIDER_MODE: "stripe",
    PAYMENT_ENVIRONMENT: "production",
    PAYMENT_PROVIDER_API_KEY: "sk_live_contract_fixture",
    PAYMENT_PROVIDER_PUBLIC_KEY: "pk_live_contract_fixture",
    STORAGE_ADAPTER: "object",
    OBJECT_STORAGE_REGION: "us-east-1",
    OBJECT_STORAGE_BUCKET: "siton-production-private",
    OBJECT_STORAGE_ACCESS_KEY_ID: "production-access-key",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "production-secret-key",
    DATABASE_URL: "postgresql://placeholder.invalid/siton",
    // A VALID production fixture must satisfy the production secret policy:
    // non-placeholder ADMIN_API_KEY (>=24) and SELLER_SESSION_SECRET (>=32),
    // and an OTP_HASH_SALT so OTP codes are not hashed with the public
    // default salt. Synthetic values, never real secrets.
    ADMIN_API_KEY: "8f3c1d2e9a7b4c6d8e0f1a2b3c4d5e6f",
    SELLER_SESSION_SECRET: "0123456789abcdef0123456789abcdef0123",
    OTP_HASH_SALT: "9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f",
    PAYMENT_WEBHOOK_SECRET: "whsec_contract_fixture",
    DISABLE_OUTBOX_WORKER: "1",
    // R9A: production charging requires the explicit VAT authority.
    SITON_VAT_MODE: "explicit",
    SITON_VAT_RATE_PRODUCT: "0.18",
    SITON_VAT_RATE_DELIVERY: "0.18",
    ...overrides
  };
}

function growProduction(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return production({
    PAYMENT_PROVIDER: "grow",
    PAYMENT_PROVIDER_MODE: "grow",
    PAYMENT_ENVIRONMENT: "live",
    PAYMENT_PROVIDER_BASE_URL: "https://secure.meshulam.co.il/api/light/server/1.0",
    GROW_USER_ID: "grow-live-contract-user",
    GROW_PAGE_CODE: "grow-live-contract-page",
    GROW_REFERENCE_ENCRYPTION_KEY: "grow-live-reference-key-32-characters-minimum",
    GROW_SUCCESS_URL: "https://siton.example.invalid/pay/success",
    GROW_CANCEL_URL: "https://siton.example.invalid/pay/cancel",
    GROW_NOTIFY_URL: "https://siton.example.invalid/webhooks/payments/grow",
    ...overrides
  });
}

assert.doesNotThrow(() => assertProductionRuntimeGuards("web", { APP_DEPLOYMENT_MODE: "demo-preview" }));
assert.doesNotThrow(() => assertProductionRuntimeGuards("worker", { APP_DEPLOYMENT_MODE: "test", PAYMENT_PROVIDER: "mockpay" }));
assert.doesNotThrow(() => assertProductionRuntimeGuards("web", production()));
assert.doesNotThrow(() => assertProductionRuntimeGuards("worker", production({ RUNTIME_ROLE: "worker", DISABLE_OUTBOX_WORKER: "0" })));
assert.throws(() => assertProductionRuntimeGuards("web", production({ PAYMENT_PROVIDER: "mockpay" })), /mock PAYMENT_PROVIDER/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ PAYMENT_PROVIDER_MODE: "mock-backed" })), /mock-backed/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ STORAGE_ADAPTER: "local" })), /STORAGE_ADAPTER=object/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ OBJECT_STORAGE_BUCKET: "" })), /OBJECT_STORAGE_BUCKET/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ OBJECT_STORAGE_ACCESS_KEY_ID: "placeholder" })), /placeholder/);
assert.throws(() => assertProductionRuntimeGuards("web", { APP_DEPLOYMENT_MODE: "sandbox", STORAGE_ADAPTER: "object" }), /external storage runtime guard/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ PAYMENT_WEBHOOK_SECRET: "" })), /PAYMENT_WEBHOOK_SECRET/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ RUNTIME_ROLE: "worker" })), /cannot start the web process/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ DISABLE_OUTBOX_WORKER: "0" })), /DISABLE_OUTBOX_WORKER=1/);

// Grow LIVE is a money boundary, not an arbitrary HTTPS transport. Production
// must be pinned to the provider's canonical live host so a typo/compromised
// config cannot redirect credentials and financial requests elsewhere.
assert.doesNotThrow(() => assertProductionRuntimeGuards("web", growProduction()));
assert.throws(
  () => assertProductionRuntimeGuards("web", growProduction({ PAYMENT_PROVIDER_BASE_URL: "https://payments.example.invalid/api" })),
  /secure\.meshulam\.co\.il/
);
assert.throws(
  () => assertProductionRuntimeGuards("web", growProduction({ PAYMENT_PROVIDER_BASE_URL: "https://sandbox.meshulam.co.il/api/light/server/1.0" })),
  /secure\.meshulam\.co\.il/
);

// A declared RUNTIME_ROLE must match the starting process in EVERY mode:
// a staging Worker misconfigured as web fails closed at boot, not only in
// production, while an undeclared role stays permissive outside production.
assert.throws(() => assertProductionRuntimeGuards("worker", { APP_DEPLOYMENT_MODE: "staging", RUNTIME_ROLE: "web" }), /cannot start the worker process/);
assert.throws(() => assertProductionRuntimeGuards("web", { APP_DEPLOYMENT_MODE: "staging", RUNTIME_ROLE: "worker" }), /cannot start the web process/);
assert.doesNotThrow(() => assertProductionRuntimeGuards("worker", { APP_DEPLOYMENT_MODE: "staging", RUNTIME_ROLE: "worker" }));
assert.doesNotThrow(() => assertProductionRuntimeGuards("worker", { APP_DEPLOYMENT_MODE: "staging" }));

console.log("PASS production guards reject unsafe live topology and providers without blocking demo/test");
