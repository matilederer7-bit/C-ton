BEGIN;

SET search_path TO siton, public;

ALTER TABLE IF EXISTS siton.deals
  ADD COLUMN IF NOT EXISTS seller_id TEXT;

UPDATE siton.deals
SET seller_id = 'seller-default'
WHERE seller_id IS NULL OR btrim(seller_id) = '';

CREATE INDEX IF NOT EXISTS idx_deals_seller_created
  ON siton.deals (seller_id, created_at DESC);

COMMIT;
