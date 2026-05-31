import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.PORT = process.env.PORT || "3461";
// OTP rail enforcement: join now requires a verified OTP. Use bypass code in tests.
process.env.OTP_TEST_BYPASS_CODE = process.env.OTP_TEST_BYPASS_CODE || "424242";
delete process.env.NODE_ENV;
delete process.env.APP_ENV;
delete process.env.RENDER;
delete process.env.RENDER_EXTERNAL_URL;

const { app } = await import("../src/app.js");
import {
  PAYMENT_DISCLOSURE_VERSION,
  SELLER_TERMS_VERSION,
  TERMS_VERSION
} from "../src/legal_policy_versions.js";

const { Pool } = pg;
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";
const pool = new Pool({ connectionString: DB_URL, max: 5 });

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function seedReadySeller(suffix = randomUUID()) {
  const sellerId = `legal-seller-${suffix}`;
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email)
     VALUES ($1,'Legal Seller','Legal Seller','legal@example.test')
     ON CONFLICT (seller_id) DO UPDATE
     SET business_name=EXCLUDED.business_name, support_email=EXCLUDED.support_email`,
    [sellerId]
  );
  return sellerId;
}

async function createDeal(sellerId: string, suffix = randomUUID()) {
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-seller-id": sellerId,
      "x-request-id": `legal-create-${suffix}`,
      "idempotency-key": `legal-create-${suffix}`
    },
    payload: {
      title: `עסקת אמון ${suffix}`,
      price_per_unit: 20,
      min_units: 2,
      max_units: 6,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "איסוף עצמי", cost: 0 }]
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().deal_id as string;
}

async function publishDeal(dealId: string, sellerId: string, suffix = randomUUID()) {
  const response = await app.inject({
    method: "POST",
    url: `/deals/${dealId}/publish`,
    headers: {
      "x-seller-id": sellerId,
      "x-request-id": `legal-publish-${suffix}`,
      "idempotency-key": `legal-publish-${suffix}`
    },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function cleanupDeal(dealId: string, sellerId: string) {
  await pool.query(`DELETE FROM siton.legal_acceptances WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.notification_events WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.audit_log WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.idempotency_log WHERE idempotency_key LIKE $1`, [`%${dealId}%`]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]).catch(() => undefined);
  await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id=$1`, [sellerId]).catch(() => undefined);
}

await run("legal pages and payment disclosure text are available", async () => {
  const terms = await app.inject({ method: "GET", url: "/legal/terms" });
  const refunds = await app.inject({ method: "GET", url: "/legal/refunds" });
  const privacy = await app.inject({ method: "GET", url: "/legal/privacy" });
  const sellers = await app.inject({ method: "GET", url: "/legal/sellers" });
  const affiliates = await app.inject({ method: "GET", url: "/legal/affiliates" });
  const demo = await app.inject({ method: "GET", url: "/legal/demo" });
  const payments = await app.inject({ method: "GET", url: "/legal/payments" });
  const appJs = await readFile("frontend/app.js", "utf8");
  assert.equal(terms.statusCode, 200);
  assert.equal(refunds.statusCode, 200);
  assert.equal(privacy.statusCode, 200);
  assert.equal(sellers.statusCode, 200);
  assert.equal(affiliates.statusCode, 200);
  assert.equal(demo.statusCode, 200);
  assert.equal(payments.statusCode, 200);
  assert.match(terms.body, /תקנון שימוש ותנאי שירות C-ton/);
  assert.match(refunds.body, /מדיניות ביטולים, החזרים ושחרור מסגרת/);
  assert.doesNotMatch(`${terms.body}\n${refunds.body}\n${privacy.body}`, /ניווט מהיר|עמודי trust ציבוריים|placeholder פנימי|פתוח להצגה/);
  assert.match(appJs, /\/legal\/terms/);
  assert.match(appJs, /\/legal\/refunds/);
  assert.match(appJs, /sellerPublishLegalAccepted/);
  assert.match(appJs, /buyerPaymentDisclosureAcceptance/);
  assert.match(appJs, /90%/);
});

