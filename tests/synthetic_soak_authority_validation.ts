// BOUNDED SYNTHETIC SOAK — sustained mixed traffic against a disposable stack.
//
// Everything before this file probes ONE behaviour at a time with a clean start.
// A soak asks the different question: does the system stay correct while it is
// busy, and does anything drift once the same code runs thousands of times
// instead of once? Connection leaks, unhandled rejections, duplicated durable
// effects and stuck work only appear under sustained mixed load.
//
// This is deliberately REALISTIC concurrency, not resource exhaustion. The point
// is to find drift, not to prove that a laptop can be overwhelmed - a
// destructive run would only measure the machine.
//
// Bounded on purpose: a fixed wall-clock budget well inside the suite timeout,
// with every worker checking the clock, so this can live in CI rather than being
// a thing someone runs by hand and forgets.
//
// LOCAL AND DISPOSABLE ONLY. No third-party service is touched, no provider call
// is made, no money moves: joins use synthetic buyers with pre-verified OTP
// challenges against the fake payment adapter, and notifications are the
// log-only provider.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3134";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
// A soak is not a rate-limit test. Leaving the limiter on would mean measuring
// the 200/min bucket instead of the system under load.
process.env.RATE_LIMIT_MAX = "0";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";

const { app, processNextPendingOutboxEvent } = await import("../src/app.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 10
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

// An unhandled rejection during a soak is a real defect: it means a failure path
// exists that nobody awaits. Node would print it and carry on, so it has to be
// captured explicitly or it is invisible to the test.
const unhandledRejections: string[] = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(String((reason as any)?.message || reason).slice(0, 200));
});

// 30s keeps the whole file - fixture, soak and post-checks - comfortably inside
// the 180s per-test budget even on a contended runner, while still issuing over
// ten thousand requests. Override with SOAK_MS for a longer manual run.
const SOAK_MS = Number(process.env.SOAK_MS || 30_000);
const VIRTUAL_USERS = 12;

type Stats = {
  requests: number;
  byStatus: Record<string, number>;
  serverFaults: string[];
  expectedThrottle: number;
  unexplained429: string[];
  transportErrors: string[];
};
const stats: Stats = { requests: 0, byStatus: {}, serverFaults: [], expectedThrottle: 0, unexplained429: [], transportErrors: [] };

// The per-IP limiter is disabled for this run, so a 429 can only come from a
// product-level cap. The inquiry rail has DB-backed caps (per customer, per
// deal, global) documented in P0.7; those engaging under sustained load is the
// protection working. Anything else is an anomaly worth naming.
const EXPECTED_THROTTLE = /inquiry|too many|rate|cap|spam|limit/i;

