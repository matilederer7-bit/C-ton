import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// R9A — notification rail reliability + shared communications safety gate:
// bounded retries, crash reclaim, fail-closed provider construction, rendered
// SMS fallback bodies, and default-deny recipient safety for future real
// adapters. Real delivery count stays ZERO (log/test adapters only).

process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.NOTIFICATION_MAX_ATTEMPTS = "3";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const dispatch = await import(`../src/notification_dispatch.js?nrel-${Date.now()}`);
const safety = await import(`../src/notification_safety.js?nsafe-${Date.now()}`);
const {
  enqueueNotification,
  flushPendingNotifications,
  reclaimStrandedNotifications,
  buildNotificationProvider
} = dispatch;

let passed = 0;
let failed = 0;
async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${(error as any)?.message || error}`);
    failed += 1;
  }
}

async function enqueueTestNotification(suffix: string, recipient = "0501234567") {
  const dealId = randomUUID();
  await enqueueNotification(
    {
      event_type: "buyer_joined_authorized",
      recipient_type: "buyer",
      recipient_ref: recipient,
      deal_id: dealId,
      channel: "sms",
      payload_jsonb: { deal_id: dealId, deal_title: `Reliability deal ${suffix}` },
      idempotency_key: `nrel-${suffix}-${randomUUID()}`,
      correlation_id: `nrel-corr-${suffix}`
    },
    pool
  );
  const row = await pool.query(
    `SELECT notification_id, correlation_id FROM siton.notification_events WHERE deal_id=$1`,
    [dealId]
  );
  return { notificationId: row.rows[0].notification_id as string, correlationId: row.rows[0].correlation_id as string };
}

async function notificationRow(notificationId: string) {
  const r = await pool.query(
    `SELECT status, attempt_count, last_error, processing_started_at FROM siton.notification_events WHERE notification_id=$1`,
    [notificationId]
  );
  return r.rows[0];
}

await runTest("enqueue writes the correlation id", async () => {
  const { correlationId } = await enqueueTestNotification("corr");
  assert.equal(correlationId, "nrel-corr-corr");
});

await runTest("temporary failures are bounded: backoff then terminal failed at max attempts", async () => {
  const { notificationId } = await enqueueTestNotification("bounded");
  const flakyProvider = {
    providerCode: "test-flaky",
    mode: "dev" as const,
    async send() {
      return { status: "temporary_fail" as const, error_code: "test_unavailable", error_message: "synthetic outage" };
    }
  };
  for (let round = 1; round <= 3; round += 1) {
    await pool.query(
      `UPDATE siton.notification_events SET scheduled_for=NULL, status='pending' WHERE notification_id=$1 AND status='pending'`,
      [notificationId]
    );
    await flushPendingNotifications(pool, flakyProvider, console);
  }
  const row = await notificationRow(notificationId);
  assert.equal(row.status, "failed", "bounded retries must terminate");
  assert.equal(Number(row.attempt_count), 3);
  assert.match(String(row.last_error || ""), /max_attempts_exhausted/);
  const attempts = await pool.query(
    `SELECT COUNT(*)::int AS n FROM siton.notification_attempts WHERE notification_id=$1`,
    [notificationId]
  );
  assert.equal(attempts.rows[0].n, 3, "one durable attempt row per provider I/O");
});

await runTest("stranded processing rows are reclaimed with a counted attempt", async () => {
  const { notificationId } = await enqueueTestNotification("reclaim");
  await pool.query(
    `UPDATE siton.notification_events
     SET status='processing', processing_started_at=now() - interval '20 minutes'
     WHERE notification_id=$1`,
    [notificationId]
  );
  const reclaimed = await reclaimStrandedNotifications(pool, 5 * 60_000);
  assert.ok(reclaimed >= 1);
  const row = await notificationRow(notificationId);
  assert.equal(row.status, "pending");
  assert.equal(Number(row.attempt_count), 1);
  assert.match(String(row.last_error || ""), /reclaimed_after_processing_timeout/);

  // A reclaim at the attempt boundary terminates instead of looping forever.
  await pool.query(
    `UPDATE siton.notification_events
     SET status='processing', processing_started_at=now() - interval '20 minutes', attempt_count=2
     WHERE notification_id=$1`,
    [notificationId]
  );
  await reclaimStrandedNotifications(pool, 5 * 60_000);
  const finalRow = await notificationRow(notificationId);
  assert.equal(finalRow.status, "failed");
});

await runTest("recent processing rows are NOT reclaimed", async () => {
  const { notificationId } = await enqueueTestNotification("fresh");
  await pool.query(
    `UPDATE siton.notification_events SET status='processing', processing_started_at=now() WHERE notification_id=$1`,
    [notificationId]
  );
  await reclaimStrandedNotifications(pool, 5 * 60_000);
  const row = await notificationRow(notificationId);
  assert.equal(row.status, "processing");
});

await runTest("requesting real delivery fails closed instead of degrading to the log provider", async () => {
  assert.throws(
    () => buildNotificationProvider({ NOTIFICATION_PROVIDER: "twilio", NOTIFICATION_PROVIDER_MODE: "real" } as NodeJS.ProcessEnv),
    /requires a verified real notification adapter/
  );
  const logOnly = buildNotificationProvider({ NOTIFICATION_PROVIDER: "log-only" } as NodeJS.ProcessEnv);
  assert.equal(logOnly.providerCode, "log");
});

await runTest("sendSms fallback renders the real message body server-side", async () => {
  const { notificationId } = await enqueueTestNotification("smsbody");
  const sent: Array<{ to: string; body: string }> = [];
  const smsOnlyProvider = {
    providerCode: "test-sms",
    mode: "dev" as const,
    async sendSms(to: string, body: string) {
      sent.push({ to, body });
      return { messageId: `sms_${randomUUID()}` };
    }
  };
  await flushPendingNotifications(pool, smsOnlyProvider, console);
  const row = await notificationRow(notificationId);
  assert.equal(row.status, "sent");
  assert.equal(sent.length >= 1, true);
  assert.ok(sent[0]!.body && sent[0]!.body.trim().length > 5, "SMS body must be the rendered template, never empty");
});

await runTest("recipient safety gate blocks a real-mode send that is not allowlisted (before any provider I/O)", async () => {
  const { notificationId } = await enqueueTestNotification("blocked", "0509998877");
  let providerCalled = 0;
  const fakeRealProvider = {
    providerCode: "test-real",
    mode: "real" as const,
    async send() {
      providerCalled += 1;
      return { status: "success" as const, provider_message_id: "should_never_happen" };
    }
  };
  // Master and channel switches OFF (defaults): blocked.
  await flushPendingNotifications(pool, fakeRealProvider, console);
  let row = await notificationRow(notificationId);
  assert.equal(row.status, "blocked");
  assert.equal(providerCalled, 0, "safety gate must block BEFORE provider I/O");
  assert.match(String(row.last_error || ""), /blocked_by_recipient_safety/);

  // Switches on but recipient not allowlisted in staging: still blocked.
  process.env.NOTIFICATION_DELIVERY_ENABLED = "1";
  process.env.SMS_DELIVERY_ENABLED = "1";
  process.env.NOTIFICATION_RECIPIENT_ALLOWLIST = "+972501111111";
  await pool.query(`UPDATE siton.notification_events SET status='pending', scheduled_for=NULL WHERE notification_id=$1`, [notificationId]);
  await flushPendingNotifications(pool, fakeRealProvider, console);
  row = await notificationRow(notificationId);
  assert.equal(row.status, "blocked");
  assert.equal(providerCalled, 0);

  // Allowlisted recipient passes the gate (E.164 normalization of 05x).
  process.env.NOTIFICATION_RECIPIENT_ALLOWLIST = "+972509998877";
  await pool.query(`UPDATE siton.notification_events SET status='pending', scheduled_for=NULL WHERE notification_id=$1`, [notificationId]);
  await flushPendingNotifications(pool, fakeRealProvider, console);
  row = await notificationRow(notificationId);
  assert.equal(row.status, "sent");
  assert.equal(providerCalled, 1);

  delete process.env.NOTIFICATION_DELIVERY_ENABLED;
  delete process.env.SMS_DELIVERY_ENABLED;
  delete process.env.NOTIFICATION_RECIPIENT_ALLOWLIST;
});

await runTest("safety evaluation is default-deny and never infers safety from a 'test' substring", async () => {
  const blocked = safety.evaluateNotificationRecipientSafety({
    channel: "sms",
    recipient: "0501234567",
    providerMode: "real",
    env: { APP_DEPLOYMENT_MODE: "internal-runtime", NOTIFICATION_DELIVERY_ENABLED: "1", SMS_DELIVERY_ENABLED: "1" } as NodeJS.ProcessEnv
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "staging_recipient_not_allowlisted");

  const internalOnly = safety.evaluateNotificationRecipientSafety({
    channel: "sms",
    recipient: "anything",
    providerMode: "dev",
    env: {} as NodeJS.ProcessEnv
  });
  assert.equal(internalOnly.allowed, true);

  const syntheticInProduction = safety.evaluateNotificationRecipientSafety({
    channel: "email",
    recipient: "buyer@example.com",
    providerMode: "real",
    env: {
      APP_DEPLOYMENT_MODE: "production",
      NOTIFICATION_DELIVERY_ENABLED: "1",
      EMAIL_DELIVERY_ENABLED: "1"
    } as NodeJS.ProcessEnv
  });
  assert.equal(syntheticInProduction.allowed, false);
  assert.equal(syntheticInProduction.reason, "production_synthetic_domain_blocked");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
await pool.end();
process.exit(failed ? 1 : 0);
