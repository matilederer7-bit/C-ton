BEGIN;
SET search_path TO siton, public;

-- Add business-facing profile fields to seller_accounts.
-- These fields are separate from the internal display_name / auth fields.
-- business_name is shown publicly on deal pages; contact fields are shown to buyers.
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS business_name        TEXT NULL;
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS contact_name         TEXT NULL;
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS support_phone        TEXT NULL;
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS support_email        TEXT NULL;
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS business_description TEXT NULL;
ALTER TABLE siton.seller_accounts ADD COLUMN IF NOT EXISTS business_identifier  TEXT NULL;

COMMIT;
