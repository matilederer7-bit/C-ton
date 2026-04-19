import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const frontendSource = join(repoRoot, "frontend");
const frontendTarget = join(repoRoot, ".tmp_test_dist", "frontend");

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

async function main() {
  await ensureFrontendAssets();

  await runTest("api hardening rejects invalid create payloads without crashing", async () => {
    const invalidDate = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Bad Date",
        min_units: 5,
        max_units: 10,
        deadline: "not-a-date"
      }
    });
    assert.equal(invalidDate.statusCode, 400);
    assert.equal((invalidDate.json() as any).error, "bad_request");

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

    const invalidMax = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Bad Max",
        min_units: 10,
        max_units: 0
      }
    });
    assert.equal(invalidMax.statusCode, 400);
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

    assert.equal(
      (
        await post(`/deals/${draft.deal_id}/join`, `adversarial-draft-join-${Date.now()}`, {
          buyer_id: "buyer-draft",
          qty: 1
        })
      ).statusCode,
      409
    );

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

    assert.equal((await post(`/deals/${created.deal_id}/publish`, sameKey)).statusCode, 200);
    assert.equal((await post(`/deals/${created.deal_id}/publish`, sameKey)).statusCode, 200);

    const firstJoinKey = `adversarial-join-${Date.now()}`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/deals/${created.deal_id}/join`,
          headers: { "x-request-id": firstJoinKey, "idempotency-key": firstJoinKey },
          payload: { buyer_id: "buyer-idem", qty: 1 }
        })
      ).statusCode,
      200
    );

    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/deals/${created.deal_id}/join`,
          headers: { "x-request-id": firstJoinKey, "idempotency-key": firstJoinKey },
          payload: { buyer_id: "buyer-idem", qty: 2 }
        })
      ).statusCode,
      400
    );
  });

  await runTest("webhook abuse remains controlled under malformed, unknown, and duplicate inputs", async () => {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/payments/mock",
          headers: { "x-webhook-secret": "mock-webhook-secret" },
          payload: {
            event_id: { bad: true },
            event_type: "charge_captured",
            payload: []
          }
        })
      ).statusCode,
      400
    );

    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/payments/mock",
          headers: { "x-webhook-secret": "mock-webhook-secret" },
          payload: {
            event_id: `adversarial-unknown-${Date.now()}`,
            event_type: "provider_ping",
            payload: {}
          }
        })
      ).statusCode,
      202
    );

    const created = await createDeal("Webhook Duplicate Deal", "webhook-dup");
    const eventId = `dup-${Date.now()}`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/payments/mock",
          headers: { "x-webhook-secret": "mock-webhook-secret" },
          payload: {
            event_id: eventId,
            event_type: "payment_authorized",
            deal_id: created.deal_id,
            payload: {}
          }
        })
      ).statusCode,
      202
    );

    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/payments/mock",
          headers: { "x-webhook-secret": "mock-webhook-secret" },
          payload: {
            event_id: eventId,
            event_type: "payment_authorized",
            deal_id: created.deal_id,
            payload: {}
          }
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
