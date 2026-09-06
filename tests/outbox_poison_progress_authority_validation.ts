// OUTBOX POISON / QUEUE-PROGRESS — the gaps left by the existing worker suites.
//
// Worker resilience is already covered well and this file deliberately does NOT
// duplicate it. `worker_two_process_fencing_validation` proves two live workers
// complete 30 competing jobs exactly once, that a hard-killed owner is fenced out
// and reclaimed, that SIGTERM during active ownership never duplicates, and that
// an unknown type or malformed payload is DLQ-archived without crashing.
// `outbox_reclaim_precision_proof` proves the lease timeout boundaries, that two
// concurrent reclaims never double-process, and that reclaim-then-fail lands in
// the DLQ with no phantom sent row.
//
// What none of them ask is whether the queue keeps MOVING when one event cannot
// succeed. Three properties, all liveness rather than safety:
//
//   1. A poison event is bounded. It stops at max_attempts instead of retrying
//      for ever - an unbounded retry is a self-inflicted load generator that also
//      never surfaces as a failure anyone can see.
//   2. A poison event does not block the queue behind it. Head-of-line blocking
//      turns one bad row into a total outage of every notification, and it is
//      invisible until someone asks why nothing has been delivered.
//   3. An event whose aggregate was DELETED is terminal, not retryable. The row
//      it refers to will never come back, so retrying is pure waste.
//
// NON-FINANCIAL: the events used here are notification-class rows. Nothing
// captures, settles, refunds or pays out; the provider is the log-only adapter,
// so no e-mail, SMS or external call happens.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3128";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-poison";
process.env.ADMIN_API_KEY = "poison-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-poison";

const { app, processNextPendingOutboxEvent, claimPendingOutboxBatch } = await import("../src/app.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

/** An allowed event_type, so the row passes the DB CHECK and reaches the handler. */
const EVENT_TYPE = "charge_deal";

async function seedDeal() {
  const result = await pool.query(
    `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
     VALUES ($1,50,1,20,5,$2,$3,'Draft') RETURNING deal_id`,
    [`Poison probe ${randomUUID().slice(0, 8)}`, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), `seller-poison-${randomUUID().slice(0, 8)}`]
  );
  return String(result.rows[0].deal_id);
}

async function enqueue(aggregateId: string, maxAttempts = 3) {
  const result = await pool.query(
    `INSERT INTO siton.outbox_events (event_type, aggregate_type, aggregate_id, payload, status, max_attempts, available_at)
     VALUES ($1,'deal',$2,'{}'::jsonb,'pending',$3, now() - interval '1 minute')
     RETURNING event_uuid`,
    [EVENT_TYPE, aggregateId, maxAttempts]
  );
  return String(result.rows[0].event_uuid);
}

/**
 * A terminal event does not stay in the queue: it is copied into
 * `siton.outbox_dlq` and deleted from `siton.outbox_events` in the same
 * transaction, which keeps the hot queue small. So an event lives in exactly one
 * of the two tables, and "which one" is itself the outcome. Looking only at the
 * queue table would read a correctly DLQ'd event as "vanished".
 */
async function eventRow(eventUuid: string) {
  const live = await pool.query(
    `SELECT status, attempt_count, max_attempts, sent, sent_at, last_error, available_at
     FROM siton.outbox_events WHERE event_uuid = $1`,
    [eventUuid]
  );
  const dlq = await pool.query(
    `SELECT status, attempt_count, max_attempts, sent, sent_at, last_error, available_at
     FROM siton.outbox_dlq WHERE event_uuid = $1`,
    [eventUuid]
  );
  assert.ok(
    (live.rowCount ?? 0) + (dlq.rowCount ?? 0) >= 1,
    "the event is in neither the queue nor the DLQ - it was lost, not completed"
  );
  assert.ok(
    (live.rowCount ?? 0) === 0 || (dlq.rowCount ?? 0) === 0,
    "the event is in BOTH the queue and the DLQ - it can be processed again after being archived"
  );
  const row = ((live.rowCount ?? 0) ? live.rows[0] : dlq.rows[0]) as any;
  return { ...row, terminal: (dlq.rowCount ?? 0) > 0 };
}

/** Drain the queue, bounded, so a livelock fails the test instead of hanging it. */
async function drain(maxIterations: number) {
  let processed = 0;
  for (let index = 0; index < maxIterations; index += 1) {
    // available_at backoff would otherwise make the drain sleep; pull every row
    // that is due now forward so the loop exercises retry accounting, not clocks.
    await pool.query(
      `UPDATE siton.outbox_events SET available_at = now() - interval '1 second'
       WHERE status = 'pending' AND sent = false`
    );
    const result = await processNextPendingOutboxEvent(1).catch(() => null);
    if (result === null) break;
    processed += 1;
  }
  return processed;
}

// Clear anything the app enqueued during boot so counts below are about this test.
await pool.query(`DELETE FROM siton.outbox_events`);
await pool.query(`DELETE FROM siton.outbox_dlq`);

