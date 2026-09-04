// R9C integration self-review — SR-1: a STALE dispatching owner must not be
// able to overwrite the lifecycle row of the SAME identity after its lease died
// and a live successor re-armed that identity.
//
// Found while integrating claude/r9c-system-red-team (f025d3f) onto master
// (123bbf9); the defect exists on the R9C branch itself. settleProviderDispatch
// wrote the outcome with NO owner fence for the non-success outcomes, and the
// migration-063 UPDATE guard refused only 'permanent_fail'/'temporary_fail',
// re-arming and disarming — not a foreign `unknown` + `responded` write. So a
// worker that stalled after dispatch (lease expired → job reclaimed → a
// successor re-sent the SAME identity and is now IN FLIGHT) could flip the
// successor's row to `responded`, which makes payment_operation_in_flight()
// false and blinds the C1 participant-wide in-flight guard:
//
//   reconcile reads "authorized/final" while the successor's capture is at the
//   provider → declares charge_failed → settles the identity permanent_fail →
//   recovery is no longer blocked (permanent_fail is not a blocking class) →
//   recovery captures the buyer a SECOND time while the first capture lands.
//   TWO provider money effects for one obligation = Codex C1, re-opened.
//
// Choreography (in-process provider-ready HTTP stub; no real provider, no money):
//   W1  claims charge_deal, arms identity K, sends the capture; the request is
//       lost in transit BEFORE any money effect → UNKNOWN; W1 is then frozen
//       (payment.after_provider_io barrier) exactly where a stalled process sits.
//   ——  W1's lease expires; the job is reclaimed.
//   W2  claims the same job (lease generation 2), proves K not executed through
//       the status seam, reuses K, re-arms it and sends the capture; the stub
//       HOLDS this request in flight.
//   W1  wakes up and settles its stale outcome.
//   REQUIRED: K stays `dispatching` under W2 (in_flight = true); the DB refuses
//       any foreign non-success write on an in-flight row (SN409); a reconcile
//       job DEFERS without a status read; a recovery_deal job finds nothing to
//       recover; when W2's capture lands there is exactly ONE provider money
//       effect, ZERO recovery calls, canonical ChargedSuccess and ONE ledger
//       entry, all on ONE identity.
//
// The deal is seeded in CompletionWindow: a duplicate/retried charge_deal for a
// deal whose window already opened is the documented F8 situation, and it is
// what makes a recovery_deal job legitimately runnable while a capture for the
// same participant is still unresolved. The charge job's own final
// Charging→CompletionWindow transition therefore fails noisily (F8) on both the
// fixed and the unfixed code; this proof asserts money invariants, not the job's
// exit status.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3103";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-r9c-stale-owner";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "r9c-stale-owner-provider-key";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "5000";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "r9c-stale-owner-webhook-secret";
process.env.WORKER_LEASE_MS = "30000";
process.env.OUTBOX_MAX_ATTEMPTS = "4";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
assert.match(
  String((await pool.query(`SELECT current_database() AS name`)).rows[0]?.name || ""),
  /^siton_test_/,
  "this proof may run only in a disposable isolated test database"
);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

// Nothing may stay blocked or unobserved when a scenario fails: a worker still
// waiting on a provider hold would otherwise run into the closed pool during
// teardown and hide the real assertion behind a crash.
const pendingWorkers: Array<Promise<unknown>> = [];
const releaseHooks: Array<() => void> = [];
function track(worker: Promise<any>): Promise<any> {
  pendingWorkers.push(worker.catch(() => undefined));
  return worker;
}
async function quiesce() {
  for (const release of releaseHooks.splice(0)) { try { release(); } catch { /* already released */ } }
  await Promise.allSettled(pendingWorkers.splice(0));
}

