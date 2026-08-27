-- Read-only R1 verification summary. Expected browser privilege counts are zero.

WITH siton_tables AS (
  SELECT c.oid, c.relrowsecurity
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'siton' AND c.relkind IN ('r', 'p')
), inventory_tables AS (
  SELECT c.oid, c.relrowsecurity
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'siton_inventory' AND c.relkind IN ('r', 'p')
), browser_roles(role_name) AS (
  VALUES ('anon'), ('authenticated')
), all_core_tables AS (
  SELECT * FROM siton_tables
  UNION ALL
  SELECT * FROM inventory_tables
)
SELECT
  (SELECT count(*) FROM siton_tables) AS siton_table_count,
  (SELECT count(*) FROM inventory_tables) AS inventory_table_count,
  COALESCE((SELECT bool_and(relrowsecurity) FROM all_core_tables), false) AS all_core_rls_enabled,
  (SELECT count(*)
     FROM browser_roles r CROSS JOIN all_core_tables t
    WHERE has_table_privilege(r.role_name, t.oid, 'SELECT')
       OR has_table_privilege(r.role_name, t.oid, 'INSERT')
       OR has_table_privilege(r.role_name, t.oid, 'UPDATE')
       OR has_table_privilege(r.role_name, t.oid, 'DELETE')) AS browser_table_privilege_count,
  (SELECT count(*)
     FROM browser_roles r
    WHERE has_schema_privilege(r.role_name, 'siton', 'USAGE')
       OR has_schema_privilege(r.role_name, 'siton_inventory', 'USAGE')) AS browser_schema_usage_count,
  to_regprocedure('public.siton_inventory_rpc(text,jsonb)') IS NOT NULL AS inventory_rpc_exists,
  COALESCE((SELECT NOT public FROM storage.buckets WHERE id = 'deal-images'), false) AS deal_images_private;
