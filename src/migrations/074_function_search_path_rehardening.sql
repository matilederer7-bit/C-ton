-- Re-pin functions recreated after the original staging search_path hardening.
-- CREATE OR REPLACE resets a function's proconfig, so later migrations must
-- restore the fixed resolution boundary explicitly.

BEGIN;

ALTER FUNCTION siton.is_valid_action_name(text)
  SET search_path = siton, pg_temp;
ALTER FUNCTION siton.is_valid_deal_transition(text, text)
  SET search_path = siton, pg_temp;
ALTER FUNCTION siton.is_valid_money_transition(text, text)
  SET search_path = siton, pg_temp;
ALTER FUNCTION siton.deal_field_change_audit_append_only()
  SET search_path = siton, pg_temp;
ALTER FUNCTION siton.prevent_published_deal_product_snapshot_change()
  SET search_path = siton, pg_temp;

COMMIT;
