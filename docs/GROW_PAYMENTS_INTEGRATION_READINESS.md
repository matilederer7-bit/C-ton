# Grow Payments Integration Readiness

Status: internal adapter and offline contract tests complete; Sandbox and
Production activation not executed.

## Boundary

Grow logic is isolated in `src/grow_payment_adapter.ts` and adapted to Siton's
canonical `PaymentProvider` in `src/payment_provider.ts`. The browser never
sends raw card data to Siton and never calls Grow's server API. It receives only
a provider-hosted HTTPS payment URL and an opaque Siton reference. Process and
transaction tokens are AES-256-GCM sealed before persistence or return across
the canonical boundary.

The implementation follows the reviewed Grow/Meshulam server contract for a
suspended/delayed J4/J5-style authorization, status lookup, settlement, and
refund. All endpoint paths are configuration boundaries because the exact
provisioned account/product contract must be confirmed in Sandbox; code does
not silently substitute a fake production endpoint.

## Implemented contract

- URL-encoded server transport with bounded timeout
- externally provisioned `userId` / `pageCode` and optional API key
- HTTPS success, cancellation, and notification URLs
- hosted payment initiation returning pending-provider-confirmation
- encrypted process/transaction reference
- authoritative process/transaction status lookup
- delayed capture/settlement and refund mapping
- correlation IDs and stable callback event identity
- callback data treated as untrusted until authoritative lookup
- 4xx permanent, retryable 408/409/425/429/5xx, and transport UNKNOWN mapping
- malformed-response, timeout, reset, duplicate/out-of-order callback tests
- recursive secret/token redaction and production fail-closed configuration

## Configuration

Set server-side only: `PAYMENT_PROVIDER=grow`, `PAYMENT_PROVIDER_MODE=grow`,
`PAYMENT_PROVIDER_BASE_URL`, `GROW_USER_ID`, `GROW_PAGE_CODE`, optional
`GROW_API_KEY`, `GROW_REFERENCE_ENCRYPTION_KEY`, `GROW_SUCCESS_URL`,
`GROW_CANCEL_URL`, and `GROW_NOTIFY_URL`. Confirm any `GROW_*_PATH` override
against the credentials/account documentation supplied by Grow.

Missing identifiers, encryption material, or HTTPS return URLs make the
adapter `configured=false`; a production runtime refuses to start it. There is
no fallback to mock success and UNKNOWN does not change money state.

## Offline proof and remaining external work

`npm run test:grow-adapter` exercises the real serializer/parser through an
in-memory transport and passes Sandbox/Production URL separation, J4/J5
mapping, lookup, capture, refund, malformed/4xx/5xx/timeout/reset behavior,
callback replay/order, sealed references, and redaction without network.

External only: open the Grow account, obtain Sandbox identifiers, confirm the
provisioned endpoint/field variant, enter secrets, whitelist callback/return
URLs if required, run controlled Sandbox authorization/status/settlement/
refund/replay tests, obtain Grow approval, and only later authorize production.
If the real account contract differs from the reviewed documentation, that is
a provider-discrepancy fix, not an intentionally omitted product feature.
