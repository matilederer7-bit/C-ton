# Legal / Trust / Compliance Surfaces

Status: surfaces and copy contracts validated against the spec. Final legal text remains the responsibility of legal counsel before live launch.

## Source Of Truth

- Buyer terms, payment disclosure, refund policy and seller terms are versioned in `src/legal_policy_versions.ts`.
- Each acceptance is recorded in `siton.legal_acceptances` with actor, deal id, participant id, version, and timestamp.

## Buyer Surface

- The buyer payment screen never says "you were charged" before charging completes. It says the credit framework is held.
- The recovery screen explains that the previous payment did not go through and asks for a new method.
- The failed screen says no charge was made and explains that a held framework will be released by the issuing bank.
- The completed screen says charging has been performed only when the deal is in `Completed` state.

## Seller Surface

- Publish requires explicit acceptance of the seller terms (recorded as `legal_acceptances.acceptance_type='seller_publish_terms'`).
- The seller is identified as the responsible party for fulfillment; Siton does not own delivery.
- Siton commission is fixed at 8% and is shown without per-deal configuration.

## Distributor / Affiliate Surface

- No commission to distributors. The product surface deliberately omits any commission, balance, or payout metric for affiliates.
- The product spec is enforced by `tests/admin_affiliate_no_commission_regression_validation.ts`.

## Admin Surface

- No "manual refund", "manual capture", or "edit money" admin action exists.
- Admin actions never delete audit, outbox, or webhook rows.
- Admin actions surface bounded reason and audit fields only.

## Footer Links

The Hebrew footer links the four legal surfaces:

- Terms (`/app/terms`)
- Privacy (`/app/privacy`)
- Refund policy (`/app/refunds`)
- Contact (`/app/contact`)

`tests/legal_trust_validation.ts` asserts that those routes are registered as part of the `app` shell so the footer links never 404.

## Accessibility

- `lang="he"` and `dir="rtl"` are set on the document root.
- Tap targets and focus states are visible in the design system.
- Forms expose labels and grouped descriptions.

## Privacy / Security Copy

- Tracking links are tokenized; the buyer is never told a bare link is private.
- Recovery links do not include card data.
- Logging hardening is documented in `docs/LOGGING_HARDENING.md`.

## Validation

- `npm run test:legal-trust`
- `npm run test:legal` (existing legal trust layer test)
- `npm run test:platform-fee-payments`
