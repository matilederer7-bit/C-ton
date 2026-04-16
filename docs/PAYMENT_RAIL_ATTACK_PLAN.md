# Payment Rail Attack Plan

## Executive Summary

המערכת כבר מחזיקה שלד תשלומים לא רע בכלל:

- state machine אמיתי
- outbox אמיתי
- audit trail אמיתי ב-`payment_attempts`
- webhook ingestion אמיתי עם duplicate safety
- reconciliation logic אמיתי ברמת מינימום
- boundary ברור יחסית של provider abstraction

אבל ה-rail עצמו עדיין לא אמיתי.

כרגע:

- `authorization` הוא `mock` ב-`mock-backed`
- `provider-ready` הוא בעיקר contract ו-env shell, לא transport חי
- `capture`, `recovery`, `refund` הם עדיין simulation או placeholder
- ה-frontend מציג מסלול אמין יחסית, אבל ה-money rail מאחוריו עדיין לא פוגש ספק חיצוני

לכן הפער האמיתי איננו "חסר הכול", אלא:

1. יש orchestration טוב יחסית
2. אין provider execution truth אמיתי
3. אסור לחבר provider אמיתי בצורה שעוקפת audit, outbox, idempotency, או webhook truth

ההמלצה החדה היא להתחיל מ-`authorization rail` אמיתי אחד בלבד, תחת provider אחד בלבד, תוך שמירה על:

- אותו API כלפי ה-frontend
- אותה משמעת idempotency
- אותו מודל audit
- `demo-preview` כמסלול mock מבודד

לא להתחיל מ-capture/recovery/refund באותו שלב.

## Current State Mapping

### What already exists and is real

#### Payment state orchestration

- `src/app.ts`
  - `POST /deals/:id/join`
  - `POST /deals/:id/prepare_charging`
  - `POST /deals/:id/charging/start`
  - state transitions for:
    - `AuthHeld`
    - `AuthLocked`
    - `ChargeAttempt`
    - `ChargedSuccess`
    - `ChargeFailedRecovery`
    - `RecoveredCharge`
    - `Refunded`
- This means the internal money-state machine is already structured and not the first thing to replace.

#### Audit and attempt tracking

- `src/payment_attempt_helpers.ts`
  - `recordAttemptBeforeIo()`
  - `finalizeAttemptResult()`
- `payment_attempts` already acts as the durable audit rail for provider-side attempts and correlation ids.

#### Webhook ingestion storage

- `src/webhook_ingestion.ts`
  - real persistent webhook table
  - primary key `(provider, event_id)`
  - duplicate-safe ingest
  - explicit status progression: `pending`, `processed`, `ignored`, `failed`

#### Reconciliation layer

- `src/payment_reconciliation.ts`
  - resolves target from:
    - `correlation_id`
    - fallback `participant_id`
  - classifies:
    - `payment_authorized`
    - `payment_failed`
    - `charge_captured`
    - `charge_failed`
    - `recovery_captured`
    - `recovery_failed`
- This is already the right conceptual place for provider-event truth.

#### Runtime/readiness surface

- `src/runtime_config.ts`
- `src/operational_readiness.ts`
- `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`

These already expose the truth that:

- current provider is `mockpay`
- `mock-backed` is active by default
- `provider-ready` is not end-to-end live
- non-demo webhook secret policy is now hardened

### What is mock today

#### Authorization

- `src/payment_provider.ts`
  - `buildMockPaymentProvider().authorize()`
  - accepts card details, simulates declines by suffix, returns synthetic `authorization_id`
- `buildProviderReadyPaymentProvider().authorize()`
  - validates presence of env
  - still returns synthetic `authorization_id`
  - does not call a provider HTTP API

#### Capture

- `src/payment_provider.ts`
  - `mock-backed` capture is deterministic simulation
  - `provider-ready` capture returns `temporary_fail` placeholder only

#### Recovery

- `src/payment_provider.ts`
  - `mock-backed` recovery is deterministic simulation
  - `provider-ready` recovery returns placeholder only

#### Refund

- `src/payment_provider.ts`
  - `mock-backed` refund is deterministic simulation
  - `provider-ready` refund returns placeholder only

### What is partial but structurally correct

#### Webhook verification

