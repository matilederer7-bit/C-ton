// INDEPENDENT ADVERSARIAL FINANCIAL REVIEW — Grow fail-closed policy probe.
//
// Owner decision: Grow exact-operation status and native settle/refund
// idempotency are UNPROVEN, therefore Grow post-dispatch ambiguity must remain
// FAIL-CLOSED — no automatic negative verdict, no automatic second settle.
//
// The candidate gates a status of "authorized/final" behind
// negative_status_authoritative (false for Grow) but lets a status of "failed"
// through as an authoritative negative for EVERY provider. For Grow a
// transaction status is not the outcome of one Siton settle invocation. This
// probe executes a settle that MOVES MONEY at (fake) Grow, answers HTTP 503,
// then reports the transaction as "failed" on the authoritative lookup and
// counts how many settle requests Siton sends. The safe number is ONE.
//
// Real Grow calls 0 — the transport is the same in-process test transport the
// R9B/R9C Grow proofs use.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.PORT = "3162";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-grow-review";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.PAYMENT_PROVIDER = "grow";
process.env.PAYMENT_PROVIDER_MODE = "grow";
process.env.PAYMENT_ENVIRONMENT = "sandbox";
process.env.PAYMENT_PROVIDER_BASE_URL = "https://sandbox.meshulam.co.il/api/light/server/1.0";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "1000";
process.env.RECOVERY_PREFLIGHT_CONFIRM_MS = "30";
process.env.GROW_USER_ID = "grow-sandbox-user";
process.env.GROW_PAGE_CODE = "grow-sandbox-page";
process.env.GROW_REFERENCE_ENCRYPTION_KEY = "grow-sandbox-reference-encryption-key-48-characters!";
process.env.GROW_SUCCESS_URL = "https://siton-staging.example.invalid/pay/success";
process.env.GROW_CANCEL_URL = "https://siton-staging.example.invalid/pay/cancel";
process.env.GROW_NOTIFY_URL = "https://siton-staging.example.invalid/webhooks/payments/grow";

type FakeTx = { transactionId: string; transactionToken: string; statusCode: string; status: string; sum: string };
const fake = {
  transactions: new Map<string, FakeTx>(),
  settleCalls: 0,
  settleEffects: 0,
  lookups: 0,
  /** what the authoritative lookup reports after a settle executed: the truth ("2"/paid) or a failure code */
  lookupMode: "truth" as "truth" | "failed_code"
};

(globalThis as Record<string, unknown>).__SITON_GROW_TEST_TRANSPORT__ = async (request: { url: string; body: URLSearchParams }) => {
  const fields = Object.fromEntries(request.body.entries());
  const ok = (data: unknown) => ({ status: 200, body: { status: 1, err: "", data } });
  const err = (message: string) => ({ status: 200, body: { status: 0, err: { id: 400, message }, data: "" } });
  if (request.url.endsWith("/getTransactionInfo")) {
    fake.lookups += 1;
    const tx = fake.transactions.get(String(fields.transactionId));
    if (!tx || tx.transactionToken !== fields.transactionToken) return err("transaction not found");
    if (fake.lookupMode === "failed_code" && tx.statusCode === "2") return ok({ ...tx, statusCode: "6", status: "נכשל" });
    return ok({ ...tx });
  }
  if (request.url.endsWith("/settleSuspendedTransaction")) {
    fake.settleCalls += 1;
    const tx = fake.transactions.get(String(fields.transactionId));
    if (!tx || tx.transactionToken !== fields.transactionToken) return err("transaction not found");
    // Money moves at Grow BEFORE the answer is lost.
    fake.settleEffects += 1;
    tx.statusCode = "2";
    tx.status = "שולם";
    tx.sum = String(fields.sum);
    return { status: 503, body: { status: 0, err: "gateway timeout after settle" } };
  }
  return { status: 404, body: { status: 0, err: "unknown endpoint" } };
};

const { app, processOutboxEventById } = await import(`../src/app.js?grow-review-${Date.now()}`);
const { sealGrowReference } = await import("../src/grow_payment_adapter.js");
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await app.ready();

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed += 1; }
  catch (error) { console.error(`FAIL ${name}: ${(error as any)?.stack || (error as any)?.message || error}`); failed += 1; }
}

