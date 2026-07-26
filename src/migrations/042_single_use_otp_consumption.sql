-- Make OTP verification a single atomic consumption that emits one durable proof.
ALTER TABLE siton.otp_challenges
  DROP CONSTRAINT IF EXISTS otp_challenges_status_check;

ALTER TABLE siton.otp_challenges
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ NULL;

UPDATE siton.otp_challenges
SET status='consumed',
    consumed_at=COALESCE(consumed_at, verified_at, updated_at)
WHERE status='verified';

ALTER TABLE siton.otp_challenges
  ADD CONSTRAINT otp_challenges_status_check
  CHECK (status IN ('pending','consumed','expired','locked','cancelled'));

ALTER TABLE siton.otp_challenges
  DROP CONSTRAINT IF EXISTS ux_otp_challenges_idempotency_key;

ALTER TABLE siton.otp_challenges
  DROP CONSTRAINT IF EXISTS otp_challenges_idempotency_key_key;

DROP INDEX IF EXISTS siton.ux_otp_challenges_idempotency_key;

CREATE UNIQUE INDEX IF NOT EXISTS ux_otp_challenges_pending_idempotency_key
  ON siton.otp_challenges (idempotency_key)
  WHERE status='pending';

CREATE TABLE IF NOT EXISTS siton.otp_proofs (
  proof_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES siton.otp_challenges(challenge_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_otp_proofs_challenge UNIQUE (challenge_id),
  CONSTRAINT ux_otp_proofs_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_otp_proofs_expiry CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS idx_otp_proofs_expiry
  ON siton.otp_proofs (expires_at);
