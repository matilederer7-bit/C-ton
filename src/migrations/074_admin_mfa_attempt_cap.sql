-- 074_admin_mfa_attempt_cap
-- Red-team hardening (Finding A1, High): the admin MFA second factor had no
-- per-challenge attempt cap, leaving the 6-digit login/setup code brute-forceable
-- within its 10-minute Pending window. Add an attempts counter so the verify
-- handler can lock a challenge after a small number of wrong codes, mirroring the
-- buyer OTP rail's 3-attempt lock. Idempotent and additive: existing Pending
-- challenges default to 0 attempts.
ALTER TABLE siton.admin_mfa_challenges
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

-- The status CHECK already allows 'Revoked'; a challenge that exhausts its
-- attempt budget is moved to 'Revoked' (distinct from 'Expired' for audit).
