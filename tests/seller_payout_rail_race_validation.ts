// D5 / F7 hardening of the seller payout rail.
//
// - Every settlement/batch mutation is serialized per deal (advisory xact lock)
//   and recomputed inside the transaction that writes it.
// - payout_status is forward-only; a stale writer cannot regress status or
//   shrink refunds_total / paid_amount.
// - A refund racing batch preparation never pays the refunded participant at
//   full net: it is excluded, or a blocking reconciliation case stops dispatch.
// - An unknown/temporary createPayout outcome is recorded durably and never
//   triggers an automatic re-dispatch with a new correlation id; only a lookup
//   (getPayoutStatus) or manual resolution can move the batch on.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  buildPayoutRail,
  canAdvancePayoutStatus,
  lockDealSettlementInTx,
  payoutDispatchCorrelationId,
  upsertSellerSettlementInTx
} from "../src/payout_rail.js";
import { buildPlatformFeeMoney } from "../src/platform_fee_money.js";
import type {
  NormalizedPayoutResult,
  PayoutProvider,
  PayoutReconciliationResult
} from "../src/payout_provider.js";
import { forcedParticipantStep, withForcedTx } from "./helpers/forced_state.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 12
});

async function runInTx<T>(fn: (c: any) => Promise<T>, onQuery?: (sql: string) => Promise<void>) {
  const client = await pool.connect();
  const target = onQuery
    ? { query: async (sql: any, params?: any) => { await onQuery(String(sql)); return client.query(sql, params); } }
    : client;
  try {
    await client.query("BEGIN");
    const result = await fn(target);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
const withTx = <T>(fn: (c: any) => Promise<T>) => runInTx(fn);

class TestPermanentFail extends Error {
  readonly kind = "permanent_fail";
}

const platformFeeMoney = buildPlatformFeeMoney({ withTx });

type Behavior = {
  create: (input: any) => Promise<Partial<NormalizedPayoutResult>>;
  status: (input: any) => Promise<Partial<NormalizedPayoutResult>>;
  reconcileGate: Promise<void> | null;
  onReconcileEntered: (() => void) | null;
};

function makeProvider() {
  const calls = { create: [] as any[], status: [] as any[], reconcile: [] as any[] };
  const behavior: Behavior = {
    create: async () => ({ result_class: "success", payout_status: "processing" }),
    status: async () => ({ result_class: "success", payout_status: "processing" }),
    reconcileGate: null,
    onReconcileEntered: null
  };
  const base = (input: any, partial: Partial<NormalizedPayoutResult>): NormalizedPayoutResult => ({
    provider: "race-test",
    result_class: "success",
    retryable: false,
    payout_status: null,
    payout_reference: `race-test:${input.payout_batch_id}`,
    correlation_id: input.correlation_id,
    external_transfer_executed: false,
    raw: { mode: "race-test" },
    ...partial
  });
  const provider: PayoutProvider = {
    providerCode: "race-test",
    mode: "internal-truth-only",
    configured: true,
    async createPayout(input) {
      calls.create.push(input);
      return base(input, await behavior.create(input));
    },
    async getPayoutStatus(input) {
      calls.status.push(input);
      return base(input, await behavior.status(input));
    },
    async cancelPayout(input) {
      return base(input, { payout_status: "returned" });
    },
    async reconcilePayout(input): Promise<PayoutReconciliationResult> {
      calls.reconcile.push(input);
      behavior.onReconcileEntered?.();
      if (behavior.reconcileGate) await behavior.reconcileGate;
      const matched =
        Number(input.expected_item_count) === Number(input.observed_item_count)
        && Number(input.expected_payout_amount) === Number(input.observed_payout_amount);
      return {
        ...base(input, { payout_status: matched ? "reconciled" : "failed" }),
        reconciliation_outcome: matched ? "matched" : "mismatched",
        observed_item_count: Number(input.observed_item_count),
        observed_payout_amount: Number(input.observed_payout_amount)
      };
    },
    parsePayoutWebhookEvent() {
      throw new Error("not_used_in_race_test");
    }
  };
  return { provider, calls, behavior };
}

function makeRail(provider: PayoutProvider, onQuery?: (sql: string) => Promise<void>) {
  return buildPayoutRail({
    withTx: <T>(fn: (c: any) => Promise<T>) => runInTx(fn, onQuery),
    payoutProvider: provider,
    PermanentFailErrorCtor: TestPermanentFail
  });
}

async function runTest(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
}

async function seedCompletedDeal(suffix: string) {
  const sellerId = `seller-race-${suffix}-${randomUUID().slice(0, 8)}`;
  const dealId = randomUUID();
  const participantId = randomUUID();
  await pool.query(
    `INSERT INTO siton.seller_accounts (
       seller_id, display_name, verification_status, settlement_status, payout_method, payout_details_masked, admin_note
     ) VALUES ($1,$2,'approved','active','bank_transfer','***1234','')`,
    [sellerId, `Seller ${suffix}`]
  );
  await pool.query(
    `INSERT INTO siton.deals (
       deal_id, seller_id, title, price_per_unit, min_units, max_units, threshold_units,
       deadline, state, published_at, created_at, updated_at
     ) VALUES ($1,$2,$3,100,1,10,1,$4,'Completed',now(),now(),now())`,
    [dealId, sellerId, `Race Deal ${suffix}`, new Date(Date.now() + 4 * 60 * 60_000).toISOString()]
  );
  await pool.query(
    `INSERT INTO siton.participants (
       participant_id, deal_id, buyer_id, qty, buyer_state, money_state, delivery_cost, created_at, updated_at
     ) VALUES ($1,$2,$3,2,'DealCompleted','ChargedSuccess',20,now(),now())`,
    [participantId, dealId, `buyer-race-${suffix}`]
  );
  await platformFeeMoney.recordProviderFinancialEvent({
    participant_id: participantId,
    deal_id: dealId,
    event_type: "charge_captured",
    provider_code: "race-test",
    provider_event_id: `charge-${participantId}`,
    provider_reference: `cap-${participantId}`,
    correlation_id: `corr-${participantId}`,
    source_money_state: "ChargedSuccess"
  });
  return { sellerId, dealId, participantId };
}

// Runtime-shaped refund: the participant money-state transition (with its audit
// row, via the forced-state helper) and the refund ledger entry commit together.
async function refundParticipant(dealId: string, participantId: string) {
  await withForcedTx(pool, "test.payout_race.refund", async (client) => {
    await forcedParticipantStep(client, participantId, { money_state: "Refunded" }, "test.payout_race.refund");
    await platformFeeMoney.recordProviderFinancialEventInTx(client, {
      participant_id: participantId,
      deal_id: dealId,
      event_type: "refund_issued",
      provider_code: "race-test",
      provider_event_id: `refund-${participantId}`,
      provider_reference: `refund-${participantId}`,
      correlation_id: `refund-corr-${participantId}`,
      source_money_state: "ChargedSuccess"
    });
  });
}

async function one(sql: string, params: unknown[]) {
  const result = await pool.query(sql, params);
  return result.rows[0] as any;
}
const settlementOf = (dealId: string) => one(`SELECT * FROM siton.seller_settlements WHERE deal_id=$1`, [dealId]);
const batchOf = (batchId: string) => one(`SELECT * FROM siton.seller_payout_batches WHERE payout_batch_id=$1`, [batchId]);
async function itemsOf(batchId: string) {
  return (await pool.query(`SELECT * FROM siton.seller_payout_batch_items WHERE payout_batch_id=$1`, [batchId])).rows as any[];
}
async function casesOf(dealId: string) {
  return (await pool.query(
    `SELECT * FROM siton.seller_payout_reconciliation_cases WHERE deal_id=$1 ORDER BY created_at ASC`,
    [dealId]
  )).rows as any[];
}

async function waitForLockWaiter(timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n
       FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event_type='Lock'`
    );
    if (Number(result.rows[0]?.n || 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function prepareBatched(rail: ReturnType<typeof makeRail>, dealId: string) {
  const prepared = await rail.prepareBatchForDeal({ deal_id: dealId, request_id: `test:${dealId}` }) as any;
  assert.equal(prepared.status, "batched");
  return String(prepared.batch_profile.batch.payout_batch_id);
}

await runTest("forward-only payout status order", async () => {
  assert.equal(canAdvancePayoutStatus("ready", "pending"), true, "pre-batch states are recomputed freely");
  assert.equal(canAdvancePayoutStatus("pending", "batched"), true);
  assert.equal(canAdvancePayoutStatus("batched", "processing"), true);
  assert.equal(canAdvancePayoutStatus("processing", "paid"), true);
  assert.equal(canAdvancePayoutStatus("paid", "reconciled"), true);
  assert.equal(canAdvancePayoutStatus("processing", "batched"), false);
  assert.equal(canAdvancePayoutStatus("batched", "ready"), false);
  assert.equal(canAdvancePayoutStatus("paid", "processing"), false);
  assert.equal(canAdvancePayoutStatus("paid", "failed"), false);
  assert.equal(canAdvancePayoutStatus("paid", "ready"), false);
  assert.equal(canAdvancePayoutStatus("reconciled", "paid"), false);
  assert.equal(canAdvancePayoutStatus("reconciled", "pending"), false);
});

await runTest("settlement writers serialize on the per-deal advisory lock", async () => {
  const seeded = await seedCompletedDeal("lock");
  const { provider } = makeProvider();
  const rail = makeRail(provider);
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await lockDealSettlementInTx(holder, seeded.dealId);
    let settled = false;
    const prepare = rail.prepareBatchForDeal({ deal_id: seeded.dealId, request_id: "lock-test" }).then((value) => {
      settled = true;
      return value;
    });
    assert.equal(await waitForLockWaiter(), true, "prepare must wait for the deal lock");
    assert.equal(settled, false);
    assert.equal(await settlementOf(seeded.dealId), undefined, "nothing written while the lock is held");
    await holder.query("COMMIT");
    const result = await prepare as any;
    assert.equal(result.status, "batched");
  } finally {
    holder.release();
  }
});

await runTest("reconcile racing a dispatch that marks the batch paid ends with payout_status='paid' (two connections)", async () => {
  const seeded = await seedCompletedDeal("reconcile-vs-paid");
  const { provider, calls, behavior } = makeProvider();
  const rail = makeRail(provider);
  const batchId = await prepareBatched(rail, seeded.dealId);

  await rail.dispatchBatch({ payout_batch_id: batchId, event_id: "dispatch-1" });
  assert.equal((await batchOf(batchId)).payout_status, "processing");

  let releaseGate!: () => void;
  behavior.reconcileGate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const entered = new Promise<void>((resolve) => { behavior.onReconcileEntered = resolve; });

  // Connection A: reconcile reads its snapshot, then blocks inside the provider call.
  const reconcile = rail.reconcileBatch({ payout_batch_id: batchId, event_id: "reconcile-1" });
  await entered;

  // Connection B: a refund commits, then a re-delivered dispatch job looks the
  // payout up and the provider reports it PAID.
  await refundParticipant(seeded.dealId, seeded.participantId);
  behavior.status = async () => ({ result_class: "success", payout_status: "paid" });
  await rail.dispatchBatch({ payout_batch_id: batchId, event_id: "dispatch-2" });
  assert.equal((await batchOf(batchId)).payout_status, "paid");
  assert.equal((await settlementOf(seeded.dealId)).payout_status, "paid");

  releaseGate();
  await reconcile;

  const settlement = await settlementOf(seeded.dealId);
  const batch = await batchOf(batchId);
  assert.equal(settlement.payout_status, "paid", "stale reconcile snapshot must not regress paid");
  assert.equal(batch.payout_status, "paid", "a paid batch is never rewritten as failed");
  for (const item of await itemsOf(batchId)) assert.equal(item.payout_status, "paid");
  assert.equal(Number(settlement.payout_amount), 199.23);
  assert.equal(Number(settlement.paid_amount), 199.23, "paid_amount never decreases");
  assert.equal(Number(settlement.refunds_total), 220, "the refund committed mid-reconcile is kept, not overwritten");
  assert.equal(Number(settlement.seller_net_payable), 0);
  assert.equal(settlement.has_open_blocking_reconciliation_case, true);
  const cases = await casesOf(seeded.dealId);
  const refundCase = cases.find((row) => row.case_type === "refund_after_payout_dispatch");
  assert.ok(refundCase, `expected refund_after_payout_dispatch case, got ${JSON.stringify(cases.map((row) => row.case_type))}`);
  assert.equal(refundCase.case_status, "open");
  assert.equal(refundCase.blocking_payout, true);
  assert.equal(calls.create.length, 1, "exactly one createPayout for the batch");
  assert.equal(calls.status.length, 1);
  assert.equal(calls.status[0].correlation_id, payoutDispatchCorrelationId(batchId));
});

await runTest("refund racing batch preparation never pays the refunded participant at full net", async () => {
  // Ordering 1: the refund commits BEFORE prepare takes the lock -> excluded.
  {
    const seeded = await seedCompletedDeal("refund-before-prepare");
    const { provider, calls } = makeProvider();
    const rail = makeRail(provider);
    await refundParticipant(seeded.dealId, seeded.participantId);
    const prepared = await rail.prepareBatchForDeal({ deal_id: seeded.dealId, request_id: "refund-before" }) as any;
    assert.notEqual(prepared.status, "batched");
    const items = await pool.query(`SELECT 1 FROM siton.seller_payout_batch_items WHERE participant_id=$1`, [seeded.participantId]);
    assert.equal(items.rowCount, 0, "refunded participant is not in any batch");
    assert.equal(calls.create.length, 0);
  }

  // Ordering 2: the refund arrives WHILE prepare is inside its transaction.
  // It must wait for prepare's participant lock, lands after the batch exists,
  // and the dispatch-time re-check under the deal lock stops the payout.
  {
    const seeded = await seedCompletedDeal("refund-during-prepare");
    const { provider, calls } = makeProvider();
    let refund: Promise<void> | null = null;
    let refundCommitted = false;
    const racingRail = makeRail(provider, async (sql) => {
      if (refund || !sql.includes("INSERT INTO siton.seller_payout_batches")) return;
      refund = refundParticipant(seeded.dealId, seeded.participantId).then(() => { refundCommitted = true; });
      assert.equal(await waitForLockWaiter(), true, "refund must block on prepare's participant lock");
    });
    const batchId = await prepareBatched(racingRail, seeded.dealId);
    assert.equal(refundCommitted, false, "refund could not commit inside prepare's transaction");
    await refund;

    const rail = makeRail(provider);
    await assert.rejects(
      rail.dispatchBatch({ payout_batch_id: batchId, event_id: "dispatch-after-refund" }),
      (error: any) => error instanceof TestPermanentFail && /settlement_changed/.test(error.message)
    );
    assert.equal(calls.create.length, 0, "provider is never asked to pay the refunded participant");
    const batch = await batchOf(batchId);
    assert.equal(batch.payout_status, "batched");
    const settlement = await settlementOf(seeded.dealId);
    assert.ok(!["processing", "paid", "reconciled"].includes(settlement.payout_status));
    assert.equal(Number(settlement.paid_amount), 0);
    const openCase = (await casesOf(seeded.dealId)).find((row) => row.case_type === "settlement_changed_before_dispatch");
    assert.ok(openCase, "a blocking reconciliation case is opened");
    assert.equal(openCase.case_status, "open");
    assert.equal(openCase.blocking_payout, true);
    assert.equal(Number(openCase.expected_payout_amount), 199.23);
    assert.equal(Number(openCase.observed_payout_amount), 0);

    // A retried dispatch job stays blocked; still no provider call.
    await assert.rejects(rail.dispatchBatch({ payout_batch_id: batchId, event_id: "dispatch-after-refund-2" }));
    assert.equal(calls.create.length, 0);
  }
});

await runTest("stale settlement writer cannot regress status or shrink refunds_total / paid_amount", async () => {
  const seeded = await seedCompletedDeal("stale-writer");
  const { provider, calls, behavior } = makeProvider();
  const rail = makeRail(provider);

  const stale = await rail.calculateSellerSettlementForDeal(seeded.dealId);
  assert.ok(stale);
  assert.equal(stale!.payout_status, "ready");
  assert.equal(stale!.refunds_total, 0);

  const batchId = await prepareBatched(rail, seeded.dealId);
  behavior.create = async () => ({ result_class: "success", payout_status: "paid" });
  await rail.dispatchBatch({ payout_batch_id: batchId, event_id: "dispatch-paid" });
  let settlement = await settlementOf(seeded.dealId);
  assert.equal(settlement.payout_status, "paid");
  assert.equal(Number(settlement.paid_amount), 199.23);

  await refundParticipant(seeded.dealId, seeded.participantId);
  // A legitimate recompute (under the lock) records the refund but keeps paid.
  await rail.prepareBatchForDeal({ deal_id: seeded.dealId, request_id: "recompute-after-refund" });
  settlement = await settlementOf(seeded.dealId);
  assert.equal(settlement.payout_status, "paid");
  assert.equal(Number(settlement.refunds_total), 220);
  assert.equal(Number(settlement.paid_amount), 199.23);

  // The stale writer (pre-dispatch snapshot) writes last.
  await withTx(async (c) => {
    await lockDealSettlementInTx(c, seeded.dealId);
    await upsertSellerSettlementInTx(c, stale!, "stale-writer");
  });
  settlement = await settlementOf(seeded.dealId);
  assert.equal(settlement.payout_status, "paid", "status never moves back from paid");
  assert.equal(Number(settlement.refunds_total), 220, "refunds_total never decreases");
  assert.equal(Number(settlement.paid_amount), 199.23, "paid_amount never decreases");
  assert.equal(Number(settlement.payout_amount), 199.23, "committed payout amount is frozen after batching");

  // Explicit status paths are guarded too: dispatch on a paid batch is a no-op.
  const again = await rail.dispatchBatch({ payout_batch_id: batchId, event_id: "dispatch-paid-again" });
  assert.equal(again.status, "already_closed");
  assert.equal(calls.create.length, 1);
  assert.equal((await batchOf(batchId)).payout_status, "paid");
});

await runTest("unknown createPayout outcome is recorded durably and never auto re-dispatched", async () => {
  const seeded = await seedCompletedDeal("unknown");
  const { provider, calls, behavior } = makeProvider();
  const rail = makeRail(provider);
  const batchId = await prepareBatched(rail, seeded.dealId);
  const expectedCorrelation = payoutDispatchCorrelationId(batchId);

  behavior.create = async () => ({ result_class: "unknown", payout_status: null });
  behavior.status = async () => ({ result_class: "unknown", payout_status: null });

  await assert.rejects(
    rail.dispatchBatch({ payout_batch_id: batchId, event_id: "evt-1" }),
    /outcome unknown/
  );
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].correlation_id, expectedCorrelation);

  const batch = await batchOf(batchId);
  assert.equal(batch.payout_status, "processing", "unknown is NOT reset to batched");
  assert.match(String(batch.last_error), /outcome_unknown/);
  for (const item of await itemsOf(batchId)) assert.equal(item.payout_status, "processing");
  assert.equal((await settlementOf(seeded.dealId)).payout_status, "processing");
  const unknownCase = (await casesOf(seeded.dealId)).find((row) => row.case_type === "dispatch_outcome_unknown");
  assert.ok(unknownCase);
  assert.equal(unknownCase.case_status, "open");
  assert.equal(unknownCase.blocking_payout, true);
  const attempts = await pool.query(
    `SELECT attempt_type, result_class, correlation_id FROM siton.seller_payout_attempts
     WHERE payout_batch_id=$1 AND attempt_type='create_payout'`,
    [batchId]
  );
  assert.ok(attempts.rows.length >= 1);
  assert.ok(attempts.rows.every((row: any) => row.result_class === "unknown"));
  assert.ok(attempts.rows.every((row: any) => row.correlation_id === expectedCorrelation));

  // Retry of the same job, and a brand-new dispatch event (e.g. after DLQ):
  // lookup only, same correlation id, no second createPayout.
  for (const eventId of ["evt-1", "evt-after-dlq"]) {
    await assert.rejects(rail.dispatchBatch({ payout_batch_id: batchId, event_id: eventId }), /manual resolution/);
  }
  assert.equal(calls.create.length, 1, "no automatic re-dispatch");
  assert.equal(calls.status.length, 2);
  assert.ok(calls.status.every((input) => input.correlation_id === expectedCorrelation));
  assert.equal((await batchOf(batchId)).payout_status, "processing");
  assert.equal((await casesOf(seeded.dealId)).filter((row) => row.case_type === "dispatch_outcome_unknown").length, 1);

  // Neither a re-prepare nor a reconcile can move the batch while unknown.
  const reprepare = await rail.prepareBatchForDeal({ deal_id: seeded.dealId, request_id: "reprepare" }) as any;
  assert.notEqual(reprepare.status, "batched");
  const batchCount = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.seller_payout_batches WHERE trigger_deal_id=$1`, [seeded.dealId]);
  assert.equal(batchCount.rows[0].n, 1);
  await assert.rejects(
    rail.reconcileBatch({ payout_batch_id: batchId, event_id: "reconcile-while-unknown" }),
    (error: any) => error instanceof TestPermanentFail
  );

  // The provider lookup finally proves the payout exists: the case resolves
  // and reconciliation is scheduled, still with exactly one createPayout.
  behavior.status = async () => ({ result_class: "success", payout_status: "processing" });
  await rail.dispatchBatch({ payout_batch_id: batchId, event_id: "evt-lookup-ok" });
  assert.equal(calls.create.length, 1);
  assert.equal((await batchOf(batchId)).payout_status, "processing");
  const resolvedCase = (await casesOf(seeded.dealId)).find((row) => row.case_type === "dispatch_outcome_unknown");
  assert.equal(resolvedCase.case_status, "resolved");
  assert.equal((await settlementOf(seeded.dealId)).has_open_blocking_reconciliation_case, false);
  const reconcileEvent = await pool.query(
    `SELECT 1 FROM siton.outbox_events WHERE event_type='seller_payout_reconcile' AND aggregate_id=$1`,
    [batchId]
  );
  assert.equal(reconcileEvent.rowCount, 1);
  await rail.reconcileBatch({ payout_batch_id: batchId, event_id: "reconcile-after-lookup" });
  assert.equal((await batchOf(batchId)).payout_status, "reconciled");
});

