# Adversarial Hardening Log

## 2026-03-31 Phase A - Threat-Oriented System Map

High-risk surfaces:
- `/deals` creation path because malformed numeric and datetime input can corrupt the contract or trigger runtime exceptions.
- `/deals/:id/*` state-transition endpoints because invalid route params and broken sequences can trigger the wrong failure semantics.
- `/webhooks/payments/mock` because malformed payloads, duplicates, and weird ordering can damage reconciliation if validation is soft.
- `/api/otp/*` because stale, missing, or malformed session input can mislead the buyer flow.

Medium-risk surfaces:
- `/api/deals/:id/public` and `/api/participants/:id/tracking` because invalid identifiers can turn into DB-facing errors if not validated early.
- Idempotent actions such as publish and join, where replay and conflicting payload reuse must remain deterministic.
- Frontend route entry into OTP, payment, confirmation, and tracking without the expected user journey context.

Low-risk surfaces:
- Static frontend shell routes and health endpoints under the current internal operating model.

Domain invariants that must not break:
- `max_units` remains the only quantity cap.
- duplicate logical actions must not create double mutation.
- webhook duplicates must not create extra state transitions.
- tracking must not imply success that did not happen.

Operational blind spots reviewed:
- accidental `500` on sequence abuse
- accidental `500` on malformed create payloads
- invalid UUIDs reaching the DB layer
- malformed webhook payloads being accepted as if valid

## 2026-03-31 Phase B - API and Input Abuse Pass

Attacks run:
- invalid datetime on deal creation
- invalid numeric price on deal creation
- invalid min/max quantity on deal creation
- malformed deal UUID in public, join, and debug-adjacent paths
- malformed participant UUID in tracking
- malformed webhook body with non-string ids and non-object payload

What broke before hardening:
- create payload validation was too permissive and could fall into DB/runtime errors
- invalid UUID route params were not blocked early enough
- webhook shape validation was too soft

What was fixed:
- explicit numeric, integer, datetime, and UUID validation was added
- malformed webhook bodies now reject with `400`
- invalid identifiers now reject cleanly with `400`

## 2026-03-31 Phase C - Flow, Session, and State Abuse Pass

Attacks run:
- OTP start with invalid phone
- OTP verify without session id
- join against draft deal
- prepare/start charging out of sequence
- direct entry into frontend flow routes without context

What broke before hardening:
- sequence-abuse paths like `prepare_charging` and `charging/start` could collapse into `500` instead of controlled conflict handling

What was fixed:
- broken-sequence state errors are now normalized as `409 invalid_state_transition`
- OTP session preconditions are stricter
- phone format for OTP start is validated more tightly

## 2026-03-31 Phase D - Idempotency, Duplicate, Webhook, and Reconciliation Abuse Pass

Attacks run:
- duplicate publish with same idempotency key
- duplicate join with conflicting payload under same idempotency key
- duplicate webhook same event id
- unknown webhook event type
- malformed webhook payload

What was proven:
- duplicate publish remains deterministic
- conflicting idempotent join payload is rejected with `400`
- duplicate webhook stays safe and idempotent
- unknown webhook events are ignored safely
- malformed webhook requests are rejected before ingestion

## 2026-03-31 Phase E - Frontend Adversarial UX Pass

Attacks run:
- direct navigation into OTP/payment/confirmation routes
- tracking without valid participant context
- invalid OTP and missing OTP session
- authorization failure path

What was proven:
- frontend shells stay reachable without crashing
- backend-facing contracts stay explicit under bad flow entry
- buyer-facing failure semantics stay coherent enough for the current MVP/internal stage

## 2026-03-31 Phase F - Data Integrity and Operational Weird-State Pass

What was proven:
- `npx tsc --noEmit` passed after hardening
- `npm test` passed after hardening
- health and integration health remain intact
- no stuck `node` process remained after the validation run
- no temporary runtime corruption surfaced from the abuse pass

## 2026-03-31 Phase G - Final Adversarial Outcome

Hardening conclusion:
- The meaningful internal adversarial gaps that surfaced were fixed.
- The remaining softness is tied to deliberately inactive external integrations, not to unresolved internal breakage.
