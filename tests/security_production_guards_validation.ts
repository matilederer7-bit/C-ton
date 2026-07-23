import assert from "node:assert/strict";
import { assertProductionRuntimeGuards } from "../src/production_guards.js";

function production(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APP_DEPLOYMENT_MODE: "production",
    RUNTIME_ROLE: "web",
    PAYMENT_PROVIDER: "stripe",
    PAYMENT_PROVIDER_MODE: "stripe",
    STORAGE_ADAPTER: "object",
    DATABASE_URL: "postgresql://placeholder.invalid/siton",
    ADMIN_API_KEY: "placeholder",
    SELLER_SESSION_SECRET: "placeholder",
    PAYMENT_WEBHOOK_SECRET: "placeholder",
    DISABLE_OUTBOX_WORKER: "1",
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
assert.throws(() => assertProductionRuntimeGuards("web", production({ PAYMENT_WEBHOOK_SECRET: "" })), /PAYMENT_WEBHOOK_SECRET/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ RUNTIME_ROLE: "worker" })), /cannot start the web process/);
assert.throws(() => assertProductionRuntimeGuards("web", production({ DISABLE_OUTBOX_WORKER: "0" })), /DISABLE_OUTBOX_WORKER=1/);

console.log("PASS production guards reject unsafe live topology and providers without blocking demo/test");
