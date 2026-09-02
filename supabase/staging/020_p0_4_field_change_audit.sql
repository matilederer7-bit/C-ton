-- P0.4: runtime boundary for the deal field-change audit rail (migration 059).
-- Web runtime records changes (INSERT) and may read them back (SELECT);
-- UPDATE stays impossible for everyone via the append-only trigger, and no
-- DELETE grant exists (rows leave only through the deal FK cascade).
-- Idempotent, safe to re-apply.

DO $$
BEGIN
  IF to_regclass('siton.deal_field_change_audit') IS NULL THEN
    RAISE EXCEPTION 'run migration 059 before this grant file';
  END IF;
END
$$;

ALTER TABLE siton.deal_field_change_audit ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON siton.deal_field_change_audit TO siton_web_runtime;
DROP POLICY IF EXISTS r2_web_select ON siton.deal_field_change_audit;
CREATE POLICY r2_web_select ON siton.deal_field_change_audit FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.deal_field_change_audit;
CREATE POLICY r2_web_insert ON siton.deal_field_change_audit FOR INSERT TO siton_web_runtime WITH CHECK (true);

DO $verify$
BEGIN
  IF NOT has_table_privilege('siton_web_runtime', 'siton.deal_field_change_audit', 'INSERT') THEN
    RAISE EXCEPTION 'siton_web_runtime is missing INSERT on deal_field_change_audit';
  END IF;
  IF has_table_privilege('siton_web_runtime', 'siton.deal_field_change_audit', 'DELETE') THEN
    RAISE EXCEPTION 'siton_web_runtime must NOT have DELETE on deal_field_change_audit';
  END IF;
END
$verify$;
