type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

import type {
  PayoutDispatchResult,
  PayoutProvider,
  PayoutReconciliationResult
} from "./payout_provider.js";

export type PayoutBatchStatus =
  | "blocked"
  | "ready"
  | "dispatching"
  | "submitted_for_execution"
  | "reconciled_internal"
  | "manual_review"
  | "failed";

export type PayoutItemStatus =
  | "eligible"
  | "blocked"
  | "dispatching"
  | "submitted_for_execution"
  | "reconciled_internal"
  | "reversed"
  | "failed";

type EligibleItem = {
  participant_id: string;
  deal_id: string;
  seller_id: string;
  seller_settlement_status: string;
  buyer_state: string;
  money_state: string;
  gross_amount: number;
  vat_amount: number;
  fee_base_amount: number;
  platform_fee_base_amount: number;
  platform_fee_vat_amount: number;
  platform_fee_total_amount: number;
  seller_net_amount: number;
  source_money_event_count: number;
};

export async function ensurePayoutRailTables(withTx: WithTx) {
  await withTx(async (c) => {
    await c.query(`
      DO $$
      DECLARE
        v_def text;
      BEGIN
        SELECT pg_get_constraintdef(oid)
        INTO v_def
        FROM pg_constraint
        WHERE conrelid = 'siton.outbox_events'::regclass
          AND conname = 'outbox_events_aggregate_type_check';

        IF v_def IS NOT NULL AND position('seller_payout_batch' in v_def) = 0 THEN
          ALTER TABLE siton.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_aggregate_type_check;
          ALTER TABLE siton.outbox_events
            ADD CONSTRAINT outbox_events_aggregate_type_check
            CHECK (aggregate_type IN ('deal','participant','seller_payout_batch')) NOT VALID;
          ALTER TABLE siton.outbox_events VALIDATE CONSTRAINT outbox_events_aggregate_type_check;
        END IF;
      END $$`
    );

    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.seller_payout_batches (
        payout_batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
        trigger_deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
        payout_status TEXT NOT NULL
          CHECK (payout_status IN (
            'blocked',
            'ready',
            'dispatching',
            'submitted_for_execution',
            'reconciled_internal',
            'manual_review',
            'failed'
          )),
        provider_code TEXT NOT NULL,
        provider_batch_reference TEXT NULL,
        correlation_id TEXT NULL,
        idempotency_key TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'ILS',
        seller_settlement_status TEXT NOT NULL,
        item_count INT NOT NULL DEFAULT 0,
        gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        seller_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        eligibility_reason TEXT NOT NULL DEFAULT '',
        external_transfer_executed BOOLEAN NOT NULL DEFAULT FALSE,
        dispatched_at TIMESTAMPTZ NULL,
        reconciled_at TIMESTAMPTZ NULL,
        last_error TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (idempotency_key)
      )
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.seller_payout_batch_items (
        payout_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payout_batch_id UUID NOT NULL REFERENCES siton.seller_payout_batches(payout_batch_id) ON DELETE CASCADE,
        participant_id UUID NOT NULL REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
        deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
        seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
        payout_status TEXT NOT NULL
          CHECK (payout_status IN (
            'eligible',
            'blocked',
            'dispatching',
            'submitted_for_execution',
            'reconciled_internal',
            'reversed',
            'failed'
          )),
        correlation_id TEXT NULL,
        idempotency_key TEXT NOT NULL,
        source_money_event_count INT NOT NULL DEFAULT 0,
        buyer_state_at_batch TEXT NOT NULL,
        money_state_at_batch TEXT NOT NULL,
        gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        seller_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        provider_item_reference TEXT NULL,
        external_transfer_executed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (participant_id),
        UNIQUE (idempotency_key)
      )
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.seller_payout_attempts (
        payout_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payout_batch_id UUID NOT NULL REFERENCES siton.seller_payout_batches(payout_batch_id) ON DELETE CASCADE,
        payout_item_id UUID NULL REFERENCES siton.seller_payout_batch_items(payout_item_id) ON DELETE CASCADE,
        attempt_type TEXT NOT NULL
          CHECK (attempt_type IN ('prepare','dispatch','reconcile')),
        result_class TEXT NOT NULL
          CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')),
        correlation_id TEXT NOT NULL,
        provider_reference TEXT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (payout_batch_id, payout_item_id, attempt_type, correlation_id)
      )
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS siton.seller_payout_reconciliation (
        payout_reconciliation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payout_batch_id UUID NOT NULL REFERENCES siton.seller_payout_batches(payout_batch_id) ON DELETE CASCADE,
        provider_code TEXT NOT NULL,
        reconciliation_status TEXT NOT NULL
          CHECK (reconciliation_status IN ('matched','manual_review')),
        correlation_id TEXT NOT NULL,
        provider_batch_reference TEXT NULL,
        expected_item_count INT NOT NULL DEFAULT 0,
        observed_item_count INT NOT NULL DEFAULT 0,
        expected_seller_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        observed_seller_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        external_transfer_executed BOOLEAN NOT NULL DEFAULT FALSE,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (payout_batch_id, correlation_id)
      )
    `);

    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_seller_payout_batches_seller_created
      ON siton.seller_payout_batches (seller_id, created_at DESC)
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_seller_payout_batches_status_created
      ON siton.seller_payout_batches (payout_status, created_at DESC)
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_seller_payout_items_batch_created
      ON siton.seller_payout_batch_items (payout_batch_id, created_at DESC)
    `);
    await c.query(`
      CREATE INDEX IF NOT EXISTS idx_seller_payout_attempts_batch_created
      ON siton.seller_payout_attempts (payout_batch_id, created_at DESC)
    `);
  });
}

