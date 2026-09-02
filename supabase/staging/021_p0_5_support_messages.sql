-- P0.5: runtime boundary for the support case conversation (migration 060).
-- Web runtime writes replies and reads threads (admin routes authorize the
-- HTTP layer; the DB grant is the runtime role boundary). No UPDATE/DELETE:
-- thread messages are append-only at the grant level.
-- Idempotent, safe to re-apply.

DO $$
BEGIN
  IF to_regclass('siton.support_case_messages') IS NULL THEN
    RAISE EXCEPTION 'run migration 060 before this grant file';
  END IF;
END
$$;

ALTER TABLE siton.support_case_messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON siton.support_case_messages TO siton_web_runtime;
DROP POLICY IF EXISTS r2_web_select ON siton.support_case_messages;
CREATE POLICY r2_web_select ON siton.support_case_messages FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.support_case_messages;
CREATE POLICY r2_web_insert ON siton.support_case_messages FOR INSERT TO siton_web_runtime WITH CHECK (true);

DO $verify$
BEGIN
  IF NOT has_table_privilege('siton_web_runtime', 'siton.support_case_messages', 'INSERT') THEN
    RAISE EXCEPTION 'siton_web_runtime is missing INSERT on support_case_messages';
  END IF;
  IF has_table_privilege('siton_web_runtime', 'siton.support_case_messages', 'DELETE') THEN
    RAISE EXCEPTION 'siton_web_runtime must NOT have DELETE on support_case_messages';
  END IF;
END
$verify$;
