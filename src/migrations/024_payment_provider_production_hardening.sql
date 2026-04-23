-- Migration 024: buyer payment provider production hardening.
-- Stores only provider payment method references, never raw card details.

CREATE TABLE IF NOT EXISTS siton.payment_webhook_security_events (
  security_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NULL,
  failure_reason TEXT NOT NULL,
  remote_hint TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_security_events_created
  ON siton.payment_webhook_security_events (created_at DESC);

CREATE TABLE IF NOT EXISTS siton.buyer_payment_methods (
  buyer_payment_method_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  provider_payment_method_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','invalid','expired','revoked')),
  last_authorized_at TIMESTAMPTZ NULL,
  last_failed_at TIMESTAMPTZ NULL,
  correlation_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_code, provider_payment_method_id)
);

CREATE INDEX IF NOT EXISTS idx_buyer_payment_methods_buyer_created
  ON siton.buyer_payment_methods (buyer_id, created_at DESC);