await run("seller publish without legal acceptance is blocked", async () => {
  const sellerId = await seedReadySeller();
  const dealId = await createDeal(sellerId);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/deals/${dealId}/publish`,
      headers: { "x-seller-id": sellerId }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "seller_terms_required");
  } finally {
    await cleanupDeal(dealId, sellerId);
  }
});

await run("seller publish with legal acceptance succeeds and persists acceptance", async () => {
  const sellerId = await seedReadySeller();
  const dealId = await createDeal(sellerId);
  try {
    await publishDeal(dealId, sellerId);
    const rows = await pool.query(
      `SELECT acceptance_type, policy_version
       FROM siton.legal_acceptances
       WHERE actor_type='seller' AND actor_ref=$1 AND deal_id=$2`,
      [sellerId, dealId]
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].acceptance_type, "seller_publish_terms");
    assert.equal(rows.rows[0].policy_version, SELLER_TERMS_VERSION);
  } finally {
    await cleanupDeal(dealId, sellerId);
  }
});

await run("buyer join without payment disclosure is blocked", async () => {
  const sellerId = await seedReadySeller();
  const dealId = await createDeal(sellerId);
  try {
    await publishDeal(dealId, sellerId);
    const option = await pool.query(`SELECT option_id FROM siton.deal_delivery_options WHERE deal_id=$1 LIMIT 1`, [dealId]);
    const response = await app.inject({
      method: "POST",
      url: `/deals/${dealId}/join`,
      headers: { "x-request-id": `legal-join-missing-${dealId}` },
      payload: {
        buyer_id: `+97250${String(Date.now()).slice(-7)}`,
        qty: 1,
        delivery_option_id: option.rows[0].option_id
      }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "payment_disclosure_required");
  } finally {
    await cleanupDeal(dealId, sellerId);
  }
});

await run("buyer join persists payment disclosure acceptance idempotently", async () => {
  const sellerId = await seedReadySeller();
  const dealId = await createDeal(sellerId);
  try {
    await publishDeal(dealId, sellerId);
    const option = await pool.query(`SELECT option_id FROM siton.deal_delivery_options WHERE deal_id=$1 LIMIT 1`, [dealId]);
    const buyerId = `+97250${String(Date.now()).slice(-7)}`;

    // OTP rail: request + verify so join carries a valid otp_token.
    const otpRequest = await app.inject({
      method: "POST",
      url: "/api/otp/request",
      payload: { channel: "sms", destination: buyerId, purpose: "buyer_join" }
    });
    assert.equal(otpRequest.statusCode, 200, otpRequest.body);
    const challengeId = (otpRequest.json() as any).challenge_id;
    const otpVerify = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: { challenge_id: challengeId, code: "424242" }
    });
    assert.equal(otpVerify.statusCode, 200, otpVerify.body);
    const otpToken = (otpVerify.json() as any).otp_token;

    const headers = {
      "x-request-id": `legal-join-${dealId}`,
      "idempotency-key": `legal-join-${dealId}:${buyerId}`
    };
    const payload = {
      buyer_id: buyerId,
      qty: 1,
      delivery_option_id: option.rows[0].option_id,
      payment_disclosure_accepted: true,
      otp_token: otpToken,
      otp_challenge_id: challengeId
    };
    const first = await app.inject({ method: "POST", url: `/deals/${dealId}/join`, headers, payload });
    const second = await app.inject({ method: "POST", url: `/deals/${dealId}/join`, headers, payload });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().participant_id, first.json().participant_id);
    const rows = await pool.query(
      `SELECT acceptance_type, policy_version, COUNT(*) AS cnt
       FROM siton.legal_acceptances
       WHERE actor_type='buyer' AND actor_ref=$1 AND deal_id=$2 AND participant_id=$3
       GROUP BY acceptance_type, policy_version
       ORDER BY acceptance_type`,
      [buyerId, dealId, first.json().participant_id]
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.acceptance_type, row.policy_version, Number(row.cnt)]),
      [
        ["buyer_payment_disclosure", PAYMENT_DISCLOSURE_VERSION, 1]
      ]
    );
  } finally {
    await cleanupDeal(dealId, sellerId);
  }
});

await run("public deal footer and UI wording stay trust-safe", async () => {
  const appJs = await app.inject({ method: "GET", url: "/app/assets/app.js" });
  assert.match(appJs.body, /\/legal\/terms/);
  assert.match(appJs.body, /\/legal\/refunds/);
  assert.match(appJs.body, /\/legal\/privacy/);
  assert.doesNotMatch(appJs.body, /ניווט מהיר|עמודי trust ציבוריים|placeholder פנימי|פתוח להצגה/);
  assert.doesNotMatch(appJs.body, /שלם עכשיו/);
  assert.doesNotMatch(appJs.body, /שילמת/);
  assert.doesNotMatch(appJs.body, /סיטון תספק את המוצר/);
});

await app.close().catch(() => undefined);
await pool.end();

