// BLACK-SKY COMBINATION 7 — rolling deploy while the database flickers and the
// worker's heartbeat writes fail.
//
//   R7a COMBINES (2): an outbox event whose type this build does not know (a
//        newer deploy is rolling out) + the database is unavailable at the
//        moment the worker records the outcome (db.before_begin fault on the
//        failure write).
//       EXPECTED: the unknown type is never executed and never dead-lettered;
//        the failed bookkeeping write leaves the job owned (not acked, not
//        lost); lease expiry + reclaim hand it to a new generation, which
//        DEFERS it (~OUTBOX_UNKNOWN_EVENT_DEFER_MS) with the retry audited.
//        The DB CHECK already refuses unknown types at insert, so — exactly
//        like tests/workers_event_deadline_validation.ts — the old build is
//        simulated by the in-memory event type the worker sees.
//
//   R7b COMBINES (3), REAL worker binary as a child process: the database
//        drops every worker connection (pg_terminate_backend) + heartbeat
//        writes fail (the heartbeat table is renamed away — a DDL on this
//        disposable database only) + jobs keep arriving.
//       EXPECTED (src/worker_scheduler.ts WorkerWatchdog): while failures stay
//        BELOW WORKER_WATCHDOG_MAX_HEARTBEAT_FAILURES the worker does NOT exit
//        and keeps completing jobs (grace window); once heartbeats recover the
//        counter resets. When heartbeat failures reach the limit the watchdog
//        exits the process non-zero (heartbeat_failing) so the supervisor
//        restarts it; a restarted worker finishes the queue exactly once.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.NODE_ENV = "test";
process.env.PORT = "3415";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.WORKER_LEASE_MS = "5000";
process.env.OUTBOX_UNKNOWN_EVENT_DEFER_MS = "300000";
process.env.LOG_LEVEL = "silent";

const { app, processClaimedOutboxEvent, claimPendingOutboxBatch, reclaimWorkerJobs, closeWorkerDatabase } = await import("../src/app.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
const { alive, poll, runMoneyInvariantsOrThrow, sleep, spawnWorkerProcess, workerLogLines } = await import("./support/black_sky_chaos.js");
await app.ready();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, application_name: "black-sky-admin" });

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.stack || error}`); }
  finally { resetTestFaults(); }
}

async function noopJob(tag: string) {
  const deal = await pool.query(
    `INSERT INTO siton.deals (seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline)
     VALUES ('seller-default',$1,'Draft',10,1,10,3,now() + interval '7 days') RETURNING deal_id`, [`black-sky rolling ${tag}`]);
  const dealId = String(deal.rows[0].deal_id);
  const ev = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('deadline_check','deal',$1,$2,'pending',0,now()) RETURNING event_uuid`, [dealId, JSON.stringify({ deal_id: dealId })]);
  return String(ev.rows[0].event_uuid);
}
async function auditActions(eventId: string) {
  return (await pool.query(`SELECT action, lease_generation::int AS g FROM siton.operational_recovery_audit WHERE subject_type='outbox_event' AND subject_id=$1 ORDER BY audit_sequence`, [eventId])).rows.map((r) => `${r.action}@${r.g}`);
}
async function sentCount(ids: string[]) {
  return Number((await pool.query(`SELECT count(*)::int AS n FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[]) AND status='sent'`, [ids])).rows[0].n);
}

