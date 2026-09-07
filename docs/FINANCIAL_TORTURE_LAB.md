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
| `payment_lab_random_schedule_fuzz_validation.ts` | payments | 18 | seeded random schedules (`LAB_FUZZ_SEED` — unset = fresh seed, printed in the summary; `LAB_FUZZ_SCENARIOS`; `LAB_FUZZ_REPLAY`); on failure: descriptor persisted + greedy minimisation. ~0.4 s per scenario: runs above ~1 200 scenarios need `LAB_TEST_TIMEOUT_MS` (e.g. `1800000` for 2 000) |
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
*Test impact:* `payment_recovery_real_rail_validation.ts` carried a status stub that answered `captured / final` for
EVERY reference (it was written for the reconcile of a timed-out recovery); with the pre-flight in place that stub
claimed the original capture had executed and correctly blocked the recovery. The stub now answers `authorized`
until a recovery for that authorization actually executed — a truthful provider — and the proof passes unchanged
otherwise.

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

*F-2b (fixed, same family):* a finalize that deferred on unresolved captures could exhaust its bounded attempts
(DLQ) before those identities resolved, leaving the deal in `CompletionWindow` for ever. Worker maintenance now
re-queues one `finalize_deal` for every deal past its window with no live finalize
(`rescheduleStalledFinalizations`); it keeps deferring while money is unresolved, so it never finalizes on
ambiguous truth (regression: finalize-guard "unknown forever → truth").

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
*Test impact:* the R9A proof `webhook_truth_handling_validation.ts` ("conflicting events are recorded but the
logical state wins") asserted that a late `charge_captured` leaves the identity at `permanent_fail`; under the R9C
rule it now asserts the state still does not flip, the identity converges to provider truth (`success`) and the
contradiction case exists — the same expectation the R9C worker-path proof already had.
*Regression during this program:* the first F-1 pre-flight treated a status answer of `unknown` as ambiguous and
deferred recovery for ever, which stalled `charging_completion_window_validation.ts` and
`payment_recovery_real_rail_validation.ts` (their stubs answer `unknown`). Corrected in `d4c2046`: the pre-flight holds
on `captured` (case, no recovery) and `pending` (defer) only; `unknown` keeps the pre-existing behaviour, the UNKNOWN
charge_start identity discipline remaining the primary guard.

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

### F-7 — HIGH (fixed): the provider-ready refund and release adapters declared success on a 2xx "pending" body
*Where:* `buildProviderReadyPaymentProvider().refund` / `.release` (`src/payment_provider.ts`); found by the seeded
fuzzer (`LAB_FUZZ_SEED=20260907`, index 159, minimised to: refund rail, provider answers `200 {ok:true,status:"pending"}`
and never refunds).
*Mechanism:* the capture and recovery adapters classify the 2xx body (`classifyCaptureEventType`: "pending" → no
declared outcome → UNKNOWN), but the refund and release adapters returned `success` for ANY parseable 2xx. A pending
(or otherwise undeclared) refund became `refund_issued` → canonical `Refunded`, fee-ledger `refund_adjustment`,
refund receipt — while the provider never moved the money (`ATTEMPT_SUCCESS_WITHOUT_PROVIDER_EFFECT` /
`FALSE_CANONICAL_REFUND`): a buyer told they were refunded who was not, with no retry.
*Fix:* `classifyRefundOutcome` / `classifyReleaseOutcome` — success only for a declared success status (or the legacy
id-only shape), declared failure → `permanent_fail`, anything else (pending, processing, unknown) → UNKNOWN on the
same identity and the reconcile rail decides. Regression: rrr suite "F-7 refund/release: 200 pending"; the fuzz
seed/index above replays green.

### F-8 — LOW (fixed): a recovery identity minted before a deferring pre-flight could be left NOT_DISPATCHED for ever
*Where:* `handleRecoveryDealEvent`; found by the long fuzz run (`LAB_FUZZ_SEED=20260907`, index 344, minimised to:
recovery rail, provider status `pending` once, an early reconcile racing the recovery job).
*Mechanism:* the F-1 pre-flight ran after `beginProviderAttempt` had minted the recovery identity; when the pre-flight
deferred (`pending`) and a reconcile then moved the participant out of the recoverable state
(`recovery_failed → Dropped`), the retried recovery job found no eligible participant and acked, leaving
`recovery … n1` at `unknown / recorded` with no job, DLQ entry or case (`INVISIBLE_STUCK_OPERATION`). No money moved
(NOT_DISPATCHED means nothing was ever sent) and the row would have resolved itself the moment any later money
operation was blocked by it, but it was invisible until then.
*Fix:* the pre-flight runs BEFORE the identity is minted, so a held recovery mints nothing; and the maintenance
sweeper also reconciles NOT_DISPATCHED identities that have been quiet for ≥ 10 s (a status read settles them as
declared-failed or executed — never a repeat).
*Regression during this program (regression #2):* moving the pre-flight ahead of `beginProviderAttempt` made it
read status for participants that ALREADY carried a recovery identity (unknown after a crash — R9C proof S9 —, or
success whose canonical state was never persisted); the provider's `captured` was then that recovery, misread as a
late original capture, and the recovery identity was never resolved. The pre-flight now steps aside whenever a
recovery identity (unknown / success) exists — those are owned by the identity discipline and
`resolvePriorProviderAttempt`; it guards the FIRST recovery of a participant only. The oracle now counts
NOT_DISPATCHED rows instead of flagging them (zero money risk, attended by the sweeper).

### F-9 — CRITICAL in synthetic terms (fixed): a flapping status defeated the single-read recovery pre-flight → double capture

*Found by:* the random-seed run of `payment_lab_random_schedule_fuzz_validation.ts` inside the full repository
regression (regression #3; the full run does not pin `LAB_FUZZ_SEED`, so every regression draws a fresh seed and
prints it). Seed **2061983203**, scenario #141, minimised to ONE participant:
capture behaviour `DELAYED_EFFECT(90 ms)` (the provider answers `200 {status: "pending"}` and executes the capture
90 ms later), status behaviour `FLAP(failed, captured)` (consecutive status reads alternate).

*Before:* capture → UNKNOWN (declared pending) → reconcile read #1 `failed / final` → `charge_failed`,
`ChargeFailedCompletion` → recovery rail → pre-flight read #2 … the alternation made this read `failed` again
(the reconcile rail and other readers consume flap positions) → recovery captured 4 200 → the delayed original
capture landed → provider captured **8 400** for a 4 200 participant; canonical truth showed one capture.
Oracle: `DUPLICATE_CAPTURE` + `CAPTURE_AMOUNT_MISMATCH`.

*Root cause:* every money decision after an ambiguous capture rested on ONE status read. A provider that contradicts
itself between reads is not a lying-final-negative provider (the documented residual) — it is detectable, and the
candidate did not try.

*Fix (`verifyOriginalCaptureBeforeRecovery`):* two status reads a confirmation interval apart
(`RECOVERY_PREFLIGHT_CONFIRM_MS`, default 1 000 ms, lab 60 ms) and the most conservative verdict: any read
`captured` → captured (late-effect ingestion + case, no recovery); any read `pending` → hold; two reads that
disagree → hold + case `payment-recovery-preflight-flapping`; only two consistent negative answers let money move.
The held job stays visible (retries, then DLQ).

*Residual (unchanged, documented in §5):* a provider that answers `failed / final` or `authorized / final`
CONSISTENTLY while a settlement is still pending cannot be distinguished from a truthful failure by any number of
reads; the simulator's honest mode never does this, `FLAP` does when its cycle aligns. The effect then surfaces as
a late-effect case (money captured on a failed participant) — visible, not automatic; the only structural defence
is a provider-specific settlement horizon before recovery, which is an owner decision.

*Regression:* three pinned scenarios in `payment_lab_refund_release_recovery_validation.ts` (the minimised fuzz
schedule; declared-failed capture with a `failed ↔ captured` flap; two disagreeing negatives `failed ↔ authorized`),
plus the fuzz rerun on the exact seed 2061983203.

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

### 4.1 Mutation testing (Phase 21) — `node scripts/financial_lab_mutations.cjs`

Each mutation is applied to the working copy, the mapped suite(s) run on fresh databases, the file is restored with
`git checkout --`. A mutation that stays GREEN is reported as **SURVIVED** and explained; it is never hidden.

| Mutation | Invariant | Outcome |
|---|---|---|
| M01 post-dispatch 5xx classified as declared failure | UNKNOWN fencing | CAUGHT (`payment_lab_c1_c2`) |
| M02 recovery no longer blocked behind unresolved/executed capture (app layer) | recovery blocking | CAUGHT |
| M03 UNKNOWN refund re-fired as a retry | refund ambiguity fencing | CAUGHT |
| M04 fresh identity minted while the prior is unresolved | operation identity persistence | CAUGHT |
| M05 arm-time CAS removed (app layer) | payment_attempt lifecycle CAS | **SURVIVED — redundant defence**: the migration-063 trigger `payment_attempt_dispatch_in_flight` refuses the same re-arm at the database, and `beginProviderAttempt` already answers `in_flight` before the CAS is reached; the DB guard is proven directly by the lifecycle suite ("DB guards") |
| M06 fee-ledger entry skipped inside the state transaction | ledger/state atomicity | CAUGHT (`payment_lab_foundation`) |
| M07 reconcile no longer defers on an in-flight operation | reconciliation deferral | CAUGHT |
| M08 late-event contradiction guard removed | late event protection | CAUGHT (`payment_lab_terminal_economics`; the first attempt was an invalid mutant — unused-variable compile error — corrected) |
| M09 duplicate webhook dedupe removed | duplicate webhook protection | CAUGHT (the first run's assertion was itself vacuous — it matched the JSON key `"duplicate"`; fixed to check the value and the stored row count, after which the mutant is red) |
| M10 lease-ownership check at arm time removed | worker lease ownership | **SURVIVED — redundant defence**: with a dead lease the arm CAS (`NOT (dispatching AND foreign owner AND in flight)`) and the 063 trigger still refuse; the stale-owner proofs pass through those layers. The lease check is the first, cheapest fence, not the only one |
| M11 / M12 fee 7 % / 9 % | Siton fee exactly 8 % | CAUGHT ×2 (`payment_lab_terminal_economics`: 14 of 17 scenarios red under either rate; the first run was invalid because the literal type `0.08` made the mutant fail to compile — retyped as `number`) |
| M13 buyer VAT included in the fee base | VAT excluded | CAUGHT (`payment_lab_terminal_economics`) |
| M14 delivery excluded from the fee base | delivery included | CAUGHT |
| M15 5 % distributor commission deducted from seller net | distributor 0 | CAUGHT |
| M16 F-1 pre-flight removed | recovery pre-flight | first two mutants SURVIVED — honestly: (a) the simulator's provider-side guard declined the second capture (fixed: the scenario now scripts a provider that honours a recovery on a captured authorization), (b) a mutant that only dropped the "captured" branch still blocked the recovery through the ambiguous deferral. The mutant now neutralises the pre-flight entirely (`always proceed`); result of that run: see `PROJECT_STATUS.md` |

Full pass on the final tree (`lab_mutations_3.json`) plus the strengthened M16 (`lab_mutations_4.json`, the
neutralised pre-flight lets the scripted provider honour the recovery → `DUPLICATE_CAPTURE`, lifecycle suite red):
**tested 16 · caught 14 · survived 2** — M05 and M10, both redundant defences masked by the migration-063 trigger and
the arm-time CAS (the database guard is proven directly by the lifecycle suite). Every economic-constitution mutation
(8 % → 7 % / 9 %, VAT included, delivery excluded, distributor 5 %) and every money-safety mutation with an observable
effect is red. ANTI_VACUITY = PASS with the two documented redundant-defence survivors.

### 4.2 Suite results, fuzz, soak, global reconciliation and the full repository regression

Final tree (`claude/r9c-financial-torture-candidate` with F-1…F-5b, F-7, F-8 and F-9 applied), fresh isolated databases:

| Suite | Result |
|---|---|
| `payment_lab_foundation_validation.ts` | 23/23 |
| `payment_lab_c1_c2_validation.ts` | 27/27 |
| `payment_lab_lifecycle_reconcile_validation.ts` | 37/37 |
| `payment_lab_refund_release_recovery_validation.ts` (non-idempotent provider; 3 F-9 pins) | 29/29 |
| `payment_lab_crash_matrix_validation.ts` | 13/13 |
| `payment_lab_finalize_guard_validation.ts` | 3/3 |
| `payment_lab_terminal_economics_validation.ts` | 17/17 |
| `payment_lab_concurrency_matrix_validation.ts` (incl. two real worker processes, 80/80 converged, 0 duplicates, 0 deadlocks) | 32/32 |
| `payment_lab_random_schedule_fuzz_validation.ts` seed `20260907`, 300 scenarios | 300/300 (451 participants, 525 provider effects, 92 s) |
| `payment_lab_soak_validation.ts` 30 s | see global reconciliation below |

**Global reconciliation (30 s soak, 231 deals, 550 participants, 2 079 jobs, 12 forced lease expiries, 8 interval audits):**

| Source | captures | recoveries | captured minor | fees minor | seller net minor |
|---|---|---|---|---|---|
| provider simulator ledger | 452 | 97 | 5 000 950 | — | — |
| canonical states (`ChargedSuccess` / `RecoveredCharge`) | 452 | 97 | 5 000 950 | — | — |
| platform-fee ledger (549 entries) | — | — | 5 000 950 gross | 472 019 | 4 528 931 |
| oracle (independent 8 % over canonical captured) | — | — | — | 472 019 | 4 528 931 |

`payment_attempts`: 549 success + 99 permanent_fail (declined captures recovered once each), DLQ 0, deadlocks 0,
unhandled rejections 0, uncaught exceptions 0, app pool ≤ 3 connections, heap ≤ 144 MB. One F-6 occurrence
(`recovery_failed → AuthReleased` without a provider release) counted. Every earlier failing fuzz index
(2, 46, 69, 132, 159 of seed 20260907) was minimised, root-caused (F-4, F-5, F-5b, F-6 documented, F-7) and replays
green.

**Long soak (180 s, `lab_run_15ls.log`): 1 181 deals, 2 894 participants, 6 846 jobs, 82 forced lease expiries,
22 interval audits, 4 687 provider operations — PASS.**

| Source | captures | recoveries | releases | captured minor | fees minor | seller net minor |
|---|---|---|---|---|---|---|
| provider simulator ledger | 2 395 | 100 | 394 | 22 489 550 | — | — |
| canonical states | 2 395 | 100 | 399 (= 394 provider releases + 5 F-6 `recovery_failed → AuthReleased`) | 22 489 550 | — | — |
| platform-fee ledger (2 495 entries) | — | — | — | 22 489 550 gross | 2 122 649 | 20 366 901 |
| oracle (independent) | — | — | — | — | 2 122 649 | 20 366 901 |

`payment_attempts`: 2 889 success + 504 permanent_fail; DLQ 9 (bounded retries, all visible), deadlocks 0, unhandled
rejections 0, uncaught exceptions 0, app pool ≤ 3, heap ≤ 190 MB; every provider effect reflected canonically; the
five-release difference is exactly the F-6 count.

**Full repository regression (`npm run test:all`, 213 files, 10 groups, fresh databases; every run also re-runs the
random-schedule fuzz with a FRESH seed, printed in its summary) and the anti-vacuity passes:**

| Run | Tree | Result | What the red files were |
|---|---|---|---|
| #1 | `5e521f3` | 8/10 groups | db 6/7 + payments 44/46 — the first F-1 pre-flight treated status `unknown` as ambiguous and stalled two recovery proofs; the R9A webhook-truth proof asserted the pre-F-3 behaviour. Fixed (`d4c2046`, `f5ab275`). |
| #2 | `f5ab275` | 9/10 groups | payments 43/46 — the F-8 pre-mint pre-flight read status for participants that ALREADY carried a recovery identity (R9C proof S9, two lab scenarios). Fixed (`565270f`); the recovery real-rail stub made truthful (`3b67821`). |
| #3 | `3b67821` | 8/10 groups | payments: the fuzz drew seed **2061983203** and found **F-9** (double capture under a flapping status, §3); db: the Phase 1B pool-hygiene proof trusted one `pg_stat_activity` snapshot (flake, now polled). Fixed (`6cec97f`). |
| #4 | `6cec97f` | 9/10 groups | payments GREEN (fresh seed 2064003608, 300/300); db: the pool-hygiene proof red a second time (`guard did not observe the idle termination`) — in a full run it could terminate another test process's idle `siton-%` backend, invisible to its own pool by design, and waited a fixed 300 ms. A first hardening (own pool backends only, bounded poll — `9aa5417`) still raced the 100 ms idle reaper of the test pool (1 of 2 reruns red); the vacuity check now holds one client checked out, terminates exactly that backend and polls for the guard observation. db group reruns: **3/3 green** (7/7 each, `40f94d1`). |

| Pass on the final tree (`6cec97f` src) | Result |
|---|---|
| fuzz, seed 2061983203 (the F-9 seed), 300 scenarios | **300/300** (456 participants, 512 provider effects, 126 s) — the F-9 schedule replays green |
| fuzz, seed 20260907, 2 000 scenarios | **2 000/2 000** (3 107 participants, 3 576 provider effects, 789 s, `LAB_TEST_TIMEOUT_MS=1800000`) — the run that earlier failed at #344 (F-8) replays green end to end |
| mutations M16 (pre-flight removed), M17 (single-read pre-flight), M01 (fee 7 %) on the final tree | **3/3 caught** (`mutation_final.log`); program total 17 mutations tested / 15 caught / 2 survived |
| mutation pass 3, all 16 (tree `f5ab275`, §4.1) | 14 caught / 2 survived (M05, M10 — redundant defences proven at the database) |

Each regression's red files were attributable to this program's own changes or to a test that trusted a single
snapshot; none was a defect of master or of the R9C lifecycle as ported. Regression #3 is the reason this program
keeps the fuzz seed UNPINNED in `test:all`: a pinned seed would never have drawn F-9.

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
