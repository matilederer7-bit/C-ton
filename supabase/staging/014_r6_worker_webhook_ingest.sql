-- R6 hosted charge proof exposed a real R2-matrix gap: the Worker's
-- charge/recovery path ingests the provider's synthetic payment event through
-- src/webhook_ingestion.ts (INSERT + status UPDATE on siton.webhook_events),
-- but migration 006 granted webhook_events only to the Web runtime. On staging
-- the first live worker charge failed with SQLSTATE 42501, retried into the
-- 3-per-30-minutes charge cap (SN429) and archived to the DLQ.
-- Grant the Worker the webhook_events triplet, mirroring the Web grants.
-- Idempotent and safe to re-apply.

GRANT SELECT, INSERT, UPDATE ON siton.webhook_events TO siton_worker_runtime;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='siton' AND tablename='webhook_events' AND policyname='r2_worker_select'
  ) THEN
    CREATE POLICY r2_worker_select ON siton.webhook_events
      FOR SELECT TO siton_worker_runtime USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='siton' AND tablename='webhook_events' AND policyname='r2_worker_insert'
  ) THEN
    CREATE POLICY r2_worker_insert ON siton.webhook_events
      FOR INSERT TO siton_worker_runtime WITH CHECK (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='siton' AND tablename='webhook_events' AND policyname='r2_worker_update'
  ) THEN
    CREATE POLICY r2_worker_update ON siton.webhook_events
      FOR UPDATE TO siton_worker_runtime USING (true) WITH CHECK (true);
  END IF;
END
$$;

-- Self-check.
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='siton' AND table_name='webhook_events'
      AND grantee='siton_worker_runtime' AND privilege_type='INSERT'
  ) THEN
    RAISE EXCEPTION 'siton_worker_runtime is missing INSERT on webhook_events';
  END IF;
END
$verify$;
