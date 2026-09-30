-- 081 — row level security on the 076 outbox insertion-evidence table.
--
-- siton.outbox_enqueue_evidence was created by migration 076 with REVOKE-only
-- protection: no role except the table owner holds any privilege, the
-- AFTER INSERT trigger on outbox_events writes it as the definer, and the
-- outbox_row_written_in_tx helper reads it as the definer. That is sound, but
-- it is the only table in schema siton without row level security, which the
-- hosted dashboard reports as "RLS disabled".
--
-- Enabling RLS with no policy changes nothing that works today: the table
-- owner (who also owns both SECURITY DEFINER functions of 076) bypasses RLS,
-- and every other role already has no privilege. It only makes a future
-- accidental GRANT harmless, exactly like every other siton table.
-- FORCE ROW LEVEL SECURITY is deliberately NOT set: the definer-rights
-- trigger and helper must keep working for the owner.
ALTER TABLE siton.outbox_enqueue_evidence ENABLE ROW LEVEL SECURITY;

DO $rls_assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'siton'
      AND c.relname = 'outbox_enqueue_evidence'
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'outbox_enqueue_evidence: row level security must be enabled and not forced';
  END IF;
END
$rls_assert$;
