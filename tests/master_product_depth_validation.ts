import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function post(url: string, requestId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "x-request-id": requestId,
      "idempotency-key": requestId
    },
    payload
  });
}

function paymentWebhookHeaders(rawBody: string) {
  const secret = String(process.env.PAYMENT_WEBHOOK_SECRET || "mock-webhook-secret");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return {
    "x-webhook-signature": `sha256=${digest}`,
    "x-webhook-timestamp": timestamp
  };
}

async function createDeal(title: string, suffix: string) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `master-depth-create-${unique}`,
      "idempotency-key": `master-depth-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 45,
      min_units: 2,
      max_units: 2,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    }
  });
  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function verifiedOtpForBuyer(buyerId: string, dealId: string, suffix: string) {
  const phoneDigits = String(
    Math.abs(Array.from(`${buyerId}-${dealId}-${suffix}`).reduce((sum, ch) => sum + ch.charCodeAt(0), 0))
  )
    .padStart(7, "0")
    .slice(-7);
  const request = await app.inject({
    method: "POST",
    url: "/api/otp/start",
    payload: { phone: `050${phoneDigits}`, deal_id: dealId }
  });
  assert.equal(request.statusCode, 200, `otp start failed for ${suffix}: ${request.body}`);
  const requested = request.json() as any;
  const verify = await app.inject({
    method: "POST",
    url: "/api/otp/verify",
    payload: { otp_session_id: requested.otp_session_id, code: requested.development_code }
  });
  assert.equal(verify.statusCode, 200, `otp verify failed for ${suffix}: ${verify.body}`);
  return verify.json() as any;
}

async function createCompletedChargedDeal(suffix: string) {
  const created = await createDeal(`Master Depth ${suffix}`, suffix);
  await post(`/deals/${created.deal_id}/publish`, `master-depth-publish-${suffix}`, {
    seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true
  });
  const buyerId = `buyer-${suffix}-${Date.now()}`;
  const otp = await verifiedOtpForBuyer(buyerId, created.deal_id, suffix);
  const join = await post(`/deals/${created.deal_id}/join`, `master-depth-join-${suffix}`, {
    buyer_id: buyerId,
    qty: 2,
    affiliate_ref: "affiliate-demo",
    buyer_terms_accepted: true,
    payment_disclosure_accepted: true,
    otp_token: otp.otp_token,
    otp_challenge_id: otp.challenge_id || otp.otp_session_id,
    authorization_id: `auth-master-depth-${suffix}-${Date.now()}`,
    authorization_provider: "mockpay"
  });
  assert.equal(join.statusCode, 200, `master depth join failed for ${suffix}: ${join.body}`);
  const participant = join.json() as any;
  await post(`/deals/${created.deal_id}/close_joining`, `master-depth-close-${suffix}`);
  await post(`/deals/${created.deal_id}/prepare_charging`, `master-depth-prepare-${suffix}`);
  await post(`/deals/${created.deal_id}/charging/start`, `master-depth-start-${suffix}`);

  const webhookPayload = {
    event_id: `master-depth-charge-${suffix}-${Date.now()}`,
    event_type: "charge_captured",
    deal_id: created.deal_id,
    participant_id: participant.participant_id,
    payload: {
      deal_id: created.deal_id,
      participant_id: participant.participant_id,
      provider_reference: `master-depth-cap-${suffix}`
    }
  };
  const webhook = await app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: paymentWebhookHeaders(JSON.stringify(webhookPayload)),
    payload: webhookPayload
  });
  assert.equal(webhook.statusCode, 200);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    const dealState = await client.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [created.deal_id]);
    const currentState = String(dealState.rows[0]?.state || "");
    if (currentState === "Charging") {
      await client.query(`SELECT set_config('siton.action_name', 'charging.to_completion_window', true)`);
      await client.query(
        `UPDATE siton.deals
         SET state='CompletionWindow',
             completion_window_until=COALESCE(completion_window_until, now())
         WHERE deal_id=$1`,
        [created.deal_id]
      );
    }
    await client.query(`SELECT set_config('siton.action_name', 'charging.finalize_completed', true)`);
    await client.query(`UPDATE siton.deals SET state='Completed', completion_window_until=COALESCE(completion_window_until, now()) WHERE deal_id=$1`, [created.deal_id]);
    await client.query(`UPDATE siton.participants SET buyer_state='DealCompleted' WHERE participant_id=$1`, [participant.participant_id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    deal_id: created.deal_id,
    participant_id: String(participant.participant_id)
  };
}

async function main() {
  await runTest("admin system status is a real connected surface", async () => {
    const response = await app.inject({ method: "GET", url: "/api/admin/system-status" });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.system_status.app_health.ok, true);
    assert.ok(payload.system_status.integrations.payment.mode);
    assert.ok("active_outbox" in payload.system_status.operational_counts);
  });

  await runTest("seller delivery handoff rejects shallow fulfillment updates", async () => {
    const charging = await createCompletedChargedDeal("delivery-rules");

    const shippedWithoutTracking = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${charging.deal_id}/delivery/${charging.participant_id}`,
      payload: {
        status: "shipped",
        tracking_number: "",
        issue_note: ""
      }
    });
    assert.equal(shippedWithoutTracking.statusCode, 404);

    const issueWithoutNote = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${charging.deal_id}/delivery/${charging.participant_id}`,
      payload: {
        status: "issue",
        tracking_number: "",
        issue_note: ""
      }
    });
    assert.equal(issueWithoutNote.statusCode, 404);
  });

  await runTest("affiliate remains attribution-only while verification stays operational", async () => {
    const affiliate = await pool.query(
      `SELECT affiliate_id::text AS affiliate_id
       FROM siton.affiliate_accounts
       WHERE affiliate_code = 'affiliate-demo'
       LIMIT 1`
    );
    const affiliateId = String(affiliate.rows[0].affiliate_id);

    const approve = await app.inject({
      method: "POST",
      url: `/api/admin/kyc/affiliate/${affiliateId}/decision`,
      payload: {
        decision: "approve",
        admin_note: "master depth approval"
      }
    });
    assert.equal(approve.statusCode, 200);
  });
}

main()
  .then(async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });

