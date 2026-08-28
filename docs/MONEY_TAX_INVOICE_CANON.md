# Money Tax Invoice Canon

Last updated: 2026-05-17

This document is the canonical C-ton decision for money, tax, invoices, refunds, seller reports, and seller settlement. It overrides older planning language when there is a conflict.

## Business Decision

- The seller sells the product or service to the buyer.
- C-ton provides platform, technology, and operational infrastructure services to the seller.
- C-ton is not presented as the product seller to the buyer.
- The seller is responsible for the product/service, delivery, legal product compliance, and buyer-facing tax documents, unless an invoice provider is explicitly connected to issue documents on the seller's behalf.
- C-ton issues the seller an invoice only for C-ton's platform fee.
- There is no distributor commission, distributor payout, distributor balance, or distributor invoice. Distributor/affiliate attribution is measurement only.

## Money Model

- `unit_price`: the seller-defined final unit price shown to the buyer.
- `quantity`: units joined and later charged for the participant.
- `shipping_amount`: delivery amount actually charged for the participant.
- `buyer_authorization_total`: expected hold amount at join time, `unit_price * quantity + shipping_amount`.
- `charged_gross_total`: actual collected buyer money only, product plus shipping, counted only from `ChargedSuccess` and `RecoveredCharge`.
- `buyer_vat_amount`: the buyer-side VAT component already included in the charged gross, supplied by authoritative tax/provider truth and otherwise `0`.
- `fee_calculation_base`: charged gross less buyer-side VAT, never below `0`.
- `platform_fee_base`: C-ton platform fee before VAT.
- `platform_fee_vat`: VAT charged by C-ton to the seller on the platform fee.
- `platform_fee_total`: total C-ton fee charged to the seller, including VAT.
- `seller_net`: amount payable to the seller before any later refund/settlement adjustments.
- `refunded_amount`: amount reversed after a captured charge.
- `seller_settlement_amount`: payable seller amount after refunds, holds, and reconciliation blockers.
- `attributed_gross`: distributor/affiliate measurement number only; it never changes fee, net, payout, or invoice amounts.

## Formulas

```text
fee_calculation_base = max(0, charged_gross_total - buyer_vat_amount)
platform_fee_base = fee_calculation_base * 0.08
platform_fee_vat = platform_fee_base * VAT_RATE
platform_fee_total = platform_fee_base + platform_fee_vat
seller_net = charged_gross_total - platform_fee_total
```

Example:

```text
charged_gross_total = 118
buyer_vat_amount = 18
fee_calculation_base = 100
VAT_RATE = 0.18
platform_fee_base = 8
platform_fee_vat = 1.44
platform_fee_total = 9.44
seller_net = 108.56
```

Shipping is included in `charged_gross_total` before buyer-side VAT is removed. For example, product plus shipping of 118 with an authoritative buyer VAT component of 18 produces a fee calculation base of 100.

## VAT Rule

- `VAT_RATE` is currently 18% for Israel and must be configured in one runtime constant: `SITON_PLATFORM_FEE_VAT_RATE`.
- The 18% rate is a current default, not a permanent hardcoded business assumption.
- C-ton charges the seller 8% plus VAT as required by law.
- C-ton does not calculate the seller's VAT liability toward the buyer. The seller is responsible for setting a lawful final buyer price and issuing the buyer document according to the seller's business type and the law.

## Document Rules

### Authorization Hold

- No receipt.
- No tax invoice.
- A join confirmation / authorization-hold confirmation is allowed.
- The buyer-facing price is the final expected hold/charge amount, not a C-ton tax document.

### Charge Success

- The buyer is entitled to the seller's document according to law.
- C-ton calculates `charged_gross_total`, `platform_fee_base`, `platform_fee_vat`, `platform_fee_total`, and `seller_net`.
- C-ton issues or records its platform-fee invoice to the seller only.

### Recovered Charge

- `RecoveredCharge` is identical to `ChargedSuccess` for collected-money accounting.
- It counts toward `charged_gross_total`, fee, seller net, seller reports, invoice rail, payout/settlement, and reconciliation.

### Failed Deal Without Charge

- No buyer tax document.
- No receipt.
- Failure notice only.
- `Dropped`, `AuthReleased`, and `ChargeFailed` states are not revenue and do not create fee or seller-net amounts.

### Failed Deal After Charges And Refunds

- A captured charge must not remain without a matching document path and refund/credit-note path.
- The system must record the charge, then record refund/credit-note or reconciliation evidence according to the invoice provider route.

### Refund

- Refund requires a matching cancellation/credit-note path through the invoice provider when provider issuance is active.
- Until full provider issuance is active, internal reconciliation documentation must show the refund adjustment and block misleading payable balances.

## Reporting Rule

Every money surface must align to the same calculation:

- seller dashboard
- seller export
- admin views
- invoice documents
- payout/settlement
- audit/reconciliation
- buyer tracking wherever an amount is shown

The canonical source for calculations is `src/platform_fee_money.ts`. Stored `platform_fee_money_events` are the provider-ready ledger truth for settlement and payout. Read surfaces may calculate fallback values from charged participants only when ledger rows are not present yet.

## Distributor Rule

- `attributed_gross` is measurement only.
- No commission.
- No payout.
- No balance.
- No invoice to the distributor.
- No effect on `seller_net`, `platform_fee_base`, `platform_fee_vat`, or `platform_fee_total`.

## Israel Invoices / Allocation Number

בחשבוניות המחייבות מספר הקצאה או דרישות דיווח נוספות לפי רשות המסים, ההפקה תתבצע דרך ספק חשבוניות התומך בדרישות הדין. ב-MVP אין לייצר מנגנון עצמאי כבד אם ספק החשבוניות עדיין לא מחובר בפועל.

## Current Code Alignment

- Platform fee rate: `SITON_PLATFORM_FEE_RATE = 0.08` in `src/platform_fee_money.ts`.
- Platform fee VAT rate: `SITON_PLATFORM_FEE_VAT_RATE`, default `0.18`, in `src/runtime_config.ts`.
- Collected gross: `qty * price_per_unit + delivery_cost`.
- Fee calculation base: `max(0, gross_amount - vat_amount)`.
- Counted collected-money states: `ChargedSuccess`, `RecoveredCharge`.
- Excluded non-revenue states: `Dropped`, `AuthReleased`, `ChargeFailedRecovery`, and authorization-only states.
- Seller analytics, seller Excel export, invoice document preparation, and payout settlement use the canonical calculation or stored platform-fee ledger rows.
- Invoice documents are queued after `DealCompleted` charge success or after `Refunded`, not at authorization hold.
- External invoice provider completion remains a provider dependency for live issuance, credit notes, allocation numbers, and tax-authority reporting.