await runTest("a thrown/timed-out createPayout is treated as unknown, not as not-executed", async () => {
  const seeded = await seedCompletedDeal("throw");
  const { provider, calls, behavior } = makeProvider();
  const rail = makeRail(provider);
  const batchId = await prepareBatched(rail, seeded.dealId);
  behavior.create = async () => { throw new Error("socket hang up"); };
  behavior.status = async () => ({ result_class: "temporary_fail", payout_status: null });
  await assert.rejects(rail.dispatchBatch({ payout_batch_id: batchId, event_id: "t-1" }), /outcome unknown/);
  await assert.rejects(rail.dispatchBatch({ payout_batch_id: batchId, event_id: "t-2" }), /manual resolution/);
  assert.equal(calls.create.length, 1);
  assert.equal((await batchOf(batchId)).payout_status, "processing");
  const openCase = (await casesOf(seeded.dealId)).find((row) => row.case_type === "dispatch_outcome_unknown");
  assert.equal(openCase?.case_status, "open");
});

await runTest("payout freeze set after batching is re-checked under lock before the provider call", async () => {
  const seeded = await seedCompletedDeal("freeze");
  const { provider, calls } = makeProvider();
  const rail = makeRail(provider);
  const batchId = await prepareBatched(rail, seeded.dealId);
  await pool.query(
    `INSERT INTO siton.admin_control_flags (flag_type, scope_type, scope_id, status, reason)
     VALUES ('payout_freeze','deal',$1,'active','race test freeze')`,
    [seeded.dealId]
  );
  await assert.rejects(rail.dispatchBatch({ payout_batch_id: batchId, event_id: "frozen" }), /payout_dispatch_held/);
  assert.equal(calls.create.length, 0);
  assert.equal((await batchOf(batchId)).payout_status, "batched");
});

await pool.end();
