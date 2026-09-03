// Independent R9C counterexample: a reclaimed/unresolved charge can race its
// own reconciliation job after passing the pre-I/O fence. Reconciliation sees
// an authorized/final hold and commits charge_failed while the already-fenced
// charge request is in flight. The late capture is then ignored by canonical
// state guards and the newly scheduled recovery performs a second capture.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3101";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-r9c-independent";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "r9c-independent-provider-key";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "5000";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "r9c-independent-webhook-secret";
process.env.WORKER_LEASE_MS = "30000";
process.env.OUTBOX_MAX_ATTEMPTS = "4";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
assert.match(
  String((await pool.query(`SELECT current_database() AS name`)).rows[0]?.name || ""),
  /^siton_test_/,
  "this proof may run only in a disposable isolated test database"
);

let releaseFirstCapture!: () => void;
const firstCaptureReleased = new Promise<void>((resolve) => { releaseFirstCapture = resolve; });
let captureEnteredResolve!: () => void;
const captureEntered = new Promise<void>((resolve) => { captureEnteredResolve = resolve; });
let releaseReconcileStatus!: () => void;
const reconcileStatusReleased = new Promise<void>((resolve) => { releaseReconcileStatus = resolve; });
let reconcileStatusEnteredResolve!: () => void;
const reconcileStatusEntered = new Promise<void>((resolve) => { reconcileStatusEnteredResolve = resolve; });
const calls: Array<{ op: string; key: string }> = [];
let captureSideEffects = 0;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on("end", async () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = new URL(String(req.url), "http://stub");
    res.setHeader("content-type", "application/json");

    if (url.pathname.startsWith("/status/")) {
      calls.push({ op: "status", key: String(body.reference || "") });
      if (calls.filter((call) => call.op === "status").length === 2) {
        reconcileStatusEnteredResolve();
        await reconcileStatusReleased;
      }
      const state = captureSideEffects > 0 ? "captured" : "authorized";
      res.statusCode = 200;
      res.end(JSON.stringify({ state, final: true, provider_reference: "auth-race", amount_minor: 4200 }));
      return;
    }

    if (url.pathname === "/capture") {
      calls.push({ op: "capture", key: String(req.headers["idempotency-key"] || "") });
      captureEnteredResolve();
      await firstCaptureReleased;
      captureSideEffects += 1;
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "captured", capture_id: "cap-race", provider_reference: "cap-race", reference: body.reference }));
      return;
    }

    if (url.pathname === "/recover") {
      calls.push({ op: "recover", key: String(req.headers["idempotency-key"] || "") });
      captureSideEffects += 1;
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "recovered", recovery_id: "rec-race", provider_reference: "rec-race", reference: body.reference }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
});

await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
const address = server.address();
if (!address || typeof address === "string") throw new Error("provider stub did not bind");
process.env.PAYMENT_PROVIDER_BASE_URL = `http://127.0.0.1:${address.port}`;

const { app, processOutboxEventById, closeWorkerDatabase } = await import(`../src/app.js?r9c-independent-race-${Date.now()}`);

const dealId = randomUUID();
const participantId = randomUUID();
const chargeEventId = randomUUID();
const reconcileEventId = randomUUID();
const priorCorrelation = `capture:prior:n1:${participantId}`;

