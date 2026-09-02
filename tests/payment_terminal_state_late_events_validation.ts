// R9C — terminal-state safety against late / out-of-order money events.
//
// Terminal truth (Completed / Failed / Refunded / Released) must not be mutated
// by late worker events, provider webhooks, reconciliation or release jobs.
// Every late event below must be IGNORED (or a no-op job) with ZERO state,
// audit, ledger or provider side effects.
//
//   T1  Completed deal, participant DealCompleted/ChargedSuccess: late
//       charge_captured (new id) / charge_failed / refund-less recovery events
//   T2  Refunded participant on a Failed deal: late refund_issued (new id),
//       late charge_captured, exact duplicate delivery of an already-processed id
//   T3  Failed deal, participant DealFailed/AuthReleased: late charge_captured,
//       late payment_release job, late payment_reconcile job (no provider call)
//   T4  Recovered participant: late recovery_captured / recovery_failed
//   T5  a payment_reconcile job for a Refunded participant is a no-op
//
// Provider: in-process stub over HTTP; every call is counted. No real money.

import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3098";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-r9c-terminal";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "r9c-provider-key";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "1500";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
const WEBHOOK_SECRET = "r9c-terminal-webhook-secret";
process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
assert.match(String((await pool.query(`SELECT current_database() AS name`)).rows[0]?.name || ""), /^siton_test_/, "isolated test database only");

let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

function startStub() {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      calls.push(String(req.url));
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ state: "captured", final: true, status: "captured", provider_reference: "late" }));
    });
  });
  return new Promise<{ calls: string[]; baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("stub port");
      resolve({ calls, baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((d, f) => server.close((e) => (e ? f(e) : d()))) });
    });
  });
}
const stub = await startStub();
process.env.PAYMENT_PROVIDER_BASE_URL = stub.baseUrl;

const { app, processOutboxEventById, closeWorkerDatabase } = await import(`../src/app.js?r9c-terminal-${Date.now()}`);

function sign(body: Record<string, unknown>) {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(JSON.stringify(body)).digest("hex")}`;
}
async function webhook(body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/webhooks/payments", headers: { "x-webhook-signature": sign(body) }, payload: body });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { status?: string; duplicate?: boolean; reason?: string };
}

async function seed(args: { suffix: string; dealState: string; buyer_state: string; money_state: string; completionWindowUntil?: Date | null }) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at, completion_window_until)
     VALUES ($1,'seller-r9c',$2,$3,42,10,50,9,$4, now(), $5)`,
    [dealId, args.dealState, `R9C terminal ${args.suffix}`, new Date(Date.now() + 30 * 60_000).toISOString(), args.completionWindowUntil ? args.completionWindowUntil.toISOString() : null]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,1,$4,$5,0, now())`,
    [participantId, dealId, `buyer-${args.suffix}`, args.buyer_state, args.money_state]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `seed:${args.suffix}`, `seed-join:${args.suffix}:${randomUUID()}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: `auth-${args.suffix}`, authorization_provider: "payrail-http" })]
  );
  return { dealId, participantId };
}

