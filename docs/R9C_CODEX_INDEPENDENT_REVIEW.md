# R9C Codex Independent Payment Review

Date: 2026-09-03

Reviewed Claude SHA: `33a2cb2ad7170ca4371444327493b69e751b202f`

Review worktree: `C:\Users\Lenovo\Documents\C-ton-codex-r9c-review`

Review branch: `codex/r9c-independent-review`

## Scope and safety boundary

This was an authorized defensive review of the R9C payment changes. It used only disposable isolated test databases and local synthetic HTTP providers. It made no real provider call, moved no real money, sent no real notification, performed no deploy, and did not modify or merge `master` or any Claude branch.

## Executive verdict

`UNSAFE_TO_MERGE` and `NOT_READY_FOR_R10`.

F1 is `PARTIAL`: durable operation identities, lease fencing, UNKNOWN persistence, status reconciliation, and stale/duplicate event guards cover important failure modes, but they do not prevent all duplicate money movement. Two deterministic counterexamples remain:

1. a charge request already in flight can race reconciliation, which records failure and schedules recovery; the original capture and recovery then both move money;
2. a provider can move money and then return HTTP 503 or 429; the adapter classifies the response as `temporary_fail`, so retry mints a new capture identity and moves money again.

F2 is `PASS`: charge, recovery, and refund state transitions and their platform-fee ledger entries share one database transaction and survive deterministic rollback/retry tests without split-brain state or duplicate ledger entries.

New findings: 2 CRITICAL, 1 HIGH, 0 MEDIUM, 0 LOW.

## CRITICAL C1: capture/reconciliation race can charge twice

### Deterministic proof

`tests/payment_r9c_reconciliation_race_validation.ts` creates one unresolved `charge_start` attempt and then coordinates two workers with explicit barriers:

1. The charge worker resolves the prior provider status as `authorized`, `final=true`, reuses the durable capture identity, passes its outbox lease fence, and enters the capture request. The synthetic provider pauses immediately before applying the side effect.
2. A reconciliation worker reads the same participant in `ChargingAttempt` / `ChargeAttempt`, receives `authorized`, `final=true`, applies `charge_failed`, and schedules `recovery_deal`.
3. The original capture resumes and succeeds. Its late success cannot transition the participant because reconciliation already moved it to `ChargeFailedCompletion` / `ChargeFailedRecovery`.
4. Recovery runs with a distinct identity and succeeds.

Provider evidence is exactly two money effects: one `capture` and one `recover`. The keys are distinct (`capture:...` versus `recovery:...`), so provider idempotency cannot collapse them. The final local state is `Recovered` / `RecoveredCharge`, while the local ledger has only the recovery charge row; the first provider capture is economically real but absent from the canonical money state and ledger.

### Source cause

- `handleChargeDealEvent` starts at `src/app.ts:2205`, resolves/reuses a prior attempt at `src/app.ts:2280-2297`, performs the final lease fence, and then calls the provider capture.
- `handlePaymentReconcileEvent` starts at `src/app.ts:1662`. It reads the waiting state before provider I/O and at `src/app.ts:1779` treats `authorized && final` as proof that capture failed, transitions the participant, and schedules recovery.
- There is no shared operation lock or fencing protocol between the already-dispatched capture and reconciliation's negative observation. The status result can therefore be true when read but stale before the reconciliation transition commits.

### Concurrency boundaries

| Case | Result | Evidence |
|---|---|---|
| Capture and reconcile concurrently | `UNSAFE` | Deterministic barriers produce capture plus recovery. |
| Two workers claim the same reconciliation event | `SAFE` in tested boundary | The second claim returns no work while the first owns the lease. |
| Two pending/processing reconcile rows for the same participant | `SAFE` in tested boundary | The partial unique outbox index rejects the duplicate active row. |
| Reconciliation before capture response | `UNSAFE` | This is the proven C1 ordering. |
| Crash after provider capture but before local persistence | `SAFE` in the tested narrow path | The unresolved attempt is retained and status=`captured` resolves it without a fresh capture. |
| Stale reconciliation after terminal success/recovery | `SAFE` in tested boundary | It is marked sent as a provider-free no-op. |
| Recovery scheduled while original capture is unresolved/in flight | `UNSAFE` | Recovery uses a distinct identity and produces the second money effect. |

