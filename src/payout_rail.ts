import { assertRequiredTables } from "./schema_contract.js";
type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

import type {
  NormalizedPayoutResult,
  PayoutLifecycleStatus,
  PayoutProvider,
  PayoutReconciliationResult,
  PayoutResultClass
} from "./payout_provider.js";

export type SellerSettlementStatus = PayoutLifecycleStatus;
export type PayoutBatchStatus = PayoutLifecycleStatus;
export type PayoutItemStatus = PayoutLifecycleStatus;
export type PayoutAttemptType =
  | "prepare"
  | "create_payout"
  | "get_payout_status"
  | "cancel_payout"
  | "reconcile_payout";
export type PayoutReconciliationCaseStatus = "open" | "resolved";

let ensurePayoutRailPromise: Promise<void> | null = null;

export type SettlementCalculation = {
  seller_id: string;
  deal_id: string;
  deal_state: string;
  gross_collected: number;
  platform_fee_total: number;
  refunds_total: number;
  reserve_amount: number;
  seller_net_payable: number;
  payout_amount: number;
  paid_amount: number;
  failed_amount: number;
  returned_amount: number;
  blocked_amount: number;
  delayed_amount: number;
  source_money_event_count: number;
  blocking_reasons: string[];
  has_open_blocking_reconciliation_case: boolean;
  has_open_mismatch: boolean;
  existing_payout_statuses: string[];
  eligible: boolean;
  payout_status: SellerSettlementStatus;
};

type BatchCalculation = {
  seller_id: string;
  settlement_count: number;
  gross_collected: number;
  platform_fee_total: number;
  refunds_total: number;
  reserve_amount: number;
  seller_net_payable: number;
  payout_amount: number;
  paid_amount: number;
  failed_amount: number;
  returned_amount: number;
  blocked_amount: number;
  delayed_amount: number;
  payout_status: PayoutBatchStatus;
};

function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Forward-only payout lifecycle (D5).
//
// The CHECK in migration 021 allows exactly these eight values on
// seller_settlements / seller_payout_batches / seller_payout_batch_items.
// 'pending' and 'ready' are PRE-BATCH, recomputed eligibility states and may
// move freely between each other (a freeze or a refund can take a 'ready'
// settlement back to 'pending'). From 'batched' onward a row only moves
// forward: batched -> processing -> failed|returned -> paid -> reconciled.
// A stale or concurrent writer can therefore never take paid/reconciled
// money truth back to an earlier state.
// ---------------------------------------------------------------------------
export const PAYOUT_LIFECYCLE_STATUSES: readonly PayoutLifecycleStatus[] = [
  "pending",
  "ready",
  "batched",
  "processing",
  "failed",
  "returned",
  "paid",
  "reconciled"
];

const PAYOUT_STATUS_RANK: Record<string, number> = {
  pending: 0,
  ready: 0,
  batched: 2,
  processing: 3,
  failed: 4,
  returned: 4,
  paid: 5,
  reconciled: 6
};

export function canAdvancePayoutStatus(from: string | null | undefined, to: string): boolean {
  const toRank = PAYOUT_STATUS_RANK[to];
  if (toRank === undefined) return false;
  if (from === null || from === undefined || from === "") return true;
  if (from === to) return true;
  const fromRank = PAYOUT_STATUS_RANK[from];
  if (fromRank === undefined) return false;
  if (fromRank === 0) return true;
  return toRank > fromRank;
}

/** Every current status from which a row may move to `to` (including `to` itself). */
export function payoutStatusesAdvanceableTo(to: string): string[] {
  return PAYOUT_LIFECYCLE_STATUSES.filter((from) => canAdvancePayoutStatus(from, to));
}

const PRE_BATCH_STATUSES = ["pending", "ready"];
const PAYABLE_PARTICIPANT_MONEY_STATES = ["ChargedSuccess", "RecoveredCharge"];
const DISPATCH_UNKNOWN_CASE_TYPE = "dispatch_outcome_unknown";

/** Stable per batch: a retried or re-enqueued dispatch never mints a new provider idempotency key. */
export function payoutDispatchCorrelationId(payoutBatchId: string) {
  return `seller-payout-create:${payoutBatchId}`;
}

/**
 * Transaction-scoped per-deal lock. Every settlement / batch / item mutation of
 * the payout rail takes it first, so compute-and-write happens atomically per
 * deal and two workers can never interleave on the same settlement.
 */
