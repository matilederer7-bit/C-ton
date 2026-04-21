-- Migration 019: canonical platform-fee money truth for Siton's 8% platform fee.
-- One signed row per participant-level financial event:
--   charge_captured / recovery_captured  -> positive amounts
--   refund_issued                        -> negative reversal amounts
-- This table is the provider-ready settlement anchor for:
--   gross_amount, vat_amount, fee_base_amount,
--   platform_fee_base_amount, platform_fee_vat_amount, platform_fee_total_amount,
--   seller_net_amount
-- with duplicate guards for charge and refund processing.

CREATE TABLE IF NOT EXISTS siton.platform_fee_money_events (
  money_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('charge_captured','recovery_captured','refund_issued')),
  logical_entry_type TEXT NOT NULL
    CHECK (logical_entry_type IN ('charge','refund_adjustment')),
  provider_code TEXT NOT NULL,
  provider_event_id TEXT NULL,
  provider_reference TEXT NULL,
  correlation_id TEXT NULL,
  source_money_state TEXT NOT NULL,
  settlement_status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (settlement_status IN ('recorded','backfilled_from_refund')),
  payout_readiness_status TEXT NOT NULL
    CHECK (payout_readiness_status IN ('ready_for_settlement','reversed_after_refund')),
  gross_amount NUMERIC(12,2) NOT NULL,
  vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  fee_base_amount NUMERIC(12,2) NOT NULL,
  platform_fee_rate NUMERIC(6,4) NOT NULL DEFAULT 0.08,
  platform_fee_vat_rate NUMERIC(6,4) NOT NULL DEFAULT 0.18,
  platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_amount NUMERIC(12,2) NOT NULL,
  seller_net_amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_platform_fee_money_charge_once
  ON siton.platform_fee_money_events (participant_id)
  WHERE logical_entry_type = 'charge';

CREATE UNIQUE INDEX IF NOT EXISTS ux_platform_fee_money_refund_once
  ON siton.platform_fee_money_events (participant_id)
  WHERE logical_entry_type = 'refund_adjustment';

CREATE UNIQUE INDEX IF NOT EXISTS ux_platform_fee_money_provider_event
  ON siton.platform_fee_money_events (provider_code, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_platform_fee_money_deal_created
  ON siton.platform_fee_money_events (deal_id, created_at DESC);
