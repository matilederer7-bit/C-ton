/**
 * Webhook HMAC signature + replay protection tests.
 * Uses registerFrontendExperience directly with a non-demo mode so
 * PAYMENT_WEBHOOK_SECRET_IS_SAFE is true and verification is enforced.
 */
import { strict as assert } from "node:assert";
import Fastify from "fastify";
import { createHmac } from "node:crypto";

const TEST_WEBHOOK_SECRET = "test-webhook-secret-not-default";

// Must be set before importing frontend_runtime + runtime_config (read at module init)
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.PAYMENT_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
process.env.SELLER_SESSION_SECRET = "test-session-secret";
process.env.SELLER_AUTH_CREDENTIALS = '[{"seller_id":"test","display_name":"Test","access_code":"code"}]';

const { registerFrontendExperience } = await import("../src/frontend_runtime.js");

function fakeWithTx() {
  return async <T>(_fn: (c: any) => Promise<T>): Promise<T> => {
    throw Object.assign(new Error("db not available in hmac tests"), { statusCode: 503 });
  };
}

function fakePaymentProvider() {
  return {
    providerCode: "mockpay",
    mode: "mock-backed" as const,
    webhookProvider: "mockpay",
    configured: true,
    async authorize() {
      return {
        ok: true as const,
        provider: "mockpay",
        authorization_id: "auth_test",
        provider_reference: "ref_test",
        correlation_id: "corr_test",
        authorization: "authorized" as const,
        hold_message: "test",
        mock: true
      };
    },
    async capture() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    },
    async recover() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    },
    async refund() {
      return { provider: "mockpay", result_class: "success" as const, retryable: false, mock: true };
    }
  };
}

function buildWebhookApp() {
  const app = Fastify();
  registerFrontendExperience(app, {
    withTx: fakeWithTx(),
    paymentProvider: fakePaymentProvider(),
    deploymentMode: "internal-runtime",
    isDemoPreview: false,
    notificationSummary: { provider: "log-only", mode: "log-only", external_delivery: false },
    debugSurfacesEnabled: false
  });
  return app;
}

function signPayload(body: string, timestamp: string, secret: string) {
  const signingInput = `${timestamp}.${body}`;
  return "sha256=" + createHmac("sha256", secret).update(signingInput).digest("hex");
}

function nowSeconds() {
  return String(Math.floor(Date.now() / 1000));
}

const VALID_PAYLOAD = JSON.stringify({
  provider: "mockpay",
  event_id: "evt_test_001",
  event_type: "payment.authorized",
  payload: {}
});

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const app = buildWebhookApp();

await run("webhook with valid HMAC signature is accepted (proceeds past auth)", async () => {
  const ts = nowSeconds();
  const sig = signPayload(VALID_PAYLOAD, ts, TEST_WEBHOOK_SECRET);

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    payload: VALID_PAYLOAD,
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": sig,
      "x-webhook-timestamp": ts
    }
  });
  // Auth passed — DB unavailable so we expect 503, but NOT 401
  assert.notEqual(res.statusCode, 401, "valid signature must not return 401");
});

await run("webhook with missing signature header returns 401", async () => {
  const ts = nowSeconds();
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    payload: VALID_PAYLOAD,
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": ts
    }
  });
  assert.equal(res.statusCode, 401);
  const body = res.json() as any;
  assert.equal(body.error, "invalid_webhook_signature");
});

await run("webhook with wrong signature returns 401", async () => {
  const ts = nowSeconds();
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    payload: VALID_PAYLOAD,
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": "sha256=deadbeef00000000000000000000000000000000000000000000000000000000",
      "x-webhook-timestamp": ts
    }
  });
  assert.equal(res.statusCode, 401);
});

await run("webhook with signature for different secret returns 401", async () => {
  const ts = nowSeconds();
  const wrongSig = signPayload(VALID_PAYLOAD, ts, "different-secret-value");

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    payload: VALID_PAYLOAD,
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": wrongSig,
      "x-webhook-timestamp": ts
    }
  });
  assert.equal(res.statusCode, 401);
});

await run("webhook with stale timestamp (6 minutes old) returns 401 (replay protection)", async () => {
  const staleTs = String(Math.floor(Date.now() / 1000) - 6 * 60); // 6 minutes ago
  const sig = signPayload(VALID_PAYLOAD, staleTs, TEST_WEBHOOK_SECRET);

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    payload: VALID_PAYLOAD,
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": sig,
      "x-webhook-timestamp": staleTs
    }
  });
  assert.equal(res.statusCode, 401, "stale timestamp must be rejected");
});

await run("webhook with future timestamp (6 minutes ahead) returns 401 (replay protection)", async () => {
  const futureTs = String(Math.floor(Date.now() / 1000) + 6 * 60); // 6 minutes in future
  const sig = signPayload(VALID_PAYLOAD, futureTs, TEST_WEBHOOK_SECRET);

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    payload: VALID_PAYLOAD,
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": sig,
      "x-webhook-timestamp": futureTs
    }
  });
  assert.equal(res.statusCode, 401, "far-future timestamp must be rejected");
});

await run("webhook within the 5-minute window is accepted", async () => {
  // 4.5 minutes ago — still within window
  const recentTs = String(Math.floor(Date.now() / 1000) - 4 * 60 - 30);
  const sig = signPayload(VALID_PAYLOAD, recentTs, TEST_WEBHOOK_SECRET);

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments",
    payload: VALID_PAYLOAD,
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": sig,
      "x-webhook-timestamp": recentTs
    }
  });
  assert.notEqual(res.statusCode, 401, "recent timestamp within window must not return 401");
});

await run("webhook mock endpoint also validates signature in non-demo mode", async () => {
  const ts = nowSeconds();
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    payload: VALID_PAYLOAD,
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": ts
      // No signature
    }
  });
  assert.equal(res.statusCode, 401);
});

await app.close();
process.exit(0);
