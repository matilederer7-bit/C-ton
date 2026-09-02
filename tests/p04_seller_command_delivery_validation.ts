// P0.4 — seller command center + delivery editing, DB-exercised:
//  * analytics carries the new canonical sections (series/funnel/viral/
//    action_center/recent_activity) and the server-side fee PROJECTION uses
//    the same 8%+VAT constitution as real charges
//  * SELLER ISOLATION at the API level: seller B cannot scope analytics to
//    seller A's deal and cannot open seller A's viral tree (404, like missing)
//  * delivery PUT: Draft always; published+ZERO-reliance allowed and audited
//    (deal_field_change_audit); any participant locks it (409)
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const sellerA = `seller-p04a-${randomUUID().slice(0, 8)}`;
const sellerB = `seller-p04b-${randomUUID().slice(0, 8)}`;
const HA = { "x-seller-id": sellerA, "content-type": "application/json" };
const HB = { "x-seller-id": sellerB, "content-type": "application/json" };

async function createDeal(headers: Record<string, string>, title: string) {
  const res = await app.inject({
    method: "POST", url: "/deals", headers: { ...headers, "idempotency-key": `p04-${randomUUID().slice(0, 12)}` },
    payload: {
      title, description_short: "בדיקת P0.4", price_per_unit: 30, min_units: 5, max_units: 20,
      deadline: new Date(Date.now() + 3 * 864e5).toISOString(), deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "איסוף מהרצל 12", cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 }]
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  return String(body.deal?.deal_id || body.deal_id);
}

async function publish(headers: Record<string, string>, dealId: string) {
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: { ...headers, "idempotency-key": `p04p-${randomUUID().slice(0, 12)}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(res.statusCode, 200, res.body);
}

let dealA = "";
let dealB = "";

await run("setup: seller A and seller B each own a published deal", async () => {
  dealA = await createDeal(HA, "עסקת מוכר א");
  dealB = await createDeal(HB, "עסקת מוכר ב");
  // publish requires a publish-ready seller profile — set it through the
  // canonical business-profile route (also syncs seller_accounts)
  for (const headers of [HA, HB]) {
    const bp = await app.inject({
      method: "PUT", url: "/api/seller/business-profile", headers,
      payload: { business_name: "עסק בדיקה", business_id_number: "515000001", contact_name: "בודק", contact_phone: "0501234567" }
    });
    assert.equal(bp.statusCode, 200, bp.body);
  }
  await publish(HA, dealA);
  await publish(HB, dealB);
});

await run("analytics: new canonical sections exist; 7d period valid; projection follows the 8% constitution", async () => {
  const res = await app.inject({ method: "GET", url: "/api/seller/analytics?period=7d", headers: HA });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  for (const key of ["series", "funnel", "share_channels", "viral", "recent_activity", "action_center", "summary", "overview", "money"]) {
    assert.ok(key in body, `analytics missing section ${key}`);
  }
  assert.ok(Array.isArray(body.series.joins_daily));
  assert.ok(Array.isArray(body.recent_activity));
  // deal.publish must appear in the seller's activity stream
  assert.ok(body.recent_activity.some((a: any) => a.message_he?.includes("פורסמה")), "publish event missing from activity");
  const expectedGross = Number(body.overview.gross_expected_amount || 0);
  const expectedFee = Number(body.overview.expected_platform_fee_total_amount || 0);
  if (expectedGross > 0) {
    const impliedRate = expectedFee / expectedGross;
    assert.ok(Math.abs(impliedRate - 0.08 * 1.18) < 0.002, `projection fee rate drifted: ${impliedRate}`);
  }
});

await run("isolation: seller B cannot scope analytics to seller A's deal (404)", async () => {
  const res = await app.inject({ method: "GET", url: `/api/seller/analytics?period=all&deal_id=${dealA}`, headers: HB });
  assert.equal(res.statusCode, 404, res.body);
});

await run("isolation: seller B cannot open seller A's viral tree (404); owner can", async () => {
  const foreign = await app.inject({ method: "GET", url: `/api/seller/deals/${dealA}/viral-tree`, headers: HB });
  assert.equal(foreign.statusCode, 404, foreign.body);
  const own = await app.inject({ method: "GET", url: `/api/seller/deals/${dealA}/viral-tree`, headers: HA });
  assert.equal(own.statusCode, 200, own.body);
  assert.ok(Array.isArray((own.json() as any).nodes));
});

await run("delivery: published deal with ZERO reliance is editable, transactional and audited", async () => {
  const before = await app.inject({ method: "GET", url: `/api/seller/deals/${dealA}`, headers: HA });
  assert.equal(before.statusCode, 200, before.body);
  const beforeBody = before.json() as any;
  assert.equal(beforeBody.seller_actions.delivery_editable, true, "published zero-reliance deal must be delivery-editable");

  const put = await app.inject({
    method: "PUT", url: `/api/seller/deals/${dealA}/delivery`, headers: HA,
    payload: { delivery_options: [
      { option_type: "pickup", label: "איסוף מנקודה חדשה", cost: 0, sort_order: 0, latitude: 31.78, longitude: 35.21 },
      { option_type: "delivery", label: "משלוח עד הבית", cost: 25, sort_order: 1 }
    ] }
  });
  assert.equal(put.statusCode, 200, put.body);
  const putBody = put.json() as any;
  assert.equal(putBody.delivery_options.length, 2);
  assert.equal(Number(putBody.delivery_options[0].latitude), 31.78);

  const audit = await pool.query(
    `SELECT field_scope, deal_state, old_value, new_value FROM siton.deal_field_change_audit WHERE deal_id=$1`,
    [dealA]
  );
  assert.equal(audit.rowCount, 1, "delivery change must be audited");
  assert.equal(audit.rows[0].field_scope, "delivery_options");
  assert.equal(audit.rows[0].deal_state, "PendingTarget");
  assert.ok(JSON.stringify(audit.rows[0].old_value).includes("הרצל"), "audit must carry the before value");

  // audit rail is append-only
  await assert.rejects(
    pool.query(`UPDATE siton.deal_field_change_audit SET field_scope='x' WHERE deal_id=$1`, [dealA]),
    /append-only/
  );
});

await run("delivery: ANY participant locks editing (409 + delivery_editable=false)", async () => {
  await pool.query(
    `INSERT INTO siton.participants (deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost)
     VALUES ($1,'p04-buyer',1,'JoinedAuthorized','AuthHeld',0)`,
    [dealA]
  );
  const put = await app.inject({
    method: "PUT", url: `/api/seller/deals/${dealA}/delivery`, headers: HA,
    payload: { delivery_options: [{ option_type: "pickup", label: "ניסיון שינוי אסור", cost: 0, sort_order: 0 }] }
  });
  assert.equal(put.statusCode, 409, put.body);
  assert.equal((put.json() as any).code, "delivery_locked_after_reliance");

  const after = await app.inject({ method: "GET", url: `/api/seller/deals/${dealA}`, headers: HA });
  const afterBody = after.json() as any;
  assert.equal(afterBody.seller_actions.delivery_editable, false);
  assert.equal(afterBody.seller_actions.delivery_lock_reason, "buyer_reliance");
  // the options themselves stay fully VISIBLE
  assert.ok((afterBody.delivery_options || []).length >= 2, "locked delivery must remain visible");
});

await run("delivery: foreign seller cannot edit (404) and Draft stays fully editable", async () => {
  const foreign = await app.inject({
    method: "PUT", url: `/api/seller/deals/${dealB}/delivery`, headers: HA,
    payload: { delivery_options: [{ option_type: "pickup", label: "פריצה", cost: 0, sort_order: 0 }] }
  });
  assert.equal(foreign.statusCode, 404, foreign.body);

  const draftDeal = await createDeal(HA, "טיוטת אספקה");
  const draftPut = await app.inject({
    method: "PUT", url: `/api/seller/deals/${draftDeal}/delivery`, headers: HA,
    payload: { delivery_options: [{ option_type: "distribution_point", label: "נקודת חלוקה מרכזית", cost: 5, sort_order: 0 }] }
  });
  assert.equal(draftPut.statusCode, 200, draftPut.body);
});

await pool.end().catch(() => undefined);
console.log(`\nP04_VALIDATION ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
