-- R2 least-privilege EXECUTE surface for validation helpers invoked by the
-- canonical state/audit triggers. Trigger bodies run with the caller's rights;
-- these non-mutating helpers therefore require explicit EXECUTE.

GRANT EXECUTE ON FUNCTION
  siton.flag_is_set(text),
  siton.is_valid_action_name(text),
  siton.is_valid_buyer_transition(text, text),
  siton.is_valid_deal_transition(text, text),
  siton.is_valid_money_transition(text, text),
  siton.is_valid_transition(text, text, text),
  siton.require_action_name()
  TO siton_web_runtime, siton_worker_runtime;

DO $trigger_helper_safety$
DECLARE
  v_role text;
  v_function text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['siton_web_runtime','siton_worker_runtime'] LOOP
    FOREACH v_function IN ARRAY ARRAY[
      'siton.flag_is_set(text)',
      'siton.is_valid_action_name(text)',
      'siton.is_valid_buyer_transition(text,text)',
      'siton.is_valid_deal_transition(text,text)',
      'siton.is_valid_money_transition(text,text)',
      'siton.is_valid_transition(text,text,text)',
      'siton.require_action_name()'
    ] LOOP
      IF NOT has_function_privilege(v_role, v_function, 'EXECUTE') THEN
        RAISE EXCEPTION 'missing runtime trigger helper privilege role=% function=%', v_role, v_function;
      END IF;
    END LOOP;
  END LOOP;
END
$trigger_helper_safety$;
