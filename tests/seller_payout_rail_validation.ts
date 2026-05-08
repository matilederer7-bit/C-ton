import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.PORT = "3096";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYOUT_PROVIDER = "internal-ledger";
process.env.PAYOUT_PROVIDER_MODE = "internal-truth-only";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const { app, processOutboxEventById } = await import(`../src/app.js?seller-payout-rail-${Date.now()}`);
const { ensurePayoutRailTables } = await import(`../src/payout_rail.js?seller-payout-schema-${Date.now()}`);
const { ensurePlatformFeeMoneyTables, buildPlatformFeeMoney } = await import(`../src/platform_fee_money.js?seller-payout-money-${Date.now()}`);

const withTx = async <T>(fn: (c: any) => Promise<T>) => {
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
};

const platformFeeMoney = buildPlatformFeeMoney({ withTx });

async function runTest(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
}

async function seedCompletedDeal(args: {
  suffix: string;
  sellerStatus?: "active" | "review" | "hold";
}) {
  const sellerId = `seller-${args.suffix}`;
  const dealId = randomUUID();
  const participantId = randomUUID();
  const prepareEventId = randomUUID();

  await pool.query(
    `INSERT INTO siton.seller_accounts (
       seller_id, display_name, verification_status, settlement_status, payout_method, payout_details_masked, admin_note
     ) VALUES ($1,$2,'approved',$3,'bank_transfer','***1234','')
     ON CONFLICT (seller_id) DO UPDATE
     SET settlement_status=EXCLUDED.settlement_status,
         updated_at=now()`,
    [sellerId, `Seller ${args.suffix}`, args.sellerStatus || "active"]
  );

  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, title, price_per_unit, min_units, max_units, threshold_units,
       deadline, state, published_at, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,'Completed',now(),now(),now()
     )`,
    [
      dealId,
      sellerId,
      `Payout Deal ${args.suffix}`,
      100,
      1,
      10,
      1,
      new Date(Date.now() + 4 * 60 * 60_000).toISOString()
    ]
  );

  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'DealCompleted','ChargedSuccess',$5,now(),now())`,
    [participantId, dealId, `buyer-${args.suffix}`, 2, 20]
  );

  await platformFeeMoney.recordProviderFinancialEvent({
    participant_id: participantId,
    deal_id: dealId,
    event_type: "charge_captured",
    provider_code: "payrail-test",
    provider_event_id: `charge-${participantId}`,
    provider_reference: `cap-${participantId}`,
    correlation_id: `corr-${participantId}`,
    source_money_state: "ChargedSuccess"
  });

  await pool.query(
    `INSERT INTO siton.outbox_events (
       event_uuid, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at, created_at, updated_at
     ) VALUES ($1,'seller_payout_prepare','deal',$2,$3,'pending',0,now(),now(),now())`,
    [prepareEventId, dealId, JSON.stringify({ deal_id: dealId, seller_id: sellerId })]
  );

  return { sellerId, dealId, participantId, prepareEventId };
}

async function cleanupDeal(dealId: string, sellerId: string) {
  const batchIds = await pool.query(
    `SELECT payout_batch_id
     FROM siton.seller_payout_batches
     WHERE trigger_deal_id=$1`,
    [dealId]
  );
  for (const row of batchIds.rows) {
    await pool.query(`DELETE FROM siton.outbox_dlq WHERE aggregate_id=$1`, [row.payout_batch_id]);
    await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1`, [row.payout_batch_id]);
  }
  await pool.query(`DELETE FROM siton.seller_payout_reconciliation_cases WHERE payout_batch_id IN (SELECT payout_batch_id FROM siton.seller_payout_batches WHERE trigger_deal_id=$1)`, [dealId]);
  await pool.query(`DELETE FROM siton.seller_payout_attempts WHERE payout_batch_id IN (SELECT payout_batch_id FROM siton.seller_payout_batches WHERE trigger_deal_id=$1)`, [dealId]);
  await pool.query(`DELETE FROM siton.seller_payout_batch_items WHERE deal_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton.seller_settlements WHERE deal_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton.seller_payout_batches WHERE trigger_deal_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton.platform_fee_money_events WHERE deal_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton.outbox_dlq WHERE aggregate_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton.outbox_events WHERE aggregate_id=$1 OR payload->>'deal_id'=$2`, [dealId, String(dealId)]);
  await pool.query(`DELETE FROM siton.participants WHERE deal_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [dealId]);
  await pool.query(`DELETE FROM siton.seller_accounts WHERE seller_id=$1`, [sellerId]);
}

async function latestBatchForDeal(dealId: string) {
  const result = await pool.query(
    `SELECT *
     FROM siton.seller_payout_batches
     WHERE trigger_deal_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [dealId]
  );
  return result.rows[0] as any;
}

async function latestSettlementForDeal(dealId: string) {
  const result = await pool.query(
    `SELECT *
     FROM siton.seller_settlements
     WHERE deal_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [dealId]
  );
  return result.rows[0] as any;
}

async function batchItems(payoutBatchId: string) {
  const result = await pool.query(
    `SELECT *
     FROM siton.seller_payout_batch_items
     WHERE payout_batch_id=$1
     ORDER BY created_at ASC`,
    [payoutBatchId]
  );
  return result.rows as any[];
}

