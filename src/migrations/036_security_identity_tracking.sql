BEGIN;

SET search_path TO siton, public;

SELECT pg_advisory_xact_lock(hashtext('siton_security_identity_tracking_ddl'));

CREATE TABLE IF NOT EXISTS siton.admin_users (
  admin_user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NULL,
  role TEXT NOT NULL CHECK (role IN ('SuperAdmin','OpsAdmin','SupportAdmin','ReadOnlyAdmin')),
  status TEXT NOT NULL CHECK (status IN ('Active','Suspended','Disabled')),
  password_hash TEXT NULL,
  mfa_required BOOLEAN NOT NULL DEFAULT true,
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS siton.admin_sessions (
  admin_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES siton.admin_users(admin_user_id),
  session_token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  last_seen_at TIMESTAMPTZ NULL,
  mfa_verified_at TIMESTAMPTZ NULL,
  ip_hash TEXT NULL,
  user_agent_hash TEXT NULL
);

CREATE TABLE IF NOT EXISTS siton.admin_mfa_factors (
  mfa_factor_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES siton.admin_users(admin_user_id),
  factor_type TEXT NOT NULL CHECK (factor_type IN ('totp','email_otp')),
  secret_hash TEXT NULL,
  secret_encrypted TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('Pending','Active','Disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ NULL,
  disabled_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS siton.admin_mfa_challenges (
  mfa_challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES siton.admin_users(admin_user_id),
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Pending','Verified','Expired','Revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS siton.participant_tracking_tokens (
  tracking_token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id UUID NOT NULL,
  deal_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('tracking','recovery','receipt','support')),
  status TEXT NOT NULL CHECK (status IN ('Active','Revoked','Expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  issued_via TEXT NULL,
  correlation_id TEXT NULL
);

ALTER TABLE IF EXISTS siton.admin_actions ADD COLUMN IF NOT EXISTS requested_by_admin_user_id UUID NULL;
ALTER TABLE IF EXISTS siton.admin_actions ADD COLUMN IF NOT EXISTS approved_by_admin_user_id UUID NULL;
ALTER TABLE IF EXISTS siton.admin_actions ADD COLUMN IF NOT EXISTS identity_strength TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_active ON siton.admin_sessions (admin_user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_mfa_challenges_user_status ON siton.admin_mfa_challenges (admin_user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_participant_tracking_tokens_participant ON siton.participant_tracking_tokens (participant_id, purpose, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_participant_tracking_tokens_deal ON siton.participant_tracking_tokens (deal_id, status, expires_at);

COMMIT;
