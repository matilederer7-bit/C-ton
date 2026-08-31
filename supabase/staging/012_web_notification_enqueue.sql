-- R6 permission-matrix correction: the canonical Web runtime enqueues a
-- join-confirmation notification synchronously inside the Join transaction
-- (src/notification_dispatch.ts enqueueNotification -> INSERT notification_events).
-- The R2 boundary granted siton_web_runtime only SELECT/UPDATE on
-- notification_events (assuming notifications were worker-enqueued), so a hosted
-- guest Join failed with "permission denied / RLS violation" for the table.
--
-- Grant the Web runtime the ability to INSERT a notification event, with a
-- matching permissive RLS INSERT policy — mirroring the existing worker grant.
-- Idempotent and safe to re-apply.

GRANT INSERT ON siton.notification_events TO siton_web_runtime;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'siton' AND tablename = 'notification_events' AND policyname = 'r2_web_insert'
  ) THEN
    CREATE POLICY r2_web_insert ON siton.notification_events
      FOR INSERT TO siton_web_runtime WITH CHECK (true);
  END IF;
END
$$;

-- Self-check: the Web runtime must now hold INSERT (privilege + policy).
DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='siton' AND table_name='notification_events'
      AND grantee='siton_web_runtime' AND privilege_type='INSERT'
  ) THEN
    RAISE EXCEPTION 'siton_web_runtime is missing INSERT on notification_events';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='siton' AND tablename='notification_events' AND policyname='r2_web_insert'
  ) THEN
    RAISE EXCEPTION 'r2_web_insert policy is missing';
  END IF;
END
$verify$;
