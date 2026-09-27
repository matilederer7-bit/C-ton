// BLACK-SKY COMBINATION 4 — seller settlement under a refund, an unknown
// provider outcome and re-delivered jobs, all at once.
//
// Real payout rail (src/payout_rail.ts buildPayoutRail) on the real migrated
// disposable database with its 077 forward-only / monotonic triggers; a
// scripted in-test payout provider (same shape as
// tests/seller_payout_rail_race_validation.ts). No real money, no network.
//
//   P4 COMBINES (4): a buyer REFUND commits while the payout DISPATCH is in
//       flight at the provider + the provider's createPayout outcome is UNKNOWN
//       + the reconcile job is re-delivered (same event id twice, concurrently,
//       plus a fresh id) + the dispatch job is re-delivered twice.
//      EXPECTED (fail closed): exactly ONE createPayout for the batch, ever;
//       the unknown outcome opens a blocking dispatch_outcome_unknown case and
//       the batch stays 'processing' (never reset, never re-dispatched with a
//       new identity); every redelivery is lookup-only; once the lookup proves
//       the payout, the refund that landed after dispatch opens a blocking
//       refund_after_payout_dispatch case; settlement amounts are monotonic
//       (077 triggers refuse a regression written directly); money invariants
//       PASS.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildPayoutRail, payoutDispatchCorrelationId } from "../src/payout_rail.js";
import { buildPlatformFeeMoney } from "../src/platform_fee_money.js";
import type { NormalizedPayoutResult, PayoutProvider, PayoutReconciliationResult } from "../src/payout_provider.js";
import { forcedParticipantStep, withForcedTx } from "./helpers/forced_state.js";
import { auditSeededDeal, runMoneyInvariantsOrThrow, sleep } from "./support/black_sky_chaos.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
async function withTx<T>(fn: (c: any) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
class TestPermanentFail extends Error { readonly kind = "permanent_fail"; }
const feeMoney = buildPlatformFeeMoney({ withTx });

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.stack || error}`); }
}

function scriptedProvider() {
  const calls = { create: [] as any[], status: [] as any[], reconcile: [] as any[] };
  let createGate: Promise<void> | null = null;
  let onCreateEntered: (() => void) | null = null;
  let statusAnswer: Partial<NormalizedPayoutResult> = { result_class: "unknown", payout_status: null };
  const base = (input: any, partial: Partial<NormalizedPayoutResult>): NormalizedPayoutResult => ({
    provider: "black-sky-payout", result_class: "success", retryable: false, payout_status: null,
    payout_reference: `bs-payout:${input.payout_batch_id}`, correlation_id: input.correlation_id,
    external_transfer_executed: false, raw: { mode: "black-sky" }, ...partial
  });
  const provider: PayoutProvider = {
    providerCode: "black-sky-payout",
    mode: "internal-truth-only",
    configured: true,
    async createPayout(input) {
      calls.create.push(input);
      onCreateEntered?.();
      if (createGate) await createGate;
      return base(input, { result_class: "unknown", payout_status: null });
    },
    async getPayoutStatus(input) { calls.status.push(input); return base(input, statusAnswer); },
    async cancelPayout(input) { return base(input, { payout_status: "returned" }); },
    async reconcilePayout(input): Promise<PayoutReconciliationResult> {
      calls.reconcile.push(input);
      const matched = Number(input.expected_item_count) === Number(input.observed_item_count) && Number(input.expected_payout_amount) === Number(input.observed_payout_amount);
      return { ...base(input, { payout_status: matched ? "reconciled" : "failed" }), reconciliation_outcome: matched ? "matched" : "mismatched", observed_item_count: Number(input.observed_item_count), observed_payout_amount: Number(input.observed_payout_amount) };
    },
    parsePayoutWebhookEvent() { throw new Error("not_used"); }
  };
  return {
    provider, calls,
    holdCreate() { let release!: () => void; createGate = new Promise<void>((r) => { release = r; }); const entered = new Promise<void>((r) => { onCreateEntered = r; }); return { entered, release }; },
    setStatus(answer: Partial<NormalizedPayoutResult>) { statusAnswer = answer; }
  };
}

async function seedCompletedDealWithTwoBuyers() {
  const sellerId = `seller-bs-${randomUUID().slice(0, 8)}`;
  const dealId = randomUUID();
  const pids = [randomUUID(), randomUUID()];
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, verification_status, settlement_status, payout_method, payout_details_masked, admin_note)
     VALUES ($1,'Black-Sky seller','approved','active','bank_transfer','***1234','')`, [sellerId]);
  await pool.query(
    `INSERT INTO siton.deals (deal_id, seller_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, published_at, created_at, updated_at)
     VALUES ($1,$2,'Black-Sky settlement deal',100,1,10,1,now() + interval '4 hours','Completed',now(),now(),now())`, [dealId, sellerId]);
  for (const pid of pids) {
    await pool.query(
      `INSERT INTO siton.participants (participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at, updated_at)
       VALUES ($1,$2,$3,2,'DealCompleted','ChargedSuccess',20,now(),now())`, [pid, dealId, `buyer-bs-${pid.slice(0, 8)}`]);
    await pool.query(
      `INSERT INTO siton.payment_attempts (participant_id, deal_id, attempt_type, result_class, correlation_id, dispatch_state, dispatched_at)
       VALUES ($1,$2,'charge_start','success',$3,'responded',now())`, [pid, dealId, `capture:bs-seed:n1:${pid}`]);
    await feeMoney.recordProviderFinancialEvent({
      participant_id: pid, deal_id: dealId, event_type: "charge_captured", provider_code: "black-sky",
      provider_event_id: `charge-${pid}`, provider_reference: `cap-${pid}`, correlation_id: `capture:bs-seed:n1:${pid}`, source_money_state: "ChargedSuccess"
    });
  }
  await auditSeededDeal(pool, dealId);
  return { sellerId, dealId, pids };
}

