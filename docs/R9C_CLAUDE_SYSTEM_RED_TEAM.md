# R9C — Claude System Red Team (deep backend / payment invariants)

Branch: `claude/r9c-system-red-team` (isolated worktree `C:\Users\Lenovo\Documents\C-ton-claude-r9c`), based on `origin/master` `e270a0c` (after the P0.6A geolocation hotfix). **Not merged.** Real money 0 · real provider calls 0 · real SMS/email/invoices 0 · R10 NOT started · Grow sandbox untouched.

> **Status history (read this first).** The first R9C pass (SHA `33a2cb2`) claimed F1 **FIXED**. The independent Codex review (`codex/r9c-independent-review` @ `550a976`, `docs/R9C_CODEX_INDEPENDENT_REVIEW.md`) re-graded it **PARTIAL / UNSAFE_TO_MERGE** with two new CRITICAL deterministic counterexamples (C1 capture/reconcile race, C2 503/429 after money moved) and one HIGH (H1 Grow settle/refund idempotency unproven). Both counterexamples were reproduced verbatim on `33a2cb2` before any code changed, then remediated — see **"R9C remediation"** below. The original F1/F2 sections are kept as written for the record; where they say FIXED for F1, read "FIXED for the crash/reclaim windows only; the in-flight race and post-dispatch HTTP ambiguity were still open until the remediation".

## Scope

Attack correctness under failure for the highest-risk money properties, in this priority order:

1. external financial side-effect idempotency (double charge / double capture / double refund / double release)
2. crash / restart / lease-reclaim windows around provider I/O
3. same-buyer duplicate participation semantics
4. inventory + threshold concurrency
5. terminal-state safety, refund/release duplication, state + audit/ledger atomicity, financial constitution (8% / delivery included / VAT excluded / distributor 0)

Out of scope (Codex parallel work, untouched): Product Library, product history/revision UX, product search, Product → Deal UX, Service Product UX.

## Methodology

- **Static trace of every money rail** (`handleChargeDealEvent`, `handleRecoveryDealEvent`, `handleRefundEvent`, `handlePaymentReleaseEvent`, `handlePaymentReconcileEvent`), the outbox claim/lease/heartbeat/reclaim helpers, `atomicMultiTransition`, `ingestAndProcessPaymentEvent` → `classifyEvent`, the payment-attempt seam (`recordAttemptBeforeIo`), migration 050 (rolling cap), 053 (bindings), and the provider adapters (mock, provider-ready HTTP, Grow, Stripe).
- **Deterministic fault injection** on the REAL worker handlers (not mocks of them): three new test-only fault points — `payment.before_provider_io`, `payment.after_provider_io`, `payment.after_state_before_ledger` (in `src/fault_injection.ts`, armed only under `NODE_ENV=test`, forbidden in production modes) — plus the existing `worker.after_claim` / `worker.before_ack`.
- **Fake provider over HTTP** (`PAYMENT_PROVIDER_MODE=provider-ready`) that records every call with its idempotency key and answers `status` from what it actually executed, so "did the provider move money twice?" is measured, not inferred.
- **Worker A / Worker B choreography**: block A at the window under test → expire A's lease → `reclaimWorkerJobs()` → run B to completion → release A → assert provider call counts, attempt identities, state, audit, ledger, outbox ACK.
- Every finding classified CRITICAL/HIGH/MEDIUM/LOW/INFO; CRITICAL/HIGH got a failing test first, then the smallest fix, then the regression proof and the surrounding suites.

## Threat model

- A worker process may stall or die at any instruction boundary (GC pause, VM freeze, OOM, deploy restart) — before, during, or after provider I/O, before or after each local commit, before the job ACK.
- Leases expire; another worker (or the same process after restart) reclaims the job; the stale worker may later resume.
- Provider answers: SUCCESS, TEMP_FAIL (5xx/429), PERM_FAIL (402), TIMEOUT / UNKNOWN (transport loss after dispatch), SUCCESS_BUT_CLIENT_TIMEOUT (money moved, client never saw the answer).
- Late / duplicate / out-of-order events (webhooks, worker results, reconcile, release) against terminal states.
- Concurrent buyers, same buyer twice, last units, threshold boundary.

