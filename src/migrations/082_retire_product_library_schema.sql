-- Product Library C2: retire the Product Library schema created by migration 072.
--
-- Forward-only. Migration 072 is never edited. The runtime stopped reading or
-- writing every object dropped here in PR B (#151, surface removal) and PR C1
-- (#161, the last three siton.product_images reference checks and the
-- product_images readiness requirement), so nothing that runs reads them.
--
-- Dropped (and nothing else):
--   trigger  siton.deals.trg_deals_product_snapshot_immutable
--   function siton.prevent_published_deal_product_snapshot_change()
--   deals    FK deals_product_id_fkey, CHECKs deals_product_snapshot_presence_check /
--            deals_product_snapshot_shape_check, index idx_deals_product_id,
--            columns product_id and product_snapshot_jsonb
--   tables   siton.product_images, siton.products (with their own indexes,
--            constraints, RLS policies and grants)
--
-- Kept, deliberately: the delivery-estimate columns 072 also added
-- (siton.deal_delivery_options.estimated_min_business_days /
-- estimated_max_business_days and their three CHECK constraints) are a live
-- feature. No Deal, participant, authorization / money state, payment
-- evidence, outbox row, idempotency row or audit row is deleted or updated:
-- the only row data that disappears is the Product rows themselves and the two
-- Product columns of siton.deals. The runtime keeps the legacy Product-backed
-- create replay (a client product_id still enters the POST /deals request
-- hash) because it never read those columns.
--
-- No CASCADE anywhere: an unexpected dependent object (a view, a function, a
-- policy elsewhere) makes this migration fail instead of being dropped
-- silently. Every statement is IF EXISTS, so a rerun is a no-op.
--
-- Guard: a siton.product_images row is a pointer to a stored blob that may
-- still exist; dropping it would orphan the blob without a decision. Staging
-- holds none (census 2026-10-01). On any database that does, this migration
-- refuses until that data has an explicit disposition (production requires a
-- fresh census, data disposition and backup/rollback evidence first).

-- (The row check is dynamic SQL: a static reference to the table would fail
-- to plan once the table is gone, and a rerun must be a no-op.)
DO $c2_guard$
DECLARE
  has_product_images BOOLEAN := FALSE;
BEGIN
  IF to_regclass('siton.product_images') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM siton.product_images)' INTO has_product_images;
  END IF;
  IF has_product_images THEN
    RAISE EXCEPTION 'product library C2: siton.product_images still holds rows; dispose of the Product image blobs explicitly before retiring the schema';
  END IF;
END
$c2_guard$;

DROP TRIGGER IF EXISTS trg_deals_product_snapshot_immutable ON siton.deals;
DROP FUNCTION IF EXISTS siton.prevent_published_deal_product_snapshot_change();

ALTER TABLE siton.deals DROP CONSTRAINT IF EXISTS deals_product_id_fkey;
ALTER TABLE siton.deals DROP CONSTRAINT IF EXISTS deals_product_snapshot_presence_check;
ALTER TABLE siton.deals DROP CONSTRAINT IF EXISTS deals_product_snapshot_shape_check;
DROP INDEX IF EXISTS siton.idx_deals_product_id;
ALTER TABLE siton.deals DROP COLUMN IF EXISTS product_snapshot_jsonb;
ALTER TABLE siton.deals DROP COLUMN IF EXISTS product_id;

DROP TABLE IF EXISTS siton.product_images;
DROP TABLE IF EXISTS siton.products;

DO $c2_assert$
BEGIN
  IF to_regclass('siton.products') IS NOT NULL OR to_regclass('siton.product_images') IS NOT NULL THEN
    RAISE EXCEPTION 'product library C2: Product tables still exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'siton' AND table_name = 'deals'
      AND column_name IN ('product_id', 'product_snapshot_jsonb')
  ) THEN
    RAISE EXCEPTION 'product library C2: Product columns still exist on siton.deals';
  END IF;
  IF to_regprocedure('siton.prevent_published_deal_product_snapshot_change()') IS NOT NULL THEN
    RAISE EXCEPTION 'product library C2: Product snapshot trigger function still exists';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'siton' AND table_name = 'deal_delivery_options'
        AND column_name IN ('estimated_min_business_days', 'estimated_max_business_days')) <> 2 THEN
    RAISE EXCEPTION 'product library C2: delivery-estimate columns must survive';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'siton.deal_delivery_options'::regclass
        AND conname IN ('deal_delivery_options_estimated_min_check',
                        'deal_delivery_options_estimated_max_check',
                        'deal_delivery_options_estimated_range_check')) <> 3 THEN
    RAISE EXCEPTION 'product library C2: delivery-estimate constraints must survive';
  END IF;
END
$c2_assert$;