function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
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

async function loadEligibleItemsForDeal(c: any, dealId: string): Promise<EligibleItem[]> {
  const result = await c.query(
    `SELECT
       p.participant_id,
       p.deal_id,
       d.seller_id,
       sa.settlement_status AS seller_settlement_status,
       p.buyer_state,
       p.money_state,
       COUNT(m.money_event_id)::int AS source_money_event_count,
       COALESCE(SUM(m.gross_amount), 0) AS gross_amount,
       COALESCE(SUM(m.vat_amount), 0) AS vat_amount,
       COALESCE(SUM(m.fee_base_amount), 0) AS fee_base_amount,
       COALESCE(SUM(m.platform_fee_base_amount), 0) AS platform_fee_base_amount,
       COALESCE(SUM(m.platform_fee_vat_amount), 0) AS platform_fee_vat_amount,
       COALESCE(SUM(m.platform_fee_total_amount), 0) AS platform_fee_total_amount,
       COALESCE(SUM(m.seller_net_amount), 0) AS seller_net_amount
     FROM siton.participants p
     JOIN siton.deals d
       ON d.deal_id = p.deal_id
     JOIN siton.seller_accounts sa
       ON sa.seller_id = d.seller_id
     JOIN siton.platform_fee_money_events m
       ON m.participant_id = p.participant_id
     LEFT JOIN siton.seller_payout_batch_items spi
       ON spi.participant_id = p.participant_id
     WHERE p.deal_id = $1
       AND p.buyer_state = 'DealCompleted'
       AND p.money_state IN ('ChargedSuccess', 'RecoveredCharge')
       AND spi.participant_id IS NULL
     GROUP BY
       p.participant_id,
       p.deal_id,
       d.seller_id,
       sa.settlement_status,
       p.buyer_state,
       p.money_state
     HAVING COALESCE(SUM(m.seller_net_amount), 0) > 0
     ORDER BY p.participant_id`,
    [dealId]
  );

  return result.rows.map((row: any) => ({
    participant_id: String(row.participant_id),
    deal_id: String(row.deal_id),
    seller_id: String(row.seller_id),
    seller_settlement_status: String(row.seller_settlement_status || "active"),
    buyer_state: String(row.buyer_state),
    money_state: String(row.money_state),
    source_money_event_count: Number(row.source_money_event_count || 0),
    gross_amount: roundMoney(Number(row.gross_amount || 0)),
    vat_amount: roundMoney(Number(row.vat_amount || 0)),
    fee_base_amount: roundMoney(Number(row.fee_base_amount || 0)),
    platform_fee_base_amount: roundMoney(Number(row.platform_fee_base_amount || 0)),
    platform_fee_vat_amount: roundMoney(Number(row.platform_fee_vat_amount || 0)),
    platform_fee_total_amount: roundMoney(Number(row.platform_fee_total_amount || 0)),
    seller_net_amount: roundMoney(Number(row.seller_net_amount || 0))
  }));
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

  const items = await c.query(
    `SELECT *
     FROM siton.seller_payout_batch_items
     WHERE payout_batch_id=$1
     ORDER BY created_at ASC`,
    [payoutBatchId]
  );

  const attempts = await c.query(
    `SELECT attempt_type, result_class, correlation_id, provider_reference, payload, created_at
     FROM siton.seller_payout_attempts
     WHERE payout_batch_id=$1
     ORDER BY created_at DESC`,
    [payoutBatchId]
  );

  const reconciliation = await c.query(
    `SELECT provider_code, reconciliation_status, correlation_id, provider_batch_reference,
            expected_item_count, observed_item_count, expected_seller_net_amount,
            observed_seller_net_amount, external_transfer_executed, details, created_at
     FROM siton.seller_payout_reconciliation
     WHERE payout_batch_id=$1
     ORDER BY created_at DESC`,
    [payoutBatchId]
  );

  return {
    batch: batch.rows[0],
    items: items.rows,
    attempts: attempts.rows,
    reconciliation: reconciliation.rows
  };
}

