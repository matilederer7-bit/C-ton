# R9C round 5 — observed-evidence oracle + the real-handler authorization race

Branch `claude/review-r9c-financial`. Frozen review SHA at start `88b6d82322282c5ca43a6324d3b83934481b51f6`;
canonical master `82c91d62fd092350748405c8aec15a23d0e2af5e` (verified unmoved at start and at the end).

Codex round 4 found two merge blockers: (1) the round-4 dispatch-legality oracle legalised a retry
on a provider status answer that had been *generated* but not yet *delivered* to Siton; (2) a race in
the **real handlers** left an authorization held for ever behind a payment-attempt row that was never
dispatched to the provider. Both were reproduced first in this tree, then fixed; every production
change carries failing-first evidence, a mutant, and an A/B against the round-4 production source.

Pre-flight (`.tmp_r5/preflight.md`): no `node.exe`/`tsx` processes on the host, zero PostgreSQL
backends on any disposable database, this worktree clean at `88b6d82`; Codex's worktrees
(`.worktrees/f12-round4-review`, `.worktrees/f12-round4-mutations`) were read, never modified, and
nothing here depends on their state. Real money 0; Grow untouched and never called; no hosted
database; no deploy; migrations 066/067/068 unchanged (no migration added).

---

## 1. Blocker 1 — the oracle used a status answer before Siton could have observed it

### 1.1 Reproduction (own tree, own controls — before any change)

`tests/review_oracle_observation_negative_validation.ts` against the round-4 oracle
(`.tmp_r5/r5-oracle-observation-vs-shipped.log`): **5 of 13 controls fail**, i.e. the unsafe
histories are accepted:

| control | chronology | round-4 oracle |
|---|---|---|
| P1 (REAL simulator, Codex's exact steps) | T1 capture answered *pending* · T2 status query · T3 provider generates `authorized/final` and HOLDS it 1 000 ms · T4 second capture dispatched inside the hold · T5 answer delivered | **accepted** (second capture "legal") |
| A synthetic twin of P1 | same, explicit delivery positions | **accepted** |
| C exact decline generated, never delivered; retry | | **accepted** |
| F post-horizon failed read delivered after the recovery | | **accepted** |
| R delivered before the dispatch, recorded by Siton after the arm | | **accepted** |

Codex's own counterexample (`independent_oracle_delivery_control.cjs`, executed read-only from a
copy pointed at this tree's compiled lab) reaches the same verdict against the fixed oracle:
`AUTOMATIC_REPEAT_WHILE_UNKNOWN` at the legality layer and in the full oracle, exit 0
(`.tmp_r5/r5-codex-oracle-control-vs-fixed.log`).

### 1.2 Root cause (observability)

`tests/lab/provider_simulator.ts` assigned a request's `seq` / `at` in `record()` at **arrival** —
before the scripted `hold` — and `declared.delivered` was computed from `hold <= clientTimeoutMs`,
i.e. "deliverable eventually". `tests/lab/dispatch_legality.ts` then ordered every provider-channel
fact (exact declines E1, status reads E2) by that arrival position. A status answer the provider
had generated but not yet written back was therefore treated as Siton's knowledge from the moment
the provider *received the query*. PROVIDER KNOWLEDGE was equated with SITON KNOWLEDGE.

### 1.3 The observed-evidence rule (causal model)

Minimum model, from facts the simulator and the runtime actually record — nothing invented:

| dimension | source | meaning |
|---|---|---|
| `provider_effect_seq` | simulator `seq` (arrival) | the request reached the provider / the provider acted; positions the DISPATCH itself and the provider-side settlement horizon |
| `siton_observed_seq` | simulator `delivered_seq` — the **same** monotonic counter, taken at the instant the provider finished writing its answer back (`res.end`); `null` when the answer never left (socket destroyed, truncated, lost, held past the client timeout) | the earliest instant Siton could have observed the answer |
| `dispatch_seq` (arm) | `payment_attempts.dispatched_at` (DB, committed before I/O, 067) | when Siton armed the dispatch |
| `db_commit` | `payment_attempts.resolved_at` (DB, set once by the 067 trigger) | when Siton recorded the identity's terminal verdict |

Evidence for dispatch D is usable only when **Siton had actually observed it before D**:

* a provider answer (exact response E1, status read E2, and the positive counterparts used by the
  release/refund rules) counts only if `delivered_seq !== null && delivered_seq < D.seq` — an answer
  generated but still held, timed out, truncated, reset or lost is not evidence, whatever the
  provider knew; provider positions are compared with provider positions only;
* **and**, when Siton's ledger carries the identity the evidence is about together with D's arm
  instant, Siton must have recorded that identity's verdict before arming D
  (`resolved_at <= D.dispatched_at`, DB instant against DB instant) — a dispatch armed on in-memory
  knowledge persisted only afterwards is legalised by *later DB state*; a row without a recorded
  verdict is not evidence. The row is consulted for its **timing only**; `result_class`, notes and
  provenance are never read;
* callbacks (`webhook_events.received_at`, written after authentication) and operator verdicts stay
  ordered against the arm instant (round-4 E3/E4, unchanged);
* the settlement horizon is still judged on the provider's answer instant (it is about when the
  *provider* may still settle), the observation on the delivery position; ambiguous / non-final
  answers stay non-evidence (UNKNOWN is never failed).