### Required invariant before merge

Reconciliation must not convert a negative status observation into `charge_failed` or schedule recovery while the corresponding money operation may be dispatched or in flight. Introduce a durable operation lifecycle and a shared serialization/fence covering dispatch, status resolution, and recovery eligibility. A recovery must remain forbidden until the exact original provider operation is authoritatively resolved. The status proof must identify that exact operation, not merely a broader authorization or transaction.

## CRITICAL C2: post-effect 503/429 permits a second capture

### Deterministic proof

`tests/payment_r9c_ambiguous_outcomes_validation.ts` uses a local provider that records the money effect before producing each response:

| Provider outcome after effect | Stored first result | Next action | Capture calls / effects | Result |
|---|---|---|---:|---|
| HTTP 503 | `temporary_fail` | outbox retry mints `n2` | 2 / 2 | `UNSAFE` |
| HTTP 429 | `temporary_fail` | outbox retry mints `n2` | 2 / 2 | `UNSAFE` |
| connection drop | `unknown` | status reconciliation | 1 / 1 | `SAFE` in tested path |
| client timeout | `unknown` | status reconciliation | 1 / 1 | `SAFE` in tested path |

For both 503 and 429, the two provider calls carry distinct idempotency identities and the attempts table ends with `temporary_fail` followed by `success`. For connection drop and timeout, the original identity remains unresolved, reconciliation observes `captured`, and no second capture call occurs.

### Source cause

The provider-ready capture adapter maps HTTP 5xx and 429 to `temporary_fail` at `src/payment_provider.ts:694-695`, but maps transport exceptions to `unknown` at `src/payment_provider.ts:713-719`. `handleChargeDealEvent` finalizes `temporary_fail` at `src/app.ts:2321-2330` and throws for outbox retry. Because only unresolved `unknown`/success-without-canonical-outcome attempts are reconciled, the retry can mint a new logical attempt and new identity. An HTTP error received after dispatch is not evidence that the provider did not execute the money operation.

### Required invariant before merge

For money-execution endpoints, every response that can occur after provider dispatch without an explicit provider guarantee of non-execution must be treated as `UNKNOWN`. This includes at least gateway/server errors, 429, 408/timeout-like responses, connection loss, and malformed/truncated responses. Preserve the same operation identity and reconcile it authoritatively before permitting any new identity or retry.

## HIGH H1: Grow settle/refund idempotency is unproven

The actual Grow adapter was audited directly and exercised with an exact request-shape test in `tests/grow_payment_adapter_validation.ts`.

- The only request header added by the adapter is `content-type: application/x-www-form-urlencoded` (`src/grow_payment_adapter.ts:342`). There is no `Idempotency-Key` or equivalent operation header.
- `settleSuspendedTransaction` sends exactly `userId`, `transactionId`, `transactionToken`, and `sum` (`src/grow_payment_adapter.ts:496-501`). It does not send Siton's durable correlation identity or `cField1`.
- `refundTransaction` sends exactly `userId`, `transactionId`, `transactionToken`, `refundSum`, and `pageCode` (`src/grow_payment_adapter.ts:514-520`). It does not send Siton's durable correlation identity or `cField1`.
- `cField1` is sent only by `createPaymentProcess` (`src/grow_payment_adapter.ts:408`), so it does not identify an individual settle or refund operation.
- `getPaymentProcessInfo` and `getTransactionInfo` query the broader payment process/transaction by process or transaction credentials. The adapter sends or receives no provider operation ID that can identify one specific Siton settle/refund invocation.

Therefore:

- Grow durable idempotency/correlation key transmitted on settle/refund: `NO`.
- Repeat Grow settle is provider-idempotent: `UNPROVEN`.
- Repeat Grow refund is provider-idempotent: `UNPROVEN`.
- Grow status can prove the exact Siton operation outcome: `NO`; it observes broader process/transaction state.

The deterministic adapter proof also sends repeated 503/429 settle calls and confirms two requests with no correlation key. It does not claim that real Grow moved money twice; no real Grow request was made. Before live use, require provider documentation and sandbox evidence for a provider-native operation key or make ambiguous settle/refund outcomes non-repeatable and manually resolvable.

## F2 ledger atomicity: PASS

`applyPaymentWebhookClassification` now invokes `recordProviderFinancialEventInTx` from the same transaction callback as canonical state changes for `charge_captured`, `recovery_captured`, and `refund_issued` (`src/app.ts:968-978`, `1058-1068`, `1127-1137`).

`tests/payment_state_ledger_atomicity_validation.ts` proves all three paths:

- charge: a fault after state SQL but before ledger insertion rolls back both; retry commits both exactly once;
- refund: the same fault rolls back state and adjustment; retry commits the refund state and one inverse ledger adjustment;
- recovery: the provider recovery executes once, the forced database transaction fault rolls back state and ledger, retry resolves provider status without a second recovery call, and a duplicate recovery event creates neither another provider call nor another ledger row.

The unique provider-event and participant/logical-entry constraints remain defense in depth. No tested path produced state without its required ledger row or a duplicate ledger entry.

## Financial constitution: PASS

- Exact Siton platform fee rate: `0.08` (`src/platform_fee_money.ts:7`).
- Delivery/shipping is included: gross is product gross plus `delivery_cost` (`src/platform_fee_money.ts:108-109`).
- VAT is excluded from the platform-fee base (`src/platform_fee_money.ts:36-39`).
- Distributor/affiliate commission remains zero: there is no distributor revenue share in the canonical fee calculation or ledger schema/path.
- Refund adjustments mirror the original charge/recovery fee basis and sign.

The focused fee tests passed 15/15 assertions, including an exhaustive cent sweep from ILS 0.01 through ILS 5,000.00, delivery inclusion, VAT exclusion, recovery, duplicate-event behavior, refund mirroring, and absence of affiliate/distributor commission fields.

## Verification evidence

| Verification | Result |
|---|---|
| Focused R9C payment selection | 9/9 files passed in 75,058 ms |
| Full payments group | 35/35 files passed in 196,756 ms |
| Full workers group | 12/12 files passed in 114,829 ms |
| Full concurrency group | 4/4 files passed in 198,486 ms |
| Unique files across the three full groups | 51/51 passed, 0 failed |
| Backend enforcement, direct state mutation, Payment SDK boundary, secret scan | PASS; 108 files scanned |
| Payment compliance scan | PASS |

The focused selection is a subset of the 35-file payments group and is not double-counted in the 51 unique files. Counterexample tests pass when they deterministically reproduce and assert the unsafe behavior.

## Handoff

- Completed: independent code audit; deterministic race and ambiguous-outcome proofs; reconciliation concurrency analysis; Grow request/status audit; F2 atomicity proof; financial-constitution verification; payment, worker, concurrency, lint, secret, and payment-compliance gates.
- Tested: 51/51 unique full-group files passed; focused R9C selection 9/9 passed; all static scans passed.
- Open: remediate C1 and C2; establish a provider-specific, documented and sandbox-proven Grow idempotency/status contract; rerun the complete R9C gate before merge.
- Review completion: 100%.
- R9C merge readiness: blocked by 2 CRITICAL and 1 HIGH finding.
- Next step: implement the operation-level dispatch/reconciliation fence and conservative UNKNOWN classification on a separate remediation branch, then repeat these exact proofs and obtain provider-backed Grow evidence. Do not start R10 and do not merge R9C as reviewed.
