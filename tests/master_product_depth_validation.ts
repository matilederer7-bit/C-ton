import assert from "node:assert/strict";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";

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
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      commission_rate: 0.1
    }
  });
  assert.equal(response.statusCode, 200);
  return response.json() as { deal_id: string };
}

async function createCompletedChargedDeal(suffix: string) {
  const created = await createDeal(`Master Depth ${suffix}`, suffix);
  await post(`/deals/${created.deal_id}/publish`, `master-depth-publish-${suffix}`);
  const join = await post(`/deals/${created.deal_id}/join`, `master-depth-join-${suffix}`, {
    buyer_id: `buyer-${suffix}`,
    qty: 2,
    affiliate_ref: "affiliate-demo"
  });
  assert.equal(join.statusCode, 200);
  const participant = join.json() as any;
  await post(`/deals/${created.deal_id}/close_joining`, `master-depth-close-${suffix}`);
  await post(`/deals/${created.deal_id}/prepare_charging`, `master-depth-prepare-${suffix}`);
  await post(`/deals/${created.deal_id}/charging/start`, `master-depth-start-${suffix}`);

  const webhook = await app.inject({
    method: "POST",
    url: "/webhooks/payments/mock",
    headers: { "x-webhook-secret": "mock-webhook-secret" },
    payload: {
      event_id: `master-depth-charge-${suffix}-${Date.now()}`,
      event_type: "charge_captured",
      deal_id: created.deal_id,
      participant_id: participant.participant_id,
      payload: {
        deal_id: created.deal_id,
        participant_id: participant.participant_id,
        provider_reference: `master-depth-cap-${suffix}`
      }
    }
  });
  assert.equal(webhook.statusCode, 202);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('siton.in_atomic', 'true', true)`);
    await client.query(`SELECT set_config('siton.audit_written', '1', true)`);
    await client.query(`SELECT set_config('siton.outbox_written', '1', true)`);
    await client.query(`SELECT set_config('siton.action_name', 'test.master_depth_complete', true)`);
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

  await runTest("seller delivery semantics reject shallow fulfillment updates", async () => {
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
    assert.equal(shippedWithoutTracking.statusCode, 400);

    const issueWithoutNote = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${charging.deal_id}/delivery/${charging.participant_id}`,
      payload: {
        status: "issue",
        tracking_number: "",
        issue_note: ""
      }
    });
    assert.equal(issueWithoutNote.statusCode, 400);
  });

  await runTest("affiliate payout approval requires verified profile and pending commission", async () => {
    const affiliate = await pool.query(
      `SELECT affiliate_id::text AS affiliate_id
       FROM siton.affiliate_accounts
       WHERE affiliate_code = 'affiliate-demo'
       LIMIT 1`
    );
    const affiliateId = String(affiliate.rows[0].affiliate_id);

    await pool.query(
      `UPDATE siton.affiliate_accounts
       SET verification_status='pending',
           payout_status='pending_profile',
           payout_details_masked='',
           updated_at=now()
       WHERE affiliate_id = $1::uuid`,
      [affiliateId]
    );

    const blocked = await app.inject({
      method: "POST",
      url: `/api/admin/affiliate-payouts/${affiliateId}`,
      payload: {
        payout_status: "approved"
      }
    });
    assert.equal(blocked.statusCode, 409);

    const payoutProfile = await app.inject({
      method: "POST",
      url: "/api/affiliate/payout-profile",
      payload: {
        payout_method: "bank_transfer",
        payout_details: "IL0011223344556677"
      }
    });
    assert.equal(payoutProfile.statusCode, 200);

    const approve = await app.inject({
      method: "POST",
      url: `/api/admin/kyc/affiliate/${affiliateId}/decision`,
      payload: {
        decision: "approve",
        admin_note: "master depth approval"
      }
    });
    assert.equal(approve.statusCode, 200);

    const charged = await createCompletedChargedDeal("affiliate-commission");
    assert.ok(charged.deal_id);

    const approved = await app.inject({
      method: "POST",
      url: `/api/admin/affiliate-payouts/${affiliateId}`,
      payload: {
        payout_status: "approved"
      }
    });
    assert.equal(approved.statusCode, 200);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
