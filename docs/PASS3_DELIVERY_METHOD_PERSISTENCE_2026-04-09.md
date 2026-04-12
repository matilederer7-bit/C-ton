# Delivery Method Persistence Pass

Date: 2026-04-09

## Decision

Delivery semantics are now modeled as:

- `siton.deal_delivery_options` for seller-defined options on the deal
- participant-level snapshot fields for the buyer choice:
  - `delivery_option_id`
  - `delivery_method_type`
  - `delivery_method_label`
  - `delivery_cost`

This keeps seller configuration normalized while preserving the exact buyer-selected delivery context for tracking, seller management, and repeat joins.

## What Changed

- Added `deal_delivery_options` schema and participant delivery snapshot columns
- Added migration `016_delivery_method_persistence.sql`
- Updated bootstrap/init SQL paths
- Wired seller deal creation to persist delivery options
- Wired buyer join flow to require or auto-select delivery method before authorization
- Persisted delivery method and cost on join
- Returned delivery data in:
  - public deal payload
  - join response
  - buyer tracking payload
  - seller deal payload
- Updated frontend deal page, payment summary, confirmation, tracking, and seller management surfaces
- Added validation coverage in frontend and product-surface tests

## Guardrails Preserved

- No new product states were introduced
- Repeat joins for the same buyer remain allowed
- Inventory enforcement remains global at the deal level
- Authorization vs charge semantics remain unchanged
- Delivery cost stays separate from `price_per_unit`

## Validation

- `node --check frontend/app.js`
- `npm run test:frontend`
- `npm run test:product-surface`
- `npx tsc -p tsconfig.test.json --noEmit`
