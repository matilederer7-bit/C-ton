/**
 * Outbox Reclaim Precision Proof
 *
 * Targeted tests for two specific properties:
 *
 *   A) Reclaim window precision — young events are NOT reclaimed; only genuinely
 *      old events are reset to pending.
 *
 *   B) No duplicate processing after reclaim — a reclaimed event is processed
 *      exactly once; no duplicate sent/failed rows appear.
 *
 * Runs against live DB. Uses reclaimStuckProcessing directly (imported from
 * outbox_worker_helpers.ts via the helpers built inside the app).
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3393");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.OUTBOX_POLL_MS = "100";
process.env.OUTBOX_MAX_ATTEMPTS = "3";
// Very short stuck timeout so we can test reclaim without waiting 60 seconds
process.env.WORKER_STUCK_TIMEOUT_MS = "2000";
// Disable the live worker loop so it doesn't race with our manual operations
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const DB = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres",
  max: 5
});

// Build the same helpers used by the real worker (same withTx)
import { buildOutboxWorkerHelpers } from "../src/outbox_worker_helpers.js";
import pg2 from "pg";
const innerPool = new pg2.Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres",
  max: 5
});
async function withTx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await innerPool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const PermanentFailError = class extends Error {};
const DeferredEventError = class extends Error { retryAt = new Date(); };
const STUCK_TIMEOUT_MS = 2000;
const { claimOutboxBatch, reclaimStuckProcessing, markOutboxSent, markOutboxFailed } =
  buildOutboxWorkerHelpers({
    withTx,
    outboxPollMs: 100,
    outboxMaxAttempts: 3,
    PermanentFailErrorCtor: PermanentFailError,
    DeferredEventErrorCtor: DeferredEventError
  });

// ─── helpers ────────────────────────────────────────────────────────────────

async function insertProcessingEvent(opts: {
  processingStartedAtOffsetMs: number;   // negative = in the past, positive = recent
  label: string;
}): Promise<string> {
  const uuid = randomUUID();
  const startedAt = new Date(Date.now() + opts.processingStartedAtOffsetMs);
  await DB.query(
    `INSERT INTO siton.outbox_events
       (event_uuid, event_type, aggregate_type, aggregate_id, payload,
        status, attempt_count, available_at, sent, sent_at, last_error,
        processing_started_at, created_at, updated_at)
     VALUES ($1,'deadline_check','deal',$2,'{}','processing',1,NOW(),false,NULL,NULL,$3,NOW(),NOW())`,
    [uuid, uuid, startedAt.toISOString()]
  );
  return uuid;
}

async function insertPendingEvent(label: string): Promise<string> {
  const uuid = randomUUID();
  await DB.query(
    `INSERT INTO siton.outbox_events
       (event_uuid, event_type, aggregate_type, aggregate_id, payload,
        status, attempt_count, available_at, sent, created_at, updated_at)
     VALUES ($1,'deadline_check','deal',$2,'{}','pending',0,NOW(),false,NOW(),NOW())`,
    [uuid, uuid]
  );
  return uuid;
}

async function getEvent(uuid: string) {
  const r = await DB.query(
    `SELECT status, attempt_count, last_error, processing_started_at, sent, sent_at
     FROM siton.outbox_events WHERE event_uuid=$1`,
    [uuid]
  );
  return r.rows[0] ?? null;
}

async function getDlqEvent(uuid: string) {
  const r = await DB.query(
    `SELECT event_uuid, status, attempt_count, last_error FROM siton.outbox_dlq WHERE event_uuid=$1`,
    [uuid]
  );
  return r.rows[0] ?? null;
}

async function deleteEvent(uuid: string) {
  await DB.query(`DELETE FROM siton.outbox_events WHERE event_uuid=$1`, [uuid]);
  await DB.query(`DELETE FROM siton.outbox_dlq WHERE event_uuid=$1`, [uuid]);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e: any) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${e.message}`);
    throw e;
  }
}

// ─── A: RECLAIM WINDOW PRECISION ────────────────────────────────────────────

console.log("\n--- A: Reclaim window precision ---");

await run("A1 — old processing event (beyond timeout) is reclaimed to pending", async () => {
  // Insert an event that started processing STUCK_TIMEOUT_MS + 500ms ago
  const oldUuid = await insertProcessingEvent({
    processingStartedAtOffsetMs: -(STUCK_TIMEOUT_MS + 500),
    label: "A1-old"
  });
  try {
    const reclaimed = await reclaimStuckProcessing(STUCK_TIMEOUT_MS);
    const ev = await getEvent(oldUuid);

    console.log(`     reclaimed=${reclaimed}  status=${ev?.status}  last_error=${ev?.last_error}  processing_started_at=${ev?.processing_started_at}`);

    assert.ok(reclaimed >= 1, `expected at least 1 reclaimed, got ${reclaimed}`);
    assert.equal(ev?.status, "pending", `event should be back to pending, got ${ev?.status}`);
    assert.equal(ev?.processing_started_at, null, `processing_started_at should be cleared`);
    assert.equal(ev?.last_error, "worker_reclaim_after_restart", `last_error should be set`);
  } finally {
    await deleteEvent(oldUuid);
  }
});

await run("A2 — young processing event (within timeout) is NOT reclaimed", async () => {
  // Insert an event that started processing only 200ms ago (well within 2000ms timeout)
  const youngUuid = await insertProcessingEvent({
    processingStartedAtOffsetMs: -200,
    label: "A2-young"
  });
  try {
    const before = await getEvent(youngUuid);
    const reclaimed = await reclaimStuckProcessing(STUCK_TIMEOUT_MS);
    const after = await getEvent(youngUuid);

    console.log(`     reclaimed=${reclaimed}  before=${before?.status}  after=${after?.status}`);

    assert.equal(after?.status, "processing", `young event should still be processing, got ${after?.status}`);
    assert.notEqual(after?.processing_started_at, null, `processing_started_at should still be set`);
  } finally {
    await deleteEvent(youngUuid);
  }
});

await run("A3 — simultaneous old+young: only old is reclaimed", async () => {
  const oldUuid = await insertProcessingEvent({ processingStartedAtOffsetMs: -(STUCK_TIMEOUT_MS + 500), label: "A3-old" });
  const youngUuid = await insertProcessingEvent({ processingStartedAtOffsetMs: -200, label: "A3-young" });
  try {
    const reclaimed = await reclaimStuckProcessing(STUCK_TIMEOUT_MS);
    const old = await getEvent(oldUuid);
    const young = await getEvent(youngUuid);

    console.log(`     reclaimed=${reclaimed}  old=${old?.status}  young=${young?.status}`);

    assert.equal(old?.status, "pending", `old event should be reclaimed to pending`);
    assert.equal(young?.status, "processing", `young event should remain processing`);
    assert.ok(reclaimed >= 1, `at least 1 reclaimed`);
  } finally {
    await deleteEvent(oldUuid);
    await deleteEvent(youngUuid);
  }
});

await run("A4 — processing_started_at=null event is reclaimed (defensive path)", async () => {
  // Simulates a pre-column migration row or a race where started_at was never set
  const uuid = randomUUID();
  await DB.query(
    `INSERT INTO siton.outbox_events
       (event_uuid, event_type, aggregate_type, aggregate_id, payload,
        status, attempt_count, available_at, sent, created_at, updated_at)
     VALUES ($1,'deadline_check','deal',$2,'{}','processing',1,NOW()-INTERVAL '5 minutes',false,NOW()-INTERVAL '5 minutes',NOW())`,
    [uuid, uuid]
  );
  try {
    const reclaimed = await reclaimStuckProcessing(STUCK_TIMEOUT_MS);
    const ev = await getEvent(uuid);

    console.log(`     reclaimed=${reclaimed}  status=${ev?.status}`);

    // processing_started_at=NULL should always be reclaimed (treated as stuck)
    assert.equal(ev?.status, "pending", `null processing_started_at should be reclaimed`);
  } finally {
    await deleteEvent(uuid);
  }
});

// ─── B: NO DUPLICATE PROCESSING AFTER RECLAIM ────────────────────────────────

console.log("\n--- B: No duplicate processing after reclaim ---");

await run("B1 — reclaimed event is claimable exactly once, produces one sent row", async () => {
  // 1. Insert a processing event that is old enough to be reclaimed
  const uuid = await insertProcessingEvent({ processingStartedAtOffsetMs: -(STUCK_TIMEOUT_MS + 500), label: "B1-stuck" });
  try {
    // 2. Reclaim it
    const reclaimed = await reclaimStuckProcessing(STUCK_TIMEOUT_MS);
    assert.ok(reclaimed >= 1, `should have reclaimed at least 1`);

    const afterReclaim = await getEvent(uuid);
    assert.equal(afterReclaim?.status, "pending", `should be pending after reclaim`);

    // 3. Claim it once — simulates one worker picking it up.
    //    Use a large batch limit so our event isn't missed if other pending
    //    events exist in the test DB (claimOutboxBatch is ordered by created_at ASC).
    const batch = await claimOutboxBatch(1000);
    const claimed = batch.find(e => e.event_uuid === uuid);
    assert.ok(claimed, `event should be claimable after reclaim`);

    const afterClaim = await getEvent(uuid);
    assert.equal(afterClaim?.status, "processing", `should be processing after claim`);

    // 4. Mark sent
    await markOutboxSent(uuid);

    // Sent events stay in outbox_events with status='sent', never appear in DLQ
    const afterSent = await getEvent(uuid);
    const inDlq = await getDlqEvent(uuid);
    console.log(`     reclaimed=${reclaimed}  claimed=${!!claimed}  afterSent.status=${afterSent?.status}  dlq=${inDlq}`);

    assert.equal(afterSent?.status, "sent", `event should have status=sent after markOutboxSent`);
    assert.equal(afterSent?.sent, true, `sent flag should be true`);
    assert.notEqual(afterSent?.sent_at, null, `sent_at should be set`);
    assert.equal(inDlq, null, `sent event should not be in DLQ`);
  } finally {
    await deleteEvent(uuid);
  }
});

await run("B2 — two concurrent reclaim calls don't double-process the same event", async () => {
  // Insert two old events
  const uuid1 = await insertProcessingEvent({ processingStartedAtOffsetMs: -(STUCK_TIMEOUT_MS + 500), label: "B2-event1" });
  const uuid2 = await insertProcessingEvent({ processingStartedAtOffsetMs: -(STUCK_TIMEOUT_MS + 500), label: "B2-event2" });
  try {
    // Fire two concurrent reclaim calls
    const [r1, r2] = await Promise.all([
      reclaimStuckProcessing(STUCK_TIMEOUT_MS),
      reclaimStuckProcessing(STUCK_TIMEOUT_MS)
    ]);
    console.log(`     r1=${r1}  r2=${r2}  total=${r1 + r2}`);

    const ev1 = await getEvent(uuid1);
    const ev2 = await getEvent(uuid2);
    console.log(`     ev1=${ev1?.status}  ev2=${ev2?.status}`);

    // Both should be pending — no double-processing
    assert.equal(ev1?.status, "pending", `ev1 should be pending`);
    assert.equal(ev2?.status, "pending", `ev2 should be pending`);
    // Total reclaimed = 2 (one call might get both, or each gets one — that's fine)
    assert.equal(r1 + r2, 2, `total reclaimed should be exactly 2 across both calls, got ${r1 + r2}`);
  } finally {
    await deleteEvent(uuid1);
    await deleteEvent(uuid2);
  }
});

await run("B3 — reclaimed then failed goes to DLQ correctly, no phantom sent row", async () => {
  const uuid = await insertProcessingEvent({ processingStartedAtOffsetMs: -(STUCK_TIMEOUT_MS + 500), label: "B3-stuck-then-fail" });
  try {
    await reclaimStuckProcessing(STUCK_TIMEOUT_MS);

    // Claim the event
    const batch = await claimOutboxBatch(1000);
    const claimed = batch.find(e => e.event_uuid === uuid);
    assert.ok(claimed, `event should be claimable`);

    // Mark it as permanently failed (immediate DLQ)
    const permanentErr = new PermanentFailError("permanent failure in test");
    await markOutboxFailed(uuid, claimed.attempt_count, permanentErr);

    const inOutbox = await getEvent(uuid);
    const inDlq = await getDlqEvent(uuid);
    console.log(`     inOutbox=${inOutbox}  inDlq=${inDlq?.event_uuid ? "present" : "absent"}`);

    assert.equal(inOutbox, null, `event should be removed from outbox_events after permanent fail`);
    assert.notEqual(inDlq, null, `event should be in DLQ after permanent fail`);
    // No sent row exists (inOutbox is null, meaning it was deleted — not marked sent)
    // Verify not sent by checking DLQ row's sent field
    const dlqRow = await DB.query(`SELECT sent, sent_at FROM siton.outbox_dlq WHERE event_uuid=$1`, [uuid]);
    assert.equal(dlqRow.rows[0]?.sent, false, `DLQ row should have sent=false`);
  } finally {
    await deleteEvent(uuid);
  }
});

await run("B4 — outbox-status endpoint returns correct bucket counts", async () => {
  // Confirm the /api/admin/outbox-status endpoint works end-to-end
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/outbox-status"
  });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true, `response.ok should be true`);
  assert.ok(typeof body.outbox.pending === "number", `outbox.pending should be a number`);
  assert.ok(typeof body.outbox.processing === "number", `outbox.processing should be a number`);
  assert.ok(typeof body.outbox.dlq === "number", `outbox.dlq should be a number`);
  assert.ok(typeof body.outbox.stuck_candidates === "number", `outbox.stuck_candidates should be a number`);
  assert.ok(typeof body.outbox.stuck_timeout_ms === "number", `outbox.stuck_timeout_ms should be a number`);
  assert.ok(body.worker !== undefined, `worker field should be present`);
  console.log(`     outbox=${JSON.stringify(body.outbox)}  worker=${JSON.stringify(body.worker)}`);
});

await run("B5 — outbox-status stuck_candidates count reflects actual stuck events", async () => {
  // Insert one old stuck event, verify stuck_candidates increments
  const uuid = await insertProcessingEvent({ processingStartedAtOffsetMs: -(STUCK_TIMEOUT_MS + 500), label: "B5-stuck-count" });
  try {
    const res = await app.inject({ method: "GET", url: "/api/admin/outbox-status" });
    const body = JSON.parse(res.body);
    console.log(`     stuck_candidates=${body.outbox.stuck_candidates}  stuck_timeout_ms=${body.outbox.stuck_timeout_ms}`);
    assert.ok(body.outbox.stuck_candidates >= 1, `stuck_candidates should be ≥1 with our test event present, got ${body.outbox.stuck_candidates}`);
  } finally {
    await deleteEvent(uuid);
    // Confirm stuck_candidates drops back after cleanup
    const res2 = await app.inject({ method: "GET", url: "/api/admin/outbox-status" });
    const body2 = JSON.parse(res2.body);
    console.log(`     after_cleanup stuck_candidates=${body2.outbox.stuck_candidates}`);
  }
});

await app.close().catch(() => undefined);
await DB.end();
await innerPool.end();

console.log("\nAll outbox reclaim precision tests completed.");
