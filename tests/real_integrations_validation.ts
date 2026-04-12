import assert from "node:assert/strict";
import { app } from "../src/app.js";

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
      deadline: new Date(Date.now() + 30 * 60_000).toISOString()
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

async function buildChargingParticipant(suffix: string, buyerId: string) {
  const created = await createDeal(`Charging Deal ${suffix}`, suffix);

  const publish = await post(`/deals/${created.deal_id}/publish`, `publish-${suffix}`);
  assert.equal(publish.statusCode, 200);

  const join = await post(`/deals/${created.deal_id}/join`, `join-${suffix}`, {
    buyer_id: buyerId,
    qty: 10
  });
  assert.equal(join.statusCode, 200);
  const joinJson = join.json() as any;

  const closeJoining = await post(`/deals/${created.deal_id}/close_joining`, `close-${suffix}`);
  assert.equal(closeJoining.statusCode, 200);

  const prepare = await post(`/deals/${created.deal_id}/prepare_charging`, `prepare-${suffix}`);
  assert.equal(prepare.statusCode, 200);

  const start = await post(`/deals/${created.deal_id}/charging/start`, `start-${suffix}`);
  assert.equal(start.statusCode, 200);

  return {
    deal_id: created.deal_id,
    participant_id: joinJson.participant_id as string
  };
}

async function pushWebhook(eventType: string, dealId: string, participantId: string, providerReference: string) {
  return app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: {
      "x-webhook-secret": "mock-webhook-secret"
    },
    payload: {
      event_id: `${eventType}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      event_type: eventType,
      deal_id: dealId,
      participant_id: participantId,
      payload: {
        participant_id: participantId,
        deal_id: dealId,
        provider_reference: providerReference
      }
    }
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

    const first = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      headers: {
        "x-webhook-secret": "mock-webhook-secret"
      },
      payload: {
        event_id: eventId,
        event_type: "payment_authorized",
        deal_id: created.deal_id,
        payload: {
          provider_reference: "auth_123"
        }
      }
    });

    assert.equal(first.statusCode, 202);
    const firstJson = first.json() as any;
    assert.equal(firstJson.ok, true);
    assert.equal(firstJson.duplicate, false);
    assert.equal(firstJson.status, "processed");

    const duplicate = await app.inject({
      method: "POST",
      url: "/webhooks/payments/mock",
      headers: {
        "x-webhook-secret": "mock-webhook-secret"
      },
      payload: {
        event_id: eventId,
        event_type: "payment_authorized",
        deal_id: created.deal_id,
        payload: {
          provider_reference: "auth_123"
        }
      }
    });

    assert.equal(duplicate.statusCode, 200);
    const duplicateJson = duplicate.json() as any;
    assert.equal(duplicateJson.ok, true);
    assert.equal(duplicateJson.duplicate, true);
  });

  await runTest("webhook reconciliation can move a charging participant into charged success", async () => {
    const charging = await buildChargingParticipant("charge-success", "buyer-charge-success");
    const webhook = await pushWebhook("charge_captured", charging.deal_id, charging.participant_id, "cap_123");

    assert.equal(webhook.statusCode, 202);
    const webhookJson = webhook.json() as any;
    assert.equal(webhookJson.reconciliation.status, "processed");

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

    assert.equal(webhook.statusCode, 202);
    const webhookJson = webhook.json() as any;
    assert.equal(webhookJson.reconciliation.status, "processed");

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
    assert.equal(failed.statusCode, 202);

    const recovered = await pushWebhook("recovery_captured", charging.deal_id, charging.participant_id, "recovery_cap_123");
    assert.equal(recovered.statusCode, 202);
    const recoveredJson = recovered.json() as any;
    assert.equal(recoveredJson.reconciliation.status, "processed");

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
    assert.equal(failed.statusCode, 202);

    const dropped = await pushWebhook("recovery_failed", charging.deal_id, charging.participant_id, "recovery_fail_123");
    assert.equal(dropped.statusCode, 202);
    const droppedJson = dropped.json() as any;
    assert.equal(droppedJson.reconciliation.status, "processed");

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
    const created = await createDeal("Webhook Ignore Deal", "webhook-ignore");
    const webhook = await app.inject({
      method: "POST",
      url: "/webhooks/payments/mock",
      headers: {
        "x-webhook-secret": "mock-webhook-secret"
      },
      payload: {
        event_id: `evt-unknown-${Date.now()}`,
        event_type: "provider_ping",
        deal_id: created.deal_id,
        payload: {
          provider_reference: "noop_123"
        }
      }
    });

    assert.equal(webhook.statusCode, 202);
    const webhookJson = webhook.json() as any;
    assert.equal(webhookJson.status, "ignored");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
