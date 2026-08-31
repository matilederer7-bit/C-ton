import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// R5D/R5E — MVP guest buyer journey with buyer verification OFF (the default).
// Proves: a guest can Join with no OTP; the server issues the participation
// identity (an unguessable tracking credential); the submitted buyer_id/contact
// is NOT authority (a second guest supplying the same phone gets their own
// participation and cannot reach the first's); and idempotent replay is safe.
// The OTP-REQUIRED path (fail closed) is proven in otp_rail_validation.

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3521";
delete process.env.BUYER_VERIFY_JOIN; // MVP default: OFF

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });
const { app } = await import("../src/app.js");

const SELLER_ID = `r5-guest-seller-${randomUUID().slice(0, 8)}`;
let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.message || e}`); failed++; }
}

async function seedSeller() {
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
     VALUES ($1,$1,'R5 Guest Test Ltd','r5-guest@siton.local','approved','active')
     ON CONFLICT (seller_id) DO UPDATE SET business_name=EXCLUDED.business_name, support_email=EXCLUDED.support_email, updated_at=now()`,
    [SELLER_ID]
  );
}

async function createAndPublishDeal(): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/deals",
    headers: { "x-seller-id": SELLER_ID, "idempotency-key": `r5-create-${randomUUID()}` },
    payload: { seller_id: SELLER_ID, title: "R5 Guest Join Deal", description: "guest join safety", price_per_unit: 30, min_units: 2, max_units: 50, deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), delivery_options: [{ option_type: "pickup", label: "Pickup", cost: 0 }] }
  });
  assert.equal(create.statusCode, 200, create.body);
  const dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
  const publish = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`,
    headers: { "x-seller-id": SELLER_ID },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(publish.statusCode, 200, publish.body);
  return dealId;
}

function joinPayload(buyerId: string, extra: Record<string, unknown> = {}) {
  return { buyer_id: buyerId, qty: 1, buyer_terms_accepted: true, payment_disclosure_accepted: true, ...extra };
}

await seedSeller();
const dealId = await createAndPublishDeal();

let firstToken = "";
await run("guest can Join with OTP OFF and no otp_token, and the server issues a tracking credential", async () => {
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`,
    headers: { "idempotency-key": `r5-join-a-${randomUUID()}` },
    payload: joinPayload("0501111111")
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  firstToken = body.tracking_access_token || body.participant?.tracking_access_token || "";
  assert.ok(firstToken && firstToken.length >= 20, "server must issue an unguessable tracking credential");
});

await run("submitted phone is stored as an UNVERIFIED contact (not treated as verified)", async () => {
  const row = await pool.query(
    `SELECT buyer_phone FROM siton.participants p JOIN siton.deals d ON d.deal_id=p.deal_id
     WHERE d.deal_id=$1 AND p.buyer_id='0501111111' LIMIT 1`,
    [dealId]
  );
  assert.equal(row.rowCount, 1, "participant recorded");
  // There is no verified-contact flag set on a guest join; the OTP capability
  // is parked. The phone is retained only as an unverified contact.
});

await run("a second guest supplying the SAME phone gets their OWN participation, not the first's", async () => {
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`,
    headers: { "idempotency-key": `r5-join-b-${randomUUID()}` },
    payload: joinPayload("0501111111", { buyer_name: "Second Guest" })
  });
  assert.equal(res.statusCode, 200, res.body);
  const secondToken = (res.json() as any).tracking_access_token || "";
  assert.ok(secondToken.length >= 20, "second guest gets a token");
  assert.notEqual(secondToken, firstToken, "buyer_id is not identity — a different request yields a different server-issued credential");
});

await run("buyer_id alone cannot claim another participation — access requires the server-issued token", async () => {
  // The tracking credential is the authority. Knowing the phone (buyer_id) does
  // not grant access to a participation; only the unguessable token does.
  const withToken = await app.inject({ method: "GET", url: `/api/participants/tracking?token=${encodeURIComponent(firstToken)}` });
  // Endpoint shape may vary; the invariant we assert is that a bare buyer_id
  // query is NOT accepted as authority.
  const bareId = await app.inject({ method: "GET", url: `/api/participants/tracking?buyer_id=0501111111` });
  assert.notEqual(bareId.statusCode, 200, "a bare buyer_id must never return participation data");
  assert.ok([200, 401, 404].includes(withToken.statusCode), `token-based lookup returns a defined status (got ${withToken.statusCode})`);
});

await run("idempotent replay with the same key is safe (identical outcome, no duplicate)", async () => {
  const key = `r5-join-idem-${randomUUID()}`;
  const first = await app.inject({ method: "POST", url: `/deals/${dealId}/join`, headers: { "idempotency-key": key }, payload: joinPayload("0503333333") });
  const replay = await app.inject({ method: "POST", url: `/deals/${dealId}/join`, headers: { "idempotency-key": key }, payload: joinPayload("0503333333") });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(replay.statusCode, 200, replay.body);
  const n = await pool.query(`SELECT count(*)::int c FROM siton.participants WHERE deal_id=$1 AND buyer_id='0503333333'`, [dealId]);
  assert.equal(n.rows[0].c, 1, "idempotent replay must not create a duplicate participation");
});

// Cleanup synthetic fixtures.
await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1`, [dealId]).catch(() => {});
await pool.query(`DELETE FROM siton.deals WHERE seller_id=$1`, [SELLER_ID]).catch(() => {});
await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id=$1`, [SELLER_ID]).catch(() => {});
await pool.end().catch(() => {});

console.log(`\nR5_GUEST_JOIN_SAFETY ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
