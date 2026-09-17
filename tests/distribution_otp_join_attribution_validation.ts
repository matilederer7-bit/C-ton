// DISTRIBUTION ATTRIBUTION survives the OTP / login / resume / checkout path.
//
// With buyer verification REQUIRED for Join, a buyer who entered through a
// seller distribution link requests an OTP, verifies it (buyer session), may
// park a resume context, and finally joins with the otp_token. The last
// eligible distribution link must still be attributed to that Join; a buyer
// who never touched a link keeps joining normally.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3655";
process.env.BUYER_VERIFY_JOIN = "required";
process.env.OTP_TEST_BYPASS_CODE = "424242";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });
const { app } = await import("../src/app.js");

const SELLER = `otp-dist-seller-${randomUUID().slice(0, 8)}`;
let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.stack || e}`); failed++; }
}

await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
   VALUES ($1,$1,'OTP Dist Ltd','otp-dist@siton.local','approved','active') ON CONFLICT (seller_id) DO NOTHING`,
  [SELLER]
);

const create = await app.inject({
  method: "POST", url: "/deals",
  headers: { "x-seller-id": SELLER, "idempotency-key": `otp-dist-create-${randomUUID()}` },
  payload: {
    seller_id: SELLER, title: "OTP Distribution Deal", description: "otp attribution proof",
    price_per_unit: 40, min_units: 2, max_units: 100,
    deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    delivery_options: [{ option_type: "pickup", label: "Pickup — Herzl 12, Tel Aviv", cost: 0 }]
  }
});
assert.equal(create.statusCode, 200, create.body);
const dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
const publish = await app.inject({
  method: "POST", url: `/deals/${dealId}/publish`, headers: { "x-seller-id": SELLER },
  payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
});
assert.equal(publish.statusCode, 200, publish.body);
const linkRes = await app.inject({
  method: "POST", url: `/api/seller/deals/${dealId}/distribution/links`,
  headers: { "x-seller-id": SELLER }, payload: { internal_name: "Telegram", channel: "telegram" }
});
assert.equal(linkRes.statusCode, 201, linkRes.body);
const link = (linkRes.json() as any).link;

function buyerCookie(res: any): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join("; ") : String(raw || "");
  const match = header.match(/siton_buyer_session=([^;]*)/);
  return match ? `siton_buyer_session=${match[1]}` : "";
}

async function verifiedBuyer(phone: string) {
  const request = await app.inject({ method: "POST", url: "/api/otp/request", payload: { channel: "sms", destination: phone, purpose: "buyer_join", deal_id: dealId } });
  assert.equal(request.statusCode, 200, request.body);
  const challengeId = (request.json() as any).challenge_id;
  const verify = await app.inject({ method: "POST", url: "/api/otp/verify", payload: { challenge_id: challengeId, code: "424242" } });
  assert.equal(verify.statusCode, 200, verify.body);
  const body = verify.json() as any;
  assert.ok(body.otp_token, "otp_token issued");
  return { otpToken: String(body.otp_token), challengeId: String(challengeId), cookie: buyerCookie(verify) };
}

async function linkMetrics() {
  const res = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/distribution`, headers: { "x-seller-id": SELLER } });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as any).links.find((l: any) => l.link_id === link.link_id).metrics;
}

await run("OTP is really required for Join in this proof (no token → refused, nothing attributed)", async () => {
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`, headers: { "idempotency-key": `otp-dist-${randomUUID()}` },
    payload: { buyer_id: "0540000001", buyer_name: "בלי אימות", qty: 1, buyer_terms_accepted: true, payment_disclosure_accepted: true, affiliate_ref: link.source_code }
  });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, `expected a refusal, got ${res.statusCode}: ${res.body}`);
  assert.equal((await linkMetrics()).joins, 0);
});

await run("OTP request → verify → resume context → Join keeps the distribution attribution", async () => {
  const buyer = await verifiedBuyer("0540000002");
  // The buyer parks a resume context (OTP verified, before checkout): the
  // attribution ref rides with it server-side, not only in a query string.
  if (buyer.cookie) {
    const park = await app.inject({
      method: "PUT", url: `/api/buyer/resume/${dealId}`, headers: { cookie: buyer.cookie },
      payload: { selected_quantity: 2, attribution_ref: link.source_code, workflow_position: "otp_verified" }
    });
    assert.equal(park.statusCode, 200, park.body);
    const resume = await app.inject({ method: "GET", url: `/api/buyer/resume/${dealId}`, headers: { cookie: buyer.cookie } });
    assert.equal(resume.statusCode, 200, resume.body);
    assert.equal((resume.json() as any).resume?.attribution_ref ?? (resume.json() as any).attribution_ref, link.source_code, "attribution_ref survives the resume context");
  }
  const joinRes = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`, headers: { "idempotency-key": `otp-dist-${randomUUID()}`, ...(buyer.cookie ? { cookie: buyer.cookie } : {}) },
    payload: {
      buyer_id: "0540000002", buyer_name: "מאומתת", qty: 2, buyer_terms_accepted: true, payment_disclosure_accepted: true,
      otp_token: buyer.otpToken, otp_challenge_id: buyer.challengeId,
      affiliate_ref: link.source_code, viral_last_touch_code: link.source_code, viral_last_touch_at: new Date().toISOString(),
      viral_visitor_id: "v_otp_buyer", viral_session_id: "s_otp_buyer"
    }
  });
  assert.equal(joinRes.statusCode, 200, joinRes.body);
  const body = joinRes.json() as any;
  assert.equal(body.viral.attributed, true, "attribution survives OTP + checkout");
  const attr = await pool.query(`SELECT parent_link_id, origin_ref_type FROM siton.viral_attributions WHERE participant_id=$1`, [body.participant_id]);
  assert.equal(String(attr.rows[0].parent_link_id), link.link_id);
  assert.equal(attr.rows[0].origin_ref_type, "seller");
  const metrics = await linkMetrics();
  assert.equal(metrics.joins, 1);
  assert.equal(metrics.joined_units, 2);
  assert.equal(metrics.charged_units, 0, "a join is never shown as a final charge");
});

await run("a verified buyer without any distribution link keeps joining normally (unattributed)", async () => {
  const buyer = await verifiedBuyer("0540000003");
  const joinRes = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`, headers: { "idempotency-key": `otp-dist-${randomUUID()}` },
    payload: {
      buyer_id: "0540000003", buyer_name: "ישיר", qty: 1, buyer_terms_accepted: true, payment_disclosure_accepted: true,
      otp_token: buyer.otpToken, otp_challenge_id: buyer.challengeId
    }
  });
  assert.equal(joinRes.statusCode, 200, joinRes.body);
  assert.equal((joinRes.json() as any).viral.attributed, false);
  assert.equal((await linkMetrics()).joins, 1, "the direct join is not attributed to the link");
});

await app.close().catch(() => undefined);
await pool.end();
console.log(`\ndistribution otp join attribution validation: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
