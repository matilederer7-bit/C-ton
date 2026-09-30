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

## What still exists (schema only, until PR C)

Migration `072` is applied and stays untouched (applied migrations are never edited). The
tables `siton.products`, `siton.product_images` and the columns `deals.product_id`,
`deals.product_snapshot_jsonb` therefore still exist, and `product_images` stays in the runtime
schema contract because the storage-cleanup worker and the deal-image delete paths still consult
it so a blob shared with a retained legacy row is never deleted. A later forward migration (PR C,
Lean Refactor step D4) drops the table set together with those reference checks — only after the
staging census (2026-09-30: 40 deals, 2 with product columns, both `PendingTarget` smoke deals of
2026-09-17, 1 product, 0 product images), an owner decision on those two rows, and for production
either ledger proof that 072 was never applied there or a production census with an explicit data
disposition and owner confirmation.

## Data model created by migration 072 (historical reference)

## Data model (migration 072)

| Object | Notes |
|---|---|
| `siton.products` | seller-owned; `status` active/archived (never deleted by the web runtime); `revision ≥ 1`; `type_attributes` + `fulfillment_defaults` JSONB objects |
| `siton.product_images` | metadata per Product image; storage object may be shared with Deal images (reference-counted before deletion) |
| `siton.deals.product_id` | FK `ON DELETE SET NULL`; `product_snapshot_jsonb` must be present when set |
| `siton.deal_delivery_options.estimated_min/max_business_days` | optional 0–365 range, `max ≥ min`; relative to Deal completion |

Staging grants: `supabase/staging/025_product_catalog_grants.sql` (web runtime only, RLS on,
no Data API exposure). Boot fail-closes until 072 is applied (`REQUIRED_TABLES`).
