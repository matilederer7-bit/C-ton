# FINANCIAL TORTURE LAB — synthetic money war room (R9C refresh candidate)

**Status: LAB + FINDINGS ON `claude/r9c-financial-torture-candidate`. `SAFE_FOR_REAL_MONEY = NO`. `SAFE_TO_MERGE_FINANCIAL_BRANCH = NO`. R10 BLOCKED.**
Authorized defensive Secure-SDLC work on the owner's own repository. Real money 0 · real Grow calls 0 · real
capture / settle / refund / release / recovery 0 · real SMS 0 · real business e-mail 0 · real invoices 0. Every
scenario runs against disposable local PostgreSQL databases (one per test file, created and dropped by
`scripts/run_test_group.cjs`), synthetic deals and participants, an in-process programmable payment provider and
local workers. Nothing here was deployed and migration 063 was never applied to staging.

| | |
|---|---|
| Master base | `60ebf6d64fb0d5909ae98fa335a4a27ad45c9172` (system hardening + route gates + concurrent publish/outbox fix) |
| Pre-financial resilience | `claude/pre-financial-resilience` @ `82f9171` (Phase 1: deal.cancel serialization + pg client error guard) |
| R9C source | `claude/r9c-integration-candidate` @ `3f00edb5fd0a19b38c6da31ef48aeb65f3365bec` (10 commits) |
| Financial candidate | `claude/r9c-financial-torture-candidate` — R9C cherry-picked (`-x`) onto `82f9171`, then the lab and the fixes below |
| Migrations | `061` P0.7 PRESERVED · `062` RESERVED (Codex Amazon) · `063` R9C PRESERVED — fresh install 58/58, re-run idempotent, checksum ledger consistent |

