# R9C — CONTROLLED INTEGRATION CANDIDATE (payment-safety remediation onto current master)

**Status: INTEGRATION CANDIDATE ONLY. `SAFE_TO_MERGE_TO_MASTER = NO`. `READY_FOR_R10 = NO`.**
Authorized defensive Secure-SDLC work on the owner's own repository. Real money 0 · real Grow calls 0 ·
real capture/refund/release/recovery 0 · real SMS 0 · real business e-mail 0 · real invoice 0 ·
no deployment · canonical staging untouched · migration 063 never applied to staging.

| | |
|---|---|
| Master base SHA | `123bbf9bb286b7cfe67a9c76358095032ce5d58b` (P0.7C) |
| R9C source SHA | `f025d3fe5aecd3b27e6d14600e583c9e18000faf` (`claude/r9c-system-red-team`) |
| Common ancestor | `e270a0c0c36d81f14ffa8e6ff3ac41387737dd12` (P0.6A) |
| Integration branch | `claude/r9c-integration-candidate` |
| Integration worktree | `C:\Users\Lenovo\Documents\C-ton-r9c-integration` (second, read-only-ish runner worktree `…-r9c-integration-b` for before/after A-B proofs) |
| Master left untouched | YES — `master` still points at `123bbf9`, working tree clean, never committed to, reset or pushed |

---

## 1. What was ported

The whole R9C ancestry, not only the three remediation commits. Seven commits were cherry-picked in
their original order onto `123bbf9`:

| # | Source SHA | Subject |
|---|---|---|
| 1 | `196869c` | fix(r9c): ONE durable provider-operation identity per money attempt + reconcile-before-new-operation + pre-I/O lease fence |
| 2 | `82936cc` | test(r9c): terminal-state late-event safety (5) + financial constitution boundary/rounding sweep (7) |
| 3 | `306e18c` | fix(r9c): money state + fee-ledger truth commit atomically |
| 4 | `33a2cb2` | docs(r9c): system red-team report + PROJECT_STATUS section |
| 5 | `5f5af24` | fix(r9c): durable money-operation lifecycle (063) — C1 race + C2 post-dispatch 503/429 |
| 6 | `3c81f50` | test(r9c): Codex C1/C2 counterexamples, full-rail ambiguity matrix, Grow fail-closed proofs |
| 7 | `f025d3f` | docs(r9c): independent review outcome + remediation record |

**Semantic inventory carried over** (A–J of the integration brief): durable provider-operation identity
(`beginProviderAttempt`), lease fencing (`assertLeaseForProviderIo` + arm-time CAS), money-operation
lifecycle (migration 063 `dispatch_state` + owner lease), reconciliation behaviour (participant-wide
in-flight deferral, in-transaction settlement), ambiguity classification (`classifyMoneyOutcome`,
`PaymentExecutionResult.dispatched`, per-provider `ambiguityPolicy`), recovery/refund/release safety
(eligibility rules in app **and** DB), state + platform-fee ledger atomicity (`insideTx`), tests
(9 files), migration (063 only), operational unresolved-case behaviour
(`FINANCIAL_OUTCOME_UNRESOLVED` on the existing `operational_cases` rail).

**Equivalence check.** After the cherry-picks the integration tree was diffed both ways:

* every R9C file except the three shared files is **byte-identical** to `f025d3f`;
* the `src/app.ts` delta `merge-base → R9C` is **line-for-line identical** to `master → candidate`;
* the `src/app.ts` delta `merge-base → master` is **line-for-line identical** to `R9C → candidate`.

So nothing of R9C was lost and nothing of master's P0.6A/P0.7/P0.7C behaviour was rolled back.

---

## 2. Conflict log

