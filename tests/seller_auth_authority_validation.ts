import { strict as assert } from "node:assert";
import pg from "pg";
import { hashSellerSessionToken } from "../src/seller_auth.js";

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function asCookie(value: string | string[] | undefined) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function cookieToken(cookieHeader: string) {
  const match = /siton_seller_session=([^;]+)/.exec(cookieHeader || "");
  return match ? decodeURIComponent(String(match[1] || "")) : "";
}

await run("non-demo create publish close prepare charge and cancel derive authority from DB-backed seller sessions", async () => {
  process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
  process.env.SELLER_SESSION_SECRET = "seller-session-secret-authority";
  process.env.PORT = "3048";
  process.env.OTP_TEST_BYPASS_CODE = process.env.OTP_TEST_BYPASS_CODE || "424242";
  const secret = process.env.SELLER_SESSION_SECRET || "";

  const { app } = await import(`../src/app.js?seller-auth-app-${Date.now()}`);
  const { Pool } = pg;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
  });

  try {
    const provisionAlpha = await app.inject({
      method: "POST",
      url: "/api/admin/seller-auth/seller-alpha/provision",
      payload: { display_name: "Seller Alpha", login_email: "alpha@example.com", access_code: "alpha-pass-123", auth_enabled: true }
    });
    assert.equal(provisionAlpha.statusCode, 200);

    const provisionBeta = await app.inject({
      method: "POST",
      url: "/api/admin/seller-auth/seller-beta/provision",
      payload: { display_name: "Seller Beta", login_email: "beta@example.com", access_code: "beta-pass-123", auth_enabled: true }
    });
    assert.equal(provisionBeta.statusCode, 200);

    const alphaLogin = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: { identifier: "alpha@example.com", access_code: "alpha-pass-123" }
    });
    const betaLogin = await app.inject({
      method: "POST",
      url: "/api/seller/session/login",
      payload: { identifier: "beta@example.com", access_code: "beta-pass-123" }
    });
    assert.equal(alphaLogin.statusCode, 200);
    assert.equal(betaLogin.statusCode, 200);

    const alphaCookie = asCookie(alphaLogin.headers["set-cookie"]);
    const betaCookie = asCookie(betaLogin.headers["set-cookie"]);

    const denied = await app.inject({
      method: "POST",
      url: "/deals",
      payload: {
        title: "Denied without session",
        price_per_unit: 20,
        min_units: 10,
        max_units: 20,
        deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString()
      }
    });
    assert.equal(denied.statusCode, 401);

    const create = await app.inject({
      method: "POST",
      url: "/deals",
      headers: {
        cookie: alphaCookie,
        "x-seller-id": "seller-beta",
        "x-request-id": `seller-auth-create-${Date.now()}`,
        "idempotency-key": `seller-auth-create-${Date.now()}`
      },
      payload: {
        title: `Seller Auth Owned Deal ${Date.now()}`,
        price_per_unit: 25,
        min_units: 10,
        max_units: 20,
        deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString()
      }
    });
    assert.equal(create.statusCode, 200);
    const created = create.json() as any;

    const ownership = await pool.query(`SELECT seller_id FROM siton.deals WHERE deal_id=$1`, [created.deal_id]);
    assert.equal(String(ownership.rows[0].seller_id), "seller-alpha");

    const wrongPublish = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/publish`,
      headers: {
        cookie: betaCookie,
        "x-seller-id": "seller-alpha",
        "x-request-id": `seller-auth-publish-wrong-${Date.now()}`,
        "idempotency-key": `seller-auth-publish-wrong-${created.deal_id}`
      },
      payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
    });
    assert.equal(wrongPublish.statusCode, 404);

    // Publish gate requires a complete seller profile (business_name + contact method).
    // Seed the alpha profile so the rightPublish below clears the readiness check.
    const profileSetup = await app.inject({
      method: "PUT",
      url: "/api/seller/profile",
      headers: { cookie: alphaCookie, "x-seller-id": "seller-beta" },
      payload: { business_name: "Seller Alpha Workspace", support_email: "alpha-support@example.com" }
    });
    assert.equal(profileSetup.statusCode, 200);

    const rightPublish = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/publish`,
      headers: {
        cookie: alphaCookie,
        "x-seller-id": "seller-beta",
        "x-request-id": `seller-auth-publish-right-${Date.now()}`,
        "idempotency-key": `seller-auth-publish-right-${created.deal_id}`
      },
      payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
    });
    assert.equal(rightPublish.statusCode, 200);

    const buyerId = `+97250${String(Date.now()).slice(-7)}`;
    const otpRequest = await app.inject({
      method: "POST",
      url: "/api/otp/request",
      payload: { channel: "sms", destination: buyerId, purpose: "buyer_join" }
    });
    assert.equal(otpRequest.statusCode, 200, otpRequest.body);
    const otpChallengeId = (otpRequest.json() as any).challenge_id;
    const otpVerify = await app.inject({
      method: "POST",
      url: "/api/otp/verify",
      payload: { challenge_id: otpChallengeId, code: "424242" }
    });
    assert.equal(otpVerify.statusCode, 200, otpVerify.body);
    const otpToken = (otpVerify.json() as any).otp_token;

    const reachTarget = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/join`,
      headers: {
        "x-request-id": `seller-auth-reach-target-${Date.now()}`,
        "idempotency-key": `seller-auth-reach-target-${created.deal_id}`
      },
      payload: {
        buyer_id: buyerId,
        qty: 9,
        buyer_terms_accepted: true,
        payment_disclosure_accepted: true,
        otp_token: otpToken,
        otp_challenge_id: otpChallengeId
      }
    });
    assert.equal(reachTarget.statusCode, 200, reachTarget.body);

    const wrongClose = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/close_joining`,
      headers: { cookie: betaCookie, "idempotency-key": `wrong-close-${created.deal_id}` }
    });
    assert.equal(wrongClose.statusCode, 404);

    const rightClose = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/close_joining`,
      headers: { cookie: alphaCookie, "idempotency-key": `right-close-${created.deal_id}` }
    });
    assert.equal(rightClose.statusCode, 200);

    const rightPrepare = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/prepare_charging`,
      headers: { cookie: alphaCookie, "idempotency-key": `right-prepare-${created.deal_id}` }
    });
    assert.equal(rightPrepare.statusCode, 200);

    const wrongStart = await app.inject({
      method: "POST",
      url: `/deals/${created.deal_id}/charging/start`,
      headers: { cookie: betaCookie, "idempotency-key": `wrong-start-${created.deal_id}` }
    });
    assert.equal(wrongStart.statusCode, 404);

    const cancelOtherSellerDraft = await app.inject({
      method: "POST",
      url: "/deals",
      headers: {
        cookie: betaCookie,
        "idempotency-key": `seller-beta-create-${Date.now()}`,
        "x-request-id": `seller-beta-create-${Date.now()}`
      },
      payload: {
        title: `Seller Beta Draft ${Date.now()}`,
        price_per_unit: 30,
        min_units: 10,
        max_units: 20,
        deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString()
      }
    });
    assert.equal(cancelOtherSellerDraft.statusCode, 200);
    const betaDraftDealId = (cancelOtherSellerDraft.json() as any).deal_id;

    const alphaCancelBeta = await app.inject({
      method: "POST",
      url: `/deals/${betaDraftDealId}/cancel`,
      headers: { cookie: alphaCookie, "idempotency-key": `alpha-cancel-beta-${betaDraftDealId}` }
    });
    assert.equal(alphaCancelBeta.statusCode, 404);

    const betaCancelOwn = await app.inject({
      method: "POST",
      url: `/deals/${betaDraftDealId}/cancel`,
      headers: { cookie: betaCookie, "idempotency-key": `beta-cancel-own-${betaDraftDealId}` }
    });
    assert.equal(betaCancelOwn.statusCode, 200);

    const alphaSessionRows = await pool.query(
      `SELECT seller_id FROM siton.seller_sessions WHERE token_hash = $1`,
      [hashSellerSessionToken(cookieToken(alphaCookie), secret) || ""]
    );
    assert.equal(String(alphaSessionRows.rows[0].seller_id), "seller-alpha");
  } finally {
    await pool.end();
    await app.close().catch(() => {});
  }
});

process.exit(0);