The R9C port itself is provably equivalent to the previous integration candidate: after the cherry-picks the
patch `3f00edb → candidate` (normalised: no index lines, no hunk offsets) is byte-identical to the patch
`123bbf9 → 82f9171` (master's delta + Phase 1), and `82f9171 → candidate` is byte-identical to
`123bbf9 → 3f00edb` (the original R9C delta), `PROJECT_STATUS.md` excluded.

---

## 1. Instruments (Phases 3–4)

### `tests/lab/provider_simulator.ts` — programmable synthetic provider
An in-process HTTP server speaking the provider-ready contract Siton's `payrail-http` adapter expects
(`POST /capture|/recover|/refund|/release`, `GET /status/:reference?operation=`, `POST /authorize`). It is
**test-side**: production talks to it over HTTP only and cannot reset anything.

* **Private economic ledger** per authorization: `capture`, `recover`, `refund`, `release` counts and amounts; every
  request is recorded (operation, idempotency key, behaviour, whether an effect was applied, whether it was a replay).
* **Behaviours** (scripted per authorization + operation, consumed in order): `SUCCESS`, `DECLINED`, `NO_EFFECT_503`,
  `EFFECT_THEN_200/503/429/408`, `EFFECT_THEN_TIMEOUT`, `EFFECT_THEN_CONNECTION_RESET`, `EFFECT_THEN_MALFORMED_2XX`,
  `EFFECT_THEN_TRUNCATED_BODY`, `EFFECT_THEN_RESPONSE_LOST`, `EFFECT_THEN_OK_FALSE`, `DELAYED_EFFECT`, `LATE_SUCCESS`,
  `HANG_NO_EFFECT`, `PENDING_NO_EFFECT`. The money moves **before** the answer is written.
* **Status behaviours**: `TRUTH` (pending/non-final while an asynchronous settlement is in progress), `STALE_AUTHORIZED`,
  `PENDING`, `UNKNOWN`, `HTTP_500`, `TIMEOUT`, `MALFORMED`, `WRONG_REFERENCE`, `MISSING_REFERENCE`, `WRONG_AMOUNT`,
  `FLAP` (`STATUS_FLAPPING`, `EVENTUALLY_CAPTURED`, `STATUS_UNKNOWN_FOREVER` are compositions of these).
* **Native idempotency toggle**: with `nativeIdempotency:false` every request executes, so a `*_count = 1` proves
  that *Siton* never repeated the operation, independently of provider dedupe.
* **Provider-side state machine**: a captured hold cannot be released, a released hold cannot be captured, nothing
  is refunded twice or before a capture — declined like a real acquirer would.
* Duplicate / out-of-order / wrong-reference **callbacks** are delivered through the real signed webhook route
  (`tests/lab/runtime.ts::postWebhook`, HMAC `t.body` with the configured secret).

### `tests/lab/oracle.ts` — independent financial truth oracle
Derives expected truth from the simulator ledger and raw SQL only; it deliberately re-implements the financial
constitution in **integer agorot** and never imports the production helpers. Tracked separately per participant:
provider effects (A), `payment_attempts` (B), `money_state` (C), `buyer_state` (D), deal state (E), platform-fee
ledger (F), audit log (G), outbox / DLQ (H), operational cases (I). Named violations include
`DUPLICATE_CAPTURE`, `DUPLICATE_REFUND`, `DUPLICATE_RELEASE`, `RELEASE_OF_CAPTURED_MONEY`, `FALSE_CANONICAL_SUCCESS`,
`LOST_PROVIDER_EFFECT`, `PROVIDER_SUCCESS_INVISIBLE`, `UNRESOLVED_WITHOUT_CASE`, `INVISIBLE_STUCK_OPERATION`,
`AUTOMATIC_REPEAT_WHILE_UNKNOWN` (a second idempotency key seen by the *provider* while the earlier identity is not
provider-declared failed), `ATTEMPT_SUCCESS_WITHOUT_PROVIDER_EFFECT`, `LEDGER_CHARGE_ENTRY_COUNT`,
`LEDGER_AMOUNT_MISMATCH`, `FEE_RATE_NOT_8_PERCENT`, `AUDIT_CAPTURE_TRANSITION_COUNT`, `AUDIT_CHAIN_BROKEN`,
`DUPLICATE_LIVE_OUTBOX_EVENT`, `MONEY_EVENTS_NOT_QUIESCENT`, `EFFECT_ON_UNKNOWN_AUTHORIZATION`.
Economics: `fee = round((gross_incl_delivery − buyer_VAT) × 8 / 100)`, fee VAT 18 %, `seller_net = gross − fee_total − 0`
(distributor commission / payout / revenue share = 0 by construction). Anti-vacuity of the oracle itself is proven in
`payment_lab_foundation_validation.ts` (planted duplicate effect, invisible effect, identity rotation, ledger
corruption and false canonical success are each reported).

### `tests/lab/runtime.ts` — scenario runtime
Boots the real application against the simulator (`PAYMENT_PROVIDER=payrail-http`, `provider-ready`,
`PAYMENT_PROVIDER_TIMEOUT_MS=250`), seeds deals/participants/bindings/join audits directly in the disposable
database, drives the outbox deterministically (claim races with `Promise.all`, deferred events pulled forward with
a short pause, dead leases expired and reclaimed), delivers signed webhooks, and hands the oracle both truths.

---

## 2. Suites (Phases 5–20)

| File | Group | Phase | What it proves |
|---|---|---|---|
| `payment_lab_foundation_validation.ts` | payments | 3–4 | every provider behaviour drives the real capture rail to the contract outcome with exactly one effect; counters are private; oracle anti-vacuity; signed webhooks |
| `payment_lab_c1_c2_validation.ts` | payments | 5 | C1 (in-flight capture + reconcile → 0 status reads, no recovery, 1 effect), C1b stale owner, C1c recovery refused on UNKNOWN capture; C2 on all four rails × 503/429/408/timeout/reset/malformed/truncated/lost; pre-dispatch failure retries the same identity |
| `payment_lab_lifecycle_reconcile_validation.ts` | payments | 6, 9, 10 | lifecycle matrix (NOT_DISPATCHED / IN_FLIGHT / UNKNOWN / SUCCEEDED / DEFINITELY_FAILED) × 4 rails; DB guards (SN409) for every invalid transition; UNKNOWN-forever → DLQ + case (never a verdict); ambiguous/stale/flapping status; two reconcilers; amount mismatch; idempotency torture; reconcile before dispatch |
| `payment_lab_refund_release_recovery_validation.ts` | payments | 11–13 | refund/release/recovery matrices on a **non-idempotent** provider (any repeat would double the money) |
| `payment_lab_crash_matrix_validation.ts` | payments | 7, 15 | crash before dispatch / after effect / after settle / between state and ledger / before ack / after claim; lease expiry in flight; DB transaction failure right after the provider effect (before BEGIN, after BEGIN, before COMMIT); backend termination while in flight (process survives — Phase 1B guard); pool exhaustion |
| `payment_lab_concurrency_matrix_validation.ts` | concurrency | 8, 14 | claim races 2/5/10/25/50 on every rail; 5/10/25/50 parallel deals; capture vs reconcile ×5; capture vs recovery; stale owner vs 2/5/10 successors; poison event, duplicate, retry storm, 60-job backlog; **two real worker processes** on 40 deals × 2 participants with random ambiguity; deadlocks read from `pg_stat_database` |
| `payment_lab_finalize_guard_validation.ts` | payments | 7/16 (F-2) | finalize defers while captures are unresolved; in-flight capture; UNKNOWN-forever stays visible, never Failed-with-charged-money |
| `payment_lab_terminal_economics_validation.ts` | payments | 16–17 | terminal-state attacks (duplicates, out-of-order, wrong/missing references, contradictions → cases); integer-agorot economics under explicit 17 % VAT: 1 agora, odd agorot, delivery 0 / > item, large amounts and quantities, 12 participants |
| `payment_lab_random_schedule_fuzz_validation.ts` | payments | 18 | seeded random schedules (`LAB_FUZZ_SEED`, `LAB_FUZZ_SCENARIOS`, `LAB_FUZZ_REPLAY`); on failure: descriptor persisted + greedy minimisation |
| `payment_lab_soak_validation.ts` | payments | 19–20 | bounded soak (`LAB_SOAK_SECONDS`) with producer, two workers, chaos (lease expiry, deferred advance), interval oracle; global reconciliation of totals |
| `scripts/financial_lab_mutations.cjs` | — | 21 | 16 deliberate defects applied one at a time to a throwaway copy and reverted; each must turn the mapped suite red |

Run any suite with `TEST_FILE_PATTERN=payment_lab_<name> node scripts/run_test_group.cjs payments`
(`concurrency` for the concurrency matrix). Never run two runners at once in one worktree.

---

## 3. Findings (this program)

Severity per the program's finding policy. Each was reproduced deterministically, root-caused, fixed with the
smallest change on the financial candidate, covered by a permanent regression, and re-run through the broader lab.

### F-1 — MEDIUM (fixed): a once-observed negative capture status authorised a second capture through recovery
*Where:* `handleRecoveryDealEvent` (`src/app.ts`).
*Reproduction:* `payment_lab_lifecycle_reconcile_validation.ts` — "later-changed result": capture executes, provider
answers 503 (UNKNOWN), the first status read lies `failed/final`, reconcile declares `charge_failed`
(`permanent_fail`), `recovery_deal` is armed; before the fix recovery captured again → provider ledger
`capture=1, recover=1` (**DUPLICATE_CAPTURE**), canonical `RecoveredCharge`.
*Root cause:* recovery trusted the identity row's `permanent_fail` verdict, which encodes a single past status
observation; status APIs flap, settle late or answer from stale replicas.
*Fix:* `verifyOriginalCaptureBeforeRecovery` — immediately before arming a recovery the original authorization is
re-read through the status seam: `captured` → late-money-effect case + identity converges to success, **no
recovery**; `pending`/`unknown`/transport failure → the recovery job defers (`DeferredEventError`, bounded);
`authorized`/`failed` → proceed. A provider without a status capability keeps the pre-existing behaviour (residual).
*After:* the same scenario ends `recover_requests=0`, cases `payment-late-money-effect` + `payment-recovery-preflight-captured`, one effect.

### F-2 — HIGH (fixed): finalize_deal decided Completed/Failed while capture identities were UNKNOWN
*Where:* `handleFinalizeDealEvent` (`src/app.ts`).
*Reproduction:* found by the two-real-worker run (`payment_lab_concurrency_matrix_validation.ts`): ambiguous
captures (503/timeout/reset/malformed) were still being reconciled when the completion window elapsed; finalize
counted zero captured units, declared the deal **Failed** and every participant `DealFailed / ChargeAttempt`;
reconciliation then proved the capture executed → participant "not waiting for a capture" → `late_money_effect`
case; the deal's `refund_issue` job skipped the participant (it refunds `ChargedSuccess`/`RecoveredCharge` only).
Net: a charged buyer on a Failed deal with no automatic refund path (visible only as a case). Deterministic
regression: `payment_lab_finalize_guard_validation.ts`.
*Fix:* before deciding, finalize selects every `charge_start`/`recovery` identity of the deal with
`result_class='unknown'`; if any exists it schedules a `payment_reconcile` for each identity that has none live,
opens/refreshes the case `deal-finalize-waiting-unresolved:<deal>`, and defers (bounded outbox retry). The deal is
finalized only on resolved truth. If an identity stays UNKNOWN forever the deal remains un-finalized and visible
(reconcile DLQ + cases) — fail closed, never Failed with charged money.

### F-3 — HIGH (fixed): the HTTP webhook path silently ignored economically real late events
*Where:* `handleWebhookPayments` (`src/frontend_runtime.ts`).
*Reproduction:* `payment_lab_terminal_economics_validation.ts` — a signed `charge_captured` callback for a
participant whose hold was already `AuthReleased` (the provider's ledger really shows a capture) was classified
`ignored: not_waiting_for_charge_capture` and **no operational case** was opened. The worker-side ingestion
(`ingestAndProcessPaymentEvent`) already had the R9C guard `recordLateMoneyEffectException`; the HTTP route did not.
*Fix:* the frontend runtime receives `recordLateMoneyEffectException` as a dependency and calls it for every
`ignored` classification with a resolved target — worker/HTTP parity. The contradiction is now a
`payment-late-money-effect` case and the identity converges to success (monotonic), so recovery/refund/release
stay blocked for that participant.

### F-4 — MEDIUM (fixed): a reconcile request behind another pending reconcile was silently dropped
*Where:* `schedulePaymentReconcile` (`src/app.ts`); found by the seeded fuzzer (`LAB_FUZZ_SEED=20260907`, index 2,
minimised to: release rail, `EFFECT_THEN_CONNECTION_RESET`, one stale reconcile already queued for the participant).
*Mechanism:* `payment_reconcile` events are participant-scoped and the outbox admits one live event per
`(event_type, aggregate)`; `schedulePaymentReconcile` inserted with `ON CONFLICT DO NOTHING`, so when a reconcile for
a *different* identity was already live, the new request vanished. The live reconcile resolved canonical state from
its own payload, the UNKNOWN identity it did not know about stayed `unknown/responded` with **no reconcile and no
case** (`UNRESOLVED_WITHOUT_CASE`). Money was correct (one effect); the gap is visibility/self-healing, and an
unattended UNKNOWN identity keeps every further money operation of the participant blocked.
*Fix:* `schedulePaymentReconcile` reports `scheduled | already_pending | queued_behind`; `queued_behind` opens the
case `payment-reconcile-queued-behind:<participant>:<correlation>`; a new worker-maintenance sweeper
`reconcileOrphanedUnknownIdentities()` schedules a reconcile for every UNKNOWN identity that is not in flight, has no
live reconcile and has been quiet for a few seconds (one per participant per pass). Regression: lifecycle suite
"F-4"; the fuzz seed/index above replays green.

### F-5 — MEDIUM (fixed): a late money event was attached to the wrong identity (state inference instead of event type)
*Where:* `resolveTarget` (`src/payment_reconciliation.ts`) and the F-1 pre-flight; found by the seeded fuzzer
(`LAB_FUZZ_SEED=20260907`, index 46, minimised to: capture `NO_EFFECT_503` + a flapping status).
*Mechanism:* when an event carries no correlation, the target attempt type was inferred from the participant's
CURRENT state (`ChargeFailedRecovery → "recovery"`), so a late `charge_captured` for such a participant settled the
freshly minted **recovery** identity as `success` although the provider reported a *capture*
(`ATTEMPT_SUCCESS_WITHOUT_PROVIDER_EFFECT` on the recovery row). Canonical money state was untouched, but the
identity ledger lied — and a recovery row falsely at `success` is exactly the kind of truth later decisions rely on.
*Fix:* the target attempt type is derived from the **event type** (`charge_*` → `charge_start`, `recovery_*` →
`recovery`, `refund_issued` → `refund`/`cancel_refund`), state inference remains only the fallback; the F-1 pre-flight
now passes the original capture identity's correlation explicitly. Regression: the fuzz seed/index above replays
green; lifecycle "later-changed result" asserts the capture identity converges.

### F-5b — MEDIUM (fixed): a late event with a foreign correlation could settle an identity of another operation family
*Where:* `recordLateMoneyEffectException` and `resolveTarget`; found by the seeded fuzzer (`LAB_FUZZ_SEED=20260907`,
index 69): a signed `refund_issued` callback carrying the CAPTURE correlation marked the `charge_start` identity as
`success` (`ATTEMPT_SUCCESS_WITHOUT_PROVIDER_EFFECT`) — a corrupted identity ledger from a single misrouted
provider callback (such an identity would then block recovery and drive finalize).
*Fix:* the correlation-first target lookup is accepted only when the identity's family matches the event type
(`charge_*`→`charge_start`, `recovery_*`→`recovery`, `refund_issued`→`refund|cancel_refund`), otherwise participant
resolution decides; the late-effect exception settles an identity only within the event's family (the case is still
opened). Fuzz seed/index above replays green.

### F-6 — MEDIUM (NOT fixed — semantics decision for the owner): `recovery_failed` sets `AuthReleased` without a provider release
*Where:* canonical `charging.recovery_failed` transition (`ChargeFailedRecovery → AuthReleased`, `ChargeFailedCompletion → Dropped`).
*Observation (fuzz index 69, minimised):* a recovery that the provider declines (or that reconciliation proves not
executed) moves the participant to `AuthReleased` with **no release request** to the provider — the hold is left
to the provider's authorization expiry. Money is not lost or duplicated (the oracle reports it under
`CANONICAL_RELEASE_WITHOUT_PROVIDER_PROOF`, never as a duplicate), but it contradicts the R9A rule enforced by the
release rail ("AuthReleased was NOT set without proof") and may leave a buyer's funds blocked until the provider's
expiry. Recommendation: on `recovery_failed`, transition to `Dropped` and enqueue `payment_release` (the R9A rail,
provider-proofed) instead of setting `AuthReleased` directly. Not changed in this program because it alters a
canonical transition of the money state machine; the reviewer/owner should decide. The lab counts every occurrence.