async function snapshot(participantId: string, dealId: string) {
  const [p, d, audit, ledger, webhooks] = await Promise.all([
    pool.query(`SELECT buyer_state, money_state FROM siton.participants WHERE participant_id=$1`, [participantId]),
    pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM siton.audit_log WHERE entity_id::text IN ($1::text, $2::text)`, [participantId, dealId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM siton.platform_fee_money_events WHERE participant_id=$1`, [participantId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM siton.webhook_events WHERE participant_id=$1 AND status='processed'`, [participantId])
  ]);
  return {
    buyer_state: String(p.rows[0]?.buyer_state), money_state: String(p.rows[0]?.money_state), deal_state: String(d.rows[0]?.state),
    audit: Number(audit.rows[0].n), ledger: Number(ledger.rows[0].n), processed_webhooks: Number(webhooks.rows[0].n)
  };
}

async function insertJob(eventType: string, dealId: string, participantId: string, payload: Record<string, unknown>) {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,$2,'participant',$3,$4,'pending',0, now(), now(), now())`,
    [eventId, eventType, participantId, JSON.stringify({ participant_id: participantId, deal_id: dealId, ...payload })]
  );
  return eventId;
}

function lateEvent(eventType: string, participantId: string, dealId: string, suffix: string) {
  return { provider: "payrail-http", event_id: `late-${eventType}-${suffix}-${randomUUID()}`, event_type: eventType, correlation_id: `late:${suffix}`, participant_id: participantId, deal_id: dealId, provider_reference: `cap-auth-${suffix}`, payload: { provider_reference: `cap-auth-${suffix}` } };
}

try {
  await run("T1 Completed deal: late charge_captured / charge_failed / recovery events are ignored with zero state, audit or ledger effect", async () => {
    const s = await seed({ suffix: "t1", dealState: "Completed", buyer_state: "DealCompleted", money_state: "ChargedSuccess" });
    const before = await snapshot(s.participantId, s.dealId);
    for (const type of ["charge_captured", "charge_failed", "recovery_captured", "recovery_failed"]) {
      const result = await webhook(lateEvent(type, s.participantId, s.dealId, "t1"));
      assert.equal(result.status, "ignored", `${type}: ${JSON.stringify(result)}`);
    }
    const after = await snapshot(s.participantId, s.dealId);
    assert.deepEqual(after, before, "terminal truth untouched");
  });

  await run("T2 Refunded participant: late refund_issued (new id) and charge_captured ignored; exact duplicate id is a duplicate, never reprocessed", async () => {
    const s = await seed({ suffix: "t2", dealState: "Failed", buyer_state: "DealFailed", money_state: "Refunded" });
    const before = await snapshot(s.participantId, s.dealId);
    const refundAgain = lateEvent("refund_issued", s.participantId, s.dealId, "t2");
    assert.equal((await webhook(refundAgain)).status, "ignored");
    assert.equal((await webhook(lateEvent("charge_captured", s.participantId, s.dealId, "t2"))).status, "ignored");
    const duplicate = await webhook(refundAgain);
    assert.equal(duplicate.duplicate, true, JSON.stringify(duplicate));
    const after = await snapshot(s.participantId, s.dealId);
    assert.deepEqual(after, before);
  });

  await run("T3 Failed deal, AuthReleased participant: late charge_captured ignored; late release + reconcile jobs are no-ops with ZERO provider calls", async () => {
    const s = await seed({ suffix: "t3", dealState: "Failed", buyer_state: "DealFailed", money_state: "AuthReleased" });
    const before = await snapshot(s.participantId, s.dealId);
    assert.equal((await webhook(lateEvent("charge_captured", s.participantId, s.dealId, "t3"))).status, "ignored");
    const calls = stub.calls.length;
    const release = await processOutboxEventById(await insertJob("payment_release", s.dealId, s.participantId, { reason: "late" }));
    assert.equal(release?.status, "sent", JSON.stringify(release));
    const reconcile = await processOutboxEventById(await insertJob("payment_reconcile", s.dealId, s.participantId, { attempt_type: "charge_start", correlation_id: "late:t3", operation: "capture", provider_reference: "auth-t3", reason: "late" }));
    assert.equal(reconcile?.status, "sent", JSON.stringify(reconcile));
    assert.equal(stub.calls.length, calls, "no provider call for a resolved participant");
    const after = await snapshot(s.participantId, s.dealId);
    assert.deepEqual(after, before);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM siton.payment_attempts WHERE participant_id=$1`, [s.participantId])).rows[0].n, 0, "no attempt identity minted for a terminal participant");
  });

  await run("T4 Recovered participant: late recovery_captured / recovery_failed / charge_captured ignored", async () => {
    const s = await seed({ suffix: "t4", dealState: "CompletionWindow", buyer_state: "Recovered", money_state: "RecoveredCharge", completionWindowUntil: new Date(Date.now() + 10 * 60_000) });
    const before = await snapshot(s.participantId, s.dealId);
    for (const type of ["recovery_captured", "recovery_failed", "charge_captured", "charge_failed"]) {
      assert.equal((await webhook(lateEvent(type, s.participantId, s.dealId, "t4"))).status, "ignored", type);
    }
    assert.deepEqual(await snapshot(s.participantId, s.dealId), before);
  });

  await run("T5 late refund reconcile for an already Refunded participant is a no-op with zero provider calls", async () => {
    const s = await seed({ suffix: "t5", dealState: "Failed", buyer_state: "DealFailed", money_state: "Refunded" });
    const before = await snapshot(s.participantId, s.dealId);
    const calls = stub.calls.length;
    const reconcile = await processOutboxEventById(await insertJob("payment_reconcile", s.dealId, s.participantId, { attempt_type: "refund", correlation_id: "late:t5", operation: "refund", provider_reference: "cap-auth-t5", reason: "late" }));
    assert.equal(reconcile?.status, "sent", JSON.stringify(reconcile));
    assert.equal(stub.calls.length, calls);
    assert.deepEqual(await snapshot(s.participantId, s.dealId), before);
  });

  console.log(`PAYMENT_TERMINAL_STATE_LATE_EVENTS_VALIDATION passed=${passed}`);
} finally {
  await stub.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
