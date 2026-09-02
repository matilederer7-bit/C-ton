-- 058 — P0.3 seller business onboarding profile.
--
-- Real business/compliance data collected for eventual settlement/provider
-- onboarding, WITHOUT inventing a Grow field contract: these are product
-- fields; provider mapping happens later through the provider abstraction.
--
-- SENSITIVE: bank_account_number is protected at the DATABASE layer — the Web
-- runtime receives a column-level SELECT grant that EXCLUDES it (staging file
-- 019); every read surface exposes only bank_account_last4. Filling fields
-- never auto-approves anything: verification / settlement / provider
-- readiness stay separate derived statuses.

BEGIN;

SET search_path TO siton, public;

CREATE TABLE IF NOT EXISTS siton.seller_business_profiles (
  seller_id TEXT PRIMARY KEY REFERENCES siton.seller_accounts(seller_id) ON DELETE CASCADE,
  business_name TEXT NULL,
  legal_name TEXT NULL,
  business_id_number TEXT NULL,
  entity_type TEXT NULL,
  contact_name TEXT NULL,
  contact_phone TEXT NULL,
  contact_email TEXT NULL,
  finance_email TEXT NULL,
  business_address TEXT NULL,
  bank_account_holder TEXT NULL,
  bank_name TEXT NULL,
  bank_branch TEXT NULL,
  bank_account_number TEXT NULL,
  bank_account_last4 TEXT NULL,
  profile_completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE siton.seller_business_profiles DROP CONSTRAINT IF EXISTS seller_business_profiles_entity_type_check;
ALTER TABLE siton.seller_business_profiles
  ADD CONSTRAINT seller_business_profiles_entity_type_check
  CHECK (entity_type IS NULL OR entity_type IN ('osek_patur','osek_murshe','company','amuta','partnership','other'));

COMMIT;
