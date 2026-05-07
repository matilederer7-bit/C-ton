-- Migration 021: canonical seller payout rail.
-- Internal truth only for now: no external transfer executes yet.
-- Domain model:
--   - seller_settlements
--   - seller_payout_batches
--   - seller_payout_batch_items
--   - seller_payout_attempts
--   - seller_payout_reconciliation_cases

ALTER TABLE siton.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_aggregate_type_check;
ALTER TABLE siton.outbox_events
  ADD CONSTRAINT outbox_events_aggregate_type_check
  CHECK (aggregate_type IN ('deal','participant','seller_payout_batch','invoice_document'));

ALTER TABLE siton.outbox_events DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;
ALTER TABLE siton.outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN (
    'charge_deal',
    'recovery_deal',
    'finalize_deal',
    'refund_issue',
    'deadline_check',
    'cancel_refund',
    'seller_payout_prepare',
    'seller_payout_dispatch',
    'seller_payout_reconcile',
    'invoice_document_issue',
    'invoice_document_reconcile'
  ));

DROP TABLE IF EXISTS siton.seller_payout_reconciliation;

CREATE TABLE IF NOT EXISTS siton.seller_settlements (
  seller_settlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  payout_batch_id UUID NULL,
  payout_status TEXT NOT NULL
    CHECK (payout_status IN ('pending','ready','batched','processing','paid','failed','returned','reconciled')),
  calculation_version TEXT NOT NULL DEFAULT 'v1',
  gross_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  refunds_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserve_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_net_payable NUMERIC(12,2) NOT NULL DEFAULT 0,
  payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  failed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  returned_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  blocked_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  delayed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  mismatch_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  source_money_event_count INT NOT NULL DEFAULT 0,
  has_open_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  has_open_blocking_reconciliation_case BOOLEAN NOT NULL DEFAULT FALSE,
  final_truth_basis TEXT NOT NULL DEFAULT '',
  blocker_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  correlation_id TEXT NULL,
  idempotency_key TEXT NOT NULL,
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deal_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS siton.seller_payout_batches (
  payout_batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
  trigger_deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  payout_status TEXT NOT NULL
    CHECK (payout_status IN ('pending','ready','batched','processing','paid','failed','returned','reconciled')),
  provider_code TEXT NOT NULL,
  provider_batch_reference TEXT NULL,
  correlation_id TEXT NULL,
  idempotency_key TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ILS',
  settlement_count INT NOT NULL DEFAULT 0,
  item_count INT NOT NULL DEFAULT 0,
  gross_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  refunds_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserve_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_net_payable NUMERIC(12,2) NOT NULL DEFAULT 0,
  payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  failed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  returned_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  blocked_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  delayed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  blocker_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  external_transfer_executed BOOLEAN NOT NULL DEFAULT FALSE,
  created_payout_at TIMESTAMPTZ NULL,
  paid_at TIMESTAMPTZ NULL,
  reconciled_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS siton.seller_payout_batch_items (
  payout_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_batch_id UUID NOT NULL REFERENCES siton.seller_payout_batches(payout_batch_id) ON DELETE CASCADE,
  seller_settlement_id UUID NULL REFERENCES siton.seller_settlements(seller_settlement_id) ON DELETE SET NULL,
  participant_id UUID NOT NULL REFERENCES siton.participants(participant_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
  payout_status TEXT NOT NULL
    CHECK (payout_status IN ('pending','ready','batched','processing','paid','failed','returned','reconciled')),
  correlation_id TEXT NULL,
  idempotency_key TEXT NOT NULL,
  gross_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  refunds_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserve_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_net_payable NUMERIC(12,2) NOT NULL DEFAULT 0,
  payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  source_money_event_count INT NOT NULL DEFAULT 0,
  buyer_state_at_batch TEXT NOT NULL,
  money_state_at_batch TEXT NOT NULL,
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
    CHECK (attempt_type IN ('prepare','create_payout','get_payout_status','cancel_payout','reconcile_payout')),
  result_class TEXT NOT NULL
    CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')),
  payout_status TEXT NULL
    CHECK (payout_status IS NULL OR payout_status IN ('pending','ready','batched','processing','paid','failed','returned','reconciled')),
  correlation_id TEXT NOT NULL,
  provider_reference TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payout_batch_id, payout_item_id, attempt_type, correlation_id)
);

CREATE TABLE IF NOT EXISTS siton.seller_payout_reconciliation_cases (
  payout_reconciliation_case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_settlement_id UUID NULL REFERENCES siton.seller_settlements(seller_settlement_id) ON DELETE CASCADE,
  payout_batch_id UUID NULL REFERENCES siton.seller_payout_batches(payout_batch_id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  case_status TEXT NOT NULL CHECK (case_status IN ('open','resolved')),
  case_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  blocking_payout BOOLEAN NOT NULL DEFAULT TRUE,
  expected_payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  observed_payout_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  expected_item_count INT NOT NULL DEFAULT 0,
  observed_item_count INT NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_settlements_seller_created
  ON siton.seller_settlements (seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_settlements_status_created
  ON siton.seller_settlements (payout_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_batches_seller_created
  ON siton.seller_payout_batches (seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_batches_status_created
  ON siton.seller_payout_batches (payout_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_items_batch_created
  ON siton.seller_payout_batch_items (payout_batch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_attempts_batch_created
  ON siton.seller_payout_attempts (payout_batch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_seller_payout_reconciliation_cases_open
  ON siton.seller_payout_reconciliation_cases (seller_id, deal_id, created_at DESC);

ALTER TABLE siton.seller_payout_batches
  DROP COLUMN IF EXISTS seller_settlement_status,
  DROP COLUMN IF EXISTS gross_amount,
  DROP COLUMN IF EXISTS vat_amount,
  DROP COLUMN IF EXISTS fee_base_amount,
  DROP COLUMN IF EXISTS platform_fee_base_amount,
  DROP COLUMN IF EXISTS platform_fee_vat_amount,
  DROP COLUMN IF EXISTS platform_fee_total_amount,
  DROP COLUMN IF EXISTS seller_net_amount,
  DROP COLUMN IF EXISTS eligibility_reason,
  DROP COLUMN IF EXISTS dispatched_at;

ALTER TABLE siton.seller_payout_batch_items
  DROP COLUMN IF EXISTS gross_amount,
  DROP COLUMN IF EXISTS vat_amount,
  DROP COLUMN IF EXISTS fee_base_amount,
  DROP COLUMN IF EXISTS platform_fee_base_amount,
  DROP COLUMN IF EXISTS platform_fee_vat_amount,
  DROP COLUMN IF EXISTS platform_fee_total_amount,
  DROP COLUMN IF EXISTS seller_net_amount;
