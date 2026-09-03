// R9C — provider-operation identity under crash / stall / lease reclaim.
//
// Property under test (the money invariant this file exists for):
//   ONE durable provider-operation identity (the idempotency key sent to the
//   provider) exists BEFORE provider I/O and survives worker crash, retry,
//   lease expiry, reclaim by another worker, reconciliation and restart.
//   An UNKNOWN / un-persisted provider outcome must be reconciled BEFORE any
//   fresh financial operation is permitted. External money side effects must
//   never happen twice for one participant.
//
// Harness: the REAL worker handlers (processOutboxEventById → charge / recovery
// / refund / release rails) against a fake provider over HTTP
// (PAYMENT_PROVIDER_MODE=provider-ready) that records every call with its
// idempotency key and answers status lookups from what it actually executed.
// Test-only fault points (payment.before_provider_io / payment.after_provider_io /
// worker.before_ack) freeze Worker A at the exact window; the test then expires
// A's lease, reclaims the job as Worker B, and finally lets A resume.
//
// Scenarios:
//   S1  A: provider SUCCESS observed, crash/stall before local persistence →
//       lease expires → B reclaims → B must NOT capture again (status lookup
//       resolves the prior identity) → A resumes → fenced, no double effects
//   S2  A: stall BEFORE provider I/O → B reclaims → B reuses the SAME identity
//       (provider dedupes) → A resumes → fenced BEFORE its provider call
//   S3  SUCCESS_BUT_CLIENT_TIMEOUT (in-process UNKNOWN) → never re-captured;
//       the SAME identity is resolved by authoritative status
//   S4  post-dispatch 5xx (provider did NOT execute) → UNKNOWN on the SAME
//       identity (R9C C2: never a fresh capture identity, never a blind retry);
//       authoritative status resolves it as not executed → charge_failed →
//       canonical recovery (a distinct logical operation) → ONE money effect
//   S5  PERM_FAIL (402) → charge_failed, exactly one provider call, no retry
//   S6  crash AFTER local success, BEFORE job ACK → B reclaims → no provider
//       call at all (state already terminal), idempotent deal transition
//   S7  REFUND: provider success observed, crash before persistence → B must
//       not refund twice; exactly one refund ledger adjustment
//   S8  RELEASE: provider success observed, crash before persistence → B must
//       not release twice; AuthReleased exactly once
//   S9  RECOVERY: same crash window on the recovery rail → one recover call
//
// No real provider, no real money: the provider here is an in-process stub.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3097";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-r9c";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "r9c-provider-key";
process.env.PAYMENT_PROVIDER_AUTH_PATH = "/authorize";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_REFUND_PATH = "/refund";
process.env.PAYMENT_PROVIDER_RELEASE_PATH = "/release";
process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "1500";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "r9c-webhook-secret";
// Short lease so the background heartbeat cadence (lease/3) is quick; the test
// expires leases explicitly, it never waits for them.
process.env.WORKER_LEASE_MS = "6000";
process.env.OUTBOX_MAX_ATTEMPTS = "4";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const database = await pool.query(`SELECT current_database() AS name`);
assert.match(String(database.rows[0]?.name || ""), /^siton_test_/, "this proof may run only in a disposable isolated test database");

let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

type ProviderCall = { op: string; idempotency_key: string; reference: string; authorization_id: string; amount_minor: number | null };

