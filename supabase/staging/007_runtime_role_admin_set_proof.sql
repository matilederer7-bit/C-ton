-- R2 administrative SET ROLE proof boundary.
--
-- Supabase creates the NOLOGIN profiles with postgres as a non-inheriting
-- administrative member, but with SET disabled. Enabling SET lets the existing
-- administrative staging connection exercise the exact runtime identity. It
-- does not grant LOGIN, inheritance, application privileges, or new authority:
-- postgres already owns the canonical schemas and remains outside the runtime.

GRANT siton_web_runtime TO postgres WITH SET TRUE, INHERIT FALSE;
GRANT siton_worker_runtime TO postgres WITH SET TRUE, INHERIT FALSE;

DO $admin_set_safety$
BEGIN
  IF NOT pg_has_role('postgres', 'siton_web_runtime', 'SET')
     OR NOT pg_has_role('postgres', 'siton_worker_runtime', 'SET') THEN
    RAISE EXCEPTION 'postgres must be able to SET ROLE for R2 runtime proofs';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles target_role ON target_role.oid = membership.roleid
    WHERE member_role.rolname = 'postgres'
      AND target_role.rolname IN ('siton_web_runtime', 'siton_worker_runtime')
      AND membership.inherit_option
  ) THEN
    RAISE EXCEPTION 'postgres must not inherit R2 runtime profile privileges';
  END IF;
END
$admin_set_safety$;
