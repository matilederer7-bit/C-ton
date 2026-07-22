import { assertRequiredTables } from "./schema_contract.js";
type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

import type {
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

type SettlementCalculation = {
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

async function upsertSellerSettlement(c: any, settlement: SettlementCalculation, correlationId: string) {
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
     SET payout_status=EXCLUDED.payout_status,
         gross_collected=EXCLUDED.gross_collected,
         platform_fee_total=EXCLUDED.platform_fee_total,
         refunds_total=EXCLUDED.refunds_total,
         reserve_amount=EXCLUDED.reserve_amount,
         seller_net_payable=EXCLUDED.seller_net_payable,
         payout_amount=EXCLUDED.payout_amount,
         paid_amount=EXCLUDED.paid_amount,
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
      idempotencyKey
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
     WHERE seller_settlement_id=$1`,
    [sellerSettlementId, payoutBatchId]
  );
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
      const settlementCalculation = await calculateSellerSettlementForDealInTx(c, args.deal_id);
      if (!settlementCalculation) {
        return { status: "deal_not_found" as const, replay: false, batch_profile: null };
      }

      const sellerSettlement = await upsertSellerSettlement(c, settlementCalculation, correlationId);

      if (settlementCalculation.payout_status !== "ready") {
        return {
          status: settlementCalculation.payout_status,
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

      const participants = await c.query(
        `SELECT p.participant_id, p.buyer_state, p.money_state,
                COALESCE(SUM(CASE WHEN m.gross_amount > 0 THEN m.gross_amount ELSE 0 END), 0) AS gross_collected,
                COALESCE(SUM(m.platform_fee_total_amount), 0) AS platform_fee_total,
                COALESCE(SUM(CASE WHEN m.gross_amount < 0 THEN ABS(m.gross_amount) ELSE 0 END), 0) AS refunds_total,
                COALESCE(SUM(m.seller_net_amount), 0) AS seller_net_payable,
                COUNT(m.money_event_id)::int AS source_money_event_count
         FROM siton.participants p
         JOIN siton.platform_fee_money_events m ON m.participant_id = p.participant_id
         WHERE p.deal_id=$1
         GROUP BY p.participant_id, p.buyer_state, p.money_state
         HAVING COALESCE(SUM(m.seller_net_amount), 0) > 0`,
        [args.deal_id]
      );

      for (const participant of participants.rows) {
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
        [payoutBatchId, participants.rowCount ?? 0]
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

  async function dispatchBatch(args: { payout_batch_id: string; event_id: string }) {
    await ensurePayoutRailTables(deps.withTx);
    const correlationId = `seller-payout-create:${args.payout_batch_id}:${args.event_id}`;

    const batchSnapshot = await deps.withTx(async (c) => {
      const snapshot = await loadBatchSnapshot(c, args.payout_batch_id);
      if (!snapshot) throw new Error("payout_batch_not_found");
      const status = String(snapshot.batch.payout_status || "");
      if (!["batched", "processing", "ready"].includes(status)) {
        if (["paid", "reconciled"].includes(status)) {
          return { snapshot, skip: true };
        }
        throw new Error(`payout_batch_not_dispatchable:${status}`);
      }
      await c.query(
        `UPDATE siton.seller_payout_batches
         SET payout_status='processing',
             correlation_id=$2,
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id, correlationId]
      );
      await c.query(
        `UPDATE siton.seller_payout_batch_items
         SET payout_status='processing',
             correlation_id=$2,
             updated_at=now()
         WHERE payout_batch_id=$1
           AND payout_status IN ('batched','ready')`,
        [args.payout_batch_id, correlationId]
      );
      await c.query(
        `UPDATE siton.seller_settlements
         SET payout_status='processing',
             correlation_id=$2,
             updated_at=now()
         WHERE payout_batch_id=$1
           AND payout_status IN ('batched','ready')`,
        [args.payout_batch_id, correlationId]
      );
      await recordAttempt(c, {
        payout_batch_id: args.payout_batch_id,
        attempt_type: "create_payout",
        result_class: "unknown",
        payout_status: "processing",
        correlation_id: correlationId,
        payload: { event_id: args.event_id }
      });
      return { snapshot: await loadBatchSnapshot(c, args.payout_batch_id), skip: false };
    });

    if (batchSnapshot.skip) return { status: "already_closed" as const };

    const batch = batchSnapshot.snapshot?.batch as any;
    const result = await deps.payoutProvider.createPayout({
      payout_batch_id: args.payout_batch_id,
      seller_id: String(batch.seller_id),
      payout_amount: roundMoney(Number(batch.payout_amount || 0)),
      item_count: Number(batch.item_count || 0),
      currency: String(batch.currency || "ILS"),
      correlation_id: correlationId,
      request_id: `worker:${args.event_id}`
    });

    await deps.withTx(async (c) => {
      await recordAttempt(c, {
        payout_batch_id: args.payout_batch_id,
        attempt_type: "create_payout",
        result_class: result.result_class,
        payout_status: result.payout_status,
        correlation_id: correlationId,
        provider_reference: result.payout_reference ?? null,
        payload: result.raw ?? {}
      });

      if (result.result_class === "success") {
        await c.query(
          `UPDATE siton.seller_payout_batches
           SET payout_status=$2,
               provider_batch_reference=$3,
               external_transfer_executed=$4,
               created_payout_at=now(),
               last_error=NULL,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [
            args.payout_batch_id,
            result.payout_status ?? "processing",
            result.payout_reference ?? null,
            result.external_transfer_executed
          ]
        );
        await c.query(
          `UPDATE siton.seller_payout_batch_items
           SET payout_status=$2,
               provider_item_reference=$3,
               external_transfer_executed=$4,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [
            args.payout_batch_id,
            result.payout_status ?? "processing",
            result.payout_reference ?? null,
            result.external_transfer_executed
          ]
        );
        await c.query(
          `UPDATE siton.seller_settlements
           SET payout_status=$2,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [args.payout_batch_id, result.payout_status ?? "processing"]
        );
        await insertOutboxEventIfMissing(c, {
          event_type: "seller_payout_reconcile",
          aggregate_type: "seller_payout_batch",
          aggregate_id: args.payout_batch_id,
          payload: {
            payout_batch_id: args.payout_batch_id,
            payout_reference: result.payout_reference ?? null
          }
        });
        return;
      }

      if (result.result_class === "permanent_fail") {
        await c.query(
          `UPDATE siton.seller_payout_batches
           SET payout_status='failed',
               last_error=$2,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [args.payout_batch_id, "create_payout_permanent_fail"]
        );
        await c.query(
          `UPDATE siton.seller_payout_batch_items
           SET payout_status='failed',
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [args.payout_batch_id]
        );
        await c.query(
          `UPDATE siton.seller_settlements
           SET payout_status='failed',
               failed_amount=payout_amount,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [args.payout_batch_id]
        );
        return;
      }

      await c.query(
        `UPDATE siton.seller_payout_batches
         SET payout_status='batched',
             last_error=$2,
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id, `create_payout_${result.result_class}`]
      );
      await c.query(
        `UPDATE siton.seller_payout_batch_items
         SET payout_status='batched',
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
      await c.query(
        `UPDATE siton.seller_settlements
         SET payout_status='batched',
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
    });

    if (result.result_class === "temporary_fail" || result.result_class === "unknown") {
      throw new Error(`create_payout_${result.result_class} batch ${args.payout_batch_id}`);
    }

    return { status: result.payout_status };
  }

  async function reconcileBatch(args: { payout_batch_id: string; event_id: string }) {
    await ensurePayoutRailTables(deps.withTx);
    const correlationId = `seller-payout-reconcile:${args.payout_batch_id}:${args.event_id}`;

    const snapshot = await deps.withTx(async (c) => {
      const current = await loadBatchSnapshot(c, args.payout_batch_id);
      if (!current) throw new Error("payout_batch_not_found");
      return current;
    });
    const batch = snapshot.batch as any;
    const settlement = snapshot.settlements[0] as any;

    const latestSettlement = await calculateSellerSettlementForDeal(String(batch.trigger_deal_id), {
      exclude_payout_batch_id: args.payout_batch_id
    });
    if (!latestSettlement) {
      throw new Error("seller_settlement_missing_for_reconcile");
    }

    const result: PayoutReconciliationResult = await deps.payoutProvider.reconcilePayout({
      payout_batch_id: args.payout_batch_id,
      seller_id: String(batch.seller_id),
      expected_item_count: Number(batch.item_count || 0),
      expected_payout_amount: roundMoney(Number(batch.payout_amount || 0)),
      observed_item_count: Number(batch.item_count || 0),
      observed_payout_amount: roundMoney(Number(latestSettlement.payout_amount || 0)),
      payout_reference: batch.provider_batch_reference ?? null,
      correlation_id: correlationId
    });

    await deps.withTx(async (c) => {
      const refreshedSettlement = await upsertSellerSettlement(c, latestSettlement, correlationId);
      await recordAttempt(c, {
        payout_batch_id: args.payout_batch_id,
        attempt_type: "reconcile_payout",
        result_class: result.result_class,
        payout_status: result.payout_status,
        correlation_id: correlationId,
        provider_reference: result.payout_reference ?? null,
        payload: result.raw ?? {}
      });

      if (result.reconciliation_outcome === "matched") {
        await c.query(
          `UPDATE siton.seller_payout_batches
           SET payout_status='reconciled',
               reconciled_at=now(),
               last_error=NULL,
               external_transfer_executed=$2,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [args.payout_batch_id, result.external_transfer_executed]
        );
        await c.query(
          `UPDATE siton.seller_payout_batch_items
           SET payout_status='reconciled',
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [args.payout_batch_id]
        );
        await c.query(
          `UPDATE siton.seller_settlements
           SET payout_status='reconciled',
               paid_amount=payout_amount,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [args.payout_batch_id]
        );
        await c.query(
          `UPDATE siton.seller_payout_reconciliation_cases
           SET case_status='resolved',
               resolved_at=now()
           WHERE payout_batch_id=$1
             AND case_status='open'`,
          [args.payout_batch_id]
        );
        return;
      }

      await c.query(
        `UPDATE siton.seller_payout_batches
         SET payout_status='failed',
             last_error='payout_reconciliation_mismatch',
             reconciled_at=now(),
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
      await c.query(
        `UPDATE siton.seller_payout_batch_items
         SET payout_status='failed',
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
      await c.query(
        `UPDATE siton.seller_settlements
         SET payout_status='pending',
             has_open_mismatch=true,
             has_open_blocking_reconciliation_case=true,
             blocker_reasons = ARRAY['open_blocking_reconciliation_case','open_money_mismatch'],
             delayed_amount=seller_net_payable,
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
      await createBlockingReconciliationCase(c, {
        seller_settlement_id: refreshedSettlement?.seller_settlement_id
          ? String(refreshedSettlement.seller_settlement_id)
          : settlement?.seller_settlement_id
            ? String(settlement.seller_settlement_id)
            : null,
        payout_batch_id: args.payout_batch_id,
        seller_id: String(batch.seller_id),
        deal_id: String(batch.trigger_deal_id),
        case_type: "amount_mismatch",
        correlation_id: correlationId,
        expected_payout_amount: roundMoney(Number(batch.payout_amount || 0)),
        observed_payout_amount: roundMoney(Number(latestSettlement.payout_amount || 0)),
        expected_item_count: Number(batch.item_count || 0),
        observed_item_count: Number(result.observed_item_count || 0),
        details: {
          expected_payout_amount: Number(batch.payout_amount || 0),
          observed_payout_amount: Number(latestSettlement.payout_amount || 0)
        }
      });
    });

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
    reconcileBatch,
    getBatchProfile,
    enqueuePrepareForDeal,
    getDealPayoutSummary,
    payoutStatusSummary
  };
}
