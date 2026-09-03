// R9C — money state + fee-ledger atomicity under failure injection.
//
// Invariant: authoritative money truth (participant money_state ChargedSuccess
// / RecoveredCharge / Refunded) must never exist without its required
// platform-fee ledger truth (siton.platform_fee_money_events). Either both are
// committed or neither is; a failure between them must be recoverable by the
// worker's own retry path without a second provider call.
//
//   L1  charge_captured: failure AFTER the state transition, BEFORE the ledger
//       write → must not leave ChargedSuccess with zero ledger entries; the
//       retried job must converge to exactly one ledger entry and ONE capture
//   L2  refund_issued: same window on the refund rail → never Refunded without
//       the signed refund adjustment; retry converges with ONE refund call
//
// Provider: in-process stub over HTTP. No real money.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3099";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-r9c-ledger";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "r9c-provider-key";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "1500";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "r9c-ledger-webhook-secret";
process.env.OUTBOX_MAX_ATTEMPTS = "4";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
assert.match(String((await pool.query(`SELECT current_database() AS name`)).rows[0]?.name || ""), /^siton_test_/, "isolated test database only");

let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

function startStub() {
  const calls: Array<{ op: string; auth: string }> = [];
  const executed = new Map<string, { captured: boolean; refunded: boolean }>();
  const normalize = (ref: string) => String(ref || "").replace(/^(cap|ref)-/, "");
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const url = new URL(String(req.url), "http://stub");
      const auth = normalize(String(body.authorization_id || body.capture_reference || ""));
      const state = executed.get(auth) || { captured: false, refunded: false };
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      if (url.pathname === "/capture" || url.pathname === "/recover") {
        const op = url.pathname === "/capture" ? "capture" : "recover";
        calls.push({ op, auth });
        executed.set(auth, { ...state, captured: true });
        res.end(JSON.stringify({ status: op === "capture" ? "captured" : "recovered", capture_id: `cap-${auth}`, provider_reference: `cap-${auth}`, reference: body.reference }));
        return;
      }
      if (url.pathname === "/refund") {
        calls.push({ op: "refund", auth });
        executed.set(auth, { ...state, refunded: true });
        res.end(JSON.stringify({ status: "refunded", refund_id: `ref-${auth}`, provider_reference: `ref-${auth}`, reference: body.reference }));
        return;
      }
      if (url.pathname.startsWith("/status/")) {
        const ref = normalize(decodeURIComponent(url.pathname.slice("/status/".length)));
        const operation = url.searchParams.get("operation") || "capture";
        const known = executed.get(ref) || { captured: false, refunded: false };
        calls.push({ op: `status:${operation}`, auth: ref });
        const stateName = operation === "refund" ? (known.refunded ? "refunded" : "captured") : (known.captured ? "captured" : "authorized");
        res.end(JSON.stringify({ state: stateName, final: true, provider_reference: ref }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  return new Promise<{ calls: typeof calls; baseUrl: string; ops: (op: string, auth: string) => number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("stub port");
      resolve({ calls, baseUrl: `http://127.0.0.1:${address.port}`, ops: (op, auth) => calls.filter((c) => c.op === op && c.auth === auth).length, close: () => new Promise<void>((d, f) => server.close((e) => (e ? f(e) : d()))) });
    });
  });
}
const stub = await startStub();
process.env.PAYMENT_PROVIDER_BASE_URL = stub.baseUrl;

const { app, processOutboxEventById, closeWorkerDatabase } = await import(`../src/app.js?r9c-ledger-${Date.now()}`);
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");

async function seed(args: { suffix: string; dealState: string; buyer_state: string; money_state: string; eventType: "charge_deal" | "recovery_deal" | "refund_issue" }) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
     VALUES ($1,'seller-r9c',$2,$3,42,10,50,9,$4, now(), $5)`,
    [dealId, args.dealState, `R9C ledger ${args.suffix}`, new Date(Date.now() + 30 * 60_000).toISOString(), args.eventType === "recovery_deal" ? new Date(Date.now() + 20 * 60_000).toISOString() : null]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,2,$4,$5,0, now())`,
    [participantId, dealId, `buyer-${args.suffix}`, args.buyer_state, args.money_state]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `seed:${args.suffix}`, `seed-join:${args.suffix}:${randomUUID()}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: `auth-${args.suffix}`, authorization_provider: "payrail-http" })]
  );
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,$2,'deal',$3,$4,'pending',0, now(), now(), now())`,
    [eventId, args.eventType, dealId, JSON.stringify({ deal_id: dealId })]
  );
  return { dealId, participantId, eventId };
}

async function truth(participantId: string) {
  const [p, ledger] = await Promise.all([
    pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [participantId]),
    pool.query(`SELECT logical_entry_type FROM siton.platform_fee_money_events WHERE participant_id=$1 ORDER BY created_at ASC`, [participantId])
  ]);
  return { money_state: String(p.rows[0]?.money_state), ledger: ledger.rows.map((r) => String(r.logical_entry_type)) };
}

