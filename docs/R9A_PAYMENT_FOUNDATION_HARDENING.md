# R9A — Payment Foundation Hardening (pre-Grow-sandbox closure)

Stage scope: close every provider-neutral architectural gap found in the Codex
R9 preflight (`docs/R9_INTEGRATION_PREFLIGHT.md`, audited from branch
`codex/r9-integration-preflight`, commit `e2e922a`) BEFORE any Grow sandbox
call is permitted.

Safety counts for the whole stage (unchanged, enforced):
real money 0 · Grow calls 0 · real payment-provider calls 0 · real SMS 0 ·
real email 0 · real invoices 0.

## Checkpoint 1 — independent validation of the Codex audit against master `408ff8b`

Every HIGH finding was re-verified directly against current master source
before any implementation. Verdicts:

| # | Codex claim | Master truth (verified evidence) | Verdict | Required action |
|---|---|---|---|---|
| 1 | Join accepts a browser-supplied `authorization_id` and records canonical `AuthHeld` without server-side provider proof; missing authorization falls back to `mock_success`. | `src/app.ts` Join route: `body.authorization_id` read verbatim; `authorizationPayload` falls back to `{ authorization: "mock_success" }`; `money_state='AuthHeld'` written unconditionally in the same tx. | CONFIRMED | Server-authoritative payment authorization binding, consumed exactly once at Join (Checkpoint 2). |
| 2 | Grow implements neither `verifyWebhook` nor `parseWebhookEvent`; shared route falls back to a generic HMAC contract; verification is silently skipped when no safe secret exists. | `buildGrowCanonicalPaymentProvider` defines neither method; `verifyWebhookSignature` in `frontend_runtime.ts` returns `true` when `PAYMENT_WEBHOOK_SECRET_IS_SAFE` is false and applies generic HMAC otherwise. | CONFIRMED | Fail-closed webhook contract: generic verification never substitutes for a missing provider-native verifier in a real provider mode (Checkpoint 8). |
| 3 | Successful synchronous Grow capture/recovery/refund produces no canonical reconciliation event; Worker records UNKNOWN and throws, creating retry/duplicate-money risk. | `executionResult` in the Grow canonical wrapper sets `reconciliation_event_type: null` for success; `handleChargeDealEvent` then finalizes the attempt as `unknown` and throws `capture_missing_reconciliation_event_type`; outbox retry mints a NEW correlation → a second provider settle. Grow adapter `unknown` is additionally collapsed to retryable `temporary_fail`. | CONFIRMED | Canonical success outcome mapping + UNKNOWN as a first-class non-retrying outcome routed to reconciliation (Checkpoint 3). |
| 4 | UNKNOWN is modeled but no automatic provider-status reconciliation exists; admin `trigger_reconcile` only opens an internal case. | `admin_control_plane.ts` `trigger_reconcile` branch: dry-run support case only, explicit "No live provider call". No outbox event type for reconciliation exists (010/021/023/051 event-type constraint). | CONFIRMED | `payment_reconcile` outbox rail owned by the Worker, bounded, with manual-review fallback (Checkpoint 4). |
| 5 | No Grow release implementation and no Worker release call site; failed/cancelled deals leave holds represented as held. | Grow adapter has no release; outbox event-type constraint contains no release event; deal-failure paths (`deadline_check`, `charging.finalize_failed`) never touch `AuthHeld`/`AuthLocked` participants' money state. | CONFIRMED | Provider-neutral `payment_release` rail (Checkpoint 5); Grow-specific release semantics stay deferred. |
| 6 | TypeScript permits `AuthHeld→AuthReleased` and `AuthLocked→AuthReleased` but migration 008 permits release only from `ChargeFailedRecovery`. | `MONEY_TRANSITIONS` in `app.ts` vs `siton.is_valid_money_transition` in `008_db_enforcement_phase2a.sql` line 82. | CONFIRMED | Forward migration extends the DB function; migration 008 untouched. |
| 7 | VAT is fixed to zero for fee-ledger and charge/refund document snapshots. | `calculatePlatformFeeMoney({ grossAmount, vatAmount: 0 })` at `app.ts` charge/refund receipt enqueues; `vat_amount: 0` in `platform_fee_money.ts` `loadParticipantChargeContext`; `vatAmount: 0` in the admin settlement summary. | CONFIRMED | Explicit VAT authority module, synthetic-zero only as an explicit synthetic configuration, fail-closed for real-provider activation (Checkpoint 7). |
| 8 | Provider reference recovery relies on unindexed audit-log JSON rather than a normalized binding table. | `handleChargeDealEvent`/`handleRecoveryDealEvent`/`handleRefundEvent` all use `LEFT JOIN LATERAL (SELECT payload FROM siton.audit_log …)` to recover `authorization_id`. | CONFIRMED | Canonical binding table becomes the indexed primary lookup; audit JSON remains fallback evidence (Checkpoint 6). |
| 9 | No Grow sandbox/live fail-closed guards; runtime summaries overstate readiness from configured/mode checks alone. | `production_guards.ts` has Stripe-only credential guards; `getPaymentProviderSummary` derives `*_transport_live`/`payment_reconcile_live` purely from mode+configured. | CONFIRMED | Provider-neutral environment guards + capability-level readiness (Checkpoint 9). |
| 10 | Notification rail: unbounded retries, `processing` rows strand on crash, no reclaim, `NOTIFICATION_MAX_ATTEMPTS` unused, silent fallback provider, `sendSms` fallback sends an empty body. | `notification_dispatch.ts`: temporary_fail always returns to pending with +1 minute; no attempt counter; no reclaim path; `buildNotificationProvider` silently downgrades any non-`log` provider; dispatch fallback invokes `sendSms(recipient, "")`. | CONFIRMED | Bounded attempts, crash reclaim, fail-closed provider construction, recipient-safety gate (Checkpoints 10–11). |
| 11 | `correlation_id` was later added to `notification_events` but enqueue does not write it. | No migration adds `correlation_id` to `notification_events` (029 is the only rail migration; 035 references the table for other purposes). The column does not exist. | INCORRECT | Column added in the R9A notification reliability migration; enqueue now writes it. |
| 12 | Staging payment webhooks can skip verification when no safe secret exists. | `verifyWebhookSignature` early-returns `true` when the secret is unsafe/missing, regardless of provider mode. | CONFIRMED | Skip remains legal only for the synthetic mock-backed provider; real modes fail closed (Checkpoint 8). |
| 13 | Invoice adapter contract, stable webhook identity, legal party fields, tax semantics unproven; Morning adapter must stay internal-only. | Partially re-verified (VAT inputs confirmed zero; provider contract not re-audited here). | PARTIALLY CONFIRMED | Out of R9A implementation scope except the VAT authority feed; invoice provider activation remains closed and deferred. |
| 14 | `GROW_API_KEY` is not required by `assertGrowConfig`; unclear whether optional. | Confirmed: `assertGrowConfig` does not list `GROW_API_KEY` as required. | CONFIRMED (provider-doc dependent) | Deferred to R9B Grow contract verification; documented, no code guess. |

