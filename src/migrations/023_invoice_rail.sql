-- Migration 023: canonical internal invoice rail.
-- Internal truth only for now: no external invoice/accounting provider executes yet.

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

ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS document_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS seller_id TEXT NULL;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS seller_settlement_id UUID NULL;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS payout_batch_id UUID NULL;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_money_event_id UUID NULL;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_base_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_vat_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS platform_fee_total_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS document_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS result_class TEXT NULL;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS external_document_issued BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ NULL;
ALTER TABLE siton.invoice_documents ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE siton.invoice_documents
SET document_status=status
WHERE document_status IS NULL OR document_status='';

UPDATE siton.invoice_documents
SET idempotency_key=document_key
WHERE idempotency_key IS NULL;

UPDATE siton.invoice_documents
SET platform_fee_total_amount=siton_fee_amount
WHERE platform_fee_total_amount=0 AND siton_fee_amount <> 0;

UPDATE siton.invoice_documents
SET document_amount=gross_amount,
    taxable_amount=gross_amount
WHERE gross_amount <> 0
  AND (document_amount=0 OR taxable_amount=0);

ALTER TABLE siton.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_document_type_check;
ALTER TABLE siton.invoice_documents
  ADD CONSTRAINT invoice_documents_document_type_check
  CHECK (document_type IN ('charge_receipt','refund_receipt','seller_settlement_invoice','platform_fee_invoice','credit_note'));

ALTER TABLE siton.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_status_check;
ALTER TABLE siton.invoice_documents
  ADD CONSTRAINT invoice_documents_status_check
  CHECK (status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped'));

ALTER TABLE siton.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_document_status_check;
ALTER TABLE siton.invoice_documents
  ADD CONSTRAINT invoice_documents_document_status_check
  CHECK (document_status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped'));

CREATE TABLE IF NOT EXISTS siton.invoice_document_attempts (
  invoice_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES siton.invoice_documents(document_id) ON DELETE CASCADE,
  attempt_type TEXT NOT NULL CHECK (attempt_type IN ('prepare','create_document','get_document_status','cancel_document','reconcile_document')),
  result_class TEXT NOT NULL CHECK (result_class IN ('success','permanent_fail','temporary_fail','unknown')),
  document_status TEXT NULL CHECK (document_status IS NULL OR document_status IN ('pending','ready','queued','processing','issued','failed','voided','reconciled','skipped')),
  correlation_id TEXT NOT NULL,
  provider_document_id TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, attempt_type, correlation_id)
);

CREATE TABLE IF NOT EXISTS siton.invoice_reconciliation_cases (
  invoice_reconciliation_case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES siton.invoice_documents(document_id) ON DELETE CASCADE,
  case_status TEXT NOT NULL DEFAULT 'open' CHECK (case_status IN ('open','resolved')),
  case_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  blocking_invoice BOOLEAN NOT NULL DEFAULT TRUE,
  expected_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  observed_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  expected_status TEXT NOT NULL DEFAULT '',
  observed_status TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_documents_deal_created
  ON siton.invoice_documents (deal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_documents_participant_created
  ON siton.invoice_documents (participant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_document_attempts_document_created
  ON siton.invoice_document_attempts (document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_reconciliation_cases_open
  ON siton.invoice_reconciliation_cases (document_id, created_at DESC);
