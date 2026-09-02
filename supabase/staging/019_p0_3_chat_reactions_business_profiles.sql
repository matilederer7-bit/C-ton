-- P0.3: runtime boundary for (a) deal chat reactions and (b) seller business
-- profiles (migrations 057/058, applied in the same change).
--
-- (a) Web reads/aggregates and toggles reactions (insert/update/delete of the
--     viewer's own row — actor scoping is enforced in the route by actor_key).
-- (b) seller_business_profiles: Web may INSERT/UPDATE every column, but its
--     SELECT grant is COLUMN-LEVEL and EXCLUDES bank_account_number — the
--     full account number is write-only for the Web runtime at the database
--     layer; every read surface uses bank_account_last4.
-- Idempotent, safe to re-apply.

DO $$
BEGIN
  IF to_regclass('siton.deal_chat_message_reactions') IS NULL OR to_regclass('siton.seller_business_profiles') IS NULL THEN
    RAISE EXCEPTION 'run migrations 057/058 before this grant file';
  END IF;
END
$$;

ALTER TABLE siton.deal_chat_message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE siton.seller_business_profiles ENABLE ROW LEVEL SECURITY;

-- (a) reactions
GRANT SELECT, INSERT, UPDATE, DELETE ON siton.deal_chat_message_reactions TO siton_web_runtime;
DROP POLICY IF EXISTS r2_web_select ON siton.deal_chat_message_reactions;
CREATE POLICY r2_web_select ON siton.deal_chat_message_reactions FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.deal_chat_message_reactions;
CREATE POLICY r2_web_insert ON siton.deal_chat_message_reactions FOR INSERT TO siton_web_runtime WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_update ON siton.deal_chat_message_reactions;
CREATE POLICY r2_web_update ON siton.deal_chat_message_reactions FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_delete ON siton.deal_chat_message_reactions;
CREATE POLICY r2_web_delete ON siton.deal_chat_message_reactions FOR DELETE TO siton_web_runtime USING (true);

-- (b) business profiles — column-level SELECT excludes bank_account_number
REVOKE ALL ON siton.seller_business_profiles FROM siton_web_runtime;
GRANT SELECT (seller_id, business_name, legal_name, business_id_number, entity_type, contact_name,
              contact_phone, contact_email, finance_email, business_address,
              bank_account_holder, bank_name, bank_branch, bank_account_last4,
              profile_completed_at, created_at, updated_at)
  ON siton.seller_business_profiles TO siton_web_runtime;
GRANT INSERT, UPDATE ON siton.seller_business_profiles TO siton_web_runtime;
DROP POLICY IF EXISTS r2_web_select ON siton.seller_business_profiles;
CREATE POLICY r2_web_select ON siton.seller_business_profiles FOR SELECT TO siton_web_runtime USING (true);
DROP POLICY IF EXISTS r2_web_insert ON siton.seller_business_profiles;
CREATE POLICY r2_web_insert ON siton.seller_business_profiles FOR INSERT TO siton_web_runtime WITH CHECK (true);
DROP POLICY IF EXISTS r2_web_update ON siton.seller_business_profiles;
CREATE POLICY r2_web_update ON siton.seller_business_profiles FOR UPDATE TO siton_web_runtime USING (true) WITH CHECK (true);

-- Self-check: web must be able to read last4 but NOT the full number.
DO $verify$
BEGIN
  IF NOT has_column_privilege('siton_web_runtime', 'siton.seller_business_profiles', 'bank_account_last4', 'SELECT') THEN
    RAISE EXCEPTION 'siton_web_runtime is missing SELECT on bank_account_last4';
  END IF;
  IF has_column_privilege('siton_web_runtime', 'siton.seller_business_profiles', 'bank_account_number', 'SELECT') THEN
    RAISE EXCEPTION 'siton_web_runtime must NOT have SELECT on bank_account_number';
  END IF;
  IF NOT has_table_privilege('siton_web_runtime', 'siton.deal_chat_message_reactions', 'DELETE') THEN
    RAISE EXCEPTION 'siton_web_runtime is missing DELETE on deal_chat_message_reactions';
  END IF;
END
$verify$;
