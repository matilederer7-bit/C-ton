# R9C — INDEPENDENT ADVERSARIAL FINANCIAL REVIEW (exact SHA review, no merge)

**Status: REVIEW + REMEDIATION on `claude/r9c-financial-review-remediation`. `SAFE_TO_MERGE_FINANCIAL_BRANCH = NO`. `SAFE_FOR_REAL_MONEY = NO`. R10 BLOCKED.**
Real money 0 · real Grow calls 0 · real provider calls 0 · no deployment · canonical staging untouched · migrations 063/064
never applied to staging · master `60ebf6d` never touched.

| | |
|---|---|
| Reviewed candidate | `claude/r9c-financial-torture-candidate` @ `5dcee1ff29fc2159d27ddc80a355d8d01b8a46dc` (27 commits over `origin/master = 60ebf6d64fb0d5909ae98fa335a4a27ad45c9172`, master is a direct ancestor) |
| Review branch | `claude/r9c-financial-review-remediation`, created from the exact candidate SHA (worktree `C:\tmp\fin-review`, own `node_modules`, disposable databases only) |
| Method | the candidate was treated as another team's code: its report, tests, oracle and classifications were not trusted; every finding below was reproduced by a NEW counterexample written before any fix, committed RED against the unmodified candidate source (evidence commit), then fixed narrowly and pinned |
| Owner financial-truth decisions applied | (1) `AuthReleased` only with authoritative release/expiry proof; (2) no automatic recovery from status reads alone after a capture may have been dispatched — exact-operation evidence AND a provider-specific settlement horizon, otherwise UNKNOWN / HOLD / OPERATOR CASE; (3) Grow post-dispatch ambiguity stays FAIL-CLOSED (settle/refund idempotency and exact-operation status UNPROVEN) |

---

## 1. Verdict on the candidate as reviewed (before remediation)

The candidate's own program (F-1 … F-9) closed real defects, but three of the owner's hard requirements were **not met** by the tree at `5dcee1f`,
and the evidence commit `644a133` reproduces each one deterministically against that exact source
(`tests/payment_review_adversarial_validation.ts`, `tests/payment_review_grow_negative_status_validation.ts`,
`tests/payment_review_mock_provider_truth_validation.ts`; run log `EVIDENCE_baseline_5dcee1f_unmodified.log`, 10 + 1 + 1 red scenarios):

