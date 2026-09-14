-- Apply after canonical migrations 067 (payment operation lifecycle) and 068
-- (payment settlement horizon). Both create SECURITY DEFINER helpers in the
-- siton schema; a fresh CREATE FUNCTION inherits PostgreSQL's default PUBLIC
-- EXECUTE privilege. Staging migration 009 establishes a fail-closed invariant:
-- browser roles must have no EXECUTE on any function in schema siton.
--
-- Re-apply that global invariant first, because functions created after 009 can
-- otherwise inherit PUBLIC EXECUTE. Then grant only the two helpers invoked
-- directly by the application runtime roles. Trigger bodies do not require
-- runtime EXECUTE, and payment_release_conflict is called only from a trigger.
BEGIN;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA siton
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  siton.payment_operation_in_flight(uuid, integer),
  siton.payment_capture_settlement_fence(uuid, uuid)
  TO siton_web_runtime, siton_worker_runtime;

DO $payment_lifecycle_grant_safety$
DECLARE
  v_role text;
  v_function regprocedure;
BEGIN
  -- staging 009 invariant: browser roles execute nothing in siton
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

  -- runtime roles: exactly the two application-invoked new helpers, while the
  -- pre-existing money transition helper retains its explicit staging grant.
  FOREACH v_role IN ARRAY ARRAY['siton_web_runtime','siton_worker_runtime'] LOOP
    IF NOT has_function_privilege(v_role, 'siton.payment_operation_in_flight(uuid,integer)', 'EXECUTE')
       OR NOT has_function_privilege(v_role, 'siton.payment_capture_settlement_fence(uuid,uuid)', 'EXECUTE')
       OR NOT has_function_privilege(v_role, 'siton.is_valid_money_transition(text,text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'missing runtime payment helper privilege role=%', v_role;
    END IF;
    IF has_function_privilege(v_role, 'siton.guard_payment_attempt_lifecycle()', 'EXECUTE')
       OR has_function_privilege(v_role, 'siton.guard_payment_attempt_eligibility()', 'EXECUTE')
       OR has_function_privilege(v_role, 'siton.guard_payment_attempt_settlement_fence()', 'EXECUTE')
       OR has_function_privilege(v_role, 'siton.guard_payment_attempt_settlement_horizon()', 'EXECUTE')
       OR has_function_privilege(v_role, 'siton.payment_release_conflict(uuid,uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'runtime role inherited a trigger-body EXECUTE privilege role=%', v_role;
    END IF;
  END LOOP;
END
$payment_lifecycle_grant_safety$;

COMMIT;
