# Marketplace Payments 8 Percent

## Official money model

Siton works as a marketplace/platform-fee system, not as a default model of late manual seller collection.

When money is actually captured from a buyer, the canonical financial truth is now recorded per participant-level financial event in `siton.marketplace_money_events`.

The supported canonical event types are:

- `charge_captured`
- `recovery_captured`
- `refund_issued`

Each row carries signed settlement truth for:

- `gross_amount`
- `vat_amount`
- `fee_base_amount`
- `platform_fee_rate`
- `platform_fee_amount`
- `seller_net_amount`
- provider correlation fields
- payout readiness / settlement status

Positive rows represent captured money.
Negative rows represent refund adjustments.

## 8 percent rule

The official Siton platform fee is fixed:

- `platform_fee_rate = 0.08`

There is no per-deal fee override in the live fee calculation path.

## Fee base

The fee base is:

- actual amount collected from the buyer
- excluding VAT

Canonical formula:

- `fee_base_amount = gross_amount - vat_amount`
- `platform_fee_amount = 8% * fee_base_amount`
- `seller_net_amount = gross_amount - platform_fee_amount`

In the current internal runtime, VAT is not yet sourced from an external tax rail, so `vat_amount` is recorded explicitly and currently defaults to `0` unless a future provider-ready path supplies a real tax component.

This keeps the model provider-ready without pretending that a live tax provider is already connected.

## No affiliate fee

There is no affiliate / distributor fee in the money model.

Affiliate remains attribution and analytics only.

This means:

- no affiliate fee calculation in marketplace settlement truth
- no affiliate fee line item in the new settlement rail
- no affiliate fee branch in charge or refund settlement logic

Legacy schema remnants may still exist in older compatibility tables, but they are not part of the live settlement computation path.

## Refund handling

Refunds are modeled as signed reversal rows.

When `refund_issued` is processed:

- gross refund impact is recorded as a negative row
- fee impact is recorded as a negative row
- seller net impact is recorded as a negative row
- payout readiness becomes non-payable for the refunded participant truth

Duplicate refund events are ignored by unique guards and do not create duplicate reversals.

If a legacy participant reaches refund processing without a prior canonical charge row, the settlement layer backfills a single charge anchor and then records the refund reversal, so net seller receivable truth still lands correctly at zero instead of drifting negative forever.

## Duplicate protection

The settlement layer blocks duplicate money truth in three ways:

- one canonical charge row per participant
- one canonical refund-adjustment row per participant
- unique provider event identity when a provider event id exists

This protects against:

- duplicate charge webhook processing
- duplicate refund webhook processing
- retry loops that would otherwise create duplicate seller receivable

## Provider-ready boundary

The current implementation is provider-ready, not provider-live.

What is ready now:

- canonical signed financial event storage
- fixed 8% calculation
- VAT-aware fee base shape
- seller net derivation
- refund reversal semantics
- provider code / provider event id / provider reference / correlation tracking
- duplicate-safe settlement recording

What is not yet externally activated:

- real marketplace split / application-fee rail at a live payment provider
- real tax / invoice provider activation
- live payout rail

## Files that now own this logic

- `src/marketplace_money.ts`
- `src/app.ts`
- `scripts/init_db.sql`
- `src/migrations/019_marketplace_money_events.sql`
- `tests/marketplace_payments_8_percent_validation.ts`

## Practical meaning

After this pass, the system can now answer, per participant-level successful capture or refund:

- how much was actually collected
- what VAT amount was considered
- what fee base was used
- how much Siton keeps
- how much belongs to the seller
- how refunds reverse that truth

without relying on late manual fee collection as the canonical default.