## Fault windows exercised

| # | Window | Scenario |
|---|---|---|
| 1 | before provider call (identity recorded, no I/O yet) | S2, S2b |
| 2 | request sent, response not observed | S3 (client timeout → UNKNOWN) |
| 3 | provider SUCCESS observed, before local success commit | **S1**, S7 (refund), S8 (release), S9 (recovery) |
| 4 | state written, before ledger/audit | L1 (charge), L2 (refund) |
| 5 | audit written, before job ACK | S6 |
| 6 | after ACK | terminal-state late events T1–T5 |
| 7 | reconciliation flow | S3 (rail no-op after inline resolution), T3/T5 (late reconcile no-op) |
| 8 | refund / release flow | S7, S8, L2, T3 |

## Findings

### F1 — CRITICAL — provider-operation identity rotated on lease reclaim → double capture / recover / release — **FIXED (first pass, crash/reclaim windows) → PARTIAL after independent review → FIXED after remediation (see "R9C remediation")**

**Observed (unfixed code, deterministic):** `tests/payment_provider_operation_identity_crash_validation.ts` S1 —

```
FAIL S1 CRITICAL window: provider SUCCESS observed, crash before persistence, lease reclaimed → NO second provider capture; A resumes fenced
AssertionError: CRITICAL: B must NOT send a second capture for a participant whose prior attempt is unresolved
2 !== 1
```

**Root cause.** The charge, recovery and release rails minted the provider idempotency key from the outbox attempt count — `capture:<event>:a<attempt_count>:<participant>` (migration 050's comment even documents the intent: "every real retry is a distinct attempt"). A worker that observed provider SUCCESS and crashed/stalled before `finalizeAttemptResult` + ingest left the `payment_attempts` row at `unknown`; after lease expiry `reclaimStuckProcessing` returned the job to `pending`, the next claim incremented `attempt_count`, the handler minted a NEW key (the participant was still `ChargeAttempt`, so it was not skipped), and the provider was captured again. Nothing consulted the earlier unresolved attempt. Database fencing (`lease_generation` on `markOutboxSent`/heartbeat) only protected local outbox writes, never the provider side effect. The reconcile rail was only scheduled when the *same process* observed UNKNOWN — a crash never scheduled it.

**Fix (no schema change).**
- `payment_attempt_helpers.beginProviderAttempt`: the identity is minted from the attempts table under the same per-(participant, deal) advisory lock the migration-050 trigger takes — logical attempt = prior rows + 1 (`…:n<logical>:…`), independent of outbox attempt_count / lease generation, so crash, retry, reclaim and restart cannot rotate it. An **unresolved** prior attempt (`unknown`, or `success` never persisted into state) is returned instead of a fresh identity.
- `app.resolvePriorProviderAttempt`: before ANY fresh money call the prior identity is resolved through `PaymentProvider.status` — executed ⇒ apply the canonical event (`reconcile:<correlation>:<event>` id, dedupes with the reconcile rail); provider says never executed (final) ⇒ **reuse the same idempotency key**; ambiguous ⇒ the Worker-owned `payment_reconcile` rail (bounded retries, DLQ + case); no status capability / no reference / amount mismatch ⇒ operational case, no money call.
- `outbox_worker_helpers.assertLeaseForProviderIo` + `app.assertOutboxLeaseForProviderIo` as the **last statement before provider I/O** in all four rails: the worker must still own its lease with ≥ provider-timeout + 5 s remaining (renewing if short); a stale worker whose job was reclaimed throws `OutboxLeaseLostError` (→ `lease_lost`, no ACK) before touching the provider.
- Provider-declared failures (`temporary_fail` from a real 5xx/429, `permanent_fail`) still mint a new identity on retry — the rolling 30-minute cap (050) keeps counting real attempts.
- `tests/full_e2e_gate_validation.ts` prediction updated to the attempts-table identity.

**Regression proof:** 10/10 —

| Scenario | Proves |
|---|---|
| S1 | provider SUCCESS + crash before persistence + reclaim → ONE capture, ONE identity, ONE ledger entry, ChargedSuccess once, A ends `lease_lost` |
| S2 | stall before I/O + reclaim → B reuses A's key (provider-side dedupe if A's request ever lands), A fenced before its call |
| S2b | stall at claim → B completes, A resumes with zero provider calls, no ACK |
| S3 | SUCCESS_BUT_CLIENT_TIMEOUT → durable UNKNOWN + reconcile scheduled; the retried job never re-captures; status lookup resolves; sibling 503 gets a NEW identity |
| S4 | TEMP_FAIL → retry is a new attempt (new key) → success |
| S5 | PERM_FAIL → charge_failed, one call, no retry |
| S6 | crash after local success before ACK → reclaim → zero provider calls, deal transition idempotent, finalize scheduled once |
| S7 / S8 / S9 | same crash window on refund / release / recovery → one provider call each, Refunded / AuthReleased / RecoveredCharge exactly once |

