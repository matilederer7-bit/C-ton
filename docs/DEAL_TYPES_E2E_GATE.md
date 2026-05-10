# Deal Types E2E Gate

Status: `DEAL_TYPES_E2E_PASS_READY_FOR_PROVIDER_SANDBOX`

Date: 2026-05-10

## Verdict

The Deal Types E2E Gate is pass-ready for Provider Sandbox Validation. The gate
ran against the real Fastify runtime and a real PostgreSQL demo database. No
live money was performed, no live provider was connected, no state machine was
changed, and no money logic was changed.

## Scope Checked

- Physical product regression: default `deal_type`, public deal surface,
  buyer join, and tracking without voucher/ticket fulfillment fields.
- Voucher full flow: required terms, public copy, buyer join, Completed-only
  issuance, `qty=N` to N fulfillment units, no plaintext code persistence,
  buyer tracking last4-only display, seller export, redemption ownership, and
  idempotent redemption.
- Ticket full flow: required terms, assigned-seat rejection, public event copy,
  Completed-only issuance, ticket export, check-in ownership, and idempotency.
- Failed deal: `deadline_check` Failed branch issues zero fulfillment units.
- Mission Control E1: `deal_type_readiness.deals_by_type` and
  `fulfillment_readiness.fulfillment_units_total` now reflect real database
  data instead of poisoned-transaction zeros.
- Guardrails: no manual refund route, JSON boundary preserved, no plaintext
  fulfillment codes, notification templates present, and completed webhook
  replay remains idempotent.

## Root Cause Fixed

`buildAdminMissionControlPayload` ran its collectors inside one transaction.
An upstream webhook collector queried `siton.webhook_events.created_at`, but the
table's real timestamp is `received_at`. PostgreSQL aborted the transaction on
that first error; later `safeQuery` calls then returned empty rows. That made
`deal_type_readiness` and `fulfillment_readiness` report zeros even while the DB
contained deals and fulfillment units.

## Fix

- Corrected Mission Control webhook timestamp reads to use `received_at`.
- Aliased webhook trace fields to the actual schema (`request_id AS
  correlation_id`, `received_at AS created_at`, and explicit `NULL` for fields
  not stored on `webhook_events`).
- Wrapped Mission Control `safeQuery` calls in per-query SAVEPOINT handling so
  one collector failure no longer poisons downstream collectors.
- Hardened the Deal Types E2E mock-charge harness so deterministic
  `temporary_fail` outcomes can be retried as distinct mock provider attempts.
- Corrected the Full E2E deterministic mock capture prediction key from
  `charge:` to the provider's real `capture:` key.

## Validation

Passed:

- `npx tsc --noEmit`
- `npx tsc -p tsconfig.test.json`
- `npm run test:deal-types`
- `npm run test:deal-types-e2e`
- `npm run test:full-e2e-gate`
- `npm run test:refund-policy`
- `npm run test:json-boundary`
- `npm run test:provider-live-money-readiness`
- `npm run test:mission-control`
- `npm run test:admin-control-plane`
- `npm run test:security-hardening`
- `npm run test:security-identity-tracking`
- `npm run test:adversarial`
- `npm run test:frontend-browser-smoke`
- `npm run test:notifications-readiness`
- `npm run test:support-operations`
- `npm run test:legal-trust`
- `npm run test:production-launch-readiness`
- `npm audit --omit=dev`
- `npm audit`

`npm run bootstrap:demo-db` was not run in this pass because no migration or
bootstrap path changed.

## Still Open

- Seller-uploaded voucher codes.
- Assigned-seat ticketing engine.
- Voucher expiry reminders.
- Ticket event reminders.
- Provider Sandbox Validation.
