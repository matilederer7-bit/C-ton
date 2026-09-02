# R9C — Claude System Red Team (deep backend / payment invariants)

Branch: `claude/r9c-system-red-team` (isolated worktree `C:\Users\Lenovo\Documents\C-ton-claude-r9c`), based on `origin/master` `e270a0c` (after the P0.6A geolocation hotfix). **Not merged.** Real money 0 · real provider calls 0 · real SMS/email/invoices 0 · R10 NOT started · Grow sandbox untouched.

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

### F1 — CRITICAL — provider-operation identity rotated on lease reclaim → double capture / recover / release — **FIXED**

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

## Tests performed (R9C worktree, fresh isolated `siton_test_*` databases via `scripts/run_test_group.cjs`)

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

- `src/fault_injection.ts` (3 test-only fault points)
- `src/payment_attempt_helpers.ts` (`beginProviderAttempt`)
- `src/outbox_worker_helpers.ts` (`assertLeaseForProviderIo`)
- `src/app.ts` (four money rails, `resolvePriorProviderAttempt`, `assertOutboxLeaseForProviderIo`, atomic ledger in `applyPaymentWebhookClassification`)
- `src/platform_fee_money.ts` (`recordProviderFinancialEventInTx`)
- `tests/payment_provider_operation_identity_crash_validation.ts`, `tests/payment_state_ledger_atomicity_validation.ts`, `tests/payment_terminal_state_late_events_validation.ts`, `tests/platform_fee_boundary_rounding_validation.ts` (new), `tests/full_e2e_gate_validation.ts` (prediction)
- `docs/R9C_CLAUDE_SYSTEM_RED_TEAM.md`, `PROJECT_STATUS.md`

No migrations. No Product UX files. Overlap with Codex scope: NONE.

## Final recommendation

Merge candidates after owner review: F1 and F2 fixes are small, local, fully regression-proven and leave every other suite green. Do NOT start R10: Grow sandbox proof (incl. the idempotency contract in F4) and explicit owner authorization remain separate gates.
