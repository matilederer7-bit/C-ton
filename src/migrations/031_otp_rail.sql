-- Migration 031: provider-ready OTP rail
-- OTP challenges and delivery attempts are side-effect persistence.
-- They never own deal, participant, or money state.
-- The OTP code itself is never stored in plaintext — only its salted hash.

CREATE TABLE IF NOT EXISTS siton.otp_challenges (
  challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  destination_hash TEXT NOT NULL,
  destination_display TEXT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('buyer_join','buyer_recovery','seller_login')),
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','expired','locked','cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NULL,
  max_attempts INT NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  attempts_count INT NOT NULL DEFAULT 0 CHECK (attempts_count >= 0),
  resend_count INT NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
  idempotency_key TEXT NOT NULL,
  deal_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT NULL,
  CONSTRAINT ux_otp_challenges_idempotency_key UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS siton.otp_delivery_attempts (
  attempt_id BIGSERIAL PRIMARY KEY,
  challenge_id UUID NOT NULL REFERENCES siton.otp_challenges(challenge_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('success','temporary_fail','permanent_fail','skipped')),
  provider_message_id TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_destination
  ON siton.otp_challenges (destination_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_challenges_status_expires
  ON siton.otp_challenges (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_otp_challenges_deal
  ON siton.otp_challenges (deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_delivery_attempts_challenge
  ON siton.otp_delivery_attempts (challenge_id, created_at);
