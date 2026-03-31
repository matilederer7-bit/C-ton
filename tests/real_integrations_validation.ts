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
  });

  await runTest("payment authorization contract returns provider metadata", async () => {
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
    assert.equal(payload.provider, "mockpay");
    assert.equal(payload.authorization, "authorized");
    assert.equal(payload.mock, true);
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
