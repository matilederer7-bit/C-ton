-- R2 deterministic function fail-closed boundary.
--
-- Object-level grants to runtime roles are not minimal while a clean replay can
-- still inherit the PostgreSQL default PUBLIC EXECUTE privilege. Remove that
-- ambient path, then preserve only the seven explicit helper grants from 008.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton
  FROM PUBLIC, anon, authenticated;

DO $function_public_safety$
DECLARE
  v_role text;
  v_function regprocedure;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOR v_function IN
      SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'siton'
    LOOP
      IF has_function_privilege(v_role, v_function, 'EXECUTE') THEN
        RAISE EXCEPTION 'browser role retains siton function execution role=% function=%', v_role, v_function;
      END IF;
    END LOOP;
  END LOOP;

  IF has_function_privilege('siton_web_runtime', 'siton.audit_log_before_insert_enforce()', 'EXECUTE')
     OR has_function_privilege('siton_worker_runtime', 'siton.participants_before_update_enforce()', 'EXECUTE') THEN
    RAISE EXCEPTION 'runtime role inherited a trigger-body EXECUTE privilege';
  END IF;
END
$function_public_safety$;
