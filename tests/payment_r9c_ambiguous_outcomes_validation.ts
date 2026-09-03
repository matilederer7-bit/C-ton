// Independent R9C proof for ambiguous provider outcomes. The fake provider
// moves money before returning 503/429, dropping the connection, or delaying
// beyond the client timeout. No real provider or real money is involved.

import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3102";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-r9c-ambiguous";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "r9c-ambiguous-provider-key";
process.env.PAYMENT_PROVIDER_CAPTURE_PATH = "/capture";
process.env.PAYMENT_PROVIDER_RECOVERY_PATH = "/recover";
process.env.PAYMENT_PROVIDER_STATUS_PATH = "/status";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "100";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "r9c-ambiguous-webhook-secret";
process.env.WORKER_LEASE_MS = "30000";
process.env.OUTBOX_MAX_ATTEMPTS = "4";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
assert.match(
  String((await pool.query(`SELECT current_database() AS name`)).rows[0]?.name || ""),
  /^siton_test_/,
  "this proof may run only in a disposable isolated test database"
);

type Scenario = "503" | "429" | "drop" | "timeout";
type ProviderCall = { scenario: Scenario; key: string; authorization_id: string };
const calls: ProviderCall[] = [];
const effects = new Map<Scenario, number>();

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on("end", async () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const url = new URL(String(req.url), "http://stub");
    const authorizationId = String(body.authorization_id || decodeURIComponent(url.pathname.split("/").pop() || ""));
    const scenario = authorizationId.replace(/^auth-/, "") as Scenario;

    if (url.pathname.startsWith("/status/")) {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({
        state: (effects.get(scenario) || 0) > 0 ? "captured" : "authorized",
        final: true,
        provider_reference: authorizationId,
        amount_minor: 4200
      }));
      return;
    }

    if (url.pathname !== "/capture") {
      res.statusCode = 404;
      res.end();
      return;
    }

    calls.push({ scenario, key: String(req.headers["idempotency-key"] || ""), authorization_id: authorizationId });
    effects.set(scenario, (effects.get(scenario) || 0) + 1);
    const callNumber = calls.filter((call) => call.scenario === scenario).length;

    if (callNumber === 1 && scenario === "503") {
      res.setHeader("content-type", "application/json");
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "after_dispatch_503", provider_reference: authorizationId }));
      return;
    }
    if (callNumber === 1 && scenario === "429") {
      res.setHeader("content-type", "application/json");
      res.statusCode = 429;
      res.end(JSON.stringify({ error: "after_dispatch_429", provider_reference: authorizationId }));
      return;
    }
    if (callNumber === 1 && scenario === "drop") {
      req.socket.destroy();
      return;
    }
    if (callNumber === 1 && scenario === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    if (!res.destroyed) {
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "captured", capture_id: authorizationId, provider_reference: authorizationId, reference: body.reference }));
    }
  });
});

await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
const address = server.address();
if (!address || typeof address === "string") throw new Error("provider stub did not bind");
process.env.PAYMENT_PROVIDER_BASE_URL = `http://127.0.0.1:${address.port}`;

const { app, processOutboxEventById, closeWorkerDatabase } = await import(`../src/app.js?r9c-ambiguous-${Date.now()}`);

