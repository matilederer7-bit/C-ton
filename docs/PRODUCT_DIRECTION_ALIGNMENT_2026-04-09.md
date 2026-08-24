# Siton Product Direction Alignment

Last updated: 2026-08-23

The 2026-04 direct-link-only decision was valid for the prior V1 definition
and is intentionally superseded by Siton V1.1.

## Canonical Decision

- Siton is a group-deal platform with two first-class entry paths: direct deal
  links and the public Siton Mall.
- `/app` is the single public Mall/landing surface; it must communicate the
  product clearly and discover published deals without duplicating Deal Details.
- Publishing automatically makes a deal eligible for discovery. Drafts never
  appear. Historical published outcomes remain visible as honest seller/deal
  evidence.
- Direct deal links remain first-class and open the same canonical deal page as
  Mall cards.
- The Mall is a public read projection. It never owns deal state, inventory,
  money, settlement, payment, or distributor attribution.
- Core deal logic stays strict: no new states, no weakening of money-state or buyer-state rules, no weakening of the 90% rule, no confusion between authorization and actual charge, and no return of per-buyer purchase caps beyond total `max_units`.

## What Stays

- Direct-link public deal page
- Public Mall discovery of published physical-product, voucher, and ticket deals
- Buyer OTP flow
- Authorization-only payment join flow
- Buyer tracking page
- Seller draft creation and basic deal management
- Strict state, audit, idempotency, locking, completion-window, and inventory enforcement

## What Remains Out Of Scope

- A second Mall-specific Deal Details implementation
- Arbitrary free-text public search or unbounded filters in V1.1
- A second state, inventory, money, settlement, or attribution truth
- Distributor commission, wallet, balance, payout, or entitlement

## Current V1

- Strong Siton main site
- Focused Siton Mall with bounded type/outcome filters and publication ordering
- Seller deal creation
- Personal public deal page
- Direct distribution link
- Buyer quantity and delivery-option selection
- OTP
- Authorization only until deal closes successfully
- Buyer tracking
- Basic seller management

The detailed binding decision is
`docs/SITON_V1_1_MALL_PRODUCT_DIRECTION.md`.
