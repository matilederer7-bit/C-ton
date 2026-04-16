/**
 * Notification Operations Proof
 *
 * Four targeted tests for the operational surface:
 *
 *   O1 — notification exhausting max_attempts lands in status='failed', never status='sent'
 *   O2 — duplicate dispatch produces exactly one row per event_key+channel (DB truth)
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

import { enqueueNotification, flushPendingNotifications, buildSmsProvider } from "../src/notification_dispatch.js";

const DB_URL = process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function cleanupKey(eventKey: string) {
  await pool.query(`DELETE FROM siton.notifications WHERE event_key=$1`, [eventKey]);
}

async function getRow(eventKey: string) {
  const r = await pool.query(
    `SELECT status, attempt_count, provider_message_id, last_error, sent_at
     FROM siton.notifications WHERE event_key=$1`,
    [eventKey]
  );
  return r.rows[0] ?? null;
}

// A provider that always fails — used to exhaust max_attempts
function buildAlwaysFailProvider(name = "test-always-fail") {
  return {
    providerCode: name,
    mode: "real" as const,
    async sendSms(_to: string, _body: string): Promise<{ messageId: string }> {
      throw new Error(`${name}_error`);
    }
  };
}

// A provider that fails on the first N calls, then succeeds
function buildFailThenSucceedProvider(failCount: number) {
  let calls = 0;
  return {
    providerCode: "fail-then-succeed",
    mode: "real" as const,
    callCount: () => calls,
    async sendSms(_to: string, _body: string): Promise<{ messageId: string }> {
      calls++;
      if (calls <= failCount) throw new Error(`deliberate_failure_${calls}`);
      return { messageId: `ok-${calls}` };
    }
  };
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

// ─── O1: Exhausted retries → status='failed', never 'sent' ──────────────────

await run("O1 — exhausting max_attempts marks status=failed, not sent", async () => {
  const eventKey = `deal_failed:${randomUUID()}:sms`;
  try {
    // Insert with max_attempts=2 so we can exhaust quickly
    await pool.query(
      `INSERT INTO siton.notifications
         (event_key, notification_event_type, channel, recipient, template_id,
          template_params, status, attempt_count, max_attempts, provider_code,
          available_at, created_at, updated_at)
       VALUES ($1,'deal_failed','sms','+972501234567','deal_failed/sms/v1',
               $2,'pending',0,2,'log-only',now(),now(),now())`,
      [eventKey, JSON.stringify({ deal_id: randomUUID(), deal_title: "Test", participant_id: randomUUID() })]
    );

    const failProvider = buildAlwaysFailProvider();

    // Flush 1: attempt_count → 1, status=pending
    await flushPendingNotifications(pool, failProvider);
    const after1 = await getRow(eventKey);
    assert.equal(after1?.status, "pending", `after 1st failure should be pending for retry, got ${after1?.status}`);
    assert.equal(after1?.attempt_count, 1);

    // Fast-forward available_at so it's claimable again immediately
    await pool.query(`UPDATE siton.notifications SET available_at=now() WHERE event_key=$1`, [eventKey]);

    // Flush 2: attempt_count reaches max_attempts=2 → permanent failed
    await flushPendingNotifications(pool, failProvider);
    const after2 = await getRow(eventKey);

    console.log(`     attempt1=${after1?.attempt_count} status1=${after1?.status} → attempt2=${after2?.attempt_count} status2=${after2?.status}`);
    console.log(`     last_error=${after2?.last_error}`);

    assert.equal(after2?.status, "failed", `should be permanently failed after max_attempts, got ${after2?.status}`);
    assert.equal(after2?.sent_at, null, `sent_at must be null — not sent`);
    assert.ok(after2?.last_error?.includes("max_attempts_exceeded"), `last_error should mention max_attempts_exceeded`);
  } finally {
    await cleanupKey(eventKey);
  }
});

// ─── O2: Duplicate dispatch = one row (DB truth) ─────────────────────────────

await run("O2 — duplicate dispatch for same event_key produces exactly one DB row", async () => {
  const eventKey = `join_authorized:${randomUUID()}:sms`;
  try {
    const params = { deal_id: randomUUID(), deal_title: "D", participant_id: randomUUID() };
    const base = { notificationEventType: "join_authorized" as const, channel: "sms" as const, recipient: "+972509876543", templateParams: params, providerCode: "log-only" };

    // Fire 10 concurrent enqueues with the same event_key
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enqueueNotification({ eventKey, ...base }, pool))
    );

    const queued = results.filter(r => r === "queued").length;
    const duplicates = results.filter(r => r === "duplicate").length;
    const rowCount = await pool.query(`SELECT COUNT(*) AS cnt FROM siton.notifications WHERE event_key=$1`, [eventKey]);

    console.log(`     queued=${queued} duplicate=${duplicates} db_rows=${rowCount.rows[0].cnt}`);

    assert.equal(Number(rowCount.rows[0].cnt), 1, `exactly 1 DB row regardless of concurrent inserts`);
    assert.equal(queued, 1, `exactly 1 should report 'queued'`);
    assert.equal(duplicates, 9, `9 should report 'duplicate'`);
  } finally {
    await cleanupKey(eventKey);
  }
});

// ─── O3: Endpoint returns correct counts ─────────────────────────────────────

await run("O3 — /api/admin/notifications-status returns correct bucket counts", async () => {
  // Insert one known pending and one known failed notification
  const keyPending = `charge_succeeded:${randomUUID()}:sms`;
  const keyFailed  = `charge_failed_recovery:${randomUUID()}:sms`;
  try {
    const params = JSON.stringify({ deal_id: randomUUID(), deal_title: "T", participant_id: randomUUID() });
    await pool.query(
      `INSERT INTO siton.notifications
         (event_key, notification_event_type, channel, recipient, template_id,
          template_params, status, attempt_count, max_attempts, provider_code,
          available_at, created_at, updated_at)
       VALUES ($1,'charge_succeeded','sms','+972501111111','charge_succeeded/sms/v1',$2,'pending',0,3,'log-only',now(),now(),now())`,
      [keyPending, params]
    );
    await pool.query(
      `INSERT INTO siton.notifications
         (event_key, notification_event_type, channel, recipient, template_id,
          template_params, status, attempt_count, max_attempts, provider_code, last_error,
          available_at, created_at, updated_at)
       VALUES ($1,'charge_failed_recovery','sms','+972502222222','charge_failed_recovery/sms/v1',$2,'failed',3,3,'log-only','max_attempts_exceeded',now(),now(),now())`,
      [keyFailed, params]
    );

    const res = await app.inject({ method: "GET", url: "/api/admin/notifications-status" });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(typeof body.notifications.pending === "number");
    assert.ok(typeof body.notifications.sent === "number");
    assert.ok(typeof body.notifications.failed === "number");
    assert.ok(typeof body.notifications.unique_event_keys === "number");
    assert.ok(Array.isArray(body.by_channel), `by_channel should be an array`);

    // Our inserted known rows should be reflected
    assert.ok(body.notifications.pending >= 1, `pending should be >= 1`);
    assert.ok(body.notifications.failed >= 1, `failed should be >= 1`);
    assert.ok(body.notifications.unique_event_keys >= 2, `unique_event_keys should be >= 2`);

    const smsChannel = body.by_channel.find((c: any) => c.channel === "sms");
    assert.ok(smsChannel, "sms channel should appear in by_channel");

    console.log(`     notifications=${JSON.stringify(body.notifications)}`);
    console.log(`     by_channel=${JSON.stringify(body.by_channel)}`);
  } finally {
    await cleanupKey(keyPending);
    await cleanupKey(keyFailed);
  }
});

// ─── O4: Retry that succeeds = one sent row, no duplicate ────────────────────

await run("O4 — retry-then-succeed produces exactly one sent row, no duplicate", async () => {
  const eventKey = `deal_completed:${randomUUID()}:sms`;
  try {
    await enqueueNotification({
      eventKey,
      notificationEventType: "deal_completed",
      channel: "sms",
      recipient: "+972503333333",
      templateParams: { deal_id: randomUUID(), deal_title: "Retry Deal", participant_id: randomUUID() },
      providerCode: "log-only"
    }, pool);

    // Flush 1 fails
    const provider = buildFailThenSucceedProvider(1); // fail on call 1, succeed on call 2
    await flushPendingNotifications(pool, provider);

    const after1 = await getRow(eventKey);
    assert.equal(after1?.status, "pending", `should be pending after first failure`);

    // Fast-forward available_at
    await pool.query(`UPDATE siton.notifications SET available_at=now() WHERE event_key=$1`, [eventKey]);

    // Flush 2 succeeds
    await flushPendingNotifications(pool, provider);

    // Verify exactly one row, status=sent
    const count = await pool.query(`SELECT COUNT(*) AS cnt FROM siton.notifications WHERE event_key=$1`, [eventKey]);
    const row = await getRow(eventKey);

    console.log(`     provider_calls=${provider.callCount()} rows=${count.rows[0].cnt} status=${row?.status} message_id=${row?.provider_message_id}`);

    assert.equal(Number(count.rows[0].cnt), 1, `exactly 1 row — no duplicates`);
    assert.equal(row?.status, "sent", `should be sent after successful retry`);
    assert.equal(row?.attempt_count, 2, `attempt_count should be 2`);
    assert.notEqual(row?.sent_at, null, `sent_at should be set`);
    assert.ok(row?.provider_message_id?.startsWith("ok-"), `message_id should be from successful send`);
  } finally {
    await cleanupKey(eventKey);
  }
});

await pool.end();
console.log("\nAll notification ops proof tests completed.");
