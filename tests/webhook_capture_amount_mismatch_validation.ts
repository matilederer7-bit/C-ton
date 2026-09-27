// Black-Sky A-F8 — a provider capture event (charge_captured / recovery_captured)
// that DECLARES an amount or currency must match the obligation it would settle.
// Before the fix the event was applied as success whatever it declared: a
// 1-agora capture of a 420 ILS obligation became ChargedSuccess with a full
// 420 ILS fee-ledger row. A mismatch now writes nothing (no state, no ledger, no
// attempt verdict), opens a PaymentMismatch case and is answered "ignored".
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";

process.env.PORT = "3193";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-af8";
process.env.SELLER_AUTH_CREDENTIALS = JSON.stringify([{ seller_id: "seller-alpha", display_name: "Seller Alpha", access_code: "alpha-code" }]);
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "af8-webhook-secret";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { app } = await import(`../src/app.js?af8-${Date.now()}`);

let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
  }
}

async function postWebhook(body: Record<string, unknown>) {
  const digest = createHmac("sha256", process.env.PAYMENT_WEBHOOK_SECRET || "").update(JSON.stringify(body)).digest("hex");
  const response = await app.inject({ method: "POST", url: "/webhooks/payments", headers: { "x-webhook-signature": `sha256=${digest}` }, payload: body });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as any;
}

async function seedChargeAwaitingWebhook() {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const correlationId = `corr-af8-${randomUUID()}`;
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,'seller-alpha','Charging','A-F8',42,10,20,9, now() + interval '30 minutes', now())`,
    [dealId]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,10,'ChargingAttempt','ChargeAttempt',0, now())`,
    [participantId, dealId, `buyer-af8-${participantId.slice(0, 6)}`]
  );
  await pool.query(
    `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, created_at)
     VALUES ($1,$2,'charge_start','unknown',$3, now())`,
    [participantId, dealId, correlationId]
  );
  return { dealId, participantId, correlationId };
}

function captureEvent(seeded: { dealId: string; participantId: string; correlationId: string }, payload: Record<string, unknown>) {
  return {
    provider: "payrail-http",
    event_id: `af8-${randomUUID()}`,
    event_type: "charge_captured",
    correlation_id: seeded.correlationId,
    participant_id: seeded.participantId,
    deal_id: seeded.dealId,
    provider_reference: `cap-${seeded.participantId.slice(0, 8)}`,
    payload: { provider_reference: `cap-${seeded.participantId.slice(0, 8)}`, ...payload }
  };
}

async function snapshot(seeded: { participantId: string; correlationId: string }) {
  const p = await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [seeded.participantId]);
  const a = await pool.query(`SELECT result_class FROM siton.payment_attempts WHERE participant_id=$1 AND correlation_id=$2`, [seeded.participantId, seeded.correlationId]);
  const fee = await pool.query(`SELECT count(*)::int AS n FROM siton.platform_fee_money_events WHERE participant_id=$1`, [seeded.participantId]);
  const cases = await pool.query(`SELECT count(*)::int AS n FROM siton.operational_cases WHERE auto_key LIKE $1`, [`payment-capture-event-amount-mismatch:${seeded.participantId}:%`]);
  return { ...p.rows[0], attempt: a.rows[0]?.result_class, fee_rows: fee.rows[0].n, cases: cases.rows[0].n };
}

await runTest("a capture event declaring the WRONG amount is not applied as success; a review case is opened", async () => {
  const seeded = await seedChargeAwaitingWebhook();
  const result = await postWebhook(captureEvent(seeded, { amount_minor: 1, currency: "ILS" }));
  assert.equal(result.status, "ignored", JSON.stringify(result));
  const after = await snapshot(seeded);
  assert.equal(after.money_state, "ChargeAttempt", "no ChargedSuccess on a mismatched amount");
  assert.equal(after.buyer_state, "ChargingAttempt");
  assert.equal(after.attempt, "unknown", "the identity is not settled by a mismatched event");
  assert.equal(after.fee_rows, 0, "no fee-ledger row for a mismatched capture");
  assert.equal(after.cases, 1, "a payment-mismatch case is opened");
});

await runTest("a capture event declaring the WRONG currency is not applied", async () => {
  const seeded = await seedChargeAwaitingWebhook();
  const result = await postWebhook(captureEvent(seeded, { amount_minor: 42000, currency: "USD" }));
  assert.equal(result.status, "ignored");
  const after = await snapshot(seeded);
  assert.equal(after.money_state, "ChargeAttempt");
  assert.equal(after.cases, 1);
});

await runTest("a capture event with an unparseable amount is not applied", async () => {
  const seeded = await seedChargeAwaitingWebhook();
  const result = await postWebhook(captureEvent(seeded, { amount_minor: "12.5x" }));
  assert.equal(result.status, "ignored");
  assert.equal((await snapshot(seeded)).money_state, "ChargeAttempt");
});

await runTest("negative: the MATCHING amount/currency is applied as before", async () => {
  const seeded = await seedChargeAwaitingWebhook();
  const result = await postWebhook(captureEvent(seeded, { amount_minor: 42000, currency: "ils" }));
  assert.equal(result.status, "processed", JSON.stringify(result));
  const after = await snapshot(seeded);
  assert.equal(after.money_state, "ChargedSuccess");
  assert.equal(after.attempt, "success");
  assert.equal(after.fee_rows, 1);
  assert.equal(after.cases, 0);
});

await runTest("negative: an event that declares no amount keeps the existing behaviour", async () => {
  const seeded = await seedChargeAwaitingWebhook();
  const result = await postWebhook(captureEvent(seeded, {}));
  assert.equal(result.status, "processed");
  assert.equal((await snapshot(seeded)).money_state, "ChargedSuccess");
});

await pool.end();
process.exit(failed ? 1 : 0);