async function seedChargingParticipant(prefix: string) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const buyerId = `${prefix}-buyer`;
  const tx: FakeTx = { transactionId: `tx-${prefix}`, transactionToken: `tok-${prefix}`, statusCode: "11", status: "עסקה מושהית", sum: "20.00" };
  fake.transactions.set(tx.transactionId, tx);
  const sealed = sealGrowReference({ process_id: `gp-${prefix}`, process_token: `ptoken-${prefix}`, transaction_id: tx.transactionId, transaction_token: tx.transactionToken }, process.env.GROW_REFERENCE_ENCRYPTION_KEY!);
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,'seller-grow-review','Charging',$2,10,1,50,1,now()+interval '1 day',now())`,
    [dealId, `${prefix} deal`]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,2,'ChargingAttempt','ChargeAttempt',0,clock_timestamp())`,
    [participantId, dealId, buyerId]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `grow-review-${prefix}`, `grow-review:${participantId}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: sealed, authorization_provider: "grow" })]
  );
  await pool.query(
    `INSERT INTO siton.payment_authorization_bindings
       (provider_code, provider_mode, provider_environment, authorization_id, provider_reference, deal_id, buyer_id, qty, amount_minor, currency, delivery_cost, status, correlation_id, consumed_by_participant_id, consumed_at)
     VALUES ('grow','grow','sandbox',$1,$1,$2,$3,2,2000,'ILS',0,'consumed',$4,$5,now())`,
    [sealed, dealId, buyerId, `grow-review-auth:${prefix}`, participantId]
  );
  return { dealId, participantId, tx };
}

async function enqueue(eventType: string, aggregateType: "deal" | "participant", aggregateId: string, payload: Record<string, unknown>) {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,$2,$3,$4,$5,'pending',0,now())`,
    [eventId, eventType, aggregateType, aggregateId, JSON.stringify(payload)]
  );
  return eventId;
}
async function pendingEvent(eventType: string, aggregateId: string) {
  const r = await pool.query(`SELECT event_uuid FROM siton.outbox_events WHERE event_type=$1 AND aggregate_id=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [eventType, aggregateId]);
  return r.rows[0]?.event_uuid as string | undefined;
}

await runTest("Grow: settle EXECUTED then HTTP 503 (UNKNOWN); the authoritative lookup answers a FAILURE code → no automatic charge_failed verdict, no recovery, ONE settle only, FINANCIAL_OUTCOME_UNRESOLVED case", async () => {
  const flow = await seedChargingParticipant("rev-failed");
  fake.lookupMode = "failed_code";
  const chargeEvent = await enqueue("charge_deal", "deal", flow.dealId, { deal_id: flow.dealId });
  const charged = await processOutboxEventById(chargeEvent);
  assert.equal(charged?.status, "sent", JSON.stringify(charged));
  assert.equal(fake.settleCalls, 1);
  assert.equal(fake.settleEffects, 1, "the synthetic settle moved money before the 503");
  const attempt = await pool.query(`SELECT result_class FROM siton.payment_attempts WHERE participant_id=$1 AND attempt_type='charge_start'`, [flow.participantId]);
  assert.equal(attempt.rows[0]?.result_class, "unknown", "503 after dispatch is UNKNOWN");
  const reconcileEvent = await pendingEvent("payment_reconcile", flow.participantId);
  assert.ok(reconcileEvent, "UNKNOWN settle schedules a reconcile");
  const reconciled = await processOutboxEventById(reconcileEvent!);
  const participant = (await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [flow.participantId])).rows[0];
  console.log(`  reconcile=${reconciled?.status}:${String((reconciled as any)?.error || "").slice(0, 80)} participant=${participant.buyer_state}/${participant.money_state} settle_calls=${fake.settleCalls}`);
  // Drive whatever the reconcile armed (recovery_deal) and count settles.
  const recoveryEvent = await pendingEvent("recovery_deal", flow.dealId);
  if (recoveryEvent) {
    const recovered = await processOutboxEventById(recoveryEvent);
    console.log(`  recovery_deal=${recovered?.status}:${String((recovered as any)?.error || "").slice(0, 80)} settle_calls=${fake.settleCalls}`);
  }
  assert.equal(fake.settleCalls, 1, "AUTOMATIC SECOND SETTLE on Grow after a status read of 'failed' — the exact settle may have executed (it did)");
  assert.equal(participant.money_state, "ChargeAttempt", "no charge_failed verdict from a status the Grow contract cannot tie to the exact settle");
  assert.equal(recoveryEvent, undefined, "no recovery may be armed from an unproven negative");
  const cases = await pool.query(`SELECT subject FROM siton.operational_cases WHERE auto_key LIKE $1`, [`payment-outcome-unresolved:${flow.participantId}:charge_start:%`]);
  assert.equal(cases.rowCount, 1, "the hold must be an operator case");
  assert.match(String(cases.rows[0].subject), /FINANCIAL_OUTCOME_UNRESOLVED/);
  fake.lookupMode = "truth";
});

await runTest("Grow: after the operator-side truth becomes visible (lookup reports paid) the SAME identity converges to ChargedSuccess with zero further settles", async () => {
  const flow = await seedChargingParticipant("rev-truth");
  fake.lookupMode = "truth";
  const before = fake.settleCalls;
  const chargeEvent = await enqueue("charge_deal", "deal", flow.dealId, { deal_id: flow.dealId });
  assert.equal((await processOutboxEventById(chargeEvent))?.status, "sent");
  assert.equal(fake.settleCalls, before + 1);
  const reconcileEvent = await pendingEvent("payment_reconcile", flow.participantId);
  assert.ok(reconcileEvent);
  const reconciled = await processOutboxEventById(reconcileEvent!);
  assert.equal(reconciled?.status, "sent", JSON.stringify(reconciled));
  const participant = (await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [flow.participantId])).rows[0];
  assert.equal(participant.money_state, "ChargedSuccess");
  assert.equal(fake.settleCalls, before + 1, "reconciliation never repeats the settle");
});

console.log(`\nSUMMARY payment_review_grow_negative_status passed=${passed} failed=${failed}`);
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
process.exit(failed ? 1 : 0);
