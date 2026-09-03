// R9C remediation regression — capture / reconciliation race (Codex C1) and the
// recovery-eligibility invariant.
//
// Adapted from the independent Codex counterexample (branch
// codex/r9c-independent-review @ 550a976, same file name). The ORIGINAL proof
// PASSED when it reproduced TWO provider money effects (capture + recovery under
// distinct identities) on R9C SHA 33a2cb2: reconciliation read "authorized/final"
// while the fenced capture request was in flight, declared charge_failed and
// scheduled recovery. This version keeps that choreography but asserts the SAFE
// behaviour, so it FAILS on the unfixed code and PASSES after remediation.
//
//   CASE 1   capture in flight + reconcile reads the same participant + capture
//            later succeeds → provider effects = 1, recovery calls = 0; the DB
//            guard also refuses a non-owner negative settle while in flight
//   CASE 8   charge and reconcile start concurrently (reconcile carries a stale /
//            foreign correlation) → one financial truth
//   CASE 9   two reconcile claims race → exactly one claim; a duplicate pending
//            reconcile job is refused by the partial unique index
//   CASE 10  reconcile runs after provider success but BEFORE local persistence
//            → deferred; one effect; canonical convergence
//   CASE 11  recovery attempted while the original capture is UNKNOWN → blocked
//            (zero recovery money calls, FINANCIAL_OUTCOME_UNRESOLVED case,
//            reconcile scheduled); once the capture resolves as not executed the
//            recovery proceeds exactly once
//   CASE 11b recovery attempted while a capture is recorded as SUCCESS but the
//            participant says charge failed → blocked, case opened, DB backstop
//
// Provider: in-process HTTP stub (PAYMENT_PROVIDER_MODE=provider-ready) that
// records every money side effect BEFORE it answers. No real provider, no money.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3101";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-r9c-race";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "r9c-race-provider-key";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "5000";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "r9c-race-webhook-secret";
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
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

type Call = { op: string; key: string; auth: string };
type Hold = { entered: Promise<void>; release: () => void };
const calls: Call[] = [];
const effects = new Map<string, number>();
const holds = new Map<string, { enteredResolve: () => void; released: Promise<void>; hold: Hold }>();
function holdFirstCapture(auth: string): Hold {
  let enteredResolve!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const hold = { entered, release };
  holds.set(auth, { enteredResolve, released, hold });
  return hold;
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
      const pending = holds.get(auth);
      if (op === "capture" && pending && ops("capture", auth).length === 1) {
        pending.enteredResolve();
        await pending.released; // the request is IN FLIGHT at the provider
      }
      // the money moves NOW; whatever the client sees afterwards is a separate matter
      effects.set(auth, effectsOf(auth) + 1);
      res.statusCode = 200;
      res.end(JSON.stringify({ status: op === "capture" ? "captured" : "recovered", [op === "capture" ? "capture_id" : "recovery_id"]: `${op === "capture" ? "cap" : "rec"}-${auth}`, provider_reference: `${op === "capture" ? "cap" : "rec"}-${auth}`, reference: body.reference }));
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

const { app, processOutboxEventById, closeWorkerDatabase } = await import(`../src/app.js?r9c-race-${Date.now()}`);
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");

async function seed(args: {
  suffix: string;
  dealState: string;
  buyer_state: string;
  money_state: string;
  completionWindowUntil?: Date | null;
  priorAttempt?: { attempt_type?: "charge_start" | "recovery"; result_class: "unknown" | "success" | "permanent_fail" };
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const authorizationId = `auth-${args.suffix}`;
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
     VALUES ($1,'seller-r9c','${args.dealState}',$2,42,1,50,1,$3,now(),$4)`,
    [dealId, `R9C race ${args.suffix}`, new Date(Date.now() + 30 * 60_000).toISOString(), args.completionWindowUntil ? args.completionWindowUntil.toISOString() : null]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,1,$4,$5,0,now())`,
    [participantId, dealId, `buyer-r9c-${args.suffix}`, args.buyer_state, args.money_state]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `seed-${args.suffix}`, `seed-${args.suffix}:${participantId}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: authorizationId, authorization_provider: "payrail-http" })]
  );
  const priorCorrelation = `capture:prior:n1:${participantId}`;
  if (args.priorAttempt) {
    await pool.query(
      `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [participantId, dealId, args.priorAttempt.attempt_type || "charge_start", args.priorAttempt.result_class, priorCorrelation]
    );
  }
  return { dealId, participantId, authorizationId, priorCorrelation };
}

