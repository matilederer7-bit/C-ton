import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.NOTIFICATION_PROVIDER = "log";
process.env.NOTIFICATION_PROVIDER_MODE = "dev";

import {
  buildNotificationProvider,
  enqueueNotification,
  ensureNotificationRailTables,
  flushPendingNotifications,
  NotificationValidationError,
  type NotificationProvider,
  type NotificationForProvider,
  type NotificationProviderResult
} from "../src/notification_dispatch.js";

const { Pool } = pg;
const DB_URL = process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL search_path TO siton, public");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function deleteByKey(idempotencyKey: string) {
  await pool.query(`DELETE FROM siton.notification_events WHERE idempotency_key=$1`, [idempotencyKey]);
}

async function getEvent(idempotencyKey: string) {
  const row = await pool.query(
    `SELECT notification_id, event_type, recipient_type, recipient_ref, deal_id, participant_id,
            seller_id, channel, template_key, status, idempotency_key, sent_at, last_error
     FROM siton.notification_events
     WHERE idempotency_key=$1`,
    [idempotencyKey]
  );
  return row.rows[0] ?? null;
}

await ensureNotificationRailTables(withTx);

await run("enqueue creates pending notification", async () => {
  const idempotencyKey = `notification-test:${randomUUID()}`;
  const dealId = randomUUID();
  try {
    const result = await enqueueNotification({
      event_type: "buyer_joined_authorized",
      recipient_type: "buyer",
      recipient_ref: "+972501234567",
      deal_id: randomUUID(),
      participant_id: randomUUID(),
      channel: "sms",
      payload_jsonb: { deal_title: "עסקת בדיקה" },
      idempotency_key: idempotencyKey
    }, pool);
    assert.equal(result, "queued");
    const event = await getEvent(idempotencyKey);
    assert.equal(event.status, "pending");
    assert.equal(event.event_type, "buyer_joined_authorized");
    assert.equal(event.template_key, "buyer_joined_authorized_he");
  } finally {
    await deleteByKey(idempotencyKey);
  }
});

await run("enqueue idempotency keeps one row", async () => {
  const idempotencyKey = `notification-test:${randomUUID()}`;
  try {
    const input = {
      event_type: "buyer_joined_authorized" as const,
      recipient_type: "buyer" as const,
      recipient_ref: "+972501234567",
      deal_id: randomUUID(),
      participant_id: randomUUID(),
      channel: "sms" as const,
      payload_jsonb: { deal_title: "עסקת בדיקה" },
      idempotency_key: idempotencyKey
    };
    assert.equal(await enqueueNotification(input, pool), "queued");
    assert.equal(await enqueueNotification(input, pool), "duplicate");
    const count = await pool.query(
      `SELECT COUNT(*) AS cnt FROM siton.notification_events WHERE idempotency_key=$1`,
      [idempotencyKey]
    );
    assert.equal(Number(count.rows[0].cnt), 1);
  } finally {
    await deleteByKey(idempotencyKey);
  }
});

await run("dispatch log provider marks sent and records attempt", async () => {
  const idempotencyKey = `notification-test:${randomUUID()}`;
  try {
    await enqueueNotification({
      event_type: "buyer_deal_completed",
      recipient_type: "buyer",
      recipient_ref: "+972501234567",
      deal_id: randomUUID(),
      participant_id: randomUUID(),
      channel: "sms",
      payload_jsonb: { deal_title: "עסקת בדיקה" },
      idempotency_key: idempotencyKey
    }, pool);
    const provider = buildNotificationProvider({}, console);
    const processed = await flushPendingNotifications(pool, provider);
    assert.ok(processed >= 1);
    const event = await getEvent(idempotencyKey);
    assert.equal(event.status, "sent");
    assert.ok(event.sent_at);
    const attempts = await pool.query(
      `SELECT provider, provider_mode, result_status, provider_message_id
       FROM siton.notification_attempts
       WHERE notification_id=$1`,
      [event.notification_id]
    );
    assert.equal(attempts.rowCount, 1);
    assert.equal(attempts.rows[0].provider, "log");
    assert.equal(attempts.rows[0].provider_mode, "dev");
    assert.equal(attempts.rows[0].result_status, "success");
    assert.match(String(attempts.rows[0].provider_message_id), /^log_/);
  } finally {
    await deleteByKey(idempotencyKey);
  }
});

