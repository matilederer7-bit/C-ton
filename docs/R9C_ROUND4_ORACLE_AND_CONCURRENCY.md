# R9C round 4 — oracle soundness + the concurrency final-state failure

Branch `claude/review-r9c-financial`. Frozen review SHA at start `ec9cf243084bf5379ff3020933bd9f820503901a`;
canonical master `82c91d62fd092350748405c8aec15a23d0e2af5e` (verified unmoved at the end).

Codex round 3: F12 production fix **PASS**; merge gate **BLOCKED** on two independent items —
(1) the round-3 financial test oracle accepts an unsafe history (temporal leakage);
(2) an unexplained `COMPLETED_DEAL_PARTICIPANT_NOT_FINAL` final-state failure in the two-worker
concurrency matrix.

The F12 production fix was **not** reopened. Production code changed in exactly one area — the
`finalize_deal` handler's participant outcome and the release rail's admitted states — because the
concurrency analysis proved two adjacent defects there (F-14, F-15, plus the stuck-hold F-16). Every
production change carries failing-first evidence. Codex's own reviewer-authored files in
`.worktrees/f12-round3-review` were read, not modified.

---

## 1. Oracle soundness

### 1.1 Reproduction of Codex's rejection (own tree, own control)

`tests/review_oracle_temporal_negative_validation.ts` feeds the shipped oracle controlled histories
whose FINAL rows look legal. Against the round-3 oracle (log `r4-oracle-controls-vs-shipped.log`):

| control | history | expected | round-3 oracle |
|---|---|---|---|
| A | K1 answered *pending*; K2 dispatched; status *failed* only afterwards | reject | **accepted, 0 violations** |
| B | K1 *pending*; K2 dispatched; `late_money_effect` note appears later (Codex's exact history) | reject | **accepted, 0 violations** |
| C | K1 *503* (unknown); K2 dispatched; reconciliation *authorized/final* only afterwards | reject | **accepted, 0 violations** |
| E | capture *503*; recovery dispatched; failure known only at the end (cross-operation) | reject | **accepted, 0 violations** |

Codex's finding is reproduced: the `late_money_effect` exemption (and, more generally, reading the
final `result_class`) let future observations legalise a past dispatch. 10 of 18 controls failed
against the shipped oracle.

### 1.2 Root cause

`tests/lab/oracle.ts` (round 3) and the fuzz test's own assertion judged "a repeat is legal only after
the previous identity was provider-declared failed" from the **final** `payment_attempts.result_class`,
then exempted rows whose `outcome_note` starts with `late_money_effect:`. Both inputs are written
after the dispatch; neither carries the *position* of the evidence relative to the dispatch.

### 1.3 The invariant, written down (`tests/lab/dispatch_legality.ts`)

> The legality of a money-moving dispatch is decided ONLY from evidence whose position in the causal
> order is strictly BEFORE that dispatch. Nothing observed later — a late money effect, a
> reconciliation verdict, a webhook, an operator case, a later provider status, the final
> `result_class` of any row — may convert an unsafe earlier repeat into a legal one.

**Ordering sources (from the data model, no invented clocks).**
The provider simulator's request log carries a monotonic `seq` for every interaction (money
requests, replays, status reads) — the canonical order of everything the provider ever told the app.
A provider-channel fact is "before dispatch D" iff `seq < D.seq`. Evidence that reaches the app
outside that channel — a callback (`siton.webhook_events.received_at`) or an operator verdict
(`payment_attempts.failure_evidence='operator'`, `updated_at`) — is ordered against the DB instant at
which the app **armed** the dispatch (`payment_attempts.dispatched_at`, written before I/O, 067).
Provider positions are compared with provider positions and DB instants with DB instants; the two
clocks are never compared with each other.

**Authoritative negative evidence for identity K, all positioned before D:**

| | evidence | position rule |
|---|---|---|
| E1 | exact-operation decline — a request carrying K itself answered with a provider-declared failure: definitive 4xx (not 408/425/429) or 2xx `ok:false` | provider `seq` |
| E2 | a status read declaring NON-execution of K's operation, `final`, correctly referenced, delivered; for a **capture-side** identity taken at/after the settlement horizon = (later of K's dispatch and the provider's last non-final answer) + policy horizon; only when the contract declares negative finality authoritative (never Grow) | provider `seq` + provider `at` |
| E3 | operator verdict recorded on K's row | DB `updated_at` ≤ `dispatched_at` of D |
| E4 | provider callback declaring K's operation failed | DB `received_at` < `dispatched_at` of D |

