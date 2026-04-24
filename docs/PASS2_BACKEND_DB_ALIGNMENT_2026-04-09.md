# [HISTORICAL] Pass 2 Backend + DB Alignment

> **Note 2026-04-22:** references below to `/app/marketplace` as a "compatibility route and legacy wording" reflect Apr 2026 state. The canonical current product has no public marketplace route at all. See [PROJECT_STATUS.md](/c:/Users/Lenovo/Documents/C-ton/PROJECT_STATUS.md).

Last updated: 2026-04-09 (historical)

## Verdict

- Backend and DB were only partially aligned.
- Repeat buyer joins were already allowed in practice.
- Seller ownership was not modeled on `deals`, which was a critical seller-first gap.
- Public marketplace API had already been deprecated, but compatibility routes and old wording still remain in parts of the repo.

## Fixed In This Pass

- Added seller ownership support to `deals` via `seller_id`.
- Backfilled existing deals to `seller-default`.
- Filtered seller surfaces by seller ownership instead of listing every deal globally.
- Exposed a direct deal link on the seller detail surface.
- Added automated validation for repeated joins by the same buyer on the same deal.

## Critical Open Gaps

- Buyer delivery-method selection is still not modeled in DB or backend state. The current buyer flow has quantity and payment semantics, but no persisted delivery choice.
- Seller identity is still default/internal rather than a full authenticated multi-seller flow.
- `/app/marketplace` remains as a compatibility route and should be treated as temporary legacy.
- Affiliate and admin surfaces are still present in active navigation even though they are not part of the immediate seller-first public positioning.

## Repeat Join Rule

- No `UNIQUE (deal_id, buyer_id)` exists in the live `siton.participants` schema.
- Join flow inserts a fresh `participant` for each valid join.
- Aggregation and reporting sum by `deal_id`, not by unique buyer.
- Admin buyer profile already lists multiple joins for the same buyer.
- Added test coverage to keep this rule enforced.

## Recommended Next Pass

1. Persist buyer delivery method and delivery cost semantics in DB + backend + buyer flow.
2. Replace default seller ownership with explicit seller identity/session semantics.
3. Remove or redirect temporary legacy compatibility routes and copy.