Counts: **12 CONFIRMED · 1 PARTIALLY CONFIRMED · 1 INCORRECT · 0 STALE.**

## R9A architecture as implemented

### Server-authoritative payment binding (Checkpoints 2, 6)

`siton.payment_authorization_bindings` (migration 053) is the canonical,
indexed financial-authority record for a payment authorization:

- Created by `/api/payments/authorize` with the SERVER-computed amount
  (qty × price + delivery from locked DB rows), provider code/mode/environment,
  deal, buyer, quantity, currency, delivery option/cost and correlation id.
  Idempotent on correlation.
- Hosted flows persist as `pending_provider_confirmation`. They become
  `authorized` ONLY after an authoritative server-to-provider status lookup
  (`/api/payments/status`, or a future verified provider webhook) — never from
  browser redirect/query data. A provider-reported amount that contradicts the
  binding fails the binding closed.
- Join (`POST /deals/:id/join`) consumes a matching `authorized` binding
  exactly once, inside the Join transaction (`consumeBindingForJoinTx`, row
  locked). Verified: provider code, provider mode + environment, deal, buyer,
  quantity, authoritative amount, currency, status, prior consumption, expiry.
  Any mismatch aborts the Join; `AuthHeld` is unreachable without a consumed
  binding in strict mode.