async function nextOutboxEvent(eventType: string, aggregateId: string) {
  const result = await pool.query(
    `SELECT event_uuid
     FROM siton.outbox_events
     WHERE event_type=$1
       AND aggregate_id=$2
     ORDER BY created_at DESC
     LIMIT 1`,
    [eventType, aggregateId]
  );
  return result.rows[0]?.event_uuid as string | undefined;
}

await ensurePlatformFeeMoneyTables(withTx);
await ensurePayoutRailTables(withTx);

await runTest("seller payout rail prepares, dispatches, and reconciles internal truth without external transfer", async () => {
  const seeded = await seedCompletedDeal({ suffix: "happy" });

  try {
    const prepareResult = await processOutboxEventById(seeded.prepareEventId);
    assert.equal(prepareResult?.status, "sent", (prepareResult as any)?.error);

    const batch = await latestBatchForDeal(seeded.dealId);
    assert.equal(batch.payout_status, "batched");
    assert.equal(Number(batch.item_count), 1);
    assert.equal(Number(batch.seller_net_payable), 199.23);
    assert.equal(Number(batch.payout_amount), 199.23);
    assert.equal(batch.external_transfer_executed, false);

    const dispatchEventId = await nextOutboxEvent("seller_payout_dispatch", batch.payout_batch_id);
    assert.ok(dispatchEventId);
    const dispatchResult = await processOutboxEventById(String(dispatchEventId));
    assert.equal(dispatchResult?.status, "sent", (dispatchResult as any)?.error);

    const afterDispatch = await latestBatchForDeal(seeded.dealId);
    assert.equal(afterDispatch.payout_status, "processing");
    assert.equal(afterDispatch.external_transfer_executed, false);

    const reconcileEventId = await nextOutboxEvent("seller_payout_reconcile", batch.payout_batch_id);
    assert.ok(reconcileEventId);
    const reconcileResult = await processOutboxEventById(String(reconcileEventId));
    assert.equal(reconcileResult?.status, "sent", (reconcileResult as any)?.error);

    const afterReconcile = await latestBatchForDeal(seeded.dealId);
    assert.equal(afterReconcile.payout_status, "reconciled");
    assert.equal(afterReconcile.external_transfer_executed, false);

    const items = await batchItems(batch.payout_batch_id);
    assert.equal(items.length, 1);
    assert.equal(items[0].payout_status, "reconciled");

    const adminStatus = await app.inject({ method: "GET", url: "/api/admin/payout-status" });
    assert.equal(adminStatus.statusCode, 200);
    const adminBatch = await app.inject({ method: "GET", url: `/api/admin/payouts/batches/${batch.payout_batch_id}` });
    assert.equal(adminBatch.statusCode, 200);
    const adminBatchJson = adminBatch.json() as any;
    assert.equal(adminBatchJson.payout_batch.batch.payout_status, "reconciled");
  } finally {
    await cleanupDeal(seeded.dealId, seeded.sellerId);
  }
});

await runTest("seller settlement hold blocks payout dispatch while preserving internal batch truth", async () => {
  const seeded = await seedCompletedDeal({ suffix: "hold", sellerStatus: "hold" });

  try {
    const prepareResult = await processOutboxEventById(seeded.prepareEventId);
    assert.equal(prepareResult?.status, "sent", (prepareResult as any)?.error);

    const settlement = await latestSettlementForDeal(seeded.dealId);
    assert.equal(settlement.payout_status, "pending");

    const batch = await latestBatchForDeal(seeded.dealId);
    assert.equal(batch, undefined);

    const readiness = await app.inject({ method: "GET", url: `/api/admin/sellers/${seeded.sellerId}/payout-readiness` });
    assert.equal(readiness.statusCode, 200);
    const readinessJson = readiness.json() as any;
    assert.equal(readinessJson.payout_readiness.eligibility.eligible_for_dispatch, false);
  } finally {
    await cleanupDeal(seeded.dealId, seeded.sellerId);
  }
});

await runTest("refund after payout submission forces payout reconciliation into manual review", async () => {
  const seeded = await seedCompletedDeal({ suffix: "refund-mismatch" });

  try {
    await processOutboxEventById(seeded.prepareEventId);
    const batch = await latestBatchForDeal(seeded.dealId);
    const dispatchEventId = await nextOutboxEvent("seller_payout_dispatch", batch.payout_batch_id);
    await processOutboxEventById(String(dispatchEventId));

    await platformFeeMoney.recordProviderFinancialEvent({
      participant_id: seeded.participantId,
      deal_id: seeded.dealId,
      event_type: "refund_issued",
      provider_code: "payrail-test",
      provider_event_id: `refund-${seeded.participantId}`,
      provider_reference: `refund-${seeded.participantId}`,
      correlation_id: `refund-corr-${seeded.participantId}`,
      source_money_state: "ChargedSuccess"
    });

    const reconcileEventId = await nextOutboxEvent("seller_payout_reconcile", batch.payout_batch_id);
    await processOutboxEventById(String(reconcileEventId));

    const afterReconcile = await latestBatchForDeal(seeded.dealId);
    assert.equal(afterReconcile.payout_status, "failed");

    const batchProfile = await app.inject({ method: "GET", url: `/api/admin/payouts/batches/${batch.payout_batch_id}` });
    assert.equal(batchProfile.statusCode, 200);
    const batchProfileJson = batchProfile.json() as any;
    assert.equal(batchProfileJson.payout_batch.reconciliation_cases[0].case_status, "open");
  } finally {
    await cleanupDeal(seeded.dealId, seeded.sellerId);
  }
});

await app.close();
await pool.end();
