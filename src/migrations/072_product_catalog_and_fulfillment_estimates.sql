-- Product catalog: reusable seller-owned Product identity + immutable Deal
-- snapshot, plus a structured fulfillment-estimate range on delivery options.
--
-- Ported from the shelf branch codex/amazon-benchmark-upgrade (its migration
-- 062) onto current master as 072. Additive compatibility migration: legacy
-- deals keep product_id NULL and continue rendering their deal-owned fields.
-- The closed deal_type set (physical_product / voucher / ticket) is unchanged;
-- Base44 remnants, the service deal type and the funnel-event extension of
-- the shelf branch were deliberately NOT carried.

SET search_path TO siton, public;

CREATE TABLE IF NOT EXISTS siton.products (
  product_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL REFERENCES siton.seller_accounts(seller_id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  short_description TEXT NOT NULL DEFAULT '' CHECK (char_length(short_description) <= 200),
  long_description TEXT NOT NULL DEFAULT '' CHECK (char_length(long_description) <= 4000),
  product_type TEXT NOT NULL CHECK (product_type IN ('physical_product','voucher','ticket')),
  category TEXT NOT NULL DEFAULT '' CHECK (char_length(category) <= 160),
  type_attributes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(type_attributes) = 'object'),
  fulfillment_defaults JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fulfillment_defaults) = 'object'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_seller_status_updated
  ON siton.products (seller_id, status, updated_at DESC);

-- Product imagery owns metadata independently from Deal imagery. The storage
-- object can be shared safely; application cleanup checks every metadata
-- reference before deleting the object.
CREATE TABLE IF NOT EXISTS siton.product_images (
  product_image_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES siton.products(product_id) ON DELETE CASCADE,
  storage_provider TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  public_url TEXT NULL,
  original_filename TEXT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, storage_provider, storage_key)
);

CREATE INDEX IF NOT EXISTS idx_product_images_product_order
  ON siton.product_images (product_id, is_primary DESC, sort_order ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_product_images_storage_ref
  ON siton.product_images (storage_provider, storage_key);

ALTER TABLE siton.deals ADD COLUMN IF NOT EXISTS product_id UUID NULL;
ALTER TABLE siton.deals ADD COLUMN IF NOT EXISTS product_snapshot_jsonb JSONB NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='deals_product_id_fkey' AND conrelid='siton.deals'::regclass
  ) THEN
    ALTER TABLE siton.deals
      ADD CONSTRAINT deals_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES siton.products(product_id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE siton.deals DROP CONSTRAINT IF EXISTS deals_product_snapshot_shape_check;
ALTER TABLE siton.deals ADD CONSTRAINT deals_product_snapshot_shape_check CHECK (
  product_snapshot_jsonb IS NULL OR jsonb_typeof(product_snapshot_jsonb) = 'object'
);
ALTER TABLE siton.deals DROP CONSTRAINT IF EXISTS deals_product_snapshot_presence_check;
ALTER TABLE siton.deals ADD CONSTRAINT deals_product_snapshot_presence_check CHECK (
  product_id IS NULL OR product_snapshot_jsonb IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deals_product_id
  ON siton.deals (product_id, created_at DESC) WHERE product_id IS NOT NULL;

-- Freeze the Product presentation at the Deal boundary once the Deal leaves
-- Draft. A Draft may still be re-pointed; anything published is immutable.
CREATE OR REPLACE FUNCTION siton.prevent_published_deal_product_snapshot_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.state <> 'Draft' OR NEW.state <> 'Draft')
     AND (NEW.product_id IS DISTINCT FROM OLD.product_id
          OR NEW.product_snapshot_jsonb IS DISTINCT FROM OLD.product_snapshot_jsonb) THEN
    RAISE EXCEPTION 'published Deal product association and snapshot are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deals_product_snapshot_immutable ON siton.deals;
CREATE TRIGGER trg_deals_product_snapshot_immutable
BEFORE UPDATE OF product_id, product_snapshot_jsonb ON siton.deals
FOR EACH ROW EXECUTE FUNCTION siton.prevent_published_deal_product_snapshot_change();

-- Structured fulfillment estimate, relative to Deal completion. NULL means the
-- seller did not claim a range.
ALTER TABLE siton.deal_delivery_options
  ADD COLUMN IF NOT EXISTS estimated_min_business_days INTEGER NULL;
ALTER TABLE siton.deal_delivery_options
  ADD COLUMN IF NOT EXISTS estimated_max_business_days INTEGER NULL;
ALTER TABLE siton.deal_delivery_options DROP CONSTRAINT IF EXISTS deal_delivery_options_estimated_min_check;
ALTER TABLE siton.deal_delivery_options ADD CONSTRAINT deal_delivery_options_estimated_min_check
  CHECK (estimated_min_business_days IS NULL OR estimated_min_business_days BETWEEN 0 AND 365);
ALTER TABLE siton.deal_delivery_options DROP CONSTRAINT IF EXISTS deal_delivery_options_estimated_max_check;
ALTER TABLE siton.deal_delivery_options ADD CONSTRAINT deal_delivery_options_estimated_max_check
  CHECK (estimated_max_business_days IS NULL OR estimated_max_business_days BETWEEN 0 AND 365);
ALTER TABLE siton.deal_delivery_options DROP CONSTRAINT IF EXISTS deal_delivery_options_estimated_range_check;
ALTER TABLE siton.deal_delivery_options ADD CONSTRAINT deal_delivery_options_estimated_range_check
  CHECK (
    estimated_min_business_days IS NULL OR estimated_max_business_days IS NULL
    OR estimated_max_business_days >= estimated_min_business_days
  );
