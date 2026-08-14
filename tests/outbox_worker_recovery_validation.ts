import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildOutboxWorkerHelpers, type OutboxEventRow } from "../src/outbox_worker_helpers.js";
import { executeAdminAction, insertAdminAction } from "../src/admin_control_plane.js";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 30 });

class PermanentFailError extends Error {
  readonly code = "permanent_fail";
}

class DeferredEventError extends Error {
  readonly retryAt: Date;

  constructor(message: string, retryAt = new Date(Date.now() + 1_000)) {
    super(message);
    this.retryAt = retryAt;
  }
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

type TransactionClockEvidence = {
  began_at?: Date;
  resumed_at?: Date;
};

function delayedAfterBeginWithTx(delayMs: number, evidence: TransactionClockEvidence) {
  return async function delayedWithTx<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const began = await client.query(`SELECT transaction_timestamp() AS began_at`);
      evidence.began_at = new Date(began.rows[0].began_at);
      await wait(delayMs);
      const resumed = await client.query(`SELECT clock_timestamp() AS resumed_at`);
      evidence.resumed_at = new Date(resumed.rows[0].resumed_at);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

function worker(
  workerId: string,
  outboxPollMs = 80,
  maxAttempts = 4,
  withTransaction: typeof withTx = withTx
) {
  return buildOutboxWorkerHelpers({
    withTx: withTransaction,
    outboxPollMs,
    outboxMaxAttempts: maxAttempts,
    workerId,
    leaseMs: 10_000,
    PermanentFailErrorCtor: PermanentFailError,
    DeferredEventErrorCtor: DeferredEventError
  });
}

async function insertPendingEvent(attemptCount = 0, maxAttempts = 4): Promise<string> {
  const eventId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload,
       status, attempt_count, max_attempts, available_at, sent
     ) VALUES ($1,'deadline_check','deal',$2,$3::jsonb,'pending',$4,$5,now(),false)`,
    [eventId, randomUUID(), JSON.stringify({ probe: "no_external_side_effect" }), attemptCount, maxAttempts]
  );
  return eventId;
}

async function eventRow(eventId: string) {
  const result = await pool.query(
    `SELECT event_uuid, status, attempt_count, max_attempts, available_at,
            updated_at, worker_id, lease_generation, lease_expires_at, payload,
            sent, sent_at, request_id
     FROM siton.outbox_events
     WHERE event_uuid=$1`,
    [eventId]
  );
  return result.rows[0] as Record<string, any> | undefined;
}

async function retryDelayFromDb(eventId: string): Promise<number> {
  const result = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS retry_delay_ms
     FROM siton.outbox_events
     WHERE event_uuid=$1`,
    [eventId]
  );
  const row = result.rows[0] as { retry_delay_ms?: string | number } | undefined;
  assert.ok(row, "retry event must remain in outbox");
  return Number(row.retry_delay_ms);
}

function leaseLost(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "outbox_lease_lost");
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const database = await pool.query<{ current_database: string }>("SELECT current_database()");
const databaseName = String(database.rows[0]?.current_database || "");
assert.match(databaseName, /^siton_test_/, "this recovery proof must run only in the isolated DB harness");

let externalSideEffectCalls = 0;
const simulateForbiddenExternalHandler = () => {
  externalSideEffectCalls += 1;
};
void simulateForbiddenExternalHandler;

