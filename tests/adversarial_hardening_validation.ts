import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const frontendSource = join(repoRoot, "frontend");
const frontendTarget = join(repoRoot, ".tmp_test_dist", "frontend");

function paymentWebhookHeaders(payload: Record<string, unknown>, secret = "mock-webhook-secret") {
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(payload);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return {
    "x-webhook-signature": `sha256=${digest}`,
    "x-webhook-timestamp": String(timestamp)
  };
}

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function ensureFrontendAssets() {
  await mkdir(frontendTarget, { recursive: true });
  await cp(frontendSource, frontendTarget, { recursive: true, force: true });
}

async function createDeal(title: string, suffix: string, overrides: Record<string, unknown> = {}) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `adversarial-create-${unique}`,
      "idempotency-key": `adversarial-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 42,
      min_units: 10,
      max_units: 20,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      ...overrides
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function post(url: string, requestId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "x-request-id": requestId,
      "idempotency-key": requestId
    },
    payload
  });
}

async function verifiedOtpForBuyer(buyerId: string, dealId: string, suffix: string) {
  const phoneDigits = String(
    Math.abs(Array.from(`${buyerId}-${dealId}-${suffix}`).reduce((sum, ch) => sum + ch.charCodeAt(0), 0))
  )
    .padStart(7, "0")
    .slice(-7);
  const request = await app.inject({
    method: "POST",
    url: "/api/otp/start",
    payload: { phone: `050${phoneDigits}`, deal_id: dealId }
  });
  assert.equal(request.statusCode, 200, `otp start failed for ${suffix}: ${request.body}`);
  const requested = request.json() as any;
  const verify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: {
      otp_session_id: requested.otp_session_id,
      code: requested.development_code
    }
  });
  assert.equal(verify.statusCode, 200, `otp verify failed for ${suffix}`);
  return verify.json() as any;
}

async function main() {
  await ensureFrontendAssets();

  await runTest("api hardening rejects invalid create payloads without crashing", async () => {
    const invalidDate = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Bad Date",
        price_per_unit: 42,
        min_units: 5,
        max_units: 10,
        deadline: "not-a-date"
      }
    });
    assert.equal(invalidDate.statusCode, 400);
    assert.equal((invalidDate.json() as any).error, "deadline must be a valid ISO date");

    const invalidPrice = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Bad Price",
        price_per_unit: "oops",
        min_units: 5,
        max_units: 10
      }
    });
    assert.equal(invalidPrice.statusCode, 400);

    const invalidTitle = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "",
        price_per_unit: 42,
        min_units: 10,
        max_units: 20
      }
    });
    assert.equal(invalidTitle.statusCode, 400);
  });

  await runTest("uuid and identifier abuse is rejected cleanly", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/deals/not-a-uuid/public" })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/participants/not-a-uuid/tracking" })).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/deals/not-a-uuid/join",
          payload: { buyer_id: "buyer", qty: 1 }
        })
      ).statusCode,
      400
    );
  });

  await runTest("otp abuse paths stay controlled", async () => {
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/otp/start", payload: { phone: "abc" } })).statusCode,
      400
    );

    const missingSessionId = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: { code: "123456" }
    });
    assert.equal(missingSessionId.statusCode, 400);
  });

  await runTest("sequence abuse does not create false success", async () => {
    const draft = await createDeal("Draft Abuse Deal", "draft-abuse");

    const draftJoin = await post(`/deals/${draft.deal_id}/join`, `adversarial-draft-join-${Date.now()}`, {
      buyer_id: "buyer-draft",
      qty: 1
    });
    assert.ok([400, 409].includes(draftJoin.statusCode), `expected controlled draft rejection, got ${draftJoin.statusCode}`);

    assert.equal(
      (await post(`/deals/${draft.deal_id}/prepare_charging`, `adversarial-prepare-${Date.now()}`)).statusCode,
      409
    );

    assert.equal(
      (await post(`/deals/${draft.deal_id}/charging/start`, `adversarial-start-${Date.now()}`)).statusCode,
      409
    );
  });

  await runTest("idempotency abuse stays deterministic under duplicate and conflicting payloads", async () => {
    const created = await createDeal("Idempotency Deal", "idem");
    const sameKey = `adversarial-publish-${Date.now()}`;

    assert.equal((await post(`/deals/${created.deal_id}/publish`, sameKey, { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true })).statusCode, 200);
    assert.equal((await post(`/deals/${created.deal_id}/publish`, sameKey, { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true })).statusCode, 200);

    const firstJoinKey = `adversarial-join-${Date.now()}`;
    const otp = await verifiedOtpForBuyer("buyer-idem", created.deal_id, "idem");
    const firstJoin = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/join`,
      headers: { "x-request-id": firstJoinKey, "idempotency-key": firstJoinKey },
      payload: {
        buyer_id: "buyer-idem",
        qty: 1,
        buyer_terms_accepted: true,
        payment_disclosure_accepted: true,
        otp_token: otp.otp_token,
        otp_challenge_id: otp.challenge_id || otp.otp_session_id,
        authorization_id: "auth-idem",
        authorization_provider: "mockpay"
      }
    });
    if (firstJoin.statusCode !== 200) {
      assert.equal(firstJoin.statusCode, 409, `expected first join success or clean precondition block, got ${firstJoin.statusCode}`);
      assert.doesNotMatch(firstJoin.body, /stack|at .*\.ts:/i);
      return;
    }

    const duplicateJoin = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/join`,
      headers: { "x-request-id": firstJoinKey, "idempotency-key": firstJoinKey },
      payload: {
        buyer_id: "buyer-idem",
        qty: 2,
        buyer_terms_accepted: true,
        payment_disclosure_accepted: true,
        otp_token: otp.otp_token,
        otp_challenge_id: otp.challenge_id || otp.otp_session_id,
        authorization_id: "auth-idem",
        authorization_provider: "mockpay"
      }
    });
    assert.ok([200, 409].includes(duplicateJoin.statusCode), `expected replay or clear conflict, got ${duplicateJoin.statusCode}`);
    if (duplicateJoin.statusCode === 200) {
      assert.equal((duplicateJoin.json() as any).participant_id, (firstJoin.json() as any).participant_id);
    } else {
      assert.doesNotMatch(duplicateJoin.body, /stack|at .*\.ts:/i);
    }
  });

  await runTest("webhook abuse remains controlled under malformed, unknown, and duplicate inputs", async () => {
    const malformedPayload = {
      event_id: { bad: true },
      event_type: "charge_captured",
      payload: []
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/payments/mock",
          headers: paymentWebhookHeaders(malformedPayload),
          payload: malformedPayload
        })
      ).statusCode,
      400
    );

    const unknownPayload = {
      event_id: `adversarial-unknown-${Date.now()}`,
      event_type: "provider_ping",
      payload: {}
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/payments/mock",
          headers: paymentWebhookHeaders(unknownPayload),
          payload: unknownPayload
        })
      ).statusCode,
      200
    );

    const created = await createDeal("Webhook Duplicate Deal", "webhook-dup");
    const eventId = `dup-${Date.now()}`;
    const duplicatePayload = {
      event_id: eventId,
      event_type: "payment_authorized",
      deal_id: created.deal_id,
      payload: {}
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/payments/mock",
          headers: paymentWebhookHeaders(duplicatePayload),
          payload: duplicatePayload
        })
      ).statusCode,
      200
    );

    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/payments/mock",
          headers: paymentWebhookHeaders(duplicatePayload),
          payload: duplicatePayload
        })
      ).statusCode,
      200
    );
  });

  await runTest("frontend shell routes remain safe under direct navigation misuse", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/app/join/not-a-uuid/otp" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/app/join/not-a-uuid/payment" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/app/join/not-a-uuid/confirmation" })).statusCode, 200);
  });
}

main()
  .then(async () => {
    await app.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await app.close().catch(() => undefined);
    process.exit(1);
  });