Stated residual, not hidden: `delivered_seq` is the instant the provider wrote the answer; the app
read it at or after that instant and sent D at or before D's arrival. A dispatch sent inside that
write→arrival window is distinguishable only through the DB clause, which the real rails always
satisfy (every rail records a verdict before minting the next identity). The lab claims no finer
precision than that.

Files: `tests/lab/provider_simulator.ts` (`delivered_seq`/`delivered_at` on every request record;
`deliver()` at the five places an answer is written), `tests/lab/dispatch_legality.ts`
(`observedBefore`, `recordedBeforeArm`, applied to E1/E2 and to positive evidence; judgements now
name `delivered_seq` and `recorded_at`), `tests/lab/oracle.ts` (passes `resolved_at`),
`tests/review_oracle_temporal_negative_validation.ts` (round-4 controls carry delivery positions
and recorded instants consistent with their own stories).

### 1.4 Controls (all pass on the round-5 oracle — `.tmp_r5/r5-oracle-observation-vs-fixed.log`, `.tmp_r5/r5-oracle-temporal-controls-vs-fixed.log`)

Reject (task §4 A–F + layer isolation): P1 real-simulator held status · A retry before status
delivery · A2 same with a ledger that claims an early record · B retry before callback delivery ·
C decline never delivered · C2 same with a lying ledger · D retry legalised only by later
reconciliation · E retry legalised only by a later late-money effect · F recovery on an
undelivered status · L1 delivered 503 with a ledger that claims a verdict · R delivered before the
dispatch but recorded after the arm · U non-final answer delivered before the retry.
Accept (task §4 G–J): A′ retry after the delivered answer · G retry after an observed, recorded
final status · H retry after a returned exact decline · I retry after a received failure callback ·
J same-identity replay with no second dispatch. Round-4's 18 temporal controls: 18/18.
**17/17 + 18/18.**

### 1.5 Mutations (`scripts/review_mutation_proof.cjs`, `.tmp_r5/r5-oracle-mutations.log`)

| mutant | re-introduces | killed by |
|---|---|---|
| OM-4 | M1 provider-generated == Siton-observed (arrival position used) | A2 / P1 |
| OM-5 | M2 an undelivered answer is usable | C2 |
| OM-6 | M3 final DB history used retroactively (verdict recorded after the arm counts) | R |
| OM-7 | M4 UNKNOWN treated as failed (non-final read counts as non-execution; the non-final re-open guard removed) | U |
| OM-3 | (round 4) 5xx / pending read as declared failure | L1 (the DB clause would have masked it in the round-4 controls, so a layer-isolating control was added) |
| OM-1b, OM-2 | (round 4) | unchanged, killed |
| OM-1a | (round 4, provider-order break in the E2 scan) | **RETIRED** — subsumed by `observedBefore` (an answer is always delivered after it arrives), so the mutation no longer changes any verdict; OM-4 carries that invariant now |

**7/7 killed**; sources restored byte-exactly after every mutant (verified).

### 1.6 The real rails under the new oracle

`LAB_FUZZ_SEED=209752203` **300/300** on the round-4 production code under the observed-evidence
oracle (`.tmp_r5/r5-seed-209752203-prefix.log`): the real rails never dispatch on undelivered
knowledge — every repeat is legal with evidence delivered and recorded before the arm. Post-fix runs
of both exact seeds are in §4.

---

## 2. Blocker 2 — the real-handler race: an orphan identity strands the hold

### 2.1 Reproduction with the real handlers (`tests/review_arm_race_orphan_hold_validation.ts`, `.tmp_r5/r5-arm-race-prefix.log`)

Codex's exact chronology, forced with a row lock so it is order-independent: finalize's DealFailed
CAS queues behind the row lock; the charge handler, which had read p2 as `ChargingAttempt/ChargeAttempt`,
queues its mint behind the finalizer's advisory lock; the lock is released.