await run("invalid event type is rejected", async () => {
  await assert.rejects(
    () => enqueueNotification({
      event_type: "bad_event",
      recipient_type: "buyer",
      recipient_ref: "+972501234567",
      channel: "sms",
      payload_jsonb: { deal_title: "עסקת בדיקה" }
    } as any, pool),
    (error) => error instanceof NotificationValidationError && error.code === "invalid_notification_event_type"
  );
});

await run("invalid channel is rejected", async () => {
  await assert.rejects(
    () => enqueueNotification({
      event_type: "buyer_joined_authorized",
      recipient_type: "buyer",
      recipient_ref: "+972501234567",
      channel: "push",
      payload_jsonb: { deal_title: "עסקת בדיקה" }
    } as any, pool),
    (error) => error instanceof NotificationValidationError && error.code === "invalid_notification_channel"
  );
});

await run("notification failure does not mutate deal or participant state", async () => {
  const idempotencyKey = `notification-test:${randomUUID()}`;
  const dealId = randomUUID();
  const participantId = randomUUID();
  try {
    await withTx(async (c) => {
      await c.query(
        `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email)
         VALUES ($1,'Notification Seller','Notification Seller','seller@example.test')
         ON CONFLICT (seller_id) DO NOTHING`,
        [`notification-seller-${dealId}`]
      );
      await c.query(
        `INSERT INTO siton.deals
           (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, seller_id)
         VALUES ($1,'Notification State Deal',10,1,5,1,now() + interval '3 hours','PendingTarget',now(),$2)`,
        [dealId, `notification-seller-${dealId}`]
      );
      await c.query(
        `INSERT INTO siton.participants
           (participant_id, deal_id, buyer_id, qty, buyer_state, money_state)
         VALUES ($1,$2,'+972501111111',1,'JoinedAuthorized','AuthHeld')`,
        [participantId, dealId]
      );
    });
    await enqueueNotification({
      event_type: "buyer_deal_completed",
      recipient_type: "buyer",
      recipient_ref: "+972501111111",
      deal_id: dealId,
      participant_id: participantId,
      channel: "sms",
      payload_jsonb: { deal_title: "Notification State Deal" },
      idempotency_key: idempotencyKey
    }, pool);
    const failingProvider: NotificationProvider = {
      providerCode: "log",
      mode: "dev",
      async send(_notification: NotificationForProvider): Promise<NotificationProviderResult> {
        return { status: "permanent_fail", error_code: "test_failure", error_message: "test failure" };
      }
    };
    await flushPendingNotifications(pool, failingProvider);
    const state = await pool.query(
      `SELECT d.state, p.buyer_state, p.money_state
       FROM siton.deals d
       JOIN siton.participants p ON p.deal_id=d.deal_id
       WHERE d.deal_id=$1 AND p.participant_id=$2`,
      [dealId, participantId]
    );
    assert.equal(state.rows[0].state, "PendingTarget");
    assert.equal(state.rows[0].buyer_state, "JoinedAuthorized");
    assert.equal(state.rows[0].money_state, "AuthHeld");
    const event = await getEvent(idempotencyKey);
    assert.equal(event.status, "failed");
  } finally {
    await deleteByKey(idempotencyKey);
    await pool.query(`DELETE FROM siton.participants WHERE participant_id=$1`, [participantId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id=$1`, [`notification-seller-${dealId}`]).catch(() => undefined);
  }
});

await run("seller completed notification references Excel without affiliate payout wording", async () => {
  const idempotencyKey = `notification-test:${randomUUID()}`;
  const dealId = randomUUID();
  try {
    await enqueueNotification({
      event_type: "seller_deal_completed",
      recipient_type: "seller",
      recipient_ref: "seller@example.test",
      deal_id: dealId,
      seller_id: "seller-notification-test",
      channel: "internal",
      payload_jsonb: { deal_id: dealId, deal_title: "עסקת מוכר" },
      idempotency_key: idempotencyKey
    }, pool);
    const event = await getEvent(idempotencyKey);
    assert.equal(event.status, "pending");
    const payload = await pool.query(`SELECT payload_jsonb FROM siton.notification_events WHERE idempotency_key=$1`, [idempotencyKey]);
    assert.doesNotMatch(JSON.stringify(payload.rows[0].payload_jsonb), /commission|payout|affiliate/i);
  } finally {
    await deleteByKey(idempotencyKey);
  }
});

const { app } = await import("../src/app.js");

await run("successful join enqueues buyer_joined_authorized", async () => {
  const sellerId = `notification-seller-${randomUUID()}`;
  const suffix = randomUUID();
  let dealId = "";
  let participantId = "";
  try {
    await pool.query(
      `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email)
       VALUES ($1,'Notification Seller','Notification Seller','seller@example.test')
       ON CONFLICT (seller_id) DO UPDATE
       SET business_name=EXCLUDED.business_name, support_email=EXCLUDED.support_email`,
      [sellerId]
    );
    const create = await app.inject({
      method: "POST",
      url: "/deals",
      headers: { "x-seller-id": sellerId, "x-request-id": `notification-create-${suffix}` },
      payload: {
        title: "עסקת הודעות",
        price_per_unit: 12,
        min_units: 2,
        max_units: 5,
        deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        delivery_options: [{ option_type: "pickup", label: "איסוף עצמי", cost: 0 }]
      }
    });
    assert.equal(create.statusCode, 200, create.body);
    dealId = create.json().deal_id;
    const publish = await app.inject({
      method: "POST",
      url: `/deals/${dealId}/publish`,
      headers: { "x-seller-id": sellerId, "x-request-id": `notification-publish-${suffix}` }
    });
    assert.equal(publish.statusCode, 200, publish.body);
    const option = await pool.query(`SELECT option_id FROM siton.deal_delivery_options WHERE deal_id=$1 LIMIT 1`, [dealId]);
    const buyerId = `+97250${String(Date.now()).slice(-7)}`;
    const join = await app.inject({
      method: "POST",
      url: `/deals/${dealId}/join`,
      headers: { "x-request-id": `notification-join-${suffix}`, "idempotency-key": `notification-join-${suffix}` },
      payload: {
        buyer_id: buyerId,
        qty: 1,
        delivery_option_id: option.rows[0].option_id,
        buyer_name: "קונה בדיקה"
      }
    });
    assert.equal(join.statusCode, 200, join.body);
    participantId = join.json().participant_id;
    const event = await pool.query(
      `SELECT status, event_type, channel
       FROM siton.notification_events
       WHERE event_type='buyer_joined_authorized' AND participant_id=$1`,
      [participantId]
    );
    assert.equal(event.rowCount, 1);
    assert.equal(event.rows[0].status, "pending");
    assert.equal(event.rows[0].channel, "sms");
  } finally {
    if (dealId) {
      await pool.query(`DELETE FROM siton.notification_events WHERE deal_id=$1`, [dealId]).catch(() => undefined);
      await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]).catch(() => undefined);
      await pool.query(`DELETE FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]).catch(() => undefined);
      await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1`, [dealId]).catch(() => undefined);
      await pool.query(`DELETE FROM siton.audit_log WHERE deal_id=$1`, [dealId]).catch(() => undefined);
      await pool.query(`DELETE FROM siton.idempotency_log WHERE idempotency_key LIKE $1`, [`%${suffix}%`]).catch(() => undefined);
      await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
    }
    await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id=$1`, [sellerId]).catch(() => undefined);
  }
});

await app.close().catch(() => undefined);
await pool.end();
