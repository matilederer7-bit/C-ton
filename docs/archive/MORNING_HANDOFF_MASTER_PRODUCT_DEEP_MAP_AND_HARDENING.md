# [SUPERSEDED — NOT CANONICAL] Morning Handoff - Master Product Deep Map and Hardening

> **STATUS: SUPERSEDED 2026-04-22.** The actor map below lists "Public visitor: search/discover" and "Affiliate: payout readiness" — both are **NOT part of the current product**. Canonical 2026-04-18 spec: no public search/discover (link-only Siton), and distributors are attribution-only (no payout, no commission). See [PROJECT_STATUS.md](/c:/Users/Lenovo/Documents/C-ton/PROJECT_STATUS.md) (Wave 4 Final Audit).

Last updated: 2026-03-31 (historical)

## Which Actors Exist And What They Can Do

- Public visitor:
  search/discover, open public deal pages
- Buyer:
  join, OTP, payment/auth, confirmation, tracking, recovery/re-entry
- Seller:
  create drafts, publish, inspect deals, view receipts, manage delivery
- Affiliate:
  inspect campaign performance, attribution, verification, payout readiness
- Admin:
  oversee deals/users, run KYC decisions, inspect settlements, manage support, inspect forensics, read system status

## What Was Already Strong

- backend core and state machines
- buyer flow
- system QA / hardening / torture / pre-live validation

## What Was Thin And Got Hardened

- admin system-status depth
- seller delivery semantic rules
- affiliate payout approval semantic rules

## What Still Feels Partial

- payment is still mock-backed
- notifications are still log-only
- live external rails are still inactive by design

## What Is External-Only

- payment provider activation
- invoice transport
- shipping carrier integration
- payout rail activation
- KYC provider activation
- support tooling / outbound notifications outside the repo

## Is The Product Now Much More Even In Depth

Yes.

Buyer flow is still the deepest single surface, but seller, affiliate, and admin are now materially less shallow and more internally hardened than before this pass.

## What Not To Reopen

- buyer quantity/join rules
- closed backend state-machine decisions
- canonical status-source cleanup
- already-closed product completion work

## Recommended Morning Step

Move to external-activation planning, not another generic internal-tightening loop.

Recommended order:
1. payment / invoice / payout-adjacent rail
2. KYC
3. shipping
4. outbound notifications and support tooling