- `src/frontend_runtime.ts`
  - HMAC verification exists
  - non-demo secret policy is now explicit and hardened
- Good foundation, but it still secures a rail that is not yet tied to a real provider transport.

#### Webhook routes and aliases

- canonical:
  - `/webhooks/payments`
- legacy compatibility:
  - `/webhooks/payments/mock`
- This is useful for migration, but alias discipline must stay strict when the real provider lands.

#### Frontend payment flow

- `frontend/app.js`
  - buyer goes through `OTP -> authorization -> join -> confirmation -> tracking`
  - copy correctly explains "authorization only" vs real charge timing
- Good UX shape, but still backed by a non-live provider implementation.

### Where the frontend still assumes a real rail

- `frontend/app.js`
  - payment screen already treats the step as a meaningful integration boundary
  - confirmation/tracking preserve provider-ish identifiers and hold messaging
- This is acceptable only because the copy explicitly explains authorization vs actual charge.
- It becomes dangerous only if backend stays mock while non-demo presentation becomes too "live" in business terms.

## Required Sources Of Truth

### Product / UX

- buyer flow expects:
  - OTP
  - authorization-only hold first
  - real charge only if the deal actually closes successfully
- trust copy already reinforces:
  - no actual charge at authorization time
  - hold release if the deal does not complete

### System / enforcement

- `src/app.ts`
  - charging is not supposed to happen inline in the request thread
  - deal transitions already model:
    - target reached
    - close joining
    - ready for charging
    - charging
    - completion window

### DB / audit / replay safety

- `payment_attempts`
- `webhook_events`
- outbox / dlq tables
- These are already the enforcement backbone and must not be bypassed.

### Readiness truth

- `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`
- `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`
- readiness already says:
  - provider boundary exists
  - provider execution truth does not

### Tests

Current tests prove mostly:

- mock-backed happy path works
- webhook duplicate handling works
- minimal reconciliation outcomes work
- provider-ready mode is configuration-shaped, not actually live

## Sub-Gap Breakdown

### 1. Provider abstraction is present but too thin for a real provider

What exists:

- single `PaymentProvider` interface
- `authorize`, `capture`, `recover`, `refund`

What is missing:

- real provider HTTP transport
- provider request/response mapping
- provider-native idempotency keys
- provider error-class normalization
- provider timeout/unknown-result discipline

### 2. Authorization rail is still synthetic

What exists:

- public API route
- frontend call path
- env shell for provider-ready mode

What is missing:

- actual outbound authorization request
- real provider correlation/reference ids
- safe handling for provider timeouts and ambiguous results

### 3. Charge / capture rail is still not live

What exists:

- internal state machine and orchestration shape
- outbox event type `charge_deal`

What is missing:

- actual capture execution against a provider
- provider result mapping into durable state truth

### 4. Recovery rail is still not live

What exists:

- recovery event classification
- money-state path for recovery success/failure

What is missing:

- actual recovery execution
- retry semantics backed by provider truth

### 5. Refund rail is still not live

What exists:

- refund method in provider abstraction
- refund-related attempt types

What is missing:

- real refund transport
- refund completion source of truth

### 6. Webhook processing truth is only partially real

What exists:

- verified secret boundary
- persistent event store
- duplicate handling
- minimal reconciliation classification

What is missing:

- chosen provider's full event taxonomy
- exact event-to-state mapping for all meaningful money outcomes
- discipline for late / duplicate / contradictory callbacks

### 7. Provider idempotency is not fully specified

What exists:

- internal app-side idempotency
- correlation ids in payment attempts

What is missing:

- mapping between app idempotency keys and provider idempotency semantics
- guarantees around retried authorization/capture calls

### 8. Unknown-result handling is not mature enough

What exists:

- placeholder retryable failures

What is missing:

- explicit "request sent but result unknown" handling
- reconcile-first recovery path
- no-double-charge guarantees when HTTP result is ambiguous

### 9. Frontend wording is ahead of backend truth

What exists:

- good wording around hold vs charge

What is missing:

- runtime-specific confidence copy once non-demo auth and real authorization actually go live
- exact operational wording for provider pending / delayed / unavailable states

### 10. Ops / env / secret model is only partly ready

What exists:

- provider mode envs
- webhook secret hardening

What is missing:

- provider credential contract for a real live rail
- rotation expectations
- preflight validation for required non-demo payment envs

## What Is Dangerous Right Now

- the system can appear commercially meaningful while still not touching a real payment network
- `provider-ready` can be misunderstood as "live enough" when it is not
- synthetic `authorization_id` values are not real provider references
- capture/recovery/refund placeholder behavior can create false confidence about downstream money closure

## Blast Radius

### Backend

- `src/payment_provider.ts`
- `src/runtime_config.ts`
- `src/frontend_runtime.ts`
- `src/payment_reconciliation.ts`
- `src/webhook_ingestion.ts`
- outbox worker behavior
- `payment_attempts` semantics

### Frontend

- `frontend/app.js` payment screen
- confirmation/tracking assumptions around authorization references and messaging

### Runtime / ops

- `/health/integrations`
- `/api/preview/meta`
- operational docs
- non-demo env bootstrap

### Tests

- frontend happy path tests
- integrations/reconciliation tests
- preprod torture tests
- webhook duplicate/out-of-order tests

## Dependencies

### Hard prerequisites before implementation

1. Choose exactly one provider.
2. Freeze exactly one minimum authorization contract.
3. Freeze the rule that money execution does not happen inside a buyer request thread.
4. Freeze the mapping boundary:
   provider events reconcile money truth, not ad hoc frontend assumptions.

### Soft dependencies

- invoice/accounting remains out of scope for now
- notifications remain out of scope for now
- repeat joins remain out of scope for now

## What Must Stay Invariant

- state machine semantics
- audit trail in `payment_attempts`
- webhook duplicate safety
- outbox discipline
- idempotency semantics
- 90 percent rule / threshold logic
- completion window semantics
- hold-before-charge product truth

## Minimum Viable Real Payment Rail

המסלול המינימלי הסביר לביצוע עכשיו הוא:

### Real authorization only

- keep current frontend payment API mostly stable:
  - `POST /api/payments/authorize`
- implement one real provider HTTP client for `authorize()`
- keep `demo-preview` on mock-backed mode
- keep `capture`, `recover`, `refund` explicitly non-live for now
- persist real provider correlation/reference ids into the existing audit rail
- harden env validation so non-demo provider-ready cannot masquerade as live without required credentials

### Why this is the right minimum

- it gives one real external money boundary
- smallest blast radius compared to full capture/recovery/refund
- lets us validate provider idempotency, timeout behavior, and correlation truth first
- avoids breaking state machine closure logic before the first live external interaction is stable

## Production-Grade Path

### Stage 1: Real authorization rail

- live provider HTTP authorization
- provider-native idempotency usage
- real provider reference persistence
- normalized failure mapping
- unknown-result handling

### Stage 2: Real webhook truth for authorization outcomes

- verify provider signature model
- map provider authorization statuses precisely
- store full provider event identity
- reconcile authorization truth without mutating final charge states too early

### Stage 3: Real capture rail

- outbox-triggered capture execution
- provider idempotency for capture
- exact reconciliation for:
  - captured
  - failed
  - pending
  - unknown

### Stage 4: Real recovery rail

- provider-backed retry/recovery flow
- preserve completion-window semantics
- preserve "late success" handling

### Stage 5: Real refund rail

- refund execution rail
- refund webhook truth
- refund retry and unknown-result handling

## Recommended Execution Order

### Order

1. Real authorization adapter
2. Authorization webhook truth tightening
3. Capture rail
4. Recovery rail
5. Refund rail

### Why this order

- the first live external boundary should be the smallest and least destructive one
- capture/recovery/refund should not be wired before provider references and idempotency behavior are trustworthy
- webhook truth should be tightened around the chosen provider as soon as authorization goes live, before downstream money movement expands

## Env / Secret / Endpoint Impact

### Envs likely required for minimum viable rail

- `PAYMENT_PROVIDER`
- `PAYMENT_PROVIDER_MODE=provider-ready`
- `PAYMENT_PROVIDER_BASE_URL`
- `PAYMENT_PROVIDER_API_KEY`
- `PAYMENT_PROVIDER_PUBLIC_KEY` if the chosen provider actually needs browser tokenization or public key setup
- `PAYMENT_WEBHOOK_PROVIDER`
- `PAYMENT_WEBHOOK_SECRET`