// ── fake provider: remembers what it executed, answers status from that ────
function startProviderStub() {
  const calls: ProviderCall[] = [];
  const executed = new Map<string, { captured: boolean; refunded: boolean; released: boolean; recovered: boolean }>();
  const normalize = (ref: string) => String(ref || "").replace(/^(cap|rec|ref|rel)-/, "");
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const url = new URL(String(req.url), "http://stub");
      res.setHeader("content-type", "application/json");
      const auth = normalize(String(body.authorization_id || body.capture_reference || ""));
      const record = (op: string) => calls.push({
        op,
        idempotency_key: String(req.headers["idempotency-key"] || ""),
        reference: String(body.reference || ""),
        authorization_id: auth,
        amount_minor: Number.isInteger(body.amount_minor) ? Number(body.amount_minor) : null
      });
      const state = executed.get(auth) || { captured: false, refunded: false, released: false, recovered: false };

      if (url.pathname === "/capture" || url.pathname === "/recover") {
        const op = url.pathname === "/capture" ? "capture" : "recover";
        record(op);
        if (auth.includes("permfail")) {
          res.statusCode = 402;
          res.end(JSON.stringify({ status: "failed", error: "declined", provider_reference: `cap-${auth}`, reference: body.reference }));
          return;
        }
        if (op === "capture" && auth.includes("tempfail") && calls.filter((c) => c.op === op && c.authorization_id === auth).length === 1) {
          res.statusCode = 503;
          res.end(JSON.stringify({ status: "unavailable", error: "try_again", reference: body.reference }));
          return;
        }
        // the money moves NOW; whether the client ever sees the answer is a separate matter
        executed.set(auth, { ...state, captured: op === "capture" ? true : state.captured, recovered: op === "recover" ? true : state.recovered });
        if (auth.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 2_500)); // > PAYMENT_PROVIDER_TIMEOUT_MS
        res.statusCode = 200;
        res.end(JSON.stringify({
          status: op === "capture" ? "captured" : "recovered",
          [op === "capture" ? "capture_id" : "recovery_id"]: `${op === "capture" ? "cap" : "rec"}-${auth}`,
          provider_reference: `${op === "capture" ? "cap" : "rec"}-${auth}`,
          reference: body.reference
        }));
        return;
      }
      if (url.pathname === "/refund") {
        record("refund");
        executed.set(auth, { ...state, refunded: true });
        res.statusCode = 200;
        res.end(JSON.stringify({ status: "refunded", refund_id: `ref-${auth}`, provider_reference: `ref-${auth}`, reference: body.reference }));
        return;
      }
      if (url.pathname === "/release") {
        record("release");
        executed.set(auth, { ...state, released: true });
        res.statusCode = 200;
        res.end(JSON.stringify({ status: "released", provider_reference: `rel-${auth}`, reference: body.reference }));
        return;
      }
      if (url.pathname.startsWith("/status/")) {
        const ref = normalize(decodeURIComponent(url.pathname.slice("/status/".length)));
        const operation = url.searchParams.get("operation") || "capture";
        const known = executed.get(ref) || { captured: false, refunded: false, released: false, recovered: false };
        calls.push({ op: `status:${operation}`, idempotency_key: "", reference: ref, authorization_id: ref, amount_minor: null });
        let stateName = "authorized";
        if (operation === "refund") stateName = known.refunded ? "refunded" : "captured";
        else if (operation === "release") stateName = known.released ? "released" : "authorized";
        else stateName = known.captured || known.recovered ? "captured" : "authorized";
        res.statusCode = 200;
        res.end(JSON.stringify({ state: stateName, final: true, provider_reference: ref }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  return new Promise<{ calls: ProviderCall[]; baseUrl: string; close: () => Promise<void>; ops: (op: string, auth?: string) => ProviderCall[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("stub port");
      resolve({
        calls,
        baseUrl: `http://127.0.0.1:${address.port}`,
        ops: (op, auth) => calls.filter((c) => c.op === op && (!auth || c.authorization_id === auth)),
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())))
      });
    });
  });
}

const provider = await startProviderStub();
process.env.PAYMENT_PROVIDER_BASE_URL = provider.baseUrl;

const appModule = await import(`../src/app.js?r9c-identity-${Date.now()}`);
const { app, processOutboxEventById, reclaimWorkerJobs, closeWorkerDatabase } = appModule;
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");

