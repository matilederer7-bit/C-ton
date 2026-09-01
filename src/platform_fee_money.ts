import { assertRequiredTables } from "./schema_contract.js";
type WithTx = <T>(fn: (c: any) => Promise<T>) => Promise<T>;

import { SITON_PLATFORM_FEE_VAT_RATE } from "./runtime_config.js";
import { computeCustomerChargeVat } from "./vat_authority.js";

export const SITON_PLATFORM_FEE_RATE = 0.08;

export type PlatformFeeFinancialEventType =
  | "charge_captured"
  | "recovery_captured"
  | "refund_issued";

export type PlatformFeeMoneySnapshot = {
  gross_amount: number;
  vat_amount: number;
  fee_base_amount: number;
  platform_fee_rate: number;
  platform_fee_vat_rate: number;
  platform_fee_base_amount: number;
  platform_fee_vat_amount: number;
  platform_fee_total_amount: number;
  platform_fee_amount: number;
  seller_net_amount: number;
};

export function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function calculatePlatformFeeMoney(args: {
  grossAmount: number;
  vatAmount?: number;
  sign?: 1 | -1;
}): PlatformFeeMoneySnapshot {
  const grossAmount = roundMoney(Number(args.grossAmount || 0));
  const vatAmount = roundMoney(Math.max(0, Number(args.vatAmount || 0)));
  const feeBaseAmount = roundMoney(Math.max(0, grossAmount - vatAmount));
  const platformFeeBaseAmount = roundMoney(feeBaseAmount * SITON_PLATFORM_FEE_RATE);
  const platformFeeVatAmount = roundMoney(platformFeeBaseAmount * SITON_PLATFORM_FEE_VAT_RATE);
  const platformFeeTotalAmount = roundMoney(platformFeeBaseAmount + platformFeeVatAmount);
  const sellerNetAmount = roundMoney(grossAmount - platformFeeTotalAmount);
  const sign = args.sign === -1 ? -1 : 1;

  return {
    gross_amount: roundMoney(grossAmount * sign),
    vat_amount: roundMoney(vatAmount * sign),
    fee_base_amount: roundMoney(feeBaseAmount * sign),
    platform_fee_rate: SITON_PLATFORM_FEE_RATE,
    platform_fee_vat_rate: SITON_PLATFORM_FEE_VAT_RATE,
    platform_fee_base_amount: roundMoney(platformFeeBaseAmount * sign),
    platform_fee_vat_amount: roundMoney(platformFeeVatAmount * sign),
    platform_fee_total_amount: roundMoney(platformFeeTotalAmount * sign),
    platform_fee_amount: roundMoney(platformFeeTotalAmount * sign),
    seller_net_amount: roundMoney(sellerNetAmount * sign)
  };
}

type ProviderMoneyEventInput = {
  participant_id: string;
  deal_id: string;
  event_type: PlatformFeeFinancialEventType;
  provider_code: string;
  provider_event_id: string | null;
  provider_reference: string | null;
  correlation_id: string | null;
  source_money_state: string;
};

type PlatformFeeSettlementSummary = PlatformFeeMoneySnapshot & {
  participant_id: string;
  deal_id: string;
  entries_count: number;
  charge_entries: number;
  refund_entries: number;
  payout_readiness_status:
    | "not_settlement_eligible"
    | "ready_for_settlement"
    | "refunded_not_payable";
};

export async function ensurePlatformFeeMoneyTables(withTx: WithTx) {
  await withTx(async c=>assertRequiredTables(c,["platform_fee_money_events"]));
}

async function loadParticipantChargeContext(c: any, participantId: string, dealId: string) {
  const result = await c.query(
    `SELECT p.participant_id,
            p.deal_id,
            p.qty,
            p.delivery_cost,
            d.price_per_unit,
            d.seller_id
     FROM siton.participants p
     JOIN siton.deals d ON d.deal_id = p.deal_id
     WHERE p.participant_id=$1
       AND p.deal_id=$2
     LIMIT 1`,
    [participantId, dealId]
  );

  if (!result.rowCount) {
    throw new Error(`platform_fee_money_target_not_found participant=${participantId} deal=${dealId}`);
  }

  const row = result.rows[0];
  const productGross = Number(row.qty || 0) * Number(row.price_per_unit || 0);
  const deliveryGross = Number(row.delivery_cost || 0);
  const grossAmount = productGross + deliveryGross;
  // Canonical VAT authority: explicit configuration decides the VAT portion of
  // the customer charge; synthetic_zero mode keeps synthetic staging at 0 by
  // declared policy. The 8% fee base always excludes this VAT amount.
  const vat = computeCustomerChargeVat({
    productGrossAmount: productGross,
    deliveryGrossAmount: deliveryGross
  });
  return {
    participant_id: String(row.participant_id),
    deal_id: String(row.deal_id),
    seller_id: String(row.seller_id || ""),
    gross_amount: roundMoney(grossAmount),
    vat_amount: vat.vat_amount
  };
}

