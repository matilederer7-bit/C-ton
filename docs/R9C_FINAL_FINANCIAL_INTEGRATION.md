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

## 6. Evidence (filled by the final run — see §7)

## 7. Exact-tip regression (filled at the end)

## 8. Open external provider requirements
* Grow sandbox proof of exact-operation status and settle/refund idempotency (until then: fail-closed, no automatic recovery on Grow).
* A real provider's reference discipline (the adapter's `reference_matches_query` is the provider-ready contract's operation-scoped prefix rule).
* The real provider-specific settlement horizon (owner-configured per contract).
* No real-money readiness is claimed.