### F2 — HIGH — money state and fee-ledger truth were two transactions → ChargedSuccess with no ledger entry, permanently — **FIXED**

**Observed (unfixed code):** `tests/payment_state_ledger_atomicity_validation.ts` L1 —

```
FAIL L1 … AssertionError: STATE/LEDGER SPLIT: money_state=ChargedSuccess ledger=[] — authoritative money truth without its fee-ledger truth
```

`applyPaymentWebhookClassification` committed the participant transition (`atomicMultiTransition`) and then wrote `siton.platform_fee_money_events` in a second transaction. A failure between them left ChargedSuccess with no 8% ledger entry; the retried job skips already-charged participants, so the hole never healed (only a later refund's backfill could) → payout / fee-recognition drift.

**Fix:** `platform_fee_money.recordProviderFinancialEventInTx(c, …)` and the ledger write moved into the transition's `insideTx` hook for `charge_captured`, `recovery_captured`, `refund_issued` — state and ledger commit together or not at all; idempotent replays skip `insideTx` (no duplicate rows). Fee math untouched.

**Regression proof:** L1 (charge) and L2 (refund): the failure window never leaves state without ledger; the worker retry converges to exactly one ledger entry with ONE provider call (via F1's prior-attempt resolution).

### F3 — HIGH — stale worker could reach the provider after losing its lease — **FIXED (part of F1)**

Before R9C nothing between `claim` and the provider `fetch` re-validated ownership; heartbeats only set a flag checked *after* the handler. Proven by S2/S2b (fence as the last statement before I/O).

### F4 — MEDIUM — residual window depends on provider idempotency semantics — **OPEN (environment blocker, documented)**

If a worker stalls for longer than its lease *between* the pre-I/O fence and the HTTP request leaving the process, the reclaimed worker will have reused the **same** idempotency key (identity reuse), so a provider that honours idempotency keys executes once. A provider that ignores them cannot be protected by any client. Grow's settle/refund idempotency behaviour is unverified (R9B blocker: sandbox access). Required before R10: confirm from Grow's contract that settle/refund are idempotent per transaction credentials or per client key.

### F5 — LOW — fee-VAT half-cent ties resolve by binary float — **OPEN (documented, no pricing redesign)**

The 8% base is exact for every gross 0.01–5,000.00 (500,000-cent sweep: zero drift, zero ties — a 2-decimal amount × 8 can never land on a half cent). The 18% VAT *on the fee* can (fee 1.25 → 0.225): `roundMoney` (`Math.round(x*100)/100`) then rounds by float representation — in the sweep 7,728 ties rounded up and 1,872 down. Impact ≤ 1 agora per participant; seller net is derived from the rounded total so gross always reconciles. Recommendation: an explicit spec decision (e.g. half-up in integer cents) — not applied here because it would change existing amounts by an agora in tie cases.

### F6 — LOW — a webhook/ingest row stuck in `processing` cannot be re-processed under the same event id — **OPEN (documented)**

`webhook_ingestion.claimEvent` returns `should_process=false` for an existing row in `processing` (a crash mid-ingest strands it). The R9C prior-attempt resolution routes around this with a distinct `reconcile:` id, so money truth converges, but the stranded row remains. Suggested: claim-age reclaim for `webhook_events`, like the outbox/notification rails.

### F7 — INFO — same-buyer multiple participations are INTENDED; inventory/threshold safe by construction

- `POST /deals/:id/join`: idempotency is per request key (`join:<deal>:<buyer>:<request>`), deliberately not per buyer; the spec-drift regression D4 asserts no `UNIQUE (deal_id, buyer_id)` and no "already joined" copy. Same key + different payload → 409 `idempotency_payload_mismatch`; same key + same payload → replay. Concurrency proof scenario 4 (same buyer, 10 concurrent joins) → multiple participants, `qty_sum ≤ max_units`.
- Canonical hosted inventory (`public.siton_inventory_rpc`): `hold` under `FOR UPDATE` with `reserved_units + qty <= max_units` in the UPDATE predicate; `commit` under `FOR UPDATE` with `committed_units + qty <= reserved_units`; TargetReached only via `deal_state='PendingTarget' AND committed_units >= min_units` plus `UNIQUE (deal_id, action_name, idempotency_key)` on `target-reached:<deal>` → one transition. Local fallback path: deal row `FOR UPDATE` + idempotent `tryTargetReached`. `charge_deal` is enqueued once by the charging-start transition (idempotency key) and the outbox has `ux_outbox_one_pending_per_aggregate_event`. Concurrency group 4/4 (70 and 200 concurrent joins, last-unit race, same buyer, large competing requests, idempotency replay/mismatch).

### F8 — INFO — a duplicate `charge_deal` job for an already-advanced deal fails noisily

If a second `charge_deal` job ran after the deal already moved to CompletionWindow, participants are skipped by state (no provider call) but the deal transition fails with "State mismatch … expected Charging" (job → retries → DLQ) instead of a no-op. Harmless (the unique pending index prevents it in practice); could return early when the deal is no longer `Charging`.

### F9 — INFO — the synthetic mock provider's `status` always reports `captured` for capture lookups

In demo/staging (mock-backed), an unresolved prior attempt resolves to "captured" without a mock capture having "happened" — acceptable for synthetic money, but expect that in staging behaviour after a worker crash.

## R9C remediation (2026-09-03, after the independent Codex review)

Authorized defensive remediation on the same branch. Real Grow calls 0 · real money 0 · real SMS/email/invoices 0. Master (`123bbf9`, P0.7C) untouched; no rebase onto master yet.

### Before-fix reproduction (Codex counterexamples run verbatim on `33a2cb2`)

| Proof | Result on `33a2cb2` | Evidence |
|---|---|---|
| `tests/payment_r9c_reconciliation_race_validation.ts` (Codex, verbatim) | **reproduced** — provider money effects **2** (1 capture under `capture:prior:n1:…` + 1 recover under `recovery:<event>:n1:…`), participant ended `Recovered/RecoveredCharge` while the first capture was economically real | `R9C_RACE_EVIDENCE` |
| `tests/payment_r9c_ambiguous_outcomes_validation.ts` (Codex, verbatim) | **reproduced** — 503: **2** effects, identities `n1` → `n2`, attempts `temporary_fail, success`; 429: **2** effects, same pattern; connection drop: 1; client timeout: 1 | `R9C_AMBIGUOUS_EVIDENCE` |

### Root causes (exact)

- **C1.** `siton.payment_attempts` knew the *identity* of a money operation but not its *dispatch lifecycle*; `result_class='unknown'` conflated NOT-DISPATCHED, IN-FLIGHT and POST-DISPATCH-AMBIGUOUS. `handlePaymentReconcileEvent` therefore treated a provider read of `authorized/final` as proof of non-execution even while the very same identity was being dispatched under a live worker lease; the pre-I/O lease fence only proved ownership *before* dispatch, never "no request in flight". The negative verdict (`charge_failed` → `recovery_deal`) was committed with no compare-and-set against the operation, so the late capture success was refused by the state guard and recovery moved money a second time under a distinct identity.
- **C2.** The provider-ready adapter mapped every non-2xx with status ≥ 500 or 429 to `temporary_fail`; the rails finalized the identity as `temporary_fail` and threw, the outbox retried, and `beginProviderAttempt` (which only treats `unknown`/`success` as unresolved) minted a fresh identity `n2` → second capture. Stripe (`stripeResultClass`) and Grow (`classifyHttp`: 408/409/425/429/5xx → `temporary_fail`) had the same post-dispatch classification defect.
- **H1 (confirmed by inspection, no Grow call made).** `settleSuspendedTransaction` sends exactly `userId, transactionId, transactionToken, sum`; `refundTransaction` sends exactly `userId, transactionId, transactionToken, refundSum, pageCode`; the only header is `content-type`. No `Idempotency-Key`, no Siton correlation (`cField1` exists only on `createPaymentProcess`). `getPaymentProcessInfo`/`getTransactionInfo` report transaction state, not the outcome of one specific Siton invocation. Repeat settle/refund idempotency: **UNPROVEN**.

### Remediation design

**Durable operation lifecycle — migration `063_payment_operation_lifecycle.sql`** (061 = P0.7 on master, 062 reserved for the Codex Amazon branch). `payment_attempts` gains `dispatch_state ('recorded'|'dispatching'|'responded')`, `owner_event_uuid`, `owner_lease_generation`, `dispatched_at`, `resolved_at`, `provider_reference`, `outcome_note`, `updated_at`. Combined with `result_class` this is the required lifecycle: NOT_DISPATCHED = `unknown+recorded`; IN_FLIGHT = `unknown+dispatching` with a live owner lease (`siton.payment_operation_in_flight(owner, generation)` reads `outbox_events`); UNKNOWN = `unknown+responded` or `dispatching` with a dead lease; SUCCEEDED = `success`; DEFINITELY_FAILED = `permanent_fail`. Legacy rows default to `responded` (conservative: status proof before reuse). DB guards (SECURITY DEFINER triggers, SQLSTATE `SN409`): terminal truth never downgrades and success is never overwritten by failure; **nobody but the dispatching owner** (identified by `set_config('siton.payment_dispatch_owner', '<event>:<generation>')`) may declare a negative outcome, re-arm or disarm an in-flight operation; a new identity of the same money type is refused while a prior one is `unknown`/`success`; `recovery` is refused while any `charge_start` is `unknown`/`success`; `refund`/`cancel_refund`/`release` are refused while any capture-side operation is `unknown`; `release` is refused while a capture is `success`.

**Rails (`src/app.ts`, all four money rails).** `beginProviderAttempt` → `fresh` | `reuse_not_dispatched` (identity minted, never left the process: reuse without status) | `unresolved` (status proof first) | `in_flight` (another live worker owns this exact operation: no I/O) | `blocked` (a conflicting operation of the participant is unresolved/executed: no I/O, `payment_reconcile` scheduled for it, `FINANCIAL_OUTCOME_UNRESOLVED` case). `armMoneyOperation` is the LAST step before provider I/O and is ONE transaction: lease fence (renewed if short) + participant still in the rail's expected state + lifecycle CAS to `dispatching` under this job's lease. `classifyMoneyOutcome` is the only place a provider result becomes a lifecycle outcome: `success`, `permanent_fail` (provider-declared), `pre_dispatch_failure` (adapter PROVED nothing left the process: `dispatched === false` → disarm to `recorded`, same identity retried by normal outbox policy, no rolling-cap consumption), otherwise `unknown` (identity kept, reconcile). `settleProviderDispatch` is the owner's write (monotonic).

**Adapters (`src/payment_provider.ts`, `src/grow_payment_adapter.ts`, `src/synthetic_payment_provider.ts`).** `PaymentExecutionResult.dispatched?: boolean` (false = proven pre-dispatch). Provider-ready HTTP: after dispatch only a definite client-side rejection (4xx that is not 408/425/429, or 2xx `ok:false`, in a parseable body) is a declared failure; 5xx, 408/425/429, gateway/non-JSON, truncated 2xx bodies and transport loss are `unknown`. Stripe: 5xx/429/lock/idempotency conflicts after dispatch → `unknown`. Grow: after `settleSuspendedTransaction`/`refundTransaction` left the process every non-2xx and every transport failure is `unknown`; read-only lookup failures before settle are `dispatched:false`. `PaymentProvider.ambiguityPolicy { same_identity_repeat_safe, negative_status_authoritative }` — absent = fail closed; Grow = **false/false**; mock/provider-ready/Stripe/synthetic = true/true with the documented basis. Exposed in `getPaymentProviderSummary` (`ambiguity_policy`, `operation_lifecycle`) and `configurationSummary` (`operation_idempotency_key_transmitted:false`, `repeat_settle_idempotent:"unproven"`, `repeat_refund_idempotent:"unproven"`).

**Reconciliation (`handlePaymentReconcileEvent`).** (1) Participant-wide in-flight guard BEFORE any status read: if any money operation of the participant is dispatching under a live lease → `DeferredEventError` (bounded outbox retry), no status read, no verdict. (2) A positive proof (captured/refunded/released) settles the identity `success` inside the state transaction; if the canonical state refuses it (already advanced to a contradicting money state) the effect is NOT discarded: `recordLateMoneyEffectException` records the attempt as executed and opens a `FINANCIAL_OUTCOME_UNRESOLVED` case. (3) A negative inference (`authorized/final` for capture/release, `captured/final` for refund) is admitted only when the provider's `negative_status_authoritative` policy is true; otherwise → `FINANCIAL_OUTCOME_UNRESOLVED` case + permanent failure of the job (DLQ), no failure verdict, no recovery/refund/release re-arm, no repeat. When admitted, the attempt row is settled `permanent_fail` INSIDE the `charge_failed`/`recovery_failed` transition (CAS; refused with in-flight → deferred). (4) A participant whose state already moved on but still carries an `unknown` identity is still resolved at the row level (success blocks recovery/release; not-executed unblocks and re-arms the canonical recovery once inside the completion window). (5) Refund/release re-arming after a negative proof happens only while the participant is still waiting for that operation.

**`resolvePriorProviderAttempt`.** `recorded` → reuse without I/O. Negative status → `reuse` only if `negative_status_authoritative || same_identity_repeat_safe`; otherwise `blocked` + case (Grow). Provider-declared `failed` → applied.

**Operational hold.** The existing `siton.operational_cases` rail (`PaymentMismatch`, auto-key deduped) carries every hold with subject prefix `FINANCIAL_OUTCOME_UNRESOLVED`: `payment-outcome-unresolved:<participant>:<type>:<correlation>`, `payment-operation-blocked:<participant>:<type>`, `payment-late-money-effect:<participant>:<event>`. Each keeps provider reference, correlation and attempt evidence in the description; canonical state is never guessed.

### After-fix proofs (fresh isolated databases)

| Case | File | Result |
|---|---|---|
| 1 (C1) capture in flight + reconcile + late success | `payment_r9c_reconciliation_race_validation.ts` | provider effects **1**, capture calls 1, recovery calls **0**; reconcile deferred without a status read; DB guard refuses non-owner negative settle (`SN409`) |
| 8 charge + reconcile concurrently (foreign correlation) | same | one truth, effects 1 |
| 9 two reconcile claims race / duplicate pending job | same | one claim; duplicate refused by the partial unique index |
| 10 reconcile after provider success, before local persistence | same | deferred; effects 1; ChargedSuccess once |
| 11 recovery while capture UNKNOWN | same | recovery blocked (0 calls), case + reconcile; after not-executed proof recovery re-armed and executes once → effects 1 |
| 11b recovery while capture recorded SUCCESS | same | blocked permanently, case, DB refuses recovery identity |
| 3/4/5/6/7 capture → 503 / 429 / drop / timeout / malformed 2xx | `payment_r9c_ambiguous_outcomes_validation.ts` | each: job `sent`, identity `unknown+responded`, reconcile → ChargedSuccess, effects **1**, one identity (no `n2`) |
| 2/18 proven pre-dispatch failure | same | 0 provider calls, identity kept `recorded`, outbox retry reuses the SAME identity → effects 1 |
| 12 recovery → 503 after effect | same | effects 1, RecoveredCharge |
| 13/14 refund → 503 / 429 after effect | same | effects 1, Refunded, one refund adjustment |
| 15 release → 503 after effect | same | effects 1, AuthReleased |
| 16 Grow settle ambiguous, hold still suspended | `grow_payment_sandbox_activation_validation.ts` | no charge_failed, no recovery, no second settle, `FINANCIAL_OUTCOME_UNRESOLVED` case |
| Grow settle → 503 after effect | same | UNKNOWN → status captured → ChargedSuccess, settle calls +1 only |
| 17 Grow refund → 503 after effect | same | UNKNOWN → status cannot prove refund → case, no second refund, no Refunded guess, refund job not re-armed |
| Grow adapter classification + H1 request shape + policies | `payment_grow_ambiguity_policy_validation.ts` | 9/9 |
| Original F1 crash/reclaim windows S1–S9 | `payment_provider_operation_identity_crash_validation.ts` | 10/10 (S3/S4 rewritten to the UNKNOWN contract: a post-dispatch 5xx never mints a fresh capture identity) |
| F2 ledger atomicity L1/L2 | `payment_state_ledger_atomicity_validation.ts` | 2/2 — not regressed |
| Exact Codex originals re-run on the fixed code | copies of `550a976` files | both FAIL as expected (ambiguous: job is `sent`, not `failed`; race: the deferred reconcile never performs the status read the proof waits on) |

Suites: payments **36/36**, workers **12/12**, concurrency **4/4**, failure **9/9**, db **6/6**, integration **28/28**, e2e **12/12** (browser smoke excluded), isolated migration proof (57 migrations, fresh install + rerun + checksum ledger) PASS, `npx tsc --noEmit` PASS, backend enforcement / direct money-state mutation / Payment SDK boundary / secret scan PASS, payment compliance scan PASS, runtime DDL scan PASS, architecture gate PASS. Tests whose expectations encoded the old (unsafe) contract were updated: identity-crash S3/S4, release-lifecycle "temporary failure", rate-limit seeds (resolved attempts instead of `unknown` rows, because a new identity may no longer be minted behind an unresolved one).

### Findings after remediation

- **F1 — FIXED**: original crash/reclaim windows (S1–S9) + Codex C1 + Codex C2 all closed by the same durable lifecycle.
- **F2 — PASS**: state + ledger still commit atomically; the attempt settlement now joins that transaction.
- **C1 — FIXED** (provider effects 1, recovery calls 0). **C2 — FIXED** (503/429 → effects 1, no fresh identity). **H1 — MITIGATED, NOT PROVEN**: Grow now fails closed (no automatic repeat settle/refund, no automatic negative verdict); the idempotency/exact-operation-status contract itself remains UNPROVEN until documented and sandbox-proven.
- **Residual (documented, not client-fixable)**: a request the client gave up on (timeout/lease death) may still be processed by a provider after a status read; only provider semantics (idempotency key or synchronous processing) close it — encoded per provider in `ambiguityPolicy`, false for Grow. A reconcile job that reaches the outbox attempt cap while the operation is in flight lands in the DLQ; the owning money job's own reclaim path still converges the identity.
- **R10**: NOT STARTED / BLOCKED. **R9C SAFE_TO_MERGE**: pending independent re-review of the new SHA.

## Tests performed — first pass (R9C worktree, fresh isolated `siton_test_*` databases via `scripts/run_test_group.cjs`)

| Suite | Result |
|---|---|
| `payment_provider_operation_identity_crash_validation.ts` (new) | 10/10 PASS (S1 FAILED on unfixed code) |
| `payment_state_ledger_atomicity_validation.ts` (new) | 2/2 PASS (L1 FAILED on unfixed code) |
| `payment_terminal_state_late_events_validation.ts` (new) | 5/5 PASS |
| `platform_fee_boundary_rounding_validation.ts` (new) | 7/7 PASS (+ INFO tie count) |
| payments group | 30/30 PASS after F1 · **33/33 PASS after F2** (includes the 4 new files) |
| workers group (12) / failure (9) / db (6) / concurrency (4) | 12/12 · 9/9 · 6/6 · 4/4 PASS after F1 |
| `full_e2e_gate_validation.ts` (prediction updated) | 1/1 PASS after F2 |

Re-run after F2: payments 33/33 · workers 12/12 · e2e gate 1/1 (all in fresh isolated databases).

## Financial constitution

- 8% — literal `SITON_PLATFORM_FEE_RATE = 0.08`, no env/per-deal override; exact for every cent 0.01–5,000.00.
- Delivery included — base = qty × price + delivery (55.00 → 4.40).
- Buyer VAT excluded — base = gross − VAT for every split tested; seller net + fee total = gross to the cent.
- Distributor 0 — snapshot has no distributor/affiliate field; spec-drift D5 keeps the tables free of affiliate payout/commission columns.

## Unresolved risks

- F4 (provider idempotency contract, Grow) — cannot be closed from the client side; must be verified in R9B/Grow sandbox before R10.
- F5 tie rule, F6 stranded ingest rows, F8 noisy duplicate job — documented, low impact.
- Hosted-only paths (Supabase inventory RPC, Supavisor pooler) were reasoned from SQL and prior hosted proofs, not re-executed against staging in this session (no money movement is possible there anyway: mock-backed provider).

## Environment blockers

- Grow sandbox credentials (userId/pageCode) — unchanged R9B blocker; no Grow call was made.
- Local runs use the participant-sum inventory fallback; the canonical RPC exists only on Supabase staging (`supabase/staging/001_siton_inventory_v1.sql`).

## Files changed on this branch

First pass:
- `src/fault_injection.ts` (3 test-only fault points)
- `src/payment_attempt_helpers.ts` (`beginProviderAttempt`)
- `src/outbox_worker_helpers.ts` (`assertLeaseForProviderIo`)
- `src/app.ts` (four money rails, `resolvePriorProviderAttempt`, `assertOutboxLeaseForProviderIo`, atomic ledger in `applyPaymentWebhookClassification`)
- `src/platform_fee_money.ts` (`recordProviderFinancialEventInTx`)
- `tests/payment_provider_operation_identity_crash_validation.ts`, `tests/payment_state_ledger_atomicity_validation.ts`, `tests/payment_terminal_state_late_events_validation.ts`, `tests/platform_fee_boundary_rounding_validation.ts` (new), `tests/full_e2e_gate_validation.ts` (prediction)

Remediation (after the Codex review):
- `src/migrations/063_payment_operation_lifecycle.sql` + `scripts/migration_manifest.cjs` (ONE migration; 061/062 not consumed)
- `src/payment_attempt_helpers.ts` (lifecycle: `beginProviderAttempt` kinds, `armProviderDispatch`, `settleProviderDispatch`, `settleAttemptInTx`, in-flight guards)
- `src/payment_provider.ts` (`dispatched`, `ambiguityPolicy`, post-dispatch classification for provider-ready/Stripe/Grow wrapper, summary)
- `src/grow_payment_adapter.ts` (settle/refund post-dispatch = UNKNOWN, pre-dispatch declared, H1 flags in the summary)
- `src/synthetic_payment_provider.ts` (pre-dispatch declaration, policy)
- `src/app.ts` (rails arm/settle, reconcile in-flight guard + policy gating + in-tx settlement, late-money-effect exceptions, blocked-operation holds)
- `tests/payment_r9c_reconciliation_race_validation.ts`, `tests/payment_r9c_ambiguous_outcomes_validation.ts` (adapted from the Codex counterexamples — safety assertions), `tests/payment_grow_ambiguity_policy_validation.ts` (new), `tests/grow_payment_sandbox_activation_validation.ts` (+3 Grow scenarios), `tests/payment_provider_operation_identity_crash_validation.ts` (S3/S4), `tests/payment_release_lifecycle_validation.ts`, `tests/charge_attempt_rate_limit_validation.ts` (seeds)
- `docs/R9C_CLAUDE_SYSTEM_RED_TEAM.md`, `PROJECT_STATUS.md`

No Product UX files. Overlap with Codex scope: NONE. Codex branches untouched.

## Final recommendation

Do NOT merge yet: the remediated SHA goes back to Codex for a second adversarial review (`R9C SAFE_TO_MERGE = pending independent re-review`). Do NOT rebase onto current master (`123bbf9`, P0.7C) before that review passes. Do NOT start R10: Grow settle/refund idempotency and exact-operation status semantics remain UNPROVEN (fail-closed in code, documented above), and explicit owner authorization remains a separate gate.
