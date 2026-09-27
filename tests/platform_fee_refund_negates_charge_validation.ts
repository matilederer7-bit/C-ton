// Black-Sky A-F6 — the refund_adjustment fee row must be the exact negation of
// the recorded charge row. Before the fix the refund row recomputed VAT from
// the LIVE configuration: a VAT-rate change between charge and refund left a
// fully refunded participant with a non-zero ledger residual (VAT, fee base,
// Siton fee, seller net). Sign semantics (charge >= 0, refund <= 0) are kept.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SITON_VAT_MODE = "explicit";
process.env.SITON_VAT_RATE = "0.17";

const { buildPlatformFeeMoney } = await import("../src/platform_fee_money.js");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function withTx<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}
const ledger = buildPlatformFeeMoney({ withTx });

const AMOUNT_COLUMNS = [
  "gross_amount", "vat_amount", "fee_base_amount", "platform_fee_base_amount",
  "platform_fee_vat_amount", "platform_fee_total_amount", "platform_fee_amount", "seller_net_amount"
] as const;

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}

async function seedParticipant() {
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, seller_id)
     VALUES ($1,'A-F6 deal',117,1,10,1, now() + interval '1 day','PendingTarget', now(), now(), 'seller-af6')`,
    [dealId]
  );
  await pool.query(
    `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at)
     VALUES ($1,$2,'buyer-af6',3,'JoinedAuthorized','AuthHeld',23.4, now())`,
    [participantId, dealId]
  );
  return { dealId, participantId };
}

async function rows(participantId: string) {
  const r = await pool.query(
    `SELECT logical_entry_type, platform_fee_rate, platform_fee_vat_rate, ${AMOUNT_COLUMNS.join(", ")}
     FROM siton.platform_fee_money_events WHERE participant_id=$1`,
    [participantId]
  );
  const charge = r.rows.find((row) => row.logical_entry_type === "charge");
  const refund = r.rows.find((row) => row.logical_entry_type === "refund_adjustment");
  return { charge, refund };
}

function event(p: { dealId: string; participantId: string }, eventType: "charge_captured" | "refund_issued", sourceMoneyState: string) {
  return {
    participant_id: p.participantId,
    deal_id: p.dealId,
    event_type: eventType,
    provider_code: "mockpay",
    provider_event_id: `af6-${eventType}-${randomUUID()}`,
    provider_reference: null,
    correlation_id: null,
    source_money_state: sourceMoneyState
  };
}

try {
  await run("a VAT-rate change between charge and refund: the refund row is still the exact negation of the charge row", async () => {
    const p = await seedParticipant();
    process.env.SITON_VAT_RATE = "0.17";
    await ledger.recordProviderFinancialEvent(event(p, "charge_captured", "ChargedSuccess"));
    process.env.SITON_VAT_RATE = "0.18"; // the rate changes before the refund
    await ledger.recordProviderFinancialEvent(event(p, "refund_issued", "ChargedSuccess"));
    const { charge, refund } = await rows(p.participantId);
    assert.ok(charge && refund);
    for (const column of AMOUNT_COLUMNS) {
      assert.ok(Number(charge[column]) >= 0, `charge ${column} >= 0`);
      assert.ok(Number(refund[column]) <= 0, `refund ${column} <= 0`);
      assert.equal(Number(refund[column]), -Number(charge[column]), `refund ${column} negates the recorded charge (${charge[column]} vs ${refund[column]})`);
    }
    assert.equal(Number(refund.platform_fee_rate), Number(charge.platform_fee_rate));
    assert.equal(Number(refund.platform_fee_vat_rate), Number(charge.platform_fee_vat_rate));
    const summary = await ledger.summarizeParticipantSettlement(p.participantId);
    for (const column of AMOUNT_COLUMNS) assert.equal(Number((summary as any)[column]), 0, `net ${column} is zero after a full refund`);
  });

  await run("negative: without a rate change the refund row is unchanged (negation of the charge)", async () => {
    const p = await seedParticipant();
    process.env.SITON_VAT_RATE = "0.17";
    await ledger.recordProviderFinancialEvent(event(p, "charge_captured", "ChargedSuccess"));
    await ledger.recordProviderFinancialEvent(event(p, "refund_issued", "ChargedSuccess"));
    const { charge, refund } = await rows(p.participantId);
    for (const column of AMOUNT_COLUMNS) assert.equal(Number(refund[column]), -Number(charge[column]));
  });

  await run("negative: refund without a recorded charge backfills the charge and negates THAT row; a duplicate refund writes nothing", async () => {
    const p = await seedParticipant();
    await ledger.recordProviderFinancialEvent(event(p, "refund_issued", "ChargedSuccess"));
    const { charge, refund } = await rows(p.participantId);
    assert.ok(charge && refund);
    for (const column of AMOUNT_COLUMNS) assert.equal(Number(refund[column]), -Number(charge[column]));
    const duplicate = await ledger.recordProviderFinancialEvent(event(p, "refund_issued", "ChargedSuccess"));
    assert.equal(duplicate.status, "duplicate_ignored");
    const count = await pool.query(`SELECT count(*)::int AS n FROM siton.platform_fee_money_events WHERE participant_id=$1`, [p.participantId]);
    assert.equal(count.rows[0].n, 2);
  });
} finally {
  await pool.end().catch(() => undefined);
}

process.exit(failed ? 1 : 0);
