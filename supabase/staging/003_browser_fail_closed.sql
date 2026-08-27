-- The future Render backend is the business authorization boundary.
-- Supabase browser roles receive no direct access to canonical business truth.

BEGIN;

REVOKE ALL ON SCHEMA siton FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA siton FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA siton FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA siton REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA siton REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA siton REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

DO $rls$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'siton'
       AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', relation.qualified_name);
  END LOOP;
END;
$rls$;

COMMIT;