try {
  await assert.rejects(
    pool.query(
      `INSERT INTO siton.outbox_events (
         event_uuid, event_type, aggregate_type, aggregate_id, payload,
         status, attempt_count, max_attempts, available_at, sent
       ) VALUES ($1,'deadline_check','deal',$2,'{}'::jsonb,'pending',5,4,now(),false)`,
      [randomUUID(), randomUUID()]
    ),
    (error: any) => error?.code === "23514",
    "the active queue must reject attempt_count above max_attempts"
  );

  const archivalDlqId = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_dlq (
       event_uuid, event_type, aggregate_type, aggregate_id, payload,
       status, attempt_count, max_attempts, available_at, sent, last_error
     ) VALUES ($1,'invoice_document_issue','invoice_document',$2,$3::jsonb,'failed',10,4,now(),false,'legacy attempt history')`,
    [archivalDlqId, randomUUID(), JSON.stringify({ probe: "no_external_side_effect" })]
  );
  const archivalDlq = await pool.query(
    `SELECT attempt_count, max_attempts, event_type, aggregate_type
     FROM siton.outbox_dlq
     WHERE event_uuid=$1`,
    [archivalDlqId]
  );
  assert.equal(archivalDlq.rowCount, 1);
  assert.equal(Number(archivalDlq.rows[0]?.attempt_count), 10);
  assert.equal(Number(archivalDlq.rows[0]?.max_attempts), 4);
  assert.equal(archivalDlq.rows[0]?.event_type, "invoice_document_issue");
  assert.equal(archivalDlq.rows[0]?.aggregate_type, "invoice_document");
  await assert.rejects(
    pool.query(
      `INSERT INTO siton.outbox_dlq (
         event_uuid, event_type, aggregate_type, aggregate_id, payload,
         status, attempt_count, max_attempts, available_at, sent, last_error
       ) VALUES ($1,'deadline_check','deal',$2,'{}'::jsonb,'failed',-1,4,now(),false,'invalid archive history')`,
      [randomUUID(), randomUUID()]
    ),
    (error: any) => error?.code === "23514",
    "the DLQ archive must still reject negative attempt counts"
  );
  console.log("PASS active attempt bounds remain strict while DLQ preserves valid legacy attempt history");

  const unfencedEventId = await insertPendingEvent();
  await assert.rejects(
    pool.query(
      `UPDATE siton.outbox_events
       SET status='processing', worker_id='legacy-unfenced-worker',
           claimed_at=clock_timestamp(), processing_started_at=clock_timestamp(),
           lease_expires_at=clock_timestamp()+interval '30 seconds',
           last_heartbeat_at=clock_timestamp(), lease_generation=0
       WHERE event_uuid=$1`,
      [unfencedEventId]
    ),
    (error: any) => error?.code === "23514",
    "a new generation-0 processing claim must be rejected by the DB fence"
  );
  const unfencedAfter = await eventRow(unfencedEventId);
  assert.equal(unfencedAfter?.status, "pending");
  assert.equal(Number(unfencedAfter?.lease_generation), 0);
  console.log("PASS the DB constraint rejects a new generation-0/unfenced processing claim");

  const cutoverClient = await pool.connect();
  try {
    await cutoverClient.query("BEGIN");
    await cutoverClient.query(
      `ALTER TABLE siton.outbox_events
       DROP CONSTRAINT outbox_processing_requires_fenced_lease`
    );
    const legacyChargeId = randomUUID();
    const legacyDeadlineId = randomUUID();
    for (const [eventId, eventType] of [[legacyChargeId, "charge_deal"], [legacyDeadlineId, "deadline_check"]]) {
      await cutoverClient.query(
        `INSERT INTO siton.outbox_events (
           event_uuid, event_type, aggregate_type, aggregate_id, payload,
           status, attempt_count, max_attempts, available_at, sent,
           processing_started_at, claimed_at, lease_expires_at, worker_id,
           lease_generation, last_heartbeat_at
         ) VALUES ($1,$2,'deal',$3,$4::jsonb,'processing',1,4,clock_timestamp(),false,
                   clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '10 minutes',
                   clock_timestamp()-interval '5 minutes','legacy-owner',0,
                   clock_timestamp()-interval '10 minutes')`,
        [eventId, eventType, randomUUID(), JSON.stringify({ probe: "legacy_cutover_only" })]
      );
    }

    await cutoverClient.query("SAVEPOINT legacy_charge_cutover");
    await assert.rejects(
      cutoverClient.query(
        `UPDATE siton.outbox_events
         SET status='pending', lease_generation=1, sent=false, sent_at=null,
             processing_started_at=null, claimed_at=null, lease_expires_at=null,
             worker_id=null, last_heartbeat_at=null, available_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE event_uuid=$1`,
        [legacyChargeId]
      ),
      (error: any) => error?.code === "23514",
      "legacy charge_deal must remain quarantined even if a caller uses the repair-shaped update"
    );
    await cutoverClient.query("ROLLBACK TO SAVEPOINT legacy_charge_cutover");

    await cutoverClient.query("SAVEPOINT legacy_deadline_without_audit");
    await assert.rejects(
      cutoverClient.query(
        `UPDATE siton.outbox_events
         SET status='pending', lease_generation=1, sent=false, sent_at=null,
             processing_started_at=null, claimed_at=null, lease_expires_at=null,
             worker_id=null, last_heartbeat_at=null, available_at=clock_timestamp(), updated_at=clock_timestamp()
         WHERE event_uuid=$1`,
        [legacyDeadlineId]
      ),
      (error: any) => error?.code === "23514",
      "legacy deadline repair must fail without its append-only recovery audit"
    );
    await cutoverClient.query("ROLLBACK TO SAVEPOINT legacy_deadline_without_audit");

    await cutoverClient.query(
      `INSERT INTO siton.operational_recovery_audit (
         subject_type, subject_id, action, worker_id, lease_generation,
         attempt_count, from_status, to_status, idempotency_key, reason_code, metadata
       ) VALUES ('outbox_event',$1,'repair_lease','operator:stage32b-proof',1,
                 1,'processing','pending',$2,'stage32b_controlled_repair','{}'::jsonb)`,
      [legacyDeadlineId, `repair-lease:${legacyDeadlineId}`]
    );
    const repairedDeadline = await cutoverClient.query(
      `UPDATE siton.outbox_events
       SET status='pending', lease_generation=1, sent=false, sent_at=null,
           processing_started_at=null, claimed_at=null, lease_expires_at=null,
           worker_id=null, last_heartbeat_at=null, available_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE event_uuid=$1
       RETURNING status, event_type, lease_generation, worker_id`,
      [legacyDeadlineId]
    );
    assert.equal(repairedDeadline.rowCount, 1);
    assert.equal(repairedDeadline.rows[0]?.status, "pending");
    assert.equal(repairedDeadline.rows[0]?.event_type, "deadline_check");
    assert.equal(Number(repairedDeadline.rows[0]?.lease_generation), 1);
    assert.equal(repairedDeadline.rows[0]?.worker_id, null);
    await cutoverClient.query("ROLLBACK");
  } catch (error) {
    await cutoverClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    cutoverClient.release();
  }
  console.log("PASS legacy cutover quarantines charge events and requires an exact recovery Audit for deadline repair");

  const heartbeatEventId = await insertPendingEvent();
  const heartbeatOwner = worker("heartbeat-owner");
  const heartbeatClaim = await heartbeatOwner.claimOutboxEventById(heartbeatEventId);
  assert.ok(heartbeatClaim);
  const heartbeatGeneration = Number(heartbeatClaim.lease_generation);
  const initialHeartbeatExpiry = new Date(String(heartbeatClaim.lease_expires_at));
  await wait(20);
  const heartbeatResults = await Promise.all([
    heartbeatOwner.heartbeatOutboxLease(heartbeatEventId, heartbeatGeneration),
    heartbeatOwner.heartbeatOutboxLease(heartbeatEventId, heartbeatGeneration)
  ]);
  assert.deepEqual(heartbeatResults, [true, true]);
  const heartbeatAfter = await eventRow(heartbeatEventId);
  assert.ok(heartbeatAfter);
  assert.ok(
    new Date(heartbeatAfter.lease_expires_at).getTime() > initialHeartbeatExpiry.getTime(),
    "heartbeat must strictly extend lease_expires_at"
  );
  const heartbeatAudits = await pool.query(
    `SELECT idempotency_key
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND subject_id=$1 AND action='heartbeat'
     ORDER BY audit_sequence`,
    [heartbeatEventId]
  );
  assert.equal(heartbeatAudits.rowCount, 2);
  assert.equal(new Set(heartbeatAudits.rows.map((row) => row.idempotency_key)).size, 2);
  await heartbeatOwner.markOutboxSent(heartbeatEventId, heartbeatGeneration);
  console.log("PASS concurrent current-owner heartbeats both extend the lease and append unique audits");

  const delayedCompletionEventId = await insertPendingEvent();
  const delayedCompletionWorkerId = "delayed-completion-owner";
  const delayedCompletionOwner = worker(delayedCompletionWorkerId);
  const delayedCompletionClaim = await delayedCompletionOwner.claimOutboxEventById(delayedCompletionEventId);
  assert.ok(delayedCompletionClaim);
  const completionExpiryResult = await pool.query(
    `UPDATE siton.outbox_events
     SET lease_expires_at=clock_timestamp()+interval '350 milliseconds'
     WHERE event_uuid=$1
     RETURNING lease_expires_at`,
    [delayedCompletionEventId]
  );
  const completionExpiry = new Date(completionExpiryResult.rows[0].lease_expires_at);
  const completionClock: TransactionClockEvidence = {};
  const completionAfterExpiryOwner = worker(
    delayedCompletionWorkerId,
    80,
    4,
    delayedAfterBeginWithTx(700, completionClock)
  );
  await assert.rejects(
    completionAfterExpiryOwner.markOutboxSent(
      delayedCompletionEventId,
      Number(delayedCompletionClaim.lease_generation)
    ),
    leaseLost,
    "completion must fail when the lease expires after BEGIN but before its guarded statement"
  );
  assert.ok(completionClock.began_at && completionClock.began_at < completionExpiry);
  assert.ok(completionClock.resumed_at && completionClock.resumed_at >= completionExpiry);
  assert.equal((await eventRow(delayedCompletionEventId))?.status, "processing");

  const delayedHeartbeatEventId = await insertPendingEvent();
  const delayedHeartbeatWorkerId = "delayed-heartbeat-owner";
  const delayedHeartbeatOwner = worker(delayedHeartbeatWorkerId);
  const delayedHeartbeatClaim = await delayedHeartbeatOwner.claimOutboxEventById(delayedHeartbeatEventId);
  assert.ok(delayedHeartbeatClaim);
  const delayedHeartbeatExpiryResult = await pool.query(
    `UPDATE siton.outbox_events
     SET lease_expires_at=clock_timestamp()+interval '350 milliseconds'
     WHERE event_uuid=$1
     RETURNING lease_expires_at`,
    [delayedHeartbeatEventId]
  );
  const delayedHeartbeatExpiry = new Date(delayedHeartbeatExpiryResult.rows[0].lease_expires_at);
  const delayedHeartbeatClock: TransactionClockEvidence = {};
  const heartbeatAfterExpiryOwner = worker(
    delayedHeartbeatWorkerId,
    80,
    4,
    delayedAfterBeginWithTx(700, delayedHeartbeatClock)
  );
  assert.equal(
    await heartbeatAfterExpiryOwner.heartbeatOutboxLease(
      delayedHeartbeatEventId,
      Number(delayedHeartbeatClaim.lease_generation)
    ),
    false
  );
  assert.ok(delayedHeartbeatClock.began_at && delayedHeartbeatClock.began_at < delayedHeartbeatExpiry);
  assert.ok(delayedHeartbeatClock.resumed_at && delayedHeartbeatClock.resumed_at >= delayedHeartbeatExpiry);
  assert.equal((await eventRow(delayedHeartbeatEventId))?.status, "processing");
  await pool.query(
    `DELETE FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[])`,
    [[delayedCompletionEventId, delayedHeartbeatEventId]]
  );
  await pool.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1`, [unfencedEventId]);
  console.log("PASS heartbeat and completion reject a lease that expires after transaction BEGIN");

  const raceEventId = await insertPendingEvent();
  const originalOwner = worker("recovery-original-owner");
  const originalClaim = await originalOwner.claimOutboxEventById(raceEventId);
  assert.ok(originalClaim);
  const originalGeneration = Number(originalClaim.lease_generation);
  assert.equal(originalGeneration, 1);
  assert.equal(await originalOwner.heartbeatOutboxLease(raceEventId, originalGeneration), true);

  await pool.query(
    `UPDATE siton.outbox_events
     SET lease_expires_at=now()-interval '1 second'
     WHERE event_uuid=$1`,
    [raceEventId]
  );

  const reclaimers = Array.from({ length: 20 }, (_, index) => worker(`reclaimer-${index}`));
  const reclaimResults = await Promise.all(reclaimers.map((entry) => entry.reclaimStuckProcessing(60_000)));
  assert.equal(reclaimResults.filter((count) => count === 1).length, 1);
  assert.equal(reclaimResults.reduce((total, count) => total + count, 0), 1);

  const afterReclaim = await eventRow(raceEventId);
  assert.ok(afterReclaim);
  assert.equal(afterReclaim.status, "pending");
  assert.equal(Number(afterReclaim.attempt_count), 1);
  assert.equal(Number(afterReclaim.lease_generation), 1);
  assert.equal(afterReclaim.worker_id, null);
  assert.equal(await originalOwner.heartbeatOutboxLease(raceEventId, originalGeneration), false);

  const claimers = Array.from({ length: 20 }, (_, index) => ({
    id: `new-owner-${index}`,
    helper: worker(`new-owner-${index}`)
  }));
  const competingClaims = await Promise.all(claimers.map(({ helper }) => helper.claimOutboxEventById(raceEventId)));
  const winningClaims = competingClaims.filter((claim): claim is OutboxEventRow => Boolean(claim));
  assert.equal(winningClaims.length, 1);
  const winningClaim = winningClaims[0];
  assert.ok(winningClaim);
  const winningGeneration = Number(winningClaim.lease_generation);
  assert.equal(Number(winningClaim.attempt_count), 2);
  assert.equal(winningGeneration, 2);
  assert.ok(winningGeneration > originalGeneration);

  const winningOwner = claimers.find(({ id }) => id === winningClaim.worker_id)?.helper;
  assert.ok(winningOwner, "the winning worker must be identifiable from worker_id");
  const losingOwner = claimers.find(({ id }) => id !== winningClaim.worker_id)?.helper;
  assert.ok(losingOwner);

  await assert.rejects(
    originalOwner.markOutboxSent(raceEventId, originalGeneration),
    leaseLost,
    "stale generation must not complete reclaimed work"
  );
  await assert.rejects(
    losingOwner.markOutboxSent(raceEventId, winningGeneration),
    leaseLost,
    "a non-owner must not complete the current generation"
  );
  assert.equal(await originalOwner.heartbeatOutboxLease(raceEventId, originalGeneration), false);

  await winningOwner.markOutboxSent(raceEventId, winningGeneration);
  const completed = await eventRow(raceEventId);
  assert.ok(completed);
  assert.equal(completed.status, "sent");
  assert.equal(completed.worker_id, null);
  assert.equal(Number(completed.lease_generation), 2);
  console.log("PASS 20 reclaimers and 20 claimers preserve exactly-one ownership with generation fencing");

  const expiredAtCapId = await insertPendingEvent(3, 4);
  const expiredAtCapOwner = worker("expired-at-cap-owner", 80, 4);
  const expiredAtCapClaim = await expiredAtCapOwner.claimOutboxEventById(expiredAtCapId);
  assert.ok(expiredAtCapClaim);
  assert.equal(Number(expiredAtCapClaim.attempt_count), 4);
  await pool.query(
    `UPDATE siton.outbox_events
     SET lease_expires_at=clock_timestamp()-interval '1 second'
     WHERE event_uuid=$1`,
    [expiredAtCapId]
  );
  assert.equal(await expiredAtCapOwner.reclaimStuckProcessing(60_000), 1);
  assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_events WHERE event_uuid=$1`, [expiredAtCapId])).rowCount, 0);
  assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_dlq WHERE event_uuid=$1`, [expiredAtCapId])).rowCount, 1);
  const expiredAtCapAudit = await pool.query(
    `SELECT action, from_status, to_status
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND subject_id=$1
     ORDER BY audit_sequence`,
    [expiredAtCapId]
  );
  assert.deepEqual(
    expiredAtCapAudit.rows.map((row) => row.action),
    ["claim", "reclaim", "failure", "dlq"]
  );
  assert.deepEqual(
    expiredAtCapAudit.rows.slice(1).map((row) => [row.from_status, row.to_status]),
    [["processing", "processing"], ["processing", "processing"], ["processing", "failed"]]
  );
  console.log("PASS an expired processing lease at the effective cap is atomically audited and archived to DLQ");

  const retryEventId = await insertPendingEvent(0, 4);
  const retryOwner = worker("retry-owner", 80, 4);
  const firstRetryClaim = await retryOwner.claimOutboxEventById(retryEventId);
  assert.ok(firstRetryClaim);
  await retryOwner.markOutboxFailed(retryEventId, Number(firstRetryClaim.lease_generation), new Error("retry-one"));
  const firstDelayMs = await retryDelayFromDb(retryEventId);
  assert.ok(firstDelayMs >= 75 && firstDelayMs <= 100, `first DB retry delay was ${firstDelayMs}ms`);

  await wait(130);
  const secondRetryClaim = await retryOwner.claimOutboxEventById(retryEventId);
  assert.ok(secondRetryClaim);
  assert.equal(Number(secondRetryClaim.attempt_count), 2);
  assert.equal(Number(secondRetryClaim.lease_generation), 2);
  await retryOwner.markOutboxFailed(retryEventId, Number(secondRetryClaim.lease_generation), new Error("retry-two"));
  const secondDelayMs = await retryDelayFromDb(retryEventId);
  assert.ok(secondDelayMs >= 155 && secondDelayMs <= 180, `second DB retry delay was ${secondDelayMs}ms`);
  assert.ok(secondDelayMs > firstDelayMs, `${secondDelayMs} must exceed ${firstDelayMs}`);

  const retryAudit = await pool.query(
    `SELECT action, attempt_count, metadata
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND subject_id=$1 AND action='retry'
     ORDER BY audit_sequence`,
    [retryEventId]
  );
  assert.equal(retryAudit.rowCount, 2);
  assert.deepEqual(retryAudit.rows.map((row) => Number(row.attempt_count)), [1, 2]);
  assert.deepEqual(retryAudit.rows.map((row) => Number(row.metadata.retry_delay_ms)), [80, 160]);
  console.log("PASS retry backoff increases and persisted available_at matches the DB-calculated schedule");

  const poisonCappedId = await insertPendingEvent(4, 4);
  const healthyCappedId = await insertPendingEvent(4, 4);
  const healthyPendingId = await insertPendingEvent(0, 4);
  await pool.query(
    `UPDATE siton.outbox_events
     SET created_at=CASE event_uuid
       WHEN $1::uuid THEN '2000-01-01T00:00:00Z'::timestamptz
       WHEN $2::uuid THEN '2000-01-01T00:00:01Z'::timestamptz
       ELSE '2000-01-01T00:00:02Z'::timestamptz
     END
     WHERE event_uuid = ANY($3::uuid[])`,
    [poisonCappedId, healthyCappedId, [poisonCappedId, healthyCappedId, healthyPendingId]]
  );
  await pool.query(
    `INSERT INTO siton.outbox_dlq (
       event_uuid, event_type, aggregate_type, aggregate_id, payload,
       status, attempt_count, max_attempts, available_at, sent, last_error
     )
     SELECT event_uuid, event_type, aggregate_type, aggregate_id, payload,
            'failed', attempt_count, max_attempts, available_at, false, 'preexisting_dlq_conflict'
     FROM siton.outbox_events
     WHERE event_uuid=$1`,
    [poisonCappedId]
  );
  const isolationOwner = worker("poison-row-isolation-owner");
  const isolatedBatch = await isolationOwner.claimOutboxBatch(10);
  assert.equal(isolatedBatch.some((event) => event.event_uuid === poisonCappedId), false);
  assert.equal(isolatedBatch.some((event) => event.event_uuid === healthyCappedId), false);
  const healthyPendingClaim = isolatedBatch.find((event) => event.event_uuid === healthyPendingId);
  assert.ok(healthyPendingClaim, "a poison DLQ conflict must not block a healthy pending claim");
  const poisonActive = await eventRow(poisonCappedId);
  assert.ok(poisonActive);
  assert.equal(poisonActive.status, "failed");
  assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_dlq WHERE event_uuid=$1`, [poisonCappedId])).rowCount, 1);
  assert.equal(
    (await pool.query(
      `SELECT 1 FROM siton.operational_recovery_audit
       WHERE subject_type='outbox_event' AND subject_id=$1
         AND action='failure' AND reason_code='pending_dlq_archive_conflict'`,
      [poisonCappedId]
    )).rowCount,
    1
  );
  assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_events WHERE event_uuid=$1`, [healthyCappedId])).rowCount, 0);
  assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_dlq WHERE event_uuid=$1`, [healthyCappedId])).rowCount, 1);
  await isolationOwner.markOutboxSent(healthyPendingId, Number(healthyPendingClaim.lease_generation));
  console.log("PASS a capped poison row is isolated while healthy capped and pending rows continue");

  const claimAuditPoisonId = await insertPendingEvent(0, 4);
  const healthyAfterAuditPoisonId = await insertPendingEvent(0, 4);
  await pool.query(
    `UPDATE siton.outbox_events
     SET created_at=CASE event_uuid
       WHEN $1::uuid THEN '2000-01-02T00:00:00Z'::timestamptz
       ELSE '2000-01-02T00:00:01Z'::timestamptz
     END
     WHERE event_uuid = ANY($2::uuid[])`,
    [claimAuditPoisonId, [claimAuditPoisonId, healthyAfterAuditPoisonId]]
  );
  await pool.query(
    `INSERT INTO siton.operational_recovery_audit (
       subject_type, subject_id, action, worker_id, lease_generation,
       attempt_count, from_status, to_status, idempotency_key, reason_code, metadata
     ) VALUES ('outbox_event',$1,'claim','forged-owner',1,
               1,'pending','processing',$2,'forged_claim_collision','{}'::jsonb)`,
    [claimAuditPoisonId, `outbox:${claimAuditPoisonId}:1:claim:once`]
  );
  const claimIsolationOwner = worker("claim-audit-poison-isolation-owner");
  const claimIsolatedBatch = await claimIsolationOwner.claimOutboxBatch(2);
  const healthyAfterAuditPoison = claimIsolatedBatch.find(
    (event) => event.event_uuid === healthyAfterAuditPoisonId
  );
  assert.ok(healthyAfterAuditPoison, "a forged claim-audit collision must not roll back a healthy claim");
  const claimPoisonAfter = await eventRow(claimAuditPoisonId);
  assert.ok(claimPoisonAfter);
  assert.equal(claimPoisonAfter.status, "failed");
  assert.equal(claimPoisonAfter.worker_id, null);
  const quarantineAudit = await pool.query(
    `SELECT reason_code, from_status, to_status
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND subject_id=$1 AND reason_code='claim_audit_conflict'`,
    [claimAuditPoisonId]
  );
  assert.equal(quarantineAudit.rowCount, 1);
  assert.equal(quarantineAudit.rows[0]?.from_status, "pending");
  assert.equal(quarantineAudit.rows[0]?.to_status, "failed");
  await claimIsolationOwner.markOutboxSent(
    healthyAfterAuditPoisonId,
    Number(healthyAfterAuditPoison.lease_generation)
  );
  console.log("PASS a claim-audit poison row is quarantined without rolling back an independent healthy claim");

  const dlqEventId = await insertPendingEvent(1, 2);
  const dlqRequestId = `request:${randomUUID()}`;
  await pool.query(`UPDATE siton.outbox_events SET request_id=$2 WHERE event_uuid=$1`, [dlqEventId, dlqRequestId]);
  const dlqOwner = worker("dlq-owner", 80, 2);
  const finalClaim = await dlqOwner.claimOutboxEventById(dlqEventId);
  assert.ok(finalClaim);
  assert.equal(Number(finalClaim.attempt_count), 2);
  await dlqOwner.markOutboxFailed(dlqEventId, Number(finalClaim.lease_generation), new Error("max-attempt-proof"));

  assert.equal((await pool.query(`SELECT 1 FROM siton.outbox_events WHERE event_uuid=$1`, [dlqEventId])).rowCount, 0);
  const dlq = await pool.query(
    `SELECT status, attempt_count, max_attempts, lease_generation, last_error, payload, request_id
     FROM siton.outbox_dlq
     WHERE event_uuid=$1`,
    [dlqEventId]
  );
  assert.equal(dlq.rowCount, 1);
  const dlqRow = dlq.rows[0] as Record<string, any> | undefined;
  assert.ok(dlqRow);
  assert.equal(dlqRow.status, "failed");
  assert.equal(Number(dlqRow.attempt_count), 2);
  assert.equal(Number(dlqRow.max_attempts), 2);
  assert.equal(Number(dlqRow.lease_generation), 1);
  assert.match(String(dlqRow.last_error), /max-attempt-proof/);
  assert.equal(dlqRow.payload.probe, "no_external_side_effect");
  assert.equal(dlqRow.request_id, dlqRequestId);
  console.log("PASS max attempts atomically archives the event in DLQ with request_id preserved");

  const lifecycle = await pool.query<{ action: string; idempotency_key: string }>(
    `SELECT action, idempotency_key
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND subject_id = ANY($1::text[])
     ORDER BY audit_sequence`,
    [[raceEventId, retryEventId, dlqEventId]]
  );
  const actions = new Set(lifecycle.rows.map((row) => row.action));
  for (const required of ["claim", "reclaim", "completion", "retry", "failure", "dlq"]) {
    assert.ok(actions.has(required), `missing lifecycle audit action ${required}`);
  }
  assert.equal(new Set(lifecycle.rows.map((row) => row.idempotency_key)).size, lifecycle.rowCount);

  const reclaimAudit = lifecycle.rows.filter((row) => row.action === "reclaim");
  assert.equal(reclaimAudit.length, 1, "the reclaim race must append one reclaim audit only");
  assert.equal(externalSideEffectCalls, 0);

  const preservedPayloads = await pool.query(
    `SELECT payload FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[])
     UNION ALL
     SELECT payload FROM siton.outbox_dlq WHERE event_uuid = ANY($1::uuid[])`,
    [[raceEventId, retryEventId, dlqEventId]]
  );
  assert.ok(preservedPayloads.rows.length >= 3);
  assert.ok(preservedPayloads.rows.every((row) => row.payload.probe === "no_external_side_effect"));
  console.log("PASS lifecycle audit covers claim/reclaim/completion/retry/failure/DLQ with zero external handler calls");

  const adminTargetId = await insertPendingEvent(1, 4);
  const adminDistractorId = await insertPendingEvent(1, 4);
  const targetBeforeAdmin = await eventRow(adminTargetId);
  const distractorBeforeAdmin = await eventRow(adminDistractorId);
  assert.ok(targetBeforeAdmin && distractorBeforeAdmin);
  const adminAction = await withTx((client) => insertAdminAction(client, {
    action_type: "requeue_outbox_event",
    target_type: "outbox",
    target_id: adminTargetId,
    reason: "isolated operational recovery proof",
    idempotency_key: `admin-requeue:${randomUUID()}`,
    request_id: `request:${randomUUID()}`,
    correlation_id: `correlation:${randomUUID()}`,
    admin_id: "stage32b-proof-admin"
  }));
  const adminExecution = await withTx((client) => executeAdminAction(client, adminAction.admin_action_id, {
    admin_id: "stage32b-proof-admin",
    request_id: `request:${randomUUID()}`,
    correlation_id: `correlation:${randomUUID()}`
  }));
  assert.equal(adminExecution.statusCode, 200);
  assert.equal((adminExecution.body as any).action.result_code, "Requeued");
  const targetAfterAdmin = await eventRow(adminTargetId);
  const distractorAfterAdmin = await eventRow(adminDistractorId);
  assert.ok(targetAfterAdmin && distractorAfterAdmin);
  assert.equal(targetAfterAdmin.event_uuid, adminTargetId);
  assert.equal(targetAfterAdmin.status, "pending");
  assert.equal(targetAfterAdmin.sent, false);
  assert.equal(targetAfterAdmin.sent_at, null);
  assert.equal(Number(targetAfterAdmin.lease_generation), Number(targetBeforeAdmin.lease_generation) + 1);
  assert.equal(Number(distractorAfterAdmin.lease_generation), Number(distractorBeforeAdmin.lease_generation));
  const adminAudit = await pool.query(
    `SELECT action, reason_code, worker_id, lease_generation
     FROM siton.operational_recovery_audit
     WHERE subject_type='outbox_event' AND subject_id=$1 AND action='retry'
     ORDER BY audit_sequence`,
    [adminTargetId]
  );
  assert.equal(adminAudit.rowCount, 1);
  assert.equal(adminAudit.rows[0].reason_code, "admin_requeue");
  assert.equal(adminAudit.rows[0].worker_id, "admin:stage32b-proof-admin");
  assert.equal(Number(adminAudit.rows[0].lease_generation), Number(targetAfterAdmin.lease_generation));

  const configuredAdminCap = Number(process.env.OUTBOX_MAX_ATTEMPTS || 4);
  const adminGlobalCap = Number.isSafeInteger(configuredAdminCap) && configuredAdminCap >= 1 ? configuredAdminCap : 4;
  assert.ok(adminGlobalCap < 50, "the isolated test cap must leave room above the global cap");
  const cappedAdminTargetId = await insertPendingEvent(adminGlobalCap, adminGlobalCap + 1);
  const cappedBeforeAdmin = await eventRow(cappedAdminTargetId);
  assert.ok(cappedBeforeAdmin);
  const cappedAdminAction = await withTx((client) => insertAdminAction(client, {
    action_type: "requeue_outbox_event",
    target_type: "outbox",
    target_id: cappedAdminTargetId,
    reason: "global retry cap proof",
    idempotency_key: `admin-requeue-cap:${randomUUID()}`,
    request_id: `request:${randomUUID()}`,
    correlation_id: `correlation:${randomUUID()}`,
    admin_id: "stage32b-proof-admin"
  }));
  const cappedAdminExecution = await withTx((client) => executeAdminAction(client, cappedAdminAction.admin_action_id, {
    admin_id: "stage32b-proof-admin",
    request_id: `request:${randomUUID()}`,
    correlation_id: `correlation:${randomUUID()}`
  }));
  assert.equal(cappedAdminExecution.statusCode, 501);
  assert.equal((cappedAdminExecution.body as any).action.result_code, "NoEligibleOutboxEvent");
  const cappedAfterAdmin = await eventRow(cappedAdminTargetId);
  assert.ok(cappedAfterAdmin);
  assert.equal(cappedAfterAdmin.status, "pending");
  assert.equal(Number(cappedAfterAdmin.lease_generation), Number(cappedBeforeAdmin.lease_generation));
  assert.equal(
    (await pool.query(
      `SELECT 1 FROM siton.operational_recovery_audit
       WHERE subject_type='outbox_event' AND subject_id=$1 AND reason_code='admin_requeue'`,
      [cappedAdminTargetId]
    )).rowCount,
    0
  );
  console.log("PASS admin requeue targets the exact UUID, preserves sent=false, fences generation, audits, and honors the global cap");
} finally {
  await pool.end();
}
