import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const { pool } = await import("../src/db.js");
const { ensureRemainingProductSurfaceTables } = await import("../src/product_surface_support.js");

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

async function createDeal(title: string, suffix: string, overrides: Record<string, unknown> = {}) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `ultimate-create-${unique}`,
      "idempotency-key": `ultimate-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 42,
      min_units: 2,
      max_units: 6,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      ...overrides
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

async function fetchRows<T = any>(sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

async function main() {
  await runTest("db schema and bootstrap assumptions remain aligned with canonical invariants", async () => {
    await ensureRemainingProductSurfaceTables(async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });

    const participantDealBuyerUnique = await fetchRows(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname='siton'
         AND tablename='participants'
         AND indexdef ILIKE '%(deal_id, buyer_id)%'
         AND indexdef ILIKE '%UNIQUE%'`
    );
    assert.equal(participantDealBuyerUnique.length, 0);

    const canonicalIndexes = await fetchRows(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname='siton'
         AND tablename = ANY($1::text[])`,
      [["webhook_events", "affiliate_attributions"]]
    );
    const names = canonicalIndexes.map((row: any) => String(row.indexname));
    assert.ok(names.includes("webhook_events_pk"));
    assert.ok(names.includes("affiliate_attributions_participant_id_key"));

    const initSql = await readFile("scripts/init_db.sql", "utf8");
    assert.match(initSql, /CREATE TABLE IF NOT EXISTS (siton\.)?webhook_events/);
    assert.match(initSql, /CREATE TABLE IF NOT EXISTS (siton\.)?affiliate_attributions/);
    assert.ok(!/UNIQUE\s*\(\s*deal_id\s*,\s*buyer_id\s*\)/i.test(initSql));
  });

  await runTest("admin misuse on missing or malformed targets is rejected cleanly", async () => {
    const badAffiliateKyc = await app.inject({
      method: "POST",
      url: "/api/admin/kyc/affiliate/not-a-uuid/decision",
      payload: {
        decision: "approve",
        admin_note: "bad target"
      }
    });
    assert.equal(badAffiliateKyc.statusCode, 400);

    const missingSellerKyc = await app.inject({
      method: "POST",
      url: "/api/admin/kyc/seller/seller-missing/decision",
      payload: {
        decision: "approve",
        admin_note: "missing seller"
      }
    });
    assert.equal(missingSellerKyc.statusCode, 404);

    const missingSupport = await app.inject({
      method: "POST",
      url: "/api/admin/support/00000000-0000-0000-0000-000000000000",
      payload: {
        status: "resolved"
      }
    });
    assert.equal(missingSupport.statusCode, 404);
  });

  await runTest("seller and affiliate completed surfaces stay contractually honest", async () => {
    const created = await createDeal("Ultimate Product Surface Deal", "ultimate-surface", {
      min_units: 2,
      max_units: 2
    });
    await post(`/deals/${created.deal_id}/publish`, `ultimate-publish-${Date.now()}`, {
      seller_terms_accepted: true
    });

    const buyerId = `buyer-ultimate-${Date.now()}`;
    const otp = await verifiedOtpForBuyer(buyerId, created.deal_id, "ultimate-surface");
    const join = await post(`/deals/${created.deal_id}/join`, `ultimate-join-${Date.now()}`, {
      buyer_id: buyerId,
      qty: 2,
      affiliate_ref: "affiliate-demo",
      buyer_terms_accepted: true,
      payment_disclosure_accepted: true,
      otp_token: otp.otp_token,
      otp_challenge_id: otp.challenge_id || otp.otp_session_id,
      authorization_id: `auth-ultimate-${Date.now()}`,
      authorization_provider: "mockpay"
    });
    assert.equal(join.statusCode, 200, `ultimate join failed: ${join.body}`);
    const participant = join.json() as any;

    await post(`/deals/${created.deal_id}/close_joining`, `ultimate-close-${Date.now()}`);
    await post(`/deals/${created.deal_id}/prepare_charging`, `ultimate-prepare-${Date.now()}`);
    await post(`/deals/${created.deal_id}/charging/start`, `ultimate-start-${Date.now()}`);

    const webhookPayload = {
      event_id: `ultimate-charge-${Date.now()}`,
      event_type: "charge_captured",
      deal_id: created.deal_id,
      participant_id: participant.participant_id,
      payload: {
        deal_id: created.deal_id,
        participant_id: participant.participant_id,
        provider_reference: "ultimate-cap"
      }
    };
    const captured = await app.inject({
      method: "POST",
      url: "/webhooks/payments/mock",
      headers: paymentWebhookHeaders(JSON.stringify(webhookPayload)),
      payload: webhookPayload
    });
    assert.equal(captured.statusCode, 200);

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
      await client.query(
        `INSERT INTO siton.invoice_documents
           (document_key, document_type, deal_id, participant_id, deal_title, qty,
            money_state_at_issue, gross_amount, siton_fee_amount, seller_net_amount,
            status, attempt_count, max_attempts, provider_code,
            available_at, created_at, updated_at)
         VALUES ($1,'charge_receipt',$2,$3,'Ultimate Product Surface Deal',2,'ChargedSuccess',84.00,6.72,77.28,
                 'issued',1,3,'log-only',now(),now(),now())
         ON CONFLICT (document_key) DO NOTHING`,
        [`ultimate-charge-receipt:${participant.participant_id}`, created.deal_id, participant.participant_id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const seller = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${created.deal_id}`
    });
    assert.equal(seller.statusCode, 200);
    const sellerJson = seller.json() as any;
    assert.equal(sellerJson.receipts_surface.status, "ready");
    assert.equal(sellerJson.receipts_surface.summary.receipt_document_count, 1);
    assert.equal(sellerJson.participants.length, 1);

    const shippingExport = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${created.deal_id}/shipping-export`
    });
    assert.equal(shippingExport.statusCode, 200);

    const affiliate = await app.inject({
      method: "GET",
      url: "/api/affiliate/overview"
    });
    assert.equal(affiliate.statusCode, 200);
    const affiliateJson = affiliate.json() as any;
    assert.ok(affiliateJson.affiliate_surface.totals.total_attributions >= 1);
    assert.ok(affiliateJson.affiliate_surface.campaigns.some((row: any) => row.deal_id === created.deal_id));
  });

  await runTest("integration health and provider boundary stay crisp under unsupported configuration probes", async () => {
    const integrations = await app.inject({
      method: "GET",
      url: "/health/integrations"
    });
    assert.equal(integrations.statusCode, 200);
    const payload = integrations.json() as any;
    assert.equal(payload.integrations.payment.mode, "mock-backed");
    assert.ok(Array.isArray(payload.integrations.payment.supported_modes));
    assert.ok(payload.integrations.payment.supported_modes.includes("provider-ready"));
    assert.equal(payload.integrations.notifications.external_delivery, false);
    assert.equal(payload.integrations.webhook_ingestion.duplicate_policy, "provider+event_id idempotent accept");
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
