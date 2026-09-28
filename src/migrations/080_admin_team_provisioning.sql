-- 080_admin_team_provisioning
-- Owner round 2026-09-28: an existing SuperAdmin adds another admin from the
-- admin UI with a USERNAME and a password.
--
-- The password never reaches this database. The admin's credential lives only
-- in Supabase Auth (created server-side by the admin-provisioner Edge Function
-- through the Auth Admin API); admin_users keeps only the binding
-- (auth_user_id), the explicit role and the provenance. This migration adds:
--
--   * admin_users.username — the login name. Unique case-insensitively
--     (stored lower-case; the format CHECK also forbids upper case), NULL for
--     admins that sign in with an e-mail.
--   * siton.admin_user_audit — the append-only audit rail of admin-team
--     actions. It has NO free-form payload column, so a password (or any other
--     secret) has no column to land in; UPDATE and DELETE are refused for every
--     role by trigger.
--
-- Additive and idempotent.

ALTER TABLE siton.admin_users ADD COLUMN IF NOT EXISTS username TEXT NULL;

ALTER TABLE siton.admin_users DROP CONSTRAINT IF EXISTS admin_users_username_format;
ALTER TABLE siton.admin_users
  ADD CONSTRAINT admin_users_username_format
  CHECK (username IS NULL OR username ~ '^[a-z][a-z0-9._-]{2,31}$');

CREATE UNIQUE INDEX IF NOT EXISTS ux_admin_users_username
  ON siton.admin_users (lower(username)) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS siton.admin_user_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('admin.created')),
  actor_admin_user_id UUID NOT NULL REFERENCES siton.admin_users(admin_user_id),
  target_admin_user_id UUID NOT NULL REFERENCES siton.admin_users(admin_user_id),
  target_username TEXT NULL,
  target_role TEXT NOT NULL CHECK (target_role IN ('SuperAdmin','OpsAdmin','SupportAdmin','ReadOnlyAdmin')),
  target_auth_user_id UUID NULL,
  request_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_user_audit_created
  ON siton.admin_user_audit (created_at DESC);

CREATE OR REPLACE FUNCTION siton.admin_user_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'siton.admin_user_audit is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_user_audit_append_only ON siton.admin_user_audit;
CREATE TRIGGER trg_admin_user_audit_append_only
  BEFORE UPDATE OR DELETE ON siton.admin_user_audit
  FOR EACH ROW EXECUTE FUNCTION siton.admin_user_audit_append_only();
