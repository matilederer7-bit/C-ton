-- Canonical hosted Supabase authority: inventory reservation / commit / release only.
-- This is deliberately not migration 049 and must never provision the portable `siton` schema.
-- New siton_inventory provisioning must declare the same fixed search_path on both
-- append-only trigger functions. Existing V1 projects can apply this file directly.

BEGIN;

ALTER FUNCTION siton_inventory.reject_participant_state_audit_mutation()
  SET search_path = '';

ALTER FUNCTION siton_inventory.reject_deal_state_audit_mutation()
  SET search_path = '';

COMMIT;
