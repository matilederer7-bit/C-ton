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
    ADMIN_API_KEY: "placeholder",
    SELLER_SESSION_SECRET: "placeholder",
    PAYMENT_WEBHOOK_SECRET: "whsec_contract_fixture",
    DISABLE_OUTBOX_WORKER: "1",
    // R9A: production charging requires the explicit VAT authority.
    SITON_VAT_MODE: "explicit",
    SITON_VAT_RATE_PRODUCT: "0.18",
    SITON_VAT_RATE_DELIVERY: "0.18",
    ...overrides
  };
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

// A declared RUNTIME_ROLE must match the starting process in EVERY mode:
// a staging Worker misconfigured as web fails closed at boot, not only in
// production, while an undeclared role stays permissive outside production.
assert.throws(() => assertProductionRuntimeGuards("worker", { APP_DEPLOYMENT_MODE: "staging", RUNTIME_ROLE: "web" }), /cannot start the worker process/);
assert.throws(() => assertProductionRuntimeGuards("web", { APP_DEPLOYMENT_MODE: "staging", RUNTIME_ROLE: "worker" }), /cannot start the web process/);
assert.doesNotThrow(() => assertProductionRuntimeGuards("worker", { APP_DEPLOYMENT_MODE: "staging", RUNTIME_ROLE: "worker" }));
assert.doesNotThrow(() => assertProductionRuntimeGuards("worker", { APP_DEPLOYMENT_MODE: "staging" }));

console.log("PASS production guards reject unsafe live topology and providers without blocking demo/test");
