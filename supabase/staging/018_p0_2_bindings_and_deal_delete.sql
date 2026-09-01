-- P0.2: runtime access boundary for (a) the R9A payment_authorization_bindings
-- table (migration 053 — applied to staging in the same change) and (b) the new
-- seller deal-delete route.
--
-- (a) Web creates/verifies/consumes bindings at authorize/join time and counts
--     them in the delete-safety guard; the Worker reconciles/releases them.
-- (b) Deleting an UNUSED deal requires DELETE on siton.deals plus the four
--     non-FK bookkeeping tables the route clears explicitly (outbox rows,
--     idempotency replays, viral cache). FK cascades run as referential
--     actions and need no runtime grants. audit_log/legal_acceptances/
--     operational_cases are deliberately kept.
-- Idempotent, safe to re-apply.

DO $$
BEGIN
  IF to_regclass('siton.payment_authorization_bindings') IS NULL THEN
    RAISE EXCEPTION 'run src/migrations/053_payment_authorization_bindings.sql before this grant file';
  END IF;
END
$$;

ALTER TABLE siton.payment_authorization_bindings ENABLE ROW LEVEL SECURITY;

DO $grants$
DECLARE
  v_table text;
  web_delete text[] := ARRAY['deals','outbox_events','outbox_dlq','idempotency_log','viral_metrics_cache'];
BEGIN
  -- (a) bindings
  GRANT SELECT, INSERT, UPDATE ON siton.payment_authorization_bindings TO siton_web_runtime;
  GRANT SELECT, UPDATE ON siton.payment_authorization_bindings TO siton_worker_runtime;
  DROP POLICY IF EXISTS r2_web_select ON siton.payment_authorization_bindings;
  CREATE POLICY r2_web_select ON siton.payment_authorization_bindings FOR SELECT TO siton_web_runtime USING (true);
  DROP POLICY IF EXISTS r2_web_insert ON siton.payment_authorization_bindings;
  CREATE POLICY r2_web_insert ON siton.payment_authorization_bindings FOR INSERT TO siton_web_runtime WITH CHECK (true);
  DROP POLICY IF EXISTS r2_web_update ON siton.payment_authorization_bindings;
  CREATE POLICY r2_web_update ON siton.payment_authorization_bindings FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true);
  DROP POLICY IF EXISTS r2_worker_select ON siton.payment_authorization_bindings;
  CREATE POLICY r2_worker_select ON siton.payment_authorization_bindings FOR SELECT TO siton_worker_runtime USING (true);
  DROP POLICY IF EXISTS r2_worker_update ON siton.payment_authorization_bindings;
  CREATE POLICY r2_worker_update ON siton.payment_authorization_bindings FOR UPDATE TO siton_worker_runtime USING (true) WITH CHECK (true);

  -- (b) deal delete
  FOREACH v_table IN ARRAY web_delete LOOP
    EXECUTE format('GRANT DELETE ON siton.%I TO siton_web_runtime', v_table);
    EXECUTE format('DROP POLICY IF EXISTS r2_web_delete ON siton.%I', v_table);
    EXECUTE format('CREATE POLICY r2_web_delete ON siton.%I FOR DELETE TO siton_web_runtime USING (true)', v_table);
  END LOOP;
END
$grants$;

-- Self-check.
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='siton' AND table_name='payment_authorization_bindings'
      AND grantee='siton_web_runtime' AND privilege_type='INSERT'
  ) THEN
    RAISE EXCEPTION 'siton_web_runtime is missing INSERT on payment_authorization_bindings';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='siton' AND table_name='deals'
      AND grantee='siton_web_runtime' AND privilege_type='DELETE'
  ) THEN
    RAISE EXCEPTION 'siton_web_runtime is missing DELETE on deals';
  END IF;
END
$verify$;
