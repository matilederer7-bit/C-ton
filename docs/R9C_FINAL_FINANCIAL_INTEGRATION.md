# R9C — FINAL FINANCIAL INTEGRATION + RESIDUAL CLOSURE

**Status: INTEGRATION CANDIDATE on `claude/r9c-final-financial-integration`. `SAFE_TO_MERGE = NO`. `SAFE_FOR_REAL_MONEY = NO`. R10 BLOCKED.**
Real money 0 · real Grow calls 0 · real provider calls 0 · no deployment · canonical staging untouched · migrations 063/064 never
applied outside disposable databases · master never modified · Codex mobile branch and `android/` / `ios/` / mobile release
scripts untouched (the mobile gate was run read-only as part of the regression).

| | |
|---|---|
| Base master (Codex independently repaired baseline) | `8ead7c828e6d6233bf7d17bf7f67d1a67ad35767` |
| Financial source | `claude/r9c-financial-review-remediation` @ `921b85b891b47996cbf57683a9ed3a532674052e` (merge-base with master `60ebf6d`) |
| Integration branch | `claude/r9c-final-financial-integration`, created from exact master; worktree `C:\Users\Lenovo\Documents\C-ton-financial-final-integration` |
| Master CI at start | `8ead7c8`: web-runtime GREEN; backend-gates RED only at step 30 "Complete repository suite" (steps 1–29 incl. every group step GREEN; annotation "exit code 1"). Financial-independent, sequence-dependent; recorded, NOT folded into this branch. |

---

## 1. Integration strategy (semantic port, not a merge)

The financial branch was not merged or rebased. Its 32 commits over `60ebf6d` were cherry-picked with `-x` in their original order
onto exact master, one by one, with every conflict inspected:

| Commits | Disposition |
|---|---|
| `b2d67ff` (pre-financial Phase 1: cancel serialization + PG client guard), `82f9171` (its status record) | **SKIPPED — superseded by master.** Codex's `693628c` carries the identical `src/app.ts` change (deal.cancel `serializeOnEntity`) line-for-line, and a strict superset of the `src/db.ts` guard: the same persistent per-client error listener plus a safe-code allowlist for the logged error code (`db_client_error_log_safety_validation.ts`). Master's versions of `tests/cancel_outbox_concurrency_validation.ts`, `tests/db_client_error_process_survival_validation.ts` and `tests/support/pg_client_error_child_harness.ts` were kept. |
| 24 R9C / torture-lab / review commits `e829e79 … 40f94d1` | applied cleanly (the two later db-test commits `9aa5417`, `40f94d1` applied on top of Codex's survival suite: the merged file carries **both** sides — Codex's idle-timer disable, terminate assertion, rollback-termination scenario and 4 child scenarios, and the review's held-client vacuity check — 11/11) |
| `5dcee1f`, `b6e20da`, `921b85b` (docs) | conflicted on `PROJECT_STATUS.md` only → master's file kept; financial status recorded in this document and in the integration section of `PROJECT_STATUS.md` |
| `644a133`, `3c9fc9c`, `777b6b8`, `7265568`, `7c5d8af` (review evidence, remediation, suites, R-11) | applied cleanly |

**Equivalence proof (integration tip `534c179`)**: `git diff --name-only 921b85b HEAD` ⊆ master's own delta files (`git diff --name-only
60ebf6d origin/master`); the two files both sides had written identically (`src/app.ts` cancel hunk, the cancel concurrency suite) do
not differ at all; source differs from the financial tip **only** by Codex's `safeCodes` hunk in `src/db.ts`. Nothing of the financial
behaviour was lost, nothing of master's baseline was rolled back. Migrations: 061 P0.7 · 062 RESERVED (Amazon catalog) · 063 lifecycle ·
064 settlement horizon — no renumbering, fresh install 59/59, rerun idempotent, checksum ledger consistent, drift 0.

## 2. Codex baseline preservation (Phase 3)

| Baseline proof (master's files, unchanged) | Result on the integration tree |
|---|---|
| `cancel_outbox_concurrency_validation.ts` — deal.cancel serialization, 500 = 0, duplicate intent = 0 | **22/22** |
| `db_client_error_process_survival_validation.ts` (+ `db_client_error_log_safety_validation.ts`) — process survival, error propagation, safe logging | **11/11** (+ log safety PASS) |
| `request_id_canonical_authority_validation.ts` — exact request correlation | **9/9** |
| `ci_log_security_validation.ts` — credential forms / redacted username≠leak | **181 assertions PASS** |
| `worker_two_process_fencing_validation.ts` — credential predicate self-check + fencing | PASS |

**CODEX_BASELINE_BEHAVIOR_LOST = 0.**

## 3. Reviewed financial behaviour preserved (R-1 … R-11)

All review suites pass unchanged on the integration tree: `payment_review_adversarial` 20/20 (R-1, R-2, R-4/F-6, R-5, R-6, R-7),
`payment_review_grow_negative_status` 2/2 (R-3), `payment_review_mock_provider_truth` 1/1 (R-8), `payment_review_findings_reconstruction`
13/13 (R-9, R-10, R-11), `payment_review_settlement_horizon` 12/12. See `docs/R9C_FINANCIAL_REVIEW.md` for each finding.

## 4. Residual closure (Phase 2)

Migration 064 was extended **in place** (it was never applied outside disposable databases; numbering unchanged):

### 4.1 Residual A — a provider that lies beyond the horizon: horizon expiry is not proof
* New durable column `payment_attempts.negative_finality_authoritative`, recorded on every capture-side identity **at dispatch** from the
  provider policy (`negative_status_authoritative`); NULL = unproven (legacy rows, Grow). The UPDATE trigger never raises a recorded value.
* `siton.payment_capture_settlement_fence()` now returns `'infinity'` for a status-inferred failure whose row has no horizon or whose
  authority is not `true`: recovery / release identities are refused at the database (`money_operation_fenced_negative_finality_unproven`),
  the recovery and release rails open `payment-recovery-negative-finality-unproven` / `payment-release-negative-finality-unproven` cases
  and stop (no deferral: waiting creates no proof), and finalize holds the deal with `deal-finalize-negative-finality-unproven`.
* The recovery pre-flight requires, for two consistent negative reads, either exact-request evidence (`dispatch_response` or `operator`)
  or an authoritative contract; every read must also name the queried reference (adapter-judged `reference_matches_query`) and the
  obligation's currency — otherwise `payment-recovery-preflight-mismatch`, no verdict.
* `PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE=false` forces the provider-ready rail into the unproven policy (lab proof of the Grow situation);
  Grow itself is fail-closed by construction (unchanged).
* The only way out of a permanent fence is an operator recording `failure_evidence = 'operator'` on the identity after provider-side
  verification. What follows depends on WHERE the deal is (product rule, unchanged from master): inside the completion window the
  recovery rail acts once the recovery job is re-armed (buyer recovery request / operator re-arm — a fenced run completes with its case and
  nothing recovers on evidence alone) → exactly one recovery (`AU-9`); past the window the recovery rail never captures — the maintenance
  rescheduler brings the parked (DLQ) finalize back and the terminal decision releases the hold WITH provider proof (`AU-9b`).
* Contract boundary, documented: on a provider whose contract IS declared authoritative, a consistent negative beyond the provider's own
  declared horizon followed by a late settlement is a breach of that contract; the system never recovers before the horizon, recovers at
  most once after it, and the oracle reports the late effect (`payment_final_residual_a_authoritative` AA-2 / AA-7).

### 4.2 Residual B — legacy rows (`settlement_horizon_at` NULL)
* NULL is never "elapsed": the fence treats a NULL horizon (and a NULL authority) as permanent until an operator records exact evidence.
* Where the original dispatch instant is durable (`dispatched_at`, migration 063), 064 backfills `settlement_horizon_at = dispatched_at +
  24 h` (the conservative provider-ready default; informational — the authority stays NULL, so the row stays fenced). Rows without a
  dispatch instant keep NULL.
* Proven: legacy DEFINITELY_FAILED, UNKNOWN (reconciled by an authoritative provider, still fenced), SUCCESS-unapplied (R-11 path),
  missing provider reference, the contrast row with exact evidence (recovered once), the backfill itself, the DB backstop.

### 4.3 Residual C — capture / recovery while a release is economically unresolved
* `beginProviderAttempt` refuses `charge_start` / `recovery` while a `release` identity of the participant is `unknown`
  (`capture_blocked_by_unresolved_release` → the job defers, bounded, until the release truth exists) or `success`
  (`capture_blocked_by_released_authorization` → the capture is never dispatched; the money truth becomes `AuthReleased`).
* DB authority: `siton.payment_release_conflict()` + the 064 INSERT trigger refuse the identity regardless of application timing.
* New legal money transition `ChargeAttempt → AuthReleased` (app table + `siton.is_valid_money_transition`), applied only when no
  capture-side identity is unknown or executed: a hold released while a charge was pending.
* Proven: capture vs release in flight, recovery vs release in flight, two in-process workers, lease loss with a reclaiming successor,
  release effect then 503 / timeout, release status unknown for ever (held, DLQ + case), release definitely failed (capture proceeds once),
  the DB backstop.

### 4.4 Integration-found defect I-1 — the finalize horizon deferral lost its milliseconds

Found while closing residual A (the settlement-horizon suite went red intermittently:
`H-6` / `H-6b` reported `outbox_lease_lost` on the FIRST finalize run, deal left in
`CompletionWindow`, 0 status reads). Root cause in the reviewed code, not in the tests:
the terminal-decision fence built its retry instant with `new Date(String(row.settlement_horizon_at))`.
`pg` returns `timestamptz` as a `Date`; `String(date)` prints second precision, so the
deferral could be up to 999 ms BEFORE the durable horizon. The outbox refuses a retry instant
that already passed (`available_at > clock_timestamp()` guard) and reports a lease loss; the
event then sat in `processing` until its lease expired and was reclaimed. No money moved and no
fence was bypassed (the horizon is enforced on every run), but the decision was delayed by a
full lease and the failure mode was invisible. Fix: keep the exact instant (`Date` passes
through untouched; strings are parsed). The recovery and release rails were already exact
(`settlementFenceInTx` hands the `Date` through). Proof: the horizon suite is deterministic
again (3 consecutive isolated runs green after the fix, 2 of 3 red before it).

## 5. Settlement policy
`PAYMENT_SETTLEMENT_HORIZON_MS` default 24 h on the provider-ready rail — a conservative configurable default, **not** a proven Grow
value; Grow automatic recovery from status evidence stays disabled (fail-closed, `negative_status_authoritative:false`,
`same_identity_repeat_safe:false`). Lab horizons: 1.5 s (torture lab), 0.7 s (residual suites), 0.4 s (identity-crash suite).

## 6. Evidence

### 6.1 Phase 2 financial suite set (tip `bf05b76`, fresh isolated databases) — 23/23 files
| suite | result |
|---|---|
| `payment_final_residual_a_unproven` (AU-1..9, AU-9b) | 10/10 |
| `payment_final_residual_a_authoritative` (AA-1..7; AA-2/AA-7 = contract boundary) | 7/7 |
| `payment_final_residual_b` (LB-1..7) | 7/7 |
| `payment_final_residual_c` (RC-1..9) | 9/9 |
| `payment_review_settlement_horizon` (H-1..8; deterministic after I-1: 3/3 consecutive isolated runs) | 12/12 |
| `payment_review_adversarial` / `_findings_reconstruction` / `_grow_negative_status` / `_mock_provider_truth` | 20 / 13 / 2 / 1 |
| `payment_lab_c1_c2` / `_crash_matrix` / `_finalize_guard` / `_foundation` / `_lifecycle_reconcile` / `_refund_release_recovery` / `_terminal_economics` | 27 / 13 / 3 / 23 / 37 / 29 / 17 |
| `payment_r9c_ambiguous_outcomes` / `_reconciliation_race` / `_stale_owner_settle`, `payment_grow_ambiguity_policy`, `payment_provider_operation_identity_crash`, `payment_recovery_real_rail`, `payment_release_lifecycle` | all green |

### 6.2 Anti-vacuity mutations (Phase 6, tip `bf05b76` src, runner `58b8381`) — 35 run · 33 caught · 2 survived
Every mutant is applied to the working copy, the suites that must catch it are run on fresh databases, the source is restored and
verified byte-identical (`scripts/financial_lab_mutations.cjs`, report `mutations_bf05b76.json` + `mutations_m22_m25.json`).

| owner-listed invariant | mutant | catching suite | outcome |
|---|---|---|---|
| settlement horizon disabled (app fence AND DB predicate) | M18 | `payment_review_settlement_horizon` | CAUGHT |
| horizon expiry alone treated as proof (residual A) | M32 | `payment_final_residual_a_unproven` | CAUGHT |
| NULL horizon treated as elapsed (residual B negative control) | M33 | `payment_final_residual_b` | CAUGHT |
| release-in-flight fence removed (residual C, app AND DB) | M34 | `payment_final_residual_c` | CAUGHT |
| exact-reference check removed (residual A) | M35 | `payment_final_residual_a_authoritative` | CAUGHT |
| currency check removed | M20 | `payment_review_adversarial` | CAUGHT |
| AuthReleased without release proof (F-6) | M19 | `payment_review_adversarial` | CAUGHT |
| R-11 guard removed (executed capture, canonical state not applied) / completed-deal sweep removed | M30 / M31 | `payment_review_findings_reconstruction` | CAUGHT / CAUGHT |
| UNKNOWN reclassified as retryable / declared failure | M01 | `payment_lab_c1_c2` | CAUGHT |
| fee 8 % → 7 % / 9 % | M11 / M12 | `payment_lab_terminal_economics` | CAUGHT / CAUGHT |
| VAT folded into the fee base | M13 | `payment_lab_terminal_economics` | CAUGHT |
| delivery excluded from the fee base | M14 | `payment_lab_terminal_economics` | CAUGHT |
| distributor commission introduced | M15 | `payment_lab_terminal_economics` | CAUGHT |
| terminal decision ignores the horizon / release rail ignores the horizon | M25 / M26 | `payment_review_settlement_horizon` | CAUGHT / CAUGHT |
| status echo rewrites the binding (O-1) — WITH the residual-A reconcile mismatch guard disabled too | M22 | `payment_review_adversarial` (RA-5) | CAUGHT |
| other reviewed invariants (M02–M04, M06–M09, M16, M17, M21, M23, M24, M27–M29) | — | lab / review suites | CAUGHT |
| arm-time CAS removed (app layer) | M05 | `payment_lab_lifecycle_reconcile` | SURVIVED — redundant defence: the 063 trigger refuses the same re-arm at the database (documented in `FINANCIAL_TORTURE_LAB.md` §4.1, unchanged) |
| lease-ownership check at arm time removed | M10 | `payment_lab_concurrency_matrix` + `_crash_matrix` | SURVIVED — redundant defence: the arm CAS and the 063 trigger still refuse a foreign in-flight owner (documented, unchanged) |

Runner changes in this integration: M18/M25 anchors follow the 064 fence function and the I-1 deferral; M25 uses an always-false
predicate TypeScript does not narrow to `never` (the `&& false` form became a compile error, i.e. "mutation invalid, not evidence");
M22's single edit had become a MASKED mutant after residual A (the reconcile reference-mismatch case fires first) — it now disables both
guards, and RA-5 still goes red. A masked mutant is reported as such, never counted as caught.

### 6.3 Fresh fuzz (Phase 7) and soak (Phase 8) — tip `58b8381` (src/tests identical to `bf05b76`)
| run | parameters | result |
|---|---|---|
| `payment_lab_random_schedule_fuzz` — FRESH seed | `FUZZ_SEED=2114779962`, 3 000 scenarios (time-based seed, printed by the suite; replayable with `LAB_FUZZ_SEED=2114779962 LAB_FUZZ_SCENARIOS=3000`) | **3000/3000**, 4 676 participants, 5 329 provider effects, 1 473 s, 0 duplicate effects (oracle per scenario) |
| `payment_lab_soak` — two in-process workers + reconciler loop + chaos (random lease expiry) + periodic oracle, then the Phase 20 global reconciliation | `LAB_SOAK_SECONDS=600` | **PASS**: 3 979 deals, 9 970 participants, 18 036 provider operations, 25 828 jobs, 243 lease expiries, 33 oracle runs; final oracle: effects cap 8 067 / rec 244 / ref 0 / rel 1 651 == canonical charged 8 067 / recovered 244 / refunded 0 / released 1 651; unknown 0; visible_unresolved 55 = cases 55 (no unresolved obligation without a case); ledger rows 8 311, fees == ledger fees (oracle recomputes 8 % of gross-incl-delivery minus buyer VAT per participant; rate / base / VAT / delivery checked row by row), violations 0; deadlocks 0, unhandled 0, uncaught 0, max pool 5, max heap 246 MB; DLQ 673 (bounded jobs parked with their cases, "hard" failures 0) |

The known F-9 seed (`2061983203`) and a second fresh fuzz seed are replayed inside the exact-tip regression (§7).




## 7. Exact-tip regression — tip `2aff7068eef60c02752d4c31c271e7d4a6d728e3` (label `2aff706`)

ONE clean, sequential run on the exact tip (dirty files 0 at start), fresh isolated databases, Windows / Node 24.

| step | result | seconds |
|---|---|---|
| typecheck (`tsc --noEmit`) | PASS | 4 |
| lint (`backend_enforcement_scan`) | PASS | 2 |
| backend enforcement scan | PASS | 2 |
| payment compliance scan | PASS | 1 |
| runtime DDL scan | PASS | 1 |
| architecture truth gate | PASS | 1 |
| `git diff --check` (whole delta vs master 8ead7c8) | PASS | 0 |
| demo build (`build:demo`) | PASS | 6 |
| mobile verification (`mobile:verify`, read-only gate; tree clean after) | PASS | 2 |
| isolated migration proof (fresh + rerun + checksum ledger + drift) | PASS | 2 |
| `ci:migrations` against the long-lived local `postgres` database | exit 1 | 1 |
| complete repository suite (10 groups) | exit 1 | 1186 |
| route authorization gate | PASS | 22 |
| fault report | PASS | 1 |
| known F-9 seed replay | PASS | 89 |
| fresh fuzz | PASS | 460 |
| soak (two workers + reconciler + global reconciliation) | PASS | 448 |
| two-process worker fencing proof | PASS | 32 |

| test group | files | result |
|---|---|---|
| unit | 12 | 12/12 PASS |
| integration | 29 | 29/29 PASS |
| db | 8 | 8/8 PASS |
| api | 41 | 41/41 PASS |
| workers | 13 | 13/13 PASS |
| payments | 55 | 55/55 PASS |
| security | 37 | 37/37 PASS |
| concurrency | 7 | 7/7 PASS |
| failure | 9 | 9/9 PASS |
| e2e | 13 | 12 passed, 1 FAILED |
| **all** | **224** | **groups 9/10** |

| financial replay / proof | result |
|---|---|
| fuzz seed 2061983203 (known F-9 seed), 200 scenarios | 200/200, 300 participants, 343 provider effects, 76 s |
| fuzz seed 2121261207 (FRESH), 1000 scenarios | 1000/1000, 1504 participants, 1721 provider effects, 446 s |
| soak 300 s | PASS: 2095 deals, 5181 participants, 9541 provider operations; deals=2095 participants=5181 jobs=14718 lease_expiries=141 oracle_runs=29 soak_s=300; participants=5181 effects[cap=4187 rec=183 ref=0 rel=809] canonical[charged=4187 recovered=183 refunded=0 released=809] unknown=0 visible_unresolved=32 cases=32 ledger=4370 live=0 totals[captured=37277950 recovered=1633600 refunded=0 fees=3672610 ledger_fees=3672610] violations=0; attempts: [{"result_class":"permanent_fail","n":995},{"result_class":"success","n":5179}] dlq=134 cases=32 deadlocks=0 unhandled=0 uncaught=0 max_pool=3 max_heap=198MB |
| two-process worker fencing (`worker_two_process_fencing_validation`) | passed=1 failed=0 duration_ms=31347 |

### 7.1 Non-PASS items, stated plainly
* **e2e 12/13 in this run** — `deal_types_e2e_validation.ts` B2 (voucher buyer flow) asserted `expected Completed, got Failed`
  once. Same tip, afterwards: the file alone 20/20, the full e2e group 6/6 (78/78 files), one more full e2e-group pass 13/13, and chain #1
  on identical `src/` (`e0d162d`) 13/13 — 33 clean runs, zero reproductions, so the root cause is NOT established and it is reported
  as an unresolved intermittent, not explained away. What is known: the test drives the in-process mock provider whose seeded draw is
  keyed by run-varying identifiers and declines 10 % of captures permanently (`payment_provider.ts` capture branch: 75 % success,
  15 % pre-dispatch transient, 10 % permanent); B2 finalizes `Failed` only when buyers A, B and C (3 + 2 + 2 units against threshold 2)
  are all declined, ≈ 0.2 % per run under that model — the observed 1-in-34 does not contradict it but is not proven by it. Nothing
  in the financial delta touches the voucher flow; the finalize decision path for exact-evidence declines is unchanged from the
  reviewed branch. A diagnostic that dumps participants / `payment_attempts` / outbox / DLQ / cases whenever a driven deal ends
  other than `Completed` was used for the reruns and is kept OUT of the branch (baseline test file, no repair folded in); it is
  recommended for the baseline so the next occurrence carries evidence. Master's own GitHub CI failure is at the same
  "complete repository suite" step (recorded in Phase 0, financial-independent).
* **`ci:migrations` exit 1** — environment artifact, not the tip: the script migrates whatever `DATABASE_URL` names, here the
  long-lived local `postgres` development database whose `migration_ledger` carries a stale checksum for
  `014_demo_preview_bootstrap.sql`. The same script against a FRESH disposable database on this tip passes
  (`CI_MIGRATION_REPORT_PASS expected_migrations=59 total=59 succeeded=59 tables=73 functions=24 triggers=19 constraints=1053 indexes=249 foreign_keys=73 rerun=pass`),
  as does the isolated migration proof (fresh install, repeat, checksum ledger, drift 0, production changes 0). GitHub CI runs it on a
  fresh service database.

### 7.2 Chain #1 on `e0d162d` (same `src/`, one test file older)
9/10 groups green; integration RED only at `charge_attempt_rate_limit_validation.ts`: its synthetic "provider-declared" failures were seeded
without `failure_evidence`, which migration 064 classifies as legacy/status-inferred rows — the third insert (`recovery`) was refused by
the negative-finality fence. The test now seeds `failure_evidence='dispatch_response'` (its own stated intent, commit `2aff706`); the
rate limit is unchanged (7/7, integration 29/29). Chain #1's other results: e2e 13/13, route authorization / fault report PASS, F-9 seed
200/200, fresh fuzz seed 2118756557 1000/1000, soak 300 s PASS; the two-process fencing proof ran separately (pattern fix) — PASS.

### 7.3 Read-only mobile check
`mobile:verify` rewrites `ios/App/CapApp-SPM/Package.swift` idempotently (normalisation); the tree was clean after every run — no
`android/`, `ios/`, mobile release script or store-readiness file changed on this branch.

### 7.4 Post-docs verification
The final commit on the branch is docs/status only. `git diff --stat 2aff706 <FINAL_SHA> -- src tests scripts` is empty (byte-identical
source, test and script trees), and the lightweight re-verification after the docs commit is recorded in `PROJECT_STATUS.md`.

## 8. Open external provider requirements
* Grow sandbox proof of exact-operation status and settle/refund idempotency (until then: fail-closed, no automatic recovery on Grow).
* A real provider's reference discipline (the adapter's `reference_matches_query` is the provider-ready contract's operation-scoped prefix rule).
* The real provider-specific settlement horizon (owner-configured per contract).
* No real-money readiness is claimed.
