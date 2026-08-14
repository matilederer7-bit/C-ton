import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildOutboxWorkerHelpers } from "../src/outbox_worker_helpers.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString });

class PermanentFailError extends Error {}
class DeferredEventError extends Error { retryAt = new Date(Date.now() + 1_000); }

async function withTx<T>(fn: (c: any) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

function helper(workerId: string, leaseMs = 30_000, maxAttempts = 3) {
  return buildOutboxWorkerHelpers({
    withTx,
    outboxPollMs: 10,
    outboxMaxAttempts: maxAttempts,
    workerId,
    leaseMs,
    PermanentFailErrorCtor: PermanentFailError,
    DeferredEventErrorCtor: DeferredEventError
  });
}

async function insertEvent(attemptCount = 0, maxAttempts = 3) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO siton.outbox_events
       (event_uuid,event_type,aggregate_type,aggregate_id,payload,status,attempt_count,max_attempts,available_at)
     VALUES ($1,'deadline_check','deal',$2,'{}','pending',$3,$4,now())`,
    [id, randomUUID(), attemptCount, maxAttempts]
  );
  return id;
}

const created: string[] = [];
try {
  const appSource = await readFile("src/app.ts", "utf8");
  const workerSource = await readFile("src/worker.ts", "utf8");
  const startBody = appSource.slice(appSource.indexOf("export async function startApplication"), appSource.indexOf("async function gracefulShutdown"));
  assert.doesNotMatch(startBody, /workerLoop|processNextPendingOutboxEvent|claimOutboxBatch/);
  assert.doesNotMatch(workerSource, /\.listen\s*\(|Fastify\s*\(/);
  assert.match(workerSource, /SIGTERM/);
  assert.match(workerSource, /worker_heartbeats/);
  console.log("PASS API startup has no worker and standalone worker has no HTTP listener");

  const workers = [helper("worker-a"), helper("worker-b"), helper("worker-c")];
  for (let i = 0; i < 30; i++) created.push(await insertEvent());
  const batches = await Promise.all(workers.map((worker) => worker.claimOutboxBatch(10)));
  const claimed = batches.flat();
  assert.equal(claimed.length, 30);
  assert.equal(new Set(claimed.map((row) => row.event_uuid)).size, 30);
  for (let i = 0; i < workers.length; i++) {
    assert.ok(batches[i]!.every((row) => row.worker_id === `worker-${String.fromCharCode(97 + i)}`));
  }
  console.log("PASS three workers claim 30 jobs exactly once with explicit ownership");

  const owned = claimed[0];
  assert.ok(owned);
  await assert.rejects(
    workers[1]!.markOutboxSent(owned.event_uuid, owned.lease_generation),
    /outbox lease lost/
  );
  let state = await pool.query(`SELECT status,worker_id FROM siton.outbox_events WHERE event_uuid=$1`, [owned.event_uuid]);
  assert.equal(state.rows[0].status, "processing");
  await workers[0]!.markOutboxSent(owned.event_uuid, owned.lease_generation);
  state = await pool.query(`SELECT status,worker_id FROM siton.outbox_events WHERE event_uuid=$1`, [owned.event_uuid]);
  assert.equal(state.rows[0].status, "sent");
  console.log("PASS only the lease owner can mark a job complete");

  const leaseId = await insertEvent();
  created.push(leaseId);
  const shortOwner = helper("short-owner", 5_000);
  const shortClaim = await shortOwner.claimOutboxEventById(leaseId);
  assert.ok(shortClaim);
  assert.equal(await shortOwner.heartbeatOutboxLease(leaseId, shortClaim.lease_generation), true);
  assert.equal(await workers[1]!.reclaimStuckProcessing(60_000), 0);
  await pool.query(`UPDATE siton.outbox_events SET lease_expires_at=now()-interval '1 second' WHERE event_uuid=$1`, [leaseId]);
  assert.equal(await workers[1]!.reclaimStuckProcessing(60_000), 1);
  const reclaimed = await workers[1]!.claimOutboxEventById(leaseId);
  assert.equal(reclaimed?.worker_id, "worker-b");
  assert.equal(reclaimed?.attempt_count, 2);
  console.log("PASS active lease heartbeat prevents reclaim and expired lease is recoverable with attempts preserved");

  const dlqId = await insertEvent(2, 3);
  created.push(dlqId);
  const dlqOwner = helper("dlq-owner", 30_000, 3);
  const finalAttempt = await dlqOwner.claimOutboxEventById(dlqId);
  assert.equal(finalAttempt?.attempt_count, 3);
  assert.ok(finalAttempt);
  await dlqOwner.markOutboxFailed(dlqId, finalAttempt.lease_generation, new Error("bounded_failure"));
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM siton.outbox_events WHERE event_uuid=$1`, [dlqId])).rows[0].count, 0);
  const dlq = await pool.query(`SELECT attempt_count,last_error FROM siton.outbox_dlq WHERE event_uuid=$1`, [dlqId]);
  assert.equal(dlq.rows[0].attempt_count, 3);
  assert.match(dlq.rows[0].last_error, /bounded_failure/);
  console.log("PASS max attempts moves the job to visible DLQ without restart reset");
} finally {
  await pool.query(`DELETE FROM siton.outbox_dlq WHERE event_uuid = ANY($1::uuid[])`, [created]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.outbox_events WHERE event_uuid = ANY($1::uuid[])`, [created]).catch(() => undefined);
  await pool.end();
}
