import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.PORT = String(process.env.PORT || "3483");
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

const DEAL_STATES = [
  "Draft",
  "PendingTarget",
  "TargetReached",
  "ClosedForJoining",
  "ReadyForCharging",
  "Charging",
  "CompletionWindow",
  "Completed",
  "Failed",
  "Cancelled"
];

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function seedSeller(label: string) {
  const sellerId = `analytics-${label}-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO siton.seller_accounts
       (seller_id, display_name, business_name, support_email)
     VALUES ($1,$2,$2,$3)
     ON CONFLICT (seller_id) DO UPDATE
     SET business_name=EXCLUDED.business_name, support_email=EXCLUDED.support_email`,
    [sellerId, `Analytics ${label} Seller`, `${label}@example.test`]
  );
  return sellerId;
}

async function seedDeal(sellerId: string, state: string) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, seller_id, title, state, threshold_units, min_units, max_units,
        price_per_unit, deadline, published_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,2,2,20,75.00,
             now()+interval '7 days',
             CASE WHEN $4='Draft' THEN NULL ELSE now() END,
             now(),now())`,
    [dealId, sellerId, `Analytics ${state} ${dealId.slice(0, 8)}`, state]
  );
  return dealId;
}

async function cleanup(sellerIds: string[], dealIds: string[]) {
  for (const dealId of dealIds) {
    await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  }
  for (const sellerId of sellerIds) {
    await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id=$1`, [sellerId]).catch(() => undefined);
  }
}

async function getAnalytics(sellerId: string, query = "") {
  return app.inject({
    method: "GET",
    url: `/api/seller/analytics${query}`,
    headers: { "x-seller-id": sellerId }
  });
}

function assertShape(payload: any) {
  for (const key of [
    "generated_at",
    "period",
    "seller",
    "summary",
    "money",
    "deals_by_state",
    "recent_deals",
    "top_deals",
    "weak_deals",
    "buyer_funnel",
    "attribution",
    "action_insights"
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `missing ${key}`);
  }
}

function assertNoForbiddenFields(payload: any) {
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const forbidden of [
    "buyer_phone",
    "buyer_email",
    "delivery_address",
    "payment_token",
    "provider_reference",
    "storage_key",
    "authorization_id",
    "payment_method",
    "commission",
    "payout",
    "balance",
    "withdrawal",
    "revenue_share",
    "affiliate_fee"
  ]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not be exposed`);
  }
}

const sellerA = await seedSeller("a");
const sellerB = await seedSeller("b");
const dealIds = [
  await seedDeal(sellerA, "Draft"),
  await seedDeal(sellerA, "PendingTarget"),
  await seedDeal(sellerA, "Completed"),
  await seedDeal(sellerA, "Failed"),
  await seedDeal(sellerB, "Completed")
];

try {
  await run("seller analytics endpoint exists and defaults to all", async () => {
    const res = await getAnalytics(sellerA);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assertShape(body);
    assert.equal(body.period, "all");
    assert.equal(body.seller.seller_id, sellerA);
    assert.equal(body.seller.business_name, "Analytics a Seller");
    assert.equal(body.seller.is_publish_ready, true);
    assert.equal(body.summary.total_deals, 4);
    assert.equal(body.summary.draft_deals, 1);
    assert.equal(body.summary.active_deals, 1);
    assert.equal(body.summary.completed_deals, 1);
    assert.equal(body.summary.failed_deals, 1);
    assert.equal(body.summary.cancelled_deals, 0);
    assert.equal(body.summary.success_rate_percent, 50);
    assertNoForbiddenFields(body);
  });

  await run("valid periods return stable period values", async () => {
    for (const period of ["30d", "90d", "year"]) {
      const res = await getAnalytics(sellerA, `?period=${period}`);
      assert.equal(res.statusCode, 200, `${period}: ${res.body}`);
      assert.equal((res.json() as any).period, period);
    }
  });

  await run("invalid period returns a controlled error", async () => {
    const res = await getAnalytics(sellerA, "?period=week");
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as any).code, "invalid_period");
  });

  await run("seller isolation excludes another seller's deals", async () => {
    const res = await getAnalytics(sellerB);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.equal(body.seller.seller_id, sellerB);
    assert.equal(body.summary.total_deals, 1);
    assert.equal(body.summary.completed_deals, 1);
    assert.equal(body.summary.failed_deals, 0);
  });

  await run("external seller_id query/body does not override seller context", async () => {
    const queryRes = await getAnalytics(sellerA, `?period=all&seller_id=${encodeURIComponent(sellerB)}`);
    assert.equal(queryRes.statusCode, 200, queryRes.body);
    assert.equal((queryRes.json() as any).seller.seller_id, sellerA);
    assert.equal((queryRes.json() as any).summary.total_deals, 4);

    const bodyRes = await app.inject({
      method: "GET",
      url: "/api/seller/analytics",
      headers: { "content-type": "application/json", "x-seller-id": sellerA },
      payload: { seller_id: sellerB }
    });
    assert.equal(bodyRes.statusCode, 200, bodyRes.body);
    assert.equal((bodyRes.json() as any).seller.seller_id, sellerA);
    assert.equal((bodyRes.json() as any).summary.total_deals, 4);
  });

  await run("response includes all deal states and measurement-only attribution", async () => {
    const res = await getAnalytics(sellerA);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as any;
    assert.deepEqual(body.deals_by_state.map((row: any) => row.state), DEAL_STATES);
    assert.equal(body.attribution.measurement_only, true);
    assert.match(body.attribution.disclaimer_he, /נתוני ייחוס בלבד/);
    assertNoForbiddenFields(body);
  });
} finally {
  await cleanup([sellerA, sellerB], dealIds);
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
