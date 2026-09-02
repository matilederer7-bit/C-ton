// P0.3 — DB-exercised proof for the routes the hosted acceptance kept
// catching: business-profile upsert (parameter typing + write-only bank
// column), pause (zero-join inventory sync) and reopen (outbox re-enqueue
// without colliding with the pending publish-time deadline_check).
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

const sellerId = `seller-p03-${randomUUID().slice(0, 8)}`;
const H = { "x-seller-id": sellerId, "content-type": "application/json" };

await run("business profile PUT creates, derives statuses, keeps bank number write-only", async () => {
  const res = await app.inject({
    method: "PUT", url: "/api/seller/business-profile", headers: H,
    payload: {
      business_name: "עסק בדיקה", business_id_number: "515000000", contact_name: "בודק",
      contact_phone: "0501234567", bank_account_holder: "בודק", bank_name: "לאומי",
      bank_branch: "800", bank_account_number: "12345678"
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.statuses.profile_complete, true);
  assert.equal(body.statuses.settlement_ready, true);
  assert.equal(body.statuses.grow_onboarding, "not_started");
  assert.equal(body.business_profile.bank_account_last4, "5678");
  assert.ok(!("bank_account_number" in body.business_profile), "full bank number must never return");
  assert.ok(!res.body.includes("12345678"), "full bank number leaked in response");
});

await run("business profile PUT with empty bank number keeps the stored one (no read of the column)", async () => {
  const res = await app.inject({
    method: "PUT", url: "/api/seller/business-profile", headers: H,
    payload: { business_name: "עסק בדיקה מעודכן", business_id_number: "515000000", contact_name: "בודק", contact_phone: "0501234567", bank_account_holder: "בודק", bank_name: "לאומי", bank_branch: "800", bank_account_number: "" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.business_profile.bank_account_last4, "5678", "stored last4 must survive an empty input");
  const stored = await pool.query(`SELECT bank_account_number FROM siton.seller_business_profiles WHERE seller_id=$1`, [sellerId]);
  assert.equal(stored.rows[0].bank_account_number, "12345678", "stored full number must survive an empty input");
});

let dealId = "";
await run("publish → pause (zero joins) → reopen without outbox collision", async () => {
  const create = await app.inject({
    method: "POST", url: "/deals", headers: { ...H, "idempotency-key": `p03-${Date.now()}` },
    payload: {
      title: "עסקת השהיה", description_short: "בדיקה", price_per_unit: 10, min_units: 5, max_units: 20,
      deadline: new Date(Date.now() + 3 * 864e5).toISOString(), deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "איסוף", cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 }]
    }
  });
  assert.equal(create.statusCode, 200, create.body);
  dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
  const pub = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: { ...H, "idempotency-key": `p03p-${Date.now()}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(pub.statusCode, 200, pub.body);

  const close = await app.inject({ method: "POST", url: `/deals/${dealId}/close_joining`, headers: { ...H, "idempotency-key": `p03c-${Date.now()}` }, payload: {} });
  assert.equal(close.statusCode, 200, close.body);
  assert.equal((close.json() as any).close_reason, "manual");

  const stored = await pool.query(`SELECT state, close_reason FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(stored.rows[0].state, "ClosedForJoining");
  assert.equal(stored.rows[0].close_reason, "manual");

  const reopen = await app.inject({ method: "POST", url: `/api/deals/${dealId}/reopen_joining`, headers: { ...H, "idempotency-key": `p03r-${Date.now()}` }, payload: {} });
  assert.equal(reopen.statusCode, 200, reopen.body);
  assert.equal((reopen.json() as any).state, "PendingTarget");

  const pending = await pool.query(
    `SELECT count(*)::int AS n FROM siton.outbox_events
     WHERE event_type='deadline_check' AND aggregate_type='deal' AND aggregate_id=$1 AND status='pending'`,
    [dealId]
  );
  assert.equal(pending.rows[0].n, 1, "exactly one pending deadline_check must remain");

  // pause again and reopen again — replay-safe
  const close2 = await app.inject({ method: "POST", url: `/deals/${dealId}/close_joining`, headers: { ...H, "idempotency-key": `p03c2-${Date.now()}` }, payload: {} });
  assert.equal(close2.statusCode, 200, close2.body);
  const reopen2 = await app.inject({ method: "POST", url: `/api/deals/${dealId}/reopen_joining`, headers: { ...H, "idempotency-key": `p03r2-${Date.now()}` }, payload: {} });
  assert.equal(reopen2.statusCode, 200, reopen2.body);
});

await run("reopen refuses when not paused / not manual", async () => {
  const r = await app.inject({ method: "POST", url: `/api/deals/${dealId}/reopen_joining`, headers: { ...H, "idempotency-key": `p03r3-${Date.now()}` }, payload: {} });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((r.json() as any).code, "deal_not_paused");
});

await pool.end().catch(() => undefined);
console.log(`\nP03_ROUTE_VALIDATION ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
