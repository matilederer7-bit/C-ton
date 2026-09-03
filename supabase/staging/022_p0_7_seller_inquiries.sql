-- P0.7: runtime boundary for internal buyer → seller inquiries (migration 061).
-- The Web runtime creates threads/messages (public inquiry + seller reply),
-- reads them (seller command center, tokenized customer view) and UPDATEs
-- thread rollups (unread counters, status, last message). Messages are
-- append-only at the grant level (no UPDATE/DELETE); threads never get DELETE
-- (rows leave only through the deals FK cascade, which runs as the table owner).
-- Idempotent, safe to re-apply.

DO $$
BEGIN
  IF to_regclass('siton.seller_inquiry_threads') IS NULL OR to_regclass('siton.seller_inquiry_messages') IS NULL THEN
    RAISE EXCEPTION 'run migration 061 before this grant file';
  END IF;
END
$$;

ALTER TABLE siton.seller_inquiry_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.seller_inquiry_messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON siton.seller_inquiry_threads TO siton_web_runtime;
DROP POLICY IF EXISTS r2_web_select ON siton.seller_inquiry_threads;
CREATE POLICY r2_web_select ON siton.seller_inquiry_threads FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.seller_inquiry_threads;
CREATE POLICY r2_web_insert ON siton.seller_inquiry_threads FOR INSERT TO siton_web_runtime WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_update ON siton.seller_inquiry_threads;
CREATE POLICY r2_web_update ON siton.seller_inquiry_threads FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON siton.seller_inquiry_messages TO siton_web_runtime;
DROP POLICY IF EXISTS r2_web_select ON siton.seller_inquiry_messages;
CREATE POLICY r2_web_select ON siton.seller_inquiry_messages FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.seller_inquiry_messages;
CREATE POLICY r2_web_insert ON siton.seller_inquiry_messages FOR INSERT TO siton_web_runtime WITH CHECK (true);

-- The Worker only reads notification_events (already granted); it never touches threads.

DO $verify$
BEGIN
  IF NOT has_table_privilege('siton_web_runtime', 'siton.seller_inquiry_threads', 'UPDATE') THEN
    RAISE EXCEPTION 'siton_web_runtime is missing UPDATE on seller_inquiry_threads';
  END IF;
  IF has_table_privilege('siton_web_runtime', 'siton.seller_inquiry_threads', 'DELETE') THEN
    RAISE EXCEPTION 'siton_web_runtime must NOT have DELETE on seller_inquiry_threads';
  END IF;
  IF NOT has_table_privilege('siton_web_runtime', 'siton.seller_inquiry_messages', 'INSERT') THEN
    RAISE EXCEPTION 'siton_web_runtime is missing INSERT on seller_inquiry_messages';
  END IF;
  IF has_table_privilege('siton_web_runtime', 'siton.seller_inquiry_messages', 'UPDATE')
     OR has_table_privilege('siton_web_runtime', 'siton.seller_inquiry_messages', 'DELETE') THEN
    RAISE EXCEPTION 'seller_inquiry_messages must stay append-only for siton_web_runtime';
  END IF;
END
$verify$;