Ambiguous answers (pending, 5xx, 408/425/429, hang / reset / lost / timeout, malformed or truncated
bodies, non-final or mis-referenced reads) are **not** evidence in either direction. UNKNOWN is never
failed.

**What is judged.** Capture-side family (capture + recover share one obligation), refund family and
release family: every identity after the first needs authoritative negative evidence for the previous
identity of the family → else `AUTOMATIC_REPEAT_WHILE_UNKNOWN`. A release must find authoritative
negative evidence for **every** capture-side identity dispatched before it (`RELEASE_AFTER_CAPTURE_DECLARED`
/ `RELEASE_WHILE_CAPTURE_UNRESOLVED`). A refund needs a capture-side identity declared **executed**
before it when any exists in the log (`REFUND_WITHOUT_CAPTURE_EVIDENCE`).

**Independence.** The rule reads the provider's own log and DB timestamps; it never reads
`result_class`, `outcome_note`, `failure_evidence` provenance or the app's decision functions.
The definition of "declared failure" is the provider-ready contract's (a declared 4xx / `ok:false`),
not the implementation's classifier. The simulator now records, on every status read, what it
DECLARED (`declared.state/final/delivered/reference_ok/amount_ok`) so the oracle never infers it.
Every judgement names the evidence it relied on (`report.dispatch_judgements`); the fuzz asserts that
every repeat is judged legal **with named pre-dispatch evidence**.

**Horizon scope — a deliberate decision, not a weakening.** The first temporal rule applied the
settlement horizon to refunds too and rejected exact-seed index 59 (a refund identity rotated 24 ms
after a `captured/final` status read following a 503). The production contract scopes the horizon to
capture-side identities: `app.ts` arms refund/release identities with `settlement_horizon_ms: null`,
and migration 068's owner decision names recovery, release and the terminal decision — not refunds.
The oracle now applies the horizon to capture-side targets only. Temporal ordering is fully enforced
for refunds (the read must be final, delivered, correctly referenced and positioned before the
dispatch). The residual risk of that contract is recorded below as **F-13**, not silently
re-legislated by the oracle.

### 1.4 Negative controls (all 18 pass on the round-4 oracle; log `r4-oracle-controls-vs-fixed.log`)

Reject: A retry-before-failure/failure-later · B retry-before-failure/late_money_effect-later ·
C retry-while-unknown/reconcile-failed-later · D second-capture-while-first-could-succeed ·
E recovery-on-final-state-knowledge · F1 release-after-capture-declared ·
F2 release-while-capture-unresolved · I3 pre-horizon status is not evidence ·
I5 operator verdict after dispatch · I7 callback-failed after dispatch · J refund without capture evidence.
Accept: G retry after exact decline (later note irrelevant — the trace-152 shape) · H same-identity
replay · I1 recovery after exact decline · I2 recovery after post-horizon status ·
I4 recovery after operator verdict before arm · I6 recovery after callback before arm ·
K refund after declared capture. Every control asserts its chronology and its verdict.

### 1.5 Mutation / anti-self-deception (`scripts/review_mutation_proof.cjs OM-*`, log `r4-oracle-mutations.log`)

| mutant | what it re-introduces | killed by |
|---|---|---|
| OM-1a | M1 — a status read positioned AFTER the dispatch counts | control A |
| OM-1b | M1 — operator / callback evidence after the arm instant counts | control I5 |
| OM-2 | M2 — the round-3 `late_money_effect` exemption | control B |
| OM-3 | M3 — 5xx / pending / lost read as declared failure | control A |

**4/4 killed.** Compile/setup errors would count as INVALID, never as a kill.

A slip the gate itself caught, recorded rather than hidden: the first round-4 commit (`44b89f4`) still
carried the first edit of OM-1b, because the harness recorded a file's "original" once **per edit** and a
mutant with two edits on one file therefore saved the once-mutated bytes and restored those. Control I5
(operator verdict after the dispatch) went red in the final gate — exactly what it exists for. The guard
is restored, the harness records each file's original once and verifies the restore byte-exactly
(`git log`: the correction commit follows `44b89f4`).

### 1.6 The exact seed and trace 152

`LAB_FUZZ_SEED=209752203`: **300/300** under the round-4 oracle, 474 participants, 541 provider
effects (`r4-seed-full.log`). Anti-vacuity over the seed (`r4-seed-full-trace.log`): 539 dispatches
judged; 60 repeats, all legal with named evidence — 28 by exact decline (E1), 27 by post-horizon
status reads (E2, horizon 1500 ms), 5 by refund/release status reads (E2, horizon 0); 0 illegal.

