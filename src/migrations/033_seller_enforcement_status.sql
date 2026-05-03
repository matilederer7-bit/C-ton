BEGIN;
SET search_path TO siton, public;

ALTER TABLE siton.seller_accounts
  ADD COLUMN IF NOT EXISTS seller_status TEXT NOT NULL DEFAULT 'Active',
  ADD COLUMN IF NOT EXISTS seller_status_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS seller_status_updated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS seller_status_updated_by TEXT NULL;

UPDATE siton.seller_accounts
   SET seller_status = 'Active'
 WHERE seller_status IS NULL OR btrim(seller_status) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'seller_accounts_seller_status_check'
       AND conrelid = 'siton.seller_accounts'::regclass
  ) THEN
    ALTER TABLE siton.seller_accounts
      ADD CONSTRAINT seller_accounts_seller_status_check
      CHECK (seller_status IN ('Active','UnderReview','Restricted','Suspended','Banned'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_seller_accounts_seller_status
  ON siton.seller_accounts (seller_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS siton.seller_security_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT NULL,
  to_status TEXT NULL,
  actor_ref TEXT NOT NULL DEFAULT 'admin',
  reason TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seller_security_events_seller_created
  ON siton.seller_security_events (seller_id, created_at DESC);

COMMIT;
