import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const serverKey = String(process.env.PAYMENT_PROVIDER_API_KEY || "");
const publicKey = String(process.env.PAYMENT_PROVIDER_PUBLIC_KEY || "");
const webhookSecret = String(process.env.PAYMENT_WEBHOOK_SECRET || "");
if (!serverKey.startsWith("sk_test_") || !publicKey.startsWith("pk_test_") || !webhookSecret.startsWith("whsec_")) {
  console.log("Stripe Sandbox external verification not executed");
  process.exit(78);
}
if (serverKey.startsWith("sk_live_") || publicKey.startsWith("pk_live_")) throw new Error("Live Stripe credentials are forbidden");

Object.assign(process.env, {
  APP_DEPLOYMENT_MODE: "sandbox",
  PAYMENT_ENVIRONMENT: "sandbox",
  PAYMENT_PROVIDER: "stripe",
  PAYMENT_PROVIDER_MODE: "stripe",
  PAYMENT_PROVIDER_BASE_URL: "https://api.stripe.com",
  PAYMENT_WEBHOOK_PROVIDER: "stripe",
  PAYMENT_PROVIDER_TIMEOUT_MS: process.env.PAYMENT_PROVIDER_TIMEOUT_MS || "8000",
  STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION: "0"
});

const { buildPaymentProvider } = await import("../src/payment_provider.js");
const provider = buildPaymentProvider();
assert.equal(provider.providerCode, "stripe");
assert.equal(provider.mode, "stripe");
assert.equal(provider.configured, true);
assert.ok(provider.status && provider.release);

const runId = randomUUID().replace(/-/g, "");
const authorizationKey = `siton_sb_auth_${runId}`;
const releaseKey = `siton_sb_release_${runId}`;
const amountMinor = 1000;
const currency = "ILS";
const input = {
  payment_method_id: "pm_card_visa",
  amount_minor: amountMinor,
  currency,
  buyer_id: `sandbox_buyer_${runId}`,
  deal_id: `sandbox_deal_${runId}`,
  correlation_id: authorizationKey,
  request_id: authorizationKey
};
let authorizationId = "";
let released = false;
const filteredReference = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

try {
  const authorized = await provider.authorize(input);
  assert.equal(authorized.ok, true, "Stripe Test Mode authorization must succeed");
  if (!authorized.ok) throw new Error(authorized.error);
  authorizationId = authorized.authorization_id;

  const status = await provider.status({ provider_reference: authorizationId, operation: "authorization", correlation_id: `${authorizationKey}_status` });
  assert.equal(status.state, "authorized");
  assert.equal(status.amount_minor, amountMinor);
  assert.equal(status.currency, currency);

  const replay = await provider.authorize(input);
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error(replay.error);
  assert.equal(replay.provider_reference, authorizationId, "same Stripe idempotency key must return the same PaymentIntent");

  const mismatch = await provider.authorize({ ...input, amount_minor: amountMinor + 100 });
  assert.equal(mismatch.ok, false, "changed payload with the same idempotency key must be rejected");

  const declineKey = `siton_sb_decline_${runId}`;
  const declined = await provider.authorize({ ...input, payment_method_id: "pm_card_visa_chargeDeclined", correlation_id: declineKey, request_id: declineKey });
  assert.equal(declined.ok, false, "official Stripe decline PaymentMethod must be declined");
  if (!declined.ok) {
    assert.notEqual(declined.statusCode, 500);
    assert.equal(declined.retryable, false);
  }

  const release = await provider.release({ authorization_id: authorizationId, amount_minor: amountMinor, currency, correlation_id: releaseKey });
  assert.equal(release.result_class, "success");
  released = true;
  const releaseReplay = await provider.release({ authorization_id: authorizationId, amount_minor: amountMinor, currency, correlation_id: releaseKey });
  assert.equal(releaseReplay.result_class, "success");
  assert.equal(releaseReplay.provider_reference, authorizationId);

  const releasedStatus = await provider.status({ provider_reference: authorizationId, operation: "release", correlation_id: `${releaseKey}_status` });
  assert.equal(releasedStatus.state, "released");
  assert.equal(releasedStatus.amount_minor, amountMinor);
  assert.equal(releasedStatus.currency, currency);

  const report = {
    external_verification: "executed",
    stripe_mode: "test",
    authorization: "authorized_then_released",
    capture_executed: false,
    refund_executed: false,
    idempotent_replay: "pass",
    payload_mismatch: "blocked",
    decline: "normalized",
    status_after_release: "released",
    provider_reference_sha256_prefix: filteredReference(authorizationId)
  };
  const reportPath = String(process.env.STRIPE_SANDBOX_REPORT_PATH || "");
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  console.log(JSON.stringify(report));
} finally {
  if (authorizationId && !released) {
    const cleanup = await provider.release!({ authorization_id: authorizationId, amount_minor: amountMinor, currency, correlation_id: `${releaseKey}_cleanup` });
    if (cleanup.result_class !== "success") throw new Error("Stripe Sandbox cleanup could not release the active authorization");
  }
}