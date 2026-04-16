/**
 * Per-deal Cross-System Ops Summary Proof
 *
 * Six targeted tests for /api/admin/deals/:id/ops-summary:
 *
 *   X1 — 404 on unknown deal_id
 *   X2 — correct bucket counts with known data (participants + notifications + invoices + outbox)
 *   X3 — failed notification is NOT counted as sent (bucket isolation)
 *   X4 — failed invoice is NOT counted as issued (bucket isolation)
 *   X5 — empty deal (no participants, notifications, invoices) does not crash endpoint
 *   X6 — by_channel and by_type split is correct
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3399");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const DB_URL = process.env.DATABASE_URL || "postgres://postgres:861434Ml@localhost:5432/postgres";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

// ─── helpers ─────────────────────────────────────────────────────────────────

async function insertDeal(dealId: string, title = "Test Deal") {
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, commission_rate, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,'Completed',1,1,10,100.00,0.10,
             now()+interval '7 days', now(), now(), now())
     ON CONFLICT (deal_id) DO NOTHING`,
    [dealId, title]
  );
}

async function insertParticipant(participantId: string, dealId: string, buyerState: string) {
  await pool.query(
    `INSERT INTO siton.participants
       (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, created_at, updated_at)
     VALUES ($1,$2,'+972500000000',1,$3,'ChargedSuccess',now(),now())
     ON CONFLICT (participant_id) DO NOTHING`,
    [participantId, dealId, buyerState]
  );
}

async function insertNotification(dealId: string, participantId: string, status: string, channel = "sms") {
  const eventKey = `charge_succeeded:${participantId}:${channel}:${randomUUID()}`;
  await pool.query(
    `INSERT INTO siton.notifications
       (event_key, notification_event_type, channel, recipient, template_id, template_params,
        status, attempt_count, max_attempts, provider_code, available_at, created_at, updated_at)
     VALUES ($1,'charge_succeeded',$2,'+972500000000','charge_succeeded/sms/v1',
             $3,$4,1,3,'log-only',now(),now(),now())
     ON CONFLICT (event_key) DO NOTHING`,
    [eventKey, channel, JSON.stringify({ deal_id: dealId, deal_title: "Test", participant_id: participantId }), status]
  );
  return eventKey;
}

async function insertInvoiceDoc(dealId: string, participantId: string, status: string, documentType = "charge_receipt") {
  const key = `${documentType}:${participantId}:test:${randomUUID()}`;
  await pool.query(
    `INSERT INTO siton.invoice_documents
       (document_key, document_type, deal_id, participant_id, deal_title, qty,
        money_state_at_issue, gross_amount, siton_fee_amount, seller_net_amount,
        affiliate_fee_amount, status, attempt_count, max_attempts, provider_code,
        available_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Test Deal',1,'ChargedSuccess',100.00,10.00,90.00,0.00,
             $5,1,3,'log-only',now(),now(),now())
     ON CONFLICT (document_key) DO NOTHING`,
    [key, documentType, dealId, participantId, status]
  );
  return key;
}

async function cleanup(dealId: string) {
  await pool.query(`DELETE FROM siton.invoice_documents WHERE deal_id=$1`, [dealId]);
  await pool.query(
    `DELETE FROM siton.notifications WHERE template_params->>'deal_id' = $1`,
    [dealId]
  );
  await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]);
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

// ─── X1: 404 on unknown deal ──────────────────────────────────────────────────

await run("X1 — 404 on unknown deal_id", async () => {
  const res = await app.inject({ method: "GET", url: `/api/admin/deals/${randomUUID()}/ops-summary` });
  assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}`);
  const body = JSON.parse(res.body);
  assert.ok(body.message || body.error, "should have error message");
  console.log(`     status=${res.statusCode}`);
});

// ─── X2: correct counts with known data ──────────────────────────────────────

await run("X2 — correct bucket counts with participants + notifications + invoices", async () => {
  const dealId = randomUUID();
  const p1 = randomUUID();
  const p2 = randomUUID();
  const p3 = randomUUID();
  try {
    await insertDeal(dealId);
    await insertParticipant(p1, dealId, "DealCompleted");
    await insertParticipant(p2, dealId, "DealCompleted");
    await insertParticipant(p3, dealId, "DealFailed");
    await insertNotification(dealId, p1, "sent");
    await insertNotification(dealId, p2, "sent");
    await insertNotification(dealId, p3, "pending");
    await insertInvoiceDoc(dealId, p1, "issued");
    await insertInvoiceDoc(dealId, p2, "pending");

    const res = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/ops-summary` });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);

    // Deal info
    assert.equal(body.deal.deal_id, dealId);
    assert.equal(body.deal.state, "Completed");

    // Participants
    assert.equal(body.participants.total, 3, `total participants should be 3, got ${body.participants.total}`);
    assert.equal(body.participants.by_state["DealCompleted"], 2, `DealCompleted count should be 2`);
    assert.equal(body.participants.by_state["DealFailed"], 1, `DealFailed count should be 1`);

    // Notifications
    assert.equal(body.notifications.sent, 2, `sent notifications should be 2, got ${body.notifications.sent}`);
    assert.equal(body.notifications.pending, 1, `pending notifications should be 1, got ${body.notifications.pending}`);

    // Invoice documents
    assert.equal(body.invoice_documents.issued, 1, `issued invoices should be 1, got ${body.invoice_documents.issued}`);
    assert.equal(body.invoice_documents.pending, 1, `pending invoices should be 1, got ${body.invoice_documents.pending}`);

    console.log(`     participants=${JSON.stringify(body.participants)}`);
    console.log(`     notifications.sent=${body.notifications.sent} pending=${body.notifications.pending}`);
    console.log(`     invoices.issued=${body.invoice_documents.issued} pending=${body.invoice_documents.pending}`);
  } finally {
    await cleanup(dealId);
  }
});

// ─── X3: failed notification NOT counted as sent ─────────────────────────────

await run("X3 — failed notification is NOT counted as sent", async () => {
  const dealId = randomUUID();
  const p1 = randomUUID();
  try {
    await insertDeal(dealId);
    await insertParticipant(p1, dealId, "DealCompleted");
    await insertNotification(dealId, p1, "failed");  // failed, not sent

    const res = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/ops-summary` });
    const body = JSON.parse(res.body);

    assert.equal(body.notifications.sent,   0, `sent should be 0, got ${body.notifications.sent}`);
    assert.equal(body.notifications.failed, 1, `failed should be 1, got ${body.notifications.failed}`);

    console.log(`     sent=${body.notifications.sent} failed=${body.notifications.failed}`);
  } finally {
    await cleanup(dealId);
  }
});

// ─── X4: failed invoice NOT counted as issued ────────────────────────────────

await run("X4 — failed invoice is NOT counted as issued", async () => {
  const dealId = randomUUID();
  const p1 = randomUUID();
  try {
    await insertDeal(dealId);
    await insertParticipant(p1, dealId, "DealCompleted");
    await insertInvoiceDoc(dealId, p1, "failed");  // failed, not issued

    const res = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/ops-summary` });
    const body = JSON.parse(res.body);

    assert.equal(body.invoice_documents.issued, 0, `issued should be 0, got ${body.invoice_documents.issued}`);
    assert.equal(body.invoice_documents.failed, 1, `failed should be 1, got ${body.invoice_documents.failed}`);

    console.log(`     issued=${body.invoice_documents.issued} failed=${body.invoice_documents.failed}`);
  } finally {
    await cleanup(dealId);
  }
});

// ─── X5: empty deal does not crash endpoint ───────────────────────────────────

await run("X5 — empty deal (no participants/notifications/invoices) does not crash", async () => {
  const dealId = randomUUID();
  try {
    await insertDeal(dealId, "Empty Deal");

    const res = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/ops-summary` });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.participants.total, 0);
    assert.equal(body.notifications.pending, 0);
    assert.equal(body.notifications.sent, 0);
    assert.equal(body.invoice_documents.issued, 0);
    assert.equal(body.outbox.pending, 0);
    assert.ok(Array.isArray(body.notifications.by_channel), "by_channel must be array (empty ok)");
    assert.ok(Array.isArray(body.invoice_documents.by_type), "by_type must be array (empty ok)");

    console.log(`     all zeros, ok=${body.ok}`);
  } finally {
    await cleanup(dealId);
  }
});

// ─── X6: by_channel and by_type split is correct ─────────────────────────────

await run("X6 — by_channel and by_type split is correct", async () => {
  const dealId = randomUUID();
  const p1 = randomUUID();
  const p2 = randomUUID();
  try {
    await insertDeal(dealId);
    await insertParticipant(p1, dealId, "DealCompleted");
    await insertParticipant(p2, dealId, "DealCompleted");
    // 2 sms notifications (1 sent, 1 failed)
    await insertNotification(dealId, p1, "sent",   "sms");
    await insertNotification(dealId, p2, "failed", "sms");
    // 1 charge_receipt (issued), 1 refund_receipt (failed)
    await insertInvoiceDoc(dealId, p1, "issued",  "charge_receipt");
    await insertInvoiceDoc(dealId, p2, "failed",  "refund_receipt");

    const res = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/ops-summary` });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);

    // by_channel: sms should have sent=1, failed=1
    const smsChannel = body.notifications.by_channel.find((c: any) => c.channel === "sms");
    assert.ok(smsChannel, "sms channel must appear");
    assert.equal(smsChannel.sent,   1, `sms sent should be 1`);
    assert.equal(smsChannel.failed, 1, `sms failed should be 1`);

    // by_type: charge_receipt issued=1, refund_receipt failed=1
    const chargeType = body.invoice_documents.by_type.find((t: any) => t.document_type === "charge_receipt");
    const refundType = body.invoice_documents.by_type.find((t: any) => t.document_type === "refund_receipt");
    assert.ok(chargeType, "charge_receipt type must appear");
    assert.ok(refundType, "refund_receipt type must appear");
    assert.equal(chargeType.issued, 1, `charge_receipt issued should be 1`);
    assert.equal(refundType.failed, 1, `refund_receipt failed should be 1`);

    console.log(`     by_channel=${JSON.stringify(body.notifications.by_channel)}`);
    console.log(`     by_type=${JSON.stringify(body.invoice_documents.by_type)}`);
  } finally {
    await cleanup(dealId);
  }
});

await pool.end();
console.log("\nAll deal ops summary proof tests completed.");
