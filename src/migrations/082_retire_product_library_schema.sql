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
-- Locks first, bounded: the drops need ACCESS EXCLUSIVE on siton.deals.
-- Taking it (and the Product tables') up front, before the guard reads them,
-- means no lock upgrade mid-file (no deadlock against a SELECT ... FOR UPDATE
-- then UPDATE on deals) and no write between the guard and the drops; the
-- timeout keeps a long-running transaction from queueing all Deal traffic
-- behind this migration on a path that sets none (Supabase apply_migration).
SET LOCAL lock_timeout = '5s';
LOCK TABLE siton.deals IN ACCESS EXCLUSIVE MODE;
DO $c2_lock$
BEGIN
  IF to_regclass('siton.product_images') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE siton.product_images IN ACCESS EXCLUSIVE MODE';
  END IF;
  IF to_regclass('siton.products') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE siton.products IN ACCESS EXCLUSIVE MODE';
  END IF;
END
$c2_lock$;

-- Guard (fail closed, per database). The migration is in the manifest, so it
-- reaches every database the runner touches; it must never drop Product data
-- without a recorded decision for THAT database:
--   * a siton.product_images row points at a stored blob: always refused —
--     the blobs need an explicit disposition first;
--   * a siton.products row, or a Deal with product_id / product_snapshot_jsonb
--     set: refused unless the applying transaction carries the explicit
--     disposition flag  SET LOCAL siton.product_library_c2_disposition = 'accepted'
--     (set only after a fresh census and an owner-approved data disposition
--     for that database; it is outside this file, so the ledger checksum is
--     unchanged). Staging: owner instruction 2026-10-01, census unchanged.
--     Production: not approved.
--   * an empty or fresh database passes without the flag.
-- Row checks are dynamic SQL: a static reference would fail to plan once the
-- objects are gone, and a rerun must be a no-op.
DO $c2_guard$
DECLARE
  disposition TEXT := coalesce(current_setting('siton.product_library_c2_disposition', true), '');
  has_product_images BOOLEAN := FALSE;
  has_products BOOLEAN := FALSE;
  has_product_deals BOOLEAN := FALSE;
BEGIN
  IF to_regclass('siton.product_images') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM siton.product_images)' INTO has_product_images;
  END IF;
  IF to_regclass('siton.products') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM siton.products)' INTO has_products;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'siton' AND table_name = 'deals' AND column_name = 'product_id') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM siton.deals WHERE product_id IS NOT NULL)' INTO has_product_deals;
  END IF;
  IF NOT has_product_deals AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'siton' AND table_name = 'deals' AND column_name = 'product_snapshot_jsonb') THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM siton.deals WHERE product_snapshot_jsonb IS NOT NULL)' INTO has_product_deals;
  END IF;
  IF has_product_images THEN
    RAISE EXCEPTION 'product library C2: siton.product_images still holds rows; dispose of the Product image blobs explicitly before retiring the schema';
  END IF;
  IF (has_products OR has_product_deals) AND disposition <> 'accepted' THEN
    RAISE EXCEPTION 'product library C2: this database holds Product rows or Product-backed Deals; run a census, record an owner-approved data disposition, then apply with SET LOCAL siton.product_library_c2_disposition = ''accepted'' in the same transaction';
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
