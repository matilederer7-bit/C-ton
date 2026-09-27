// BLACK-SKY COMBINATION 2 — the database connection dies inside a join while
// other joins fight for the last unit on an almost-exhausted pool.
//
// Real /deals/:id/join handler (app.inject), real disposable database. The web
// pool is pinned to PG_POOL_MAX=3. A separate "locker" connection holds the
// deal row FOR NO KEY UPDATE — the lock the join's capacity critical section
// takes — so every join parks INSIDE its transaction after writing its
// participant row (uncommitted), exactly the mid-transaction window. A separate
// "killer" connection then pg_terminate_backend()s one parked join.
//
//   J2 COMBINES (3): backend of join A terminated mid-transaction (after its
//       participant insert, before capacity commit) + joins B and C race A for
//       the LAST unit + the 3-connection web pool is fully checked out by the
//       three parked joins (pool exhaustion) while the kill lands.
//      EXPECTED (fail closed): A fails (never reported as success), nothing A
//       wrote survives (no participant, no idempotency result, no audit), no
//       over-capacity (sum(qty) <= max_units), exactly one of B/C takes the
//       last unit and the other gets 409 max_units_exceeded, the process and
//       the pool survive, A's retry with the same idempotency key gets a clean
//       capacity answer, money invariants PASS.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.NODE_ENV = "test";
process.env.PG_POOL_MAX = "3";
process.env.PORT = "3413";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "1000000";

const { app } = await import("../src/app.js");
const dbModule: any = await import("../src/db.js");
const { auditSeededDeal, poll, runMoneyInvariantsOrThrow, sleep } = await import("./support/black_sky_chaos.js");
await app.ready();
assert.equal(dbModule.pool.options.max, 3, "the web pool is pinned to 3 connections");
// the pool's 100ms idle reaper could race the kill; this test owns termination
dbModule.pool.options.idleTimeoutMillis = 0;

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, application_name: "black-sky-admin" });
const uncaught: string[] = [];
process.on("uncaughtException", (error: any) => { uncaught.push(String(error?.code || error?.message || error)); });

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.stack || error}`); }
}

async function openDeal(maxUnits: number) {
  const r = await admin.query(
    `INSERT INTO siton.deals (seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, published_at)
     VALUES ('seller-default','Black-Sky last unit','PendingTarget',10,1,$1,$1,now() + interval '2 hours',now()) RETURNING deal_id`, [maxUnits]);
  const dealId = String(r.rows[0].deal_id);
  await auditSeededDeal(admin, dealId);
  return dealId;
}

function join(dealId: string, buyer: string, key: string) {
  return app.inject({
    method: "POST", url: `/deals/${dealId}/join`,
    headers: { "x-request-id": `bs-j2-${key}`, "idempotency-key": `bs-j2-${key}`, "content-type": "application/json", "x-forwarded-for": "10.9.2.1" },
    payload: { buyer_id: buyer, qty: 1, buyer_terms_accepted: true, payment_disclosure_accepted: true }
  });
}

async function parkedJoinPids() {
  return (await admin.query(
    `SELECT pid FROM pg_stat_activity
     WHERE datname=current_database() AND application_name='siton-web-runtime' AND wait_event_type='Lock'
     ORDER BY backend_start, pid`)).rows.map((r) => Number(r.pid));
}

try {
  await run("J2 join backend killed mid-transaction + two joins racing for the last unit + exhausted 3-connection pool → A leaves nothing, exactly one survivor, no over-capacity", async () => {
    const dealId = await openDeal(2);
    const first = await join(dealId, "0501110001", `first-${dealId}`);
    assert.equal(first.statusCode, 200, first.body);

    const locker = await admin.connect();
    let aResult: any;
    let bResult: any;
    let cResult: any;
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM siton.deals WHERE deal_id=$1 FOR NO KEY UPDATE`, [dealId]);

      const aPromise = join(dealId, "0501110002", `a-${dealId}`);
      await poll("join A parked inside its transaction", 10_000, async () => (await parkedJoinPids()).length === 1, 25);
      const [aPid] = await parkedJoinPids();
      const aWrites = await admin.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='relation' AND mode='RowExclusiveLock' AND relation='siton.participants'::regclass`, [aPid]);
      assert.equal(aWrites.rows[0].n, 1, "vacuity: A already wrote its participant row (uncommitted) when it parked");

      const bPromise = join(dealId, "0501110003", `b-${dealId}`);
      const cPromise = join(dealId, "0501110004", `c-${dealId}`);
      await poll("B and C parked too (pool fully checked out)", 10_000, async () => (await parkedJoinPids()).length === 3, 25);
      assert.equal(dbModule.pool.totalCount, 3, "the web pool is exhausted");
      assert.equal(dbModule.pool.idleCount, 0);

      const killed = await admin.query(`SELECT pg_terminate_backend($1) AS ok`, [aPid]);
      assert.equal(killed.rows[0].ok, true);
      aResult = await aPromise;
      await sleep(200);
      await locker.query("COMMIT");
      [bResult, cResult] = await Promise.all([bPromise, cPromise]);
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }

    console.log(`  J2 A=${aResult.statusCode} ${aResult.body.slice(0, 120)} | B=${bResult.statusCode} ${bResult.body.slice(0, 80)} | C=${cResult.statusCode} ${cResult.body.slice(0, 80)}`);
    assert.ok(aResult.statusCode >= 500 && aResult.statusCode < 600, `the killed join fails (never a success): ${aResult.statusCode}`);
    const statuses = [bResult.statusCode, cResult.statusCode].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one survivor takes the last unit");
    const loser = bResult.statusCode === 409 ? bResult : cResult;
    assert.match(loser.body, /max_units_exceeded|exceeds available inventory/);

    const buyers = (await admin.query(`SELECT buyer_id, qty, buyer_state, money_state FROM siton.participants WHERE deal_id=$1 ORDER BY created_at`, [dealId])).rows;
    assert.equal(buyers.length, 2, `participants: ${JSON.stringify(buyers)}`);
    assert.ok(!buyers.some((b) => b.buyer_id === "0501110002"), "nothing of the killed join survived");
    assert.equal(buyers.reduce((s, b) => s + Number(b.qty), 0), 2, "no over-capacity");
    const aTrace = await admin.query(
      `SELECT (SELECT count(*) FROM siton.join_idempotency_results WHERE deal_id=$1 AND buyer_id='0501110002')::int AS idem,
              (SELECT count(*) FROM siton.audit_log a WHERE a.deal_id=$1 AND a.idempotency_key=$2)::int AS audits`, [dealId, `bs-j2-a-${dealId}`]);
    assert.deepEqual(aTrace.rows[0], { idem: 0, audits: 0 }, "no orphan reservation / idempotency / audit rows from the killed join");

    // the pool and the process survived; A's retry with the SAME key gets a clean capacity answer
    const retry = await join(dealId, "0501110002", `a-${dealId}`);
    assert.equal(retry.statusCode, 409, `A's retry is refused cleanly on capacity, not replayed: ${retry.body}`);
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.deepEqual(uncaught, [], "no uncaught exception escaped the kill");
    await runMoneyInvariantsOrThrow("J2");
  });
} finally {
  await admin.end();
  await app.close();
  await dbModule.pool.end().catch(() => undefined);
}
console.log(`\nSUMMARY black_sky_join_db_kill passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
