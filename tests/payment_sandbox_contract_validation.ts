import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertProductionRuntimeGuards } from "../src/production_guards.js";

function base(role: "web" | "worker") {
  return {
    APP_DEPLOYMENT_MODE: "production",
    PAYMENT_ENVIRONMENT: "live",
    PAYMENT_PROVIDER: "stripe",
    PAYMENT_PROVIDER_MODE: "stripe",
    PAYMENT_PROVIDER_API_KEY: "sk_live_contract_value",
    PAYMENT_PROVIDER_PUBLIC_KEY: "pk_live_contract_value",
    PAYMENT_WEBHOOK_SECRET: "whsec_contract_value",
    STORAGE_ADAPTER: "object",
    OBJECT_STORAGE_REGION: "eu-test-1",
    OBJECT_STORAGE_BUCKET: "contract-bucket",
    OBJECT_STORAGE_ACCESS_KEY_ID: "contract-access",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "contract-secret",
    DATABASE_URL: "postgresql://contract.invalid/siton",
    ADMIN_API_KEY: "contract-admin",
    SELLER_SESSION_SECRET: "contract-session",
    RUNTIME_ROLE: role,
    DISABLE_OUTBOX_WORKER: role === "web" ? "1" : undefined,
    // R9A: production charging requires the explicit VAT authority.
    SITON_VAT_MODE: "explicit",
    SITON_VAT_RATE_PRODUCT: "0.18",
    SITON_VAT_RATE_DELIVERY: "0.18"
  } as NodeJS.ProcessEnv;
}

// R9A: production without explicit VAT authority fails closed.
assert.throws(
  () => assertProductionRuntimeGuards("web", { ...base("web"), SITON_VAT_MODE: undefined }),
  /SITON_VAT_MODE=explicit/
);

const web = base("web");
assert.doesNotThrow(() => assertProductionRuntimeGuards("web", web));
const worker = base("worker");
delete worker.PAYMENT_PROVIDER_PUBLIC_KEY;
delete worker.PAYMENT_WEBHOOK_SECRET;
assert.doesNotThrow(() => assertProductionRuntimeGuards("worker", worker), "worker receives only the secret key needed for money operations");

assert.throws(() => assertProductionRuntimeGuards("web", { ...web, PAYMENT_ENVIRONMENT: "sandbox", PAYMENT_PROVIDER_API_KEY: "sk_test_contract", PAYMENT_PROVIDER_PUBLIC_KEY: "pk_test_contract" }), /production cannot use/);
assert.throws(() => assertProductionRuntimeGuards("web", { ...web, PAYMENT_PROVIDER_API_KEY: "sk_test_contract" }), /test credentials|sk_live_/);
assert.throws(() => assertProductionRuntimeGuards("web", { ...web, PAYMENT_PROVIDER_BASE_URL: "https:\/\/sandbox-gateway.invalid" }), /canonical https:\/\/api\.stripe\.com endpoint/);
assert.throws(() => assertProductionRuntimeGuards("web", { ...web, PAYMENT_WEBHOOK_SECRET: "placeholder" }), /non-placeholder/);

const sandbox = { ...web, APP_DEPLOYMENT_MODE: "sandbox", PAYMENT_ENVIRONMENT: "sandbox", PAYMENT_PROVIDER_API_KEY: "sk_test_contract", PAYMENT_PROVIDER_PUBLIC_KEY: "pk_test_contract", PAYMENT_WEBHOOK_SECRET: "whsec_contract", STORAGE_ADAPTER: "local" };
assert.doesNotThrow(() => assertProductionRuntimeGuards("web", sandbox));
assert.throws(() => assertProductionRuntimeGuards("web", { ...sandbox, PAYMENT_PROVIDER_API_KEY: "" }), /sk_test_/);
assert.throws(() => assertProductionRuntimeGuards("web", { ...sandbox, PAYMENT_PROVIDER_API_KEY: "sk_live_forbidden", PAYMENT_PROVIDER_PUBLIC_KEY: "pk_live_forbidden" }), /sk_test_|live Stripe credentials/);

const providerSource = await readFile("src/payment_provider.ts", "utf8");
assert.match(providerSource, /amount: amountMinor/);
assert.match(providerSource, /amount_to_capture: Number\.isInteger\(amountMinor\)/);
assert.match(providerSource, /amount: Number\.isInteger\(amountMinor\)/);
assert.doesNotMatch(providerSource, /platform_fee.*stripePost|stripePost[\s\S]{0,300}platform_fee/i, "adapter must consume canonical minor amounts, not recompute fees");
assert.match(providerSource, /idempotency-key/);
assert.match(providerSource, /payment_intents\/\$\{encodeURIComponent\(paymentIntentId\)\}\/cancel/);
assert.match(providerSource, /async status\(input: PaymentStatusInput\)/);
assert.match(providerSource, /retryable: false[\s\S]{0,180}provider_reference: paymentIntentId/, "outcome-unknown money failures must reconcile instead of blind retry");

console.log("PASS Stripe Sandbox guards, role-scoped secrets, canonical amounts, release, status and no-blind-retry contract");