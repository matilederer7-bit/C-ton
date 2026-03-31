# Demo / Preview Deployment Decision

## Executive Decision

`DEMO / PREVIEW READY WITH NON-BLOCKING GAPS`

## What Was Prepared

- Canonical demo / preview runtime mode
- Preview metadata surface for UI and validation
- Global preview banner in the frontend shell
- Guardrail messaging for payment, receipts, delivery, affiliate payout, and admin runtime status
- Demo-specific validation coverage
- Demo start command and deployment-ready runtime notes

## What Was Hardened For Demo

- Payment no longer relies on implicit understanding that it is mock-backed.
- Receipts no longer read like real invoices.
- Delivery no longer reads like live carrier execution.
- Affiliate payout no longer reads like live payout execution.
- Admin now shows explicit deployment mode and external activation boundary.

## What Was Explicitly Left As Demo-Only

- Payment authorization flow
- Receipt surface
- Delivery workflow surface
- Affiliate payout semantics
- KYC/admin operational semantics
- Notification dispatch visibility

## What Is Still External-Only

- Real payment provider
- Real invoice / accounting rail
- Real shipping provider
- Real payout rail
- Real KYC provider
- Real outbound notification delivery

## What Would Mislead Users If Not Guarded

- Presenting authorization as real charging
- Presenting receipts as externally issued invoices
- Presenting delivery status as proof of real shipment execution
- Presenting payout and KYC states as externally completed
- Presenting log-only notifications as sent messages

## Recommended Next Step

- Deploy only in explicit demo / preview mode.
- Present the product as a live showcase with internal-ready semantics, not as an activated commercial platform.
- Keep the next engineering step focused on staged external activation planning, one rail at a time.
