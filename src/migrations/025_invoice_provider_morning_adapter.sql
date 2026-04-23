-- Migration 025: invoice provider webhook intake for the first real adapter.
-- Provider-specific mapping remains in the adapter; these tables store canonical
-- webhook audit, dedupe, and security events only.

CREATE TABLE IF NOT EXISTS siton.invoice_webhook_events (
  invoice_webhook_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  provider_document_id TEXT NULL,
  document_id UUID NULL,
  document_key TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','queued','ignored','failed')),
  correlation_id TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS siton.invoice_webhook_security_events (
  security_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NULL,
  failure_reason TEXT NOT NULL,
  remote_hint TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_webhook_events_document
  ON siton.invoice_webhook_events (document_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_webhook_security_events_created
  ON siton.invoice_webhook_security_events (created_at DESC);
