# Full System QA Log

## 2026-03-31 Phase A - System Reality Map

System flow map:
- Public deal page loads from `/api/deals/:id/public` and is rendered by `/app/deal/:dealId`.
- OTP starts through `/api/otp/start` and verifies through `/api/otp/verify`.
- Payment authorization runs through `/api/payments/authorize-mock`, which already sits behind the provider boundary.
- Join persists through `/deals/:id/join`.
- Confirmation is presented through `/app/join/:dealId/confirmation`.
- Tracking is served by `/api/participants/:id/tracking` and rendered by `/app/track/:participantId`.
- Payment lifecycle transitions continue internally through webhook ingestion and reconciliation at `/webhooks/payments/mock`.

What is real vs mock-backed:
- Real inside the repo: deal creation, publish, join, OTP session handling, participant tracking, webhook ingestion, duplicate handling, domain reconciliation.
- Mock-backed by design: payment provider execution and notifications.
- Translation layer: frontend copy and route state are mapped from backend states returned by the public and tracking APIs.

Known blind spots at the start of this pass:
- Full-system QA had not yet been expressed as one dedicated suite across all layers.
- OTP verify response shape was slightly less explicit than the OTP start response.

## 2026-03-31 Phase B - End-to-End Customer Journey QA

What was proven:
- A buyer can move from public deal page to OTP to payment authorization to join to confirmation to tracking.
- Backend responses and frontend route surfaces stay aligned through the happy path.
- Tracking copy remains coherent for the joined-authorized state.
- Confirmation and tracking shells remain reachable after join.

Fix applied in this phase:
- OTP verify response now includes `ok: true`, matching the rest of the frontend-facing API contract.

## 2026-03-31 Phase C - Cross-Layer State and Contract QA

What was proven:
- Availability from the public deal API matches actual join behavior under capacity pressure.
- `stock_exhausted` is returned when capacity is full and join rejects with `409`.
- Unknown deals surface as `404`.
- Payment authorization failure remains mapped as `402 authorization_failed`.
- Tracking semantics stay coherent across:
  - `JoinedAuthorized`
  - `ChargedSuccess`
  - `Recovered`
  - `Dropped`

## 2026-03-31 Phase D - Error, Recovery, and Session QA

What was proven:
- draft deal remains non-joinable
- cancelled deal remains non-joinable
- capacity exceeded remains explicit
- invalid OTP remains `400`
- missing OTP session remains `404`
- payment failure remains `402`
- unknown tracking remains `404`
- charged, recovered, and dropped states remain understandable through tracking

Session and recovery conclusion:
- The current internal flow remains recoverable enough for the MVP stage.
- No cross-layer ambiguity surfaced that would force reopening flow design.

## 2026-03-31 Phase E - Observability and Operational QA

What was proven:
- `/health` returns `ok`
- `/health/integrations` returns integration summaries
- webhook auth rejection returns `401`
- `npx tsc --noEmit` passed
- `npm test` passed
- the new full-system QA suite passed
- no stuck `node` process remained after test execution

Operational conclusion:
- The system is understandable both functionally and operationally under the current internal model.

## 2026-03-31 Phase F - Final QA Outcome

Outcome summary:
- The system now has explicit evidence that backend, frontend, internal integration, reconciliation, and observability hold together as one product.
- The meaningful remaining gaps are external-activation gaps, not internal system-coherence blockers.
