BEGIN;

SET search_path TO siton, public;

ALTER TABLE siton.seller_accounts
  ADD COLUMN IF NOT EXISTS login_email TEXT NULL,
  ADD COLUMN IF NOT EXISTS auth_secret_hash TEXT NULL,
  ADD COLUMN IF NOT EXISTS auth_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auth_secret_updated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_login_ip TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_login_user_agent TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_accounts_login_email
  ON siton.seller_accounts (lower(login_email))
  WHERE login_email IS NOT NULL AND btrim(login_email) <> '';

CREATE TABLE IF NOT EXISTS siton.seller_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_ip TEXT NOT NULL DEFAULT '',
  created_user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_seller_sessions_active
  ON siton.seller_sessions (seller_id, expires_at DESC);

COMMIT;
