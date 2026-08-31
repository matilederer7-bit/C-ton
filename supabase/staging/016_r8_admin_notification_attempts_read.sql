-- R8: the admin Notifications console surfaces per-event attempt counts and the
-- last adapter used. That read touches siton.notification_attempts, which the
-- R2 matrix had granted to the worker but not the Web runtime. Grant SELECT +
-- an R2 read policy so the canonical admin notifications endpoint works.
--
-- Read-only for Web; the worker keeps its existing write authority. No PII: the
-- table holds provider/result/error metadata, never contact destinations.

GRANT SELECT ON siton.notification_attempts TO siton_web_runtime;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='siton' AND tablename='notification_attempts' AND policyname='r2_web_select'
  ) THEN
    CREATE POLICY r2_web_select ON siton.notification_attempts
      FOR SELECT TO siton_web_runtime USING (true);
  END IF;
END
$$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='siton' AND table_name='notification_attempts'
      AND grantee='siton_web_runtime' AND privilege_type='SELECT'
  ) THEN
    RAISE EXCEPTION 'siton_web_runtime is missing SELECT on notification_attempts';
  END IF;
END
$verify$;
