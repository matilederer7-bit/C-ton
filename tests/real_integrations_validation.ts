import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { app } from "../src/app.js";

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

async function createDeal(title: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `integration-test-create-${unique}`,
      "idempotency-key": `integration-test-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 42,
      min_units: 10,
      max_units: 20,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString()
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

async function buildChargingParticipant(suffix: string, buyerId: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const created = await createDeal(`Charging Deal ${suffix}`, unique);

  const publish = await post(`/deals/${created.deal_id}/publish`, `publish-${unique}`, {
    seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true
  });
  assert.equal(publish.statusCode, 200);

  const otp = await verifiedOtpForBuyer(buyerId, created.deal_id, suffix);
  const join = await post(`/deals/${created.deal_id}/join`, `join-${unique}`, {
    buyer_id: buyerId,
    qty: 10,
    buyer_terms_accepted: true,
    payment_disclosure_accepted: true,
    otp_token: otp.otp_token,
    otp_challenge_id: otp.challenge_id || otp.otp_session_id,
    authorization_id: `auth-${suffix}`,
    authorization_provider: "mockpay"
  });
  assert.equal(join.statusCode, 200);
  const joinJson = join.json() as any;

  const closeJoining = await post(`/deals/${created.deal_id}/close_joining`, `close-${unique}`);
  assert.equal(closeJoining.statusCode, 200);

  const prepare = await post(`/deals/${created.deal_id}/prepare_charging`, `prepare-${unique}`);
  assert.equal(prepare.statusCode, 200);

  const start = await post(`/deals/${created.deal_id}/charging/start`, `start-${unique}`);
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
  await runTest("integration health exposes payment, notification, and webhook readiness", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/integrations"
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.integrations.payment.provider, "mockpay");
    assert.equal(payload.integrations.notifications.provider, "log-only");
    assert.equal(payload.integrations.webhook_ingestion.provider, "mockpay");
    assert.equal(payload.integrations.webhook_ingestion.canonical_route, "/webhooks/payments");
    assert.equal(payload.operational_readiness.payment_provider.state, "mock");
    assert.equal(payload.operational_readiness.sms.state, "not-connected");
    assert.match(payload.operational_readiness.seller_identity.context_leakage_risk, /high/i);
  });

  await runTest("payment authorization contract returns provider metadata on the canonical route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/payments/authorize",
      payload: {
        holder_name: "Integration Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123"
      }
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.provider, "mockpay");
    assert.equal(payload.authorization, "authorized");
    assert.equal(payload.mock, true);
  });

  await runTest("legacy payment authorization route remains available as a compatibility alias", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Integration Buyer",
        card_number: "4111111111111111",
        expiry: "12/28",
        cvv: "123"
      }
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.ok, true);
  });

  await runTest("payment authorization failure stays mapped through provider boundary", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: {
        holder_name: "Declined Buyer",
        card_number: "4111111111110000",
        expiry: "12/28",
        cvv: "123"
      }
    });

    assert.equal(response.statusCode, 402);
    const payload = response.json() as any;
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "authorization_failed");
    assert.equal(payload.provider, "mockpay");
  });

  await runTest("webhook ingestion accepts first delivery and idempotently accepts duplicates", async () => {
    const created = await createDeal("Webhook Readiness Deal", "webhook");
    const eventId = `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const firstPayload = {
      event_id: eventId,
      event_type: "payment_authorized",
      deal_id: created.deal_id,
      payload: {
        provider_reference: "auth_123"
      }
    };

    const first = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      headers: paymentWebhookHeaders(firstPayload),
      payload: firstPayload
    });

    assert.equal(first.statusCode, 200);
    const firstJson = first.json() as any;
    assert.equal(firstJson.ok, true);
    assert.equal(firstJson.duplicate, false);
    assert.equal(firstJson.status, "processed");

    const duplicatePayload = {
      event_id: eventId,
      event_type: "payment_authorized",
      deal_id: created.deal_id,
      payload: {
        provider_reference: "auth_123"
      }
    };
    const duplicate = await app.inject({
      method: "POST",
      url: "/webhooks/payments/mock",
      headers: paymentWebhookHeaders(duplicatePayload),
      payload: duplicatePayload
    });

    assert.equal(duplicate.statusCode, 200);
    const duplicateJson = duplicate.json() as any;
    assert.equal(duplicateJson.ok, true);
    assert.equal(duplicateJson.duplicate, true);
  });

  await runTest("webhook reconciliation can move a charging participant into charged success", async () => {
    const charging = await buildChargingParticipant("charge-success", "buyer-charge-success");
    const webhook = await pushWebhook("charge_captured", charging.deal_id, charging.participant_id, "cap_123");

    assert.equal(webhook.statusCode, 200);
    const webhookJson = webhook.json() as any;
    assert.equal(webhookJson.status, "processed");

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${charging.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingJson = tracking.json() as any;
    assert.equal(trackingJson.tracking.buyer_state, "ChargedSuccess");
    assert.equal(trackingJson.tracking.money_state, "ChargedSuccess");
  });

  await runTest("webhook reconciliation can move a charging participant into recovery-needed state", async () => {
    const charging = await buildChargingParticipant("charge-fail", "buyer-charge-fail");
    const webhook = await pushWebhook("charge_failed", charging.deal_id, charging.participant_id, "cap_fail_123");

    assert.equal(webhook.statusCode, 200);
    const webhookJson = webhook.json() as any;
    assert.equal(webhookJson.status, "processed");

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${charging.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingJson = tracking.json() as any;
    assert.equal(trackingJson.tracking.buyer_state, "ChargeFailedCompletion");
    assert.equal(trackingJson.tracking.money_state, "ChargeFailedRecovery");
  });

  await runTest("webhook reconciliation can recover a failed participant back into success", async () => {
    const charging = await buildChargingParticipant("recovery-success", "buyer-recovery-success");
    const failed = await pushWebhook("charge_failed", charging.deal_id, charging.participant_id, "cap_fail_recovery");
    assert.equal(failed.statusCode, 200);

    const recovered = await pushWebhook("recovery_captured", charging.deal_id, charging.participant_id, "recovery_cap_123");
    assert.equal(recovered.statusCode, 200);
    const recoveredJson = recovered.json() as any;
    assert.equal(recoveredJson.status, "processed");

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${charging.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingJson = tracking.json() as any;
    assert.equal(trackingJson.tracking.buyer_state, "Recovered");
    assert.equal(trackingJson.tracking.money_state, "RecoveredCharge");
  });

  await runTest("webhook reconciliation can drop a failed participant when recovery fails", async () => {
    const charging = await buildChargingParticipant("recovery-fail", "buyer-recovery-fail");
    const failed = await pushWebhook("charge_failed", charging.deal_id, charging.participant_id, "cap_fail_drop");
    assert.equal(failed.statusCode, 200);

    const dropped = await pushWebhook("recovery_failed", charging.deal_id, charging.participant_id, "recovery_fail_123");
    assert.equal(dropped.statusCode, 200);
    const droppedJson = dropped.json() as any;
    assert.equal(droppedJson.status, "processed");

    const tracking = await app.inject({
      method: "GET",
      url: `/api/participants/${charging.participant_id}/tracking`
    });
    assert.equal(tracking.statusCode, 200);
    const trackingJson = tracking.json() as any;
    assert.equal(trackingJson.tracking.buyer_state, "Dropped");
    assert.equal(trackingJson.tracking.money_state, "AuthReleased");
  });

  await runTest("unknown webhook events are stored and safely ignored", async () => {
    const charging = await buildChargingParticipant("webhook-ignore", "buyer-webhook-ignore");
    const payload = {
      event_id: `evt-unknown-${Date.now()}`,
      event_type: "provider_ping",
      deal_id: charging.deal_id,
      participant_id: charging.participant_id,
      payload: {
        participant_id: charging.participant_id,
        deal_id: charging.deal_id,
        provider_reference: "noop_123"
      }
    };
    const webhook = await app.inject({
      method: "POST",
      url: "/webhooks/payments/mock",
      headers: paymentWebhookHeaders(payload),
      payload
    });

    assert.equal(webhook.statusCode, 200);
    const webhookJson = webhook.json() as any;
    assert.equal(webhookJson.status, "ignored");
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