async function insertEvent(eventType: string, aggregateType: "deal" | "participant", aggregateId: string, payload: Record<string, unknown>) {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'pending',0,now(),now(),now())`,
    [eventId, eventType, aggregateType, aggregateId, JSON.stringify(payload)]
  );
  return eventId;
}
const reconcilePayload = (s: { participantId: string; dealId: string; authorizationId: string }, correlation: string, reason: string) => ({
  participant_id: s.participantId, deal_id: s.dealId, attempt_type: "charge_start", correlation_id: correlation, operation: "capture", provider_reference: s.authorizationId, reason
});
async function participantState(participantId: string) {
  return (await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [participantId])).rows[0] as { buyer_state: string; money_state: string };
}
async function attempts(participantId: string, attemptType?: string) {
  return (await pool.query(
    `SELECT attempt_type, correlation_id, result_class, dispatch_state, owner_event_uuid, owner_lease_generation,
            siton.payment_operation_in_flight(owner_event_uuid, owner_lease_generation) AS in_flight
     FROM siton.payment_attempts WHERE participant_id=$1 AND ($2::text IS NULL OR attempt_type=$2) ORDER BY created_at ASC, correlation_id ASC`,
    [participantId, attemptType ?? null]
  )).rows as Array<{ attempt_type: string; correlation_id: string; result_class: string; dispatch_state: string; owner_event_uuid: string | null; owner_lease_generation: number | null; in_flight: boolean }>;
}
async function ledger(participantId: string) {
  return (await pool.query(`SELECT logical_entry_type FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at`, [participantId])).rows.map((r) => String(r.logical_entry_type));
}
async function pendingEvents(eventType: string, aggregateId: string) {
  return (await pool.query(`SELECT event_uuid FROM siton.outbox_events WHERE event_type=$1 AND aggregate_id=$2 AND status='pending' ORDER BY created_at`, [eventType, aggregateId])).rows.map((r) => String(r.event_uuid));
}
async function outboxRow(eventId: string) {
  return (await pool.query(`SELECT status, attempt_count, last_error, (available_at > now()) AS deferred FROM siton.outbox_events WHERE event_uuid=$1`, [eventId])).rows[0] as { status: string; attempt_count: number; last_error: string | null; deferred: boolean } | undefined;
}
async function cases(autoKeyPrefix: string) {
  return (await pool.query(`SELECT auto_key, subject, description FROM siton.operational_cases WHERE auto_key LIKE $1 ORDER BY created_at`, [`${autoKeyPrefix}%`])).rows as Array<{ auto_key: string; subject: string; description: string }>;
}
async function retryNow(eventId: string) {
  await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [eventId]);
}
const evidence: Record<string, unknown> = {};

try {
  await run("CASE 1 (Codex C1): capture in flight + reconcile on the same participant + late capture success → ONE provider effect, ZERO recovery calls, canonical ChargedSuccess", async () => {
    const s = await seed({ suffix: "race", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", priorAttempt: { result_class: "unknown" } });
    const chargeEvent = await insertEvent("charge_deal", "deal", s.dealId, { deal_id: s.dealId });
    const reconcileEvent = await insertEvent("payment_reconcile", "participant", s.participantId, reconcilePayload(s, s.priorCorrelation, "independent_race_proof"));

    // The charge worker resolves the prior UNKNOWN as "authorized/final", reuses
    // its identity, arms the dispatch and reaches the provider, which holds the
    // request immediately before applying the money side effect.
    const hold = holdFirstCapture(s.authorizationId);
    const chargeRun = processOutboxEventById(chargeEvent);
    await hold.entered;
    const inFlight = (await attempts(s.participantId, "charge_start"))[0]!;
    assert.equal(inFlight.correlation_id, s.priorCorrelation, "the SAME durable identity is reused");
    assert.equal(inFlight.dispatch_state, "dispatching");
    assert.equal(inFlight.in_flight, true, "the operation is IN_FLIGHT under the charge job's live lease");
    assert.equal(inFlight.owner_event_uuid, chargeEvent);
    assert.equal(ops("capture", s.authorizationId)[0]!.key, s.priorCorrelation, "provider saw the prior identity as idempotency key");

    // DB backstop (migration 063): nobody but the dispatching owner may declare a
    // negative outcome on an in-flight operation.
    await assert.rejects(
      pool.query(`UPDATE siton.payment_attempts SET result_class='permanent_fail' WHERE participant_id=$1 AND correlation_id=$2`, [s.participantId, s.priorCorrelation]),
      (error: any) => String(error?.code) === "SN409" && /payment_attempt_in_flight_negative_settle/.test(String(error?.message)),
      "DB guard must refuse a non-owner negative settle while the request may be in flight"
    );

    // CASE 9 — two reconcile workers race for the same job: exactly one claims it.
    const statusCallsBefore = ops("status").length;
    const [first, second] = await Promise.all([processOutboxEventById(reconcileEvent), processOutboxEventById(reconcileEvent)]);
    const claimed = [first, second].filter(Boolean);
    assert.equal(claimed.length, 1, "exactly one worker claims the reconcile job");
    const reconcileRun = claimed[0]!;
    assert.equal(reconcileRun.status, "failed", JSON.stringify(reconcileRun));
    assert.match(String(reconcileRun.error), /payment_reconcile_operation_in_flight/, "reconcile must DEFER while the exact operation is in flight");
    assert.equal(ops("status").length, statusCallsBefore, "no status read is taken while the operation is in flight (a read now could be stale on arrival)");
    const deferred = await outboxRow(reconcileEvent);
    assert.equal(deferred?.status, "pending");
    assert.equal(deferred?.deferred, true, "bounded outbox deferral, not a verdict");
    const duplicate = await pool.query(
      `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
       VALUES ('payment_reconcile','participant',$1,$2,'pending',0,now(),now(),now()) ON CONFLICT DO NOTHING RETURNING event_uuid`,
      [s.participantId, JSON.stringify(reconcilePayload(s, s.priorCorrelation, "duplicate_concurrent_reconcile"))]
    );
    assert.equal(duplicate.rowCount, 0, "a second pending reconcile job for the participant is refused");
    const stillWaiting = await participantState(s.participantId);
    assert.equal(stillWaiting.buyer_state, "ChargingAttempt");
    assert.equal(stillWaiting.money_state, "ChargeAttempt", "no charge_failed verdict was written while the capture was in flight");
    assert.equal((await pendingEvents("recovery_deal", s.dealId)).length, 0, "no recovery was scheduled");

    // The in-flight capture now completes at the provider.
    hold.release();
    const chargeOutcome = await chargeRun;
    assert.equal(chargeOutcome?.status, "sent", JSON.stringify(chargeOutcome));
    assert.equal(effectsOf(s.authorizationId), 1);
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess", "the late success applies canonically");
    assert.deepEqual(await ledger(s.participantId), ["charge"], "exactly one fee-ledger entry");
    const settled = (await attempts(s.participantId, "charge_start"))[0]!;
    assert.equal(settled.result_class, "success");
    assert.equal(settled.dispatch_state, "responded");

    // The deferred reconcile converges as a provider-free no-op.
    await retryNow(reconcileEvent);
    const retry = await processOutboxEventById(reconcileEvent);
    assert.equal(retry?.status, "sent", JSON.stringify(retry));
    assert.equal(ops("status").length, statusCallsBefore, "resolved participant → no status read");
    assert.equal((await pendingEvents("recovery_deal", s.dealId)).length, 0);
    assert.equal(ops("recover", s.authorizationId).length, 0, "CRITICAL invariant: zero recovery money calls");
    assert.equal(ops("capture", s.authorizationId).length, 1);
    assert.equal(effectsOf(s.authorizationId), 1, "ONE provider money effect for one obligation");
    assert.equal((await attempts(s.participantId)).length, 1, "one identity for the whole episode");
    evidence.case1 = { provider_calls: calls.filter((c) => c.auth === s.authorizationId), effects: effectsOf(s.authorizationId), participant: await participantState(s.participantId), attempts: await attempts(s.participantId), ledger: await ledger(s.participantId) };
  });

  await run("CASE 8: charge and reconcile start concurrently (reconcile carries a stale/foreign correlation) → one financial truth", async () => {
    const s = await seed({ suffix: "c8", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" });
    const chargeEvent = await insertEvent("charge_deal", "deal", s.dealId, { deal_id: s.dealId });
    const reconcileEvent = await insertEvent("payment_reconcile", "participant", s.participantId, reconcilePayload(s, "legacy-c8-correlation", "foreign_correlation_probe"));
    const hold = holdFirstCapture(s.authorizationId);
    const chargeRun = processOutboxEventById(chargeEvent);
    await hold.entered;
    const reconcileRun = await processOutboxEventById(reconcileEvent);
    assert.equal(reconcileRun?.status, "failed", JSON.stringify(reconcileRun));
    assert.match(String(reconcileRun?.error), /payment_reconcile_operation_in_flight/, "participant-wide in-flight guard: a foreign correlation cannot conclude anything either");
    assert.equal(ops("status", s.authorizationId).length, 0, "no status read while in flight");
    hold.release();
    assert.equal((await chargeRun)?.status, "sent");
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess");
    await retryNow(reconcileEvent);
    assert.equal((await processOutboxEventById(reconcileEvent))?.status, "sent");
    assert.equal(ops("status", s.authorizationId).length, 0);
    assert.equal(ops("recover", s.authorizationId).length, 0);
    assert.equal(effectsOf(s.authorizationId), 1);
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
  });

  await run("CASE 10: reconcile runs after provider success but BEFORE local persistence → deferred; one effect; canonical convergence", async () => {
    const s = await seed({ suffix: "c10", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" });
    const chargeEvent = await insertEvent("charge_deal", "deal", s.dealId, { deal_id: s.dealId });
    const barrier = armTestFault("payment.after_provider_io", { kind: "block" });
    const chargeRun = processOutboxEventById(chargeEvent);
    await barrier!.entered;
    assert.equal(effectsOf(s.authorizationId), 1, "provider executed");
    assert.equal((await participantState(s.participantId)).money_state, "ChargeAttempt", "nothing persisted locally yet");
    const minted = (await attempts(s.participantId, "charge_start"))[0]!;
    assert.equal(minted.dispatch_state, "dispatching");
    assert.equal(minted.in_flight, true);
    const reconcileEvent = await insertEvent("payment_reconcile", "participant", s.participantId, reconcilePayload(s, minted.correlation_id, "reconcile_before_local_persistence"));
    const reconcileRun = await processOutboxEventById(reconcileEvent);
    assert.equal(reconcileRun?.status, "failed", JSON.stringify(reconcileRun));
    assert.match(String(reconcileRun?.error), /payment_reconcile_operation_in_flight/);
    barrier!.release();
    assert.equal((await chargeRun)?.status, "sent");
    assert.equal((await participantState(s.participantId)).money_state, "ChargedSuccess");
    await retryNow(reconcileEvent);
    assert.equal((await processOutboxEventById(reconcileEvent))?.status, "sent");
    assert.equal(effectsOf(s.authorizationId), 1);
    assert.equal(ops("capture", s.authorizationId).length, 1);
    assert.equal(ops("recover", s.authorizationId).length, 0);
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
    assert.deepEqual((await attempts(s.participantId)).map((r) => r.result_class), ["success"]);
  });

  await run("CASE 11: recovery while the original capture is UNKNOWN → blocked (zero recovery money calls, visible case, reconcile scheduled); after not-executed resolution the recovery runs exactly once", async () => {
    const s = await seed({ suffix: "c11", dealState: "CompletionWindow", buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", completionWindowUntil: new Date(Date.now() + 20 * 60_000), priorAttempt: { result_class: "unknown" } });
    const recoveryEvent = await insertEvent("recovery_deal", "deal", s.dealId, { deal_id: s.dealId });
    const recoveryRun = await processOutboxEventById(recoveryEvent);
    assert.equal(recoveryRun?.status, "sent", JSON.stringify(recoveryRun));
    assert.equal(ops("recover", s.authorizationId).length, 0, "recovery must not execute while the capture is unresolved");
    assert.equal(effectsOf(s.authorizationId), 0);
    const blocked = await cases(`payment-operation-blocked:${s.participantId}:recovery`);
    assert.equal(blocked.length, 1, "FINANCIAL_OUTCOME_UNRESOLVED case opened");
    assert.match(blocked[0]!.subject, /FINANCIAL_OUTCOME_UNRESOLVED/);
    const reconcileIds = await pendingEvents("payment_reconcile", s.participantId);
    assert.equal(reconcileIds.length, 1, "the unresolved capture is handed to reconciliation");
    assert.deepEqual((await attempts(s.participantId, "recovery")), [], "no recovery identity was minted");

    // Authoritative status: the capture never executed → charge_failed is already
    // the local truth, the identity settles as permanent_fail, recovery unlocks.
    const reconciled = await processOutboxEventById(reconcileIds[0]!);
    assert.equal(reconciled?.status, "sent", JSON.stringify(reconciled));
    assert.deepEqual((await attempts(s.participantId, "charge_start")).map((r) => r.result_class), ["permanent_fail"]);
    assert.equal((await participantState(s.participantId)).money_state, "ChargeFailedRecovery");
    // The authoritative not-executed resolution re-arms the canonical recovery
    // exactly once (idempotent pending job); no second identity, no manual poke.
    const rearmed = await pendingEvents("recovery_deal", s.dealId);
    assert.equal(rearmed.length, 1, "reconcile re-armed recovery for the failed participant inside the completion window");
    assert.equal((await processOutboxEventById(rearmed[0]!))?.status, "sent");
    assert.equal(ops("recover", s.authorizationId).length, 1, "recovery executes once the capture is authoritatively resolved");
    assert.equal(effectsOf(s.authorizationId), 1, "ONE money effect for the obligation");
    assert.equal((await participantState(s.participantId)).money_state, "RecoveredCharge");
    assert.deepEqual(await ledger(s.participantId), ["charge"]);
    evidence.case11 = { provider_calls: calls.filter((c) => c.auth === s.authorizationId), effects: effectsOf(s.authorizationId), attempts: await attempts(s.participantId), cases: blocked.map((c) => c.auto_key) };
  });

  await run("CASE 11b: recovery while a capture is recorded as SUCCESS but the participant says charge failed → blocked permanently, case opened, DB backstop refuses a recovery identity", async () => {
    const s = await seed({ suffix: "c11b", dealState: "CompletionWindow", buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", completionWindowUntil: new Date(Date.now() + 20 * 60_000), priorAttempt: { result_class: "success" } });
    const recoveryEvent = await insertEvent("recovery_deal", "deal", s.dealId, { deal_id: s.dealId });
    assert.equal((await processOutboxEventById(recoveryEvent))?.status, "sent");
    assert.equal(ops("recover", s.authorizationId).length, 0, "money was already captured: recovery must never run");
    const blocked = await cases(`payment-operation-blocked:${s.participantId}:recovery`);
    assert.equal(blocked.length, 1);
    assert.match(blocked[0]!.description, /money was already captured/);
    assert.equal((await pendingEvents("payment_reconcile", s.participantId)).length, 0, "a succeeded capture needs an operator, not a status loop");
    await assert.rejects(
      pool.query(`INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id) VALUES ($1,$2,'recovery','unknown',$3)`, [s.participantId, s.dealId, `recovery:manual:n1:${s.participantId}`]),
      (error: any) => String(error?.code) === "SN409" && /recovery_blocked_by_unresolved_capture/.test(String(error?.message)),
      "DB eligibility guard must refuse a recovery identity behind an executed capture"
    );
    assert.equal((await participantState(s.participantId)).money_state, "ChargeFailedRecovery", "no state guessed");
  });

  evidence.all_provider_calls = calls;
  evidence.all_effects = Object.fromEntries(effects);
  console.log(`R9C_RACE_EVIDENCE ${JSON.stringify(evidence)}`);
  console.log(`PAYMENT_R9C_RECONCILIATION_RACE_VALIDATION passed=${passed}`);
} finally {
  for (const pending of holds.values()) pending.hold.release();
  resetTestFaults();
  await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
