import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  buildOutboxWorkerHelpers,
  OutboxLeaseLostError
} from "../src/outbox_worker_helpers.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// A single-connection pool keeps the fake TEMP effect table private to this
// disposable test database while all worker transactions share it.
const pool = new Pool({ connectionString, max: 1 });

class PermanentFailError extends Error {}
class DeferredEventError extends Error {
  retryAt = new Date(Date.now() + 60_000);
}

async function withTx<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function worker(workerId: string) {
  return buildOutboxWorkerHelpers({
    withTx,
    outboxPollMs: 1_000,
    outboxMaxAttempts: 5,
    workerId,
    leaseMs: 5_000,
    PermanentFailErrorCtor: PermanentFailError,
    DeferredEventErrorCtor: DeferredEventError
  });
}

async function seedEvent(maxAttempts = 5) {
  const eventId = randomUUID();
  const aggregateId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload,
       status, attempt_count, max_attempts, available_at
     ) VALUES ($1,'deadline_check','deal',$2,'{}'::jsonb,'pending',0,$3,now())`,
    [eventId, aggregateId, maxAttempts]
  );
  return eventId;
}

async function expireLease(eventId: string) {
  const result = await pool.query(
    `UPDATE siton.outbox_events
     SET lease_expires_at=now()-interval '1 second'
     WHERE event_uuid=$1 AND status='processing'`,
    [eventId]
  );
  assert.equal(result.rowCount, 1, "the test must expire exactly one owned lease");
}

async function applyFakeInternalEffect(eventId: string) {
  return withTx(async (client) => {
    const result = await client.query(
      `INSERT INTO fake_internal_effects(event_uuid, effect_key)
       VALUES ($1,$2)
       ON CONFLICT (event_uuid) DO NOTHING
       RETURNING event_uuid`,
      [eventId, `effect:${eventId}`]
    );
    return Number(result.rowCount || 0);
  });
}

async function eventState(eventId: string) {
  const result = await pool.query(
    `SELECT status, attempt_count, lease_generation, worker_id, lease_expires_at,
            available_at, last_attempt_at
     FROM siton.outbox_events
     WHERE event_uuid=$1`,
    [eventId]
  );
  return result.rows[0] ?? null;
}

async function lifecycleAudit(eventId: string) {
  const result = await pool.query(
    `SELECT action, worker_id, lease_generation, attempt_count,
            from_status, to_status, reason_code
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND subject_id=$1
     ORDER BY audit_sequence`,
    [eventId]
  );
  return result.rows;
}

try {
  const database = await pool.query(`SELECT current_database() AS name`);
  assert.match(
    String(database.rows[0]?.name || ""),
    /^siton_test_/,
    "failure recovery proof may run only in a disposable isolated test database"
  );

  await pool.query(
    `CREATE TEMP TABLE fake_internal_effects (
       event_uuid UUID PRIMARY KEY,
       effect_key TEXT NOT NULL UNIQUE,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     ) ON COMMIT PRESERVE ROWS`
  );

  const crashBeforeWorker = worker("test-crash-before-effect");
  const crashAfterWorker = worker("test-crash-after-effect");
  const recoveryWorker = worker("test-recovery-worker");

  const recoveryEventId = await seedEvent();

  // Crash boundary 1: the event was claimed, but no internal action happened.
  const firstClaim = await crashBeforeWorker.claimOutboxEventById(recoveryEventId);
  assert.ok(firstClaim, "crash-before-effect worker must claim the event");
  assert.equal(
    Number((await pool.query(`SELECT COUNT(*)::int AS count FROM fake_internal_effects WHERE event_uuid=$1`, [recoveryEventId])).rows[0].count),
    0
  );
  await expireLease(recoveryEventId);
  assert.ok(await recoveryWorker.reclaimStuckProcessing(5_000) >= 1);
  assert.equal((await eventState(recoveryEventId))?.status, "pending");

  // Crash boundary 2: the internal action committed, but completion did not.
  const secondClaim = await crashAfterWorker.claimOutboxEventById(recoveryEventId);
  assert.ok(secondClaim, "crash-after-effect worker must claim the reclaimed event");
  assert.equal(await applyFakeInternalEffect(recoveryEventId), 1);
  await expireLease(recoveryEventId);
  assert.ok(await recoveryWorker.reclaimStuckProcessing(5_000) >= 1);

  const recoveredClaim = await recoveryWorker.claimOutboxEventById(recoveryEventId);
  assert.ok(recoveredClaim, "new worker must claim after the second reclaim");
  assert.ok(
    Number(recoveredClaim.lease_generation) > Number(secondClaim.lease_generation),
    "reclaim followed by claim must advance the fencing generation"
  );

  // Replaying the same internal operation is harmless and creates no duplicate.
  assert.equal(await applyFakeInternalEffect(recoveryEventId), 0);
  const effectCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM fake_internal_effects WHERE event_uuid=$1`,
    [recoveryEventId]
  );
  assert.equal(effectCount.rows[0].count, 1);

  // The stale owner cannot acknowledge after its generation was reclaimed.
  await assert.rejects(
    () => crashAfterWorker.markOutboxSent(recoveryEventId, secondClaim.lease_generation),
    (error: unknown) => error instanceof OutboxLeaseLostError
  );
  const beforeRecoveryAck = await eventState(recoveryEventId);
  assert.equal(beforeRecoveryAck?.status, "processing");
  assert.equal(beforeRecoveryAck?.worker_id, "test-recovery-worker");

  await recoveryWorker.markOutboxSent(recoveryEventId, recoveredClaim.lease_generation);
  const completed = await eventState(recoveryEventId);
  assert.equal(completed?.status, "sent");
  assert.equal(completed?.worker_id, null);

  const recoveryAudit = await lifecycleAudit(recoveryEventId);
  assert.equal(recoveryAudit.filter((row) => row.action === "claim").length, 3);
  assert.equal(recoveryAudit.filter((row) => row.action === "reclaim").length, 2);
  assert.equal(recoveryAudit.filter((row) => row.action === "completion").length, 1);
  assert.equal(
    recoveryAudit.some(
      (row) => row.action === "completion" && Number(row.lease_generation) === Number(secondClaim.lease_generation)
    ),
    false,
    "stale completion must not create an audit record"
  );

  // A controlled handler failure is recorded atomically with its retry state.
  const failureWorker = worker("test-failure-worker");
  const failureEventId = await seedEvent(3);
  const failureClaim = await failureWorker.claimOutboxEventById(failureEventId);
  assert.ok(failureClaim);
  const controlledFailure = Object.assign(new Error("test-only internal failure"), {
    code: "test_internal_failure"
  });
  await failureWorker.markOutboxFailed(
    failureEventId,
    failureClaim.lease_generation,
    controlledFailure
  );

  const failedState = await eventState(failureEventId);
  assert.equal(failedState?.status, "pending");
  assert.equal(Number(failedState?.attempt_count), 1);
  assert.ok(new Date(failedState.available_at).getTime() > new Date(failedState.last_attempt_at).getTime());

  const failureAudit = await lifecycleAudit(failureEventId);
  const failureRows = failureAudit.filter((row) => row.action === "failure");
  assert.equal(failureRows.length, 1);
  assert.equal(failureRows[0]?.reason_code, "test_internal_failure");
  assert.equal(failureAudit.filter((row) => row.action === "retry").length, 1);

  console.log(
    "PASS outbox failure recovery fences stale owners, replays internal effects idempotently, completes with the new owner, and writes lifecycle failure audit"
  );
} finally {
  await pool.end();
}
