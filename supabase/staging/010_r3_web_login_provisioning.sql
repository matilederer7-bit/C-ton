-- R3 Render Web LOGIN provisioning (secret-free structure).
--
-- siton_web_runtime remains the audited NOLOGIN permission profile from R2.
-- The Render Web process authenticates as the dedicated siton_web_login
-- principal. This migration provisions only the reproducible role structure:
-- the login secret is set exclusively through the external secret channel
-- (an ALTER ROLE statement executed outside Git and outside logs).
-- Until that external step runs, the role cannot authenticate at all.

DO $login_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'siton_web_login') THEN
    CREATE ROLE siton_web_login LOGIN NOINHERIT;
  END IF;
END
$login_role$;

ALTER ROLE siton_web_login LOGIN NOINHERIT;

-- The login principal holds zero direct object privileges. Its only authority
-- is adopting the audited Web profile after authentication.
REVOKE ALL ON SCHEMA siton FROM siton_web_login;
REVOKE ALL ON ALL TABLES IN SCHEMA siton FROM siton_web_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA siton FROM siton_web_login;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton FROM siton_web_login;
REVOKE ALL ON SCHEMA siton_inventory FROM siton_web_login;
REVOKE ALL ON ALL TABLES IN SCHEMA siton_inventory FROM siton_web_login;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA siton_inventory FROM siton_web_login;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton_inventory FROM siton_web_login;

DO $database_access$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO siton_web_login', current_database());
END
$database_access$;

GRANT siton_web_runtime TO siton_web_login WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;

-- Every session opened by the login principal adopts the audited Web profile
-- before the first application statement. current_user is therefore always
-- siton_web_runtime, matching the readiness identity check, and this holds
-- through any session-mode pooler without client-side cooperation.
ALTER ROLE siton_web_login SET role = 'siton_web_runtime';

DO $login_safety$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'siton_web_login'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication
           OR rolbypassrls OR rolinherit OR NOT rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'siton_web_login must be a plain non-inheriting LOGIN principal';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN ('siton_web_runtime', 'siton_worker_runtime')
      AND rolcanlogin
  ) THEN
    RAISE EXCEPTION 'R2 permission profiles must remain NOLOGIN';
  END IF;

  IF NOT pg_has_role('siton_web_login', 'siton_web_runtime', 'SET') THEN
    RAISE EXCEPTION 'siton_web_login must be able to SET ROLE to the Web profile';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles target_role ON target_role.oid = membership.roleid
    WHERE member_role.rolname = 'siton_web_login'
      AND target_role.rolname = 'siton_worker_runtime'
  ) THEN
    RAISE EXCEPTION 'siton_web_login must not hold the Worker profile';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_roles target_role ON target_role.oid = membership.roleid
    WHERE member_role.rolname = 'siton_web_login'
      AND target_role.rolname = 'siton_web_runtime'
      AND (membership.inherit_option OR membership.admin_option)
  ) THEN
    RAISE EXCEPTION 'siton_web_login membership must be SET-only, no inherit, no admin';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_db_role_setting setting
    JOIN pg_roles login_role ON login_role.oid = setting.setrole
    WHERE login_role.rolname = 'siton_web_login'
      AND setting.setconfig @> ARRAY['role=siton_web_runtime']
  ) THEN
    RAISE EXCEPTION 'siton_web_login sessions must default to the audited Web profile';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = 'siton_web_login'
      AND table_schema IN ('siton', 'siton_inventory')
  ) THEN
    RAISE EXCEPTION 'siton_web_login must hold zero direct table privileges';
  END IF;
END
$login_safety$;
