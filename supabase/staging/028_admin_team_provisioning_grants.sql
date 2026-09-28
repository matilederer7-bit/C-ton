-- Apply after canonical migration 080 (admin team provisioning). Idempotent.
--
-- The web runtime creates admins (INSERT on admin_users is already granted by
-- 013) and appends to the admin-team audit rail. The rail is append-only for
-- the web runtime: SELECT + INSERT, never UPDATE/DELETE (080's trigger refuses
-- both for every role anyway). No anon/authenticated Data API grant exists on
-- admin_users or on the rail, so a signed-in Supabase user can never insert
-- an admin row — or read one — through PostgREST; the only path is the
-- Fastify route guarded by the SuperAdmin-only admin_users.manage permission.

DO $$
BEGIN
  IF to_regclass('siton.admin_user_audit') IS NULL THEN
    RAISE EXCEPTION 'run canonical migration 080 before this grant file';
  END IF;
END
$$;

BEGIN;
ALTER TABLE siton.admin_user_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON siton.admin_user_audit FROM PUBLIC, anon, authenticated, siton_worker_runtime;
REVOKE ALL ON SEQUENCE siton.admin_user_audit_audit_id_seq FROM PUBLIC, anon, authenticated, siton_worker_runtime;
REVOKE ALL ON siton.admin_users FROM anon, authenticated;

GRANT SELECT, INSERT ON siton.admin_user_audit TO siton_web_runtime;
GRANT USAGE ON SEQUENCE siton.admin_user_audit_audit_id_seq TO siton_web_runtime;

DROP POLICY IF EXISTS r2_web_select ON siton.admin_user_audit;
CREATE POLICY r2_web_select ON siton.admin_user_audit FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.admin_user_audit;
CREATE POLICY r2_web_insert ON siton.admin_user_audit FOR INSERT TO siton_web_runtime WITH CHECK (true);
COMMIT;