export function buildPayoutRail(deps: {
  withTx: WithTx;
  payoutProvider: PayoutProvider;
  PermanentFailErrorCtor: new (...args: any[]) => Error;
}) {
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

      const eligible = await c.query(
        `SELECT
           COUNT(*)::int AS eligible_items,
           COALESCE(SUM(summary.seller_net_amount), 0) AS eligible_seller_net_amount
         FROM (
           SELECT p.participant_id, COALESCE(SUM(m.seller_net_amount), 0) AS seller_net_amount
           FROM siton.participants p
           JOIN siton.deals d ON d.deal_id = p.deal_id
           JOIN siton.platform_fee_money_events m ON m.participant_id = p.participant_id
           LEFT JOIN siton.seller_payout_batch_items spi ON spi.participant_id = p.participant_id
           WHERE d.seller_id=$1
             AND p.buyer_state='DealCompleted'
             AND p.money_state IN ('ChargedSuccess','RecoveredCharge')
             AND spi.participant_id IS NULL
           GROUP BY p.participant_id
           HAVING COALESCE(SUM(m.seller_net_amount), 0) > 0
         ) summary`,
        [sellerId]
      );

      const batches = await c.query(
        `SELECT payout_batch_id, trigger_deal_id, payout_status, item_count, seller_net_amount,
                external_transfer_executed, created_at, reconciled_at
         FROM siton.seller_payout_batches
         WHERE seller_id=$1
         ORDER BY created_at DESC
         LIMIT 20`,
        [sellerId]
      );

      return {
        seller: seller.rows[0],
        eligibility: {
          eligible_items: Number(eligible.rows[0]?.eligible_items || 0),
          eligible_seller_net_amount: roundMoney(Number(eligible.rows[0]?.eligible_seller_net_amount || 0)),
          seller_settlement_status: String(seller.rows[0].settlement_status || "active"),
          eligible_for_dispatch: String(seller.rows[0].settlement_status || "active") === "active"
        },
        recent_batches: batches.rows
      };
    });
  }

  async function prepareBatchForDeal(args: {
    deal_id: string;
    request_id: string;
    correlation_id?: string | null;
  }) {
    await ensurePayoutRailTables(deps.withTx);
    const idempotencyKey = `seller-payout-prepare:${args.deal_id}`;

    return deps.withTx(async (c) => {
      const existing = await c.query(
        `SELECT payout_batch_id
         FROM siton.seller_payout_batches
         WHERE idempotency_key=$1
         LIMIT 1`,
        [idempotencyKey]
      );
      if (existing.rowCount) {
        return {
          status: "duplicate_ignored" as const,
          replay: true,
          batch_profile: await loadBatchSnapshot(c, String(existing.rows[0].payout_batch_id))
        };
      }

      const eligibleItems = await loadEligibleItemsForDeal(c, args.deal_id);
      if (eligibleItems.length === 0) {
        return {
          status: "no_eligible_items" as const,
          replay: false,
          batch_profile: null
        };
      }

      const sellerId = eligibleItems[0]?.seller_id || "";
      const sellerSettlementStatus = eligibleItems[0]?.seller_settlement_status || "active";
      const totals = eligibleItems.reduce(
        (acc, item) => ({
          gross_amount: roundMoney(acc.gross_amount + item.gross_amount),
          vat_amount: roundMoney(acc.vat_amount + item.vat_amount),
          fee_base_amount: roundMoney(acc.fee_base_amount + item.fee_base_amount),
          platform_fee_base_amount: roundMoney(acc.platform_fee_base_amount + item.platform_fee_base_amount),
          platform_fee_vat_amount: roundMoney(acc.platform_fee_vat_amount + item.platform_fee_vat_amount),
          platform_fee_total_amount: roundMoney(acc.platform_fee_total_amount + item.platform_fee_total_amount),
          seller_net_amount: roundMoney(acc.seller_net_amount + item.seller_net_amount)
        }),
        {
          gross_amount: 0,
          vat_amount: 0,
          fee_base_amount: 0,
          platform_fee_base_amount: 0,
          platform_fee_vat_amount: 0,
          platform_fee_total_amount: 0,
          seller_net_amount: 0
        }
      );
      const batchStatus: PayoutBatchStatus =
        sellerSettlementStatus === "active" ? "ready" : "blocked";
      const eligibilityReason =
        batchStatus === "ready"
          ? "seller_active_and_settlement_positive"
          : `seller_settlement_status_${sellerSettlementStatus}`;

      const batchInsert = await c.query(
        `INSERT INTO siton.seller_payout_batches (
           seller_id,
           trigger_deal_id,
           payout_status,
           provider_code,
           correlation_id,
           idempotency_key,
           seller_settlement_status,
           item_count,
           gross_amount,
           vat_amount,
           fee_base_amount,
           platform_fee_base_amount,
           platform_fee_vat_amount,
           platform_fee_total_amount,
           seller_net_amount,
           eligibility_reason
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         )
         RETURNING payout_batch_id`,
        [
          sellerId,
          args.deal_id,
          batchStatus,
          deps.payoutProvider.providerCode,
          args.correlation_id ?? `payout-prepare:${args.deal_id}`,
          idempotencyKey,
          sellerSettlementStatus,
          eligibleItems.length,
          totals.gross_amount,
          totals.vat_amount,
          totals.fee_base_amount,
          totals.platform_fee_base_amount,
          totals.platform_fee_vat_amount,
          totals.platform_fee_total_amount,
          totals.seller_net_amount,
          eligibilityReason
        ]
      );
      const payoutBatchId = String(batchInsert.rows[0].payout_batch_id);

      for (const item of eligibleItems) {
        await c.query(
          `INSERT INTO siton.seller_payout_batch_items (
             payout_batch_id,
             participant_id,
             deal_id,
             seller_id,
             payout_status,
             correlation_id,
             idempotency_key,
             source_money_event_count,
             buyer_state_at_batch,
             money_state_at_batch,
             gross_amount,
             vat_amount,
             fee_base_amount,
             platform_fee_base_amount,
             platform_fee_vat_amount,
             platform_fee_total_amount,
             seller_net_amount
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
           )`,
          [
            payoutBatchId,
            item.participant_id,
            item.deal_id,
            item.seller_id,
            batchStatus === "ready" ? "eligible" : "blocked",
            args.correlation_id ?? `payout-prepare:${args.deal_id}:${item.participant_id}`,
            `seller-payout-item:${item.participant_id}`,
            item.source_money_event_count,
            item.buyer_state,
            item.money_state,
            item.gross_amount,
            item.vat_amount,
            item.fee_base_amount,
            item.platform_fee_base_amount,
            item.platform_fee_vat_amount,
            item.platform_fee_total_amount,
            item.seller_net_amount
          ]
        );
      }

      await c.query(
        `INSERT INTO siton.seller_payout_attempts (
           payout_batch_id, payout_item_id, attempt_type, result_class, correlation_id, payload
         ) VALUES ($1, NULL, 'prepare', 'success', $2, $3)`,
        [
          payoutBatchId,
          args.correlation_id ?? `payout-prepare:${args.deal_id}`,
          JSON.stringify({
            request_id: args.request_id,
            eligible_item_count: eligibleItems.length,
            seller_settlement_status: sellerSettlementStatus,
            eligibility_reason: eligibilityReason
          })
        ]
      );

      if (batchStatus === "ready") {
        await insertOutboxEventIfMissing(c, {
          event_type: "seller_payout_dispatch",
          aggregate_type: "seller_payout_batch",
          aggregate_id: payoutBatchId,
          payload: {
            payout_batch_id: payoutBatchId,
            trigger_deal_id: args.deal_id,
            seller_id: sellerId
          }
        });
      }

      return {
        status: batchStatus === "ready" ? "ready" as const : "blocked" as const,
        replay: false,
        batch_profile: await loadBatchSnapshot(c, payoutBatchId)
      };
    });
  }

  async function markBatchForDispatch(c: any, payoutBatchId: string, correlationId: string) {
    await c.query(
      `UPDATE siton.seller_payout_batches
       SET payout_status='dispatching',
           correlation_id=$2,
           updated_at=now()
       WHERE payout_batch_id=$1
         AND payout_status='ready'`,
      [payoutBatchId, correlationId]
    );
    await c.query(
      `UPDATE siton.seller_payout_batch_items
       SET payout_status='dispatching',
           correlation_id=$2,
           updated_at=now()
       WHERE payout_batch_id=$1
         AND payout_status='eligible'`,
      [payoutBatchId, correlationId]
    );
  }

  async function revertBatchToReady(c: any, payoutBatchId: string, errorMessage: string) {
    await c.query(
      `UPDATE siton.seller_payout_batches
       SET payout_status='ready',
           last_error=$2,
           updated_at=now()
       WHERE payout_batch_id=$1`,
      [payoutBatchId, errorMessage.slice(0, 500)]
    );
    await c.query(
      `UPDATE siton.seller_payout_batch_items
       SET payout_status='eligible',
           updated_at=now()
       WHERE payout_batch_id=$1
         AND payout_status='dispatching'`,
      [payoutBatchId]
    );
  }

  async function failBatch(c: any, payoutBatchId: string, errorMessage: string) {
    await c.query(
      `UPDATE siton.seller_payout_batches
       SET payout_status='failed',
           last_error=$2,
           updated_at=now()
       WHERE payout_batch_id=$1`,
      [payoutBatchId, errorMessage.slice(0, 500)]
    );
    await c.query(
      `UPDATE siton.seller_payout_batch_items
       SET payout_status='failed',
           updated_at=now()
       WHERE payout_batch_id=$1
         AND payout_status IN ('eligible','dispatching','submitted_for_execution')`,
      [payoutBatchId]
    );
  }

  async function dispatchBatch(args: { payout_batch_id: string; event_id: string }) {
    await ensurePayoutRailTables(deps.withTx);
    const correlationId = `seller-payout-dispatch:${args.payout_batch_id}:${args.event_id}`;

    const context = await deps.withTx(async (c) => {
      const snapshot = await loadBatchSnapshot(c, args.payout_batch_id);
      if (!snapshot) throw new Error("payout_batch_not_found");
      const batch = snapshot.batch as any;
      if (batch.payout_status === "reconciled_internal" || batch.payout_status === "manual_review") {
        return { snapshot, skip: true };
      }
      if (batch.payout_status === "blocked") {
        throw new Error("payout_batch_blocked");
      }
      await markBatchForDispatch(c, args.payout_batch_id, correlationId);
      await c.query(
        `INSERT INTO siton.seller_payout_attempts (
           payout_batch_id, payout_item_id, attempt_type, result_class, correlation_id, payload
         ) VALUES ($1, NULL, 'dispatch', 'unknown', $2, $3)
         ON CONFLICT (payout_batch_id, payout_item_id, attempt_type, correlation_id) DO NOTHING`,
        [
          args.payout_batch_id,
          correlationId,
          JSON.stringify({ event_id: args.event_id })
        ]
      );
      return { snapshot: await loadBatchSnapshot(c, args.payout_batch_id), skip: false };
    });

    if (context.skip) {
      return { status: "already_closed" as const };
    }

    const batch = context.snapshot?.batch as any;
    const result: PayoutDispatchResult = await deps.payoutProvider.dispatchBatch({
      payout_batch_id: args.payout_batch_id,
      seller_id: String(batch.seller_id),
      item_count: Number(batch.item_count || 0),
      seller_net_amount: roundMoney(Number(batch.seller_net_amount || 0)),
      currency: String(batch.currency || "ILS"),
      correlation_id: correlationId,
      request_id: `worker:${args.event_id}`
    });

    const resultMessage = `${result.result_class} payout dispatch batch ${args.payout_batch_id}`;
    await deps.withTx(async (c) => {
      await c.query(
        `UPDATE siton.seller_payout_attempts
         SET result_class=$1,
             provider_reference=$2,
             payload = payload || $3::jsonb
         WHERE payout_batch_id=$4
           AND payout_item_id IS NULL
           AND attempt_type='dispatch'
           AND correlation_id=$5`,
        [
          result.result_class,
          result.provider_batch_reference ?? null,
          JSON.stringify({
            provider: result.provider,
            external_transfer_executed: result.external_transfer_executed
          }),
          args.payout_batch_id,
          correlationId
        ]
      );

      if (result.result_class === "success") {
        await c.query(
          `UPDATE siton.seller_payout_batches
           SET payout_status='submitted_for_execution',
               provider_batch_reference=$2,
               correlation_id=$3,
               external_transfer_executed=$4,
               dispatched_at=now(),
               last_error=NULL,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [
            args.payout_batch_id,
            result.provider_batch_reference ?? null,
            result.correlation_id ?? correlationId,
            result.external_transfer_executed
          ]
        );
        await c.query(
          `UPDATE siton.seller_payout_batch_items
           SET payout_status='submitted_for_execution',
               correlation_id=$2,
               external_transfer_executed=$3,
               updated_at=now()
           WHERE payout_batch_id=$1
             AND payout_status IN ('eligible','dispatching')`,
          [
            args.payout_batch_id,
            result.correlation_id ?? correlationId,
            result.external_transfer_executed
          ]
        );
        await insertOutboxEventIfMissing(c, {
          event_type: "seller_payout_reconcile",
          aggregate_type: "seller_payout_batch",
          aggregate_id: args.payout_batch_id,
          payload: {
            payout_batch_id: args.payout_batch_id,
            provider_batch_reference: result.provider_batch_reference ?? null
          }
        });
        return;
      }

      if (result.result_class === "temporary_fail") {
        await revertBatchToReady(c, args.payout_batch_id, resultMessage);
        return;
      }

      await failBatch(c, args.payout_batch_id, resultMessage);
    });

    if (result.result_class === "temporary_fail") {
      throw new Error(resultMessage);
    }
    if (result.result_class === "permanent_fail") {
      throw new deps.PermanentFailErrorCtor(resultMessage);
    }

    return { status: "submitted_for_execution" as const };
  }

  async function reconcileBatch(args: { payout_batch_id: string; event_id: string }) {
    await ensurePayoutRailTables(deps.withTx);
    const correlationId = `seller-payout-reconcile:${args.payout_batch_id}:${args.event_id}`;

    const context = await deps.withTx(async (c) => {
      const snapshot = await loadBatchSnapshot(c, args.payout_batch_id);
      if (!snapshot) throw new Error("payout_batch_not_found");
      const batch = snapshot.batch as any;
      if (!["submitted_for_execution", "manual_review", "reconciled_internal"].includes(String(batch.payout_status))) {
        throw new Error(`payout_batch_not_reconcilable:${batch.payout_status}`);
      }

      await c.query(
        `INSERT INTO siton.seller_payout_attempts (
           payout_batch_id, payout_item_id, attempt_type, result_class, correlation_id, payload
         ) VALUES ($1, NULL, 'reconcile', 'unknown', $2, $3)
         ON CONFLICT (payout_batch_id, payout_item_id, attempt_type, correlation_id) DO NOTHING`,
        [
          args.payout_batch_id,
          correlationId,
          JSON.stringify({ event_id: args.event_id })
        ]
      );

      const observed = await c.query(
        `SELECT
           COUNT(*)::int AS observed_item_count,
           COALESCE(SUM(current_summary.seller_net_amount), 0) AS observed_seller_net_amount
         FROM (
           SELECT spi.participant_id, COALESCE(SUM(m.seller_net_amount), 0) AS seller_net_amount
           FROM siton.seller_payout_batch_items spi
           LEFT JOIN siton.platform_fee_money_events m
             ON m.participant_id = spi.participant_id
           WHERE spi.payout_batch_id=$1
           GROUP BY spi.participant_id
         ) current_summary`,
        [args.payout_batch_id]
      );

      return {
        snapshot,
        observed_item_count: Number(observed.rows[0]?.observed_item_count || 0),
        observed_seller_net_amount: roundMoney(Number(observed.rows[0]?.observed_seller_net_amount || 0))
      };
    });

    const batch = context.snapshot.batch as any;
    const result: PayoutReconciliationResult = await deps.payoutProvider.reconcileBatch({
      payout_batch_id: args.payout_batch_id,
      seller_id: String(batch.seller_id),
      expected_item_count: Number(batch.item_count || 0),
      expected_seller_net_amount: roundMoney(Number(batch.seller_net_amount || 0)),
      observed_item_count: context.observed_item_count,
      observed_seller_net_amount: context.observed_seller_net_amount,
      correlation_id: correlationId,
      provider_batch_reference: batch.provider_batch_reference ?? null
    });

    await deps.withTx(async (c) => {
      await c.query(
        `UPDATE siton.seller_payout_attempts
         SET result_class=$1,
             provider_reference=$2,
             payload = payload || $3::jsonb
         WHERE payout_batch_id=$4
           AND payout_item_id IS NULL
           AND attempt_type='reconcile'
           AND correlation_id=$5`,
        [
          result.result_class,
          result.provider_batch_reference ?? null,
          JSON.stringify({
            provider: result.provider,
            reconciliation_status: result.reconciliation_status,
            observed_item_count: result.observed_item_count,
            observed_seller_net_amount: result.observed_seller_net_amount,
            external_transfer_executed: result.external_transfer_executed
          }),
          args.payout_batch_id,
          correlationId
        ]
      );

      await c.query(
        `INSERT INTO siton.seller_payout_reconciliation (
           payout_batch_id,
           provider_code,
           reconciliation_status,
           correlation_id,
           provider_batch_reference,
           expected_item_count,
           observed_item_count,
           expected_seller_net_amount,
           observed_seller_net_amount,
           external_transfer_executed,
           details
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (payout_batch_id, correlation_id) DO NOTHING`,
        [
          args.payout_batch_id,
          result.provider,
          result.reconciliation_status,
          correlationId,
          result.provider_batch_reference ?? null,
          Number(batch.item_count || 0),
          result.observed_item_count,
          roundMoney(Number(batch.seller_net_amount || 0)),
          roundMoney(result.observed_seller_net_amount),
          result.external_transfer_executed,
          JSON.stringify({
            expected_item_count: Number(batch.item_count || 0),
            expected_seller_net_amount: roundMoney(Number(batch.seller_net_amount || 0))
          })
        ]
      );

      if (result.reconciliation_status === "matched") {
        await c.query(
          `UPDATE siton.seller_payout_batches
           SET payout_status='reconciled_internal',
               reconciled_at=now(),
               external_transfer_executed=$2,
               last_error=NULL,
               updated_at=now()
           WHERE payout_batch_id=$1`,
          [args.payout_batch_id, result.external_transfer_executed]
        );
        await c.query(
          `UPDATE siton.seller_payout_batch_items
           SET payout_status='reconciled_internal',
               external_transfer_executed=$2,
               updated_at=now()
           WHERE payout_batch_id=$1
             AND payout_status='submitted_for_execution'`,
          [args.payout_batch_id, result.external_transfer_executed]
        );
        return;
      }

      await c.query(
        `UPDATE siton.seller_payout_batches
         SET payout_status='manual_review',
             reconciled_at=now(),
             last_error='payout_reconciliation_manual_review',
             updated_at=now()
         WHERE payout_batch_id=$1`,
        [args.payout_batch_id]
      );
    });

    return {
      status: result.reconciliation_status
    };
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
      if (String(deal.rows[0].state) !== "Completed") return false;
      return insertOutboxEventIfMissing(c, {
        event_type: "seller_payout_prepare",
        aggregate_type: "deal",
        aggregate_id: dealId,
        payload: {
          deal_id: dealId,
          seller_id: String(deal.rows[0].seller_id || "")
        }
      });
    });
  }

  async function getDealPayoutSummary(dealId: string) {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => {
      const batches = await c.query(
        `SELECT payout_batch_id, seller_id, payout_status, item_count, seller_net_amount,
                external_transfer_executed, created_at, reconciled_at
         FROM siton.seller_payout_batches
         WHERE trigger_deal_id=$1
         ORDER BY created_at DESC`,
        [dealId]
      );
      const items = await c.query(
        `SELECT payout_item_id, payout_batch_id, participant_id, payout_status, seller_net_amount,
                external_transfer_executed, created_at
         FROM siton.seller_payout_batch_items
         WHERE deal_id=$1
         ORDER BY created_at DESC`,
        [dealId]
      );
      return {
        batches: batches.rows,
        items: items.rows
      };
    });
  }

  async function payoutStatusSummary() {
    await ensurePayoutRailTables(deps.withTx);
    return deps.withTx(async (c) => {
      const batches = await c.query(
        `SELECT
           COUNT(*) FILTER (WHERE payout_status='blocked')::int AS blocked,
           COUNT(*) FILTER (WHERE payout_status='ready')::int AS ready,
           COUNT(*) FILTER (WHERE payout_status='dispatching')::int AS dispatching,
           COUNT(*) FILTER (WHERE payout_status='submitted_for_execution')::int AS submitted_for_execution,
           COUNT(*) FILTER (WHERE payout_status='reconciled_internal')::int AS reconciled_internal,
           COUNT(*) FILTER (WHERE payout_status='manual_review')::int AS manual_review,
           COUNT(*) FILTER (WHERE payout_status='failed')::int AS failed,
           COALESCE(SUM(seller_net_amount) FILTER (
             WHERE payout_status IN ('ready','dispatching','submitted_for_execution','reconciled_internal','manual_review')
           ), 0) AS seller_net_amount_in_flight
         FROM siton.seller_payout_batches`
      );
      return {
        batches: {
          blocked: Number(batches.rows[0]?.blocked || 0),
          ready: Number(batches.rows[0]?.ready || 0),
          dispatching: Number(batches.rows[0]?.dispatching || 0),
          submitted_for_execution: Number(batches.rows[0]?.submitted_for_execution || 0),
          reconciled_internal: Number(batches.rows[0]?.reconciled_internal || 0),
          manual_review: Number(batches.rows[0]?.manual_review || 0),
          failed: Number(batches.rows[0]?.failed || 0),
          seller_net_amount_in_flight: roundMoney(Number(batches.rows[0]?.seller_net_amount_in_flight || 0))
        }
      };
    });
  }

  return {
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