async function logicalEntryExists(c: any, participantId: string, entryType: "charge" | "refund_adjustment") {
  const result = await c.query(
    `SELECT 1
     FROM siton.platform_fee_money_events
     WHERE participant_id=$1
       AND logical_entry_type=$2
     LIMIT 1`,
    [participantId, entryType]
  );
  return result.rowCount > 0;
}

async function insertPlatformFeeMoneyEntry(c: any, args: {
  participant_id: string;
  deal_id: string;
  seller_id: string;
  event_type: PlatformFeeFinancialEventType;
  logical_entry_type: "charge" | "refund_adjustment";
  provider_code: string;
  provider_event_id: string | null;
  provider_reference: string | null;
  correlation_id: string | null;
  source_money_state: string;
  settlement_status: "recorded" | "backfilled_from_refund";
  payout_readiness_status: "ready_for_settlement" | "reversed_after_refund";
  sign: 1 | -1;
  gross_amount: number;
  vat_amount: number;
}) {
  const amounts = calculatePlatformFeeMoney({
    grossAmount: args.gross_amount,
    vatAmount: args.vat_amount,
    sign: args.sign
  });

  const result = await c.query(
    `INSERT INTO siton.platform_fee_money_events (
       participant_id,
       deal_id,
       seller_id,
       event_type,
       logical_entry_type,
       provider_code,
       provider_event_id,
       provider_reference,
       correlation_id,
       source_money_state,
       settlement_status,
       payout_readiness_status,
       gross_amount,
       vat_amount,
       fee_base_amount,
       platform_fee_rate,
       platform_fee_vat_rate,
       platform_fee_base_amount,
       platform_fee_vat_amount,
       platform_fee_total_amount,
       platform_fee_amount,
       seller_net_amount
     )
     VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
       $13,$14,$15,$16,$17,$18,$19,$20,$21,$22
     )
     ON CONFLICT DO NOTHING`,
    [
      args.participant_id,
      args.deal_id,
      args.seller_id,
      args.event_type,
      args.logical_entry_type,
      args.provider_code,
      args.provider_event_id,
      args.provider_reference,
      args.correlation_id,
      args.source_money_state,
      args.settlement_status,
      args.payout_readiness_status,
      amounts.gross_amount,
      amounts.vat_amount,
      amounts.fee_base_amount,
      amounts.platform_fee_rate,
      amounts.platform_fee_vat_rate,
      amounts.platform_fee_base_amount,
      amounts.platform_fee_vat_amount,
      amounts.platform_fee_total_amount,
      amounts.platform_fee_amount,
      amounts.seller_net_amount
    ]
  );

  return { inserted: (result.rowCount || 0) > 0, amounts };
}

