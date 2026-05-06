/**
 * Notification Operations Proof
 *
 * Four targeted tests for the operational surface:
 *
 *   O1 — notification with permanent_fail lands in status='failed', never 'sent'
 *   O2 — duplicate dispatch produces exactly one row per idempotency_key (DB truth)
 *   O3 — /api/admin/notifications-status returns correct counts after known inserts
 *   O4 — a retried notification that succeeds on the second attempt produces exactly
 *        one sent row — no duplicate send
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3395");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

import {
  enqueueNotification,
  flushPendingNotifications,
  type NotificationProvider,
  type NotificationForProvider,
  type NotificationProviderResult
} from "../src/notification_dispatch.js";

const DB_URL = process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function cleanupKey(idempotencyKey: string) {
  await pool.query(
    `DELETE FROM siton.notification_events WHERE idempotency_key=$1`,
    [idempotencyKey]
  );
}

async function getRow(idempotencyKey: string) {
  const r = await pool.query(
    `SELECT n.status, n.last_error, n.sent_at, n.notification_id,
            (SELECT COUNT(*) FROM siton.notification_attempts WHERE notification_id=n.notification_id)::int AS attempt_count,
            (SELECT provider_message_id FROM siton.notification_attempts WHERE notification_id=n.notification_id AND result_status='success' LIMIT 1) AS provider_message_id
     FROM siton.notification_events n WHERE n.idempotency_key=$1`,
    [idempotencyKey]
  );
  return r.rows[0] ?? null;
}

async function prioritizeKey(idempotencyKey: string) {
  await pool.query(
    `UPDATE siton.notification_events
     SET created_at='2000-01-01T00:00:00Z', scheduled_for=NULL
     WHERE idempotency_key=$1`,
    [idempotencyKey]
  );
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

const TEST_DEAL_ID = randomUUID();

// ─── O1: permanent_fail → status='failed', never 'sent' ──────────────────────

await run("O1 — permanent_fail provider marks status=failed, not sent", async () => {
  const idemKey = `test:buyer_deal_failed:o1:${randomUUID()}`;
  try {
    await enqueueNotification({
      event_type: "buyer_deal_failed",
      recipient_type: "buyer",
      recipient_ref: "+972501234567",
      deal_id: TEST_DEAL_ID,
      channel: "sms",
      idempotency_key: idemKey,
      payload_jsonb: { deal_title: "Test Deal O1" }
    }, pool);

    const permanentFailProvider: NotificationProvider = {
      providerCode: "test-permanent-fail",
      mode: "real",
      async send(_: NotificationForProvider): Promise<NotificationProviderResult> {
        return { status: "permanent_fail", error_code: "provider_rejected", error_message: "test_permanent_rejection" };
      }
    };

    const row0 = await getRow(idemKey);
    assert.ok(row0, "row must exist after enqueue");
    await prioritizeKey(idemKey);
    await flushPendingNotifications(pool, permanentFailProvider);

    const row = await getRow(idemKey);
    console.log(`     status=${row?.status} last_error=${row?.last_error}`);
    assert.equal(row?.status, "failed", `should be failed after permanent_fail, got ${row?.status}`);
    assert.equal(row?.sent_at, null, "sent_at must be null — not sent");
    assert.equal(row?.attempt_count, 1, "permanent failure should record exactly one attempt");
    assert.ok(row?.last_error, "last_error should be set");
  } finally {
    await cleanupKey(idemKey);
  }
});

// ─── O2: Duplicate dispatch = one row (DB truth) ─────────────────────────────

await run("O2 — duplicate dispatch for same idempotency_key produces exactly one DB row", async () => {
  const idemKey = `test:buyer_joined_authorized:o2:${randomUUID()}`;
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enqueueNotification({
        event_type: "buyer_joined_authorized",
        recipient_type: "buyer",
        recipient_ref: "+972509876543",
        deal_id: TEST_DEAL_ID,
        channel: "sms",
        idempotency_key: idemKey,
        payload_jsonb: { deal_title: "Test Deal O2" }
      }, pool))
    );

    const queued    = results.filter(r => r === "queued").length;
    const duplicates = results.filter(r => r === "duplicate").length;
    const rowCount  = await pool.query(
      `SELECT COUNT(*) AS cnt FROM siton.notification_events WHERE idempotency_key=$1`,
      [idemKey]
    );

    console.log(`     queued=${queued} duplicate=${duplicates} db_rows=${rowCount.rows[0].cnt}`);
    assert.equal(Number(rowCount.rows[0].cnt), 1, "exactly 1 DB row regardless of concurrent inserts");
    assert.equal(queued,    1, "exactly 1 should report 'queued'");
    assert.equal(duplicates, 9, "9 should report 'duplicate'");
  } finally {
    await cleanupKey(idemKey);
  }
});

// ─── O3: Endpoint returns correct counts ─────────────────────────────────────

await run("O3 — /api/admin/notifications-status returns correct bucket counts", async () => {
  const idemPending = `test:buyer_deal_target_reached:o3pending:${randomUUID()}`;
  const idemFailed  = `test:buyer_deal_failed:o3failed:${randomUUID()}`;
  try {
    // Insert one known pending notification
    await enqueueNotification({
      event_type: "buyer_deal_target_reached",
      recipient_type: "buyer",
      recipient_ref: "+972501111111",
      deal_id: TEST_DEAL_ID,
      channel: "sms",
      idempotency_key: idemPending,
      payload_jsonb: { deal_title: "Test Deal O3" }
    }, pool);

    // Insert one that we then manually set to 'failed'
    await enqueueNotification({
      event_type: "buyer_deal_failed",
      recipient_type: "buyer",
      recipient_ref: "+972502222222",
      deal_id: TEST_DEAL_ID,
      channel: "sms",
      idempotency_key: idemFailed,
      payload_jsonb: { deal_title: "Test Deal O3 Failed" }
    }, pool);
    await pool.query(
      `UPDATE siton.notification_events SET status='failed', last_error='test_failure' WHERE idempotency_key=$1`,
      [idemFailed]
    );

    const res = await app.inject({ method: "GET", url: "/api/admin/notifications-status" });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(typeof body.notifications.pending === "number");
    assert.ok(typeof body.notifications.sent === "number");
    assert.ok(typeof body.notifications.failed === "number");
    assert.ok(typeof body.notifications.unique_event_keys === "number");
    assert.ok(Array.isArray(body.by_channel), "by_channel should be an array");

    // Our inserted rows should be reflected
    assert.ok(body.notifications.pending >= 1, `pending should be >= 1`);
    assert.ok(body.notifications.failed >= 1, `failed should be >= 1`);
    assert.ok(body.notifications.unique_event_keys >= 2, `unique_event_keys should be >= 2`);

    const smsChannel = body.by_channel.find((c: any) => c.channel === "sms");
    assert.ok(smsChannel, "sms channel should appear in by_channel");

    console.log(`     notifications=${JSON.stringify(body.notifications)}`);
    console.log(`     by_channel=${JSON.stringify(body.by_channel)}`);
  } finally {
    await cleanupKey(idemPending);
    await cleanupKey(idemFailed);
  }
});

// ─── O4: Retry that succeeds = one sent row, no duplicate ────────────────────

await run("O4 — retry-then-succeed produces exactly one sent row, no duplicate", async () => {
  const idemKey = `test:buyer_deal_completed:o4:${randomUUID()}`;
  try {
    await enqueueNotification({
      event_type: "buyer_deal_completed",
      recipient_type: "buyer",
      recipient_ref: "+972503333333",
      deal_id: TEST_DEAL_ID,
      channel: "sms",
      idempotency_key: idemKey,
      payload_jsonb: { deal_title: "Test Deal O4" }
    }, pool);

    const row0 = await getRow(idemKey);
    assert.ok(row0, "row must exist after enqueue");
    const targetNotificationId = String(row0.notification_id);
    let targetCalls = 0;
    const failThenSucceedProvider: NotificationProvider = {
      providerCode: "fail-then-succeed",
      mode: "real",
      async send(notification: NotificationForProvider): Promise<NotificationProviderResult> {
        if (notification.notification_id !== targetNotificationId) {
          return { status: "temporary_fail", error_code: "non_target_deferred", error_message: "non-target event deferred by test provider" };
        }
        targetCalls++;
        if (targetCalls <= 1) return { status: "temporary_fail", error_code: "temp_error", error_message: `deliberate_failure_${targetCalls}` };
        return { status: "success", provider_message_id: `ok-${targetCalls}` } as any;
      }
    };

    // Attempt 1: temporary_fail
    await prioritizeKey(idemKey);
    await flushPendingNotifications(pool, failThenSucceedProvider);
    const after1 = await getRow(idemKey);
    assert.equal(after1?.status, "pending", `should be pending after first failure`);

    // Reset scheduled_for so flush 2 can pick it up immediately
    await pool.query(
      `UPDATE siton.notification_events
       SET scheduled_for=NULL, created_at='2000-01-01T00:00:00Z'
       WHERE idempotency_key=$1`,
      [idemKey]
    );

    // Attempt 2: success
    await flushPendingNotifications(pool, failThenSucceedProvider);

    const count = await pool.query(
      `SELECT COUNT(*) AS cnt FROM siton.notification_events WHERE idempotency_key=$1`,
      [idemKey]
    );
    const row = await getRow(idemKey);

    console.log(`     target_provider_calls=${targetCalls} rows=${count.rows[0].cnt} status=${row?.status} message_id=${row?.provider_message_id}`);

    assert.equal(Number(count.rows[0].cnt), 1, "exactly 1 row — no duplicates");
    assert.equal(row?.status, "sent", `should be sent after successful retry`);
    assert.equal(row?.attempt_count, 2, "retry path should record both attempts");
    assert.equal(targetCalls, 2, "target notification should fail once and then succeed once");
    assert.notEqual(row?.sent_at, null, "sent_at should be set");
    assert.ok(row?.provider_message_id?.startsWith("ok-"), `message_id should be from successful send`);
  } finally {
    await cleanupKey(idemKey);
  }
});

await app.close().catch(() => undefined);
await pool.end();
console.log("\nAll notification ops proof tests completed.");
