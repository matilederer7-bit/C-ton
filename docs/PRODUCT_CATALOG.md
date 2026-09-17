# Product catalog — reusable Products, frozen Deal snapshots

Updated: 2026-09-17. Source: shelf branch `codex/amazon-benchmark-upgrade`, ported onto current
`master` by the Claude shelf closeout (`claude/shelf-heavy-closeout-20260917`). Migration `071`.

## What it is

A **Product** is the presentation truth a seller maintains once: name, short/long copy,
category, typed attributes (per deal type), imagery and fulfillment defaults. A **Deal** is
the commercial event: price, quantities, deadline, delivery options, publication, money.

A Deal created **from** a Product copies the Product's presentation into
`deals.product_snapshot_jsonb` (schema_version 1, `product_revision`, `content_hash`) and its
images into `deal_images`. The snapshot is the Deal's truth from then on:

- editing the Product bumps `products.revision` and never touches an existing Deal;
- once a Deal leaves `Draft`, a database trigger refuses any change to `product_id` /
  `product_snapshot_jsonb` (`trg_deals_product_snapshot_immutable`);
- a Product-backed Draft's name/copy/type are snapshot-owned: the generic Draft editor answers
  `409 product_snapshot_fields_locked`; the seller edits the Product and re-creates the Draft.

Legacy / direct Deals keep `product_id = NULL` and behave exactly as before.

Product types are exactly the canonical deal types (`physical_product`, `voucher`, `ticket`).
The shelf branch's fourth `service` type, its funnel-event extension and its Base44 entity /
function were **not** carried (see "Not carried").

## Data model (migration 071)

| Object | Notes |
|---|---|
| `siton.products` | seller-owned; `status` active/archived (never deleted by the web runtime); `revision ≥ 1`; `type_attributes` + `fulfillment_defaults` JSONB objects |
| `siton.product_images` | metadata per Product image; storage object may be shared with Deal images (reference-counted before deletion) |
| `siton.deals.product_id` | FK `ON DELETE SET NULL`; `product_snapshot_jsonb` must be present when set |
| `siton.deal_delivery_options.estimated_min/max_business_days` | optional 0–365 range, `max ≥ min`; relative to Deal completion |

Staging grants: `supabase/staging/025_product_catalog_grants.sql` (web runtime only, RLS on,
no Data API exposure). Boot fail-closes until 071 is applied (`REQUIRED_TABLES`).

## Routes

| Route | Authority | Purpose |
|---|---|---|
| `GET /api/seller/products?status=active\|archived\|all&q=` | seller | library list (deal counts, primary image) |
| `GET /api/seller/products/:id` | seller | detail + images + Deal history with `snapshot_status` current/historical |
| `POST /api/seller/products` | seller (`create_draft`) | create; typed attributes validated per type |
| `PATCH /api/seller/products/:id` | seller (`operate`) | edit → revision N+1; `status` archive/restore; type is locked |
| `POST /api/seller/deals/:dealId/product` | seller (`operate`) | promote a Draft (fields + images) into a Product and attach the snapshot |
| `GET /api/seller/product-images/:id` | seller | private image read (owner-scoped) |
| `POST /deals` with `product_id` | seller | Deal from Product: title/copy/type from the snapshot; voucher/ticket terms default from the Product attributes; physical delivery estimates default from `fulfillment_defaults` |

Public deal payload (`/api/deals/:id/public`, seller preview) carries `product_id` and a
presentation-only `product` projection (no storage or seller internals), and every delivery
option carries `estimate_text` when an estimate exists.

## Publish readiness (Product-backed Deals only)

`POST /deals/:id/publish` answers `409 deal_product_readiness_failed` with `reason_code` listing
the blockers: `product_snapshot_missing`, `deal_image_missing`, `delivery_option_missing`,
`delivery_estimate_missing` (physical). Legacy Deals keep their existing rules.

## Seller UI (React `web/`)

- `#/seller/products` — library: search (name/category), status/type filters, sort; cards
  (never a desktop table); "יצירת עסקה מהמוצר", details, archive/restore; archived → explicit
  "שחזור ויצירת עסקה".
- `#/seller/products/new`, `#/seller/products/:id` — create/edit (type locked after creation,
  every save = new revision), images, Deal history with historical-revision marker.
- `#/seller/new?product=<id>` — the canonical wizard with the Product summary locked in step 1
  (price/quantities/delivery/deadline still per Deal); estimates prefilled from the Product.
- Seller deal screen — "המוצר בספרייה" panel, or "שמירה כמוצר" for a plain Draft; Draft editor
  disables snapshot-owned fields; delivery rows carry the estimate inputs.
- Buyer deal page — the estimate line under each delivery option.

Pure rules live in `web/src/productLibrary.ts` and `src/product_catalog.ts`
(`describeDeliveryEstimate` wording is shared).

## Enrichment

`src/product_enrichment.ts` is a provider seam only: no provider is selected or called, no
browser key exists. A future provider may only suggest; the seller approves.

## Tests

`npm run test:product-catalog` — `tests/product_catalog_validation.ts` (static + pure rules)
and `tests/product_catalog_api_validation.ts` (real app + database: seller isolation, snapshot
freezing, draft locking, publish readiness, trigger immutability, revisions/history, archive,
promotion, shared-blob image deletion, estimate validation).

## Not carried from the shelf branch (deliberate)

- `service` deal type + `deal_service_terms` (a new deal type is a product decision outside this
  closeout; every surface assumes the closed three-type set).
- Funnel-event extension (`otp_started` … `completed_purchase`) — emitters lived in the legacy
  `frontend/app.js`; the React app has its own funnel rail.
- Base44 `product.jsonc` entity and `siton-seller-product` function — Supabase/Postgres and the
  Fastify backend are the source of truth.
- Legacy `frontend/app.js` / `product-library.js` UI — replaced by the React pages above.
