-- Apply after canonical migrations 067 (payment operation lifecycle) and 068
-- (payment settlement horizon). Both create SECURITY DEFINER helpers in the
-- siton schema; a fresh CREATE FUNCTION inherits the PostgreSQL default PUBLIC
-- EXECUTE privilege that staging 009 removed from every earlier function.
--
--   * payment_operation_in_flight and payment_capture_settlement_fence are
--     invoked directly by application SQL under the runtime roles — explicit
--     EXECUTE, exactly like the 008 trigger helpers.
--   * payment_release_conflict is invoked only from inside the eligibility
--     trigger body (which runs as its SECURITY DEFINER owner) — no runtime grant.
--   * the four guard_* trigger bodies need no runtime EXECUTE: trigger
--     functions are not privilege-checked at fire time, and 009 asserts the
--     runtime roles hold none.
-- is_valid_money_transition is CREATE OR REPLACEd by 068 and keeps its 008 ACL.
BEGIN;

REVOKE EXECUTE ON FUNCTION
  siton.payment_operation_in_flight(uuid, integer),
  siton.guard_payment_attempt_lifecycle(),
  siton.guard_payment_attempt_eligibility(),
  siton.payment_capture_settlement_fence(uuid, uuid),
  siton.payment_release_conflict(uuid, uuid),
  siton.guard_payment_attempt_settlement_fence(),
  siton.guard_payment_attempt_settlement_horizon()
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

  -- runtime roles: exactly the two application-invoked helpers, no trigger bodies
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
