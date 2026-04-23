# Buyer Payment Provider Production Readiness

## Current Decision

Siton supports a first real buyer-payment adapter for Stripe behind the canonical payment provider abstraction. Stripe-specific behavior stays inside `src/payment_provider.ts`; the domain continues to consume normalized authorization, capture, recovery, refund, and webhook reconciliation results.

The canonical money model is unchanged:

- `platform_fee_base_amount`
- `platform_fee_vat_amount`
- `platform_fee_total_amount`

## Request Thread Rules

Allowed in request thread:

- Payment method token reference intake from a secure provider component.
- Buyer authorization before deal closure, using an existing provider `payment_method_id`.

Not allowed in request thread:

- Capture.
- Recovery charge.
- Refund.
- Reconcile state changes.
- Webhook-driven state changes outside the webhook reconciliation path.

Capture, recovery, refund, and reconcile remain worker/outbox driven.

## PCI And Tokenization

Production does not allow server-side raw card tokenization. The frontend must use Stripe.js/Elements to obtain a `payment_method_id`; Siton stores only provider references.

`STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION=1` exists only for non-production test/dev validation. Production startup fails if that flag is enabled.

Siton must never store raw PAN, CVV, or card expiry. `buyer_payment_methods` stores only:

- `buyer_id`
- `provider_code`
- `provider_payment_method_id`
- lifecycle status
- correlation and operational timestamps

## Webhook Verification

Stripe webhooks are verified against the raw request body and `stripe-signature`. The adapter also accepts the existing internal `x-webhook-signature` path for provider-ready compatibility.

Invalid signatures are recorded in `payment_webhook_security_events` for operations visibility.

Webhook dedupe remains based on `(provider, event_id)` in `webhook_events`. Duplicate and late webhooks must not mutate visible state twice.

## Idempotency

Outbound provider calls use correlation IDs as idempotency keys. Worker-side payment attempts continue to persist `unknown` before I/O and finalize to `success`, `temporary_fail`, or `permanent_fail`.

## Operations

`GET /api/admin/payment-ops-status` reports:

- Attempt outcomes by type.
- Webhook processed/ignored/failed/pending counts.
- Duplicate/ignored rate.
- Webhook signature failure count.
- Buyer payment method lifecycle counts.
- Provider configuration and transport readiness.

## External Activation Still Required

- Live Stripe API keys.
- Live `PAYMENT_WEBHOOK_SECRET`.
- Stripe.js/Elements frontend integration.
- Production webhook endpoint validation through the deployed runtime.
- Operational allowlists/risk controls.