const HEARTBEATS = "siton.worker_heartbeats";
async function breakHeartbeats() { await pool.query(`ALTER TABLE ${HEARTBEATS} RENAME TO worker_heartbeats_black_sky_moved`); }
async function restoreHeartbeats() {
  const moved = await pool.query(`SELECT to_regclass('siton.worker_heartbeats_black_sky_moved') AS t`);
  if (moved.rows[0].t) await pool.query(`ALTER TABLE siton.worker_heartbeats_black_sky_moved RENAME TO worker_heartbeats`);
}
// The child runs with RUNTIME_ROLE=worker, so BOTH of its pools are labeled
// siton-worker-runtime (this process's app pool is siton-web-runtime and is left
// alone). Test pools reap idle connections after 100 ms, so keep terminating
// until at least one live worker connection was really killed (anti-vacuity).
async function dropWorkerConnections() {
  let total = 0;
  const end = Date.now() + 5_000;
  while (Date.now() < end && total === 0) {
    const r = await pool.query(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
       WHERE datname=current_database() AND pid <> pg_backend_pid() AND application_name='siton-worker-runtime'`);
    total += Number(r.rows[0].n);
    if (!total) await sleep(20);
  }
  assert.ok(total >= 1, "vacuity: at least one live worker connection was terminated");
  return total;
}

try {
  await run("R7a unknown event type (rolling deploy) + DB unavailable while recording the outcome → not executed, not DLQ, reclaimed and deferred", async () => {
    const eventId = await noopJob(`r7a-${randomUUID().slice(0, 8)}`);
    const batch = await claimPendingOutboxBatch(10);
    const claimed = batch.find((row) => row.event_uuid === eventId);
    assert.ok(claimed, "claimed");
    const futureType = { ...claimed!, event_type: "future_event_type_v2" };

    armTestFault("db.before_begin", { kind: "throw", code: "black_sky_db_unavailable" });
    await assert.rejects(processClaimedOutboxEvent(futureType), (error: any) => error?.code === "black_sky_db_unavailable");
    let row = (await pool.query(`SELECT status, attempt_count, lease_generation FROM siton.outbox_events WHERE event_uuid=$1`, [eventId])).rows[0];
    assert.equal(row.status, "processing", "the failed bookkeeping write left the job owned, not acked or lost");
    assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_dlq WHERE event_uuid=$1`, [eventId])).rowCount, 0);

    await pool.query(`UPDATE siton.outbox_events SET lease_expires_at = now() - interval '1 second' WHERE event_uuid=$1`, [eventId]);
    await reclaimWorkerJobs(1);
    const second = (await claimPendingOutboxBatch(10)).find((r) => r.event_uuid === eventId);
    assert.ok(second, "a new generation claims it");
    const before = Date.now();
    const result = await processClaimedOutboxEvent({ ...second!, event_type: "future_event_type_v2" });
    assert.equal(result?.status, "failed", JSON.stringify(result));
    row = (await pool.query(`SELECT status, attempt_count, lease_generation, last_error, available_at FROM siton.outbox_events WHERE event_uuid=$1`, [eventId])).rows[0];
    assert.equal(row.status, "pending", "deferred, not dead-lettered");
    assert.equal(Number(row.lease_generation), 2);
    assert.match(String(row.last_error), /unsupported_outbox_event_type_deferred: future_event_type_v2/);
    const deferMs = new Date(row.available_at).getTime() - before;
    assert.ok(deferMs > 290_000 && deferMs < 310_000, `deferred ~5 min (${deferMs}ms)`);
    assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_dlq WHERE event_uuid=$1`, [eventId])).rowCount, 0);
    const actions = await auditActions(eventId);
    assert.deepEqual(actions.filter((a) => /^(claim|reclaim|retry|completion|dlq)/.test(a)), ["claim@1", "reclaim@1", "claim@2", "retry@2"], actions.join(","));
    assert.equal((await pool.query(`SELECT state FROM siton.deals d JOIN siton.outbox_events o ON o.aggregate_id=d.deal_id WHERE o.event_uuid=$1`, [eventId])).rows[0].state, "Draft", "the unknown type was never executed");
  });

  await run("R7b real worker: connections dropped + heartbeat writes failing → no exit inside the grace window, jobs keep completing; beyond it the watchdog exits non-zero and a restart finishes the queue once", async () => {
    const env = {
      RUNTIME_ROLE: "worker", OUTBOX_POLL_MS: "150", WORKER_CONCURRENCY: "2", WORKER_LEASE_MS: "6000", WORKER_RECLAIM_EVERY_POLLS: "2",
      WORKER_HEARTBEAT_MS: "1000", WORKER_WATCHDOG_MAX_HEARTBEAT_FAILURES: "4", WORKER_WATCHDOG_INTERVAL_MS: "200",
      WORKER_SHUTDOWN_TIMEOUT_MS: "2000"
    };
    const first = spawnWorkerProcess(`bs-rolling-a-${process.pid}`, env);
    try {
      await poll("worker ready heartbeat", 30_000, async () => (await pool.query(`SELECT 1 FROM ${HEARTBEATS} WHERE worker_id=$1 AND status='ready'`, [first.id])).rowCount === 1, 200);

      // ── grace window: ~2 heartbeat failures (< 4) while the DB drops connections ──
      await breakHeartbeats();
      const dropped = await dropWorkerConnections();
      const graceJobs = [await noopJob("grace-1"), await noopJob("grace-2")];
      await sleep(2_300);
      assert.ok(alive(first), "no exit inside the grace window");
      await restoreHeartbeats();
      await poll("grace jobs completed during/after the flicker", 20_000, async () => (await sentCount(graceJobs)) === graceJobs.length, 200);
      const failuresInGrace = workerLogLines(first).filter((l) => l.msg === "worker_heartbeat_failed").length;
      console.log(`  R7b grace: terminated_connections=${dropped} heartbeat_failures=${failuresInGrace}`);
      assert.ok(failuresInGrace >= 1 && failuresInGrace < 4, `vacuity: heartbeats really failed, but below the limit (${failuresInGrace})`);
      const hbBefore = (await pool.query(`SELECT heartbeat_at FROM ${HEARTBEATS} WHERE worker_id=$1`, [first.id])).rows[0].heartbeat_at;
      await poll("heartbeats recovered", 10_000, async () => {
        const now = (await pool.query(`SELECT heartbeat_at FROM ${HEARTBEATS} WHERE worker_id=$1`, [first.id])).rows[0].heartbeat_at;
        return new Date(now).getTime() > new Date(hbBefore).getTime();
      }, 200);
      await sleep(2_500); // well past the old failure count: the counter was reset by the successes
      assert.ok(alive(first), "recovered heartbeats reset the watchdog counter");

      // ── beyond the grace window: heartbeats keep failing → watchdog exit ──
      await breakHeartbeats();
      await dropWorkerConnections();
      const exit = await Promise.race([first.exited, sleep(20_000).then(() => null)]);
      await restoreHeartbeats();
      assert.ok(exit, "the watchdog must exit a worker whose heartbeats keep failing");
      assert.equal(exit!.code, 1, `non-zero exit for the supervisor: ${JSON.stringify(exit)}`);
      const fatal = workerLogLines(first).find((l) => l.msg === "worker_watchdog_fatal");
      assert.equal(fatal?.reason, "heartbeat_failing", JSON.stringify(fatal));
    } finally {
      await restoreHeartbeats();
      if (alive(first)) first.child.kill("SIGKILL");
    }

    // ── supervisor restart: the queue is finished exactly once ──
    const after = [await noopJob("after-1"), await noopJob("after-2"), await noopJob("after-3")];
    const second = spawnWorkerProcess(`bs-rolling-b-${process.pid}`, env);
    try {
      await poll("restarted worker drains the queue", 30_000, async () => (await sentCount(after)) === after.length, 200);
      const dup = await pool.query(
        `SELECT subject_id FROM siton.operational_recovery_audit WHERE subject_type='outbox_event' AND action='completion' AND subject_id = ANY($1::text[])
         GROUP BY subject_id HAVING count(*) <> 1`, [after]);
      assert.equal(dup.rowCount, 0, "exactly-once completion");
      second.child.kill("SIGTERM");
      assert.equal((await second.exited).code, 0);
    } finally {
      if (alive(second)) second.child.kill("SIGKILL");
    }
    const residue = await pool.query(`SELECT count(*)::int AS n FROM siton.outbox_events WHERE status='processing' AND lease_expires_at > now() + interval '1 hour'`);
    assert.equal(residue.rows[0].n, 0);
    await runMoneyInvariantsOrThrow("R7");
  });
} finally {
  await restoreHeartbeats().catch(() => undefined);
  await pool.end();
  await app.close();
  await closeWorkerDatabase().catch(() => undefined);
}
console.log(`\nSUMMARY black_sky_rolling_deploy passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