type Call = { op: string; key: string; auth: string };
type Hold = { entered: Promise<void>; release: () => void };
const calls: Call[] = [];
const effects = new Map<string, number>();
const holds = new Map<string, { enteredResolve: () => void; released: Promise<void> }>();
function holdCapture(auth: string, nth: number): Hold {
  let enteredResolve!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  holds.set(`${auth}#${nth}`, { enteredResolve, released });
  releaseHooks.push(() => { enteredResolve(); release(); });
  return { entered, release };
}
const ops = (op: string, auth?: string) => calls.filter((c) => c.op === op && (!auth || c.auth === auth));
const effectsOf = (auth: string) => effects.get(auth) || 0;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on("end", async () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = new URL(String(req.url), "http://stub");
    const auth = String(body.authorization_id || decodeURIComponent(url.pathname.split("/").pop() || "")).replace(/^(cap|rec)-/, "");
    res.setHeader("content-type", "application/json");
    if (url.pathname.startsWith("/status/")) {
      calls.push({ op: "status", key: "", auth });
      res.statusCode = 200;
      res.end(JSON.stringify({ state: effectsOf(auth) > 0 ? "captured" : "authorized", final: true, provider_reference: auth, amount_minor: 4200 }));
      return;
    }
    if (url.pathname === "/capture" || url.pathname === "/recover") {
      const op = url.pathname === "/capture" ? "capture" : "recover";
      calls.push({ op, key: String(req.headers["idempotency-key"] || ""), auth });
      const nth = ops(op, auth).length;
      if (op === "capture" && nth === 1) {
        // Lost in transit: nothing reaches the money side. The client learns
        // only that the request was dispatched → UNKNOWN.
        req.socket.destroy();
        return;
      }
      const pending = holds.get(`${auth}#${nth}`);
      if (pending) {
        pending.enteredResolve();
        await pending.released; // the request is IN FLIGHT at the provider
      }
      effects.set(auth, effectsOf(auth) + 1); // the money moves NOW
      if (res.destroyed) return;
      res.statusCode = 200;
      res.end(JSON.stringify({
        status: op === "capture" ? "captured" : "recovered",
        [op === "capture" ? "capture_id" : "recovery_id"]: `${op === "capture" ? "cap" : "rec"}-${auth}`,
        provider_reference: `${op === "capture" ? "cap" : "rec"}-${auth}`,
        reference: body.reference
      }));
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

const { app, processOutboxEventById, reclaimWorkerJobs, closeWorkerDatabase } = await import(`../src/app.js?r9c-stale-owner-${Date.now()}`);
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");

async function seed(suffix: string) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const authorizationId = `auth-${suffix}`;
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
     VALUES ($1,'seller-r9c','CompletionWindow',$2,42,1,50,1,$3,now(),$4)`,
    [dealId, `R9C stale owner ${suffix}`, new Date(Date.now() + 30 * 60_000).toISOString(), new Date(Date.now() + 20 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,1,'ChargingAttempt','ChargeAttempt',0,now())`,
    [participantId, dealId, `buyer-r9c-${suffix}`]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `seed-${suffix}`, `seed-${suffix}:${participantId}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: authorizationId, authorization_provider: "payrail-http" })]
  );
  return { dealId, participantId, authorizationId };
}

async function insertEvent(eventType: string, aggregateType: "deal" | "participant", aggregateId: string, payload: Record<string, unknown>) {
  const eventId = randomUUID();
  const inserted = await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'pending',0,now(),now(),now()) ON CONFLICT DO NOTHING RETURNING event_uuid`,
    [eventId, eventType, aggregateType, aggregateId, JSON.stringify(payload)]
  );
  return inserted.rowCount ? eventId : null;
}
async function participantState(participantId: string) {
  return (await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [participantId])).rows[0] as { buyer_state: string; money_state: string };
}
async function attempts(participantId: string) {
  return (await pool.query(
    `SELECT attempt_type, correlation_id, result_class, dispatch_state, owner_event_uuid, owner_lease_generation,
            siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation) AS in_flight
     FROM siton.payment_attempts WHERE participant_id=$1 ORDER BY created_at ASC, correlation_id ASC`,
    [participantId]
  )).rows as Array<{ attempt_type: string; correlation_id: string; result_class: string; dispatch_state: string; owner_event_uuid: string | null; owner_lease_generation: number | null; in_flight: boolean }>;
}
async function ledger(participantId: string) {
  return (await pool.query(`SELECT logical_entry_type FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at`, [participantId])).rows.map((r) => String(r.logical_entry_type));
}
async function outboxRow(eventId: string) {
  return (await pool.query(`SELECT status, lease_generation, attempt_count, (available_at > now()) AS deferred FROM siton.outbox_events WHERE event_uuid=$1`, [eventId])).rows[0] as { status: string; lease_generation: number; attempt_count: number; deferred: boolean } | undefined;
}
async function cases(prefix: string) {
  return (await pool.query(`SELECT auto_key FROM siton.operational_cases WHERE auto_key LIKE $1 ORDER BY created_at`, [`${prefix}%`])).rows.map((r) => String(r.auto_key));
}
async function pendingEventOfType(eventType: string, aggregateId: string) {
  const r = await pool.query(
    `SELECT event_uuid FROM siton.outbox_events
     WHERE event_type=$1 AND aggregate_id=$2 AND status='pending'
     ORDER BY created_at DESC LIMIT 1`,
    [eventType, aggregateId]
  );
  return r.rows[0] ? String(r.rows[0].event_uuid) : null;
}
async function pendingReconcileEvent(participantId: string) {
  const r = await pool.query(
    `SELECT event_uuid FROM siton.outbox_events
     WHERE event_type='payment_reconcile' AND aggregate_id=$1 AND status='pending'
     ORDER BY created_at DESC LIMIT 1`,
    [participantId]
  );
  return r.rows[0] ? String(r.rows[0].event_uuid) : null;
}
async function retryNow(eventId: string) {
  await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [eventId]);
}

