import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import "dotenv/config";

process.env.ADMIN_API_KEY = "seller-enforcement-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = "3496";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
// R5C — admin status mutations require a named admin identity, not the shared key.
const { cookie: ADMIN_COOKIE } = await establishNamedAdminSession(app, pool);

async function run(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`PASS ${name}`);
}

async function setSellerStatus(sellerId: string, status?: string) {
  await pool.query(
    `INSERT INTO siton.seller_accounts (
       seller_id, display_name, verification_status, settlement_status, payout_method,
       payout_details_masked, admin_note, business_name, support_email
     )
     VALUES ($1,$2,'approved','active','bank_transfer','***1234','seller enforcement test',$2,'seller-enforcement@siton.local')
     ON CONFLICT (seller_id) DO UPDATE
     SET business_name=EXCLUDED.business_name,
         support_email=EXCLUDED.support_email,
         updated_at=now()`,
    [sellerId, `Seller Enforcement ${sellerId}`]
  );
  if (status) {
    await pool.query(
      `UPDATE siton.seller_accounts
       SET seller_status=$2, seller_status_reason='test setup', seller_status_updated_at=now()
       WHERE seller_id=$1`,
      [sellerId, status]
    );
  }
}

async function createDraftViaApi(sellerId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `seller-enforcement-create:${sellerId}:${Date.now()}`,
      "idempotency-key": `seller-enforcement-create:${sellerId}:${randomUUID()}`
    },
    payload: {
      seller_id: sellerId,
      seller_display_name: `Seller ${sellerId}`,
      title: `Seller Enforcement Deal ${sellerId} ${Date.now()}`,
      price_per_unit: 10,
      min_units: 2,
      max_units: 5,
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "Pickup — Herzl 12, Tel Aviv", cost: 0 }]
    }
  });
  return res;
}

async function seedDraft(sellerId: string) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state
     ) VALUES ($1,$2,10,2,5,2,$3,$4,'Draft')`,
    [dealId, `Seeded Enforcement Deal ${sellerId}`, new Date(Date.now() + 4 * 60 * 60_000).toISOString(), sellerId]
  );
  return dealId;
}

async function publishViaApi(sellerId: string, dealId: string) {
  return app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-seller-id": sellerId,
      "x-request-id": `seller-enforcement-publish:${sellerId}:${Date.now()}`,
      "idempotency-key": `seller-enforcement-publish:${dealId}:${randomUUID()}`
    },
    payload: {
      seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true
    }
  });
}

try {
  await run("new seller status defaults to Active", async () => {
    const sellerId = `seller-enforcement-default-${Date.now()}`;
    await setSellerStatus(sellerId);
    const row = await pool.query(`SELECT seller_status FROM siton.seller_accounts WHERE seller_id=$1`, [sellerId]);
    assert.equal(row.rows[0].seller_status, "Active");
  });

  await run("Active seller can create draft and publish", async () => {
    const sellerId = `seller-enforcement-active-${Date.now()}`;
    await setSellerStatus(sellerId, "Active");
    const created = await createDraftViaApi(sellerId);
    assert.equal(created.statusCode, 200, created.body);
    const published = await publishViaApi(sellerId, (created.json() as any).deal_id);
    assert.equal(published.statusCode, 200, published.body);
  });

  await run("UnderReview seller can publish", async () => {
    const sellerId = `seller-enforcement-review-${Date.now()}`;
    await setSellerStatus(sellerId, "UnderReview");
    const created = await createDraftViaApi(sellerId);
    assert.equal(created.statusCode, 200, created.body);
    const published = await publishViaApi(sellerId, (created.json() as any).deal_id);
    assert.equal(published.statusCode, 200, published.body);
  });

  await run("Restricted seller can draft but cannot publish", async () => {
    const sellerId = `seller-enforcement-restricted-${Date.now()}`;
    await setSellerStatus(sellerId, "Restricted");
    const created = await createDraftViaApi(sellerId);
    assert.equal(created.statusCode, 200, created.body);
    const published = await publishViaApi(sellerId, (created.json() as any).deal_id);
    assert.equal(published.statusCode, 403, published.body);
    assert.equal((published.json() as any).code, "SELLER_RESTRICTED");
  });

  await run("Suspended seller cannot create draft or publish", async () => {
    const sellerId = `seller-enforcement-suspended-${Date.now()}`;
    await setSellerStatus(sellerId, "Suspended");
    const created = await createDraftViaApi(sellerId);
    assert.equal(created.statusCode, 403, created.body);
    assert.equal((created.json() as any).code, "SELLER_SUSPENDED");
    const dealId = await seedDraft(sellerId);
    const published = await publishViaApi(sellerId, dealId);
    assert.equal(published.statusCode, 403, published.body);
    assert.equal((published.json() as any).code, "SELLER_SUSPENDED");
  });

  await run("Banned seller cannot create draft or publish", async () => {
    const sellerId = `seller-enforcement-banned-${Date.now()}`;
    await setSellerStatus(sellerId, "Banned");
    const created = await createDraftViaApi(sellerId);
    assert.equal(created.statusCode, 403, created.body);
    assert.equal((created.json() as any).code, "SELLER_BANNED");
    const dealId = await seedDraft(sellerId);
    const published = await publishViaApi(sellerId, dealId);
    assert.equal(published.statusCode, 403, published.body);
    assert.equal((published.json() as any).code, "SELLER_BANNED");
  });

  await run("admin status change requires reason, succeeds with reason, and records security event", async () => {
    const sellerId = `seller-enforcement-admin-${Date.now()}`;
    await setSellerStatus(sellerId, "Active");
    const missingReason = await app.inject({
      method: "POST",
      url: `/api/admin/sellers/${sellerId}/status`,
      headers: { "x-admin-key": "seller-enforcement-admin-key", cookie: ADMIN_COOKIE },
      payload: { status: "Restricted" }
    });
    assert.equal(missingReason.statusCode, 400, missingReason.body);

    const changed = await app.inject({
      method: "POST",
      url: `/api/admin/sellers/${sellerId}/status`,
      headers: {
        "x-admin-key": "seller-enforcement-admin-key",
        "x-admin-user": "seller-enforcement-test",
        cookie: ADMIN_COOKIE
      },
      payload: { status: "Restricted", reason: "test risk signal" }
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((changed.json() as any).seller.seller_status, "Restricted");

    const events = await pool.query(
      `SELECT event_type, from_status, to_status, reason
       FROM siton.seller_security_events
       WHERE seller_id=$1
       ORDER BY created_at DESC
       LIMIT 1`,
      [sellerId]
    );
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].event_type, "seller.status.update");
    assert.equal(events.rows[0].from_status, "Active");
    assert.equal(events.rows[0].to_status, "Restricted");
    assert.equal(events.rows[0].reason, "test risk signal");
  });

  await run("seller enforcement stays isolated from duplicate discovery and distributor money rails", async () => {
    const platformFee = await readFile("src/platform_fee_money.ts", "utf8");
    const frontendRuntime = await readFile("src/frontend_runtime.ts", "utf8");
    assert.match(platformFee, /SITON_PLATFORM_FEE_RATE/);
    assert.doesNotMatch(frontendRuntime, /app\.get\(["']\/api\/marketplace/i);
    assert.doesNotMatch(frontendRuntime, /app\.get\(["']\/api\/catalog/i);
    assert.match(frontendRuntime, /app\.get\(["']\/api\/mall\/deals/i);
    assert.doesNotMatch(frontendRuntime, /affiliate.*commission/i);
    assert.doesNotMatch(frontendRuntime, /affiliate-payouts/i);
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end();
}