**Trace 152 verdict: genuinely safe, for the right reason.** Replay (`r4-seed-replay-152.log`):
n1 (seq 1) answered `402`; n2 dispatched at seq 2 is judged `legal` on
`{"kind":"exact_decline","seq":1,"answered":"402"}`. The later `charge_captured` callback that turns
n1 into a `late_money_effect` row plays no part in the verdict. No production bug behind it; the
late-effect case it opens is the designed visibility of a provider contradiction.

Index 59 (the one rejection during the work) was investigated, not suppressed: see §1.3 and F-13.

---

## 2. Concurrency final-state failure

### 2.1 What Codex saw, and what the preserved data allows

Round 2: participant `e2ad2e26-…`; round 3: participant `a6d98d61-b69e-41d8-bc61-503bdfdd7ce4` —
`COMPLETED_DEAL_PARTICIPANT_NOT_FINAL: deal Completed, buyer_state=ChargedSuccess`, with
`converged=80/80 duplicates=0 deadlocks=0`, 80 captures, 80 ledger rows, 0 unknown, 0 cases,
0 live money events. Their `r3-concurrency.log` preserves exactly one line about that participant
(the oracle line); worker output lives in the test process's memory and is only printed on a worker
exit failure. The disposable database was dropped by the runner. The chronology therefore had to be
re-derived from the production source and reproduced — which was done deterministically.

### 2.2 Root cause (from `src/app.ts`, then reproduced)

`handleFinalizeDealEvent` decides the deal, commits `deal → Completed` in **its own transaction**, then
reads the participants and transitions each one in a **separate transaction from the state it read**.
Its F-2 gate defers while any capture-side identity is UNKNOWN or executed-but-unapplied (R-11), so the
only participant it can read as non-final and still proceed is one with **no capture identity yet** —
never attempted (e.g. a `charge_deal` re-run after a lost lease has not reached it; threshold 1 is met
by the other participant). If that participant's capture then lands between finalize's read and
finalize's CAS, the CAS finds the row changed: `State mismatch participant … expected ChargingAttempt`,
the handler throws, the outbox marks the finalize job **failed → pending, deferred by backoff**.

The two-worker test drains only `charge_deal / recovery_deal / payment_reconcile`, stops both workers
(graceful SIGTERM — it waits for the in-flight cycle, so SIGTERM is not the mechanism), and audits at
once. The deferred finalize retry — which takes the `Completed` branch — never runs before the oracle
reads `deal=Completed, participant=ChargedSuccess`.

**Classification: B (test assertion timing) + E (incorrect expected terminal state at that instant),
on top of a real, benign CAS conflict in the runtime.** For Codex's 2-participant instance the state
is self-healing: the retry completes the participant with zero provider interaction.

### 2.3 Deterministic reconstruction and terminal-state proof — `tests/review_finalize_participant_race_terminal_state_validation.ts`

Real handlers in-process, disposable database, in-process simulator; interleavings forced with the
participant/deal locks so they are order-independent. **8/8, three consecutive runs**
(`r4-finalize-race-postfix-{1,2,3}.log`).

| | what | result |
|---|---|---|
| RC-1 | Codex's order: capture lands after finalize's stale read | deal `Completed`, p2 `ChargedSuccess/ChargedSuccess`, finalize `pending#1 deferred=true` `last_error="State mismatch … expected ChargingAttempt"` — Codex's signature |
| RC-2 | oracle at that instant | exactly `COMPLETED_DEAL_PARTICIPANT_NOT_FINAL`; 2 captures, 2 canonical, 0 unknown |
| RC-3 | deferred retry | both `DealCompleted`, provider request count unchanged, effects unchanged, oracle clean |
| RC-4 | terminal invariant | effects ↔ identities ↔ money_state ↔ buyer_state ↔ deal state agree; p2 chain `ChargingAttempt→ChargedSuccess | ChargedSuccess→DealCompleted`, money `ChargeAttempt→ChargedSuccess`; no failed-while-captured, no success-without-capture, no non-terminal residue |
| RC-7 | control | without the interleaving one run completes both |

### 2.4 Two adjacent defects the analysis exposed — proven failing-first, then fixed

Pre-fix run (`r4-finalize-race-prefix.log`): RC-5 and RC-6 **FAIL**; post-fix: PASS.

