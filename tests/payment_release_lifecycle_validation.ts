import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// R9A — provider-neutral release/void lifecycle.
//
// Failed/cancelled deals schedule Worker-owned payment_release jobs for every
// still-held authorization. AuthReleased is reached ONLY with authoritative
// provider proof (release success or a status lookup saying 'released').

process.env.PORT = "3096";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-release";
process.env.PAYMENT_PROVIDER = "payrail-http";
process.env.PAYMENT_PROVIDER_MODE = "provider-ready";
process.env.PAYMENT_PROVIDER_API_KEY = "live-provider-key";
process.env.PAYMENT_PROVIDER_RELEASE_PATH = "/release";
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = "150";
process.env.OUTBOX_POLL_MS = "60000";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_WEBHOOK_PROVIDER = "payrail-http";
process.env.PAYMENT_WEBHOOK_SECRET = "release-webhook-secret";

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
    failed += 1;
  }
}

async function startProviderStub() {
  const releaseCalls: Array<any> = [];
  const statusCalls: Array<string> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", async () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

      if (req.url && req.url.startsWith("/status/")) {
        statusCalls.push(req.url);
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ state: "released", final: true }));
        return;
      }

      if (req.url === "/release") {
        releaseCalls.push(body);
        const authorizationId = String(body.authorization_id || "");
        if (authorizationId.includes("timeout")) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        res.setHeader("content-type", "application/json");
        if (authorizationId.includes("permfail")) {
          res.statusCode = 402;
          res.end(JSON.stringify({ ok: false, error: "release_refused" }));
          return;
        }
        if (authorizationId.includes("tempfail")) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: "release_unavailable" }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, provider_reference: authorizationId }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub port missing");
  return {
    releaseCalls,
    statusCalls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

const provider = await startProviderStub();
process.env.PAYMENT_PROVIDER_BASE_URL = provider.baseUrl;

const { processOutboxEventById } = await import(`../src/app.js?release-${Date.now()}`);
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

async function seedHeldParticipant(args: {
  suffix: string;
  authorizationId: string;
  moneyState?: "AuthHeld" | "AuthLocked";
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.seller_accounts(seller_id, display_name, auth_enabled) VALUES ($1,$2,false)
     ON CONFLICT (seller_id) DO NOTHING`,
    [`rel-seller-${args.suffix}`, `Release seller ${args.suffix}`]
  );
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, seller_id
     ) VALUES ($1,$2,10,2,50,40,$3,'PendingTarget', now(), now(), $4)`,
    [dealId, `Release Deal ${args.suffix}`, new Date(Date.now() - 60_000).toISOString(), `rel-seller-${args.suffix}`]
  );
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,1,'JoinedAuthorized',$4,0, now())`,
    [participantId, dealId, `buyer-${args.suffix}`, args.moneyState || "AuthHeld"]
  );
  await pool.query(
    `INSERT INTO siton.audit_log (
       entity_type, entity_id, deal_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, payload
     ) VALUES ('participant',$1,$2,'buyer_state','NotJoined','JoinedAuthorized','participant.join_authorize',$3,$4,$5)`,
    [
      participantId,
      dealId,
      `seed:${args.suffix}`,
      `seed-release-${args.suffix}-${Date.now()}`,
      JSON.stringify({
        authorization: "provider_authorized",
        authorization_id: args.authorizationId,
        authorization_provider: "payrail-http"
      })
    ]
  );
  return { dealId, participantId };
}

async function enqueueDeadlineCheck(dealId: string) {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'deadline_check','deal',$2,$3,'pending',0, now())`,
    [eventId, dealId, JSON.stringify({ deal_id: dealId })]
  );
  return eventId;
}

async function latestReleaseEvent(participantId: string) {
  const r = await pool.query(
    `SELECT event_uuid, status FROM siton.outbox_events
     WHERE event_type='payment_release' AND aggregate_id=$1
     ORDER BY created_at DESC LIMIT 1`,
    [participantId]
  );
  return r.rows[0] || null;
}

async function participantMoneyState(participantId: string) {
  const r = await pool.query(`SELECT money_state FROM siton.participants WHERE participant_id=$1`, [participantId]);
  return String(r.rows[0]?.money_state || "");
}

await runTest("failed deal schedules release; release success reaches AuthReleased with a durable attempt", async () => {
  const seeded = await seedHeldParticipant({ suffix: "ok", authorizationId: "auth-release-ok-1" });
  const deadlineEvent = await enqueueDeadlineCheck(seeded.dealId);
  const processed = await processOutboxEventById(deadlineEvent);
  assert.equal(processed?.status, "sent");

  const deal = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [seeded.dealId]);
  assert.equal(deal.rows[0].state, "Failed");

  const releaseEvent = await latestReleaseEvent(seeded.participantId);
  assert.ok(releaseEvent, "payment_release must be scheduled for the held authorization");

  const releaseProcessed = await processOutboxEventById(releaseEvent.event_uuid);
  assert.equal(releaseProcessed?.status, "sent");
  assert.equal(await participantMoneyState(seeded.participantId), "AuthReleased");

  const attempt = await pool.query(
    `SELECT result_class FROM siton.payment_attempts
     WHERE participant_id=$1 AND attempt_type='release' ORDER BY created_at DESC LIMIT 1`,
    [seeded.participantId]
  );
  assert.equal(attempt.rows[0].result_class, "success");
  assert.equal(provider.releaseCalls.filter((row) => row.authorization_id === "auth-release-ok-1").length, 1);

  // Duplicate release processing is a no-op once released.
  const again = await pool.query(
    `INSERT INTO siton.outbox_events (event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ($1,'payment_release','participant',$2,$3,'pending',0, now())
     ON CONFLICT DO NOTHING RETURNING event_uuid`,
    [randomUUID(), seeded.participantId, JSON.stringify({ participant_id: seeded.participantId, deal_id: seeded.dealId, reason: "duplicate" })]
  );
  if (again.rowCount) {
    const dupProcessed = await processOutboxEventById(again.rows[0].event_uuid);
    assert.equal(dupProcessed?.status, "sent");
  }
  assert.equal(provider.releaseCalls.filter((row) => row.authorization_id === "auth-release-ok-1").length, 1);
  assert.equal(await participantMoneyState(seeded.participantId), "AuthReleased");
});

