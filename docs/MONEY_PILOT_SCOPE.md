# Money Pilot Scope

> **V1.1 product-scope notice (2026-08-23):** references that assume a
> direct-link-only product are historical. The Mall is a read/discovery layer
> and does not change any money-pilot boundary in this document.

Status: narrow pilot proposal only. This does not declare live-money readiness.
Do not run this as a real-money pilot until provider sandbox dry-run evidence,
admin/debug production guards, export consistency, and the conditional-deal user
test plan have all passed.

## Goal

Run one controlled paid pilot to prove that C-ton can handle a conditional deal
with understandable buyer wording, correct authorization/capture behavior,
consistent seller export, and limited support load.

## First Seller Fit

Best first seller: one known, trusted seller with operational capacity and a
simple direct-buyer audience. A good first use case is a farmer or producer who
wants to sell a defined bulk quantity directly without wholesale marketing.

Suitable products:

- single physical product
- fixed unit price
- clear quantity and deadline
- seller-controlled delivery or pickup
- low dispute risk

Not suitable for the first pilot:

- regulated goods
- perishable goods without same-day seller logistics readiness
- custom products
- warranty-heavy products
- products requiring C-ton to manage shipping, fulfillment, installation, or
  commercial disputes

## Limits

- One seller.
- One deal.
- Maximum 30 buyers.
- Maximum total buyer authorization exposure: ILS 10,000.
- Maximum duration: 7 days from publish to completion/failure.
- No public marketplace, catalog, or search.
- No distributor commission.
- No manual refund path.

## Responsibility Boundary

C-ton provides the deal room, buyer joining flow, OTP gate, payment
authorization/capture/refund state machine, audit trail, seller export, and
read-only operational visibility.

The seller is responsible for product accuracy, stock reality, delivery,
pickup, warranty, customer service, and commercial dispute handling outside the
money state machine.

## Success Metrics

- Deal reaches threshold and completes, or fails cleanly with automatic release
  or refund behavior.
- Buyers can explain when they are charged.
- No unexplained capture.
- No suspected duplicate charge.
- Seller export matches backend money calculations.
- Seller asks to run a follow-up deal.

## Failure Metrics

- Buyers do not understand authorization versus capture.
- Seller expects C-ton to manage delivery or commercial responsibility.
- Money differs between provider, DB, and export.
- Support requires heavy manual intervention.
- Any buyer disputes the timing or amount of capture.

## Kill Criteria

- Suspected double charge.
- Capture before the deal success condition.
- Provider/DB mismatch that cannot be reconciled.
- Unknown payment state older than the operational threshold.
- Buyer confusion around charge timing.
- Seller requires C-ton to take responsibility for fulfillment, warranty, or a
  commercial refund outside the product rules.
