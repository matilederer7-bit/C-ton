import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = "3496";

const { app } = await import("../src/app.js");

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
      "x-request-id": `full-system-create-${unique}`,
      "idempotency-key": `full-system-create-${unique}`
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

async function publishDeal(dealId: string, suffix: string) {
  const response = await post(`/deals/${dealId}/publish`, `full-system-publish-${suffix}`, {
    seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true
  });
  assert.equal(response.statusCode, 200);
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

async function buildChargingParticipant(suffix: string, buyerId: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const created = await createDeal(`Full System Charging ${suffix}`, unique);
  await publishDeal(created.deal_id, unique);

  const otp = await verifiedOtpForBuyer(buyerId, created.deal_id, suffix);
  const join = await post(`/deals/${created.deal_id}/join`, `full-system-join-${unique}`, {
    buyer_id: buyerId,
    qty: 10,
    buyer_terms_accepted: true,
    payment_disclosure_accepted: true,
    otp_token: otp.otp_token,
    otp_challenge_id: otp.challenge_id || otp.otp_session_id,
    authorization_id: `auth-${unique}`,
    authorization_provider: "mockpay"
  });
  assert.equal(join.statusCode, 200);
  const joinJson = join.json() as any;

  const closeJoining = await post(`/deals/${created.deal_id}/close_joining`, `full-system-close-${unique}`);
  assert.equal(closeJoining.statusCode, 200);

  const prepare = await post(`/deals/${created.deal_id}/prepare_charging`, `full-system-prepare-${unique}`);
  assert.equal(prepare.statusCode, 200);

  const start = await post(`/deals/${created.deal_id}/charging/start`, `full-system-start-${unique}`);
  assert.equal(start.statusCode, 200);

  return {
    deal_id: created.deal_id,
    participant_id: joinJson.participant_id as string
  };
}

async function pushWebhook(eventType: string, dealId: string, participantId: string, providerReference: string) {
  const payload = {
    event_id: `${eventType}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    event_type: eventType,
    deal_id: dealId,
    participant_id: participantId,
    payload: {
      participant_id: participantId,
      deal_id: dealId,
      provider_reference: providerReference
    }
  };
  return app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: paymentWebhookHeaders(payload),
    payload
  });
}

async function main() {
  await ensureFrontendAssets();

  await runTest("full system happy path stays coherent from public deal to tracking", async () => {
    const created = await createDeal("Full System Journey Deal", "journey");
    await publishDeal(created.deal_id, "journey");

    const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${created.deal_id}/public` });
    assert.equal(publicDeal.statusCode, 200);
    const publicJson = publicDeal.json() as any;
    assert.equal(publicJson.ok, true);
    assert.equal(publicJson.deal.state, "PendingTarget");
    assert.equal(publicJson.availability.canJoin, true);

    const dealShell = await app.inject({ method: "GET", url: `/app/deal/${created.deal_id}` });
    assert.equal(dealShell.statusCode, 200);

    const otpStart = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: `050${String(Date.now()).slice(-7)}` }
    });
    assert.equal(otpStart.statusCode, 200);
    const otpStartJson = otpStart.json() as any;
    assert.equal(otpStartJson.ok, true);
    assert.ok(otpStartJson.otp_session_id);

    const otpVerify = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: otpStartJson.otp_session_id,
        code: otpStartJson.development_code
      }
    });
    assert.equal(otpVerify.statusCode, 200);
    const otpVerifyJson = otpVerify.json() as any;
    assert.equal(otpVerifyJson.ok, true);
    assert.equal(otpVerifyJson.verified, true);

    const payment = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "QA Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123"
      }
    });
    assert.equal(payment.statusCode, 200);
    const paymentJson = payment.json() as any;
    assert.equal(paymentJson.ok, true);
    assert.equal(paymentJson.authorization, "authorized");

    const join = await post(`/deals/${created.deal_id}/join`, `full-system-join-journey-${Date.now()}`, {
      buyer_id: otpVerifyJson.buyer_id,
      qty: 3,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otpVerifyJson.otp_token,
      otp_challenge_id: otpVerifyJson.challenge_id || otpVerifyJson.otp_session_id,
      authorization_id: paymentJson.authorization_id || "auth-full-system-journey",
      authorization_provider: paymentJson.provider || "mockpay"
    });
    assert.equal(join.statusCode, 200);
    const joinJson = join.json() as any;
    assert.ok(joinJson.participant_id);

    const confirmationShell = await app.inject({
      method: "GET",
      url: `/app/join/${created.deal_id}/confirmation`
    });
    assert.equal(confirmationShell.statusCode, 200);

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${joinJson.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingJson = tracking.json() as any;
    assert.equal(trackingJson.ok, true);
    assert.equal(trackingJson.tracking.deal_state, "PendingTarget");
    assert.equal(trackingJson.tracking.buyer_state, "JoinedAuthorized");
    assert.equal(trackingJson.tracking.money_state, "AuthHeld");
    assert.equal(typeof trackingJson.tracking.headline, "string");
    assert.equal(typeof trackingJson.tracking.subline, "string");
    assert.equal(trackingJson.tracking.tone, "info");

    const trackingShell = await app.inject({
      method: "GET",
      url: `/app/track/${joinJson.participant_id}`
    });
    assert.equal(trackingShell.statusCode, 200);
  });

  await runTest("capacity and availability stay aligned between backend and buyer-facing surface", async () => {
    const created = await createDeal("Full System Capacity Deal", "capacity", {
      min_units: 1,
      max_units: 3
    });
    await publishDeal(created.deal_id, "capacity");

    const firstOtp = await verifiedOtpForBuyer("buyer-capacity-a", created.deal_id, "capacity-first");
    const firstJoin = await post(`/deals/${created.deal_id}/join`, `full-system-capacity-first-${Date.now()}`, {
      buyer_id: "buyer-capacity-a",
      qty: 3,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: firstOtp.otp_token,
      otp_challenge_id: firstOtp.challenge_id || firstOtp.otp_session_id,
      authorization_id: "auth-capacity-first",
      authorization_provider: "mockpay"
    });
    assert.equal(firstJoin.statusCode, 200);

    const publicDeal = await app.inject({ method: "GET", url: `/api/deals/${created.deal_id}/public` });
    assert.equal(publicDeal.statusCode, 200);
    const publicJson = publicDeal.json() as any;
    assert.equal(publicJson.availability.canJoin, false);
    assert.equal(publicJson.availability.reasonCode, "stock_exhausted");

    const rejectedOtp = await verifiedOtpForBuyer("buyer-capacity-b", created.deal_id, "capacity-second");
    const rejectedJoin = await post(`/deals/${created.deal_id}/join`, `full-system-capacity-second-${Date.now()}`, {
      buyer_id: "buyer-capacity-b",
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: rejectedOtp.otp_token,
      otp_challenge_id: rejectedOtp.challenge_id || rejectedOtp.otp_session_id,
      authorization_id: "auth-capacity-second",
      authorization_provider: "mockpay"
    });
    assert.equal(rejectedJoin.statusCode, 409);
  });

  await runTest("cancelled and unknown deals surface coherently to the system", async () => {
    const created = await createDeal("Full System Cancelled Deal", "cancelled");
    const cancel = await post(`/deals/${created.deal_id}/cancel`, `full-system-cancel-${Date.now()}`);
    assert.equal(cancel.statusCode, 200);

    const publicCancelled = await app.inject({ method: "GET", url: `/api/deals/${created.deal_id}/public` });
    assert.equal(publicCancelled.statusCode, 200);
    const cancelledJson = publicCancelled.json() as any;
    assert.equal(cancelledJson.deal.state, "Cancelled");
    assert.equal(cancelledJson.availability.canJoin, false);
    assert.equal(cancelledJson.availability.reasonCode, "cancelled");

    const dealShell = await app.inject({ method: "GET", url: `/app/deal/${created.deal_id}` });
    assert.equal(dealShell.statusCode, 200);

    const unknown = await app.inject({
      method: "GET",
      url: "/api/deals/00000000-0000-0000-0000-000000000000/public"
    });
    assert.equal(unknown.statusCode, 404);
  });

  await runTest("error, recovery, and session contracts stay understandable across layers", async () => {
    const otpStart = await app.inject({
      method: "POST",
      url: "/api/otp/start",
      payload: { phone: `050${String(Date.now()).slice(-7)}` }
    });
    assert.equal(otpStart.statusCode, 200);
    const otpSession = otpStart.json() as any;

    const invalidOtp = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: otpSession.otp_session_id,
        code: "000000"
      }
    });
    assert.equal(invalidOtp.statusCode, 400);

    const missingOtp = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: {
        otp_session_id: "00000000-0000-0000-0000-000000000000",
        code: "123456"
      }
    });
    assert.equal(missingOtp.statusCode, 400);

    const paymentFailure = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Declined QA Buyer",
        card_number: "4111111111110000",
        expiry: "12/28",
        cvv: "123"
      }
    });
    assert.equal(paymentFailure.statusCode, 402);
    const paymentFailureJson = paymentFailure.json() as any;
    assert.equal(paymentFailureJson.error, "authorization_failed");

    const unknownTracking = await app.inject({
      method: "GET",
      url: "/api/participants/00000000-0000-0000-0000-000000000000/tracking"
    });
    assert.equal(unknownTracking.statusCode, 404);
  });

  await runTest("charged, recovered, and dropped tracking states remain coherent for the whole product", async () => {
    const charged = await buildChargingParticipant("charged", "buyer-full-system-charged");
    const chargedWebhook = await pushWebhook("charge_captured", charged.deal_id, charged.participant_id, "cap_full_123");
    assert.equal(chargedWebhook.statusCode, 200);
    const chargedTracking = await app.inject({
      method: "GET",
      url: `/api/participants/${charged.participant_id}/tracking`
    });
    assert.equal(chargedTracking.statusCode, 200);
    const chargedJson = chargedTracking.json() as any;
    assert.equal(chargedJson.tracking.buyer_state, "ChargedSuccess");
    assert.equal(chargedJson.tracking.money_state, "ChargedSuccess");
    assert.equal(chargedJson.tracking.tone, "success");

    const recovered = await buildChargingParticipant("recovered", "buyer-full-system-recovered");
    await pushWebhook("charge_failed", recovered.deal_id, recovered.participant_id, "cap_recovery_fail");
    const recoveredWebhook = await pushWebhook("recovery_captured", recovered.deal_id, recovered.participant_id, "recovery_full_123");
    assert.equal(recoveredWebhook.statusCode, 200);
    const recoveredTracking = await app.inject({
      method: "GET",
      url: `/api/participants/${recovered.participant_id}/tracking`
    });
    assert.equal(recoveredTracking.statusCode, 200);
    const recoveredJson = recoveredTracking.json() as any;
    assert.equal(recoveredJson.tracking.buyer_state, "Recovered");
    assert.equal(recoveredJson.tracking.money_state, "RecoveredCharge");
    assert.equal(recoveredJson.tracking.tone, "success");

    const dropped = await buildChargingParticipant("dropped", "buyer-full-system-dropped");
    await pushWebhook("charge_failed", dropped.deal_id, dropped.participant_id, "cap_drop_fail");
    const droppedWebhook = await pushWebhook("recovery_failed", dropped.deal_id, dropped.participant_id, "recovery_drop_123");
    assert.equal(droppedWebhook.statusCode, 200);
    const droppedTracking = await app.inject({
      method: "GET",
      url: `/api/participants/${dropped.participant_id}/tracking`
    });
    assert.equal(droppedTracking.statusCode, 200);
    const droppedJson = droppedTracking.json() as any;
    assert.equal(droppedJson.tracking.buyer_state, "Dropped");
    assert.equal(droppedJson.tracking.money_state, "AuthReleased");
    assert.equal(droppedJson.tracking.tone, "info");
  });

  await runTest("health, integration health, and webhook auth remain operationally clear", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    const healthJson = health.json() as any;
    assert.equal(healthJson.ok, true);

    const integrations = await app.inject({ method: "GET", url: "/health/integrations" });
    assert.equal(integrations.statusCode, 200);
    const integrationsJson = integrations.json() as any;
    assert.equal(integrationsJson.ok, true);
    assert.equal(integrationsJson.integrations.payment.mode, "mock-backed");

    const unauthorizedPayload = {
      event_id: `bad-secret-${Date.now()}`,
      event_type: "charge_captured",
      payload: {}
    };
    const unauthorizedWebhook = await app.inject({
      method: "POST",
      url: "/webhooks/payments/mock",
      headers: paymentWebhookHeaders(unauthorizedPayload, "wrong-secret"),
      payload: unauthorizedPayload
    });
    assert.equal(unauthorizedWebhook.statusCode, 401);
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

