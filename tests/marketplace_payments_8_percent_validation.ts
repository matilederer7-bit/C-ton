import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";
import {
  SITON_PLATFORM_FEE_RATE,
  buildMarketplaceMoney,
  calculateMarketplaceMoney,
  ensureMarketplaceMoneyTables
} from "../src/marketplace_money.js";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

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

const marketplaceMoney = buildMarketplaceMoney({ withTx });

async function runTest(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`PASS ${name}`);
}

async function seedParticipant(args: {
  suffix: string;
  pricePerUnit: number;
  qty: number;
  deliveryCost: number;
  commissionRate?: number;
}) {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, title, price_per_unit, min_units, max_units, threshold_units,
       deadline, state, published_at, created_at, updated_at, commission_rate, seller_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8, now(), now(), now(), $9, $10
     )`,
    [
      dealId,
      `Marketplace Fee Deal ${args.suffix}`,
      args.pricePerUnit,
      1,
      Math.max(2, args.qty + 1),
      1,
      new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      "Completed",
      args.commissionRate ?? 0.37,
      "seller-default"
    ]
  );

  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [participantId, dealId, `buyer-${args.suffix}`, args.qty, "DealCompleted", "ChargedSuccess", args.deliveryCost]
  );

  return { dealId, participantId };
}

async function cleanupParticipant(args: { dealId: string; participantId: string }) {
  await pool.query(`DELETE FROM siton.marketplace_money_events WHERE participant_id=$1`, [args.participantId]);
  await pool.query(`DELETE FROM siton.participants WHERE participant_id=$1`, [args.participantId]);
  await pool.query(`DELETE FROM siton.deals WHERE deal_id=$1`, [args.dealId]);
}

await ensureMarketplaceMoneyTables(withTx);

await runTest("charge success computes fixed 8% platform fee and ignores per-deal commission_rate", async () => {
  const seeded = await seedParticipant({
    suffix: "charge",
    pricePerUnit: 100,
    qty: 2,
    deliveryCost: 20,
    commissionRate: 0.61
  });

  try {
    const first = await marketplaceMoney.recordProviderFinancialEvent({
      participant_id: seeded.participantId,
      deal_id: seeded.dealId,
      event_type: "charge_captured",
      provider_code: "test-provider",
      provider_event_id: `charge-${seeded.participantId}`,
      provider_reference: "cap-charge-1",
      correlation_id: "corr-charge-1",
      source_money_state: "ChargedSuccess"
    });

    assert.equal(first.status, "recorded");
    assert.equal(first.snapshot?.entries_count, 1);
    assert.equal(first.snapshot?.gross_amount, 220);
    assert.equal(first.snapshot?.fee_base_amount, 220);
    assert.equal(first.snapshot?.platform_fee_rate, SITON_PLATFORM_FEE_RATE);
    assert.equal(first.snapshot?.platform_fee_amount, 17.6);
    assert.equal(first.snapshot?.seller_net_amount, 202.4);
    assert.equal(first.snapshot?.payout_readiness_status, "ready_for_settlement");
  } finally {
    await cleanupParticipant(seeded);
  }
});

await runTest("recovered charge computes the same fixed 8% fee model", async () => {
  const seeded = await seedParticipant({
    suffix: "recovery",
    pricePerUnit: 55,
    qty: 3,
    deliveryCost: 15,
    commissionRate: 0.01
  });

  try {
    const recorded = await marketplaceMoney.recordProviderFinancialEvent({
      participant_id: seeded.participantId,
      deal_id: seeded.dealId,
      event_type: "recovery_captured",
      provider_code: "test-provider",
      provider_event_id: `recovery-${seeded.participantId}`,
      provider_reference: "cap-recovery-1",
      correlation_id: "corr-recovery-1",
      source_money_state: "RecoveredCharge"
    });

    assert.equal(recorded.status, "recorded");
    assert.equal(recorded.snapshot?.gross_amount, 180);
    assert.equal(recorded.snapshot?.platform_fee_amount, 14.4);
    assert.equal(recorded.snapshot?.seller_net_amount, 165.6);
  } finally {
    await cleanupParticipant(seeded);
  }
});

await runTest("VAT is excluded from the 8% fee base", () => {
  const money = calculateMarketplaceMoney({
    grossAmount: 118,
    vatAmount: 18
  });
  assert.equal(money.gross_amount, 118);
  assert.equal(money.vat_amount, 18);
  assert.equal(money.fee_base_amount, 100);
  assert.equal(money.platform_fee_amount, 8);
  assert.equal(money.seller_net_amount, 110);
  assert.ok(!Object.prototype.hasOwnProperty.call(money, "affiliate_fee_amount"));
});

await runTest("canonical marketplace settlement table carries no affiliate fee columns", async () => {
  const columns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='siton'
       AND table_name='marketplace_money_events'
     ORDER BY ordinal_position`
  );
  const names = columns.rows.map((row) => String(row.column_name));
  assert.ok(!names.includes("affiliate_fee_amount"));
  assert.ok(!names.includes("affiliate_fee_rate"));
  assert.ok(!names.includes("commission_amount"));
  assert.ok(!names.includes("commission_rate"));
});

