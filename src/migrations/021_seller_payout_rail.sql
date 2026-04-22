-- Migration 021: canonical seller payout rail (internal truth only, provider-agnostic).
-- No external transfer is executed in this migration. The tables below capture:
--   - seller payout eligibility snapshots
--   - payout batches and payout items
--   - payout dispatch/reconcile attempts
--   - reconciliation truth for future adapter wiring

ALTER TABLE siton.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_aggregate_type_check;
ALTER TABLE siton.outbox_events
  ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('deal','participant','seller_payout_batch'));

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
);

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
);

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
);

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
);

CREATE INDEX IF NOT EXISTS idx_seller_payout_batches_seller_created
  ON siton.seller_payout_batches (seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_batches_status_created
  ON siton.seller_payout_batches (payout_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_items_batch_created
  ON siton.seller_payout_batch_items (payout_batch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_attempts_batch_created
  ON siton.seller_payout_attempts (payout_batch_id, created_at DESC);