/** A stale owner (event E, lease generation 1) writes a non-success outcome directly. Always rolled back. */
async function probeStaleOwnerWrite(participantId: string, correlation: string, eventId: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('siton.is_worker','true',true)`);
    await c.query(`SELECT set_config('siton.payment_dispatch_owner',$1,true)`, [`${eventId}:1`]);
    try {
      await c.query(
        `UPDATE siton.payment_attempts SET result_class='unknown', dispatch_state='responded', outcome_note='stale_owner_probe'
         WHERE participant_id=$1 AND correlation_id=$2`,
        [participantId, correlation]
      );
      return "admitted";
    } catch (error: any) {
      return `refused:${String(error?.code)}:${String(error?.message || "").split(":")[0]}`;
    }
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

const evidence: Record<string, unknown> = {};

try {
  await run("SR-1: a stale dispatching owner cannot blind the in-flight guard after reclaim + same-identity re-dispatch → ONE provider effect, ZERO recovery calls", async () => {
    const s = await seed("stale");
    const chargeEvent = (await insertEvent("charge_deal", "deal", s.dealId, { deal_id: s.dealId }))!;
    assert.ok(chargeEvent);

    // ---- W1: capture lost in transit (UNKNOWN), then the process stalls.
    const w1Frozen = armTestFault("payment.after_provider_io", { kind: "block" })!;
    releaseHooks.push(() => w1Frozen.release());
    const w1 = track(processOutboxEventById(chargeEvent));
    await w1Frozen.entered;
    const armedByW1 = (await attempts(s.participantId))[0]!;
    assert.equal(armedByW1.attempt_type, "charge_start");
    assert.equal(armedByW1.dispatch_state, "dispatching");
    assert.equal(armedByW1.owner_event_uuid, chargeEvent);
    assert.equal(armedByW1.owner_lease_generation, 1);
    assert.equal(armedByW1.in_flight, true, "W1 owns the operation under a live lease");
    const K = armedByW1.correlation_id;
    assert.equal(ops("capture", s.authorizationId).length, 1);
    assert.equal(effectsOf(s.authorizationId), 0, "the lost request moved no money");

    // ---- the stall outlives the lease; the job is reclaimed.
    await pool.query(`UPDATE siton.outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE event_uuid=$1`, [chargeEvent]);
    const reclaimed = await reclaimWorkerJobs();
    assert.equal(reclaimed.outbox, 1, "the stalled job is reclaimed");
    assert.equal((await outboxRow(chargeEvent))?.status, "pending");
    assert.equal((await attempts(s.participantId))[0]!.in_flight, false, "a dead lease means UNKNOWN, not in flight");

    // ---- W2 claims the same job, proves K not executed, reuses K, re-arms, sends.
    const w2Hold = holdCapture(s.authorizationId, 2);
    const statusReadsBeforeW2 = ops("status", s.authorizationId).length;
    const w2 = track(processOutboxEventById(chargeEvent));
    await w2Hold.entered;
    assert.equal(ops("status", s.authorizationId).length, statusReadsBeforeW2 + 1, "W2 resolved the prior identity through the status seam before re-sending");
    const armedByW2 = (await attempts(s.participantId))[0]!;
    assert.equal(armedByW2.correlation_id, K, "the SAME durable identity is re-sent (no rotation)");
    assert.equal(armedByW2.dispatch_state, "dispatching");
    assert.equal(armedByW2.owner_lease_generation, 2, "W2 owns the operation now");
    assert.equal(armedByW2.in_flight, true);
    assert.equal(ops("capture", s.authorizationId).length, 2);
    assert.equal(ops("capture", s.authorizationId)[1]!.key, K, "the provider sees the same idempotency key");

    // ---- DB backstop probe (rolled back).
    const dbProbe = await probeStaleOwnerWrite(s.participantId, K, chargeEvent);
    evidence.db_probe_stale_owner_unknown_write = dbProbe;
    assert.equal((await attempts(s.participantId))[0]!.dispatch_state, "dispatching", "the probe was rolled back");

    // ---- W1 wakes up and settles its stale outcome on the same identity.
    w1Frozen.release();
    const w1Outcome = await w1;
    evidence.w1_outcome = w1Outcome;
    const afterStaleSettle = (await attempts(s.participantId))[0]!;
    evidence.row_after_stale_settle = afterStaleSettle;

    // ---- a reconcile for K must conclude nothing while W2 is in flight.
    const statusReadsBeforeReconcile = ops("status", s.authorizationId).length;
    // A stale worker that managed to settle its outcome schedules a reconcile of
    // its own; the partial unique index then refuses a second pending job. Either
    // way exactly one reconcile job for this identity must be processed here.
    const scheduledByStaleWorker = await pendingReconcileEvent(s.participantId);
    const reconcileEvent = scheduledByStaleWorker || (await insertEvent("payment_reconcile", "participant", s.participantId, {
      participant_id: s.participantId, deal_id: s.dealId, attempt_type: "charge_start", correlation_id: K,
      operation: "capture", provider_reference: s.authorizationId, reason: "stale_owner_selfreview"
    }));
    evidence.reconcile_scheduled_by_stale_worker = Boolean(scheduledByStaleWorker);
    assert.ok(reconcileEvent, "a reconcile job must exist for the unresolved identity");
    await retryNow(reconcileEvent!);
    const reconcileRun = await processOutboxEventById(reconcileEvent!);
    evidence.reconcile_run_while_w2_in_flight = reconcileRun;
    evidence.status_reads_by_reconcile = ops("status", s.authorizationId).length - statusReadsBeforeReconcile;
    evidence.participant_after_reconcile = await participantState(s.participantId);

    // ---- a recovery job for the deal must find nothing to recover.
    // A false charge_failed verdict schedules recovery itself; either way the
    // recovery job that exists for this deal is processed here.
    const recoveryScheduledByVerdict = await pendingEventOfType("recovery_deal", s.dealId);
    const recoveryEvent = recoveryScheduledByVerdict || (await insertEvent("recovery_deal", "deal", s.dealId, { deal_id: s.dealId }));
    evidence.recovery_scheduled_by_verdict = Boolean(recoveryScheduledByVerdict);
    if (recoveryEvent) await retryNow(recoveryEvent);
    const recoveryRun = recoveryEvent ? await processOutboxEventById(recoveryEvent) : null;
    evidence.recovery_run_while_w2_in_flight = recoveryRun;
    evidence.recover_calls = ops("recover", s.authorizationId).length;

    // ---- W2's capture finally lands.
    w2Hold.release();
    const w2Outcome = await w2;
    evidence.w2_outcome = w2Outcome;
    evidence.final = {
      provider_calls: calls.filter((c) => c.auth === s.authorizationId),
      effects: effectsOf(s.authorizationId),
      participant: await participantState(s.participantId),
      attempts: await attempts(s.participantId),
      ledger: await ledger(s.participantId),
      cases: await cases("payment-")
    };
    console.log(`R9C_STALE_OWNER_EVIDENCE ${JSON.stringify(evidence)}`);

    // ---- invariants ------------------------------------------------------
    assert.equal(afterStaleSettle.dispatch_state, "dispatching", "a stale owner must not flip the successor's IN_FLIGHT row to responded");
    assert.equal(afterStaleSettle.result_class, "unknown");
    assert.equal(afterStaleSettle.owner_lease_generation, 2, "ownership stays with the live successor");
    assert.equal(afterStaleSettle.in_flight, true, "the operation stays visible as IN_FLIGHT");
    assert.equal(w1Outcome?.status, "lease_lost", `the stale worker must recognise it lost the job: ${JSON.stringify(w1Outcome)}`);
    assert.match(String(dbProbe), /^refused:SN409/, `the DB guard must refuse a foreign non-success write on an in-flight row (got ${dbProbe})`);
    assert.equal(reconcileRun?.status, "failed", JSON.stringify(reconcileRun));
    assert.match(String(reconcileRun?.error), /payment_reconcile_operation_in_flight/, "reconcile must DEFER while the capture may be in flight");
    assert.equal(evidence.status_reads_by_reconcile, 0, "no status read is taken while the operation is in flight");
    // The state as it stood WHILE the successor was still in flight (a fresh
    // read here would already show the landed capture).
    assert.equal((evidence.participant_after_reconcile as any).money_state, "ChargeAttempt", "no charge_failed verdict may be written while the capture is in flight");
    assert.equal((evidence.participant_after_reconcile as any).buyer_state, "ChargingAttempt");
    assert.equal(evidence.recover_calls, 0, "a recovery job must find nothing to recover while the capture is unresolved");
    assert.equal(ops("recover", s.authorizationId).length, 0, "CRITICAL invariant: zero recovery money calls");
    assert.equal(effectsOf(s.authorizationId), 1, "ONE provider money effect for one obligation");
    const finalState = await participantState(s.participantId);
    assert.equal(finalState.money_state, "ChargedSuccess");
    assert.equal(finalState.buyer_state, "ChargedSuccess");
    assert.deepEqual(await ledger(s.participantId), ["charge"], "exactly one fee-ledger entry");
    const rows = await attempts(s.participantId);
    assert.equal(rows.length, 1, "one identity for the whole episode");
    assert.equal(rows[0]!.result_class, "success");
    assert.equal(rows[0]!.dispatch_state, "responded");

    // ---- the deferred reconcile converges as a provider-free no-op.
    await retryNow(reconcileEvent!);
    const retry = await processOutboxEventById(reconcileEvent!);
    assert.equal(retry?.status, "sent", JSON.stringify(retry));
    assert.equal(ops("status", s.authorizationId).length, statusReadsBeforeReconcile, "a resolved participant needs no status read");
    assert.equal(ops("recover", s.authorizationId).length, 0);
    assert.equal(effectsOf(s.authorizationId), 1);
  });

  await run("SR-1b: provider SUCCESS from a foreign writer is still admitted on an in-flight row (provider truth is never refused)", async () => {
    const s = await seed("stale-success");
    const chargeEvent = (await insertEvent("charge_deal", "deal", s.dealId, { deal_id: s.dealId }))!;
    // The stub loses only the FIRST capture per authorization; pre-record one so
    // this participant's real capture is the second call and can be held.
    calls.push({ op: "capture", key: "pre-recorded-so-the-real-call-is-nth-2", auth: s.authorizationId });
    const hold = holdCapture(s.authorizationId, 2);
    const worker = track(processOutboxEventById(chargeEvent));
    await hold.entered;
    const row = (await attempts(s.participantId))[0]!;
    assert.equal(row.dispatch_state, "dispatching");
    assert.equal(row.in_flight, true);
    const c = await pool.connect();
    let admitted = false;
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('siton.is_worker','true',true)`);
      await c.query(`SELECT set_config('siton.payment_dispatch_owner',$1,true)`, [`${chargeEvent}:999`]);
      await c.query(
        `UPDATE siton.payment_attempts SET result_class='success', outcome_note='foreign_success_probe'
         WHERE participant_id=$1 AND correlation_id=$2`,
        [s.participantId, row.correlation_id]
      );
      admitted = true;
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
    assert.equal(admitted, true, "a foreign writer declaring provider SUCCESS must never be refused");
    hold.release();
    await worker;
    assert.equal(effectsOf(s.authorizationId), 1);
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess");
    assert.equal((await attempts(s.participantId))[0]!.result_class, "success");
  });

  console.log(`SUMMARY passed=${passed} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await quiesce();
  resetTestFaults();
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}