try {
  await run("L1 charge: failure after the state transition and before the ledger write never leaves ChargedSuccess without ledger truth; retry converges with ONE capture", async () => {
    const s = await seed({ suffix: "l1", dealState: "Charging", buyer_state: "ChargingAttempt", money_state: "ChargeAttempt", eventType: "charge_deal" });
    armTestFault("payment.after_state_before_ledger", { kind: "throw", code: "ledger_write_lost" });
    const faulted = await processOutboxEventById(s.eventId);
    assert.equal(faulted?.status, "failed", JSON.stringify(faulted));
    assert.equal(stub.ops("capture", "auth-l1"), 1);
    const afterFault = await truth(s.participantId);
    assert.deepEqual(afterFault, { money_state: "ChargeAttempt", ledger: [] }, "the thrown ledger boundary must abort the state transition too");

    await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [s.eventId]);
    const retried = await processOutboxEventById(s.eventId);
    assert.equal(retried?.status, "sent", JSON.stringify(retried));
    const final = await truth(s.participantId);
    assert.equal(final.money_state, "ChargedSuccess");
    assert.deepEqual(final.ledger, ["charge"], "exactly one fee-ledger charge entry after recovery");
    assert.equal(stub.ops("capture", "auth-l1"), 1, "recovery never re-captures");
  });

  await run("L2 refund: failure after Refunded transition and before the ledger adjustment never leaves Refunded without the signed reversal; retry converges with ONE refund", async () => {
    const s = await seed({ suffix: "l2", dealState: "Failed", buyer_state: "DealFailed", money_state: "ChargedSuccess", eventType: "refund_issue" });
    armTestFault("payment.after_state_before_ledger", { kind: "throw", code: "ledger_write_lost" });
    const faulted = await processOutboxEventById(s.eventId);
    assert.equal(faulted?.status, "failed", JSON.stringify(faulted));
    assert.equal(stub.ops("refund", "auth-l2"), 1);
    const afterFault = await truth(s.participantId);
    assert.deepEqual(afterFault, { money_state: "ChargedSuccess", ledger: [] }, "the thrown refund-ledger boundary must abort Refunded too");

    await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [s.eventId]);
    const retried = await processOutboxEventById(s.eventId);
    assert.equal(retried?.status, "sent", JSON.stringify(retried));
    const final = await truth(s.participantId);
    assert.equal(final.money_state, "Refunded");
    assert.equal(final.ledger.filter((e) => e === "refund_adjustment").length, 1, "exactly one signed refund adjustment");
    assert.equal(stub.ops("refund", "auth-l2"), 1, "recovery never re-refunds");
  });

  await run("L3 recovery: failure after RecoveredCharge transition and before ledger write aborts both; retry converges with ONE recovery and one ledger row", async () => {
    const s = await seed({ suffix: "l3", dealState: "CompletionWindow", buyer_state: "ChargeFailedCompletion", money_state: "ChargeFailedRecovery", eventType: "recovery_deal" });
    armTestFault("payment.after_state_before_ledger", { kind: "throw", code: "ledger_write_lost" });
    const faulted = await processOutboxEventById(s.eventId);
    assert.equal(faulted?.status, "failed", JSON.stringify(faulted));
    assert.equal(stub.ops("recover", "auth-l3"), 1);
    assert.deepEqual(await truth(s.participantId), { money_state: "ChargeFailedRecovery", ledger: [] }, "transaction rollback must erase both the state write and ledger write");

    await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [s.eventId]);
    const retried = await processOutboxEventById(s.eventId);
    assert.equal(retried?.status, "sent", JSON.stringify(retried));
    assert.deepEqual(await truth(s.participantId), { money_state: "RecoveredCharge", ledger: ["charge"] });
    assert.equal(stub.ops("recover", "auth-l3"), 1, "recovery retry resolves provider status and does not move money twice");

    const duplicateId = randomUUID();
    await pool.query(
      `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
       VALUES ($1,'recovery_deal','deal',$2,$3,'pending',0,now(),now(),now())`,
      [duplicateId, s.dealId, JSON.stringify({ deal_id: s.dealId })]
    );
    assert.equal((await processOutboxEventById(duplicateId))?.status, "sent");
    assert.deepEqual(await truth(s.participantId), { money_state: "RecoveredCharge", ledger: ["charge"] }, "duplicate event cannot duplicate ledger truth");
    assert.equal(stub.ops("recover", "auth-l3"), 1);
  });

  console.log(`PAYMENT_STATE_LEDGER_ATOMICITY_VALIDATION passed=${passed}`);
} finally {
  resetTestFaults();
  await stub.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
