-- Migration 018: invoice_documents delivery table
-- Tracks every document issuance attempt with full idempotency.
-- document_key is the idempotency key:
--   charge_receipt:{participant_id}
--   refund_receipt:{participant_id}
-- UNIQUE on document_key prevents double issuance for the same business event.

CREATE TABLE IF NOT EXISTS siton.invoice_documents (
  document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Idempotency: one row per (document_type, participant) combination.
  -- Format: "{document_type}:{participant_id}"
  document_key TEXT NOT NULL,

  -- Document type
  document_type TEXT NOT NULL CHECK (document_type IN ('charge_receipt', 'refund_receipt')),

  -- Business references
  deal_id UUID NOT NULL,
  participant_id UUID NOT NULL,

  -- Business snapshot at issuance time (immutable — written once, never updated)
  deal_title TEXT NOT NULL DEFAULT '',
  qty INT NOT NULL DEFAULT 1,
  money_state_at_issue TEXT NOT NULL DEFAULT '',
  gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  siton_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  seller_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Delivery state machine: pending → processing → issued | failed | skipped
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'issued', 'failed', 'skipped')),
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,

  -- Provider tracking
  provider_code TEXT NOT NULL DEFAULT 'log-only',
  provider_document_id TEXT NULL,   -- returned by provider on success
  last_error TEXT NULL,

  -- Timing
  issued_at TIMESTAMPTZ NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_invoice_documents_key UNIQUE (document_key)
);

-- Claim-pending index: dispatcher queries status='pending' AND available_at <= now()
CREATE INDEX IF NOT EXISTS idx_invoice_documents_pending
  ON siton.invoice_documents (status, available_at)
  WHERE status = 'pending';