Only two conflicts. `src/app.ts` auto-merged in all three code commits (master's P0.7/P0.7C hunks and
R9C's payment hunks are in disjoint regions), and the equivalence check above proves the auto-merge
was semantically correct.

### C-1 `PROJECT_STATUS.md` (commit `33a2cb2`)

| | |
|---|---|
| Master behaviour | Top of file: P0.7 owner-acceptance section, then **P0.6A — OWNER ACCEPTED (OWNER_ACCEPTANCE = PASS)**. |
| R9C behaviour | Inserted its R9C section at the top, directly above the older **P0.6A — ENGINEERING COMPLETE / OWNER_ACCEPTANCE_REQUIRED** header it was written against. |
| Resolution | R9C section kept at the top; master's P0.7 and P0.6A-ACCEPTED sections kept verbatim below it; R9C's stale duplicate P0.6A header dropped. |
| Why | Master is authoritative for product status. P0.6A acceptance is newer owner truth and must not be reverted to "acceptance required"; R9C only contributes its own section. |

### C-2 `scripts/migration_manifest.cjs` (commit `5f5af24`)

| | |
|---|---|
| Master behaviour | Registers `061_seller_customer_inquiries.sql` after `060`. |
| R9C behaviour | Registers `063_payment_operation_lifecycle.sql` after `060` (it never saw 061), with a comment reserving 061/062. |
| Resolution | Both, in order: `060`, `061` (P0.7), comment reserving **062 for the Codex Amazon Product branch**, `063` (R9C). |
| Why | 061 is applied product truth on master; 063 must keep its number (never renumbered down to 062) so the Codex branch's reservation stays intact. |

---

## 3. Migrations

| Migration | State |
|---|---|
| `061_seller_customer_inquiries.sql` | **PRESERVED** — position 57, unchanged content |
| `062` | **RESERVED** — not consumed, not present, explicitly commented in the manifest |
| `063_payment_operation_lifecycle.sql` | **INTEGRATED** — position 58, plus the SR-1 hardening in §5 |

Proof (disposable local database only, `npm run test:migrations-isolated`):
fresh install 58/58, re-run idempotent, checksum ledger consistent, drift 0, production changes 0.
Migration 063 was **not** applied to canonical staging and the candidate was **not** deployed.

---

## 4. Financial invariants the candidate must uphold

1. One durable lifecycle per logical money operation: `NOT_DISPATCHED` (`unknown`+`recorded`),
   `IN_FLIGHT` (`unknown`+`dispatching` under a live owner lease), `UNKNOWN` (`unknown`+`responded`,
   or `dispatching` with a dead lease), `SUCCEEDED` (`success`), `DEFINITELY_FAILED` (`permanent_fail`).
2. A pre-I/O lease fence alone is not sufficient: the arm-time CAS records **who** is dispatching, and
   `siton.payment_operation_in_flight()` is the authority on whether a request may be in flight.
3. Reconciliation may not turn a negative status observation into a financial failure while the
   operation may be in flight — it defers (bounded outbox retry) without even reading status.
4. Recovery is not executable while the original capture is unresolved or already executed
   (app-level `beginProviderAttempt` **and** DB eligibility trigger).
5. After dispatch may have happened, 5xx / 429 / 408 / gateway / connection loss / timeout /
   malformed body are `UNKNOWN` on the **same** identity — never `temporary_fail`, never a new identity.
6. Pre-dispatch definite failures (adapter proves `dispatched:false`) retry the same identity.
7. Grow ambiguous settle/refund fail closed: no automatic repeat, no automatic negative verdict,
   `FINANCIAL_OUTCOME_UNRESOLVED` case instead.
8. Canonical money state and the 8 % platform-fee ledger entry commit in ONE transaction, and the
   attempt settlement joins that transaction.
9. **(new, SR-1)** Only the current dispatching owner may write a non-success outcome onto an
   in-flight identity; provider SUCCESS is always admitted.

---

## 5. Self-red-team of the integrated code (findings)

The integrated candidate was attacked again from scratch, as if written by someone else. Two findings,
both fixed **on this branch**, each with a deterministic proof that fails before the fix.

### SR-1 — CRITICAL: a stale dispatching owner could blind the in-flight guard (C1 re-opened)

*Present on the R9C source branch itself, not introduced by the merge.*

`settleProviderDispatch` wrote its outcome with **no owner fence** for the non-success outcomes, and the
migration-063 UPDATE guard refused only `permanent_fail`/`temporary_fail`, re-arming and disarming — not
a foreign `unknown` + `responded` write.

Interleaving: a worker stalls after dispatch → its lease expires → the job is reclaimed → a successor
proves the identity was not executed, reuses it, re-arms it and is now **in flight** → the stalled
worker wakes and settles `unknown` on that row. The row flips to `responded`, so
`siton.payment_operation_in_flight()` is false for a request that is still at the provider. From there
the C1 chain re-opens: reconcile reads `authorized/final`, declares `charge_failed`, settles the
identity `permanent_fail` — and `permanent_fail` is not a blocking class, so a recovery job may capture
the buyer a second time while the first capture lands.

**Fix (three layers).**

* `src/payment_attempt_helpers.ts` — `settleProviderDispatch` returns
  `"settled" | "foreign_owner" | "missing"`; the non-success UPDATE carries an owner predicate
  (`$5 = 'success' OR owner is null OR owner = this job`), and `classifySettleRefusal` distinguishes
  "already terminal" from "someone else owns this dispatch now".
* `src/app.ts` — all four money rails settle through `settleOwnedMoneyOperation`, which converts
  `foreign_owner` into `OutboxLeaseLostError`: the stale job stops immediately, does not ACK, does not
  schedule a reconcile and writes nothing further.
* `src/migrations/063_payment_operation_lifecycle.sql` — DB backstop: while an operation is in flight,
  a non-owner write that is not provider `SUCCESS` raises `SN409
  payment_attempt_in_flight_foreign_write`. The pre-existing `..._negative_settle`, `..._dispatch_in_flight`
  and `..._disarm` messages keep their order, so the existing R9C proofs still observe them.

**Proof** `tests/payment_r9c_stale_owner_settle_validation.ts` (SR-1 and SR-1b).
Before the fix the stale settle is admitted, the successor's row goes `responded`/not-in-flight, the
reconcile proceeds to a verdict, and the participant is marked charge-failed while the money request is
still live. After the fix: DB probe `refused:SN409:payment_attempt_in_flight_foreign_write`; the stale
worker's job returns `lease_lost`; the row stays `dispatching` under the successor's lease
generation 2 with `in_flight = true`; the reconcile fails with `payment_reconcile_operation_in_flight`
after **0** status reads; the recovery job makes **0** recovery calls; the capture lands as
**1** provider money effect, `ChargedSuccess`, exactly one `charge` ledger entry, one identity.
SR-1b proves the other direction is untouched: a foreign writer declaring provider **SUCCESS** on an
in-flight row is still admitted (provider truth is never refused).

### SR-2 — MEDIUM: a stable identity plus a deterministic mock made a "transient" failure permanent

R9C retries a proven **pre-dispatch** failure with the SAME durable identity (correct: nothing reached
the provider). The mock provider drew its outcome as a pure function of the correlation id, so once an
identity drew the simulated transient failure it drew it again on every retry, forever. The deal-types
end-to-end proof deadlocked on exactly that (`B2 … expected Completed, got Charging`) — a genuine
integration regression of the R9C identity change against master's e2e suite, not a flake.

Production is bounded by `OUTBOX_MAX_ATTEMPTS` and by the rolling three-per-thirty-minutes cap
(migration 050), so this is a fixture-level defect, but it hid behind a "flaky test" appearance and had
to be closed to trust the suite. **Fix:** `mockOutcomeDraw()` keeps the seeded, reproducible draw for the
first call of a key and re-draws on each retry of that key — a simulated *transient* failure is now
transient. Only the mock/simulation path changed; no provider-ready, Stripe or Grow behaviour moved.

### Reviewed and found clean

* **Every provider money call site** in `src/` goes through the four rails:
  `paymentProvider.capture` (app.ts:2625), `.recover` (2880), `.refund` (1538), `.release` (2445) —
  each preceded by `armMoneyOperation` and followed by `classifyMoneyOutcome` + owner-fenced settle.
  The only other provider calls are **read-only status** lookups: the two reconcile paths
  (app.ts:1831, 2238) and two authorization-verification paths in `src/frontend_runtime.ts`
  (5634 Grow callback, 9731 `POST /api/payments/status`), which can only confirm an authorization
  binding — they move no money.
* **No direct `siton.payment_attempts` writes** outside `src/payment_attempt_helpers.ts`
  (only migrations 014 and 063 touch the table in SQL).
* **No alternate money rail**: `src/operational_repair.ts` is plan/validate/hash only (its
  "canonical transition keys" are an allow-list, not an executor); `src/admin_intervention.ts`,
  `src/admin_control_plane.ts` and `src/admin_mission_control.ts` expose read/measurement surfaces and
  no provider call or money-state mutation; the outbox dispatcher (`workerProcessEvent`) routes every
  money event type to exactly one rail handler.
* **No attempt-counter identity rotation** remains: identities come from
  `beginProviderAttempt(identity(logicalAttempt))` under the participant advisory lock.
* **Ledger atomicity** unchanged: `recordProviderFinancialEventInTx` is called inside the
  state transition's `insideTx`, together with the attempt settlement.
* **DLQ / unresolved truth**: a reconcile that exhausts its attempts opens
  `payment-reconcile-unresolved:…` before failing permanently, and the attempt row stays `unknown`,
  which keeps recovery/refund/release blocked (fail-closed). Documented residual, unchanged from R9C.
* **Adapter honesty defaults**: `classifyMoneyOutcome` treats a `temporary_fail` **without** an explicit
  `dispatched:false` as UNKNOWN, so an adapter that forgets the flag fails closed. The Grow adapter's
  HTTP helper never throws after dispatch (transport loss returns `status: 0`), so its pre-dispatch
  `catch` blocks genuinely cannot fire once a settle/refund has left the process.

### INFO (noted, deliberately not changed here)

* `paymentCaptureMock` / `paymentRecoveryMock` / `refundMock` in `src/app.ts` (≈ lines 841–861) are dead
  code with **no callers**, left from before the provider abstraction. They are not a bypass (nothing
  reaches them) and they pre-date R9C on master, so removing them is out of scope for this candidate.
* `openPaymentOperationalCase` swallows its own write errors. A lost case row costs operator
  *visibility* only: the money truth stays in `payment_attempts` (an `unknown` identity keeps every
  further money operation blocked) and the failing job is still DLQ-visible. Pre-existing R9C behaviour.

---

## 6. Residual risks (documented, not fixed here)

* **Grow native idempotency / exact-operation status: UNPROVEN.** Settle and refund transmit no Siton
  operation key; the policy is `same_identity_repeat_safe:false`, `negative_status_authoritative:false`,
  so Grow fails closed into a manual case. Must be proven in the Grow sandbox before R10.
* A request the client gave up on may still be processed by a provider after a status read. Only
  provider semantics close this; encoded per provider in `ambiguityPolicy`.
* A reconcile job may reach the outbox attempt cap while an operation is still in flight and land in the
  DLQ; the owning job's reclaim path still converges the identity, and the operational case is visible.
* **JOIN RATE HARDENING = OPEN.** The aliased `/api/deals/:id/join` and bare `/deals*` lifecycle routes
  do not reach the strict mutation bucket because Fastify's `rewriteUrl` mutates `req.url` before the
  hooks. Untouched here by instruction; no blanket 20/min/IP was applied (shared-IP environments).
* **REAL EXTERNAL EMAIL DELIVERY = OPEN / PROVIDER REQUIRED**, unchanged: internal inquiry COMPLETE,
  notification event COMPLETE, real delivery still needs a provider.

---

## 7. Test matrix

See §"Tests" in `PROJECT_STATUS.md` for the summary line. All runs used **fresh isolated local
databases** created per test file by `scripts/run_test_group.cjs`; no hosted environment was touched.

### Whole repository suite — `npm run test:all`

`files=181 groups_passed=10 groups_failed=0` (exit 0, 1 439 s)

| Group | Result |
|---|---|
| unit | 12/12 |
| integration | 29/29 |
| db | 6/6 |
| api | 41/41 |
| workers | 12/12 |
| payments | **37/37** (36 R9C + the new SR-1 proof) |
| security | 18/18 |
| concurrency | 4/4 |
| failure | 9/9 |
| e2e | 13/13 |

No suite was skipped. Two failures seen on the ported-but-unpatched candidate were both real and are
both closed: `deal_types_e2e_validation.ts` (SR-2) and `mobile_readiness_validation.ts` (needs
`npm run mobile:verify` to build `.mobile_dist` first, exactly as CI does before its test steps).

### Money-safety proofs (all on fresh isolated local databases)

| Proof | Result |
|---|---|
| `payment_r9c_stale_owner_settle_validation.ts` (**new, SR-1**) | PASS — see the A-B table below |
| `payment_r9c_reconciliation_race_validation.ts` (Codex C1) | PASS — capture in flight + reconcile + late success: effects **1**, capture calls **1**, recovery calls **0** |
| `payment_r9c_ambiguous_outcomes_validation.ts` (Codex C2) | PASS — 503 **1**, 429 **1**, connection drop **1**, client timeout **1**, malformed 2xx **1**; one identity each, no `n2` |
| same file, other rails | recovery→503 **1**, refund→503 **1**, refund→429 **1**, release→503 **1** |
| `payment_provider_operation_identity_crash_validation.ts` | PASS — crash/reclaim windows S1–S9 |
| `payment_state_ledger_atomicity_validation.ts` (F2) | PASS — state + fee ledger commit together, no duplicate on replay |
| `payment_terminal_state_late_events_validation.ts` | PASS — terminal states immune to late webhooks/reconcile/release |
| `payment_grow_ambiguity_policy_validation.ts` (H1) | PASS — Grow policy false/false, request shape, no operation key transmitted |
| `grow_payment_sandbox_activation_validation.ts` | PASS — ambiguous settle and ambiguous refund both FAIL CLOSED (no repeat, no verdict, case opened) |
| `payment_release_lifecycle_validation.ts` | PASS (4/4) |
| `platform_fee_boundary_rounding_validation.ts` | PASS — 8 % exact across the sweep |
| `platform_fee_payments_8_percent_validation.ts` | PASS |
| `charge_attempt_rate_limit_validation.ts` | PASS — 050 rolling cap unchanged |
| `full_e2e_gate_validation.ts` | PASS |

### SR-1 A-B measurement (same test, same seed, two worktrees at the same base)

| | un-fixed candidate | fixed candidate |
|---|---|---|
| provider money effects | **2** (capture + recovery) | **1** |
| recovery money calls | 1 | **0** |
| stale-owner DB write | `admitted` | `refused:SN409:payment_attempt_in_flight_foreign_write` |
| stale worker's job | settled its outcome and scheduled a reconcile | `lease_lost` (no ACK, no writes) |
| lifecycle row after the stale settle | `unknown` + **`responded`** (in-flight guard blinded) | `unknown` + **`dispatching`**, owner generation 2, `in_flight = true` |
| reconcile while the successor was in flight | `sent` — 1 status read, verdict written | `failed: payment_reconcile_operation_in_flight` — **0** status reads |
| participant while in flight | ChargeFailedCompletion / ChargeFailedRecovery | ChargingAttempt / ChargeAttempt |
| final participant state | Recovered / RecoveredCharge | ChargedSuccess / ChargedSuccess |
| fee-ledger entries | 1 `charge` for two captures | 1 `charge` for one capture |

### Product regression (master behaviour that must survive)

| Surface | Proof | Result |
|---|---|---|
| P0.6A geolocation | `frontend_foundation_geolocation_strategy_validation.ts` | PASS |
| P0.7 seller inquiries | `p07_seller_inquiries_pickup_validation.ts` | PASS |
| public seller e-mail / phone / WhatsApp | same proof + static read of `buildPublicDealPayload` | **NO** — payload carries only `business_name`, `business_description`, `contact_channel:"siton_inquiry"`; the SQL does not even select the contact columns |
| pickup location + publish readiness | `p07_seller_inquiries_pickup_validation.ts`, `frontend_foundation_countdown_pickup_validation.ts` | PASS |
| four-cell countdown | `frontend_foundation_countdown_pickup_validation.ts` | PASS |
| Draft buyer preview | `p07b_seller_draft_preview_validation.ts` | PASS |
| P0.7C polling + background-tab pause | `frontend_foundation_polling_validation.ts` | PASS |
| two normal deal tabs → no 429 | `rate_limit_read_budget_validation.ts` | PASS (`rateLimitBucketFor` read budget intact) |

### Static gates (on the patched candidate)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| backend enforcement / direct money-state mutation / Payment SDK boundary / secret scan | PASS (112 files) |
| payment + raw-card compliance scan | PASS |
| runtime DDL scan | PASS (62 runtime files) |
| architecture truth gate | PASS |
| PWA / native shell gate (`mobile:verify`) | PASS |
| isolated migration proof (fresh install + re-run + checksum ledger) | PASS — 58/58, drift 0, production changes 0 |

---

## 8. What still has to happen before this can merge

1. A fresh adversarial Claude audit of **this** branch in a separate conversation and worktree.
2. An independent Codex re-review (currently unavailable — capacity), of the remediated SHA
   *including* the SR-1 fix, which Codex has never seen.
3. Grow sandbox proof of settle/refund idempotency and exact-operation status.
4. Owner decision on merge and on the still-open P0.7 acceptance.

`SAFE_TO_MERGE_TO_MASTER = NO` · `READY_FOR_R10 = NO` · do not deploy · do not apply 063 to staging.