Captured at t4 (round-4 code): deal `Completed`; p2 `buyer_state=DealFailed`, `money_state=ChargeAttempt`;
attempt row `charge_start capture:<charge-job>:n1:<p2>` — `result_class=unknown`, `dispatch_state=recorded`,
owner NULL, `dispatched_at NULL`, not in flight; provider effects 0; provider requests **none**;
jobs `finalize_deal sent`, `payment_release pending` (F-16), `charge_deal failed→pending` (its own
deal transition refused: Completed is not Charging); audits `join_authorize`, `fail_participant_after_completed`.

After the normal worker machinery (release rail, reconcile, sweepers, deferred retries, 4 rounds):
p2 still `ChargeAttempt`, release effects **0**; the `payment_release` job consumed as *blocked*
(`payment-operation-blocked:<p2>:release` case, job `sent`); the reconcile it scheduled read the
provider's status for an identity the provider had never seen and turned the row into
`permanent_fail / status_inference / dispatch_state=responded` with `dispatched_at NULL` and no
settlement horizon — a row that claims a response for a request never sent, which the 068 fence
would hold to infinity; nothing re-queues the release. **A, B, C, D of task §5 all hold.**

### 2.2 Exact runtime cause

1. `handleChargeDealEvent` reads the participants in one transaction, then `beginProviderAttempt`
   mints the identity under the participant/deal lock **without re-reading the participant's
   state** (only the later arm checks it). A finalizer that failed the participant between the read
   and the mint therefore gets an identity minted for a `DealFailed` participant; the arm refuses
   (`participant_state_changed`) and leaves the row `unknown/recorded`.
2. `beginProviderAttempt(release)` (and the 067 INSERT guard) treated **any** capture-side
   `result_class='unknown'` row as "unresolved capture", regardless of `dispatch_state` — although
   067's own vocabulary defines `recorded` as "no request has left the process". The release was
   blocked, the job acknowledged.
3. `handlePaymentReconcileEvent` reconciled the never-dispatched identity through a provider status
   read and recorded `permanent_fail/status_inference` on it; with no dispatch instant the 068 fence
   is infinite (`release_fenced_negative_finality_unproven`).

Classification against round 4 (task §10): the orphan mint is **pre-existing** (R9C/063 mint
semantics; the same class was patched locally for recovery as F-8), and the release rail's
conflation of created-not-sent with unresolved is pre-existing too. F-16 (release admitted for
`ChargeAttempt`) **exposed** it — before F-16 no release was scheduled for such a hold at all, so
the hold was stranded differently (never released, no job); F-16 made the release reachable and the
stale-identity block visible. F-14 and F-15 neither caused nor masked it: the F-15 guard runs
before the orphan exists in this ordering. No round-4 production change is reverted.

### 2.3 Attempt lifecycle truth (task §8) — fix within 067/068, **no migration**

CREATED/ARMED vs ACTUALLY DISPATCHED was already durable in 067 (`recorded` → `dispatching` +
`dispatched_at` is written before any I/O; the only way back to `recorded` is the owner's
pre-dispatch disarm). What was missing is that the predicates honour it. A new lifecycle state is
defined from existing columns:

```
ABANDONED_BEFORE_DISPATCH  result_class temporary_fail + dispatch_state recorded + dispatched_at NULL
                           + outcome_note 'never_dispatched:<reason>'
```

The row stays (the ledger keeps every identity ever minted), keeps `recorded` and a NULL dispatch
instant (it never claims a provider response — `permanent_fail` would be forced to `responded` by
the 067 trigger and fenced to infinity by 068 without exact evidence, which is why it is not used),
and leaves `unknown`, so that the 067/068 INSERT guards admit the superseding identity and any
stale worker still holding the identity can never arm it (the arm CAS requires `result_class='unknown'` —
DB-enforced, proven in matrix case C).

Production changes (`src/payment_attempt_helpers.ts`, `src/app.ts`):