export async function lockDealSettlementInTx(c: any, dealId: string) {
  await c.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('siton:settlement:' || $1::text, 0))`,
    [String(dealId)]
  );
}

/** Resolves the batch's deal, takes the deal lock, then row-locks the batch. */
async function lockBatchInTx(c: any, payoutBatchId: string) {
  const head = await c.query(
    `SELECT trigger_deal_id FROM siton.seller_payout_batches WHERE payout_batch_id=$1 LIMIT 1`,
    [payoutBatchId]
  );
  if (!head.rowCount) return null;
  await lockDealSettlementInTx(c, String(head.rows[0].trigger_deal_id));
  const batch = await c.query(
    `SELECT * FROM siton.seller_payout_batches WHERE payout_batch_id=$1 FOR UPDATE`,
    [payoutBatchId]
  );
  return batch.rows[0] ?? null;
}

type TreeSet = { set: string; params?: unknown[] };

/**
 * Moves a batch, its items and its linked settlements forward to `to`. Rows
 * that are already at or beyond `to` (per canAdvancePayoutStatus) are left
 * untouched. Each extra SET fragment may reference its own params from $4 on
 * ($1 batch id, $2 allowed-from statuses, $3 target status).
 */
async function advanceBatchTreeInTx(c: any, payoutBatchId: string, to: PayoutLifecycleStatus, opts: {
  batch?: TreeSet | undefined;
  item?: TreeSet | undefined;
  settlement?: TreeSet | undefined;
} = {}) {
  const allowedFrom = payoutStatusesAdvanceableTo(to);
  const run = (table: "seller_payout_batches" | "seller_payout_batch_items" | "seller_settlements", extra?: TreeSet) =>
    c.query(
      `UPDATE siton.${table}
       SET payout_status=$3, updated_at=now()${extra?.set ? `, ${extra.set}` : ""}
       WHERE payout_batch_id=$1 AND payout_status = ANY($2::text[])`,
      [payoutBatchId, allowedFrom, to, ...(extra?.params ?? [])]
    );
  const batch = await run("seller_payout_batches", opts.batch);
  await run("seller_payout_batch_items", opts.item);
  await run("seller_settlements", opts.settlement);
  return Number(batch.rowCount || 0) > 0;
}

async function refreshSettlementCaseFlagInTx(c: any, dealId: string) {
  await c.query(
    `UPDATE siton.seller_settlements s
     SET has_open_blocking_reconciliation_case=open_case.present,
         blocker_reasons=CASE
           WHEN open_case.present THEN s.blocker_reasons
           ELSE array_remove(s.blocker_reasons, 'open_blocking_reconciliation_case')
         END,
         updated_at=now()
     FROM (
       SELECT EXISTS (
         SELECT 1 FROM siton.seller_payout_reconciliation_cases
         WHERE deal_id=$1 AND case_status='open' AND blocking_payout=true
       ) AS present
     ) open_case
     WHERE s.deal_id=$1`,
    [dealId]
  );
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function firstBlockingStatus(statuses: string[]) {
  const normalized = statuses.map((value) => String(value || "").trim().toLowerCase());
  if (normalized.includes("paid")) return "paid";
  if (normalized.includes("reconciled")) return "reconciled";
  if (normalized.includes("processing")) return "processing";
  if (normalized.includes("batched")) return "batched";
  if (normalized.includes("returned")) return "returned";
  if (normalized.includes("failed")) return "failed";
  return null;
}

function deriveSettlementStatus(args: {
  deal_state: string;
  eligible: boolean;
  payout_amount: number;
  blocking_reasons: string[];
  existing_payout_statuses: string[];
  payout_freeze_active?: boolean;
}) {
  const existingStatus = firstBlockingStatus(args.existing_payout_statuses);
  if (existingStatus) return existingStatus as SellerSettlementStatus;
  if (args.payout_freeze_active) return "pending" as const;
  if (String(args.deal_state) !== "Completed") return "pending" as const;
  if (!args.eligible) return "pending" as const;
  if (args.blocking_reasons.length > 0) return "pending" as const;
  if (args.payout_amount <= 0) return "returned" as const;
  return "ready" as const;
}

function summarizeBatchFromSettlements(settlements: SettlementCalculation[]): BatchCalculation {
  const totals = settlements.reduce(
    (acc, settlement) => ({
      gross_collected: roundMoney(acc.gross_collected + settlement.gross_collected),
      platform_fee_total: roundMoney(acc.platform_fee_total + settlement.platform_fee_total),
      refunds_total: roundMoney(acc.refunds_total + settlement.refunds_total),
      reserve_amount: roundMoney(acc.reserve_amount + settlement.reserve_amount),
      seller_net_payable: roundMoney(acc.seller_net_payable + settlement.seller_net_payable),
      payout_amount: roundMoney(acc.payout_amount + settlement.payout_amount),
      paid_amount: roundMoney(acc.paid_amount + settlement.paid_amount),
      failed_amount: roundMoney(acc.failed_amount + settlement.failed_amount),
      returned_amount: roundMoney(acc.returned_amount + settlement.returned_amount),
      blocked_amount: roundMoney(acc.blocked_amount + settlement.blocked_amount),
      delayed_amount: roundMoney(acc.delayed_amount + settlement.delayed_amount)
    }),
    {
      gross_collected: 0,
      platform_fee_total: 0,
      refunds_total: 0,
      reserve_amount: 0,
      seller_net_payable: 0,
      payout_amount: 0,
      paid_amount: 0,
      failed_amount: 0,
      returned_amount: 0,
      blocked_amount: 0,
      delayed_amount: 0
    }
  );

  let payout_status: PayoutBatchStatus = "pending";
  if (settlements.length > 0 && settlements.every((settlement) => settlement.payout_status === "ready")) {
    payout_status = "ready";
  }

  return {
    seller_id: settlements[0]?.seller_id || "",
    settlement_count: settlements.length,
    ...totals,
    payout_status
  };
}

export async function ensurePayoutRailTables(withTx: WithTx) {
  await withTx(async c=>assertRequiredTables(c,["seller_settlements","seller_payout_batches","seller_payout_batch_items","seller_payout_attempts","seller_payout_reconciliation_cases"]));
}

async function insertOutboxEventIfMissing(c: any, args: {
  event_type: "seller_payout_prepare" | "seller_payout_dispatch" | "seller_payout_reconcile";
  aggregate_type: "deal" | "seller_payout_batch";
  aggregate_id: string;
  payload: any;
}) {
  const existing = await c.query(
    `SELECT event_uuid
     FROM siton.outbox_events
     WHERE event_type=$1
       AND aggregate_type=$2
       AND aggregate_id=$3
       AND status IN ('pending','processing','sent')
     LIMIT 1`,
    [args.event_type, args.aggregate_type, args.aggregate_id]
  );
  if (existing.rowCount) return false;

  await c.query(
    `INSERT INTO siton.outbox_events (
       event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at
     ) VALUES ($1,$2,$3,$4,'pending',0,now())`,
    [args.event_type, args.aggregate_type, args.aggregate_id, JSON.stringify(args.payload ?? {})]
  );
  return true;
}

async function calculateSellerSettlementForDealInTx(c: any, dealId: string, options?: {
  exclude_payout_batch_id?: string | null;
}): Promise<SettlementCalculation | null> {
  const dealResult = await c.query(
    `SELECT d.deal_id, d.seller_id, d.state, sa.settlement_status
     FROM siton.deals d
     JOIN siton.seller_accounts sa ON sa.seller_id = d.seller_id
     WHERE d.deal_id=$1
     LIMIT 1`,
    [dealId]
  );
  if (!dealResult.rowCount) return null;

  const deal = dealResult.rows[0];
  const settlementStatus = String(deal.settlement_status || "active");

  const moneyResult = await c.query(
    `SELECT
       COUNT(*)::int AS source_money_event_count,
       COALESCE(SUM(CASE WHEN gross_amount > 0 THEN gross_amount ELSE 0 END), 0) AS gross_collected,
       COALESCE(SUM(platform_fee_total_amount), 0) AS platform_fee_total,
       COALESCE(SUM(CASE WHEN gross_amount < 0 THEN ABS(gross_amount) ELSE 0 END), 0) AS refunds_total,
       COALESCE(SUM(seller_net_amount), 0) AS seller_net_payable
     FROM siton.platform_fee_money_events
     WHERE deal_id=$1`,
    [dealId]
  );

  const payoutItemsResult = await c.query(
    `SELECT payout_status, COUNT(*)::int AS cnt
     FROM siton.seller_payout_batch_items
     WHERE deal_id=$1
       AND ($2::uuid IS NULL OR payout_batch_id <> $2::uuid)
     GROUP BY payout_status`,
    [dealId, options?.exclude_payout_batch_id ?? null]
  );

  const openCasesResult = await c.query(
    `SELECT COUNT(*)::int AS open_count
     FROM siton.seller_payout_reconciliation_cases
     WHERE deal_id=$1
       AND case_status='open'
       AND blocking_payout=true`,
    [dealId]
  );

  const money = moneyResult.rows[0];
  const grossCollected = roundMoney(Number(money?.gross_collected || 0));
  const platformFeeTotal = roundMoney(Number(money?.platform_fee_total || 0));
  const refundsTotal = roundMoney(Number(money?.refunds_total || 0));
  const reserveAmount = 0;
  const sellerNetPayable = roundMoney(Number(money?.seller_net_payable || 0) - reserveAmount);
  const existingPayoutStatuses = payoutItemsResult.rows.map((row: any) => String(row.payout_status || ""));
  const hasBlockingPayoutStatus = existingPayoutStatuses.some((status: string) =>
    ["batched", "processing", "paid", "reconciled"].includes(status)
  );
  const hasOpenBlockingReconciliationCase = Number(openCasesResult.rows[0]?.open_count || 0) > 0;
  const hasOpenMismatch = sellerNetPayable < 0;
  // payout_freeze admin flag is a fail-closed eligibility gate. Existing
  // settlement rows already advanced past 'pending' (paid/reconciled/etc) are
  // not retroactively rolled back by a freeze; the freeze only prevents new
  // payout eligibility from forming.
  const payoutFreezeRow = await c.query(
    `SELECT 1
     FROM siton.admin_control_flags
     WHERE flag_type='payout_freeze' AND status='active'
       AND (expires_at IS NULL OR expires_at > now())
       AND (
         (scope_type='global' AND scope_id='global')
         OR (scope_type='seller' AND scope_id=$1)
         OR (scope_type='deal' AND scope_id=$2)
       )
     LIMIT 1`,
    [String(deal.seller_id), String(deal.deal_id)]
  ).catch(() => ({ rowCount: 0 }));
  const payoutFreezeActive = Boolean(payoutFreezeRow.rowCount);
  const blockingReasons = uniqueStrings([
    String(deal.state) !== "Completed" ? `deal_state_${String(deal.state).toLowerCase()}` : "",
    settlementStatus !== "active" ? `seller_settlement_status_${settlementStatus}` : "",
    grossCollected <= 0 ? "no_gross_collected" : "",
    sellerNetPayable <= 0 ? "seller_net_non_positive" : "",
    hasBlockingPayoutStatus ? "deal_already_payouted_or_inflight" : "",
    hasOpenBlockingReconciliationCase ? "open_blocking_reconciliation_case" : "",
    hasOpenMismatch ? "open_money_mismatch" : "",
    payoutFreezeActive ? "payout_freeze_admin_flag_active" : ""
  ]);
  const eligible = blockingReasons.length === 0;
  const payoutAmount = eligible ? sellerNetPayable : 0;
  const paidAmount = existingPayoutStatuses.includes("paid") || existingPayoutStatuses.includes("reconciled")
    ? sellerNetPayable
    : 0;
  const failedAmount = existingPayoutStatuses.includes("failed") ? sellerNetPayable : 0;
  const returnedAmount = existingPayoutStatuses.includes("returned") ? sellerNetPayable : 0;
  const blockedAmount = !eligible && sellerNetPayable > 0 ? sellerNetPayable : 0;
  const delayedAmount =
    !eligible && blockingReasons.some((reason) => reason.includes("reconciliation") || reason.includes("mismatch"))
      ? Math.max(0, sellerNetPayable)
      : 0;

  return {
    seller_id: String(deal.seller_id),
    deal_id: String(deal.deal_id),
    deal_state: String(deal.state),
    gross_collected: grossCollected,
    platform_fee_total: roundMoney(platformFeeTotal),
    refunds_total: refundsTotal,
    reserve_amount: reserveAmount,
    seller_net_payable: sellerNetPayable,
    payout_amount: roundMoney(payoutAmount),
    paid_amount: roundMoney(paidAmount),
    failed_amount: roundMoney(failedAmount),
    returned_amount: roundMoney(returnedAmount),
    blocked_amount: roundMoney(blockedAmount),
    delayed_amount: roundMoney(delayedAmount),
    source_money_event_count: Number(money?.source_money_event_count || 0),
    blocking_reasons: blockingReasons,
    has_open_blocking_reconciliation_case: hasOpenBlockingReconciliationCase,
    has_open_mismatch: hasOpenMismatch,
    existing_payout_statuses: existingPayoutStatuses,
    eligible,
    payout_status: deriveSettlementStatus({
      deal_state: String(deal.state),
      eligible,
      payout_amount: payoutAmount,
      blocking_reasons: blockingReasons,
      existing_payout_statuses: existingPayoutStatuses,
      payout_freeze_active: payoutFreezeActive
    })
  };
}

/**
 * The ONLY settlement writer. Callers must hold lockDealSettlementInTx for the
 * deal and must have computed `settlement` inside the same transaction.
 * Defence in depth against a stale writer anyway:
 *   - payout_status only moves forward (canAdvancePayoutStatus);
 *   - refunds_total and paid_amount never decrease;
 *   - payout_amount is frozen once the settlement left the pre-batch states
 *     (the batch is the committed amount; drift is surfaced as a case).
 */
export async function upsertSellerSettlementInTx(c: any, settlement: SettlementCalculation, correlationId: string) {
  const idempotencyKey = `seller-settlement:${settlement.deal_id}`;
  await c.query(
    `INSERT INTO siton.seller_settlements (
       seller_id,
       deal_id,
       payout_status,
       gross_collected,
       platform_fee_total,
       refunds_total,
       reserve_amount,
       seller_net_payable,
       payout_amount,
       paid_amount,
       failed_amount,
       returned_amount,
       blocked_amount,
       delayed_amount,
       mismatch_amount,
       source_money_event_count,
       has_open_mismatch,
       has_open_blocking_reconciliation_case,
       final_truth_basis,
       blocker_reasons,
       correlation_id,
       idempotency_key,
       last_calculated_at,
       updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now(),now()
     )
     ON CONFLICT (deal_id) DO UPDATE
     SET payout_status=CASE
           WHEN siton.seller_settlements.payout_status = ANY($23::text[]) THEN EXCLUDED.payout_status
           ELSE siton.seller_settlements.payout_status
         END,
         gross_collected=EXCLUDED.gross_collected,
         platform_fee_total=EXCLUDED.platform_fee_total,
         refunds_total=GREATEST(siton.seller_settlements.refunds_total, EXCLUDED.refunds_total),
         reserve_amount=EXCLUDED.reserve_amount,
         seller_net_payable=EXCLUDED.seller_net_payable,
         payout_amount=CASE
           WHEN siton.seller_settlements.payout_status = ANY($24::text[]) THEN EXCLUDED.payout_amount
           ELSE siton.seller_settlements.payout_amount
         END,
         paid_amount=GREATEST(
           siton.seller_settlements.paid_amount,
           LEAST(
             EXCLUDED.paid_amount,
             CASE
               WHEN siton.seller_settlements.payout_status = ANY($24::text[]) THEN EXCLUDED.payout_amount
               ELSE siton.seller_settlements.payout_amount
             END
           )
         ),
         failed_amount=EXCLUDED.failed_amount,
         returned_amount=EXCLUDED.returned_amount,
         blocked_amount=EXCLUDED.blocked_amount,
         delayed_amount=EXCLUDED.delayed_amount,
         mismatch_amount=EXCLUDED.mismatch_amount,
         source_money_event_count=EXCLUDED.source_money_event_count,
         has_open_mismatch=EXCLUDED.has_open_mismatch,
         has_open_blocking_reconciliation_case=EXCLUDED.has_open_blocking_reconciliation_case,
         final_truth_basis=EXCLUDED.final_truth_basis,
         blocker_reasons=EXCLUDED.blocker_reasons,
         correlation_id=EXCLUDED.correlation_id,
         last_calculated_at=now(),
         updated_at=now()`,
    [
      settlement.seller_id,
      settlement.deal_id,
      settlement.payout_status,
      settlement.gross_collected,
      settlement.platform_fee_total,
      settlement.refunds_total,
      settlement.reserve_amount,
      settlement.seller_net_payable,
      settlement.payout_amount,
      settlement.paid_amount,
      settlement.failed_amount,
      settlement.returned_amount,
      settlement.blocked_amount,
      settlement.delayed_amount,
      settlement.has_open_mismatch ? settlement.seller_net_payable : 0,
      settlement.source_money_event_count,
      settlement.has_open_mismatch,
      settlement.has_open_blocking_reconciliation_case,
      "deal_completed_money_truth",
      settlement.blocking_reasons,
      correlationId,
      idempotencyKey,
      payoutStatusesAdvanceableTo(settlement.payout_status),
      PRE_BATCH_STATUSES
    ]
  );

  const result = await c.query(
    `SELECT *
     FROM siton.seller_settlements
     WHERE deal_id=$1
     LIMIT 1`,
    [settlement.deal_id]
  );
  return result.rows[0];
}

const upsertSellerSettlement = upsertSellerSettlementInTx;

async function createBlockingReconciliationCase(c: any, args: {
  seller_settlement_id: string | null;
  payout_batch_id: string | null;
  seller_id: string;
  deal_id: string;
  case_type: string;
  correlation_id: string;
  expected_payout_amount: number;
  observed_payout_amount: number;
  expected_item_count: number;
  observed_item_count: number;
  details: Record<string, unknown>;
}) {
  await c.query(
    `INSERT INTO siton.seller_payout_reconciliation_cases (
       seller_settlement_id,
       payout_batch_id,
       seller_id,
       deal_id,
       case_status,
       case_type,
       correlation_id,
       blocking_payout,
       expected_payout_amount,
       observed_payout_amount,
       expected_item_count,
       observed_item_count,
       details
     ) VALUES ($1,$2,$3,$4,'open',$5,$6,true,$7,$8,$9,$10,$11)`,
    [
      args.seller_settlement_id,
      args.payout_batch_id,
      args.seller_id,
      args.deal_id,
      args.case_type,
      args.correlation_id,
      args.expected_payout_amount,
      args.observed_payout_amount,
      args.expected_item_count,
      args.observed_item_count,
      JSON.stringify(args.details)
    ]
  );
}

/**
 * Opens a blocking reconciliation case unless an open one of the same type
 * already exists for the same batch (or, without a batch, the same deal), and
 * flags the deal's settlement. Returns true when a new case was opened.
 */
async function ensureOpenBlockingCase(c: any, args: Parameters<typeof createBlockingReconciliationCase>[1]) {
  const existing = await c.query(
    `SELECT 1
     FROM siton.seller_payout_reconciliation_cases
     WHERE deal_id=$1
       AND case_type=$2
       AND case_status='open'
       AND payout_batch_id IS NOT DISTINCT FROM $3::uuid
     LIMIT 1`,
    [args.deal_id, args.case_type, args.payout_batch_id]
  );
  if (!existing.rowCount) await createBlockingReconciliationCase(c, args);
  await c.query(
    `UPDATE siton.seller_settlements
     SET has_open_blocking_reconciliation_case=true,
         blocker_reasons=ARRAY(
           SELECT DISTINCT reason
           FROM unnest(blocker_reasons || ARRAY['open_blocking_reconciliation_case']) AS reason
         ),
         updated_at=now()
     WHERE deal_id=$1`,
    [args.deal_id]
  );
  return !existing.rowCount;
}

async function loadBatchSnapshot(c: any, payoutBatchId: string) {
  const batch = await c.query(
    `SELECT *
     FROM siton.seller_payout_batches
     WHERE payout_batch_id=$1
     LIMIT 1`,
    [payoutBatchId]
  );
  if (!batch.rowCount) return null;

  const settlements = await c.query(
    `SELECT *
     FROM siton.seller_settlements
     WHERE payout_batch_id=$1
     ORDER BY created_at ASC`,
    [payoutBatchId]
  );
  const items = await c.query(
    `SELECT *
     FROM siton.seller_payout_batch_items
     WHERE payout_batch_id=$1
     ORDER BY created_at ASC`,
    [payoutBatchId]
  );
  const attempts = await c.query(
    `SELECT attempt_type, result_class, payout_status, correlation_id, provider_reference, payload, created_at
     FROM siton.seller_payout_attempts
     WHERE payout_batch_id=$1
     ORDER BY created_at DESC`,
    [payoutBatchId]
  );
  const reconciliationCases = await c.query(
    `SELECT case_status, case_type, correlation_id, blocking_payout,
            expected_payout_amount, observed_payout_amount,
            expected_item_count, observed_item_count, details, resolved_at, created_at
     FROM siton.seller_payout_reconciliation_cases
     WHERE payout_batch_id=$1
     ORDER BY created_at DESC`,
    [payoutBatchId]
  );

  return {
    batch: batch.rows[0],
    settlements: settlements.rows,
    items: items.rows,
    attempts: attempts.rows,
    reconciliation_cases: reconciliationCases.rows
  };
}

async function replaceSettlementBatchLink(c: any, sellerSettlementId: string, payoutBatchId: string) {
  await c.query(
    `UPDATE siton.seller_settlements
     SET payout_batch_id=$2,
         payout_status='batched',
         updated_at=now()
     WHERE seller_settlement_id=$1
       AND payout_status = ANY($3::text[])`,
    [sellerSettlementId, payoutBatchId, payoutStatusesAdvanceableTo("batched")]
  );
}

async function resolveDispatchUnknownCasesInTx(c: any, batch: any, resolution: Record<string, unknown>) {
  await c.query(
    `UPDATE siton.seller_payout_reconciliation_cases
     SET case_status='resolved',
         resolved_at=now(),
         details=details || $3::jsonb
     WHERE payout_batch_id=$1
       AND case_type=$2
       AND case_status='open'`,
    [String(batch.payout_batch_id), DISPATCH_UNKNOWN_CASE_TYPE, JSON.stringify({ resolution })]
  );
  await refreshSettlementCaseFlagInTx(c, String(batch.trigger_deal_id));
}

/** Applies a provider-confirmed processing/paid state (forward-only) and schedules reconciliation. */
async function applyProviderAcceptedInTx(
  c: any,
  batch: any,
  result: NormalizedPayoutResult,
  source: string,
  extraResolution: Record<string, unknown> = {}
) {
  const target: PayoutLifecycleStatus = result.payout_status === "paid" || result.payout_status === "reconciled"
    ? "paid"
    : "processing";
  const reference = result.payout_reference ?? null;
  const executed = Boolean(result.external_transfer_executed);
  await advanceBatchTreeInTx(c, String(batch.payout_batch_id), target, {
    batch: {
      set: `provider_batch_reference=COALESCE($4::text, provider_batch_reference),
            external_transfer_executed=$5::boolean,
            created_payout_at=COALESCE(created_payout_at, now()),
            last_error=NULL${target === "paid" ? ", paid_amount=payout_amount, paid_at=COALESCE(paid_at, now())" : ""}`,
      params: [reference, executed]
    },
    item: {
      set: `provider_item_reference=COALESCE($4::text, provider_item_reference), external_transfer_executed=$5::boolean`,
      params: [reference, executed]
    },
    settlement: target === "paid" ? { set: "paid_amount=GREATEST(paid_amount, payout_amount)" } : undefined
  });
  await resolveDispatchUnknownCasesInTx(c, batch, {
    resolved_by: source,
    provider_payout_status: result.payout_status ?? null,
    provider_reference: reference,
    ...extraResolution
  });
  await insertOutboxEventIfMissing(c, {
    event_type: "seller_payout_reconcile",
    aggregate_type: "seller_payout_batch",
    aggregate_id: String(batch.payout_batch_id),
    payload: {
      payout_batch_id: String(batch.payout_batch_id),
      payout_reference: reference
    }
  });
}

export const PAYOUT_ATTESTED_OUTCOMES = ["processing", "paid", "failed"] as const;
export type PayoutAttestedOutcome = (typeof PAYOUT_ATTESTED_OUTCOMES)[number];

/** Operator-supplied provider evidence id: 3..200 chars of [A-Za-z0-9._:/#-], no surrounding whitespace. */
export function isValidAttestedProviderReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:\/#-]{3,200}$/.test(value.trim()) && value.trim() === value;
}

/**
 * Black-Sky follow-up (F7 closure): resolve an open dispatch_outcome_unknown
 * case from an OPERATOR ATTESTATION — a human checked the payout provider and
 * records what it shows, with the provider's reference as evidence. Runs inside
 * the admin action transaction (second approval + recent MFA are enforced by
 * the control plane). No provider call, no money movement: it records truth the
 * provider already holds, forward-only.
 *   * processing | paid: the payout EXISTS at the provider -> the same path as a
 *     provider-confirmed lookup (reference stored, reconcile scheduled).
 *   * failed: the provider confirms NO transfer happened -> batch tree failed.
 * Every attestation writes a seller_payout_attempts row and the case resolution
 * carries the admin action id, requester/approver/executor and the reference.
 */
export async function resolveDispatchUnknownByAttestationInTx(c: any, args: {
  payout_batch_id: string;
  outcome: PayoutAttestedOutcome;
  provider_reference: string;
  admin_action_id: string;
  executed_by: string;
  requested_by: string | null;
  approved_by: string | null;
  note: string;
}): Promise<{ ok: true; status: PayoutLifecycleStatus } | { ok: false; code: string }> {
  if (!(PAYOUT_ATTESTED_OUTCOMES as readonly string[]).includes(args.outcome)) return { ok: false, code: "attested_outcome_invalid" };
  if (!isValidAttestedProviderReference(args.provider_reference)) return { ok: false, code: "provider_reference_required" };
  const batch = await lockBatchInTx(c, args.payout_batch_id);
  if (!batch) return { ok: false, code: "payout_batch_not_found" };
  const open = await c.query(
    `SELECT payout_reconciliation_case_id FROM siton.seller_payout_reconciliation_cases
     WHERE payout_batch_id=$1 AND case_type=$2 AND case_status='open' LIMIT 1`,
    [args.payout_batch_id, DISPATCH_UNKNOWN_CASE_TYPE]
  );
  if (!open.rowCount) return { ok: false, code: "no_open_dispatch_unknown_case" };
  if (String(batch.payout_status) !== "processing") return { ok: false, code: `payout_batch_not_processing:${batch.payout_status}` };

  const correlationId = `admin-attestation:${args.admin_action_id}`;
  const evidence = {
    source: "operator_attestation",
    admin_action_id: args.admin_action_id,
    executed_by: args.executed_by,
    requested_by: args.requested_by,
    approved_by: args.approved_by,
    attested_outcome: args.outcome,
    attested_provider_reference: args.provider_reference,
    note: String(args.note || "").slice(0, 500)
  };
  await c.query(
    `INSERT INTO siton.seller_payout_attempts (
       payout_batch_id, payout_item_id, attempt_type, result_class, payout_status, correlation_id, provider_reference, payload
     ) VALUES ($1, NULL, 'get_payout_status', 'success', $2, $3, $4, $5)
     ON CONFLICT (payout_batch_id, payout_item_id, attempt_type, correlation_id) DO NOTHING`,
    [args.payout_batch_id, args.outcome, correlationId, args.provider_reference, JSON.stringify(evidence)]
  );

  if (args.outcome === "failed") {
    await advanceBatchTreeInTx(c, args.payout_batch_id, "failed", {
      batch: { set: "last_error=$4", params: ["operator_attested_failed"] },
      settlement: { set: "failed_amount=payout_amount" }
    });
    await resolveDispatchUnknownCasesInTx(c, batch, { resolved_by: "operator_attestation", provider_payout_status: "failed", ...evidence });
    return { ok: true, status: "failed" };
  }
  await applyProviderAcceptedInTx(c, batch, {
    provider: "operator_attestation",
    result_class: "success",
    retryable: false,
    payout_status: args.outcome,
    payout_reference: args.provider_reference,
    correlation_id: correlationId,
    external_transfer_executed: true,
    raw: evidence
  }, "operator_attestation", evidence);
  return { ok: true, status: args.outcome };
}

export function buildPayoutRail(deps: {
  withTx: WithTx;
  payoutProvider: PayoutProvider;
  PermanentFailErrorCtor: new (...args: any[]) => Error;
}) {
  async function calculateSellerSettlementForDeal(dealId: string, options?: {
    exclude_payout_batch_id?: string | null;
  }) {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => calculateSellerSettlementForDealInTx(c, dealId, options));
  }

  async function calculateSellerPayoutBatchBySettlementIds(args: {
    seller_id: string;
    seller_settlement_ids: string[];
  }) {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => {
      const result = await c.query(
        `SELECT seller_id, deal_id
         FROM siton.seller_settlements
         WHERE seller_settlement_id = ANY($1::uuid[])
         ORDER BY deal_id`,
        [args.seller_settlement_ids]
      );
      const settlements: SettlementCalculation[] = [];
      for (const row of result.rows) {
        const calculated = await calculateSellerSettlementForDealInTx(c, String(row.deal_id));
        if (calculated) settlements.push(calculated);
      }
      return summarizeBatchFromSettlements(settlements);
    });
  }

  async function summarizeSellerReadiness(sellerId: string) {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => {
      const seller = await c.query(
        `SELECT seller_id, display_name, settlement_status, payout_method, payout_details_masked
         FROM siton.seller_accounts
         WHERE seller_id=$1
         LIMIT 1`,
        [sellerId]
      );
      if (!seller.rowCount) return null;

      const deals = await c.query(
        `SELECT deal_id
         FROM siton.deals
         WHERE seller_id=$1
         ORDER BY created_at DESC`,
        [sellerId]
      );

      const settlements: SettlementCalculation[] = [];
      for (const row of deals.rows) {
        const calculated = await calculateSellerSettlementForDealInTx(c, String(row.deal_id));
        if (calculated) settlements.push(calculated);
      }

      const readySettlements = settlements.filter((settlement) => settlement.payout_status === "ready");
      const openCases = await c.query(
        `SELECT COUNT(*)::int AS open_cases
         FROM siton.seller_payout_reconciliation_cases
         WHERE seller_id=$1
           AND case_status='open'
           AND blocking_payout=true`,
        [sellerId]
      );

      return {
        seller: seller.rows[0],
        eligibility: {
          ready_settlement_count: readySettlements.length,
          payout_amount_ready: roundMoney(
            readySettlements.reduce((sum, settlement) => sum + settlement.payout_amount, 0)
          ),
          blocked_amount: roundMoney(
            settlements.reduce((sum, settlement) => sum + settlement.blocked_amount, 0)
          ),
          delayed_amount: roundMoney(
            settlements.reduce((sum, settlement) => sum + settlement.delayed_amount, 0)
          ),
          open_blocking_reconciliation_cases: Number(openCases.rows[0]?.open_cases || 0),
          seller_settlement_status: String(seller.rows[0].settlement_status || "active"),
          eligible_for_dispatch:
            String(seller.rows[0].settlement_status || "active") === "active"
            && readySettlements.length > 0
            && Number(openCases.rows[0]?.open_cases || 0) === 0
        },
        settlements: settlements.map((settlement) => ({
          deal_id: settlement.deal_id,
          payout_status: settlement.payout_status,
          gross_collected: settlement.gross_collected,
          platform_fee_total: settlement.platform_fee_total,
          refunds_total: settlement.refunds_total,
          reserve_amount: settlement.reserve_amount,
          seller_net_payable: settlement.seller_net_payable,
          payout_amount: settlement.payout_amount,
          blocking_reasons: settlement.blocking_reasons
        }))
      };
    });
  }

  async function prepareBatchForDeal(args: {
    deal_id: string;
    request_id: string;
    correlation_id?: string | null;
  }) {
    await ensurePayoutRailTables(deps.withTx);
    const correlationId = args.correlation_id ?? `seller-payout-prepare:${args.deal_id}`;
    const settlementIdempotencyKey = `seller-settlement:${args.deal_id}`;
    const batchIdempotencyKey = `seller-payout-batch:${args.deal_id}`;

    return deps.withTx(async (c) => {
      // Serialize with every other settlement/batch writer of this deal, then
      // row-lock the deal's participants. Refund ledger inserts reference the
      // participant (FK -> FOR KEY SHARE) and refund state changes UPDATE it,
      // so a refund either committed before this point (and is read below) or
      // waits until this batch commits (and is caught by the dispatch-time
      // re-check / reconciliation as a blocking case).
      await lockDealSettlementInTx(c, args.deal_id);
      await c.query(
        `SELECT participant_id
         FROM siton.participants
         WHERE deal_id=$1
         ORDER BY participant_id
         FOR UPDATE`,
        [args.deal_id]
      );
      const settlementCalculation = await calculateSellerSettlementForDealInTx(c, args.deal_id);
      if (!settlementCalculation) {
        return { status: "deal_not_found" as const, replay: false, batch_profile: null };
      }

      const sellerSettlement = await upsertSellerSettlement(c, settlementCalculation, correlationId);

      if (settlementCalculation.payout_status !== "ready" || String(sellerSettlement?.payout_status) !== "ready") {
        return {
          status: String(sellerSettlement?.payout_status || settlementCalculation.payout_status) as SellerSettlementStatus,
          replay: false,
          batch_profile: null,
          seller_settlement: sellerSettlement
        };
      }

      const existingBatch = await c.query(
        `SELECT payout_batch_id
         FROM siton.seller_payout_batches
         WHERE idempotency_key=$1
         LIMIT 1`,
        [batchIdempotencyKey]
      );
      if (existingBatch.rowCount) {
        return {
          status: "duplicate_ignored" as const,
          replay: true,
          batch_profile: await loadBatchSnapshot(c, String(existingBatch.rows[0].payout_batch_id)),
          seller_settlement: sellerSettlement
        };
      }

      // Re-read every participant's money state and refund adjustments under
      // the deal lock + participant row locks taken above. Only a captured,
      // never-refunded participant with positive net is payable; anything else
      // is excluded. If the payable items do not add up to the settlement's
      // payout amount the money truth is inconsistent: open a blocking case
      // and do not batch (uncertainty over invented truth).
      const participantRows = await c.query(
        `SELECT p.participant_id, p.buyer_state, p.money_state,
                COALESCE(SUM(CASE WHEN m.gross_amount > 0 THEN m.gross_amount ELSE 0 END), 0) AS gross_collected,
                COALESCE(SUM(m.platform_fee_total_amount), 0) AS platform_fee_total,
                COALESCE(SUM(CASE WHEN m.gross_amount < 0 THEN ABS(m.gross_amount) ELSE 0 END), 0) AS refunds_total,
                COALESCE(SUM(m.seller_net_amount), 0) AS seller_net_payable,
                COUNT(m.money_event_id)::int AS source_money_event_count,
                COUNT(*) FILTER (
                  WHERE m.logical_entry_type='refund_adjustment' OR m.gross_amount < 0
                )::int AS refund_entry_count
         FROM siton.participants p
         JOIN siton.platform_fee_money_events m ON m.participant_id = p.participant_id
         WHERE p.deal_id=$1
         GROUP BY p.participant_id, p.buyer_state, p.money_state
         ORDER BY p.participant_id`,
        [args.deal_id]
      );
      const payableParticipants: any[] = [];
      const excludedParticipants: Array<{ participant_id: string; money_state: string; seller_net_payable: number; reason: string }> = [];
      for (const row of participantRows.rows) {
        const net = roundMoney(Number(row.seller_net_payable || 0));
        const reason =
          Number(row.refund_entry_count || 0) > 0 ? "refund_adjustment_present"
            : !PAYABLE_PARTICIPANT_MONEY_STATES.includes(String(row.money_state)) ? `money_state_${String(row.money_state)}`
              : net <= 0 ? "seller_net_non_positive"
                : "";
        if (reason) {
          if (net !== 0) {
            excludedParticipants.push({
              participant_id: String(row.participant_id),
              money_state: String(row.money_state),
              seller_net_payable: net,
              reason
            });
          }
          continue;
        }
        payableParticipants.push(row);
      }
      const payableTotal = roundMoney(
        payableParticipants.reduce((sum, row) => sum + roundMoney(Number(row.seller_net_payable || 0)), 0)
      );
      if (payableParticipants.length === 0 || payableTotal !== roundMoney(settlementCalculation.payout_amount)) {
        await ensureOpenBlockingCase(c, {
          seller_settlement_id: String(sellerSettlement.seller_settlement_id),
          payout_batch_id: null,
          seller_id: settlementCalculation.seller_id,
          deal_id: args.deal_id,
          case_type: "batch_item_total_mismatch",
          correlation_id: correlationId,
          expected_payout_amount: roundMoney(settlementCalculation.payout_amount),
          observed_payout_amount: payableTotal,
          expected_item_count: participantRows.rowCount ?? 0,
          observed_item_count: payableParticipants.length,
          details: {
            reason: "payable_participants_do_not_match_settlement",
            settlement_payout_amount: roundMoney(settlementCalculation.payout_amount),
            payable_participant_total: payableTotal,
            excluded_participants: excludedParticipants
          }
        });
        await c.query(
          `UPDATE siton.seller_settlements
           SET payout_status='pending',
               payout_amount=0,
               updated_at=now()
           WHERE seller_settlement_id=$1
             AND payout_status = ANY($2::text[])`,
          [String(sellerSettlement.seller_settlement_id), PRE_BATCH_STATUSES]
        );
        return {
          status: "pending" as const,
          replay: false,
          batch_profile: null,
          seller_settlement: await c.query(
            `SELECT * FROM siton.seller_settlements WHERE seller_settlement_id=$1`,
            [String(sellerSettlement.seller_settlement_id)]
          ).then((r: any) => r.rows[0])
        };
      }

      const batchCalculation = summarizeBatchFromSettlements([settlementCalculation]);
      const batchInsert = await c.query(
        `INSERT INTO siton.seller_payout_batches (
           seller_id,
           trigger_deal_id,
           payout_status,
           provider_code,
           correlation_id,
           idempotency_key,
           settlement_count,
           item_count,
           gross_collected,
           platform_fee_total,
           refunds_total,
           reserve_amount,
           seller_net_payable,
           payout_amount,
           paid_amount,
           failed_amount,
           returned_amount,
           blocked_amount,
           delayed_amount,
           blocker_reasons
         ) VALUES (
           $1,$2,'batched',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
         )
         RETURNING payout_batch_id`,
        [
          settlementCalculation.seller_id,
          settlementCalculation.deal_id,
          deps.payoutProvider.providerCode,
          correlationId,
          batchIdempotencyKey,
          batchCalculation.settlement_count,
          0,
          batchCalculation.gross_collected,
          batchCalculation.platform_fee_total,
          batchCalculation.refunds_total,
          batchCalculation.reserve_amount,
          batchCalculation.seller_net_payable,
          batchCalculation.payout_amount,
          batchCalculation.paid_amount,
          batchCalculation.failed_amount,
          batchCalculation.returned_amount,
          batchCalculation.blocked_amount,
          batchCalculation.delayed_amount,
          settlementCalculation.blocking_reasons
        ]
      );
      const payoutBatchId = String(batchInsert.rows[0].payout_batch_id);

      await replaceSettlementBatchLink(c, String(sellerSettlement.seller_settlement_id), payoutBatchId);
      await recordAttempt(c, {
        payout_batch_id: payoutBatchId,
        attempt_type: "prepare",
        result_class: "success",
        payout_status: "batched",
        correlation_id: correlationId,
        payload: {
          request_id: args.request_id,
          idempotency_key: settlementIdempotencyKey,
          blocking_reasons: settlementCalculation.blocking_reasons
        }
      });

      for (const participant of payableParticipants) {
        await c.query(
          `INSERT INTO siton.seller_payout_batch_items (
             payout_batch_id,
             seller_settlement_id,
             participant_id,
             deal_id,
             seller_id,
             payout_status,
             correlation_id,
             idempotency_key,
             gross_collected,
             platform_fee_total,
             refunds_total,
             reserve_amount,
             seller_net_payable,
             payout_amount,
             source_money_event_count,
             buyer_state_at_batch,
             money_state_at_batch
           ) VALUES (
             $1,$2,$3,$4,$5,'batched',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
           )`,
          [
            payoutBatchId,
            String(sellerSettlement.seller_settlement_id),
            String(participant.participant_id),
            args.deal_id,
            settlementCalculation.seller_id,
            correlationId,
            `seller-payout-item:${String(participant.participant_id)}`,
            roundMoney(Number(participant.gross_collected || 0)),
            roundMoney(Number(participant.platform_fee_total || 0)),
            roundMoney(Number(participant.refunds_total || 0)),
            0,
            roundMoney(Number(participant.seller_net_payable || 0)),
            roundMoney(Number(participant.seller_net_payable || 0)),
            Number(participant.source_money_event_count || 0),
            String(participant.buyer_state),
            String(participant.money_state)
          ]
        );
      }

      await c.query(
        `UPDATE siton.seller_payout_batches
         SET item_count=$2,
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [payoutBatchId, payableParticipants.length]
      );

      await insertOutboxEventIfMissing(c, {
        event_type: "seller_payout_dispatch",
        aggregate_type: "seller_payout_batch",
        aggregate_id: payoutBatchId,
        payload: {
          payout_batch_id: payoutBatchId,
          seller_settlement_id: String(sellerSettlement.seller_settlement_id),
          deal_id: args.deal_id,
          seller_id: settlementCalculation.seller_id
        }
      });

      return {
        status: "batched" as const,
        replay: false,
        batch_profile: await loadBatchSnapshot(c, payoutBatchId),
        seller_settlement: sellerSettlement
      };
    });
  }

  async function recordAttempt(c: any, args: {
    payout_batch_id: string;
    attempt_type: PayoutAttemptType;
    result_class: PayoutResultClass;
    payout_status: string | null;
    correlation_id: string;
    provider_reference?: string | null;
    payload?: Record<string, unknown>;
  }) {
    await c.query(
      `INSERT INTO siton.seller_payout_attempts (
         payout_batch_id, payout_item_id, attempt_type, result_class, payout_status, correlation_id, provider_reference, payload
       ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (payout_batch_id, payout_item_id, attempt_type, correlation_id) DO UPDATE
       SET result_class=EXCLUDED.result_class,
           payout_status=EXCLUDED.payout_status,
           provider_reference=EXCLUDED.provider_reference,
           payload=EXCLUDED.payload`,
      [
        args.payout_batch_id,
        args.attempt_type,
        args.result_class,
        args.payout_status,
        args.correlation_id,
        args.provider_reference ?? null,
        JSON.stringify(args.payload ?? {})
      ]
    );
  }

  function unknownProviderResult(error: unknown, correlationId: string): NormalizedPayoutResult {
    return {
      provider: deps.payoutProvider.providerCode,
      result_class: "unknown",
      retryable: true,
      payout_status: null,
      payout_reference: null,
      correlation_id: correlationId,
      external_transfer_executed: false,
      raw: { provider_call_error: String((error as any)?.message || error).slice(0, 500) }
    };
  }

  async function settlementIdForBatchInTx(c: any, payoutBatchId: string) {
    const row = await c.query(
      `SELECT seller_settlement_id FROM siton.seller_settlements WHERE payout_batch_id=$1 LIMIT 1`,
      [payoutBatchId]
    );
    return row.rowCount ? String(row.rows[0].seller_settlement_id) : null;
  }

  // F7: a provider answer that is neither success nor permanent_fail (or a
  // thrown/timed-out call) means the payout MAY exist at the provider. That is
  // recorded durably as UNKNOWN: the batch stays 'processing' (no CHECK value
  // for "dispatch_unknown" exists) and a blocking case is opened. Nothing may
  // call createPayout again for this batch; only a lookup or a human resolves it.
  async function openDispatchUnknownCaseInTx(c: any, batch: any, correlationId: string, result: NormalizedPayoutResult, source: "create_payout" | "get_payout_status") {
    await ensureOpenBlockingCase(c, {
      seller_settlement_id: await settlementIdForBatchInTx(c, String(batch.payout_batch_id)),
      payout_batch_id: String(batch.payout_batch_id),
      seller_id: String(batch.seller_id),
      deal_id: String(batch.trigger_deal_id),
      case_type: DISPATCH_UNKNOWN_CASE_TYPE,
      correlation_id: correlationId,
      expected_payout_amount: roundMoney(Number(batch.payout_amount || 0)),
      observed_payout_amount: 0,
      expected_item_count: Number(batch.item_count || 0),
      observed_item_count: 0,
      details: {
        source,
        result_class: result.result_class,
        provider_payout_status: result.payout_status ?? null,
        provider_reference: result.payout_reference ?? null,
        dispatch_correlation_id: correlationId,
        required_action: "provider_lookup_or_manual_resolution_before_any_redispatch"
      }
    });
  }

  async function dispatchBatch(args: { payout_batch_id: string; event_id: string }) {
    await ensurePayoutRailTables(deps.withTx);
    // Stable per batch (never per outbox event): the provider sees the same
    // idempotency key no matter how often the dispatch job is retried/re-enqueued.
    const correlationId = payoutDispatchCorrelationId(args.payout_batch_id);

    const phase1 = await deps.withTx(async (c) => {
      const batch = await lockBatchInTx(c, args.payout_batch_id);
      if (!batch) throw new Error("payout_batch_not_found");
      const status = String(batch.payout_status || "");
      if (status === "paid" || status === "reconciled") return { mode: "skip" as const };
      // A 'processing' batch already reached (or may have reached) the
      // provider. Never createPayout again: look the payout up instead.
      if (status === "processing") return { mode: "lookup" as const };
      if (!["batched", "ready"].includes(status)) {
        throw new deps.PermanentFailErrorCtor(`payout_batch_not_dispatchable:${status}`);
      }

      // Re-check freeze / seller hold / money truth under the deal lock,
      // immediately before the point of no return.
      const dealId = String(batch.trigger_deal_id);
      const fresh = await calculateSellerSettlementForDealInTx(c, dealId, {
        exclude_payout_batch_id: args.payout_batch_id
      });
      if (!fresh) throw new deps.PermanentFailErrorCtor(`payout_batch_settlement_missing:${args.payout_batch_id}`);
      const holdReasons = fresh.blocking_reasons.filter(
        (reason) => reason === "payout_freeze_admin_flag_active" || reason.startsWith("seller_settlement_status_")
      );
      if (holdReasons.length) {
        await c.query(
          `UPDATE siton.seller_payout_batches SET last_error=$2, updated_at=now() WHERE payout_batch_id=$1`,
          [args.payout_batch_id, `dispatch_held:${holdReasons.join(",")}`]
        );
        return { mode: "held" as const, reasons: holdReasons };
      }
      const batchPayoutAmount = roundMoney(Number(batch.payout_amount || 0));
      const batchRefundsTotal = roundMoney(Number(batch.refunds_total || 0));
      const driftReasons = uniqueStrings([
        ...fresh.blocking_reasons,
        roundMoney(fresh.seller_net_payable) !== batchPayoutAmount ? "seller_net_changed_since_batch" : "",
        roundMoney(fresh.refunds_total) > batchRefundsTotal ? "refunds_added_since_batch" : ""
      ]);
      if (driftReasons.length) {
        await ensureOpenBlockingCase(c, {
          seller_settlement_id: await settlementIdForBatchInTx(c, args.payout_batch_id),
          payout_batch_id: args.payout_batch_id,
          seller_id: String(batch.seller_id),
          deal_id: dealId,
          case_type: "settlement_changed_before_dispatch",
          correlation_id: correlationId,
          expected_payout_amount: batchPayoutAmount,
          observed_payout_amount: roundMoney(fresh.seller_net_payable),
          expected_item_count: Number(batch.item_count || 0),
          observed_item_count: Number(batch.item_count || 0),
          details: {
            reasons: driftReasons,
            batch_payout_amount: batchPayoutAmount,
            current_seller_net_payable: roundMoney(fresh.seller_net_payable),
            batch_refunds_total: batchRefundsTotal,
            current_refunds_total: roundMoney(fresh.refunds_total)
          }
        });
        await c.query(
          `UPDATE siton.seller_payout_batches SET last_error=$2, updated_at=now() WHERE payout_batch_id=$1`,
          [args.payout_batch_id, "dispatch_blocked_settlement_changed"]
        );
        return { mode: "blocked" as const, reasons: driftReasons };
      }

      await advanceBatchTreeInTx(c, args.payout_batch_id, "processing", {
        batch: { set: "correlation_id=$4", params: [correlationId] },
        item: { set: "correlation_id=$4", params: [correlationId] },
        settlement: { set: "correlation_id=$4", params: [correlationId] }
      });
      // Durable pre-call marker: if this process dies during the provider call,
      // the batch is 'processing' with an 'unknown' create attempt and every
      // later dispatch goes through lookup, never a second createPayout.
      await recordAttempt(c, {
        payout_batch_id: args.payout_batch_id,
        attempt_type: "create_payout",
        result_class: "unknown",
        payout_status: "processing",
        correlation_id: correlationId,
        payload: { event_id: args.event_id, phase: "pre_provider_call" }
      });
      const refreshed = await c.query(
        `SELECT * FROM siton.seller_payout_batches WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
      return { mode: "create" as const, batch: refreshed.rows[0] };
    });

    if (phase1.mode === "skip") return { status: "already_closed" as const };
    if (phase1.mode === "held") {
      throw new Error(`payout_dispatch_held:${phase1.reasons.join(",")} batch ${args.payout_batch_id}`);
    }
    if (phase1.mode === "blocked") {
      throw new deps.PermanentFailErrorCtor(
        `payout_dispatch_blocked_settlement_changed:${phase1.reasons.join(",")} batch ${args.payout_batch_id}`
      );
    }
    if (phase1.mode === "lookup") {
      const looked = await lookupBatchPayoutStatus({
        payout_batch_id: args.payout_batch_id,
        event_id: args.event_id,
        reason: "dispatch_on_processing_batch"
      });
      return { status: looked.status };
    }

    const batch = phase1.batch as any;
    let result: NormalizedPayoutResult;
    try {
      result = await deps.payoutProvider.createPayout({
        payout_batch_id: args.payout_batch_id,
        seller_id: String(batch.seller_id),
        payout_amount: roundMoney(Number(batch.payout_amount || 0)),
        item_count: Number(batch.item_count || 0),
        currency: String(batch.currency || "ILS"),
        correlation_id: correlationId,
        request_id: `worker:${args.event_id}`
      });
    } catch (error) {
      result = unknownProviderResult(error, correlationId);
    }

    const outcome = await deps.withTx(async (c) => {
      const current = await lockBatchInTx(c, args.payout_batch_id);
      if (!current) throw new Error("payout_batch_not_found");
      await recordAttempt(c, {
        payout_batch_id: args.payout_batch_id,
        attempt_type: "create_payout",
        result_class: result.result_class,
        payout_status: result.payout_status,
        correlation_id: correlationId,
        provider_reference: result.payout_reference ?? null,
        payload: { ...(result.raw ?? {}), event_id: args.event_id, phase: "provider_result" }
      });

      const acceptedStatus = String(result.payout_status ?? "processing");
      if (result.result_class === "success" && ["processing", "paid", "reconciled"].includes(acceptedStatus)) {
        await applyProviderAcceptedInTx(c, current, { ...result, payout_status: acceptedStatus as PayoutLifecycleStatus }, "create_payout");
        return "accepted" as const;
      }

      if (result.result_class === "permanent_fail") {
        await advanceBatchTreeInTx(c, args.payout_batch_id, "failed", {
          batch: { set: "last_error=$4", params: ["create_payout_permanent_fail"] },
          settlement: { set: "failed_amount=payout_amount" }
        });
        return "failed" as const;
      }

      await c.query(
        `UPDATE siton.seller_payout_batches SET last_error=$2, updated_at=now() WHERE payout_batch_id=$1`,
        [args.payout_batch_id, `create_payout_${result.result_class}_outcome_unknown`]
      );
      await openDispatchUnknownCaseInTx(c, current, correlationId, result, "create_payout");
      return "unknown" as const;
    });

    if (outcome === "unknown") {
      throw new Error(
        `create_payout_${result.result_class} batch ${args.payout_batch_id}: outcome unknown, provider lookup required before any re-dispatch`
      );
    }

    return { status: result.payout_status };
  }

  /**
   * Resolves a 'processing' batch by asking the provider (getPayoutStatus) under
   * the SAME dispatch correlation id. Never calls createPayout. An inconclusive
   * answer keeps the batch 'processing' with an open blocking case.
   */
  async function lookupBatchPayoutStatus(args: { payout_batch_id: string; event_id?: string | null; reason?: string }) {
    await ensurePayoutRailTables(deps.withTx);
    const correlationId = payoutDispatchCorrelationId(args.payout_batch_id);
    const head = await deps.withTx(async (c) => {
      const row = await c.query(
        `SELECT * FROM siton.seller_payout_batches WHERE payout_batch_id=$1 LIMIT 1`,
        [args.payout_batch_id]
      );
      return row.rows[0] ?? null;
    });
    if (!head) throw new Error("payout_batch_not_found");
    if (String(head.payout_status) !== "processing") {
      return { status: String(head.payout_status) as PayoutLifecycleStatus, lookup: "not_required" as const };
    }

    let result: NormalizedPayoutResult;
    try {
      result = await deps.payoutProvider.getPayoutStatus({
        payout_batch_id: args.payout_batch_id,
        seller_id: String(head.seller_id),
        payout_reference: head.provider_batch_reference ?? null,
        correlation_id: correlationId
      });
    } catch (error) {
      result = unknownProviderResult(error, correlationId);
    }

    const outcome = await deps.withTx(async (c) => {
      const current = await lockBatchInTx(c, args.payout_batch_id);
      if (!current) throw new Error("payout_batch_not_found");
      await recordAttempt(c, {
        payout_batch_id: args.payout_batch_id,
        attempt_type: "get_payout_status",
        result_class: result.result_class,
        payout_status: result.payout_status,
        correlation_id: correlationId,
        provider_reference: result.payout_reference ?? null,
        payload: { ...(result.raw ?? {}), event_id: args.event_id ?? null, reason: args.reason ?? null }
      });
      if (String(current.payout_status) !== "processing") return "superseded" as const;

      const status = String(result.payout_status || "");
      if (result.result_class === "success" && ["processing", "paid", "reconciled"].includes(status)) {
        await applyProviderAcceptedInTx(c, current, result, "get_payout_status");
        return "accepted" as const;
      }
      if (result.result_class === "success" && (status === "failed" || status === "returned")) {
        await advanceBatchTreeInTx(c, args.payout_batch_id, status as PayoutLifecycleStatus, {
          batch: { set: "last_error=$4", params: [`provider_lookup_${status}`] },
          settlement: { set: status === "failed" ? "failed_amount=payout_amount" : "returned_amount=payout_amount" }
        });
        await resolveDispatchUnknownCasesInTx(c, current, { resolved_by: "get_payout_status", provider_payout_status: status });
        return "failed" as const;
      }
      await c.query(
        `UPDATE siton.seller_payout_batches SET last_error=$2, updated_at=now() WHERE payout_batch_id=$1`,
        [args.payout_batch_id, "payout_lookup_inconclusive"]
      );
      await openDispatchUnknownCaseInTx(c, current, correlationId, result, "get_payout_status");
      return "inconclusive" as const;
    });

    if (outcome === "inconclusive") {
      throw new Error(
        `payout_dispatch_outcome_unknown batch ${args.payout_batch_id}: lookup ${result.result_class}, manual resolution required`
      );
    }
    return { status: result.payout_status, lookup: outcome };
  }

  async function reconcileBatch(args: { payout_batch_id: string; event_id: string }) {
    await ensurePayoutRailTables(deps.withTx);
    const correlationId = `seller-payout-reconcile:${args.payout_batch_id}:${args.event_id}`;

    const phaseA = await deps.withTx(async (c) => {
      const batch = await lockBatchInTx(c, args.payout_batch_id);
      if (!batch) throw new Error("payout_batch_not_found");
      const status = String(batch.payout_status || "");
      if (status === "reconciled") return { mode: "skip" as const };
      if (!["processing", "paid"].includes(status)) {
        throw new deps.PermanentFailErrorCtor(`payout_batch_not_reconcilable:${status}`);
      }
      const unknownOpen = await c.query(
        `SELECT 1 FROM siton.seller_payout_reconciliation_cases
         WHERE payout_batch_id=$1 AND case_type=$2 AND case_status='open' LIMIT 1`,
        [args.payout_batch_id, DISPATCH_UNKNOWN_CASE_TYPE]
      );
      if (unknownOpen.rowCount) {
        throw new deps.PermanentFailErrorCtor(`payout_reconcile_blocked_dispatch_outcome_unknown batch ${args.payout_batch_id}`);
      }
      const observed = await calculateSellerSettlementForDealInTx(c, String(batch.trigger_deal_id), {
        exclude_payout_batch_id: args.payout_batch_id
      });
      if (!observed) throw new Error("seller_settlement_missing_for_reconcile");
      return { mode: "reconcile" as const, batch, observed_amount: roundMoney(observed.seller_net_payable) };
    });
    if (phaseA.mode === "skip") return { status: "reconciled" as const };

    const snapshotBatch = phaseA.batch as any;
    let result: PayoutReconciliationResult;
    try {
      result = await deps.payoutProvider.reconcilePayout({
        payout_batch_id: args.payout_batch_id,
        seller_id: String(snapshotBatch.seller_id),
        expected_item_count: Number(snapshotBatch.item_count || 0),
        expected_payout_amount: roundMoney(Number(snapshotBatch.payout_amount || 0)),
        observed_item_count: Number(snapshotBatch.item_count || 0),
        observed_payout_amount: phaseA.observed_amount,
        payout_reference: snapshotBatch.provider_batch_reference ?? null,
        correlation_id: correlationId
      });
    } catch (error) {
      result = {
        ...unknownProviderResult(error, correlationId),
        reconciliation_outcome: "mismatched",
        observed_item_count: 0,
        observed_payout_amount: 0
      };
    }

    // Recompute and write in ONE transaction under the deal lock: whatever a
    // concurrent dispatch/lookup/refund committed while the provider call was
    // in flight is read here, never overwritten with a pre-call snapshot.
    const outcome = await deps.withTx(async (c) => {
      const batch = await lockBatchInTx(c, args.payout_batch_id);
      if (!batch) throw new Error("payout_batch_not_found");
      const dealId = String(batch.trigger_deal_id);
      const fresh = await calculateSellerSettlementForDealInTx(c, dealId, {
        exclude_payout_batch_id: args.payout_batch_id
      });
      if (!fresh) throw new Error("seller_settlement_missing_for_reconcile");
      const refreshedSettlement = await upsertSellerSettlement(c, fresh, correlationId);
      await recordAttempt(c, {
        payout_batch_id: args.payout_batch_id,
        attempt_type: "reconcile_payout",
        result_class: result.result_class,
        payout_status: result.payout_status,
        correlation_id: correlationId,
        provider_reference: result.payout_reference ?? null,
        payload: result.raw ?? {}
      });
      if (result.result_class !== "success") return "retry" as const;

      const status = String(batch.payout_status || "");
      if (status === "reconciled") return "already_reconciled" as const;
      if (!["processing", "paid"].includes(status)) return "superseded" as const;

      const expectedAmount = roundMoney(Number(batch.payout_amount || 0));
      const freshAmount = roundMoney(fresh.seller_net_payable);
      const matched =
        result.reconciliation_outcome === "matched"
        && freshAmount === expectedAmount
        && freshAmount === phaseA.observed_amount;

      if (matched) {
        await advanceBatchTreeInTx(c, args.payout_batch_id, "reconciled", {
          batch: {
            set: "reconciled_at=now(), last_error=NULL, external_transfer_executed=$4::boolean",
            params: [Boolean(result.external_transfer_executed)]
          },
          settlement: { set: "paid_amount=GREATEST(paid_amount, payout_amount)" }
        });
        await c.query(
          `UPDATE siton.seller_payout_reconciliation_cases
           SET case_status='resolved',
               resolved_at=now()
           WHERE payout_batch_id=$1
             AND case_status='open'
             AND case_type <> $2`,
          [args.payout_batch_id, DISPATCH_UNKNOWN_CASE_TYPE]
        );
        await refreshSettlementCaseFlagInTx(c, dealId);
        return "matched" as const;
      }

      // Mismatch. Forward-only: a 'processing' batch becomes 'failed'
      // (manual review); a 'paid' batch STAYS paid — money that left is never
      // rewritten as not-paid. Either way a blocking case carries the gap.
      await advanceBatchTreeInTx(c, args.payout_batch_id, "failed", {
        batch: { set: "reconciled_at=now()" }
      });
      await c.query(
        `UPDATE siton.seller_payout_batches
         SET last_error='payout_reconciliation_mismatch', updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
      await c.query(
        `UPDATE siton.seller_settlements
         SET has_open_mismatch=true,
             has_open_blocking_reconciliation_case=true,
             blocker_reasons=ARRAY['open_blocking_reconciliation_case','open_money_mismatch'],
             delayed_amount=GREATEST(seller_net_payable, 0),
             mismatch_amount=payout_amount - seller_net_payable,
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
      const refundsAdded = roundMoney(fresh.refunds_total) > roundMoney(Number(batch.refunds_total || 0));
      await ensureOpenBlockingCase(c, {
        seller_settlement_id: refreshedSettlement?.seller_settlement_id
          ? String(refreshedSettlement.seller_settlement_id)
          : await settlementIdForBatchInTx(c, args.payout_batch_id),
        payout_batch_id: args.payout_batch_id,
        seller_id: String(batch.seller_id),
        deal_id: dealId,
        case_type: refundsAdded ? "refund_after_payout_dispatch" : "amount_mismatch",
        correlation_id: correlationId,
        expected_payout_amount: expectedAmount,
        observed_payout_amount: freshAmount,
        expected_item_count: Number(batch.item_count || 0),
        observed_item_count: Number(result.observed_item_count || 0),
        details: {
          expected_payout_amount: expectedAmount,
          observed_payout_amount: freshAmount,
          provider_observed_payout_amount: phaseA.observed_amount,
          provider_reconciliation_outcome: result.reconciliation_outcome,
          batch_status_at_reconcile: status,
          batch_refunds_total: roundMoney(Number(batch.refunds_total || 0)),
          current_refunds_total: roundMoney(fresh.refunds_total)
        }
      });
      return "mismatched" as const;
    });

    if (outcome === "retry") {
      throw new Error(`reconcile_payout_${result.result_class} batch ${args.payout_batch_id}`);
    }
    return { status: result.payout_status };
  }

  async function getBatchProfile(payoutBatchId: string) {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => loadBatchSnapshot(c, payoutBatchId));
  }

  async function enqueuePrepareForDeal(dealId: string) {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => {
      const deal = await c.query(
        `SELECT deal_id, seller_id, state
         FROM siton.deals
         WHERE deal_id=$1
         LIMIT 1`,
        [dealId]
      );
      if (!deal.rowCount) return false;
      return insertOutboxEventIfMissing(c, {
        event_type: "seller_payout_prepare",
        aggregate_type: "deal",
        aggregate_id: dealId,
        payload: {
          deal_id: dealId,
          seller_id: String(deal.rows[0].seller_id || ""),
          deal_state: String(deal.rows[0].state || "")
        }
      });
    });
  }

  async function getDealPayoutSummary(dealId: string) {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => {
      const settlement = await c.query(
        `SELECT *
         FROM siton.seller_settlements
         WHERE deal_id=$1
         LIMIT 1`,
        [dealId]
      );
      const batches = await c.query(
        `SELECT payout_batch_id, seller_id, payout_status, settlement_count, item_count,
                payout_amount, external_transfer_executed, created_at, reconciled_at
         FROM siton.seller_payout_batches
         WHERE trigger_deal_id=$1
         ORDER BY created_at DESC`,
        [dealId]
      );
      const items = await c.query(
        `SELECT payout_item_id, payout_batch_id, participant_id, payout_status, payout_amount,
                external_transfer_executed, created_at
         FROM siton.seller_payout_batch_items
         WHERE deal_id=$1
         ORDER BY created_at DESC`,
        [dealId]
      );
      const cases = await c.query(
        `SELECT case_status, case_type, blocking_payout, expected_payout_amount, observed_payout_amount, created_at
         FROM siton.seller_payout_reconciliation_cases
         WHERE deal_id=$1
         ORDER BY created_at DESC`,
        [dealId]
      );
      return {
        settlement: settlement.rows[0] || null,
        batches: batches.rows,
        items: items.rows,
        reconciliation_cases: cases.rows
      };
    });
  }

  async function payoutStatusSummary() {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => {
      const settlements = await c.query(
        `SELECT
           COUNT(*) FILTER (WHERE payout_status='pending')::int AS pending,
           COUNT(*) FILTER (WHERE payout_status='ready')::int AS ready,
           COUNT(*) FILTER (WHERE payout_status='batched')::int AS batched,
           COUNT(*) FILTER (WHERE payout_status='processing')::int AS processing,
           COUNT(*) FILTER (WHERE payout_status='paid')::int AS paid,
           COUNT(*) FILTER (WHERE payout_status='failed')::int AS failed,
           COUNT(*) FILTER (WHERE payout_status='returned')::int AS returned,
           COUNT(*) FILTER (WHERE payout_status='reconciled')::int AS reconciled,
           COALESCE(SUM(payout_amount) FILTER (WHERE payout_status='ready'), 0) AS payout_amount_ready,
           COALESCE(SUM(blocked_amount), 0) AS blocked_amount,
           COALESCE(SUM(delayed_amount), 0) AS delayed_amount
         FROM siton.seller_settlements`
      );
      const batches = await c.query(
        `SELECT
           COUNT(*) FILTER (WHERE payout_status='pending')::int AS pending,
           COUNT(*) FILTER (WHERE payout_status='ready')::int AS ready,
           COUNT(*) FILTER (WHERE payout_status='batched')::int AS batched,
           COUNT(*) FILTER (WHERE payout_status='processing')::int AS processing,
           COUNT(*) FILTER (WHERE payout_status='paid')::int AS paid,
           COUNT(*) FILTER (WHERE payout_status='failed')::int AS failed,
           COUNT(*) FILTER (WHERE payout_status='returned')::int AS returned,
           COUNT(*) FILTER (WHERE payout_status='reconciled')::int AS reconciled,
           COALESCE(SUM(payout_amount) FILTER (
             WHERE payout_status IN ('batched','processing','paid','reconciled')
           ), 0) AS payout_amount_in_batches
         FROM siton.seller_payout_batches`
      );
      const cases = await c.query(
        `SELECT COUNT(*) FILTER (WHERE case_status='open')::int AS open_cases
         FROM siton.seller_payout_reconciliation_cases
         WHERE blocking_payout=true`
      );
      return {
        settlements: {
          pending: Number(settlements.rows[0]?.pending || 0),
          ready: Number(settlements.rows[0]?.ready || 0),
          batched: Number(settlements.rows[0]?.batched || 0),
          processing: Number(settlements.rows[0]?.processing || 0),
          paid: Number(settlements.rows[0]?.paid || 0),
          failed: Number(settlements.rows[0]?.failed || 0),
          returned: Number(settlements.rows[0]?.returned || 0),
          reconciled: Number(settlements.rows[0]?.reconciled || 0),
          payout_amount_ready: roundMoney(Number(settlements.rows[0]?.payout_amount_ready || 0)),
          blocked_amount: roundMoney(Number(settlements.rows[0]?.blocked_amount || 0)),
          delayed_amount: roundMoney(Number(settlements.rows[0]?.delayed_amount || 0))
        },
        batches: {
          pending: Number(batches.rows[0]?.pending || 0),
          ready: Number(batches.rows[0]?.ready || 0),
          batched: Number(batches.rows[0]?.batched || 0),
          processing: Number(batches.rows[0]?.processing || 0),
          paid: Number(batches.rows[0]?.paid || 0),
          failed: Number(batches.rows[0]?.failed || 0),
          returned: Number(batches.rows[0]?.returned || 0),
          reconciled: Number(batches.rows[0]?.reconciled || 0),
          payout_amount_in_batches: roundMoney(Number(batches.rows[0]?.payout_amount_in_batches || 0))
        },
        reconciliation_cases: {
          open_blocking_cases: Number(cases.rows[0]?.open_cases || 0)
        }
      };
    });
  }

  return {
    calculateSellerSettlementForDeal,
    calculateSellerPayoutBatchBySettlementIds,
    summarizeSellerReadiness,
    prepareBatchForDeal,
    dispatchBatch,
    lookupBatchPayoutStatus,
    reconcileBatch,
    getBatchProfile,
    enqueuePrepareForDeal,
    getDealPayoutSummary,
    payoutStatusSummary
  };
}