try {
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,'seller-r9c','Charging','R9C independent reconcile race',42,1,50,1,$2,now())`,
    [dealId, new Date(Date.now() + 30 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,'buyer-r9c-race',1,'ChargingAttempt','ChargeAttempt',0,now())`,
    [participantId, dealId]
  );
  await pool.query(
    `INSERT INTO siton.audit_log
       (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize','seed-race',$3,$4)`,
    [participantId, dealId, `seed-race:${participantId}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: "auth-race", authorization_provider: "payrail-http" })]
  );
  await pool.query(
    `INSERT INTO siton.payment_attempts
       (participant_id, deal_id, attempt_type, result_class, correlation_id)
     VALUES ($1,$2,'charge_start','unknown',$3)`,
    [participantId, dealId, priorCorrelation]
  );
  await pool.query(
    `INSERT INTO siton.outbox_events
       (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES
       ($1,'charge_deal','deal',$3,$4,'pending',0,now(),now(),now()),
       ($2,'payment_reconcile','participant',$5,$6,'pending',0,now(),now(),now())`,
    [
      chargeEventId,
      reconcileEventId,
      dealId,
      JSON.stringify({ deal_id: dealId }),
      participantId,
      JSON.stringify({
        participant_id: participantId,
        deal_id: dealId,
        attempt_type: "charge_start",
        correlation_id: priorCorrelation,
        operation: "capture",
        provider_reference: "auth-race",
        reason: "independent_race_proof"
      })
    ]
  );

  // The charge worker resolves the old UNKNOWN as "authorized/final", reuses
  // its identity, passes the lease fence, and reaches the provider. The stub
  // holds it immediately before the side effect.
  const chargeRun = processOutboxEventById(chargeEventId);
  await captureEntered;

  // A duplicate reconciliation job observes the same pre-capture truth and
  // commits charge_failed while the already-fenced request is still in flight.
  const reconcilePromise = processOutboxEventById(reconcileEventId);
  await reconcileStatusEntered;
  const duplicateClaim = await processOutboxEventById(reconcileEventId);
  assert.equal(duplicateClaim, null, "a second worker cannot claim the same reconciliation event concurrently");
  const duplicateReconcile = await pool.query(
    `INSERT INTO siton.outbox_events
       (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ('payment_reconcile','participant',$1,$2,'pending',0,now(),now(),now())
     ON CONFLICT DO NOTHING
     RETURNING event_uuid`,
    [participantId, JSON.stringify({ participant_id: participantId, deal_id: dealId, attempt_type: "charge_start", correlation_id: priorCorrelation, operation: "capture", provider_reference: "auth-race", reason: "duplicate_concurrent_reconcile" })]
  );
  assert.equal(duplicateReconcile.rowCount, 0, "the partial unique index prevents two pending/processing reconcile jobs for one participant");
  releaseReconcileStatus();
  const reconcileRun = await reconcilePromise;
  assert.equal(reconcileRun?.status, "sent", JSON.stringify(reconcileRun));
  const failedState = await pool.query(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [participantId]
  );
  assert.equal(failedState.rows[0]?.buyer_state, "ChargeFailedCompletion");
  assert.equal(failedState.rows[0]?.money_state, "ChargeFailedRecovery");

  // The in-flight capture now succeeds. Its success event cannot apply because
  // reconciliation already moved the participant out of ChargeAttempt.
  releaseFirstCapture();
  const chargeOutcome = await chargeRun;
  assert.equal(chargeOutcome?.status, "sent", JSON.stringify(chargeOutcome));
  assert.equal(captureSideEffects, 1);
  const staleState = await pool.query(
    `SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
    [participantId]
  );
  assert.equal(staleState.rows[0]?.money_state, "ChargeFailedRecovery", "provider captured but canonical state still says recovery is needed");

  const recovery = await pool.query(
    `SELECT event_uuid FROM siton.outbox_events
     WHERE event_type='recovery_deal' AND aggregate_id=$1 AND status='pending'
     ORDER BY created_at ASC LIMIT 1`,
    [dealId]
  );
  assert.equal(recovery.rowCount, 1, "the losing reconciliation path scheduled recovery");
  const recoveryOutcome = await processOutboxEventById(String(recovery.rows[0].event_uuid));
  assert.equal(recoveryOutcome?.status, "sent", JSON.stringify(recoveryOutcome));

  assert.equal(captureSideEffects, 2, "CRITICAL: capture plus recovery produced two provider money side effects");
  assert.equal(calls.filter((call) => call.op === "capture").length, 1);
  assert.equal(calls.filter((call) => call.op === "recover").length, 1);
  const captureKey = calls.find((call) => call.op === "capture")?.key;
  const recoveryKey = calls.find((call) => call.op === "recover")?.key;
  assert.ok(captureKey && recoveryKey && captureKey !== recoveryKey, "recovery minted a distinct provider identity, so provider idempotency cannot dedupe the two effects");

  const statusCallsBeforeStale = calls.filter((call) => call.op === "status").length;
  const staleReconcileId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events
       (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,'payment_reconcile','participant',$2,$3,'pending',0,now(),now(),now())`,
    [staleReconcileId, participantId, JSON.stringify({ participant_id: participantId, deal_id: dealId, attempt_type: "charge_start", correlation_id: priorCorrelation, operation: "capture", provider_reference: "auth-race", reason: "stale_after_recovery" })]
  );
  assert.equal((await processOutboxEventById(staleReconcileId))?.status, "sent");
  assert.equal(calls.filter((call) => call.op === "status").length, statusCallsBeforeStale, "stale reconcile after terminal recovery is a provider-free no-op");

  const evidence = {
    provider_calls: calls,
    provider_money_effect_count: captureSideEffects,
    participant: (await pool.query(
      `SELECT participant_id, buyer_state, money_state FROM siton.participants WHERE participant_id=$1`,
      [participantId]
    )).rows,
    payment_attempts: (await pool.query(
      `SELECT attempt_type, result_class, correlation_id FROM siton.payment_attempts WHERE participant_id=$1 ORDER BY created_at, correlation_id`,
      [participantId]
    )).rows,
    outbox: (await pool.query(
      `SELECT event_type, status, attempt_count, payload FROM siton.outbox_events WHERE aggregate_id IN ($1,$2) ORDER BY created_at, event_type`,
      [dealId, participantId]
    )).rows,
    audit: (await pool.query(
      `SELECT state_type, from_state, to_state, action_name, request_id, idempotency_key FROM siton.audit_log WHERE entity_id=$1 ORDER BY created_at`,
      [participantId]
    )).rows,
    ledger: (await pool.query(
      `SELECT event_type, logical_entry_type, source_money_state, gross_amount, platform_fee_rate, platform_fee_amount FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at`,
      [participantId]
    )).rows
  };
  console.log(`R9C_RACE_EVIDENCE ${JSON.stringify(evidence)}`);

  console.log("PASS deterministic proof reproduced TWO provider captures from charge/reconcile race");
} finally {
  releaseFirstCapture?.();
  releaseReconcileStatus?.();
  await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
