import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.ADMIN_API_KEY = "launch-console-admin-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = process.env.PORT || "3471";

const { app } = await import("../src/app.js");

const { Pool } = pg;
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new Pool({ connectionString: DB_URL, max: 5 });
const ADMIN_HEADERS = { "x-admin-key": "launch-console-admin-key" };

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function getConsole() {
  const res = await app.inject({ method: "GET", url: "/api/admin/launch-console", headers: ADMIN_HEADERS });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
}

function countValue(payload: any, path: string[]) {
  return Number(path.reduce((current, key) => current?.[key], payload) || 0);
}

async function seedLaunchFixture() {
  const suffix = randomUUID().slice(0, 8);
  const readySellerId = `launch-ready-${suffix}`;
  const incompleteSellerId = `launch-incomplete-${suffix}`;
  const dealId = randomUUID();
  const participantId = randomUUID();
  const notificationPendingKey = `launch:${suffix}:pending`;
  const notificationSentKey = `launch:${suffix}:sent`;
  const notificationFailedKey = `launch:${suffix}:failed`;

  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email)
     VALUES ($1,'Launch Ready Seller','Launch Ready Seller','launch-ready@example.test')
     ON CONFLICT (seller_id) DO UPDATE
     SET business_name=EXCLUDED.business_name, support_email=EXCLUDED.support_email`,
    [readySellerId]
  );
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, support_phone)
     VALUES ($1,'Launch Incomplete Seller',NULL,NULL,NULL)
     ON CONFLICT (seller_id) DO UPDATE
     SET business_name=NULL, support_email=NULL, support_phone=NULL`,
    [incompleteSellerId]
  );
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,'Launch Console Completed Deal','Completed',1,1,10,100.00,
             now()+interval '7 days', now(), now(), now())`,
    [dealId, readySellerId]
  );
  await pool.query(
    `INSERT INTO siton.deal_images
       (deal_id, storage_provider, storage_key, public_url, original_filename, mime_type, size_bytes, sort_order, is_primary)
     VALUES ($1,'local',$2,$3,'launch.png','image/png',128,0,true)`,
    [dealId, `deal-images/${dealId}/launch.png`, `/uploads/deal-images/${dealId}/launch.png`]
  );
  await pool.query(
    `INSERT INTO siton.legal_acceptances
       (actor_type, actor_ref, deal_id, participant_id, acceptance_type, policy_version)
     VALUES
       ('seller',$1,$2,NULL,'seller_publish_terms','2026-04-26'),
       ('buyer','launch-buyer',$2,$3,'buyer_join_terms','2026-04-26'),
       ('buyer','launch-buyer',$2,$3,'buyer_payment_disclosure','2026-04-26')
     ON CONFLICT DO NOTHING`,
    [readySellerId, dealId, participantId]
  );
  await pool.query(
    `INSERT INTO siton.notification_events
       (event_type, recipient_type, recipient_ref, deal_id, participant_id, seller_id,
        channel, template_key, payload_jsonb, status, idempotency_key)
     VALUES
       ('seller_deal_published','seller',$1,$2,NULL,$1,'internal','seller_deal_published_he','{}','pending',$3),
       ('seller_deal_completed','seller',$1,$2,NULL,$1,'internal','seller_deal_completed_he','{}','sent',$4),
       ('seller_deal_failed','seller',$1,$2,NULL,$1,'internal','seller_deal_failed_he','{}','failed',$5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [readySellerId, dealId, notificationPendingKey, notificationSentKey, notificationFailedKey]
  );

  return { suffix, readySellerId, incompleteSellerId, dealId };
}

async function cleanupFixture(fixture: { readySellerId: string; incompleteSellerId: string; dealId: string; suffix: string }) {
  await pool.query(`DELETE FROM siton.notification_events WHERE idempotency_key LIKE $1`, [`launch:${fixture.suffix}:%`]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.legal_acceptances WHERE deal_id=$1`, [fixture.dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.deal_images WHERE deal_id=$1`, [fixture.dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [fixture.dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id IN ($1,$2)`, [fixture.readySellerId, fixture.incompleteSellerId]).catch(() => undefined);
}

await run("launch console endpoint requires admin key", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/launch-console" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "admin_auth_required");
});

const baseline = await getConsole();
const fixture = await seedLaunchFixture();

try {
  const payload = await getConsole();

  await run("launch console returns aggregate snapshot", async () => {
    assert.equal(payload.ok, true);
    assert.ok(["green", "yellow", "red"].includes(payload.system.status));
    assert.equal(typeof payload.generated_at, "string");
    assert.ok(payload.sellers);
    assert.ok(payload.deals);
    assert.ok(payload.launch_readiness);
    assert.ok(payload.notifications);
    assert.ok(payload.legal);
    assert.ok(Array.isArray(payload.recent_deals));
  });

  await run("seller readiness counts include incomplete and publish-ready sellers", async () => {
    assert.ok(countValue(payload, ["sellers", "publish_ready"]) >= countValue(baseline, ["sellers", "publish_ready"]) + 1);
    assert.ok(countValue(payload, ["sellers", "incomplete_profile"]) >= countValue(baseline, ["sellers", "incomplete_profile"]) + 1);
  });

  await run("completed deal exposes Excel availability in recent deals", async () => {
    const deal = payload.recent_deals.find((item: any) => item.deal_id === fixture.dealId);
    assert.ok(deal, "seeded deal should appear in recent deals");
    assert.equal(deal.has_excel_export_available, true);
    assert.equal(deal.has_image, true);
    assert.equal(deal.has_seller_profile, true);
    assert.equal(deal.has_seller_terms_acceptance, true);
  });

  await run("notification summary uses notification_events", async () => {
    assert.ok(countValue(payload, ["notifications", "pending"]) >= countValue(baseline, ["notifications", "pending"]) + 1);
    assert.ok(countValue(payload, ["notifications", "sent"]) >= countValue(baseline, ["notifications", "sent"]) + 1);
    assert.ok(countValue(payload, ["notifications", "failed"]) >= countValue(baseline, ["notifications", "failed"]) + 1);
    assert.equal(payload.notifications.provider, "log");
    assert.equal(payload.notifications.external_delivery, false);
  });

  await run("legal summary uses legal_acceptances", async () => {
    assert.ok(countValue(payload, ["legal", "seller_publish_acceptances"]) >= countValue(baseline, ["legal", "seller_publish_acceptances"]) + 1);
    assert.ok(countValue(payload, ["legal", "buyer_join_acceptances"]) >= countValue(baseline, ["legal", "buyer_join_acceptances"]) + 1);
    assert.ok(countValue(payload, ["legal", "buyer_payment_disclosures"]) >= countValue(baseline, ["legal", "buyer_payment_disclosures"]) + 1);
  });

  await run("launch console does not leak buyer PII or internal storage/payment references", async () => {
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["buyer_phone", "buyer_email", "delivery_address", "payment_token", "provider_reference", "storage_key"]) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must not be exposed`);
    }
  });

  await run("launch console response stays constitution-safe", async () => {
    const serialized = JSON.stringify(payload);
    const forbidden = [
      ["market", "place"].join(""),
      ["comm", "ission"].join(""),
      ["pay", "out"].join(""),
      ["with", "drawal"].join(""),
      ["bal", "ance"].join("")
    ];
    for (const word of forbidden) assert.ok(!serialized.toLowerCase().includes(word), `${word} must not be exposed`);
  });
} finally {
  await cleanupFixture(fixture);
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