export function buildPlatformFeeMoney(deps: { withTx: WithTx }) {
  async function summarizeParticipantSettlementInTx(c: any, participantId: string): Promise<PlatformFeeSettlementSummary | null> {
    const result = await c.query(
      `SELECT participant_id,
              deal_id,
              COUNT(*) AS entries_count,
              COUNT(*) FILTER (WHERE logical_entry_type='charge') AS charge_entries,
              COUNT(*) FILTER (WHERE logical_entry_type='refund_adjustment') AS refund_entries,
              COALESCE(SUM(gross_amount), 0) AS gross_amount,
              COALESCE(SUM(vat_amount), 0) AS vat_amount,
              COALESCE(SUM(fee_base_amount), 0) AS fee_base_amount,
              COALESCE(SUM(platform_fee_base_amount), 0) AS platform_fee_base_amount,
              COALESCE(SUM(platform_fee_vat_amount), 0) AS platform_fee_vat_amount,
              COALESCE(SUM(platform_fee_total_amount), 0) AS platform_fee_total_amount,
              COALESCE(SUM(platform_fee_amount), 0) AS platform_fee_amount,
              COALESCE(SUM(seller_net_amount), 0) AS seller_net_amount
       FROM siton.platform_fee_money_events
       WHERE participant_id=$1
       GROUP BY participant_id, deal_id`,
      [participantId]
    );

    if (!result.rowCount) return null;

    const row = result.rows[0];
    const refundEntries = Number(row.refund_entries || 0);
    const gross = Number(row.gross_amount || 0);
    const payout_readiness_status =
      refundEntries > 0 || gross <= 0
        ? "refunded_not_payable"
        : "ready_for_settlement";

    return {
      participant_id: String(row.participant_id),
      deal_id: String(row.deal_id),
      entries_count: Number(row.entries_count || 0),
      charge_entries: Number(row.charge_entries || 0),
      refund_entries: refundEntries,
      gross_amount: roundMoney(gross),
      vat_amount: roundMoney(Number(row.vat_amount || 0)),
      fee_base_amount: roundMoney(Number(row.fee_base_amount || 0)),
      platform_fee_rate: SITON_PLATFORM_FEE_RATE,
      platform_fee_vat_rate: SITON_PLATFORM_FEE_VAT_RATE,
      platform_fee_base_amount: roundMoney(Number(row.platform_fee_base_amount || 0)),
      platform_fee_vat_amount: roundMoney(Number(row.platform_fee_vat_amount || 0)),
      platform_fee_total_amount: roundMoney(Number(row.platform_fee_total_amount || 0)),
      platform_fee_amount: roundMoney(Number(row.platform_fee_amount || 0)),
      seller_net_amount: roundMoney(Number(row.seller_net_amount || 0)),
      payout_readiness_status
    };
  }

  async function summarizeParticipantSettlement(participantId: string): Promise<PlatformFeeSettlementSummary | null> {
    return deps.withTx(async (c) => summarizeParticipantSettlementInTx(c, participantId));
  }

  async function recordProviderFinancialEvent(args: ProviderMoneyEventInput) {
    await ensurePlatformFeeMoneyTables(deps.withTx);

    return deps.withTx(async (c) => {
      const context = await loadParticipantChargeContext(c, args.participant_id, args.deal_id);

      if (args.event_type === "refund_issued" && !(await logicalEntryExists(c, args.participant_id, "charge"))) {
        await insertPlatformFeeMoneyEntry(c, {
          participant_id: context.participant_id,
          deal_id: context.deal_id,
          seller_id: context.seller_id,
          event_type:
            args.source_money_state === "RecoveredCharge" ? "recovery_captured" : "charge_captured",
          logical_entry_type: "charge",
          provider_code: args.provider_code,
          provider_event_id: null,
          provider_reference: args.provider_reference,
          correlation_id: args.correlation_id,
          source_money_state: args.source_money_state,
          settlement_status: "backfilled_from_refund",
          payout_readiness_status: "ready_for_settlement",
          sign: 1,
          gross_amount: context.gross_amount,
          vat_amount: context.vat_amount
        });
      }

      const logicalEntryType = args.event_type === "refund_issued" ? "refund_adjustment" : "charge";
      const entry = await insertPlatformFeeMoneyEntry(c, {
        participant_id: context.participant_id,
        deal_id: context.deal_id,
        seller_id: context.seller_id,
        event_type: args.event_type,
        logical_entry_type: logicalEntryType,
        provider_code: args.provider_code,
        provider_event_id: args.provider_event_id,
        provider_reference: args.provider_reference,
        correlation_id: args.correlation_id,
        source_money_state: args.source_money_state,
        settlement_status: "recorded",
        payout_readiness_status:
          logicalEntryType === "charge" ? "ready_for_settlement" : "reversed_after_refund",
        sign: logicalEntryType === "charge" ? 1 : -1,
        gross_amount: context.gross_amount,
        vat_amount: context.vat_amount
      });

      return {
        status: entry.inserted ? "recorded" as const : "duplicate_ignored" as const,
        snapshot: await summarizeParticipantSettlementInTx(c, args.participant_id),
        amounts: entry.amounts
      };
    });
  }

  return {
    summarizeParticipantSettlement,
    recordProviderFinancialEvent
  };
}
