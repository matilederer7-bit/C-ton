-- R6: runtime access boundary for the commerce viral graph (migration 051).
--
-- New tables: siton.viral_attributions, siton.viral_events,
-- siton.viral_metrics_cache. Web records attribution + funnel events and reads
-- metrics; the Worker owns the async recompute (viral_recompute outbox job)
-- and is the only writer of viral_metrics_cache. The Worker also gains SELECT
-- on the link/attribution surfaces it aggregates. Idempotent, safe to re-apply.

DO $$
BEGIN
  IF to_regclass('siton.viral_attributions') IS NULL THEN
    RAISE EXCEPTION 'run src/migrations/051_commerce_viral_graph.sql before this grant file';
  END IF;
END
$$;

ALTER TABLE siton.viral_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.viral_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.viral_metrics_cache ENABLE ROW LEVEL SECURITY;

-- Web: writes attribution edges + funnel events at Join/view time, reads all
-- three surfaces for the seller/admin/participant read models.
DO $grants$
DECLARE
  v_table text;
  web_select text[] := ARRAY['viral_attributions','viral_events','viral_metrics_cache'];
  web_insert text[] := ARRAY['viral_attributions','viral_events'];
  worker_select text[] := ARRAY[
    'viral_attributions','viral_events','viral_metrics_cache',
    'affiliate_links','affiliate_link_events','affiliate_attributions','affiliate_accounts'
  ];
  worker_insert text[] := ARRAY['viral_metrics_cache'];
  worker_update text[] := ARRAY['viral_metrics_cache'];
BEGIN
  FOREACH v_table IN ARRAY web_select LOOP
    EXECUTE format('GRANT SELECT ON siton.%I TO siton_web_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_web_select ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_select ON siton.%I FOR SELECT TO siton_web_runtime USING (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY web_insert LOOP
    EXECUTE format('GRANT INSERT ON siton.%I TO siton_web_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_web_insert ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_insert ON siton.%I FOR INSERT TO siton_web_runtime WITH CHECK (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY worker_select LOOP
    EXECUTE format('GRANT SELECT ON siton.%I TO siton_worker_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_worker_select ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_worker_select ON siton.%I FOR SELECT TO siton_worker_runtime USING (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY worker_insert LOOP
    EXECUTE format('GRANT INSERT ON siton.%I TO siton_worker_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_worker_insert ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_worker_insert ON siton.%I FOR INSERT TO siton_worker_runtime WITH CHECK (true)', v_table);
  END LOOP;
  FOREACH v_table IN ARRAY worker_update LOOP
    EXECUTE format('GRANT UPDATE ON siton.%I TO siton_worker_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_worker_update ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_worker_update ON siton.%I FOR UPDATE TO siton_worker_runtime USING (true) WITH CHECK (true)', v_table);
  END LOOP;
END
$grants$;

-- R6 owner claim: the Web runtime provisions the canonical owner admin binding
-- (verified Supabase email = configured owner email) — it needs INSERT on
-- admin_users (SELECT/UPDATE already granted by the R2 matrix).
GRANT INSERT ON siton.admin_users TO siton_web_runtime;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='siton' AND tablename='admin_users' AND policyname='r2_web_insert'
  ) THEN
    CREATE POLICY r2_web_insert ON siton.admin_users
      FOR INSERT TO siton_web_runtime WITH CHECK (true);
  END IF;
END
$$;

-- Self-check.
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='siton' AND table_name='viral_attributions'
      AND grantee='siton_web_runtime' AND privilege_type='INSERT'
  ) THEN
    RAISE EXCEPTION 'siton_web_runtime is missing INSERT on viral_attributions';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='siton' AND table_name='viral_metrics_cache'
      AND grantee='siton_worker_runtime' AND privilege_type='UPDATE'
  ) THEN
    RAISE EXCEPTION 'siton_worker_runtime is missing UPDATE on viral_metrics_cache';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='siton' AND table_name='affiliate_links'
      AND grantee='siton_worker_runtime' AND privilege_type='SELECT'
  ) THEN
    RAISE EXCEPTION 'siton_worker_runtime is missing SELECT on affiliate_links';
  END IF;
END
$verify$;