// ── seeding helpers (mirrors charging_completion_window_validation) ────────
async function insertJoinAudit(participantId: string, dealId: string, authorizationId: string, suffix: string) {
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `seed:${suffix}`, `seed-join:${suffix}:${randomUUID()}`, JSON.stringify({
      authorization: "provider_authorized", authorization_id: authorizationId, authorization_provider: "payrail-http", authorization_correlation_id: `payauth-${suffix}`
    })]
  );
}

async function seedDeal(args: {
  suffix: string; dealState: string;
  participants: Array<{ qty: number; authorizationId: string; buyer_state: string; money_state: string }>;
  eventType: "charge_deal" | "recovery_deal" | "refund_issue" | "payment_release" | null;
  completionWindowUntil?: Date | null;
}) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
     VALUES ($1,'seller-r9c',$2,$3,42,10,50,9,$4, now(), $5)`,
    [dealId, args.dealState, `R9C ${args.suffix}`, new Date(Date.now() + 30 * 60_000).toISOString(), args.completionWindowUntil ? args.completionWindowUntil.toISOString() : null]
  );
  const participants: Array<{ participantId: string; authorizationId: string }> = [];
  for (const p of args.participants) {
    const participantId = randomUUID();
    await pool.query(
      `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,0, now())`,
      [participantId, dealId, `buyer-${args.suffix}-${p.authorizationId}`, p.qty, p.buyer_state, p.money_state]
    );
    await insertJoinAudit(participantId, dealId, p.authorizationId, `${args.suffix}-${p.authorizationId}`);
    participants.push({ participantId, authorizationId: p.authorizationId });
  }
  let outboxEventId: string | null = null;
  if (args.eventType) {
    outboxEventId = await insertEvent(args.eventType, dealId, participants[0]?.participantId || dealId);
  }
  return { dealId, outboxEventId: outboxEventId as string, participants };
}

async function insertEvent(eventType: string, dealId: string, participantId: string) {
  const eventId = randomUUID();
  const participantScoped = eventType === "payment_release" || eventType === "payment_reconcile";
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'pending',0, now(), now(), now())`,
    [eventId, eventType, participantScoped ? "participant" : "deal", participantScoped ? participantId : dealId,
      JSON.stringify(participantScoped ? { participant_id: participantId, deal_id: dealId, reason: "r9c" } : { deal_id: dealId })]
  );
  return eventId;
}

async function expireLease(eventId: string) {
  const r = await pool.query(`UPDATE siton.outbox_events SET lease_expires_at = now() - interval '1 second' WHERE event_uuid=$1 AND status='processing'`, [eventId]);
  assert.equal(r.rowCount, 1, "exactly one owned lease must be expired");
}

async function participantState(participantId: string) {
  const r = await pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [participantId]);
  return r.rows[0] as { buyer_state: string; money_state: string };
}
async function dealState(dealId: string) {
  return String((await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId])).rows[0]?.state);
}
async function attempts(participantId: string, attemptType: string) {
  const r = await pool.query(`SELECT correlation_id, result_class FROM siton.payment_attempts WHERE participant_id=$1 AND attempt_type=$2 ORDER BY created_at ASC`, [participantId, attemptType]);
  return r.rows as Array<{ correlation_id: string; result_class: string }>;
}
async function ledgerEntries(participantId: string) {
  const r = await pool.query(`SELECT event_type, logical_entry_type FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at ASC`, [participantId]);
  return r.rows as Array<{ event_type: string; logical_entry_type: string }>;
}
async function transitionsTo(participantId: string, stateType: string, toState: string) {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.audit_log WHERE entity_type='participant' AND entity_id=$1 AND state_type=$2 AND to_state=$3`, [participantId, stateType, toState]);
  return Number(r.rows[0].n);
}
async function eventStatus(eventId: string) {
  const r = await pool.query(`SELECT status, attempt_count FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]);
  return r.rows[0] as { status: string; attempt_count: number };
}
async function pendingEvents(eventType: string, aggregateId: string) {
  const r = await pool.query(`SELECT event_uuid FROM siton.outbox_events WHERE event_type=$1 AND aggregate_id=$2 AND status='pending' ORDER BY created_at ASC`, [eventType, aggregateId]);
  return r.rows.map((row) => String(row.event_uuid));
}

