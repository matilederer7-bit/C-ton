-- R1 staging hardening: pin canonical siton function resolution.
-- Browser roles remain fail-closed; this only removes mutable search_path risk.

alter function siton.audit_log_append_only()
  set search_path = siton, pg_temp;
alter function siton.audit_log_before_insert_enforce()
  set search_path = siton, pg_temp;
alter function siton.deals_before_update_enforce()
  set search_path = siton, pg_temp;
alter function siton.deals_outbox_enforce()
  set search_path = siton, pg_temp;
alter function siton.enforce_outbox_fencing_cutover()
  set search_path = siton, pg_temp;
alter function siton.flag_is_set(text)
  set search_path = siton, pg_temp;
alter function siton.is_valid_action_name(text)
  set search_path = siton, pg_temp;
alter function siton.is_valid_buyer_transition(text, text)
  set search_path = siton, pg_temp;
alter function siton.is_valid_deal_transition(text, text)
  set search_path = siton, pg_temp;
alter function siton.is_valid_money_transition(text, text)
  set search_path = siton, pg_temp;
alter function siton.is_valid_transition(text, text, text)
  set search_path = siton, pg_temp;
alter function siton.participants_before_update_enforce()
  set search_path = siton, pg_temp;
alter function siton.prevent_operational_recovery_audit_mutation()
  set search_path = siton, pg_temp;
alter function siton.require_action_name()
  set search_path = siton, pg_temp;
alter function siton.set_updated_at()
  set search_path = siton, pg_temp;