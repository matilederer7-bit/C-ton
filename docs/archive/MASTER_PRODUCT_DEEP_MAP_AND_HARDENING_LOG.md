# [SUPERSEDED — NOT CANONICAL] Master Product Deep Map and Hardening Log

> **V1.1 clarification (2026-08-23):** the no-public-discovery conclusion below
> was superseded. Current canon is direct deal links plus the focused public
> Mall; distributor payout/commission remains excluded.

> **STATUS: SUPERSEDED 2026-04-22.** The surface map below references `/app/marketplace` and "expansion marketplace/search surface" which are **NOT part of the current product**. Canonical 2026-04-18 direction: link-only Siton, no public marketplace/search. Affiliate "payout readiness" described here was **dismantled** in Wave 2.5 — distributors are attribution-only. See [PROJECT_STATUS.md](/c:/Users/Lenovo/Documents/C-ton/PROJECT_STATUS.md) (Wave 4 Final Audit).

Last updated: 2026-03-31 (historical)

## Phase A - Master Role and Surface Map

### Public visitor / guest

- Role: discovers public deal surfaces and the expansion marketplace/search surface.
- Surfaces:
  - `/app`
  - `/app/marketplace`
  - `/app/deal/:id`
- Maturity: `STRONG`

### Buyer / repeat buyer

- Role: joins deals, verifies phone, authorizes payment, tracks progress, re-enters flows.
- Surfaces:
  - deal page
  - OTP
  - payment/auth
  - confirmation
  - tracking
- Maturity: `STRONG`

### Seller

- Role: creates/publishes deals and operates completed deals.
- Surfaces:
  - seller dashboard
  - new draft
  - seller deal detail
  - receipts
  - delivery operations
- Maturity before pass: `GOOD`

### Affiliate / distributor

- Role: monitors attributed campaign performance, payout readiness, verification, and commissions.
- Surfaces:
  - affiliate overview
  - campaign view
  - payout profile
  - verification/payout states
- Maturity before pass: `GOOD`

### Admin

- Role: operational oversight across all actors.
- Surfaces:
  - dashboard
  - omnisearch
  - exceptional deals
  - KYC queue
  - settlements
  - support hub
  - forensics
  - system status
- Maturity before pass: `GOOD`, with system-status depth thinner than buyer flow

### External system actors

- Payment provider: `PARTIAL` internally, `EXTERNAL-ONLY` live
- Invoice transport: `EXTERNAL-ONLY`
- Shipping provider: `EXTERNAL-ONLY`
- KYC provider: `EXTERNAL-ONLY`
- Payout rail: `EXTERNAL-ONLY`
- Notification channels: `PARTIAL` boundary, `EXTERNAL-ONLY` live delivery

## Phase B - Backend Deep Layer Map

- Very strong:
  - DB invariants
  - deal / buyer / money state machines
  - idempotency
  - audit
  - outbox and reconciliation
- Good but bounded:
  - payment boundary
  - webhook ingestion
  - seller/admin/affiliate support
- Thin spots found:
  - delivery semantics allowed shallow updates
  - affiliate payout admin mutation was too permissive
  - admin system-status surface was not first-class

## Phase C - Frontend and UX Deep Layer Map

- `DEEP`: public deal, join, OTP, payment/auth, confirmation, tracking
- `SOLID`: seller dashboard/detail, affiliate overview, admin dashboard
- `PARTIAL/THIN` before this pass:
  - admin system status readability
  - seller delivery guidance
  - affiliate/admin payout semantic clarity

## Phase D - Cross-Layer Consistency Findings

- Buyer semantics were already deepest.
- Seller/admin/affiliate semantics were real, but slightly shallower around operational rules and system observability.
- The system now needed internal hardening more than new features.

## Phase E - Hardening Closure Summary

- Hardened seller delivery rules
- Hardened affiliate payout approval rules
- Added explicit admin system-status surface
- Added dedicated depth validation coverage

## Phase F - Revalidation Summary

- `node --check frontend/app.js` passed
- `npx tsc --noEmit` passed
- `npm run test:master-depth` passed
- `npm test` passed
- `.tmp_test_dist` was removed after validation
- no lingering `node` process remained

## Phase G - Final Assessment

- The deepest pre-existing surface is still buyer flow.
- After this pass, seller/admin/affiliate are materially less shallow:
  - seller delivery now enforces stronger operational semantics
  - affiliate payout approval now enforces verification + payout-profile + pending-commission semantics
  - admin now has a real connected system-status surface instead of only references to health endpoints
- Remaining thinness is no longer internal product neglect. It is almost entirely tied to external activation.