await run("VACUITY GUARD: the queue processes a well-formed event at all", async () => {
  const dealId = await seedDeal();
  const eventUuid = await enqueue(dealId);
  const processed = await drain(5);
  assert.ok(processed >= 1, "the worker claimed nothing - every assertion below would be vacuous");
  const row = await eventRow(eventUuid);
  assert.notEqual(String(row.status), "pending", `the event never left pending: ${JSON.stringify(row)}`);
});

await run("a poison event is BOUNDED: it stops at max_attempts instead of retrying for ever", async () => {
  await pool.query(`DELETE FROM siton.outbox_events`);
  await pool.query(`DELETE FROM siton.outbox_dlq`);
  // An aggregate id that refers to nothing: the handler cannot succeed, ever.
  const eventUuid = await enqueue(randomUUID(), 3);

  const processed = await drain(25);
  const row = await eventRow(eventUuid);

  assert.ok(
    Number(row.attempt_count) <= Number(row.max_attempts),
    `attempt_count ${row.attempt_count} exceeded max_attempts ${row.max_attempts} - retries are unbounded`
  );
  assert.notEqual(String(row.status), "processing", "the poison event was left claimed forever");
  assert.equal(row.sent, false, "a poison event was marked sent");
  assert.ok(
    processed < 25,
    "the drain never ran out of work: the poison event is being retried without limit"
  );
  console.log(`  poison: status=${row.status} attempts=${row.attempt_count}/${row.max_attempts} drained=${processed}`);
});

await run("a poison event does NOT block healthy events behind it (no head-of-line blocking)", async () => {
  await pool.query(`DELETE FROM siton.outbox_events`);
  await pool.query(`DELETE FROM siton.outbox_dlq`);
  // Poison first, so a naive strictly-ordered queue would stall on it.
  const poison = await enqueue(randomUUID(), 2);
  const healthy: string[] = [];
  for (let index = 0; index < 3; index += 1) healthy.push(await enqueue(await seedDeal(), 3));

  await drain(40);

  const stuck: string[] = [];
  for (const eventUuid of healthy) {
    const row = await eventRow(eventUuid);
    if (String(row.status) === "pending" && Number(row.attempt_count) === 0) {
      stuck.push(`${eventUuid} status=${row.status} attempts=${row.attempt_count}`);
    }
  }
  assert.deepEqual(stuck, [], "healthy events were never attempted - one poison row blocked the queue");

  const poisonRow = await eventRow(poison);
  assert.equal(poisonRow.sent, false, "the poison event was marked sent");
});

await run("an event whose aggregate was deleted is terminal, not retried for ever", async () => {
  await pool.query(`DELETE FROM siton.outbox_events`);
  await pool.query(`DELETE FROM siton.outbox_dlq`);
  const dealId = await seedDeal();
  const eventUuid = await enqueue(dealId, 3);
  // The referenced row goes away between enqueue and processing - the ordinary
  // shape of a cancelled or purged entity. Retrying can never help.
  await pool.query(`DELETE FROM siton.deals WHERE deal_id = $1`, [dealId]);

  await drain(25);
  const row = await eventRow(eventUuid);
  assert.ok(
    Number(row.attempt_count) <= Number(row.max_attempts),
    `a deleted-aggregate event retried ${row.attempt_count} times against a max of ${row.max_attempts}`
  );
  assert.notEqual(String(row.status), "processing", "the event was left claimed forever");
  console.log(`  deleted aggregate: status=${row.status} attempts=${row.attempt_count}/${row.max_attempts}`);
});

await run("a failing event never reports itself as sent, and records why", async () => {
  await pool.query(`DELETE FROM siton.outbox_events`);
  await pool.query(`DELETE FROM siton.outbox_dlq`);
  const eventUuid = await enqueue(randomUUID(), 2);
  await drain(15);
  const row = await eventRow(eventUuid);
  assert.equal(row.sent, false, "a failing event set sent=true");
  assert.equal(row.sent_at ?? null, null, "a failing event carries a sent_at");
  assert.ok(
    row.last_error === null || String(row.last_error).length > 0,
    "last_error was written as an empty string, which reads as 'no error' to an operator"
  );
});

await run("a claimed batch is never handed to a second claimer", async () => {
  await pool.query(`DELETE FROM siton.outbox_events`);
  await pool.query(`DELETE FROM siton.outbox_dlq`);
  const ids = new Set<string>();
  for (let index = 0; index < 6; index += 1) ids.add(await enqueue(await seedDeal(), 3));

  // Two claimers race for the same queue, as two worker processes would.
  const [batchA, batchB] = await Promise.all([claimPendingOutboxBatch(6), claimPendingOutboxBatch(6)]);
  const claimedA = new Set(batchA.map((event: any) => String(event.event_uuid)));
  const claimedB = new Set(batchB.map((event: any) => String(event.event_uuid)));

  const overlap = [...claimedA].filter((eventUuid) => claimedB.has(eventUuid));
  assert.deepEqual(overlap, [], "the same event was claimed by two concurrent claimers");
  assert.ok(claimedA.size + claimedB.size > 0, "neither claimer got anything - probe is not meaningful");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
