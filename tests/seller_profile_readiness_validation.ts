import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3425");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function createSeller(suffix: string) {
  const sellerId = `seller-profile-test-${suffix}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.seller_accounts
       (seller_id, display_name, verification_status, settlement_status, payout_method, payout_details_masked)
     VALUES ($1,$2,'approved','active','bank_transfer','***1234')
     ON CONFLICT (seller_id) DO NOTHING`,
    [sellerId, `Test Seller ${suffix}`]
  );
  return sellerId;
}

async function createPublishableDeal(sellerId: string) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, created_at, updated_at)
     VALUES ($1,$2,'Deal to publish','Draft',2,2,20,50.00,
             now()+interval '7 days', now(), now())
     ON CONFLICT (deal_id) DO NOTHING`,
    [dealId, sellerId]
  );
  // Add required delivery option
  await pool.query(
    `INSERT INTO siton.deal_delivery_options (option_id, deal_id, option_type, label, cost, sort_order)
     VALUES (gen_random_uuid(), $1, 'pickup', 'איסוף עצמי', 0, 0)`,
    [dealId]
  );
  return dealId;
}

// S1: GET /api/seller/profile returns empty profile for new seller
await run("S1: GET profile returns empty profile for new seller", async () => {
  const sellerId = await createSeller("s1");
  const res = await app.inject({
    method: "GET",
    url: "/api/seller/profile",
    headers: { "x-seller-id": sellerId }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as any;
  assert.ok(body.ok);
  assert.ok(body.profile);
  assert.equal(body.profile.seller_id, sellerId);
  assert.equal(body.profile.business_name, null);
  assert.equal(body.profile.is_publish_ready, false);
});

// S2: PUT /api/seller/profile requires business_name
await run("S2: PUT profile without business_name → 400 business_name_required", async () => {
  const sellerId = await createSeller("s2");
  const res = await app.inject({
    method: "PUT",
    url: "/api/seller/profile",
    headers: { "Content-Type": "application/json", "x-seller-id": sellerId },
    payload: { contact_name: "Test Contact", support_phone: "0501234567" }
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as any;
  assert.equal(body.code, "business_name_required");
});

// S3: PUT profile with business_name only → is_publish_ready still false (no contact)
await run("S3: PUT profile with business_name only → is_publish_ready false", async () => {
  const sellerId = await createSeller("s3");
  const res = await app.inject({
    method: "PUT",
    url: "/api/seller/profile",
    headers: { "Content-Type": "application/json", "x-seller-id": sellerId },
    payload: { business_name: "Test Biz" }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as any;
  assert.ok(body.ok);
  assert.equal(body.profile.business_name, "Test Biz");
  assert.equal(body.profile.is_publish_ready, false);
});

// S4: PUT profile with business_name + support_phone → is_publish_ready true
await run("S4: PUT profile with business_name + support_phone → is_publish_ready true", async () => {
  const sellerId = await createSeller("s4");
  const res = await app.inject({
    method: "PUT",
    url: "/api/seller/profile",
    headers: { "Content-Type": "application/json", "x-seller-id": sellerId },
    payload: { business_name: "Good Biz", support_phone: "0501234567" }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as any;
  assert.ok(body.ok);
  assert.equal(body.profile.is_publish_ready, true);
});

// S5: Publish blocked when profile is incomplete
await run("S5: publish deal → 409 seller_profile_incomplete when profile missing", async () => {
  const sellerId = await createSeller("s5");
  const dealId = await createPublishableDeal(sellerId);
  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: { "x-seller-id": sellerId }
  });
  assert.equal(res.statusCode, 409);
  const body = res.json() as any;
  assert.equal(body.code, "seller_profile_incomplete");
});

// S6: Publish succeeds after completing seller profile
await run("S6: publish deal → 200 after completing seller profile", async () => {
  const sellerId = await createSeller("s6");
  // Complete profile with email contact
  const profileRes = await app.inject({
    method: "PUT",
    url: "/api/seller/profile",
    headers: { "Content-Type": "application/json", "x-seller-id": sellerId },
    payload: { business_name: "Ready Biz", support_email: "ready@example.com" }
  });
  assert.equal(profileRes.statusCode, 200);
  const profileBody = profileRes.json() as any;
  assert.equal(profileBody.profile.is_publish_ready, true);

  const dealId = await createPublishableDeal(sellerId);
  const res = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: { "x-seller-id": sellerId }
  });
  const body = res.json() as any;
  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${JSON.stringify(body)}`);
  // atomicTransition returns { response: { ok: true }, replay: bool }
  assert.ok(body.response?.ok);
});

await pool.end();
await app.close();
