# Product catalog — retired (record of migration 072)

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md` (§7: Siton has **no Product Library**), the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

## What was removed (PR B, 2026-09-30)

By owner decision the Product Library / Product Catalog is not part of Siton. PR B removed every
runtime surface that this document once described as current behaviour:

- **Routes (gone):** `POST /api/seller/products` (create / create-from-Deal),
  `PATCH /api/seller/products/:productId` (edit, revision bump),
  `POST /api/seller/deals/:dealId/product` (create a Deal from a Product / save as Product),
  `GET /api/seller/product-images/:productImageId` (private Product image bytes).
- **Modules (deleted):** `src/product_catalog.ts`, `src/product_enrichment.ts`,
  `web/src/productLibrary.ts`, `web/src/pages/sellerProducts.tsx`.
- **Seller UI (gone):** the Seller Product Library page and `#/seller/products*` routes, the
  "save as product" and "create from product" actions and the product-link panel in the deal editor.
- **Tests / scripts (gone):** `tests/product_catalog_validation.ts`,
  `tests/product_catalog_api_validation.ts` and the `npm run test:product-catalog` script.
  Replacement coverage: `tests/delivery_estimate_validation.ts` (delivery estimates were the
  only Product-era feature that stays, now owned by `src/delivery_estimate.ts` /
  `web/src/deliveryEstimate.ts`), and `tests/seller_creation_depth_validation.ts` S5b (a
  pre-removal Product-backed create replayed with its Idempotency-Key still recovers the stored
  response).
- **141 i18n keys** of the Product Library removed from the dictionaries.

## Schema retirement (PR C1 #161, PR C2 / migration 082, 2026-10-01)

Migration `072` is applied and stays untouched (applied migrations are never edited).

PR C1 (#161) removed the last **runtime dependency**: storage cleanup and the Deal-image /
Deal delete paths no longer query `siton.product_images`, and readiness no longer requires that
table. Shared-blob protection between Deal images stays (`tests/deal_images_validation.ts` D12).

PR C2 adds the forward migration `082_retire_product_library_schema.sql`, which drops the
Product Library schema only: the trigger `trg_deals_product_snapshot_immutable` and its function
`siton.prevent_published_deal_product_snapshot_change()`, the `deals` FK
`deals_product_id_fkey`, the CHECKs `deals_product_snapshot_presence_check` /
`deals_product_snapshot_shape_check`, the index `idx_deals_product_id`, the columns
`deals.product_id` / `deals.product_snapshot_jsonb`, and the tables `siton.product_images` and
`siton.products` (with their own indexes, constraints, RLS policies and grants). No `CASCADE`;
every statement is `IF EXISTS` (a rerun is a no-op). It refuses to run while
`siton.product_images` holds any row (a pointer to a stored blob needs an explicit disposition).
The staging grant file `supabase/staging/025_product_catalog_grants.sql` is retired with it.

Kept: the delivery-estimate columns 072 also added
(`deal_delivery_options.estimated_min/max_business_days` and their three CHECKs), every Deal,
participant, authorization / money state, payment evidence, outbox, idempotency and audit row,
and the legacy Product-backed create replay: a client `product_id` still enters the
`POST /deals` request hash so old `siton.idempotency_log` rows keep matching
(`tests/seller_creation_depth_validation.ts` S5b, which now also asserts the column is gone).

The staging census on 2026-10-01 (before and again at C2 build time) found 1 Product, 0 Product
images and exactly 2 Product-backed Deals; both are explicit `Smoke 20260917` fixtures with
snapshots, one with a participant in `JoinedAuthorized/AuthHeld`. Both Deals and that
participant stay; only their two Product columns go. **C2 is applied to staging only.**
Production execution remains blocked pending a fresh production census, explicit data
disposition, backup/rollback evidence and owner confirmation.

## Data model created by migration 072 (historical reference)

| Object | Notes |
|---|---|
| `siton.products` | seller-owned; `status` active/archived (never deleted by the web runtime); `revision ≥ 1`; `type_attributes` + `fulfillment_defaults` JSONB objects |
| `siton.product_images` | metadata per Product image; storage object could be shared with Deal images (reference-counted before deletion until C1) |
| `siton.deals.product_id` | FK `ON DELETE SET NULL`; `product_snapshot_jsonb` must be present when set |
| `siton.deal_delivery_options.estimated_min/max_business_days` | optional 0–365 range, `max ≥ min`; relative to Deal completion |

Staging grants were `supabase/staging/025_product_catalog_grants.sql` (web runtime only, RLS on,
no Data API exposure; retired with C2). Boot fail-closes on the migration ledger
(`REQUIRED_MIGRATION_IDS`, now through `082`); the Product tables left `REQUIRED_TABLES` in C1.
