-- Migration 020: drop legacy distributor commission / payout columns.
--
-- Spec (Wave 2.5 purge, 2026-04-21): distributors are attribution-only. No
-- commission, no payout, no settlement. Prior migrations (018, 014, and
-- product_surface_support ensure helpers) left behind columns that encoded a
-- distributor money model. Those columns are now removed end-to-end.

BEGIN;

-- invoice_documents: the document contract no longer carries an affiliate fee.
ALTER TABLE siton.invoice_documents DROP COLUMN IF EXISTS affiliate_fee_amount;

-- affiliate_attributions: strip the three money/payout fields and the two
-- indexes that keyed on payout_status.
DROP INDEX IF EXISTS siton.idx_affiliate_attributions_deal;
DROP INDEX IF EXISTS siton.idx_affiliate_attributions_affiliate;

ALTER TABLE siton.affiliate_attributions DROP COLUMN IF EXISTS commission_rate;
ALTER TABLE siton.affiliate_attributions DROP COLUMN IF EXISTS commission_amount;
ALTER TABLE siton.affiliate_attributions DROP COLUMN IF EXISTS payout_status;

CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_deal
  ON siton.affiliate_attributions (deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_attributions_affiliate
  ON siton.affiliate_attributions (affiliate_id, created_at DESC);

-- affiliate_accounts: drop the distributor payout profile fields.
ALTER TABLE siton.affiliate_accounts DROP COLUMN IF EXISTS payout_status;
ALTER TABLE siton.affiliate_accounts DROP COLUMN IF EXISTS payout_method;
ALTER TABLE siton.affiliate_accounts DROP COLUMN IF EXISTS payout_details_masked;

COMMIT;