### Observations (not defects of the candidate, recorded for the reviewer)
* **O-1 — status echo trust.** The reconciler stores the `provider_reference` echoed by a status answer as the
  participant's newest reference. A provider answering a status query for reference X with an unrelated reference
  Y (`WRONG_REFERENCE`) is a contract violation the application cannot detect structurally (capture references
  legitimately differ from authorization references). Residual by contract; a real provider's reference discipline
  must be verified in R10.
* **O-2 — duplicate `charge_deal` after the window opened.** A second `charge_deal` for a deal already in
  `CompletionWindow` fails its `Charging → CompletionWindow` transition (409) on every retry and lands in the DLQ.
  Money-safe (participants are skipped) but noisy; the lifecycle key is per event.
* **O-3 — reconcile before dispatch.** A stale/early `payment_reconcile` on a NOT_DISPATCHED identity reads a
  truthful `authorized/final` and declares `charge_failed`; the participant is recovered later. One effect, consistent
  state, but the first capture is pre-empted. Benign.
* **O-4 — `payment-late-money-effect` cases leave the buyer's money outside the automatic refund path by design.**
  Every such case is an operator action item; the lab counts them (`unresolved_visible`) and the global
  reconciliation reports them.
* **O-5 — CAPTURE vs CANCEL is structurally impossible.** `deal.cancel` is the only transition into `Cancelled`
  and it is legal from `Draft` only (a Draft has no participants, hence no money); a cancel racing a charging deal
  is a 409 with nothing written (`cancel_outbox_concurrency_validation.ts`, Phase 1A). The matrix therefore covers
  capture vs reconcile / recovery / release and the outbox races instead.