| change | where | effect |
|---|---|---|
| **admitted-state mint** | `beginProviderAttempt({ admitted })`; every rail passes the states its arm requires (charge `ChargeAttempt/ChargingAttempt`, recovery `ChargeFailedRecovery/ChargeFailedCompletion`, refund `ChargedSuccess/RecoveredCharge`, release `AuthHeld/AuthLocked/ChargeFailedRecovery/ChargeAttempt`) | the state is re-read under the participant/deal lock (the lock the F-15 guard takes); a stale snapshot mints **nothing** (`state_changed`), and a same-type identity minted earlier for that state and never sent is retired |
| **never-dispatched never blocks** | `beginProviderAttempt`: created-not-sent identities of a *conflicting* operation are retired atomically before the new identity is minted (capture-side rows for release/refund/recovery; a release row for a capture) | a release is never held behind a capture that never left the process; the superseding identity passes the 067/068 guards in the same transaction |
| **reconcile never reads status for an identity the provider never saw** | `handlePaymentReconcileEvent` | a live rail job owns it (reuse or retire under the lock); the rail's phase still open but its job gone → operator case naming the job to requeue, identity kept as the truthful marker; phase over or participant moved on → retire in place and queue the release when a hold is left on a decided participant |
| **terminal decision honours retirement** | `applyCompletedDealOutcome` F-15 guard predicate | round-4 contract kept (a *minted* identity still defers — its live rail may dispatch it, RC-5b); a retired identity no longer defers the decision |

Invariant (task §7) now holds by construction: a hold ends in a dispatched capture, a dispatched
release, or a visible obligation (live job / reconcile / operator case naming the job) — never
behind a row that says nothing was sent.

### 2.4 Regression + crash/race matrix (real handlers; `.tmp_r5/r5-arm-race-postfix.log`, `.tmp_r5/r5-lifecycle-matrix-postfix.log`)

`review_arm_race_orphan_hold_validation.ts` — post-fix: no capture-side identity minted, `release:200`,
p2 `DealFailed/AuthReleased`, 0 cases, oracle clean. **1/1** (round-4 code: 0/1).

`review_attempt_lifecycle_crash_race_matrix_validation.ts` — **10/10** post-fix (round-4 code: 5/9
of the original nine, A2/B/C/F failing — exactly the never-dispatched class):

| case | result |
|---|---|
| A minted, crash before the provider call, job retried | the SAME identity dispatched once (reuse_not_dispatched) |
| A2 minted, crash, no live job, charging phase over | retired `never_dispatched:reconcile:phase_over…`; p2 failed; release 1; `AuthReleased` |
| B minted, finalize decides first; a late charge job re-runs | hold released; the late job mints nothing and sends nothing; no false escalation |
| B2 real handler frozen between mint and arm (block barrier at `payment.before_provider_io`) while finalize decides | finalize defers on the minted identity (round-4 contract); the capture lands; p2 `DealCompleted`; exactly one effect |
| C release begins while a capture identity is created-not-sent | capture retired `superseded_by_release`; release 1; a stale worker's arm of the retired identity is refused by the DB CAS |
| D capture dispatch races the release path, 6 races both orders | exactly one provider effect per hold, never both; oracle clean |
| E provider call made, response lost | UNKNOWN; no release while unknown; truth reconciled → `ChargedSuccess` |
| F never-dispatched identity found by the maintenance sweeper (real 10 s quiet window) | **no status read**, no fence, retired, release 1 |
| G worker dies after ARM, before the provider call | reclaim; exactly one capture-side effect; no UNKNOWN residue |
| H the same job claimed three times concurrently | one dispatch, one request (two-process case: `payment_lab_concurrency_matrix_validation`) |

A fixture fact worth recording: `payment_attempts.updated_at` cannot be back-dated from a test —
the 067 lifecycle trigger stamps `clock_timestamp()` on every UPDATE — so the sweeper's quiet window
is honoured in real time where the sweeper is the subject (F). Codex's independent test aged rows
the same way; its convergence phase therefore never exercised the sweeper either.

### 2.5 Production mutants (`.tmp_r5/r5-mutations-all.log`)

| mutant | re-introduces | killed by |
|---|---|---|
| RM-10 | mint without the admitted-state re-read | arm-race regression (an identity is minted for a decided participant) |
| RM-11 | never-dispatched conflicting identities block the rail (no retirement) | matrix C (release blocked, hold kept) |
| RM-12 | reconcile status-reads a never-dispatched identity | matrix F / A2 |
| RM-13 | the terminal decision defers on a retired identity | matrix A2 (finalize never completes) |

Full proof (`node scripts/review_mutation_proof.cjs`, every RM-* and OM-* mutant, `.tmp_r5/r5-mutations-all-final.log`):
**19/19 killed** (RM-1/2/3/4/6/7/8/9 from earlier rounds, RM-10/11/12/13, OM-1b/2/3/4/5/6/7).
Recorded, not hidden: the first full run (`.tmp_r5/r5-mutations-all.log`) reported RM-10 as INVALID — its
first edit (`if (false && args.admitted)`) did not type-check, and the harness counts a compile error as
nothing, never as a kill; the mutant was rewritten to degrade the admitted-state predicate (any existing
participant counts as admitted), which compiles and is killed by the arm-race regression. Sources were
restored byte-exactly after every mutant (verified: no mutant text in `src/` or `tests/lab/`).

