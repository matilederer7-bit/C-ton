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

async function createDeal(title: string, suffix: string, overrides: Record<string, unknown> = {}) {
  const unique = `${suffix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/deals",
    headers: {
      "x-request-id": `remaining-create-${unique}`,
      "idempotency-key": `remaining-create-${unique}`
    },
    payload: {
      title,
      price_per_unit: 50,
      min_units: 5,
      max_units: 5,
      deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      commission_rate: 0.1,
      ...overrides
    }
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function buildChargedParticipant(suffix: string, buyerId: string) {
  const created = await createDeal(`Remaining Surface ${suffix}`, suffix);
  await post(`/deals/${created.deal_id}/publish`, `remaining-publish-${suffix}`);

  const join = await post(`/deals/${created.deal_id}/join`, `remaining-join-${suffix}`, {
    buyer_id: buyerId,
    qty: 5,
    affiliate_ref: "affiliate-demo"
  });
  assert.equal(join.statusCode, 200);
  const participant = join.json() as any;

  await post(`/deals/${created.deal_id}/close_joining`, `remaining-close-${suffix}`);
  await post(`/deals/${created.deal_id}/prepare_charging`, `remaining-prepare-${suffix}`);
  await post(`/deals/${created.deal_id}/charging/start`, `remaining-start-${suffix}`);

  const webhookPayload = {
    event_id: `remaining-charge-${suffix}-${Date.now()}`,
    event_type: "charge_captured",
    deal_id: created.deal_id,
    participant_id: participant.participant_id,
    payload: {
      deal_id: created.deal_id,
      participant_id: participant.participant_id,
      provider_reference: `remaining-cap-${suffix}`
    }
  };
  const webhook = await app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: paymentWebhookHeaders(JSON.stringify(webhookPayload)),
    payload: webhookPayload
  });
  assert.equal(webhook.statusCode, 200);

  return {
    deal_id: created.deal_id,
    participant_id: String(participant.participant_id)
  };
}

async function forceCompleteDeal(dealId: string, participantId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    const dealState = await client.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
    const currentState = String(dealState.rows[0]?.state || "");
    if (currentState === "Charging") {
      await client.query(`SELECT set_config('siton.action_name', 'charging.to_completion_window', true)`);
      await client.query(
        `UPDATE siton.deals
         SET state='CompletionWindow',
             completion_window_until=COALESCE(completion_window_until, now())
         WHERE deal_id=$1`,
        [dealId]
      );
    }
    await client.query(`SELECT set_config('siton.action_name', 'charging.finalize_completed', true)`);
    await client.query(
      `UPDATE siton.deals
       SET state='Completed',
           completion_window_until=COALESCE(completion_window_until, now())
       WHERE deal_id=$1`,
      [dealId]
    );
    await client.query(`UPDATE siton.participants SET buyer_state='DealCompleted' WHERE participant_id=$1`, [participantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  await runTest("seller completed-deal surface exposes receipts and delivery only for charged buyers", async () => {
    const charging = await buildChargedParticipant("seller-closure", "0502001001");
    await forceCompleteDeal(charging.deal_id, charging.participant_id);

    const sellerDeal = await app.inject({
      method: "GET",
      url: `/api/seller/deals/${charging.deal_id}`
    });

    assert.equal(sellerDeal.statusCode, 200);
    const payload = sellerDeal.json() as any;
    assert.equal(payload.receipts_surface.status, "ready");
    assert.equal(payload.receipts_surface.summary.receipt_document_count, 1);
    assert.equal(payload.delivery_surface.status, "ready");
    assert.equal(payload.delivery_surface.rows.length, 1);
    // Distributor-as-money surfaces must be gone from the live API.
    assert.ok(
      !Object.prototype.hasOwnProperty.call(payload.receipts_surface.summary, "affiliate_fee_amount"),
      "affiliate_fee_amount must not appear on receipts_surface.summary"
    );

    const deliveryUpdate = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${charging.deal_id}/delivery/${charging.participant_id}`,
      payload: {
        status: "shipped",
        tracking_number: "TRACK-123",
        issue_note: ""
      }
    });
    assert.equal(deliveryUpdate.statusCode, 200);
  });

  await runTest("affiliate payout and settlement actions are fail-closed while attribution stays live", async () => {
    const payoutProfile = await app.inject({
      method: "POST",
      url: "/api/affiliate/payout-profile",
      payload: {
        payout_method: "bank_transfer",
        payout_details: "IL88000123456789"
      }
    });
    assert.equal(payoutProfile.statusCode, 410);

    const affiliateOverview = await app.inject({
      method: "GET",
      url: "/api/affiliate/overview"
    });
    assert.equal(affiliateOverview.statusCode, 200);
    const affiliatePayload = affiliateOverview.json() as any;
    assert.ok(affiliatePayload.affiliate_surface.totals.total_attributions >= 0);
    assert.ok(affiliatePayload.affiliate_surface.totals.total_units >= 0);

    const adminOverview = await app.inject({
      method: "GET",
      url: "/api/admin/overview?q="
    });
    assert.equal(adminOverview.statusCode, 200);
    const adminPayload = adminOverview.json() as any;
    assert.equal(adminPayload.admin_surface.settlements.affiliates?.length || 0, 0);
    const affiliateResult = await pool.query(
      `SELECT affiliate_id::text AS affiliate_id
       FROM siton.affiliate_accounts
       WHERE affiliate_code = 'affiliate-demo'
       LIMIT 1`
    );
    const affiliateId = String(affiliateResult.rows[0].affiliate_id);

    const approve = await app.inject({
      method: "POST",
      url: `/api/admin/kyc/affiliate/${affiliateId}/decision`,
      payload: {
        decision: "approve",
        admin_note: "Approved for internal closure validation"
      }
    });
    assert.equal(approve.statusCode, 410);

    const markPayout = await app.inject({
      method: "POST",
      url: `/api/admin/affiliate-payouts/${affiliateId}`,
      payload: {
        payout_status: "approved"
      }
    });
    assert.equal(markPayout.statusCode, 410);
  });

  await runTest("admin support and forensics surfaces include remaining product closure entities", async () => {
    const ticket = await app.inject({
      method: "POST",
      url: "/api/admin/support",
      payload: {
        scope_type: "system",
        scope_key: "closure-pass",
        title: "Remaining surface validation ticket",
        priority: "normal",
        summary: "Ensure support hub is operational."
      }
    });
    assert.equal(ticket.statusCode, 200);

    const adminOverview = await app.inject({
      method: "GET",
      url: "/api/admin/overview?q="
    });
    assert.equal(adminOverview.statusCode, 200);
    const payload = adminOverview.json() as any;
    assert.ok(payload.admin_surface.support_tickets.length >= 1);
    assert.ok("dlq_count" in payload.admin_surface.forensics);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