try {
  // ── S1 ────────────────────────────────────────────────────────────────
  await run("S1 CRITICAL window: provider SUCCESS observed, crash before persistence, lease reclaimed → NO second provider capture; A resumes fenced", async () => {
    const seed = await seedDeal({ suffix: "s1", dealState: "Charging", eventType: "charge_deal", participants: [{ qty: 2, authorizationId: "auth-s1", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
    const participantId = seed.participants[0]!.participantId;
    const barrier = armTestFault("payment.after_provider_io", { kind: "block" });
    assert.ok(barrier);
    const runA = processOutboxEventById(seed.outboxEventId);
    await barrier!.entered;
    assert.equal(provider.ops("capture", "auth-s1").length, 1, "A captured exactly once before stalling");
    const attemptsAfterA = await attempts(participantId, "charge_start");
    assert.equal(attemptsAfterA.length, 1);
    assert.equal(attemptsAfterA[0]!.result_class, "unknown", "durable pre-I/O identity is UNKNOWN while A is stalled");
    assert.equal((await participantState(participantId)).money_state, "ChargeAttempt", "nothing persisted locally yet");

    await expireLease(seed.outboxEventId);
    const reclaimed = await reclaimWorkerJobs(1);
    assert.ok(reclaimed.outbox >= 1, "expired lease reclaimed");
    assert.equal((await eventStatus(seed.outboxEventId)).status, "pending");

    const runB = await processOutboxEventById(seed.outboxEventId);
    assert.equal(runB?.status, "sent", `B must complete the job: ${JSON.stringify(runB)}`);
    assert.equal(provider.ops("capture", "auth-s1").length, 1, "CRITICAL: B must NOT send a second capture for a participant whose prior attempt is unresolved");
    assert.equal((await participantState(participantId)).money_state, "ChargedSuccess", "B resolved the prior identity via authoritative status lookup");
    assert.ok(provider.ops("status:capture", "auth-s1").length >= 1, "B consulted provider status before any fresh operation");

    barrier!.release();
    const resultA = await runA;
    assert.equal(resultA?.status, "lease_lost", `stale worker must not ACK: ${JSON.stringify(resultA)}`);

    assert.equal(provider.ops("capture", "auth-s1").length, 1, "A's resumption produced no provider call");
    const finalAttempts = await attempts(participantId, "charge_start");
    assert.equal(finalAttempts.length, 1, "ONE provider-operation identity for the whole episode");
    assert.equal(finalAttempts[0]!.result_class, "success");
    assert.deepEqual((await ledgerEntries(participantId)).map((e) => e.logical_entry_type), ["charge"], "exactly one fee-ledger charge entry (8% base recorded once)");
    assert.equal(await transitionsTo(participantId, "money_state", "ChargedSuccess"), 1, "money state reached ChargedSuccess exactly once");
    assert.equal(await dealState(seed.dealId), "CompletionWindow");
    assert.equal((await eventStatus(seed.outboxEventId)).status, "sent");
  });

  // ── S2 ────────────────────────────────────────────────────────────────
  await run("S2 stall BEFORE provider I/O, lease reclaimed → B reuses the SAME identity (one key), A resumes and is fenced before its provider call", async () => {
    const seed = await seedDeal({ suffix: "s2", dealState: "Charging", eventType: "charge_deal", participants: [{ qty: 1, authorizationId: "auth-s2", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
    const participantId = seed.participants[0]!.participantId;
    const barrier = armTestFault("payment.before_provider_io", { kind: "block" });
    const runA = processOutboxEventById(seed.outboxEventId);
    await barrier!.entered;
    assert.equal(provider.ops("capture", "auth-s2").length, 0, "A has not called the provider yet");
    const identityA = (await attempts(participantId, "charge_start"))[0]!.correlation_id;

    await expireLease(seed.outboxEventId);
    await reclaimWorkerJobs(1);
    const runB = await processOutboxEventById(seed.outboxEventId);
    assert.equal(runB?.status, "sent", JSON.stringify(runB));
    const capturesB = provider.ops("capture", "auth-s2");
    assert.equal(capturesB.length, 1, "B performed the single capture");
    assert.equal(capturesB[0]!.idempotency_key, identityA, "B reused A's durable identity as the provider idempotency key (provider-side dedupe if A's request ever lands)");
    assert.equal((await participantState(participantId)).money_state, "ChargedSuccess");

    barrier!.release();
    const resultA = await runA;
    assert.equal(resultA?.status, "lease_lost", JSON.stringify(resultA));
    assert.equal(provider.ops("capture", "auth-s2").length, 1, "A was fenced BEFORE its provider call: still exactly one capture");
    const finalAttempts = await attempts(participantId, "charge_start");
    assert.equal(finalAttempts.length, 1, "one identity, no fresh row minted by the reclaim");
    assert.equal(finalAttempts[0]!.result_class, "success");
    assert.equal((await ledgerEntries(participantId)).length, 1);
  });

  // ── S2b ───────────────────────────────────────────────────────────────
  await run("S2b stall right after claim (handler not started), lease reclaimed, B completes → A resumes with ZERO provider calls and no ACK", async () => {
    const seed = await seedDeal({ suffix: "s2b", dealState: "Charging", eventType: "charge_deal", participants: [{ qty: 1, authorizationId: "auth-s2b", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
    const participantId = seed.participants[0]!.participantId;
    const barrier = armTestFault("worker.after_claim", { kind: "block" });
    const runA = processOutboxEventById(seed.outboxEventId);
    await barrier!.entered;
    await expireLease(seed.outboxEventId);
    await reclaimWorkerJobs(1);
    const runB = await processOutboxEventById(seed.outboxEventId);
    assert.equal(runB?.status, "sent", JSON.stringify(runB));
    assert.equal(provider.ops("capture", "auth-s2b").length, 1);
    barrier!.release();
    const resultA = await runA;
    assert.equal(resultA?.status, "lease_lost", JSON.stringify(resultA));
    assert.equal(provider.ops("capture", "auth-s2b").length, 1, "stale worker made no provider call");
    assert.equal((await participantState(participantId)).money_state, "ChargedSuccess");
    assert.equal((await attempts(participantId, "charge_start")).length, 1);
    assert.equal((await ledgerEntries(participantId)).length, 1);
  });

  // ── S3 ────────────────────────────────────────────────────────────────
  await run("S3 SUCCESS_BUT_CLIENT_TIMEOUT (UNKNOWN) → the job completes without a blind retry, the SAME identity is resolved by authoritative status, exactly ONE capture", async () => {
    const seed = await seedDeal({ suffix: "s3", dealState: "Charging", eventType: "charge_deal", participants: [
      { qty: 1, authorizationId: "auth-slow-s3", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }
    ] });
    const slow = seed.participants[0]!.participantId;
    const first = await processOutboxEventById(seed.outboxEventId);
    assert.equal(first?.status, "sent", JSON.stringify(first)); // UNKNOWN never fails the job into a retry
    assert.equal(provider.ops("capture", "auth-slow-s3").length, 1, "the slow participant was captured at the provider once");
    const afterFirst = await attempts(slow, "charge_start");
    assert.equal(afterFirst.length, 1, "one identity");
    assert.equal(afterFirst[0]!.result_class, "unknown", "transport loss after dispatch is durable UNKNOWN");
    assert.equal((await participantState(slow)).money_state, "ChargeAttempt", "no local truth yet");
    assert.equal((await pendingEvents("payment_reconcile", slow)).length, 1, "reconcile rail scheduled for the UNKNOWN attempt");
    assert.equal(await dealState(seed.dealId), "CompletionWindow");

    const reconcileId = (await pendingEvents("payment_reconcile", slow))[0]!;
    const reconciled = await processOutboxEventById(reconcileId);
    assert.equal(reconciled?.status, "sent", JSON.stringify(reconciled));
    assert.equal(provider.ops("capture", "auth-slow-s3").length, 1, "UNKNOWN must never become a fresh capture");
    assert.equal((await participantState(slow)).money_state, "ChargedSuccess", "resolved through the authoritative status lookup, not a new charge");
    assert.equal((await ledgerEntries(slow)).length, 1, "one ledger charge entry");
    assert.equal(await transitionsTo(slow, "money_state", "ChargedSuccess"), 1);
    const finalAttempts = await attempts(slow, "charge_start");
    assert.equal(finalAttempts.length, 1, "one identity for the UNKNOWN participant");
    assert.equal(finalAttempts[0]!.result_class, "success");
  });

  // ── S4 ────────────────────────────────────────────────────────────────
  await run("S4 post-dispatch 5xx (provider did NOT execute) → UNKNOWN on the SAME identity, no fresh capture identity; status resolves not-executed → charge_failed → canonical recovery → ONE money effect", async () => {
    const seed = await seedDeal({ suffix: "s4", dealState: "Charging", eventType: "charge_deal", participants: [{ qty: 1, authorizationId: "auth-tempfail-s4", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
    const participantId = seed.participants[0]!.participantId;
    const first = await processOutboxEventById(seed.outboxEventId);
    assert.equal(first?.status, "sent", JSON.stringify(first));
    assert.equal(provider.ops("capture", "auth-tempfail-s4").length, 1);
    const afterFirst = await attempts(participantId, "charge_start");
    assert.equal(afterFirst.length, 1, "R9C C2: a 5xx after dispatch never mints a second capture identity");
    assert.equal(afterFirst[0]!.result_class, "unknown", "5xx after dispatch is UNKNOWN, not temporary_fail");
    assert.equal((await participantState(participantId)).money_state, "ChargeAttempt");
    const reconcileId = (await pendingEvents("payment_reconcile", participantId))[0];
    assert.ok(reconcileId, "UNKNOWN schedules reconciliation");
    const reconciled = await processOutboxEventById(reconcileId!);
    assert.equal(reconciled?.status, "sent", JSON.stringify(reconciled));
    assert.equal(provider.ops("capture", "auth-tempfail-s4").length, 1, "reconciliation never re-captures");
    assert.deepEqual((await attempts(participantId, "charge_start")).map((r) => r.result_class), ["permanent_fail"], "authoritative not-executed settles the SAME identity");
    assert.equal((await participantState(participantId)).money_state, "ChargeFailedRecovery", "not-executed → charge_failed (canonical), recovery becomes eligible");
    const recoveryId = (await pendingEvents("recovery_deal", seed.dealId))[0];
    assert.ok(recoveryId, "late charge failure gets its recovery chance inside the completion window");
    const recovered = await processOutboxEventById(recoveryId!);
    assert.equal(recovered?.status, "sent", JSON.stringify(recovered));
    assert.equal(provider.ops("recover", "auth-tempfail-s4").length, 1, "recovery is a distinct logical operation");
    assert.equal(provider.ops("capture", "auth-tempfail-s4").length, 1);
    assert.equal((await participantState(participantId)).money_state, "RecoveredCharge");
    assert.equal((await ledgerEntries(participantId)).length, 1, "exactly one money effect recorded for the whole episode");
    assert.deepEqual((await attempts(participantId, "recovery")).map((r) => r.result_class), ["success"]);
  });

  // ── S5 ────────────────────────────────────────────────────────────────
  await run("S5 PERM_FAIL (402) → charge_failed, exactly one provider call, no retry", async () => {
    const seed = await seedDeal({ suffix: "s5", dealState: "Charging", eventType: "charge_deal", participants: [{ qty: 1, authorizationId: "auth-permfail-s5", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
    const participantId = seed.participants[0]!.participantId;
    const result = await processOutboxEventById(seed.outboxEventId);
    assert.equal(result?.status, "sent", JSON.stringify(result));
    assert.equal(provider.ops("capture", "auth-permfail-s5").length, 1);
    const state = await participantState(participantId);
    assert.equal(state.money_state, "ChargeFailedRecovery");
    assert.equal(state.buyer_state, "ChargeFailedCompletion");
    assert.equal((await attempts(participantId, "charge_start"))[0]!.result_class, "permanent_fail");
    assert.equal((await ledgerEntries(participantId)).length, 0);
  });

  // ── S6 ────────────────────────────────────────────────────────────────
  await run("S6 crash AFTER local success BEFORE job ACK → reclaim → zero provider calls, idempotent deal transition, single ledger entry", async () => {
    const seed = await seedDeal({ suffix: "s6", dealState: "Charging", eventType: "charge_deal", participants: [{ qty: 1, authorizationId: "auth-s6", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt" }] });
    const participantId = seed.participants[0]!.participantId;
    const barrier = armTestFault("worker.before_ack", { kind: "block" });
    const runA = processOutboxEventById(seed.outboxEventId);
    await barrier!.entered;
    assert.equal((await participantState(participantId)).money_state, "ChargedSuccess", "local truth persisted before the ACK window");
    assert.equal(await dealState(seed.dealId), "CompletionWindow");
    await expireLease(seed.outboxEventId);
    await reclaimWorkerJobs(1);
    const runB = await processOutboxEventById(seed.outboxEventId);
    assert.equal(runB?.status, "sent", JSON.stringify(runB));
    assert.equal(provider.ops("capture", "auth-s6").length, 1, "terminal participant is skipped: no provider call on reclaim");
    barrier!.release();
    const resultA = await runA;
    assert.equal(resultA?.status, "lease_lost");
    assert.equal((await ledgerEntries(participantId)).length, 1);
    assert.equal(await transitionsTo(participantId, "money_state", "ChargedSuccess"), 1);
    const dealTransitions = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.audit_log WHERE entity_type='deal' AND entity_id=$1 AND to_state='CompletionWindow'`, [seed.dealId]);
    assert.equal(Number(dealTransitions.rows[0].n), 1, "deal → CompletionWindow exactly once");
    assert.equal((await pendingEvents("finalize_deal", seed.dealId)).length, 1, "finalize scheduled exactly once");
  });

  // ── S7 refund ─────────────────────────────────────────────────────────
  await run("S7 REFUND crash window: provider refund SUCCESS observed, crash before persistence → reclaim → NO second refund; one ledger adjustment", async () => {
    const seed = await seedDeal({ suffix: "s7", dealState: "Failed", eventType: "refund_issue", participants: [{ qty: 1, authorizationId: "auth-s7", buyer_state: "DealFailed", money_state: "ChargedSuccess" }] });
    const participantId = seed.participants[0]!.participantId;
    const barrier = armTestFault("payment.after_provider_io", { kind: "block" });
    const runA = processOutboxEventById(seed.outboxEventId);
    await barrier!.entered;
    assert.equal(provider.ops("refund", "auth-s7").length, 1);
    await expireLease(seed.outboxEventId);
    await reclaimWorkerJobs(1);
    const runB = await processOutboxEventById(seed.outboxEventId);
    assert.equal(runB?.status, "sent", JSON.stringify(runB));
    assert.equal(provider.ops("refund", "auth-s7").length, 1, "CRITICAL: no second refund for an unresolved prior refund attempt");
    assert.equal((await participantState(participantId)).money_state, "Refunded");
    barrier!.release();
    assert.equal((await runA)?.status, "lease_lost");
    assert.equal(provider.ops("refund", "auth-s7").length, 1);
    const refundEntries = (await ledgerEntries(participantId)).filter((e) => e.logical_entry_type === "refund_adjustment");
    assert.equal(refundEntries.length, 1, "exactly one refund ledger adjustment");
    assert.equal(await transitionsTo(participantId, "money_state", "Refunded"), 1);
    assert.equal((await attempts(participantId, "refund")).length, 1, "one refund identity");
  });

  // ── S8 release ────────────────────────────────────────────────────────
  await run("S8 RELEASE crash window: provider release SUCCESS observed, crash before persistence → reclaim → NO second release; AuthReleased once", async () => {
    const seed = await seedDeal({ suffix: "s8", dealState: "Failed", eventType: "payment_release", participants: [{ qty: 1, authorizationId: "auth-s8", buyer_state: "DealFailed", money_state: "AuthHeld" }] });
    const participantId = seed.participants[0]!.participantId;
    const barrier = armTestFault("payment.after_provider_io", { kind: "block" });
    const runA = processOutboxEventById(seed.outboxEventId);
    await barrier!.entered;
    assert.equal(provider.ops("release", "auth-s8").length, 1);
    await expireLease(seed.outboxEventId);
    await reclaimWorkerJobs(1);
    const runB = await processOutboxEventById(seed.outboxEventId);
    assert.equal(runB?.status, "sent", JSON.stringify(runB));
    assert.equal(provider.ops("release", "auth-s8").length, 1, "no second release for an unresolved prior release attempt");
    assert.equal((await participantState(participantId)).money_state, "AuthReleased");
    barrier!.release();
    assert.equal((await runA)?.status, "lease_lost");
    assert.equal(provider.ops("release", "auth-s8").length, 1);
    assert.equal(await transitionsTo(participantId, "money_state", "AuthReleased"), 1);
    assert.equal((await attempts(participantId, "release")).length, 1);
  });

  // ── S9 recovery ───────────────────────────────────────────────────────
  await run("S9 RECOVERY crash window: provider recover SUCCESS observed, crash before persistence → reclaim → NO second recover", async () => {
    const seed = await seedDeal({ suffix: "s9", dealState: "CompletionWindow", eventType: "recovery_deal", completionWindowUntil: new Date(Date.now() + 20 * 60_000),
      participants: [{ qty: 1, authorizationId: "auth-s9", buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery" }] });
    const participantId = seed.participants[0]!.participantId;
    const barrier = armTestFault("payment.after_provider_io", { kind: "block" });
    const runA = processOutboxEventById(seed.outboxEventId);
    await barrier!.entered;
    assert.equal(provider.ops("recover", "auth-s9").length, 1);
    await expireLease(seed.outboxEventId);
    await reclaimWorkerJobs(1);
    const runB = await processOutboxEventById(seed.outboxEventId);
    assert.equal(runB?.status, "sent", JSON.stringify(runB));
    assert.equal(provider.ops("recover", "auth-s9").length, 1, "no second recovery capture");
    assert.equal((await participantState(participantId)).money_state, "RecoveredCharge");
    barrier!.release();
    assert.equal((await runA)?.status, "lease_lost");
    assert.equal(provider.ops("recover", "auth-s9").length, 1);
    assert.equal((await ledgerEntries(participantId)).length, 1);
    assert.equal(await transitionsTo(participantId, "money_state", "RecoveredCharge"), 1);
  });

  console.log(`PAYMENT_PROVIDER_OPERATION_IDENTITY_CRASH_VALIDATION passed=${passed}`);
} finally {
  resetTestFaults();
  await provider.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