await runTest("release temporary failure retries via outbox without state change", async () => {
  const seeded = await seedHeldParticipant({ suffix: "tempfail", authorizationId: "auth-release-tempfail-1" });
  const deadlineEvent = await enqueueDeadlineCheck(seeded.dealId);
  await processOutboxEventById(deadlineEvent);
  const releaseEvent = await latestReleaseEvent(seeded.participantId);
  const processed = await processOutboxEventById(releaseEvent.event_uuid);
  assert.equal(processed?.status, "failed");
  const outbox = await pool.query(`SELECT status, last_error FROM siton.outbox_events WHERE event_uuid=$1`, [releaseEvent.event_uuid]);
  assert.equal(outbox.rows[0].status, "pending");
  assert.match(String(outbox.rows[0].last_error || ""), /temporary_fail/);
  assert.equal(await participantMoneyState(seeded.participantId), "AuthHeld");
});

await runTest("release UNKNOWN routes to reconcile and resolves via status proof without a second release call", async () => {
  const seeded = await seedHeldParticipant({ suffix: "timeout", authorizationId: "auth-release-timeout-1" });
  const deadlineEvent = await enqueueDeadlineCheck(seeded.dealId);
  await processOutboxEventById(deadlineEvent);
  const releaseEvent = await latestReleaseEvent(seeded.participantId);
  const processed = await processOutboxEventById(releaseEvent.event_uuid);
  assert.equal(processed?.status, "sent");
  assert.equal(await participantMoneyState(seeded.participantId), "AuthHeld");

  const attempt = await pool.query(
    `SELECT result_class, correlation_id FROM siton.payment_attempts
     WHERE participant_id=$1 AND attempt_type='release' ORDER BY created_at DESC LIMIT 1`,
    [seeded.participantId]
  );
  assert.equal(attempt.rows[0].result_class, "unknown");

  const reconcile = await pool.query(
    `SELECT event_uuid FROM siton.outbox_events
     WHERE event_type='payment_reconcile' AND aggregate_id=$1
     ORDER BY created_at DESC LIMIT 1`,
    [seeded.participantId]
  );
  assert.ok(reconcile.rowCount, "reconcile job must exist for UNKNOWN release");

  const releaseCallsBefore = provider.releaseCalls.filter((row) => row.authorization_id === "auth-release-timeout-1").length;
  const reconcileProcessed = await processOutboxEventById(reconcile.rows[0].event_uuid);
  assert.equal(reconcileProcessed?.status, "sent");
  assert.equal(await participantMoneyState(seeded.participantId), "AuthReleased");
  const releaseCallsAfter = provider.releaseCalls.filter((row) => row.authorization_id === "auth-release-timeout-1").length;
  assert.equal(releaseCallsAfter, releaseCallsBefore, "reconcile must not re-fire the release call");

  const finalized = await pool.query(
    `SELECT result_class FROM siton.payment_attempts
     WHERE participant_id=$1 AND attempt_type='release' ORDER BY created_at DESC LIMIT 1`,
    [seeded.participantId]
  );
  assert.equal(finalized.rows[0].result_class, "success");
});

await runTest("release permanent failure lands in DLQ with an operational case and no state change", async () => {
  const seeded = await seedHeldParticipant({ suffix: "permfail", authorizationId: "auth-release-permfail-1" });
  const deadlineEvent = await enqueueDeadlineCheck(seeded.dealId);
  await processOutboxEventById(deadlineEvent);
  const releaseEvent = await latestReleaseEvent(seeded.participantId);
  const processed = await processOutboxEventById(releaseEvent.event_uuid);
  assert.equal(processed?.status, "failed");
  assert.equal(await participantMoneyState(seeded.participantId), "AuthHeld");

  const dlq = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.outbox_dlq WHERE event_uuid=$1`, [releaseEvent.event_uuid]);
  assert.equal(dlq.rows[0].n, 1, "permanent release failure must be DLQ-visible");

  const cases = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.operational_cases WHERE auto_key=$1`,
    [`payment-release-failed:${seeded.participantId}`]
  );
  assert.equal(cases.rows[0].n, 1, "permanent release failure must open a manual-review case");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
await provider.close();
await pool.end();
// Windows/libuv teardown drain (uv_async close race under process.exit).
await new Promise((resolve) => setTimeout(resolve, 700));
process.exit(failed ? 1 : 0);
