# Observability Contract

This contract defines the practical request/correlation model now used by Siton.

## IDs

- `request_id`: one HTTP request. Accepted from `x-request-id` only when it is safe (`A-Z`, `a-z`, digits, `.`, `_`, `:`, `-`, length 8-160). Otherwise the server generates `req:<uuid>`.
- `correlation_id`: one investigation flow. Accepted from `x-correlation-id` with the same safety rules. Otherwise the server generates `corr:<uuid>`.
- Every HTTP response returns `x-request-id` and `x-correlation-id`.

## Current Coverage

Coverage is `partial`, not full.

- HTTP: `request_id` and `correlation_id` are assigned globally.
- Audit: new atomic transition audit rows can carry `request_id` and `correlation_id`.
- Idempotency: new transition idempotency rows can carry both IDs.
- Outbox: new atomic outbox rows can carry both IDs.
- Payment attempts: existing provider/payment rail already stores `correlation_id`.
- Invoices: existing invoice rail already stores `correlation_id`.
- Payouts: existing payout rail already stores `correlation_id`.
- Notifications: Phase 2 adds `correlation_id` and `request_id` columns.
- Support/operational cases: Phase 2 adds `correlation_id` and `request_id` columns.
- Admin actions: every `admin_action` requires `correlation_id` and may carry `request_id`.

## Missing / Partial

- Worker log propagation is still partial.
- Some older legacy direct inserts do not yet write correlation data.
- Webhooks can link by provider event/payment references, but external providers do not always send an original correlation id.
- Admin second approval identity enforcement now uses session identity for hardened Admin Actions.
- Admin MFA is available as an email-OTP foundation and required for high-trust actions; live pilot still needs enrollment and recovery runbooks.

## Rules

- Do not fabricate a historical correlation link without evidence.
- If a link is uncertain, Mission Control must show `missing` or `partial`, not `full`.
- Raw provider payloads, secrets, cookies, authorization headers and card data are never returned.
- Observability never edits deal state, buyer state, money state or money amounts.

## Trace Surface

`GET /api/admin/mission-control/correlation/:correlationId` aggregates:

- audit
- outbox
- webhooks
- payments
- invoices
- payouts
- notifications
- support cases
- admin actions

The endpoint returns `correlation_coverage` per domain.
