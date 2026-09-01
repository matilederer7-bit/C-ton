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

The remainder of this document records the R9A architecture as implemented.
(Sections appended per checkpoint as they land.)