* **O-6 — money-lane retries are bounded at four.** Migration 045 sets `outbox_events.max_attempts DEFAULT 4`;
  `OUTBOX_MAX_ATTEMPTS` can only lower the effective bound. Four ambiguous status reads exhaust a reconcile into the
  DLQ + `payment-reconcile-unresolved` case; the F-4 sweeper re-queues the identity at maintenance cadence, so
  "UNKNOWN forever" is visible and retried, never a verdict.

---

## 4. Results

_(filled from the final runs of this program — see `PROJECT_STATUS.md` for the counts and the `logs/` evidence)_

---

## 5. Residual risks / not covered here

* Grow native settle/refund idempotency and exact-operation status remain **UNPROVEN** (sandbox blocked); Grow fails
  closed into manual cases by policy.
* A provider that declares a *final* negative status for an operation it executed (`STALE_AUTHORIZED final:true`) can
  only be caught after the fact (late event / F-1 pre-flight); no reconciler can defend against a provider that lies
  about finality — the Grow policy (`negative_status_authoritative:false`) exists for exactly this reason.
* Statement timeouts, PostgreSQL server restarts and true deadlock injection were not simulated (no local
  Docker/WSL; restarting the developer's PostgreSQL service is out of scope). Backend termination, pool exhaustion,
  transaction failure at BEGIN/COMMIT boundaries and rollback were.
* A termination while COMMIT is already in flight is reported as a failed transaction even if the server committed
  (honest ambiguity; retries converge through identity/idempotency keys).
* `payment-late-money-effect` and `deal-finalize-waiting-unresolved` cases require operator follow-up; there is no
  automatic refund for money captured on a deal that later failed.
* Real-provider webhook signature schemes (Stripe/Grow) are exercised by their own suites, not by this lab's HMAC.

`SAFE_FOR_REAL_MONEY = NO`. A fresh independent adversarial review of the exact candidate SHA, a Codex re-review and
the Grow sandbox proof are still required before R10.
