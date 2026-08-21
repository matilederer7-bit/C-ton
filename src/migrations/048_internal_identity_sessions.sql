-- Stage 32D: server-authoritative buyer resume and distributor identity.
-- Session tokens and OTP/contact material are never stored in plaintext.

ALTER TABLE siton.affiliate_accounts
  ADD COLUMN IF NOT EXISTS login_email TEXT NULL,
  ADD COLUMN IF NOT EXISTS auth_secret_hash TEXT NULL,
  ADD COLUMN IF NOT EXISTS auth_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auth_secret_updated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_affiliate_accounts_login_email
  ON siton.affiliate_accounts (lower(login_email))
  WHERE login_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS siton.distributor_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id UUID NOT NULL REFERENCES siton.affiliate_accounts(affiliate_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL,
  created_ip TEXT NOT NULL DEFAULT '',
  created_user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_distributor_session_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_distributor_sessions_affiliate_active
  ON siton.distributor_sessions (affiliate_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS siton.buyer_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_identity_hash TEXT NOT NULL,
  authenticated_deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_buyer_session_identity_hash CHECK (buyer_identity_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_buyer_session_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_buyer_sessions_identity_deal_active
  ON siton.buyer_sessions (buyer_identity_hash, authenticated_deal_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS siton.buyer_resume_contexts (
  resume_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_identity_hash TEXT NOT NULL,
  deal_id UUID NOT NULL REFERENCES siton.deals(deal_id) ON DELETE CASCADE,
  selected_quantity INT NOT NULL CHECK (selected_quantity BETWEEN 1 AND 1000),
  delivery_option_id UUID NULL REFERENCES siton.deal_delivery_options(option_id) ON DELETE SET NULL,
  attribution_ref TEXT NULL,
  pricing_estimate_reference TEXT NOT NULL,
  workflow_position TEXT NOT NULL CHECK (workflow_position IN ('otp_verified','payment')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_buyer_resume_identity_deal UNIQUE (buyer_identity_hash, deal_id),
  CONSTRAINT ck_buyer_resume_identity_hash CHECK (buyer_identity_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_buyer_resume_attribution_length CHECK (attribution_ref IS NULL OR length(attribution_ref) <= 120),
  CONSTRAINT ck_buyer_resume_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_buyer_resume_expiry
  ON siton.buyer_resume_contexts (expires_at)
  WHERE consumed_at IS NULL;