- Enforcement: every non-mock provider mode is ALWAYS strict; the synthetic
  mock-backed demo keeps the legacy Join contract unless
  `PAYMENT_BINDING_ENFORCEMENT=strict` (and even legacy mode verifies and
  consumes a binding when one exists — mismatches always fail closed).
- The consumed binding (unique per participant) is the indexed provider
  reference source for capture/recovery/refund/release; refreshed opaque
  references (e.g. sealed references gaining transaction credentials) are
  written back after successful money calls. Audit-log JSON is demoted to
  evidence-only fallback for pre-binding participants.

### Async provider result model (Checkpoint 3)

`PaymentExecutionResult.result_class` now includes first-class `"unknown"`:

- Provider-declared outcomes map to exactly one canonical reconciliation
  event: success ⇒ `charge_captured`/`recovery_captured`/`refund_issued`,
  permanent failure ⇒ `charge_failed`/`recovery_failed`. The Grow canonical
  wrapper now emits success events instead of returning success with no event
  (the confirmed duplicate-money defect).
- Transport loss AFTER dispatch (capture/recovery/refund/release) is UNKNOWN
  in every adapter (generic provider-ready, Stripe, Grow): recorded as a
  durable `unknown` attempt and handed to the reconcile rail. It is NEVER
  converted into a retryable failure — a blind retry could move money twice.
- Adapter pre-I/O throws (invalid sealed reference, configuration) are
  `temporary_fail` (no provider call happened; outbox attempt caps + DLQ bound
  the retries) and never fabricate provider-declared failure events.
- `recordAttemptBeforeIo` remains the sole durable before-I/O seam; no adapter
  performs hidden money retries.

### UNKNOWN reconciliation rail (Checkpoint 4)

`payment_reconcile` outbox events (participant-scoped, money worker lane):

- Scheduled whenever a money operation ends without provider-declared truth.
- The Worker resolves via `PaymentProvider.status` (the authoritative lookup
  seam), applies exactly one canonical event through the existing webhook
  ingest/dedupe/terminal-protection path, finalizes the attempt row, and
  refreshes the binding reference.
- Amount mismatch against the binding fails closed into a `PaymentMismatch`
  operational case with zero state mutation.
- Still-ambiguous outcomes retry under outbox backoff; exhaustion opens a
  manual-review operational case and lands in the DLQ (`trigger_reconcile`
  admin dry-run remains; the automatic rail is Worker-owned).
- A charge failure resolved late re-arms `recovery_deal` while the completion
  window is open. Late/duplicate reconciliation after resolution is a no-op
  (no provider call, no double ledger).

### Release / void (Checkpoint 5)

`payment_release` outbox events (participant-scoped, money lane):

- Scheduled for every participant still holding `AuthHeld`/`AuthLocked`/
  `ChargeFailedRecovery` when a deal fails (deadline or finalize) and for
  unrecovered participants of completed deals.