---

## 3. F-12, F-14/15/16, P0 and identity rails — unchanged and re-run

All re-run on the fixed code through the A/B driver (fresh migrated database per file):

| suite | covers | result | log |
|---|---|---|---|
| `review_finalize_participant_race_terminal_state_validation` | F-14, F-15 (RC-5a/5b), F-16, RC-1..7 | **8/8** | `r5-finalize-f14-f15-f16.log` |
| `review_payment_dual_capture_durable_escalation_validation` | F-12 case-write failure (DE-1..4), same-event retry (DE-2, DE-10), exactly-one escalation (DE-3/6/7/11), identity-read failure (DE-9..12) | **12/12** | `r5-f12-durable-escalation.log` |
| `review_payment_dual_capture_escalation_validation` | F-12 dual detect (DS-1..4) | **4/4** | `r5-f12-escalation.log` |
| `review_payment_foreign_reference_ab_validation` | P0 foreign reference | **PASS, 0 failures** | `r5-p0-foreign-reference.log` |
| `review_payment_reference_identity_rails_validation` | identity rails RI-1..9b | **10/10** | `r5-identity-rails.log` |

## 4. Gate

Sequential, one runner at a time (`.tmp_r5/gates.sh`, driver log `.tmp_r5/gates-driver.log`), every step exit 0; no corrective reruns were needed:

| step | result |
|---|---|
| status-response-observation regression + temporal controls | 17/17, 18/18 |
| oracle mutation proof | 7/7 OM (in the 19/19 full proof) |
| exact seed `LAB_FUZZ_SEED=209752203` | **300/300**, 474 participants, 542 provider effects (`r5-seed-209752203-postfix.log`); also 300/300 on the round-4 production code under the new oracle (`r5-seed-209752203-prefix.log`) |
| exact seed `LAB_FUZZ_SEED=203965851` | **300/300**, 472 participants, 540 provider effects (`r5-seed-203965851-postfix.log`) |
| fresh seed `273739535` | **300/300**, 462 participants, 534 provider effects (`r5-fuzz-fresh.log`) |
| real-handler authorization-race regression | 1/1 (round-4 code 0/1) |
| crash/race matrix | 10/10 (round-4 code 5/9) |
| F-14/F-15/F-16, F-12, P0, identity rails | §3 |
| `test:payments` | **61/61** (491 s) |
| `test:concurrency` (incl. the two-worker matrix) | **8/8** |
| `test:workers` (incl. two-process fencing) | **13/13** |
| `test:security` | **39/39** |
| DB fencing proof (`scripts/review_db_fencing_proof.cjs`) | **21/21** |
| migration proofs (`review_r9c_migration_independent_proof.cjs`, `r9c_master_migration_proof.cjs`) | **49/49**; current-master upgrade 59→61 applying only 067/068, master ledger unchanged, SQL bytes equal |
| typecheck, `lint`, `scan:payment`, `scan:runtime-ddl`, `gate:architecture` | PASS |

Master re-verified unmoved at `82c91d62fd092350748405c8aec15a23d0e2af5e` (`git ls-remote`) before the freeze.

## 5. F-13 and the real-money blocker

F-13 (refund identity rotation trusts a final status read with no settlement horizon) is untouched:
nothing in this round is generically unsafe about it — the observed-evidence rule makes the oracle
*stricter* about such reads (delivered and recorded before the dispatch), and the simulator is
honest, so the lab still cannot manifest a lying/lagging provider. It remains provider-contract
dependent: **REAL_MONEY_BLOCKER = YES** until the provider guarantee is researched separately.
No Grow semantics invented; Grow never called.

## 6. Findings ledger (this round)

| id | class | status |
|---|---|---|
| oracle observation leakage (Codex round 4, blocker 1) | test-oracle unsoundness | **FIXED** — observed-evidence rule; 17 + 18 controls; 7/7 oracle mutants |
| orphan authorization behind a never-dispatched identity (Codex round 4, blocker 2) | production, hold stranded (no money moved; no double money) | **FIXED** — admitted-state mint, never-dispatched retirement, reconcile policy, guard predicate; A/B proven; 4 production mutants |
| F-8 (never-dispatched recovery identity, round-3 lab) | subsumed | closed generally by the admitted-state mint |
| F-14 / F-15 / F-16 | round 4 | unchanged; re-run green |
| F-12 | round 3 | unchanged; re-run green |
| F-13 | contract-dependent | **OPEN** (owner / provider research) |
