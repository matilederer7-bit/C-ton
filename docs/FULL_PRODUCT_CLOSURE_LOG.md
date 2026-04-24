# [SUPERSEDED — NOT CANONICAL] FULL PRODUCT CLOSURE LOG

> **STATUS: SUPERSEDED 2026-04-22.** The "Public marketplace expansion: STARTED" framing below was **reverted** by the canonical product direction adopted on 2026-04-18. Siton has no public marketplace, no catalog, no search, no browse surface. Distributor economic subsystems referenced here were dismantled in Wave 2.5. See [PROJECT_STATUS.md](/c:/Users/Lenovo/Documents/C-ton/PROJECT_STATUS.md) (Wave 4 Final Audit) for current truth.

## Before This Pass

- Buyer flow was real and validated end-to-end:
  public deal page, join, OTP, payment authorization mock, confirmation, tracking.
- Backend, internal closure, full-system QA, adversarial hardening, and preprod torture QA were already in place.
- Product reality was still heavily buyer-centric.
- Seller, affiliate, and admin mostly existed in docs, not as working product surfaces.
- Public discovery, search, and marketplace-style browsing did not exist in the original spec and did not exist in the product.

## Phase A - Canonical Product Surface Audit

- Buyer surface: `CLOSED`
- Seller surface: `OPEN`
- Affiliate / distributor surface: `DOCUMENTED_ONLY`
- Admin surface: `DOCUMENTED_ONLY`
- Public marketplace search/catalog: `NOT_IN_CURRENT_SCOPE` in the original spec, but now explicitly requested as expansion
- Backend support already present:
  deals, publish, join, OTP, tracking, payment attempts, audit, outbox, webhook events
- Backend support still missing for full product breadth:
  seller identity model, affiliate attribution persistence, KYC queues, payouts, receipts, delivery entities, support hub

## Phase B - Seller Surface Closure

- Added seller workspace API and UI:
  list deals, create draft, publish draft, seller deal detail, create similar
- Seller surface now maps to real backend endpoints:
  `/deals`, `/deals/:id/publish`, read-side seller APIs
- Edit lock after publish is now visible in the UI and aligned to current backend rules.
- Seller live/closed deal view is now real.

## Phase C - Affiliate / Distributor Surface Closure

- Added affiliate overview surface and share-link generation.
- Affiliate surface is intentionally marked `PARTIAL`.
- Reason:
  backend does not yet persist affiliate attribution, verification, payouts, or settlement state.

## Phase D - Admin Surface Closure

- Added admin overview surface with:
  dashboard totals, exceptional deals, omnisearch, deal profile, user profile
- Admin read surface now exists on top of live backend truth.
- System status is linked to `/health` and `/health/integrations`.

## Phase E - Cross-Surface Consistency

- Seller, buyer, and admin all read from the same deal and participant truth.
- Payment attempts on seller/admin surfaces now use `result_class`, matching the actual schema.
- Publish lock semantics are consistent across seller UI and backend rules.

## Phase F - Product Expansion Boundary

- Original current spec:
  link-based buyer entry, no public catalog, no Amazon-style mall
- New user request in this pass:
  public search and deals visible to everyone
- Decision:
  this is `PRODUCT EXPANSION`, not merely missing completion from the original spec
- Action taken:
  started the expansion with a real public marketplace discovery/search surface

## Surface Classification After This Pass

- Buyer: `CLOSED`
- Seller: `PARTIAL TO MOSTLY CLOSED`
- Affiliate: `PARTIAL`
- Admin: `PARTIAL TO MOSTLY CLOSED`
- Public marketplace expansion: `STARTED`

## Remaining Gaps

- Seller receipts: not implemented
- Seller delivery surface: not implemented
- Affiliate attribution and payouts: not implemented in backend model
- Admin onboarding / KYC queue: not implemented
- Admin payouts, settlements, support hub, and forensics workflow: not implemented