**F-15 — the other order of the same race (real money defect).** If finalize's `DealFailed` CAS commits
between the capture's **arm** (identity minted under the participant/deal advisory lock, before I/O) and
its **ingest**, the ingest fails on the buyer-state CAS and the participant ends
`buyer_state=DealFailed, money_state=ChargeAttempt` with money captured at the provider — charged buyer,
marked failed, no refund path (pre-fix RC-5: `finalize=sent ingest=409 p2=DealFailed/ChargeAttempt`,
1 capture effect). *Fix:* the fail-participant transition takes the **same advisory lock the rails
take**, then refuses (defers — a deferral burns no attempt) when any capture-side identity of the
participant is not `permanent_fail`. A plain read without the lock was tried first and proven
insufficient (an arm landing between the read and the CAS still slipped through). Post-fix RC-5a:
finalize first → the rail's arm reads `DealFailed` and refuses, no money moves, hold released;
RC-5b: arm first (after the F-2 gate) → the guard defers naming the identity, the capture lands, the
retry completes the participant.

**F-14 — the retry path only completed paid participants.** `completeParticipantsOfCompletedDeal`
(R-11) handled `ChargedSuccess/Recovered` only; a finalize aborted mid-loop left every unpaid sibling
after the conflicting participant non-terminal on a `Completed` deal, hold never released, no sweeper
covers it (`rescheduleStalledFinalizations` targets `CompletionWindow` deals only). *Fix:* the whole
completed-deal outcome is one idempotent routine `applyCompletedDealOutcome` (complete paid, fail unpaid
with the F-15 guard, release held authorizations, notifications, receipts, fulfillment, payout) used by
the fresh path and by every retry. Idempotency of each step verified in source (idempotency keys,
`ON CONFLICT (idempotency_key)`, `ON CONFLICT DO NOTHING`, one-pending indexes).

**F-16 — a never-attempted participant's hold was never released.** `scheduleAuthorizationReleasesForDeal`
and the release rail's entry/arm admitted only `AuthHeld/AuthLocked/ChargeFailedRecovery`, although
`applyAuthorizationRelease` already implements `ChargeAttempt → AuthReleased` (Residual C) and
`beginProviderAttempt` already refuses a release identity behind any unresolved or executed capture.
*Fix:* `ChargeAttempt` admitted in the scheduler and the rail entry/arm; the DB fence and the
`applyAuthorizationRelease` belt are unchanged and still guard it. Proven by RC-5a
(`money_state=AuthReleased`, 1 release effect, oracle clean).

### 2.5 Sampling the real two-worker matrix

`scripts/review_flake_probe.cjs payment_lab_concurrency_matrix_validation.ts 20` on the fixed code, with
the test instrumented to print the finalize job rows, the participant's audit chronology and the
worker output tails whenever a `Completed` deal has a non-final participant at audit time
(`TRANSIENT_NON_FINAL …`). Result: see PROJECT_STATUS (filled from `r4-matrix-probe-20.log`).

The test premise is corrected as well (`payment_lab_concurrency_matrix_validation.ts`): after the
workers stop, the remaining `finalize_deal` work is drained in-process and it is asserted that this
drain moves no money (provider request count and effects unchanged) **before** the strict deal-level
oracle — quiescence now includes the terminal decision, and the deal-level invariant stays strict.

---

## 3. Findings ledger (this round)

| id | class | status |
|---|---|---|
| oracle temporal leakage | test-oracle unsoundness | **FIXED** (dispatch_legality.ts; 18 controls; 4/4 mutants) |
| concurrency final-state failure | B+E: audit timing on a benign, self-healing CAS conflict | **EXPLAINED + reproduced**; test premise corrected |
| F-14 | retry path strands unpaid siblings (stuck non-terminal, hold unreleased) | **FIXED** (production) |
| F-15 | DealFailed committed between arm and ingest → charged buyer marked failed | **FIXED** (production) |
| F-16 | never-attempted `ChargeAttempt` hold never released on a decided deal | **FIXED** (production) |
| F-13 | refund identity rotation trusts a final status read with no settlement horizon (contract-consistent; a lying/lagging provider could produce a double refund) | **OPEN — owner decision** (out of scope here; the simulator is honest, so the lab cannot manifest it) |
| F-2 F-5 F-6 F-10 F-11 | as before | untouched by instruction |

Real money 0. Grow untouched, never called. No hosted DB. No deploy. Migrations 066/067/068 unchanged.
