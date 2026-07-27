# Payment Provider Sandbox Readiness

## Canonical decision

**Canonical provider: Stripe.** This is an existing repository decision, not a new provider choice. The evidence is `src/payment_provider.ts`, `docs/BUYER_PAYMENT_PROVIDER_PRODUCTION_READINESS.md`, `docs/ENVIRONMENT_CONTRACT.md`, and the historical project status that names Stripe as the first real buyer-payment adapter. The generic `provider-ready` transport remains compatibility infrastructure; it is not a second selected provider.

No Stripe Sandbox credentials are present on this workstation. No real Sandbox API call, authorization, capture, release, refund, or webhook delivery was performed in Stage 6a. All provider behavior below was verified against deterministic contract servers and official Stripe protocol documentation only.

## Product money invariants

The adapter consumes the canonical positive integer `amount_minor` and ISO currency supplied by the business engine. It does not recalculate price, delivery, platform fee, or VAT. C-ton's fee remains 8% of product plus delivery, excluding the VAT component; distributor commission remains zero. Capture remains worker/outbox-driven and is not activated from a buyer request in this stage.

## Capability matrix

| Capability | Stripe protocol | Repository implementation | Contract tested | Real Sandbox tested | Remaining activation |
|---|---|---|---|---|---|
| Tokenization | Stripe.js/Elements PaymentMethod | Server accepts only `payment_method_id`; raw-card server tokenization refused | Yes | No | Configure Stripe.js/Elements with Sandbox publishable key |
| Authorization | Manual-capture PaymentIntent | `authorize`, `capture_method=manual`, provider id + correlation | Yes | No | Sandbox keys and interactive token |
| Status query | Retrieve PaymentIntent/Refund | `status` normalizes authorized/captured/released/refunded/pending/failed/unknown | Yes | No | Query real Sandbox objects |
| Capture | Capture PaymentIntent | `capture`, idempotency key, canonical minor amount | Yes | No | Isolated Sandbox proof only in Stage 6b; not product scheduling |
| Void/release | Cancel PaymentIntent | `release`, cancellation before capture, no blind retry after unknown outcome | Yes | No | Sandbox cancellation and status reconciliation |
| Refund | Create/retrieve Refund | `refund` and refund status normalization | Yes | No | Sandbox full/duplicate/over-refund proof |
| Signed webhooks | Raw body + `Stripe-Signature` | HMAC/timestamp verification, event ID ledger and duplicate handling | Yes | No | Register Sandbox endpoint and deliver real events |
| Out-of-order events | Stripe does not guarantee order | Canonical reconciliation classifies current DB truth and ignores invalid late transitions | Yes | No | Real event sequence proof |
| Idempotency | Stripe `Idempotency-Key` on POST | Correlation/idempotency key propagated on authorize/capture/release/refund | Yes | No | Same-key and changed-payload Sandbox proof |
| Unknown outcome | Retrieve authoritative object | Money call timeouts do not trigger blind new action; status query is available for reconciliation | Yes | No | Provider outage/response-loss Sandbox proof |
| Currency | Stripe supports ILS; API receives lowercase currency and integer minor units | Canonical default is ILS | Yes | No | Confirm Sandbox account/payment-method compatibility |

Official protocol references: [PaymentIntents](https://docs.stripe.com/api/payment_intents), [manual capture](https://docs.stripe.com/api/payment_intents/create), [cancel/release](https://docs.stripe.com/api/payment_intents/cancel), [refunds](https://docs.stripe.com/api/refunds/create), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), [signed webhooks and ordering](https://docs.stripe.com/webhooks), [Sandbox isolation](https://docs.stripe.com/sandboxes), [test PaymentMethods](https://docs.stripe.com/testing?testing-method=payment-methods), and [ILS support](https://docs.stripe.com/currencies).

## Required configuration

Web role:

- `PAYMENT_PROVIDER=stripe`
- `PAYMENT_PROVIDER_MODE=stripe`
- `PAYMENT_ENVIRONMENT=sandbox`
- `PAYMENT_PROVIDER_BASE_URL=https://api.stripe.com`
- `PAYMENT_PROVIDER_API_KEY` from the secret store, shaped `sk_test_*`
- `PAYMENT_PROVIDER_PUBLIC_KEY` from the secret store, shaped `pk_test_*`
- `PAYMENT_WEBHOOK_PROVIDER=stripe`
- `PAYMENT_WEBHOOK_SECRET` from the registered Sandbox endpoint, shaped `whsec_*`
- `PAYMENT_PROVIDER_TIMEOUT_MS=8000`
- `STRIPE_ALLOW_SERVER_SIDE_CARD_TOKENIZATION=0`

Worker role needs `PAYMENT_PROVIDER`, mode/environment/base URL, the Sandbox secret API key and timeout. It does not need the publishable key or webhook signing secret. No value belongs in source, example files, logs, CI artifacts, or client responses.

Safe Stripe test PaymentMethod identifiers such as `pm_card_visa` may be used only with `sk_test_*` credentials. No real card data may be used or stored.

## Guards

Production refuses mock mode, missing provider, Sandbox/test/demo environment, `sk_test_*`/`pk_test_*`, placeholders, non-canonical Stripe API base URL, missing role-specific secrets, combined Web/Worker role, and local storage. Sandbox Stripe refuses missing test credentials, live credentials, missing webhook secret, or provider/mode mismatch. There is no fallback to mock and no simulated success when Stripe is selected.

## Persistence, webhooks, and reconciliation

Stored payment data is limited to provider references, correlation/idempotency identifiers, canonical amounts/states, attempts, webhook event IDs, and audit/reconciliation metadata. PAN, expiry and CVV are excluded. Webhooks verify the raw body before ingestion; `(provider,event_id)` prevents duplicate processing. Heavy money transitions remain in the existing worker/outbox lane. Unknown results remain non-final and must be resolved by provider status or a signed event before another money action.

## Stage 6b blockers

1. Authorized Stripe Sandbox account and `sk_test_*`, `pk_test_*`, and endpoint-specific `whsec_*` secrets.
2. Registered HTTPS Sandbox webhook endpoint.
3. Stripe.js/Elements Sandbox tokenization path in an approved non-production deployment.
4. Real Sandbox evidence for authorization success/decline/3DS, release, isolated capture, refund, duplicate/mismatched idempotency, webhook replay/order, outage, restart and reconciliation.
5. Confirmation of account-level ILS/card-method availability and operational Radar rules.

Stage 6a repository readiness can be complete without credentials; external Sandbox proof remains explicitly blocked and must not be reported as passed.