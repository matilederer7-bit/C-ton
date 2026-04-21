# Platform Fee Payments - 8 Percent Before VAT, Plus VAT On Siton Fee

## Official money model

Siton charges a fixed 8% platform fee on money actually collected from buyers,
excluding buyer-side VAT from the fee base itself. VAT is then added on Siton's
fee only. This is a settlement and fee model, not a buyer-facing marketplace
model - buyers enter through direct deal links, not through public discovery or
catalog browsing.

When money is actually captured from a buyer, the canonical financial truth is
recorded per participant-level financial event in `siton.platform_fee_money_events`.

The supported canonical event types are:

- `charge_captured`
- `recovery_captured`
- `refund_issued`

Each row carries signed settlement truth for:

- `gross_amount`
- `vat_amount`
- `fee_base_amount`
- `platform_fee_rate`
- `platform_fee_vat_rate`
- `platform_fee_base_amount`
- `platform_fee_vat_amount`
- `platform_fee_total_amount`
- `platform_fee_amount`
- `seller_net_amount`
- provider correlation fields
- payout readiness and settlement status

Positive rows represent captured money.
Negative rows represent refund adjustments.

## 8 percent rule plus VAT on Siton fee

The official Siton platform fee is fixed:

- `platform_fee_rate = 0.08`
- `platform_fee_vat_rate = VAT on Siton fee only`

There is no per-deal fee override in the live fee calculation path. The legacy
per-deal `commission_rate` field is no longer consulted in the settlement math.

## Fee base

The fee base is:

- actual amount collected from the buyer (`qty * price_per_unit + delivery_cost`)
- excluding buyer-side VAT
- including delivery, clearing, and operational costs - the fee is computed on
  the full collected amount, not on the product subtotal alone

Canonical formula:

- `fee_base_amount = gross_amount - vat_amount`
- `platform_fee_base_amount = 8% * fee_base_amount`
- `platform_fee_vat_amount = VAT(platform_fee_base_amount)`
- `platform_fee_total_amount = platform_fee_base_amount + platform_fee_vat_amount`
- `platform_fee_amount = platform_fee_total_amount` as the compatibility alias used by existing runtime paths
- `seller_net_amount = gross_amount - platform_fee_total_amount`

In the current internal runtime, buyer-side VAT is not yet sourced from an
external tax rail, so `vat_amount` is recorded explicitly and currently defaults
to `0` unless a future provider-ready path supplies a real tax component. The
VAT rate applied on Siton's fee is configured through `SITON_PLATFORM_FEE_VAT_RATE`
and currently defaults to `0.18`.

This keeps the model provider-ready without pretending that a live tax provider
is already connected.

## No affiliate or distributor fee

There is no affiliate or distributor fee in the money model.

Distributor remains attribution and analytics only.

This means:

- no distributor fee calculation in settlement truth
- no distributor fee line item in the settlement rail
- no distributor fee branch in charge or refund settlement logic
- legacy columns (`commission_rate`, `commission_amount`, `payout_status`,
  `payout_method`, `payout_details_masked`, `affiliate_fee_amount`) were dropped
  in Wave 2.5 (migration `020_drop_affiliate_legacy_columns.sql`)

## Refund handling

Refunds are modeled as signed reversal rows.

When `refund_issued` is processed:

- gross refund impact is recorded as a negative row
- platform fee base impact is recorded as a negative row
- platform fee VAT impact is recorded as a negative row
- seller net impact is recorded as a negative row
- payout readiness becomes non-payable for the refunded participant truth

Duplicate refund events are ignored by unique guards and do not create duplicate
reversals.

If a legacy participant reaches refund processing without a prior canonical
charge row, the settlement layer backfills a single charge anchor and then
records the refund reversal, so net seller receivable truth still lands correctly
at zero instead of drifting negative forever.

## Duplicate protection

The settlement layer blocks duplicate money truth in three ways:

- one canonical charge row per participant (partial unique index on
  `logical_entry_type = 'charge'`)
- one canonical refund-adjustment row per participant (partial unique index on
  `logical_entry_type = 'refund_adjustment'`)
- unique provider event identity when a provider event id exists

Note that "one charge row per participant" is about settlement-row uniqueness per
`participant_id`, not buyer uniqueness. A single buyer can become multiple
participants on the same deal through repeat purchases - each participant gets
its own settlement rows.

This protects against:

- duplicate charge webhook processing
- duplicate refund webhook processing
- retry loops that would otherwise create duplicate seller receivable

## Provider-ready boundary

The current implementation is provider-ready, not provider-live.

What is ready now:

- canonical signed financial event storage
- fixed 8% fee-base calculation
- explicit fee-base / fee-VAT / fee-total breakdown
- seller net derivation
- refund reversal semantics
- provider code / provider event id / provider reference / correlation tracking
- duplicate-safe settlement recording
- provider abstraction summary for authorize / capture / recover / refund

What is not yet externally activated:

- real platform-fee split or application-fee rail at a live payment provider
- real tax or invoice provider activation
- live payout rail

## Files that own this logic

- `src/platform_fee_money.ts`
- `src/payment_provider.ts`
- `src/app.ts`
- `src/product_surface_support.ts`
- `scripts/init_db.sql`
- `src/migrations/019_platform_fee_money_events.sql`
- `tests/platform_fee_payments_8_percent_validation.ts`

## Practical meaning

After this pass, the system can answer, per participant-level successful capture
or refund:

- how much was actually collected
- what buyer-side VAT amount was considered
- what fee base was used
- how much Siton keeps before VAT
- how much VAT applies on Siton's fee
- how much Siton keeps in total
- how much belongs to the seller
- how refunds reverse that truth

without relying on late manual fee collection as the canonical default.
