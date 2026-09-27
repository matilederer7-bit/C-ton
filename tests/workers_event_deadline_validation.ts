// Outbox worker resilience — per-job deadline and unknown-type deferral.
//
// M3: WORKER_EVENT_TIMEOUT_MS is enforced. A handler that never resolves is
//     ABANDONED at the deadline: the worker stops waiting and stops renewing
//     the lease, but it never acks the job sent or failed (a JS timeout is not
//     evidence of failure — a money handler may already have dispatched). When
//     the abandoned run later finishes it still cannot ack; lease expiry +
//     reclaim hand the job to a new lease generation, which completes it once.
// H2: an event type this build does not know (rolling deploy) is deferred
//     (~5 min, bounded by the attempt budget) instead of dead-lettered.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.NODE_ENV = "test";
process.env.PORT = "3147";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.OUTBOX_POLL_MS = "60000";
process.env.WORKER_LEASE_MS = "5000";
process.env.LOG_LEVEL = "silent";

const { app, processClaimedOutboxEvent, processOutboxEventById, claimPendingOutboxBatch, reclaimWorkerJobs, workerAbandonedJobsInFlight } = await import("../src/app.js");
const { armTestFault, resetTestFaults } = await import("../src/fault_injection.js");
await app.ready();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

let passed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  } finally {
    resetTestFaults();
  }
}
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function seedDraftDealCheck(tag: string) {
  const deal = await pool.query(
    `INSERT INTO siton.deals (seller_id, title, state, price_per_unit, min_units, max_units, threshold_units, deadline, created_at, updated_at)
     VALUES ('seller-default', $1, 'Draft', 10.00, 1, 10, 3, now() + interval '7 day', now(), now())
     RETURNING deal_id`,
    [`workers-deadline:${tag}`]
  );
  const dealId = String(deal.rows[0].deal_id);
  const event = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
     VALUES ('deadline_check','deal',$1,$2,'pending',0,now())
     RETURNING event_uuid`,
    [dealId, JSON.stringify({ deal_id: dealId })]
  );
  return String(event.rows[0].event_uuid);
}

async function eventRow(eventId: string) {
  const row = await pool.query(
    `SELECT status, sent, attempt_count, lease_generation, worker_id, last_error, available_at
     FROM siton.outbox_events WHERE event_uuid=$1`,
    [eventId]
  );
  return row.rows[0];
}

async function auditActions(eventId: string) {
  const rows = await pool.query(
    `SELECT action, lease_generation::int AS generation
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND subject_id=$1
     ORDER BY audit_id`,
    [eventId]
  );
  return rows.rows.map((row) => `${row.action}@${row.generation}`);
}

try {
  await run("a job past WORKER_EVENT_TIMEOUT_MS is abandoned: neither sent nor failed, the late completion cannot ack, reclaim + a new generation completes it exactly once", async () => {
    process.env.WORKER_EVENT_TIMEOUT_MS = "400";
    const eventId = await seedDraftDealCheck(randomUUID());
    // The fake "handler that never resolves": block the job right after claim.
    const barrier = armTestFault("worker.after_claim", { kind: "block" });
    const started = Date.now();
    const result = await processOutboxEventById(eventId);
    const elapsed = Date.now() - started;
    assert.equal(result?.status, "deadline_exceeded", JSON.stringify(result));
    assert.ok(elapsed >= 380 && elapsed < 5_000, `deadline honoured (${elapsed}ms)`);
    assert.equal(workerAbandonedJobsInFlight(), 1);

    let row = await eventRow(eventId);
    assert.equal(row.status, "processing", "abandoned job is not acked in either direction");
    assert.equal(row.sent, false);
    assert.equal(Number(row.lease_generation), 1);
    assert.deepEqual(await auditActions(eventId), ["claim@1"], "no completion / failure / retry recorded by the abandoned run");

    // Let the "hung handler" finish late. Its business logic runs (Draft deal:
    // pure no-op success) but nothing acks the job.
    barrier!.release();
    for (let i = 0; i < 50 && workerAbandonedJobsInFlight() > 0; i++) await sleep(50);
    assert.equal(workerAbandonedJobsInFlight(), 0, "late run settled");
    await sleep(200);
    row = await eventRow(eventId);
    assert.equal(row.status, "processing", "the late completion did NOT mark the job sent");
    assert.equal(Number(row.lease_generation), 1);
    assert.deepEqual(await auditActions(eventId), ["claim@1"]);

    // The lease is no longer renewed; once it expires the reclaim returns the
    // job to pending and a new generation completes it.
    await pool.query(`UPDATE siton.outbox_events SET lease_expires_at = now() - interval '1 second' WHERE event_uuid=$1 AND status='processing'`, [eventId]);
    await reclaimWorkerJobs(1);
    row = await eventRow(eventId);
    assert.equal(row.status, "pending");
    process.env.WORKER_EVENT_TIMEOUT_MS = "120000";
    const second = await processOutboxEventById(eventId);
    assert.equal(second?.status, "sent", JSON.stringify(second));
    row = await eventRow(eventId);
    assert.equal(row.status, "sent");
    assert.equal(Number(row.lease_generation), 2);
    const actions = await auditActions(eventId);
    assert.deepEqual(actions.filter((action) => action.startsWith("completion")), ["completion@2"], "exactly one completion, by the new generation");
    assert.ok(!actions.some((action) => action.startsWith("failure") || action.startsWith("retry")), actions.join(","));
  });

  await run("an abandoned job stops renewing its lease (lease expiry is what hands it over)", async () => {
    process.env.WORKER_EVENT_TIMEOUT_MS = "300";
    const eventId = await seedDraftDealCheck(randomUUID());
    const barrier = armTestFault("worker.after_claim", { kind: "block" });
    const result = await processOutboxEventById(eventId);
    assert.equal(result?.status, "deadline_exceeded");
    const before = await pool.query(`SELECT lease_expires_at, last_heartbeat_at FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]);
    // The heartbeat interval is max(1s, lease/3) = 1.67s: wait past two ticks.
    await sleep(3_600);
    const after = await pool.query(`SELECT lease_expires_at, last_heartbeat_at FROM siton.outbox_events WHERE event_uuid=$1`, [eventId]);
    assert.equal(String(after.rows[0].lease_expires_at), String(before.rows[0].lease_expires_at), "lease was not renewed after the deadline");
    barrier!.release();
    for (let i = 0; i < 50 && workerAbandonedJobsInFlight() > 0; i++) await sleep(50);
    process.env.WORKER_EVENT_TIMEOUT_MS = "120000";
  });

  await run("a job that finishes inside the deadline is acked normally", async () => {
    process.env.WORKER_EVENT_TIMEOUT_MS = "5000";
    const eventId = await seedDraftDealCheck(randomUUID());
    const result = await processOutboxEventById(eventId);
    assert.equal(result?.status, "sent", JSON.stringify(result));
    process.env.WORKER_EVENT_TIMEOUT_MS = "120000";
  });

  await run("an unknown event type (rolling deploy) is deferred ~5 min instead of dead-lettered", async () => {
    const eventId = await seedDraftDealCheck(randomUUID());
    await pool.query(`UPDATE siton.outbox_events SET available_at = now() - interval '1 hour' WHERE event_uuid=$1`, [eventId]);
    const batch = await claimPendingOutboxBatch(50);
    const claimed = batch.find((item) => item.event_uuid === eventId);
    assert.ok(claimed, "claimed the seeded event");
    // Other due rows claimed by the batch are released by processing them.
    for (const other of batch) if (other.event_uuid !== eventId) await processClaimedOutboxEvent(other);
    // The DB constraint only admits known types, so a build that does not
    // know the type is simulated by the in-memory event the worker sees.
    const before = Date.now();
    const result = await processClaimedOutboxEvent({ ...claimed!, event_type: "future_event_type_v2" });
    assert.equal(result?.status, "failed", JSON.stringify(result));
    const row = await eventRow(eventId);
    assert.equal(row.status, "pending", "deferred, not dead-lettered");
    assert.match(String(row.last_error), /unsupported_outbox_event_type_deferred: future_event_type_v2/);
    const deferMs = new Date(row.available_at).getTime() - before;
    assert.ok(deferMs > 290_000 && deferMs < 310_000, `deferred ~5 min (${deferMs}ms)`);
    const dlq = await pool.query(`SELECT 1 FROM siton.outbox_dlq WHERE event_uuid=$1`, [eventId]);
    assert.equal(dlq.rowCount, 0);
    const actions = await auditActions(eventId);
    assert.ok(actions.includes("retry@1"), actions.join(","));
  });
} finally {
  resetTestFaults();
  await pool.end();
  await app.close();
}
console.log(`SUMMARY passed=${passed} failed=0`);
process.exit(0);