async function hit(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const injection: Record<string, unknown> = {
    method,
    url,
    headers: { "x-request-id": randomUUID(), ...headers }
  };
  if (payload !== undefined) {
    (injection.headers as Record<string, string>)["content-type"] = "application/json";
    injection.payload = payload;
  }
  try {
    const response = await app.inject(injection as any);
    stats.requests += 1;
    const bucket = `${Math.floor(response.statusCode / 100)}xx`;
    stats.byStatus[bucket] = (stats.byStatus[bucket] || 0) + 1;
    if (response.statusCode >= 500) {
      stats.serverFaults.push(`${method} ${url.split("?")[0]} -> ${response.statusCode} ${(response.body || "").slice(0, 120)}`);
    }
    if (response.statusCode === 429) {
      if (EXPECTED_THROTTLE.test(response.body || "")) stats.expectedThrottle += 1;
      else stats.unexplained429.push(`${method} ${url.split("?")[0]} -> ${(response.body || "").slice(0, 140)}`);
    }
    return response;
  } catch (error: any) {
    stats.transportErrors.push(String(error?.message || error).slice(0, 160));
    return null;
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const SELLER = `seller-soak-${randomUUID().slice(0, 8)}`;
const sellerHeaders = { "x-seller-id": SELLER };

async function seedPublishedDeal(maxUnits: number) {
  const result = await pool.query(
    `INSERT INTO siton.deals
       (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at)
     VALUES ($1,100,1,$2,1,now()+interval '7 days',$3,'PendingTarget',now())
     RETURNING deal_id`,
    [`Soak deal ${randomUUID().slice(0, 8)}`, maxUnits, SELLER]
  );
  const dealId = String(result.rows[0].deal_id);
  await pool.query(
    `INSERT INTO siton.deal_delivery_options (deal_id, option_type, label, cost, sort_order)
     VALUES ($1,'pickup','רחוב העומס 1, תל אביב',0,0) ON CONFLICT DO NOTHING`,
    [dealId]
  );
  return dealId;
}

async function verifiedOtpChallenge(dealId: string) {
  const challengeId = randomUUID();
  await pool.query(
    `INSERT INTO siton.otp_challenges
       (challenge_id, channel, destination_hash, destination_display, purpose,
        code_hash, status, expires_at, verified_at, consumed_at, max_attempts, attempts_count,
        resend_count, idempotency_key, deal_id, created_at, updated_at)
     VALUES ($1,'sms','soak-hash','soak-display','buyer_join',
             'soak-code-hash','consumed',now()+interval '1 hour',now(),now(),3,1,
             0,$2,$3,now(),now())`,
    [challengeId, `soak:buyer_join:${challengeId}`, dealId]
  );
  await pool.query(
    `INSERT INTO siton.otp_proofs(challenge_id, token_hash, issued_at, expires_at)
     VALUES ($1,$2,now(),now()+interval '15 minutes')`,
    [challengeId, `soak-proof-${challengeId}`]
  );
  return challengeId;
}

const CAPACITY = 40;
const soakDeals: string[] = [];
for (let index = 0; index < 4; index += 1) soakDeals.push(await seedPublishedDeal(CAPACITY));

const heapBefore = process.memoryUsage().heapUsed;
const connectionsBefore = Number((await pool.query(
  `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`
)).rows[0].n);

let joinsAccepted = 0;
let inquiriesCreated = 0;
let outboxProcessed = 0;

// ── The soak ─────────────────────────────────────────────────────────────────

const deadline = Date.now() + SOAK_MS;
const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

async function anonymousReader() {
  while (Date.now() < deadline) {
    const dealId = pick(soakDeals);
    await hit("GET", `/api/deals/${dealId}/public`);
    await hit("GET", `/api/deals/${dealId}/activity`);
    await hit("GET", "/api/mall/deals");
  }
}

async function sellerWorker() {
  while (Date.now() < deadline) {
    const dealId = pick(soakDeals);
    await hit("GET", "/api/seller/deals", undefined, sellerHeaders);
    await hit("GET", `/api/seller/deals/${dealId}/preview`, undefined, sellerHeaders);
    await hit("GET", "/api/seller/analytics", undefined, sellerHeaders);
  }
}

async function buyerJoiner() {
  while (Date.now() < deadline) {
    const dealId = pick(soakDeals);
    const challengeId = await verifiedOtpChallenge(dealId);
    const response = await hit("POST", `/deals/${dealId}/join`, {
      buyer_id: `+9725${String(Math.floor(Math.random() * 100000000)).padStart(8, "0")}`,
      otp_challenge_id: challengeId,
      qty: 1,
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true
    });
    if (response?.statusCode === 200) joinsAccepted += 1;
  }
}

async function inquirySender() {
  while (Date.now() < deadline) {
    const dealId = pick(soakDeals);
    const response = await hit("POST", `/api/deals/${dealId}/inquiries`, {
      name: `Soak Buyer ${randomUUID().slice(0, 6)}`,
      email: `soak-${randomUUID().slice(0, 8)}@siton.test`,
      message: "Soak inquiry: is this still available?"
    });
    if (response && response.statusCode >= 200 && response.statusCode < 300) inquiriesCreated += 1;
  }
}

async function outboxDrainer() {
  while (Date.now() < deadline) {
    const result = await processNextPendingOutboxEvent(1).catch(() => null);
    if (result === null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    outboxProcessed += 1;
  }
}

await run("VACUITY GUARD: the soak actually generated sustained mixed traffic", async () => {
  const started = Date.now();
  await Promise.all([
    anonymousReader(), anonymousReader(), anonymousReader(), anonymousReader(),
    sellerWorker(), sellerWorker(), sellerWorker(),
    buyerJoiner(), buyerJoiner(),
    inquirySender(), inquirySender(),
    outboxDrainer()
  ]);
  const elapsed = Date.now() - started;
  console.log(
    `  soak: ${(elapsed / 1000).toFixed(1)}s, ${stats.requests} requests, ` +
    `status ${JSON.stringify(stats.byStatus)}, joins ${joinsAccepted}, ` +
    `inquiries ${inquiriesCreated}, capped ${stats.expectedThrottle}, outbox ${outboxProcessed}, users ${VIRTUAL_USERS}`
  );
  assert.ok(stats.requests > 300, `only ${stats.requests} requests were issued - not a soak`);
  assert.ok(elapsed >= SOAK_MS * 0.5, `the soak finished in ${elapsed}ms, far short of its ${SOAK_MS}ms budget`);
  // Each write path is guarded separately. The first version of this file left
  // inquiries at ZERO for a whole run - the payload used the wrong field names -
  // and a guard that only checked joins reported a healthy soak that had never
  // touched the inquiry rail at all.
  assert.ok(joinsAccepted > 0, "no join succeeded during the soak - the join path was never exercised");
  assert.ok(inquiriesCreated > 0, "no inquiry succeeded during the soak - the inquiry path was never exercised");
  assert.ok(outboxProcessed > 0, "the outbox drained nothing - the worker path was never exercised");
  assert.ok((stats.byStatus["2xx"] || 0) > 100, "almost nothing succeeded; this measures failure, not load");
});

await run("no server fault under sustained load", async () => {
  assert.deepEqual([...new Set(stats.serverFaults)].slice(0, 10), [], "5xx responses during the soak");
  assert.deepEqual([...new Set(stats.transportErrors)].slice(0, 10), [], "transport errors during the soak");
});

await run("no unexpected throttling, and no unhandled rejection anywhere", async () => {
  assert.deepEqual(
    [...new Set(stats.unexplained429)].slice(0, 10),
    [],
    "requests were throttled by something that is not a documented product cap"
  );
  // The other direction: the inquiry caps SHOULD engage under this much load.
  // If they never fire, the spam protection is not doing anything.
  assert.ok(
    stats.expectedThrottle > 0,
    "the inquiry spam caps never engaged under sustained load - the protection may be inert"
  );
  assert.deepEqual([...new Set(unhandledRejections)].slice(0, 10), [], "unhandled promise rejections during the soak");
});

await run("no duplicate durable effects: every accepted join is exactly one participant", async () => {
  const totals = await pool.query(
    `SELECT COUNT(*)::int AS participants, COALESCE(SUM(qty),0)::int AS units
     FROM siton.participants WHERE deal_id = ANY($1::uuid[])`,
    [soakDeals]
  );
  assert.equal(
    Number(totals.rows[0].participants),
    joinsAccepted,
    `${joinsAccepted} joins were accepted but ${totals.rows[0].participants} participant rows exist`
  );

  // Capacity held for every deal, under load rather than in isolation.
  const perDeal = await pool.query(
    `SELECT d.deal_id, d.max_units, COALESCE(SUM(p.qty),0)::int AS units
     FROM siton.deals d LEFT JOIN siton.participants p ON p.deal_id = d.deal_id
     WHERE d.deal_id = ANY($1::uuid[]) GROUP BY d.deal_id, d.max_units`,
    [soakDeals]
  );
  const oversold = perDeal.rows
    .filter((row: any) => Number(row.units) > Number(row.max_units))
    .map((row: any) => `${row.deal_id}: ${row.units}/${row.max_units}`);
  assert.deepEqual(oversold, [], "a deal was oversold under sustained load");

  // One inquiry request must not fan out into several notification events.
  const events = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.notification_events
     WHERE event_type = 'seller_customer_inquiry'`
  ).catch(() => ({ rows: [{ n: -1 }] } as any));
  if (Number(events.rows[0].n) >= 0) {
    assert.ok(
      Number(events.rows[0].n) <= inquiriesCreated,
      `${inquiriesCreated} inquiries produced ${events.rows[0].n} notification events - a fan-out under load`
    );
  }
});

await run("no stuck work and no leaked database connections", async () => {
  const stuck = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.outbox_events
     WHERE status = 'processing' AND processing_started_at < now() - interval '2 minutes'`
  );
  assert.equal(Number(stuck.rows[0].n), 0, "outbox events were left claimed after the soak");

  const idleInTransaction = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND state = 'idle in transaction'
       AND state_change < now() - interval '30 seconds'`
  );
  assert.equal(Number(idleInTransaction.rows[0].n), 0, "connections were left idle inside a transaction");

  const connectionsAfter = Number((await pool.query(
    `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`
  )).rows[0].n);
  // Pools grow to their configured ceiling under load; a LEAK is unbounded growth.
  assert.ok(
    connectionsAfter <= connectionsBefore + 40,
    `connections grew from ${connectionsBefore} to ${connectionsAfter} - the pool is leaking`
  );
  console.log(`  connections ${connectionsBefore} -> ${connectionsAfter}, heap ${(heapBefore / 1e6).toFixed(1)}MB -> ${(process.memoryUsage().heapUsed / 1e6).toFixed(1)}MB`);
});

console.log(`SUMMARY passed=${passed} failed=${failed} requests=${stats.requests}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
