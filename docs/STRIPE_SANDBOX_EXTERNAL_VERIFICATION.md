# Stripe Test Mode external verification

## Authorization-only scope (Stage 6b-1b-b-1)

The manual workflow now accepts only the required `proof_scope=authorization-only` choice together with `confirm_test_mode_only=yes`. Missing or unknown scope fails before provider code; missing credentials retain the explicit `Stripe Sandbox external verification not executed` result.

The authorization-only module can call only the canonical adapter's `authorize` and `status` contracts. It proves manual-capture authorization, authoritative status, same-key replay, changed-payload rejection and an official Test Mode decline. Its provider interface and entrypoint contain no Release/Cancel, Capture, Refund or cleanup call, including failure paths. Live credentials remain blocked.

A successful authorization intentionally remains pending for the separately approved Release stage. The filtered artifact stores amount, currency, canonical status, creation time, hashed internal references, and the provider reference encrypted with AES-256-GCM. The encryption key is derived at runtime from the protected Environment webhook secret; neither the raw provider reference, encryption key, client secret, provider response, authorization header nor card data is stored. The next protected stage can decrypt the handoff with the same Environment secret and must release promptly; operators must not run authorization-only unless the next Release window is scheduled.

The three Environment secrets remain absent, so no Stripe request or external workflow execution occurred during this code/CI stage.

## Current state

Repository preparation is complete, but external verification has not executed because authorized `sk_test_*`, `pk_test_*`, and `whsec_*` values are not present in the local environment. This is not a pass for Stage 6b-1.

## GitHub protected configuration

Create the protected GitHub Environment `stripe-sandbox`, require an authorized reviewer, and add only these encrypted environment secrets:

- `STRIPE_SANDBOX_SECRET_KEY`: Stripe Test Mode secret key (`sk_test_*`).
- `STRIPE_SANDBOX_PUBLISHABLE_KEY`: Stripe Test Mode publishable key (`pk_test_*`).
- `STRIPE_SANDBOX_WEBHOOK_SECRET`: signing secret for the approved Test Mode endpoint (`whsec_*`).

Never place values in repository variables, workflow YAML, artifacts, issue comments, commit messages, or job summaries. The manual workflow `Stripe Sandbox authorization and release proof` is never triggered by a push or pull request. Invoke it with `confirm_test_mode_only=yes`. Missing secrets produce the explicit report `Stripe Sandbox external verification not executed`; the provider-proof job remains skipped.

## Implemented external harness

`npm run test:stripe-sandbox-external` refuses malformed/missing credentials before importing the adapter. With authorized Test Mode credentials it uses the canonical adapter and official Stripe test PaymentMethod identifiers to prove:

1. one ILS PaymentIntent with `capture_method=manual`;
2. authoritative `requires_capture` status normalized to `authorized`;
3. same-key replay returns the same PaymentIntent;
4. changed payload with the same key is rejected;
5. the official declined PaymentMethod is normalized without a generic 500 or unsafe retry;
6. cancel/release and same-key replay;
7. authoritative status after release is `released`;
8. cleanup releases an authorization if an assertion fails.

The harness contains no Capture or Refund invocation, card number, PAN, expiry, CVC/CVV, customer data, or secret output. Its report includes only a short SHA-256 prefix derived from the provider reference, never the raw identifier or provider response.

## Remaining external proof

Stage 6b-1 remains blocked until an authorized operator supplies the protected Test Mode secrets and endpoint. The first approved execution must additionally record, without sensitive payloads:

- a real signed Test Mode event for the created PaymentIntent, invalid-signature rejection and duplicate event idempotency;
- response-loss proxy evidence for authorization and release followed by authoritative status reconciliation;
- filtered provider request/event references;
- confirmation that no active authorization remains.

Do not mark the stage complete from contract tests or a skipped provider-proof job. Do not run Capture or Refund; those belong to Stage 6b-2.

Official references: [PaymentIntent creation and manual capture](https://docs.stripe.com/api/payment_intents/create), [PaymentIntent lifecycle and idempotency](https://docs.stripe.com/payments/payment-intents), [official test PaymentMethods](https://docs.stripe.com/testing?testing-method=payment-methods), [cancelling a PaymentIntent](https://docs.stripe.com/api/payment_intents/cancel), and [Stripe CLI webhook forwarding](https://docs.stripe.com/stripe-cli/use-cli).