async function seed(scenario: Scenario) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  const eventId = randomUUID();
  const authorizationId = `auth-${scenario}`;
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, state, title, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ($1,'seller-r9c','Charging',$2,42,1,50,1,$3,now())`,
    [dealId, `R9C ambiguous ${scenario}`, new Date(Date.now() + 30 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,$3,1,'ChargingAttempt','ChargeAttempt',0,now())`,
    [participantId, dealId, `buyer-r9c-${scenario}`]
  );
  await pool.query(
    `INSERT INTO siton.audit_log
       (entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload)
     VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [participantId, dealId, `seed-${scenario}`, `seed-${scenario}:${participantId}`, JSON.stringify({ authorization: "provider_authorized", authorization_id: authorizationId, authorization_provider: "payrail-http" })]
  );
  await pool.query(
    `INSERT INTO siton.outbox_events
       (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at)
     VALUES ($1,'charge_deal','deal',$2,$3,'pending',0,now(),now(),now())`,
    [eventId, dealId, JSON.stringify({ deal_id: dealId })]
  );
  return { dealId, participantId, eventId };
}

async function attempts(participantId: string) {
  return (await pool.query(
    `SELECT correlation_id, result_class FROM siton.payment_attempts WHERE participant_id=$1 AND attempt_type='charge_start' ORDER BY created_at, correlation_id`,
    [participantId]
  )).rows as Array<{ correlation_id: string; result_class: string }>;
}

try {
  for (const scenario of ["503", "429"] as const) {
    const seeded = await seed(scenario);
    const first = await processOutboxEventById(seeded.eventId);
    assert.equal(first?.status, "failed", JSON.stringify(first));
    assert.deepEqual((await attempts(seeded.participantId)).map((row) => row.result_class), ["temporary_fail"]);
    await pool.query(`UPDATE siton.outbox_events SET available_at=now() WHERE event_uuid=$1`, [seeded.eventId]);
    const second = await processOutboxEventById(seeded.eventId);
    assert.equal(second?.status, "sent", JSON.stringify(second));
    const scenarioCalls = calls.filter((call) => call.scenario === scenario);
    assert.equal(scenarioCalls.length, 2, `${scenario}: a second capture was allowed`);
    assert.notEqual(scenarioCalls[0]?.key, scenarioCalls[1]?.key, `${scenario}: retry minted a fresh provider identity`);
    assert.equal(effects.get(scenario), 2, `${scenario}: two provider money effects occurred`);
    assert.deepEqual((await attempts(seeded.participantId)).map((row) => row.result_class), ["temporary_fail", "success"]);
  }

  for (const scenario of ["drop", "timeout"] as const) {
    const seeded = await seed(scenario);
    const first = await processOutboxEventById(seeded.eventId);
    assert.equal(first?.status, "sent", JSON.stringify(first));
    const beforeReconcile = await attempts(seeded.participantId);
    assert.deepEqual(beforeReconcile.map((row) => row.result_class), ["unknown"]);
    const reconcile = await pool.query(
      `SELECT event_uuid FROM siton.outbox_events WHERE event_type='payment_reconcile' AND aggregate_id=$1 AND status='pending' ORDER BY created_at LIMIT 1`,
      [seeded.participantId]
    );
    assert.equal(reconcile.rowCount, 1, `${scenario}: UNKNOWN schedules reconciliation`);
    const reconciled = await processOutboxEventById(String(reconcile.rows[0].event_uuid));
    assert.equal(reconciled?.status, "sent", JSON.stringify(reconciled));
    assert.equal(calls.filter((call) => call.scenario === scenario).length, 1, `${scenario}: reconciliation did not send another capture`);
    assert.equal(effects.get(scenario), 1, `${scenario}: exactly one provider money effect`);
    assert.equal((await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [seeded.participantId])).rows[0]?.money_state, "ChargedSuccess");
  }

  const evidence = {
    provider_calls: calls,
    provider_money_effects: Object.fromEntries(effects),
    payment_attempts: (await pool.query(
      `SELECT p.buyer_id, pa.correlation_id, pa.result_class FROM siton.payment_attempts pa JOIN siton.participants p ON p.participant_id=pa.participant_id ORDER BY p.buyer_id, pa.created_at`
    )).rows,
    participants: (await pool.query(
      `SELECT buyer_id, buyer_state, money_state FROM siton.participants WHERE buyer_id LIKE 'buyer-r9c-%' ORDER BY buyer_id`
    )).rows,
    outbox: (await pool.query(
      `SELECT event_type, status, attempt_count, aggregate_id FROM siton.outbox_events WHERE aggregate_id IN (SELECT participant_id FROM siton.participants WHERE buyer_id LIKE 'buyer-r9c-%') OR aggregate_id IN (SELECT deal_id FROM siton.participants WHERE buyer_id LIKE 'buyer-r9c-%') ORDER BY created_at`
    )).rows
  };
  console.log(`R9C_AMBIGUOUS_EVIDENCE ${JSON.stringify(evidence)}`);
  console.log("PASS 503/429 after side effect double-charge; connection drop/timeout remain UNKNOWN and reconcile without a fresh capture");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  await app.close().catch(() => undefined);
  await closeWorkerDatabase().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
