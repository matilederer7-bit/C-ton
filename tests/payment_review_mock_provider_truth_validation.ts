// INDEPENDENT ADVERSARIAL FINANCIAL REVIEW — mock-backed provider truth probe.
//
// The in-process mock provider (demo / staging) answers EVERY capture status
// lookup with "captured / final" regardless of whether a mock capture ever
// happened (R9C INFO F9). The candidate's recovery pre-flight (F-1/F-9) trusts
// that answer: for a mock-backed deployment every declined capture is then
// mis-read as "already captured", the charge_start identity is marked SUCCESS
// for money that never moved, a false late-money-effect case is opened and the
// recovery never runs. This is exactly the "provider says captured but no
// economic effect" false-truth attack — executed by our own mock.
//
// Synthetic money only (the mock moves nothing). Disposable database.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.PORT = "3163";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-mock-review";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.MOCK_SEED = "7";
process.env.RECOVERY_PREFLIGHT_CONFIRM_MS = "10";
delete process.env.PAYMENT_PROVIDER;
delete process.env.PAYMENT_PROVIDER_MODE;

const { app, processOutboxEventById } = await import(`../src/app.js?mock-review-${Date.now()}`);
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await app.ready();

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed += 1; }
  catch (error) { console.error(`FAIL ${name}: ${(error as any)?.stack || (error as any)?.message || error}`); failed += 1; }
}

async function seedRecoverable(prefix: string) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const authorization = `auth_${prefix}${randomUUID().slice(0, 6)}`;
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
     VALUES ($1,'seller-mock-review','CompletionWindow',$2,10,1,50,1,now()+interval '1 day',now(),now()+interval '5 minutes')`,
    [dealId, `${prefix} deal`]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,1,'ChargeFailedCompletion','ChargeFailedRecovery',0,clock_timestamp())`,
    [participantId, dealId, `${prefix}-buyer`]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `mock-review-${prefix}`, `mock-review:${participantId}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: authorization, authorization_provider: "mockpay" })]
  );
  await pool.query(
    `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state)
     VALUES ($1,$2,'charge_start','permanent_fail',$3,'responded')`,
    [participantId, dealId, `capture:mock-review:n1:${participantId}`]
  );
  return { dealId, participantId, authorization };
}

await runTest("mock provider: a declined capture must be recoverable — the pre-flight must not believe a status 'captured' that no mock capture ever produced", async () => {
  const flow = await seedRecoverable("rec");
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'recovery_deal','deal',$2,$3,'pending',0,now())`,
    [eventId, flow.dealId, JSON.stringify({ deal_id: flow.dealId })]
  );
  const outcome = await processOutboxEventById(eventId);
  const attempts = (await pool.query(`SELECT attempt_type, result_class, outcome_note FROM siton.payment_attempts WHERE participant_id=$1 ORDER BY created_at`, [flow.participantId])).rows as Array<{ attempt_type: string; result_class: string; outcome_note: string | null }>;
  const cases = (await pool.query(`SELECT auto_key FROM siton.operational_cases WHERE auto_key LIKE '%' || $1 || '%'`, [flow.participantId])).rows.map((r: any) => String(r.auto_key).split(":")[0]);
  const participant = (await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [flow.participantId])).rows[0];
  console.log(`  recovery_deal=${outcome?.status}:${String((outcome as any)?.error || "").slice(0, 60)} participant=${participant.buyer_state}/${participant.money_state} attempts=${JSON.stringify(attempts)} cases=${cases.join(",")}`);
  const capture = attempts.find((a) => a.attempt_type === "charge_start")!;
  assert.equal(capture.result_class, "permanent_fail", "the mock never captured: the capture identity must not be flipped to SUCCESS on a fabricated status");
  assert.ok(!cases.includes("payment-recovery-preflight-captured"), "no false 'original capture already executed' case may be opened for money that never moved");
  assert.ok(attempts.some((a) => a.attempt_type === "recovery"), "a recovery must actually be attempted for a declined capture on the mock provider");
});

console.log(`\nSUMMARY payment_review_mock_provider_truth passed=${passed} failed=${failed}`);
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
process.exit(failed ? 1 : 0);
