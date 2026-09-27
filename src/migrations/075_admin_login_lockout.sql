-- 075_admin_login_lockout
-- Red-team hardening (Finding A3, Medium): the admin password login had no
-- per-account failure counter or lockout (unlike seller/link-viewer login), so
-- with a spoofable client IP the password step had no throttle bound at all.
-- Add a sliding-window failure counter and a self-healing lock timestamp on the
-- account row. The login handler holds the row FOR UPDATE, so the count and the
-- lock decision are race-safe. Additive and idempotent: existing admins start
-- with a clean counter and no lock.
ALTER TABLE siton.admin_users
  ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_login_window_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMPTZ NULL;

ALTER TABLE siton.admin_users
  DROP CONSTRAINT IF EXISTS admin_users_failed_login_count_nonnegative;
ALTER TABLE siton.admin_users
  ADD CONSTRAINT admin_users_failed_login_count_nonnegative CHECK (failed_login_count >= 0);