await runTest("duplicate charge event does not create duplicate fee truth", async () => {
  const seeded = await seedParticipant({
    suffix: "dup-charge",
    pricePerUnit: 90,
    qty: 1,
    deliveryCost: 10
  });

  try {
    const first = await marketplaceMoney.recordProviderFinancialEvent({
      participant_id: seeded.participantId,
      deal_id: seeded.dealId,
      event_type: "charge_captured",
      provider_code: "test-provider",
      provider_event_id: `dup-charge-${seeded.participantId}`,
      provider_reference: "cap-dup-charge",
      correlation_id: "corr-dup-charge",
      source_money_state: "ChargedSuccess"
    });
    const duplicate = await marketplaceMoney.recordProviderFinancialEvent({
      participant_id: seeded.participantId,
      deal_id: seeded.dealId,
      event_type: "charge_captured",
      provider_code: "test-provider",
      provider_event_id: `dup-charge-${seeded.participantId}`,
      provider_reference: "cap-dup-charge",
      correlation_id: "corr-dup-charge",
      source_money_state: "ChargedSuccess"
    });

    assert.equal(first.status, "recorded");
    assert.equal(duplicate.status, "duplicate_ignored");
    assert.equal(duplicate.snapshot?.entries_count, 1);
    assert.equal(duplicate.snapshot?.charge_entries, 1);
    assert.equal(duplicate.snapshot?.gross_amount, 100);
    assert.equal(duplicate.snapshot?.platform_fee_amount, 8);
  } finally {
    await cleanupParticipant(seeded);
  }
});

await runTest("refund creates a single signed reversal and keeps seller receivable at zero after duplicate events", async () => {
  const seeded = await seedParticipant({
    suffix: "refund",
    pricePerUnit: 120,
    qty: 1,
    deliveryCost: 30
  });

  try {
    await marketplaceMoney.recordProviderFinancialEvent({
      participant_id: seeded.participantId,
      deal_id: seeded.dealId,
      event_type: "charge_captured",
      provider_code: "test-provider",
      provider_event_id: `refund-charge-${seeded.participantId}`,
      provider_reference: "cap-refund-charge",
      correlation_id: "corr-refund-charge",
      source_money_state: "ChargedSuccess"
    });

    const refunded = await marketplaceMoney.recordProviderFinancialEvent({
      participant_id: seeded.participantId,
      deal_id: seeded.dealId,
      event_type: "refund_issued",
      provider_code: "test-provider",
      provider_event_id: `refund-${seeded.participantId}`,
      provider_reference: "ref-refund-1",
      correlation_id: "corr-refund-1",
      source_money_state: "ChargedSuccess"
    });

    const duplicateRefund = await marketplaceMoney.recordProviderFinancialEvent({
      participant_id: seeded.participantId,
      deal_id: seeded.dealId,
      event_type: "refund_issued",
      provider_code: "test-provider",
      provider_event_id: `refund-${seeded.participantId}`,
      provider_reference: "ref-refund-1",
      correlation_id: "corr-refund-1",
      source_money_state: "ChargedSuccess"
    });

    assert.equal(refunded.status, "recorded");
    assert.equal(duplicateRefund.status, "duplicate_ignored");
    assert.equal(duplicateRefund.snapshot?.entries_count, 2);
    assert.equal(duplicateRefund.snapshot?.charge_entries, 1);
    assert.equal(duplicateRefund.snapshot?.refund_entries, 1);
    assert.equal(duplicateRefund.snapshot?.gross_amount, 0);
    assert.equal(duplicateRefund.snapshot?.platform_fee_amount, 0);
    assert.equal(duplicateRefund.snapshot?.seller_net_amount, 0);
    assert.equal(duplicateRefund.snapshot?.payout_readiness_status, "refunded_not_payable");
  } finally {
    await cleanupParticipant(seeded);
  }
});

await runTest("failed deal without charge truth does not report payout readiness", async () => {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, title, price_per_unit, min_units, max_units, threshold_units,
       deadline, state, published_at, created_at, updated_at, commission_rate, seller_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now(), now(), $9, $10)`,
    [
      dealId,
      "Failed deal without captured charge",
      50,
      1,
      5,
      1,
      new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      "Failed",
      0.08,
      "seller-default"
    ]
  );
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
    [participantId, dealId, "buyer-failed", 2, "DealFailed", "AuthReleased", 0]
  );

  try {
    const summary = await marketplaceMoney.summarizeParticipantSettlement(participantId);
    assert.equal(summary, null);
  } finally {
    await cleanupParticipant({ participantId, dealId });
  }
});

await pool.end();