async function refund(dealId: string, participantId: string) {
  await withForcedTx(pool, "test.black_sky_refund", async (client) => {
    await forcedParticipantStep(client, participantId, { money_state: "Refunded" }, "test.black_sky_refund");
    await feeMoney.recordProviderFinancialEventInTx(client, {
      participant_id: participantId, deal_id: dealId, event_type: "refund_issued", provider_code: "black-sky",
      provider_event_id: `refund-${participantId}`, provider_reference: `refund-${participantId}`, correlation_id: `refund-corr-${participantId}`, source_money_state: "ChargedSuccess"
    });
  });
}

const one = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0] as any;
const casesOf = async (dealId: string) => (await pool.query(`SELECT case_type, case_status, blocking_payout FROM siton.seller_payout_reconciliation_cases WHERE deal_id=$1 ORDER BY created_at`, [dealId])).rows as any[];

try {
  await run("P4 refund during in-flight dispatch + UNKNOWN payout outcome + re-delivered reconcile/dispatch → one createPayout, blocking cases, monotonic settlement, invariants PASS", async () => {
    const seeded = await seedCompletedDealWithTwoBuyers();
    const script = scriptedProvider();
    const rail = buildPayoutRail({ withTx, payoutProvider: script.provider, PermanentFailErrorCtor: TestPermanentFail });

    const prepared = await rail.prepareBatchForDeal({ deal_id: seeded.dealId, request_id: "bs-prepare" }) as any;
    assert.equal(prepared.status, "batched", JSON.stringify(prepared).slice(0, 300));
    const batchId = String(prepared.batch_profile.batch.payout_batch_id);
    const batchBefore = await one(`SELECT payout_amount, item_count FROM siton.seller_payout_batches WHERE payout_batch_id=$1`, [batchId]);
    assert.equal(Number(batchBefore.item_count), 2);

    // dispatch reaches the provider and hangs there; a refund commits meanwhile
    const gate = script.holdCreate();
    const dispatch = rail.dispatchBatch({ payout_batch_id: batchId, event_id: "bs-dispatch-1" }).then(() => ({ ok: true as const }), (error: any) => ({ ok: false as const, error }));
    await gate.entered;
    const refundCommit = refund(seeded.dealId, seeded.pids[1]!);
    const refundRace = await Promise.race([refundCommit.then(() => "committed"), sleep(3_000).then(() => "blocked")]);
    console.log(`  P4 refund while createPayout is in flight: ${refundRace}`);
    gate.release();
    const dispatched = await dispatch;
    await refundCommit;
    assert.equal(dispatched.ok, false, "an unknown payout outcome is never reported as success");
    assert.match(String((dispatched as any).error?.message), /outcome unknown/);
    assert.equal(script.calls.create.length, 1);
    assert.equal(script.calls.create[0].correlation_id, payoutDispatchCorrelationId(batchId));
    const batchUnknown = await one(`SELECT payout_status FROM siton.seller_payout_batches WHERE payout_batch_id=$1`, [batchId]);
    assert.equal(batchUnknown.payout_status, "processing", "unknown is not reset to batched");
    assert.ok((await casesOf(seeded.dealId)).some((c) => c.case_type === "dispatch_outcome_unknown" && c.case_status === "open" && c.blocking_payout), "blocking unknown-outcome case");

    // re-delivered reconcile (same id twice, concurrently, plus a fresh id) and dispatch (twice)
    const redelivered = await Promise.allSettled([
      rail.reconcileBatch({ payout_batch_id: batchId, event_id: "bs-reconcile-1" }),
      rail.reconcileBatch({ payout_batch_id: batchId, event_id: "bs-reconcile-1" }),
      rail.reconcileBatch({ payout_batch_id: batchId, event_id: "bs-reconcile-2" }),
      rail.dispatchBatch({ payout_batch_id: batchId, event_id: "bs-dispatch-1" }),
      rail.dispatchBatch({ payout_batch_id: batchId, event_id: "bs-dispatch-after-dlq" })
    ]);
    console.log(`  P4 redeliveries while unknown: ${redelivered.map((r) => r.status === "fulfilled" ? "fulfilled" : String((r.reason as any)?.message || r.reason).slice(0, 60)).join(" | ")}`);
    assert.ok(redelivered.every((r) => r.status === "rejected"), "nothing moves while the payout outcome is unknown");
    assert.equal(script.calls.create.length, 1, "no automatic re-dispatch, ever");
    assert.ok(script.calls.status.every((s) => s.correlation_id === payoutDispatchCorrelationId(batchId)), "lookups use the ONE dispatch identity");
    assert.equal((await one(`SELECT payout_status FROM siton.seller_payout_batches WHERE payout_batch_id=$1`, [batchId])).payout_status, "processing");
    assert.equal((await casesOf(seeded.dealId)).filter((c) => c.case_type === "dispatch_outcome_unknown" && c.case_status === "open").length, 1, "one case, not one per redelivery");

    // the provider lookup finally proves the payout was paid
    script.setStatus({ result_class: "success", payout_status: "paid" });
    await rail.dispatchBatch({ payout_batch_id: batchId, event_id: "bs-dispatch-lookup" });
    assert.equal(script.calls.create.length, 1);
    const settlementPaid = await one(`SELECT payout_status, payout_amount, paid_amount, refunds_total FROM siton.seller_settlements WHERE deal_id=$1`, [seeded.dealId]);
    console.log(`  P4 settlement after proven payout: ${JSON.stringify(settlementPaid)}`);
    assert.equal(settlementPaid.payout_status, "paid");

    // reconcile after the refund that landed post-dispatch → a blocking case, no silent rewrite
    await Promise.allSettled([rail.reconcileBatch({ payout_batch_id: batchId, event_id: "bs-reconcile-3" }), rail.reconcileBatch({ payout_batch_id: batchId, event_id: "bs-reconcile-3" })]);
    const settlement = await one(`SELECT payout_status, payout_amount, paid_amount, refunds_total, has_open_blocking_reconciliation_case FROM siton.seller_settlements WHERE deal_id=$1`, [seeded.dealId]);
    const cases = await casesOf(seeded.dealId);
    console.log(`  P4 terminal settlement=${JSON.stringify(settlement)} cases=${JSON.stringify(cases)}`);
    assert.equal(settlement.payout_status, "paid", "a paid settlement never regresses");
    assert.ok(Number(settlement.paid_amount) <= Number(settlement.payout_amount), "paid <= payout");
    assert.ok(Number(settlement.paid_amount) >= Number(settlementPaid.paid_amount), "paid_amount never decreases");
    assert.ok(Number(settlement.refunds_total) > 0, "the refund is recorded, not overwritten");
    assert.equal(settlement.has_open_blocking_reconciliation_case, true);
    assert.ok(cases.some((c) => c.case_type === "refund_after_payout_dispatch" && c.case_status === "open" && c.blocking_payout), "refund after payout is a blocking operator case");
    assert.equal(script.calls.create.length, 1, "exactly one createPayout for the whole scenario");

    // 077: a stale writer cannot regress status or shrink monotonic amounts
    await assert.rejects(pool.query(`UPDATE siton.seller_settlements SET paid_amount = 0 WHERE deal_id=$1`, [seeded.dealId]), /paid_amount_decrease/);
    await assert.rejects(pool.query(`UPDATE siton.seller_settlements SET refunds_total = 0 WHERE deal_id=$1`, [seeded.dealId]), /refunds_total_decrease/);
    await assert.rejects(pool.query(`UPDATE siton.seller_payout_batches SET payout_status='batched' WHERE payout_batch_id=$1`, [batchId]), /payout_status_regression/);

    await runMoneyInvariantsOrThrow("P4");
  });
} finally {
  await pool.end();
}
console.log(`\nSUMMARY black_sky_settlement_combo passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