### Additional envs that may be needed depending on provider design

- provider merchant/account identifier
- provider timeout tuning
- provider idempotency namespace or account-scoped keys

### Endpoint impact

For the minimum viable rail, prefer keeping these stable:

- `POST /api/payments/authorize`
- compatibility alias can remain temporarily:
  - `POST /api/payments/authorize-mock`
- keep canonical webhook route:
  - `POST /webhooks/payments`

Avoid adding many new public endpoints unless the provider integration truly needs them.

### DB / field impact

For the minimum viable authorization rail:

- no schema rewrite should be required first
- existing `payment_attempts.correlation_id` should remain the main correlation anchor

Possible later additions, only if proved necessary:

- provider-specific reference fields
- richer attempt metadata storage
- normalized provider status snapshots

## Buyer / Seller Flow Impact

### Buyer

- payment screen becomes truly external at authorization time
- failure semantics become more real and less synthetic
- confirmation/tracking should continue to speak in hold/authorization language, not charge-complete language

### Seller

- seller surfaces should remain mostly unaffected in Stage 1
- downstream seller money/completion surfaces become more important only once capture/recovery/refund are real

## Validation Plan

### Success criteria for Stage 1

- non-demo authorization hits a real provider successfully
- real provider reference is stored consistently
- internal attempt record is written before or around provider IO with traceable correlation
- buyer flow still reaches confirmation/tracking cleanly
- no accidental charge execution happens inside the payment request thread

### Tests required

- provider adapter unit tests
- authorization contract tests
- non-demo env validation tests
- integration tests around real/simulated mode split
- buyer happy path regression
- failure mapping tests:
  - decline
  - validation error
  - timeout / unknown result

### Live QA required

- buyer OTP -> payment -> join -> confirmation
- wrong card / decline path
- provider unavailable path
- non-demo runtime readiness
- webhook endpoint verification with signed sample payloads from the chosen provider

## Dangerous Payment Fixes

### 1. Putting live money execution in the buyer request thread

אסור לשבור את ההפרדה בין request handling לבין orchestration.

### 2. Skipping the audit write before external IO

בלי correlation/audit מסודר, unknown result ייהפך לחור תפעולי מסוכן.

### 3. Treating HTTP success as final money truth

במיוחד ב-capture/recovery/refund, webhook truth וה-reconcile חייבים להישאר מקור האמת המשני/המאשר.

### 4. Replacing outbox discipline with direct imperative calls

זה ידרוס retry semantics, observability, ו-replay safety.

### 5. Losing provider idempotency at the app boundary

אותה פעולה לא יכולה להפוך לשתי פעולות חיצוניות שונות בגלל retry לא מבוקר.

### 6. Ignoring late webhooks

late success / late failure / duplicates / reordered events הם חלק מהמציאות, לא edge case דמיוני.

### 7. Collapsing unknown-result into fake success or fake failure

אם התוצאה לא ידועה, צריך מסלול reconcile מפורש. אסור "לנחש".

### 8. Breaking the 90 percent rule or completion-window semantics while wiring payment

חוקי המוצר של target/charging/completion window לא אמורים להשתנות בגלל provider integration.

### 9. Making the frontend sound more live than the backend really is

copy צריך להישאר כן לכל אורך staged rollout.

## What Must Not Be Improvised

- חיבור provider "כאילו" בלי HTTP client אמיתי
- שימוש ב-`provider-ready` כ-label שיווקי
- הכנסת capture/recovery/refund באותו patch ראשון
- שינוי state semantics כדי "להתאים" ל-provider
- schema churn מוקדם בלי הוכחת צורך
- חיבור invoice/accounting לפני שיש payment truth אמיתי

## Sharp Recommendation

הדבר הראשון שמומלץ לממש הוא:

### Real authorization rail בלבד

תחת provider אחד, עם:

- outbound HTTP client אמיתי
- env contract קשיח ל-`non-demo`
- persistence של correlation/provider reference
- error mapping אמיתי
- unknown-result discipline
- ללא capture/recovery/refund באותו שלב

זהו המסלול הצר ביותר שנותן rail אמיתי שאפשר לבנות עליו, בלי לפרק את state machine ובלי לייצר fake production confidence.