| # | Severity | Finding (unmodified candidate) | Counterexample |
|---|---|---|---|
| R-1 | **CRITICAL** (synthetic money) | **Automatic recovery while the original capture can still settle.** A provider that settles asynchronously (capture answered `200 pending`, effect 100–1200 ms later) and whose status seam answers a CONSISTENT `failed/final` (or `authorized/final`) during that settlement: the reconcile rail infers `charge_failed`, arms recovery, the F-9 double-read pre-flight reads the same consistent answer twice and proceeds, the recovery captures, then the original capture lands — **8 400 minor captured for a 4 200 obligation**. The candidate's F-9 fix only defends against a *flapping* provider; it has no settlement horizon at all (the author documented this as a residual and called the horizon "an owner decision"; the owner has now decided). | RA-1a (failed/final), RA-1b (500, 500, then failed/final), RA-1c (authorized/final), all `DUPLICATE_CAPTURE` |
| R-2 | **CRITICAL** (synthetic) | **Terminal decision on money that is still moving.** The completion window ends while such a status-inferred failure is still settling: finalize decides on the inferred verdict, the deal completes on the recovery, the original capture lands afterwards — double capture hidden behind a terminal state. | RA-9 |
| R-3 | **CRITICAL by policy** (Grow) | **Second settle on Grow after a `failed` lookup.** `handlePaymentReconcileEvent` gated only `authorized/final` behind `negative_status_authoritative`; a status of `failed` was an authoritative verdict for EVERY provider. Grow: settle executes → HTTP 503 (UNKNOWN) → `getTransactionInfo` reports a failure code → `charge_failed` verdict → recovery → **a second `settleSuspendedTransaction`**. Violates owner decision (3). Same gap in `resolvePriorProviderAttempt`. | Grow probe (in-process test transport, real Grow calls 0): `settle_calls = 2` |
| R-4 | **HIGH** (F-6, owner decision 1) | `charging.recovery_failed` set `AuthReleased` with **zero provider releases** — even when the provider would REFUSE the release. Money truth by assumption. | RA-2a (declined recovery), RA-2b (reconciled recovery_failed), RA-2c (release refused): all `AuthReleased` with `release=0` |
| R-5 | MEDIUM | **Currency is not part of the exact-operation identity.** A status answer with the right amount in USD for an ILS obligation was applied as `ChargedSuccess`. | RA-3 |
| R-6 | MEDIUM | **A status echo naming another reference rewrote the durable binding** (`updateProviderReferenceForParticipant` from a status READ in the reconcile and prior-attempt paths, O-1). Evidence that cannot be tied to the exact operation became its identity. | RA-5 (`binding → other-…`) |
| R-7 | MEDIUM | **Unverifiable status still let money move.** Pre-flight reads answering `unknown` (status seam 500 on every read) → `proceed` → recovery sent for a failure whose provenance was not the provider's answer to the exact request. | RA-6 |
| R-8 | MEDIUM (product, mock-backed deployments) | The in-process mock's `status()` fabricated `captured/final` for every reference; with the F-1 pre-flight in place every declined mock capture was mis-read as "already captured": the capture identity was flipped to SUCCESS for money that never moved, a false `payment-late-money-effect` case opened, and recovery was blocked for ever on demo/staging. | mock probe |
| R-9 | LOW-MEDIUM | Refund / release adapters treated a 2xx body carrying an id but **no declared outcome** ("legacy shape") as success — canonical `Refunded` / `AuthReleased` on an undeclared outcome. | FR-7b (added with the fix) |
| R-11 | MEDIUM (found by the full regression on the remediated tree; latent on the candidate) | **Terminal decision on executed-but-unpersisted money.** The F-2 finalize guard defers only on UNKNOWN capture identities. An identity the provider EXECUTED whose canonical state is not yet applied (the gap between the dispatching owner's `settle(success)` and the ingest transition — the R9C "SUCCEEDED-unpersisted" lifecycle state) lets finalize decide; its participant transition then races the ingest and, on the retry, the deal is already Completed and returns early: a paid buyer stranded at `ChargedSuccess` on a Completed deal — no `DealCompleted`, no receipt, no fulfillment, no case (`COMPLETED_DEAL_PARTICIPANT_NOT_FINAL`). Surfaced 2/80 in the two-real-worker run because the settlement-horizon deferral makes finalize and recovery wake at the same instant. | concurrency matrix TWO_WORKERS (r1), FR-2b / FR-2c (deterministic) |
| R-10 | LOW-MEDIUM (identity ledger) | A reconcile job carrying an **already-declined** capture identity (stale, `permanent_fail`) read the per-authorization status while a NEWER capture identity was UNKNOWN and flipped the stale identity to `success` from evidence that belonged to the newer one — two capture identities "executed" for one provider effect (money and canonical state correct; identity ledger false). | FR-4 (found during reconstruction of the author's F-4) |

No finding was silently patched: every counterexample was committed red first (`644a133`), then the narrowest fix was made and the same
suites turned green; the fixes are separately mutation-tested (§5).

## 2. F-1 … F-9 independently reconstructed

| Finding | Author's fix inspected | Different adversarial variation (review) | Verdict |
|---|---|---|---|
| F-1 recovery pre-flight | `verifyOriginalCaptureBeforeRecovery` | consistent (non-flapping) wrong status during settlement (RA-1), unverifiable status (RA-6), amount/currency-mismatched "captured" (RA-3/RA-4d), wrong-reference echo (RA-5) | **FAIL as shipped** (R-1, R-7) → PASS after the settlement horizon + evidence provenance + hold-on-unverifiable |
| F-2 finalize waits for UNKNOWN captures | `handleFinalizeDealEvent` | UNKNOWN **recovery** identity while the threshold is already met (FR-2); status-inferred failure still inside its horizon (RA-9, H-6, H-6b) | PASS (unknown) / **FAIL as shipped** for inferred failures → PASS after the finalize fence + post-horizon look |
| F-3 HTTP webhook late-effect parity | `recordLateMoneyEffectException` wired into `handleWebhookPayments` | late `recovery_captured` for a Dropped participant whose recovery was declared failed → case, identity success, pending release BLOCKED (FR-3) | PASS |
| F-4 reconcile queued behind | `schedulePaymentReconcile` + sweeper | the blocking reconcile is `processing` under a DEAD lease (FR-4) — visible (queued-behind case), reclaimed, then the live identity converges; but the reclaimed STALE reconcile flipped the already-declined identity to `success` from the live identity's status | visibility PASS / **FAIL as shipped** (R-10) → PASS after "a terminal identity steps aside while a sibling is unresolved" |
| F-5 / F-5b family discipline | `resolveTarget`, `recordLateMoneyEffectException` | `refund_issued` carrying the CAPTURE correlation for a never-captured participant (FR-5b): capture identity untouched, no refund identity fabricated, contradiction case | PASS |
| F-6 | NOT fixed by the author | RA-2a/b/c | **FAIL** → fixed (§3.2) |
| F-7 refund/release 2xx pending | `classifyRefundOutcome/ReleaseOutcome` | `status:"processing"` (FR-7) PASS; **id-only 2xx** (FR-7b) → **FAIL as shipped** (R-9) → PASS after tightening to UNKNOWN |
| F-8 pre-flight before mint | `handleRecoveryDealEvent` | pre-flight holds on `pending`, then a `recovery_failed` provider event drops the participant → zero recovery identities, hold released WITH proof (FR-8) | PASS |
| F-9 flapping status | double read | `FLAP(failed, failed, captured)` — two consistent negatives then the truth: safe only because the horizon holds until the third read (FR-9); `WHILE_SETTLING` consistent lies (RA-1) | **FAIL as shipped** for consistent lies → PASS with the horizon |

## 3. Remediation (narrow, on the review branch only)

### 3.1 Settlement horizon + failure evidence — migration `064_payment_settlement_horizon.sql`
Provider-neutral recovery fencing contract, durable in the database:

* `payment_attempts.settlement_horizon_at` — opened when a capture-side identity is **armed** for I/O (`dispatched_at + policy.settlement_horizon_ms`),
  only ever extended (`GREATEST`; a re-arm after a pre-dispatch failure extends, a `pending` status read extends), never shortened or cleared
  (UPDATE trigger), never reset by identity rotation (the fence reads EVERY capture-side row of the participant).
* `payment_attempts.failure_evidence` — provenance of a `permanent_fail`: `dispatch_response` (the provider's answer to the exact request — set only by
  the dispatching owner in `settleProviderDispatch`, never downgraded), `status_inference` (reconcile / prior-attempt resolution / pre-flight),
  `provider_event` (callback), `operator`.
* `siton.payment_capture_settlement_fence(participant, deal)` — the latest open horizon of a capture-side `permanent_fail` row whose evidence is NOT
  `dispatch_response`; NULL = no fence.
* While fenced: no recovery and no release identity may be minted (INSERT trigger, DB-authoritative backstop; `beginProviderAttempt` answers `fenced`);
  the recovery job (`payment-recovery-settlement-horizon:<participant>`), the release job (`payment-release-settlement-horizon`) and the terminal
  finalize decision (`deal-finalize-waiting-settlement-horizon:<deal>`) are deferred to the horizon instant with an open case.
* Past the horizon: the recovery pre-flight re-verifies the capture (amount AND currency must match the obligation; `pending` extends the horizon;
  disagreement → hold; `unknown` → hold with `payment-recovery-preflight-unverifiable` unless the failure is `dispatch_response` evidence); finalize
  makes the same authoritative look at every dispatched status-inferred failure before deciding, so a late settlement becomes visible truth (identity
  success + case, captured money never released) instead of being hidden behind Completed / Failed.
* Policy: `ProviderAmbiguityPolicy.settlement_horizon_ms` — mock / synthetic 0 (in-process, synchronous), provider-ready `PAYMENT_SETTLEMENT_HORIZON_MS`
  (default 24 h, owner-configured per provider contract, never guessed from expiry behaviour), Stripe / Grow 24 h (Grow is fail-closed regardless).
  Lab: 1 500 ms (the simulator settles within ~1.2 s).

### 3.2 F-6 — `recovery_failed` is business truth, not money truth
`charging.recovery_failed` now moves `buyer_state` to `Dropped` only; `money_state` stays `ChargeFailedRecovery` and a `payment_release` job is
scheduled. `AuthReleased` is reached exclusively through the provider-proofed release rail (declared release → `authorization.release`), and a refused
release stays honestly held with the existing `payment-release-failed` case (RA-2c). The oracle no longer tolerates any `AuthReleased` without a
provider release effect (`FALSE_CANONICAL_RELEASE`, no F-6 allowance).

### 3.3 Grow fail-closed on `failed`
Reconcile and prior-attempt resolution treat `failed` exactly like `authorized/final`: a verdict only when `negative_status_authoritative`; for Grow
`FINANCIAL_OUTCOME_UNRESOLVED` case, `PermanentFail`, no recovery, no second settle.

### 3.4 Exact-operation identity
Currency is compared against the binding in the reconcile, prior-attempt resolution and the pre-flight (`payment-reconcile-currency-mismatch`,
`payment-recovery-preflight-mismatch`); a status READ never rewrites the durable provider reference (only the provider's answer to a money request
this rail sent may). Refund / release 2xx bodies without a declared outcome are UNKNOWN.

### 3.5 Truthful mock
The mock provider remembers what it executed (`mockExecutedOperations`) and answers status from that memory only.

### 3.6 R-11 — the terminal decision waits for executed-but-unpersisted money
The F-2 guard also treats a capture-side identity at `result_class = success` whose participant is not canonically captured as unresolved
(reconcile scheduled, finalize deferred). A finalize retried on an already-Completed deal sweeps every `ChargedSuccess` / `Recovered`
participant to `DealCompleted` with receipt and fulfillment (idempotent), so a transition that lost a race can never strand a paid buyer.

### 3.7 Behavioural consequences (owner's "reduced automation is acceptable")
A recovery that follows a status-inferred failure now waits for the provider's settlement horizon (24 h by default on the provider-ready rail;
a synchronous decline of the capture request itself is still recovered immediately). A deal whose window ends inside such a horizon stays in
`CompletionWindow` with an open case until the horizon and one authoritative status look. Three existing suites that asserted `AuthReleased`
immediately after a declined recovery were changed to assert the honest intermediate state (`Dropped / ChargeFailedRecovery` + pending release)
and, where the harness can drive the outbox, the proof-backed `AuthReleased` afterwards.

## 4. Results — review suites (fresh isolated databases, synthetic provider / in-process Grow transport)

| Suite | On `5dcee1f` (unmodified) | After remediation |
|---|---|---|
| `payment_review_adversarial_validation.ts` — RA-1a/1b/1c/1d, RA-2a/2b/2c, RA-3, RA-4a-d, RA-5, RA-6, RA-7, RA-8a-d, RA-9 | **10/20 FAIL** | **20/20** |
| `payment_review_grow_negative_status_validation.ts` | **1/2 FAIL** (second settle) | **2/2** |
| `payment_review_mock_provider_truth_validation.ts` | **0/1 FAIL** | **1/1** |
| `payment_review_settlement_horizon_validation.ts` — H-1 … H-8 (incl. the NEGATIVE CONTROL that double-captures with the horizon forced closed) | n/a (needs 064) | **12/12** |
| `payment_review_findings_reconstruction_validation.ts` — FR-2, FR-3, FR-4, FR-5b, FR-7, FR-7b, FR-8, FR-9, FR-C2, FR-C3, FR-C4 | n/a | **11/11** |

Economic effects across every review run after remediation: DUPLICATE_CAPTURE 0 · DUPLICATE_RECOVERY 0 · DUPLICATE_REFUND 0 ·
DUPLICATE_RELEASE 0 · FALSE_CANONICAL_SUCCESS 0 (RA-4a documents the provider-lie trust boundary and is oracle-visible) ·
FALSE_CANONICAL_RELEASE 0 · LOST_PROVIDER_EFFECT 0 · UNRESOLVED_WITHOUT_CASE 0 · automatic recovery while the capture could still
settle 0 · deadlocks 0.

## 5. Anti-vacuity — mutation testing (`scripts/financial_lab_mutations.cjs`, M18–M31 added)

Each mutant is applied to the working copy (several files at once where the invariant has a DB backstop), the mapped review
suite is run on a fresh database, the files are restored (`git checkout --`, content-compared across autocrlf). Result of this
review's pass (`mutations_review*.log/json`): **review mutants M18–M31: 14 tested / 14 caught / 0 survived**; the author's
mutants that touch code changed by the remediation were re-run — **M01, M02, M07, M16, M17: 5/5 caught**. (M27's first form
mutated the reconcile's late `finalizeAttemptResult`, a dead site for provenance because the canonical transition settles the
identity first; it survived, was retargeted to the primary site and is red. The author's M05 / M10 survivors remain documented
redundant DB defences, unchanged.) ANTI_VACUITY = PASS.

| Mutant | Invariant | Suite that goes red | Result |
|---|---|---|---|
| M18 settlement fence removed (app predicate AND migration 064 SQL) | horizon fences automatic recovery | horizon (H-3), adversarial (RA-1) | CAUGHT |
| M19 recovery_failed releases by assumption | F-6 | RA-2 | CAUGHT |
| M20 currency check removed | currency identity | RA-3 | CAUGHT |
| M21 `failed` accepted as a Grow verdict | Grow fail-closed | Grow probe | CAUGHT |
| M22 status echo rewrites the binding | O-1 | RA-5 | CAUGHT |
| M23 mock status fabricated | truthful mock | mock probe | CAUGHT |
| M24 unverifiable pre-flight proceeds | hold on unverifiable | RA-6 | CAUGHT |
| M25 finalize fence removed | terminal decision waits | H-6 | CAUGHT |
| M26 release fence removed | no release-then-capture | H-5 | CAUGHT |
| M27 inferred failure recorded as exact evidence (primary site) | provenance | H-1 / H-3 | CAUGHT |
| M28 horizon not opened at dispatch | durable horizon | H-1 | CAUGHT |
| M29 terminal identity settled from a sibling identity's status | exact identity (R-10) | FR-4 | CAUGHT |
| M30 finalize ignores an executed-but-unpersisted capture | R-11 terminal decision | FR-2b | CAUGHT |
| M31 completed-deal sweep removed | R-11 finalize retry | FR-2c | CAUGHT |

## 6. Full repository regression

### 6.1 First full run — commit `7265568` (code identical to the final tree except the R-11 fix that it revealed)
Sequential chain (`regression_chain.sh r1`, 2026-09-07 16:33–16:59 local, one runner, fresh databases): static gates PASS
(`tsc --noEmit`, lint / backend enforcement scan, payment compliance scan, runtime DDL scan, architecture gate, `git diff --check`,
isolated migration proof **59/59** fresh + rerun + checksum ledger, drift 0), route-authorization gate PASS, fault report PASS.
`test:all` (218 files, 10 groups): **6/10 groups green** — unit 12/12, integration 29/29, api 41/41, security 36/36, failure 9/9,
e2e 13/13; red files and their disposition:

| Red file | Cause | Disposition |
|---|---|---|
| `charging_completion_window_validation.ts` (db) | the suite's provider stub has no `/status` seam; the pre-flight now HOLDS on an unverifiable status for a participant with no capture identity | stub answers a truthful `authorized/final`; scenario intent (UNKNOWN recovery truth) unchanged — 7/7 after |
| `payment_provider_operation_identity_crash_validation.ts` S4 (payments) | recovery after a status-inferred failure is now fenced by the settlement horizon (24 h default) | the suite declares a 400 ms horizon for its synchronous stub and asserts the hold (`recovery_held`) before the horizon elapses |
| `payment_release_lifecycle_validation.ts` (payments) | the stub's release answer was an id-only 2xx (R-9: UNKNOWN, never AuthReleased on an undeclared outcome) | the stub declares `status: "released"` |
| `payment_lab_concurrency_matrix_validation.ts` TWO_WORKERS (concurrency) | **R-11** (2/80 paid buyers stranded at ChargedSuccess on a Completed deal) + one truthful non-charge (lost capture request reconciled after the 6 s window) | R-11 fixed (`7c5d8af`), regressions FR-2b/FR-2c, mutants M30/M31; the random run admits ≤ 2 visible money-safe non-charges — 32/32 after |
| `worker_two_process_fencing_validation.ts` (workers) | timeout under load (deadline-check events only, worker code unchanged) | passes in isolation on the review tree (43 s) and on the untouched candidate (66 s); load-sensitive, not a remediation regression |

### 6.2 Exact final tip
See the follow-up section recorded with the final run (the regression must be run on the tip that carries this document).

## 7. Residual risks (documented, not hidden)

* **Provider finality lies beyond any horizon** (RA-1d): a provider that keeps answering `authorized/final` for an EXECUTED capture beyond the
  configured horizon defeats any client; the horizon must be set from the provider contract (owner), the oracle reports the double, and the
  late effect surfaces as a case as soon as any read tells the truth. Grow is fail-closed for exactly this reason.
* **Legacy rows** (armed before migration 064, `settlement_horizon_at IS NULL`) are not horizon-fenced; the pre-flight refuses to proceed on an
  unverifiable status for them and finalize does not look at them. None carry real money (SAFE_FOR_REAL_MONEY = NO throughout).
* **Status-answer reference identity** (O-1, mitigated): the durable binding can no longer drift, but a status answer naming an unrelated reference
  is still accepted as a verdict when its amount and currency match the obligation — reference-level verification needs the real provider's
  reference discipline (R10).
* **Release vs capture** (FR-C4, LOW): a charge that runs while a release of the same participant is IN FLIGHT still dispatches its capture
  request — the identity discipline fences release behind an unresolved capture but not capture behind an unresolved release. The provider's
  state machine declines the capture of a released hold; the declined capture's NEGATIVE settlement is fenced by the in-flight guard until the
  release settles; the end state is consistent (`Dropped / AuthReleased`, one provider release, zero captures). Not changed: blocking the
  capture would strand a released hold at `ChargeAttempt` (no legal money transition) — a broader state-machine change for the owner. A
  provider without a hold state machine (capture of a released hold succeeds) is outside this defence; the oracle would report it.
* `payment-late-money-effect` / `payment-recovery-preflight-captured` cases remain operator action items — there is no automatic refund for money
  captured on a deal that later failed (unchanged R9C doctrine).
* **Load-sensitive suites (not remediation regressions):** `worker_two_process_fencing_validation.ts` (deadline-check events only, no money
  rail; worker code unchanged) timed out twice under load — inside the full regression and again right after the payments group — and passes
  in isolation on both the candidate and the review tree. The two-real-worker random run (`payment_lab_concurrency_matrix`) can leave a
  participant whose capture request was lost client-side and reconciled after the 6 s completion window as a truthful, money-safe non-charge
  (0 effects, deal Failed, hold pending its provider-proofed release); the assertion now admits exactly that outcome (≤ 2 of 80) and keeps
  duplicates and the oracle hard.
* Grow native settle/refund idempotency and exact-operation status remain UNPROVEN (sandbox blocked).