- The handler records a durable `release` payment attempt (a NEW attempt type;
  migration 050's rolling charge/recovery cap is untouched), calls
  `PaymentProvider.release`, and transitions to `AuthReleased`
  (action `authorization.release`) ONLY on provider proof. UNKNOWN routes to
  the reconcile rail (status `released` is the proof); permanent failure and
  missing release capability open operational cases and stay DLQ-visible with
  the hold still represented as held.
- Migration 053 extends `siton.is_valid_money_transition` with
  `AuthHeld→AuthReleased` and `AuthLocked→AuthReleased` (forward migration;
  008 untouched), closing the confirmed TS/DB drift.
- Grow-specific release semantics remain deferred to the verified Grow
  contract (R9B); Grow cannot start in a real environment without them.

### VAT authority (Checkpoint 7)

`src/vat_authority.ts`:

- `SITON_VAT_MODE=synthetic_zero` (default) is an EXPLICIT synthetic policy —
  staging/demo math is unchanged and labeled.
- `SITON_VAT_MODE=explicit` takes authoritative business/legal rates
  (`SITON_VAT_RATE_PRODUCT`, `SITON_VAT_RATE_DELIVERY`; product and delivery
  may differ) and computes the VAT portion of the gross customer charge per
  component. No tax law is invented in code.
- Fee ledger (`platform_fee_money.ts`), charge/refund receipt snapshots and
  the admin settlement summary all consume the authority; the 8% fee base is
  always VAT-exclusive (delivery included, VAT excluded).
- Fail closed: production runtime requires `SITON_VAT_MODE=explicit`
  (production guard); `assertVatAuthorityForRealMoney` guards real-provider
  activation. Real invoices remain OFF.

### Webhook contract (Checkpoint 8)

- A provider that requires native verification (Grow) is NEVER verified by the
  generic HMAC fallback: with `mode === "grow"` and no native `verifyWebhook`,
  the route fails closed and records a security event.
- Skipping verification when no safe secret exists is legal ONLY for the
  synthetic mock-backed provider; every real mode fails closed.
- Grow selection in any real provider environment (sandbox/live, and always in
  production) throws at startup unless native
  `release`/`status`/`verifyWebhook`/`parseWebhookEvent` exist — startup/
  readiness fail closed, never silent generic fallback.

### Provider environment safety (Checkpoint 9)

- `PAYMENT_ENVIRONMENT=live` is only legal in production deployment mode
  (production credentials cannot run on staging); production forbids
  sandbox/test/demo (pre-existing) and production Grow requires `live`.
- Grow selection anywhere requires a declared sandbox/live environment plus
  complete, non-placeholder `GROW_USER_ID`/`GROW_PAGE_CODE`/
  `GROW_REFERENCE_ENCRYPTION_KEY` (≥32 chars) and https base/return URLs.
- Readiness is capability-level: `getPaymentProviderSummary` reports
  `capabilities`, `capability_gaps`, `real_activation_ready` and truthful
  `webhook_verification_live`/`release_transport_live`/`status_transport_live`
  /`payment_reconcile_live` flags derived from actual adapter methods —
  `configured=true` alone no longer implies anything.
- Production mock fallback remains prohibited (pre-existing, retested).

### Communications safety + reliability (Checkpoints 10–11)

On the EXISTING 029 notification rail (no second system), migration 054 adds
`attempt_count`, `correlation_id`, `processing_started_at` and a `blocked`
status. `src/notification_safety.ts` is the shared gate every future real
adapter must pass BEFORE provider I/O:

- Default-deny: real mode requires `NOTIFICATION_DELIVERY_ENABLED=1` AND the
  per-channel switch; staging real delivery additionally requires the explicit
  recipient allowlist (E.164-normalized numbers / exact emails / controlled
  domains); production blocks synthetic recipients and domains; safety is
  never inferred from a "test" substring. Blocked sends persist as `blocked`
  with a `skipped` attempt row.
- `buildNotificationProvider` fails closed on `NOTIFICATION_PROVIDER_MODE=real`
  (no verified real adapter exists) instead of silently degrading; `log-only`
  is a first-class alias of the log provider (the misleading staging label is
  gone). Production guards enforce the same at boot.
- Bounded retries (`NOTIFICATION_MAX_ATTEMPTS`, default 3, exponential
  backoff) with a terminal, visible `failed` status; stranded `processing`
  rows are reclaimed by claim age in Worker maintenance with a counted
  attempt; `sendSms` fallback renders the real template body server-side;
  enqueue writes `correlation_id`.
- Real SMS/email delivery count remains ZERO.

### Deferred to R9B (Grow sandbox activation) — intentionally NOT guessed

Grow-native webhook signing/parsing, Grow release/void semantics, settle
idempotency/partial-capture rules, `GROW_API_KEY` requirement, status-code
taxonomy verification, invoice provider (Morning) contract/legal party
mapping, and any real communications adapter. All are fail-closed until the
official contracts are verified.
