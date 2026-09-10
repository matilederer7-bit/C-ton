# R9C master integration candidate — independent financial review

Reviewer: Claude (independent), 2026-09-10. Autonomous, no real money, no provider
contact, no hosted database touched, nothing merged.

This review does not rely on the candidate's own report. Every claim below was
re-derived from the repository: ancestry and blobs from git, migration behaviour
from disposable local PostgreSQL databases, and money behaviour from
reviewer-authored counterexamples run on **both** sides of an A/B.

---

## 1. Identity of what was reviewed

| Field | Value |
|---|---|
| Stated canonical master baseline | `d4c7877f9b704734036d69f57f7d98f794f4d034` |
| **Actual `origin/master` at review time** | **`c1ce4e4164fd4ee64d124fec29fade97b4557df0`** |
| Reviewed branch | `codex/r9c-master-integration-candidate` |
| Reviewed SHA | `356574f5aef3bd65cf1ef96bc7c14f9447b1d0ee` |
| Review branch | `claude/review-r9c-financial` |
| Merge base with `d4c7877` | `d4c7877…` exactly (candidate 3 ahead / 0 behind at review start) |

`SOURCE_SHA_VERIFIED = YES`. `ANCESTRY_VERIFIED = YES`. The candidate really is
built on the stated baseline: `git merge-base origin/master@d4c7877 356574f`
returns `d4c7877` itself, and `d4c7877` is an ancestor of the candidate.

**Master moved during this review.** Two commits were pushed to `origin/master`
after the candidate was published (`2950e18` social icons, `c1ce4e4` receipt /
seller-trust / content). This matters twice: it creates the merge blocker in §3,
and master's newest commit independently fixed a defect the candidate predates
(§7, F-3). The payment code itself is byte-identical between `d4c7877` and
`c1ce4e4` — `src/app.ts`, `payment_provider.ts`, `payment_attempt_helpers.ts`,
`payment_reconciliation.ts`, `platform_fee_money.ts`, `grow_payment_adapter.ts`,
`outbox_worker_helpers.ts` and `synthetic_payment_provider.ts` are all unchanged
— so every finding here applies to both.

### Port fidelity

The candidate is a faithful, byte-exact port of the already-reviewed financial
work. Verified mechanically, not by reading its report:

- All 12 financial runtime files are **byte-identical** to the Codex final
  review source `3809b32c11d82e57d6ed106f88dea7a55b76499a`.
- `src/app.ts`: the `-U0` delta from the common base `8ead7c8` to the source is
  **line-for-line identical** (1916 lines both ways) to the delta from
  `origin/master` to the candidate — nothing added, nothing dropped.
- `src/frontend_runtime.ts`: same test, zero difference; 21 added financial lines.
- `src/migrations/066_payment_operation_lifecycle.sql` and
  `067_payment_settlement_horizon.sql` are byte-identical to the reviewed
  `063`/`064`.
- Every landed master migration `001…065` is untouched. **Migration 065 is
  unchanged**, confirmed by diff and by ledger comparison.

`FILES_CHANGED_BY_R9C` = 63 files, +13832 / −423 (11 runtime/src, 2 migrations,
4 scripts, 44 tests, 2 docs). The only production code the candidate adds
beyond the previously reviewed set is the final review's own one-line
correction in `src/payment_provider.ts` (§5).

---

## 2. The money lifecycle, reconstructed from the code

| Layer | Where it lives | What identifies it |
|---|---|---|
| Business identity | `siton.participants` (`participant_id`, `deal_id`) | the obligation |
| Money truth | `participants.money_state`, a Postgres enum. Written at 8 sites, every one of them in `src/app.ts` and nowhere else in the tree: `ChargedSuccess`, `ChargeFailedRecovery`, `RecoveredCharge`, `Refunded`, `AuthReleased`, `AuthLocked`, `ChargeAttempt` through the generic transition helper, plus one raw pre-money `NoFinancial → AuthHeld` on join | `NoFinancial → AuthHeld → AuthLocked → ChargeAttempt → ChargedSuccess \| ChargeFailedRecovery → RecoveredCharge`; `→ AuthReleased`; `→ Refunded` |
| Payment operation identity | `siton.payment_attempts` (`participant_id`, `deal_id`, `attempt_type`, `correlation_id`) unique | one durable row per logical money operation |
| Attempt/dispatch identity | `dispatch_state` ∈ `recorded \| dispatching \| responded` | whether a request has left the process |
| Lease owner | `owner_event_uuid` + `owner_lease_generation` → `siton.outbox_events` | which worker job may act |
| Provider reference | `payment_attempts.provider_reference`, `payment_authorization_bindings.provider_reference` | the authorization at the provider |
| Finality horizon | `settlement_horizon_at`, `failure_evidence`, `negative_finality_authoritative` | how long an ambiguous negative may still settle |
| Fee ledger | `siton.platform_fee_money_events`, one `charge` and one `refund_adjustment` row per participant (partial unique indexes) | the money's accounting consequence |

**Before dispatch.** `beginProviderAttempt` takes a per-`(participant, deal)`
advisory lock and classifies: `fresh` (mint a new identity), `reuse_not_dispatched`
(an identity exists but nothing was sent), `unresolved` (a prior identity's
outcome is unknown — resolve it before sending anything), `in_flight` (a live
owner is sending), `blocked` (a conflicting operation), `fenced` (a settlement
horizon forbids recovery/release).

**Arming.** `armProviderDispatch` is the last step before I/O and does four
things in one transaction: declares the owner via
`set_config('siton.payment_dispatch_owner', '<event>:<generation>')`, re-checks
that this worker still holds the outbox lease with enough time left, re-checks
the participant's money state, and compare-and-swaps the row to `dispatching`
with itself as owner — refusing if another live owner holds it. No lease, no
money I/O.

**During ambiguity.** `classifyMoneyOutcome` treats a non-success as
"nothing happened" **only** when the adapter proves `dispatched: false`.
Everything else — 5xx, 429, 408, transport loss, timeout, malformed or
truncated body, id-only 2xx — is `UNKNOWN`. The identity is kept; reconcile owns
it. `anyOperationInFlight` makes every reconciler defer while any operation of
that participant is in flight.

**After success / failure.** The four writes that assert money actually MOVED
(`ChargedSuccess`, `RecoveredCharge`, `Refunded`) each write the fee-ledger row
in the very same transaction. `settleProviderDispatch` writes the outcome, but
only the current owner may write a non-success; a stale owner is told
`foreign_owner`, which `settleOwnedMoneyOperation` converts into
`OutboxLeaseLostError` so the stale job stops without acknowledging.
Money truth and the fee-ledger row are written in the **same** transaction as
the state compare-and-swap (`atomicMultiTransition` → `insideTx(c)` → CAS →
`COMMIT`).

**Reconciliation.** `handlePaymentReconcileEvent` reads the provider status for
the exact operation and refuses to conclude anything unless the answer ties to
the obligation: amount, currency and reference must match, no sibling identity
of the same family may be unresolved, and nothing may be in flight. A negative
answer becomes a verdict only when the provider's contract says a negative
status proves non-execution.

**Finality.** `payment_capture_settlement_fence(participant, deal)` returns the
latest open horizon of a capture-side `permanent_fail` row whose failure is not
exact-request or operator evidence — `'infinity'` when it can never be resolved
automatically. While it is not NULL, recovery and release identities are refused
by the database and the corresponding jobs are deferred or turned into operator
cases.

**Late events.** A provider money effect that local state refuses to absorb is
recorded as a late-money-effect exception with a visible operational case
(`payment-late-money-effect:…`) rather than discarded.

**Recovery.** A second capture of the same obligation, with its own
`attempt_type = 'recovery'` identity, guarded three ways: the pre-flight
(`verifyOriginalCaptureBeforeRecovery`), the settlement fence, and the database
INSERT trigger that refuses recovery while a `charge_start` is `unknown` or
`success`.

---

## 3. BLOCKER B-1 — migration id 066 collides with landed master (fixed on the review branch)

`FOUND_IN_R9C` — the candidate was correct against its own baseline; master
advanced underneath it.

`origin/master@c1ce4e4` **landed migration id `066`**
(`066_receipt_trust_content.sql`) at ledger position 59. The candidate claims the
same id `066` at the same position for `066_payment_operation_lifecycle.sql`.
These cannot coexist: `scripts/run_migrations.cjs` hashes exact file bytes and
throws `migration manifest mismatch` / `migration checksum mismatch` when an
already-applied id maps to a different filename, position or checksum. Merging
the candidate as-is would leave a manifest whose id 066 disagrees with any
database that already applied master's 066.

Master's 066 is **money-inert** (`deals.receipt_config`, seller public profile
columns, `participants.public_name_opt_in`, `content_assets`, `site_content`,
chat title) so there is no semantic conflict — only an id conflict.

**Fixed on the review branch**, following the rule migration 065's own header
states ("whichever branch lands second appends AFTER the other so ledger
positions stay contiguous"):

| Was | Now | Position |
|---|---|---|
| `066_payment_operation_lifecycle.sql` | `067_payment_operation_lifecycle.sql` | 60 |
| `067_payment_settlement_horizon.sql` | `068_payment_settlement_horizon.sql` | 61 |

SQL bytes are unchanged; only the filename and manifest id move. Neither file
has ever been applied outside disposable local databases, so this is an id
assignment, **not** a rewrite of migration history. All 59 landed migrations keep
their id, filename, checksum and position. References updated:
`scripts/financial_lab_mutations.cjs` (six mutant anchors),
`tests/payment_final_residual_b_validation.ts`, and both migration proofs.
Codex's `docs/R9C_MASTER_INTEGRATION_REPORT.md` is left verbatim as the record of
what was proved against `d4c7877`.

---

## 4. Migrations 067 / 068 (the reviewed 063 / 064) — strict review

`MIGRATION_066_SAFE_TO_APPLY` (now 067, operation lifecycle) = **YES**
`MIGRATION_067_SAFE_TO_APPLY` (now 068, settlement horizon) = **YES**
— with the prerequisite in F-7 below, and only in this order, after master's 066.

Reviewed by reading both files in full and by an **independent** proof script
(`scripts/review_r9c_migration_independent_proof.cjs`, written without reading
the candidate's own proof). 49/49 checks pass on local disposable databases:

- Manifest positions contiguous 1…61; the 59 landed migrations keep their ids and
  positions; 067 at 60, 068 at 61.
- Both files are wrapped in an explicit `BEGIN`/`COMMIT` (the pattern 37 of 61
  migrations already use) and contain no `DROP TABLE` or `DROP COLUMN`.
- Fresh install: 61 migrations, all succeeded.
- A **true** current-master upgrade: apply only the 59 landed migrations, seed
  production-shaped legacy data (a deal plus one participant per interesting money
  state and payment rows in every `result_class`), then apply the manifest —
  exactly two migrations are applied.
- All 59 historical ledger rows byte-identical afterwards (id, position, filename,
  checksum, status, `completed_at`).
- Every pre-existing business and payment row unchanged.
- Fresh and upgraded schemas equivalent: 997 columns, 1073 constraints, 254
  indexes, 19 triggers, 24 functions, compared including defaults, nullability,
  constraint definitions, index definitions, trigger definitions and function
  body hashes.
- Re-running the manifest is a no-op; re-executing both SQL files directly
  against an already-migrated database changes nothing.
- A deliberately tampered historical checksum is **rejected** and the ledger is
  left unchanged — no silent repair.
- Ledger checksums equal the on-disk bytes.

**Existing-row compatibility.** `dispatch_state TEXT NOT NULL DEFAULT 'responded'`
and `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` use PostgreSQL fast defaults,
so no table rewrite; a brief `ACCESS EXCLUSIVE` lock is taken, as with every
other `ALTER TABLE` in this repository. Both data-fixup `UPDATE`s run **before**
their own triggers are installed; 068's horizon backfill does run with 067's
lifecycle trigger already present and is admitted (legacy rows are `responded`,
so the in-flight branch is not entered).

**Function replacement is not a narrowing.** 068 does
`CREATE OR REPLACE FUNCTION siton.is_valid_money_transition`, which replaces the
definition master installed in migration 053. I checked this explicitly because a
replacement can silently drop transitions: 068's table is 053's table **plus**
`ChargeAttempt → AuthReleased`, verified by executing all 16 relevant transitions
against the upgraded database (12 must be admitted, 4 must be refused; 0 wrong).
The application-side `MONEY_TRANSITIONS` in `src/app.ts` matches exactly.

**Grants and runtime roles.** Neither file contains a `GRANT`. Neither does any
other migration in this repository — there is not a single `GRANT`, `REVOKE` or
`ALTER DEFAULT PRIVILEGES` in `src/migrations/`. The new `SECURITY DEFINER`
functions and triggers follow the same model migration 050 already uses on the
same table, so **no new grant risk is introduced**; the existing model is
inherited unchanged.

**Rollback.** Neither migration has a down step, and this repository has no
rollback mechanism at all — the ledger is forward-only. Reverting would require a
new forward migration. Stated as a fact, not a defect.

---

## 5. P0 — a foreign provider reference must never become capture proof

`P0_FOREIGN_REFERENCE_REPRODUCED_ON_MASTER` = **YES**
`P0_FOREIGN_REFERENCE_FIXED_IN_R9C` = **YES**

The counterexample is
`tests/review_payment_foreign_reference_ab_validation.ts`, written deliberately to
run on **both** trees: it touches only the participant state machine, the
`payment_reconcile` rail and the provider-ready HTTP seam, all byte-identical on
master and the candidate. It asserts the safe outcome, so it fails on master and
passes on the candidate. `scripts/review_ab_driver.cjs` runs it against a freshly
migrated disposable database on either tree. Amount and currency in the fabricated
answer deliberately **match** the obligation, so only exact-operation reference
identity can save the system.

| Tree | Result |
|---|---|
| canonical master `d4c7877` | **21 assertions FAIL** |
| review branch (master + candidate) | **29/29 PASS** |

On master, every one of seven foreign-reference shapes turns the participant into
`money_state = ChargedSuccess`, `buyer_state = ChargedSuccess`, with **zero
capture requests ever dispatched to the provider**. The shapes include an
arbitrary `xyz-` prefix, an `abc-` prefix, the upper-case form `CAP-` of a defined
prefix, a wholly unrelated identifier (`op_9f2c41d0aa11`), **another
participant's authorization**, and suffixed and truncated forms of the queried
reference. Master's `handlePaymentReconcileEvent` performs no reference check
whatsoever: a `state: "captured"` answer is accepted and the binding's provider
reference is then rewritten to the foreign value.

On the candidate every shape is refused, the money state stays `ChargeAttempt`, no
money request is dispatched, and a visible
`payment-reconcile-reference-mismatch:<participant>:charge_start` case is opened
each time.

The candidate's own commit `11b0ba0` is what closes the specific alias hole: the
provider-ready adapter's `bareReference` changed from `/^[a-z]{3}-/i` to
`/^(cap|rec|ref|rel)-/`. Note that the pre-existing test instrument could not
have caught it — the simulator's `WRONG_REFERENCE` behaviour answers with
`other-<uuid>`, a five-letter prefix the old regex never stripped.

### Every analogous path, not just the one the candidate tested

The candidate's `payment_final_reference_collision_validation.ts` covers the
reconcile capture lookup only. `tests/review_payment_reference_identity_rails_validation.ts`
attacks the same defect class on every remaining rail. 10/10 pass; provider truth
is read from the simulator's own effect ledger, so "no money moved" is measured:

| Scenario | Rail | Result |
|---|---|---|
| RI-1 | recovery pre-flight, foreign **negative** answer — the double-capture path | 0 provider effects, no recovery identity minted, `payment-recovery-preflight-mismatch` case |
| RI-2 | recovery pre-flight, foreign `captured` answer | 0 effects, no false `RecoveredCharge`/`ChargedSuccess` |
| RI-3 | refund lookup, foreign reference | 0 refunds, stays `ChargedSuccess`, no fee reversal row, mismatch case |
| RI-4 | release lookup, foreign reference | 0 releases, no false `AuthReleased`, mismatch case |
| RI-5 | late signed `charge_failed` callback, foreign reference, after a captured truth | money truth unchanged |
| RI-6 | late signed `charge_captured` callback, foreign reference, after a released hold | stays `AuthReleased`, no fee row, `payment-late-money-effect` case raised |
| RI-7 | a sibling participant's **genuine** capture answering this participant's query | 0 effects, stays `ChargeAttempt`, no fee row, mismatch case |
| RI-9a/b | identity **reuse** before a new dispatch, foreign `captured` / `failed` | 0 effects, no unpaid `ChargedSuccess`, no second dispatch |
| RI-8 | recorded contract boundary (see F-4) | the accepted set is exactly the four defined prefixes plus a missing echo |

`EXACT_OPERATION_MATCHING` = enforced on every rail, with the documented
boundary in F-4.

### Anti-vacuity

`scripts/review_mutation_proof.cjs` reverts one layer of the defence at a time
and requires the suites to go red. A mutant counts as killed only on a genuine
test failure; compile and setup errors are classified `INVALID`.

| Mutant | Layer reverted | Result |
|---|---|---|
| RM-1 | restores the `/^[a-z]{3}-/i` alias (the final review's own correction) | **KILLED** by both suites |
| RM-2 | removes the reconcile reference-mismatch guard | **KILLED** by both suites |
| RM-3 | removes the recovery pre-flight `foreignRead` guard | **KILLED** |
| RM-4 | removes the prior-attempt-resolution reference guard | **KILLED** (after RI-9 was added) |

`ADVERSARIAL_TEST_RESULTS` = 4/4 mutants killed, 0 survived. RM-4 initially
**survived**, which exposed a real gap in the reviewer's own coverage — identity
reuse was untested — and is exactly why RI-9 exists. Reported rather than hidden.

---

## 6. Duplicate money, fencing and finality

`DISPATCH_FENCING`, `LEASE_FENCING` = enforced at the database, not only in the
process. `scripts/review_db_fencing_proof.cjs` drives raw SQL against a
disposable database with 067/068 applied and ignores the application entirely.
21/21 pass:

| Check | Result |
|---|---|
| a foreign writer declares a negative outcome in flight | refused, `SN409 payment_attempt_in_flight_negative_settle` |
| the same with no owner declared at all | refused |
| a foreign writer steals the dispatch (re-arm) | refused, `payment_attempt_dispatch_in_flight` |
| a foreign writer disarms to `recorded` | refused, `payment_attempt_in_flight_disarm` |
| any other foreign write in flight (SR-1), including rewriting `provider_reference` | refused, `payment_attempt_in_flight_foreign_write` |
| provider **SUCCESS** from any writer | **admitted** — the deliberate exception, so real money is never lost |
| the dispatching owner settles a negative outcome | admitted |
| `success →` anything else | refused, `payment_attempt_terminal_downgrade` |
| `permanent_fail → unknown` | refused |
| `permanent_fail → success` (late provider truth) | admitted |
| an expired lease means not in flight; a successor may settle | admitted |
| the in-flight predicate is lease-generation sensitive; a row with no owner is never in flight | holds |
| the settlement horizon shortened or set to NULL | silently clamped to the earlier value |
| exact-request `failure_evidence` downgraded to an inference | clamped back to `dispatch_response` |
| a recorded negative-finality authority raised to `true` | clamped back |

Combined with the INSERT guards proved in §4 (identity rotation blocked while an
operation is `unknown` or `success`; recovery blocked behind an unresolved or
successful capture; release blocked behind an executed capture; capture blocked
behind an unresolved or executed release; recovery/release refused while fenced),
the duplication verdicts are:

| Field | Verdict |
|---|---|
| `INITIAL_CAPTURE_DUPLICATION` | not reachable — one durable identity per obligation, rotation refused by the DB, arm-before-I/O under a verified lease, post-dispatch ambiguity is `UNKNOWN` and never a retryable no-effect |
| `RECOVERY_DUPLICATION` | not reachable — recovery has its own identity, is refused while the original capture is `unknown` or `success`, is fenced by the settlement horizon, and requires exact-operation evidence in the pre-flight |
| `REFUND_DUPLICATION` | not reachable — refunds are full-amount only, recomputed from `qty × price + delivery`; eligibility requires `money_state IN ('ChargedSuccess','RecoveredCharge')`; `Refunded` is terminal; a second refund identity is refused while one is `unknown`/`success`; one `refund_adjustment` fee row per participant by unique index |
| `RELEASE_DUPLICATION` | not reachable — release is refused behind an executed capture and behind the fence; `AuthReleased` is terminal |
| `AMBIGUOUS_RESULT_HANDLING` | `UNKNOWN` + reconcile the exact operation + operator case; no blind redispatch |
| `RECONCILIATION` | tied to the exact operation; foreign references, foreign currencies and contradicting amounts refused; a terminal identity steps aside while a sibling of the same family is unresolved; idempotent and restart-safe |
| `SETTLEMENT_HORIZON` | implemented consistently with its declared configuration (§4, F-7) |
| `NEGATIVE_FINALITY` | a negative status becomes a verdict only under an explicitly recorded provider authority; unproven and legacy rows are permanently fenced |
| `LATE_EVENT_PROTECTION` | stale events never overwrite newer truth; refused provider effects become visible late-money-effect cases rather than being discarded |
| `TERMINAL_STATE_PROTECTION` | enforced in the application state machine **and** in the database trigger |

Partial refunds do not exist in this system, so "refund greater than the
refundable balance" and "refund after a previous partial refund" are structurally
unreachable rather than defended.

`FINANCIAL_ATOMICITY`, `FEE_LEDGER_ATOMICITY` = atomic. All money-truth
transitions (`ChargedSuccess`, `RecoveredCharge`, `Refunded`) write the fee
ledger row through `insideTx(c)` on the same `PoolClient`, inside the single
`BEGIN`/`COMMIT` that also performs the state compare-and-swap. Order is audit →
outbox → fee ledger → CAS → idempotency → `COMMIT`; any failure before `COMMIT`
rolls back both, and a lost CAS throws and discards the fee row. Money success
without a fee row, or a fee row without money success, is not reachable by a
crash. Making these writes share one transaction is one of the port's own fixes.

---

## 7. Findings

### F-1 — false success from a foreign reference · P0 · FOUND_IN_MASTER · FIXED_IN_R9C
Reproduced on master seven ways, fixed by the candidate, proved by A/B and by
four mutants. See §5.

### F-2 — seller "pending money" double-counts a dropped buyer · P2 display · INTRODUCED_BY_R9C
The port's F-6 correction is right: master's `recovery_failed` handler set
`money_state → AuthReleased` with **zero** provider releases, a false claim that
the hold was released. The candidate instead drops the buyer and leaves the money
state at `ChargeFailedRecovery` until a provider-proofed release succeeds.

That creates a state pair master's read models never saw: `buyer_state = 'Dropped'`
with `money_state = 'ChargeFailedRecovery'`. In `src/seller_analytics.ts` the
`pending_units` filter includes `ChargeFailedRecovery` while `failed_units`
includes `buyer_state IN ('DealFailed','Dropped')`, so the same participant is
counted in **both** buckets — indefinitely, and permanently if the provider
refuses the release and it ends as an operator case. `recovery_pending_units` and
`in_recovery` in `src/frontend_runtime.ts` overstate money in flight the same way.

No stored financial truth is wrong and no money moves. Not fixed here: it is a
read-model change on surfaces this review is instructed not to modify. Recommended
follow-up — exclude `buyer_state IN ('Dropped','DealFailed')` from the pending
buckets.

### F-3 — voucher redemption had no money gate · P1 · PREEXISTING IN MASTER · ALREADY FIXED ON CURRENT MASTER
At `d4c7877`, `POST /api/seller/fulfillment/:unitId/redeem` gated only on seller
ownership, `deal_state = 'Completed'` and unit status. It never joined
`siton.participants` and never read `money_state`, so a refunded buyer's issued
voucher or ticket could still be redeemed — goods handed over after the money was
returned. The canonical pickup rail refuses exactly that
(`decidePhysicalFulfillment` → `not_ready_reason: "refunded"`), so the repository
had two redemption doors with different gates.

Master's newest commit `c1ce4e4` **added** the gate (`decideFulfillmentIssuance`
+ `fulfillment_unit_not_entitled`). The candidate does not contain it only because
it predates it. Nothing to fix here, but it is a merge instruction:
**merge the candidate into master; never fast-forward, reset or force-push it
over master**, or the gate is lost. The review branch's merge was checked
explicitly — `src/frontend_runtime.ts` auto-merged keeping both master's new gate
and the R9C late-money-effect hook.

### F-4 — the provider-ready reference alias set · residual, documented · PREEXISTING
`bareReference` treats the four defined operation prefixes `cap-`, `rec-`, `ref-`,
`rel-` as operation-scoped forms of the same authorization, and an answer that
echoes **no** reference at all is treated as answering the query it was sent for.
Both are deliberate. RI-8 pins the accepted set to exactly these five shapes so it
cannot widen silently.

Consequences, stated precisely. A `rec-<auth>` answer can satisfy a `cap-<auth>`
query; because the only positive verdict is `state === "captured"`, this can
report "money moved" when a recovery moved it, which is the conservative
direction. A refund or release answer carries `state` `refunded`/`released` and
cannot manufacture a capture. A missing echo is trusted because the lookup is
request-scoped by URL; a provider that lies about the operation it was asked
about is outside this repository's control and outside this review's scope.

### F-5 — payment operational cases are not linked to a participant · INFO · PREEXISTING
`openPaymentOperationalCase` inserts into `siton.operational_cases` without
`participant_id`; the participant appears only inside `auto_key`, `subject` and
`description`. Every payment case — including the reference-mismatch and
late-money-effect cases this review relies on for visibility — is therefore
invisible to any admin surface that filters cases by participant, and is
discoverable only by text match. This cost the reviewer a false test failure
before it was diagnosed. Recommended follow-up: populate `participant_id`.

### F-6 — a reused provider event id can commit a capture with no fee row · LOW, under-collection · PREEXISTING
`src/platform_fee_money.ts` inserts the fee row with an **un-targeted**
`ON CONFLICT DO NOTHING`, so it also swallows a conflict on
`ux_platform_fee_money_provider_event`, and the caller in `src/app.ts` discards
the `{ status: "recorded" | "duplicate_ignored" }` return value. If a provider
ever reused an `event_id` across participants, the capture would commit
`ChargedSuccess` with no fee row, silently, and the participant would drop out of
payout. The direction is seller under-payment, never a double fee. Recommended
follow-up: target the conflict on the charge index, or assert the returned status.

### F-7 — deployment prerequisite: legacy failed captures become permanently fenced
This is the one operational consequence of applying 068 that operators must know,
and it is proved rather than assumed. 067 adds `dispatched_at` as NULL for
existing rows; 068 then backfills `settlement_horizon_at = dispatched_at + 24h`
only `WHERE dispatched_at IS NOT NULL`. On a real upgrade that matches **zero**
rows. Every pre-existing capture-side `permanent_fail` row therefore keeps a NULL
horizon and a NULL authority, and
`payment_capture_settlement_fence` returns `'infinity'` for it.

Measured on the upgrade fixture: recovery and release INSERTs for such a
participant are refused with
`money_operation_fenced_negative_finality_unproven`, and are admitted again as
soon as `failure_evidence = 'dispatch_response'` (or `'operator'`) is recorded.

So after this migration, **automatic recovery and automatic release are
permanently blocked for every participant with a pre-existing failed capture**
until an operator verifies the operation at the provider and records
`failure_evidence = 'operator'` on the identity. A fresh `charge_start` is not
affected. This is fail-closed and therefore the right default, but it is a
migration-day operational task, not a no-op. Recommended: audit the count of such
rows before applying 068 and prepare the operator annotation path.

### F-8 — "exactly 8%" holds on the fee base, not on the field named `platform_fee_amount`
`SITON_PLATFORM_FEE_RATE = 0.08` is a source literal with no environment or
per-deal override; `deals.commission_rate` was dropped by migration 022. The
canonical arithmetic is
`feeBase = max(0, gross − vat)`, `platformFeeBase = feeBase × 0.08`, with
`gross = qty × price_per_unit + delivery_cost` read from rigid columns.

`platform_fee_base_amount` is exactly 8%. `platform_fee_amount` and
`platform_fee_total_amount` are the fee **plus Siton's own output VAT on its fee**
(`SITON_PLATFORM_FEE_VAT_RATE`, default 0.18, environment-overridable), so the
deduction from seller net is 9.44% of the fee base by default. That is Siton's VAT
on its own service, not a second commission, but the invariant should always be
quoted against `platform_fee_base_amount`. Preexisting and unchanged by the port
— `git diff origin/master 356574f -- src/platform_fee_money.ts` is 20 lines and
purely structural, moving the ledger write into the caller's transaction.

| Field | Verdict |
|---|---|
| `SITON_FEE_PERCENT` | 8.00% exactly, on `platform_fee_base_amount` |
| `VAT_EXCLUDED_FROM_CANONICAL_FEE_BASE` | YES |
| `DELIVERY_INCLUDED_IN_CANONICAL_FEE_BASE` | YES |
| `DISTRIBUTOR_COMMISSION_PRESENT` | **NO** |

No constant, column, field or arithmetic computes or moves distributor money.
Distributor links are attribution-only by migration 046 and 051; the affiliate
commission and payout columns were dropped by migrations 020 and 022; the payout
rail is seller-only and derives every amount from
`siton.platform_fee_money_events`. `src/admin_mission_control.ts` reports
`distributor_commission_present: false` and `siton_fee_pct: 8` as hard-coded
facts, and mutant `M15_distributor_commission` exists to catch a reintroduction.

### F-9 — display surfaces ignore buyer VAT · display only · PREEXISTING · NOT IMPORTED
`product_surface_support.summarizeMoney` accepts `vatAmount`, echoes it, and never
subtracts it from the fee base, so the admin overview
`settlements.seller_workspace.platform_fee_amount` overstates the platform fee
under `SITON_VAT_MODE=explicit`. Several other display surfaces call the correct
canonical function with no `vatAmount` at all. The **canonical ledger and the
payout rail that reads it remain correct** — this is display truth, not ledger
truth. Already fixed on a different review branch, which this task forbids
importing; recorded here so the two reviews do not lose it.

### F-10 — Grow status selection prefers `captured` over `refunded` · residual, contained · PREEXISTING
`selectAuthoritativeTransaction` in `src/grow_payment_adapter.ts` picks
`byState("captured")` before `byState("refunded")` among the transactions of one
payment process. A Grow process containing both a capture and a refund would
therefore answer a **refund** status query with `captured / final`, which the
reconcile refund branch reads as "the refund never executed" and would otherwise
follow by re-arming the refund job — a second refund.

It is contained, and the containment is explicit in the code: that branch begins
`if (!policy.negative_status_authoritative) await failClosedUnresolved(...)`, and
Grow's policy is fail-closed on both flags, so the outcome is a
`FINANCIAL_OUTCOME_UNRESOLVED` operator case and `PermanentFail`, never a repeat.
Grow runtime is not enabled. Must be resolved before Grow real money; not a code
merge blocker.

### F-11 — `PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE` defaults to the permissive value · real-money prerequisite · PREEXISTING
`PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE` is `String(env).toLowerCase() !== "false"`,
i.e. **true unless explicitly disabled**, and the provider-ready adapter passes it
straight into `negative_status_authoritative`. Recovery, the refund re-arm and the
release re-arm all become permitted on status inference under that flag. There is
no boot-time assertion for it, unlike `assertVatAuthorityForRealMoney` which
refuses real money unless the VAT mode is explicit. An operator who wires a real
provider through this adapter and forgets the flag silently gets the permissive
contract, on a fact the repository itself documents as unverified.

Deliberately **not changed here**: flipping the default alters the reviewed
candidate's behaviour across many suites and reduces automation, which is the
owner's decision, and real money is forbidden regardless. Recommended: mirror the
VAT pattern with an `assertProviderAmbiguityPolicyForRealMoney` guard, or flip the
default to fail-closed.

### F-12 — a dual capture was absorbed as an idempotent replay · P1 observability · PREEXISTING · FIXED ON THE REVIEW BRANCH
`recordLateMoneyEffectException` is the mechanism that keeps a refused provider
effect visible. It decided "is this a contradiction?" from the money STATE alone:

    captureEffect && !["ChargedSuccess", "RecoveredCharge", "Refunded"].includes(moneyState)

Right for an idempotent REPLAY, wrong for a DUAL capture. When a recovery has
succeeded and the ORIGINAL capture then settles late, the money state is
`RecoveredCharge`, the predicate is false, and the effect is dropped. Measured on
the unmodified candidate (`tests/review_payment_dual_capture_escalation_validation.ts`,
DS-1): provider effects `capture=1 recover=1`, `money_state=RecoveredCharge`,
`cases=[]` — two real captures at the provider, canonical state accounting for
one, and nobody told. That is precisely what both the recovery contract ("detect
and escalate rather than silently accept both") and the late-event rule ("do not
merely discard evidence of real money") forbid.

**Severity, stated honestly.** The rails do not CAUSE this. It needs a provider
that settles a request after declaring it failed, or after its own declared
settlement horizon. The lab oracle already fails any scenario in which provider
captures exceed one (`DUPLICATE_CAPTURE`), and the recorded fuzz and soak runs
are clean. So this is a production observability gap, not a source of double
money — but it is exactly the case where the money is real and nobody would ever
find out.

**Fixed here** by detecting it through IDENTITY instead of state: a capture
effect arriving while the money state already says captured is a dual capture
when a DIFFERENT capture-side identity is the one recorded as executed.
Deliberately conservative — the claim is made only when an executed capture-side
identity positively exists and is not the one named, so a seeded state or a
pre-rails row with no identity keeps the old behaviour and no new case traffic
appears. After the fix the case is opened and the original identity converges to
provider truth, which makes the double capture visible in `payment_attempts` and
blocks every further automatic money operation for that participant through the
067 rules.

Two controls guard against over-firing, both passing: DS-2 (a duplicate delivery
of the SAME capture stays silent) and DS-3 (a late capture on a released hold
keeps the pre-existing escalation). Mutant RM-5 turns DS-1 red again when the
detection is disabled.

Provenance: the predicate is byte-identical to the reviewed source `3809b32`, so
it is PREEXISTING in that lineage and NOT introduced by this candidate. Canonical
master is worse — it has no late-money-effect mechanism at all, so the effect is
discarded there with no case in every state.

---

## 8. Test results

`STATIC_GATES` — all PASS on the merged review branch: TypeScript `--noEmit`
(source and tests), `backend_enforcement_scan`, `compliance_payment_scan`,
`runtime_ddl_scan`, `architecture_truth_gate`, `ci_route_authorization_gate`, and
`git diff --check` over the whole delta.

| Campaign | Result |
|---|---|
| Independent migration proof (reviewer's own) | 49/49 |
| Candidate's own migration proof, re-pinned to landed master | PASS — fresh 61, upgrade 59→61 applying only 067/068, legacy rows preserved and fenced, checksum mismatch rejected |
| DB-level dispatch/lease fencing proof (raw SQL) | 21/21 |
| P0 foreign-reference A/B, canonical master | 21 assertions FAIL (defect reproduced) |
| P0 foreign-reference A/B, review branch | 29/29 PASS |
| Reviewer adversarial identity suite (all rails) | 10/10 PASS |
| Reviewer mutation proof | 5/5 killed, 0 survived |
| No pre-existing test was weakened | verified by reading all 10 modified test diffs |

**On the modified tests.** The candidate changes 10 pre-existing test files. Every
change was read: none weakens an assertion. `full_system_qa` and
`real_integrations` now assert `ChargeFailedRecovery` instead of `AuthReleased`,
which is the F-6 fix making them MORE truthful (master claimed a release with
zero provider releases). `webhook_truth_handling` gains an assertion that the
late-effect case exists. `payment_release_lifecycle` replaces a weak "temporary
failure retries" expectation with a much stronger one: post-dispatch 503 is
UNKNOWN on the same identity, resolved by status proof, with exactly one release
call ever. `charge_attempt_rate_limit` reseeds its fixtures because the new
guards refuse a second unresolved identity, leaving the rolling cap itself
unchanged. `full_e2e_gate` adapts to the new identity scheme.
`charging_completion_window` gives its stub a truthful status seam, where a 404
previously let a recovery proceed.

### Full suite

`FULL_TEST_RESULTS` — the definitive `node scripts/run_test_group.cjs all` run on
the merged review branch, with the F-12 fix in place. **240 files, 239 pass,
9 of 10 groups green**, a fresh isolated database per file, 1515 s:

| Group | Files | Result |
|---|---|---|
| unit | 15 | 15/15 |
| integration | 31 | 31/31 |
| db | 8 | 8/8 |
| api | 44 | 44/44 |
| workers | 13 | 12/13 in that run — now **13/13**, see below |
| payments | 60 | **60/60** |
| security | 39 | 39/39 |
| concurrency | 8 | 8/8 |
| failure | 9 | 9/9 |
| e2e | 13 | 13/13 |

The single failing file is `worker_two_process_fencing_validation.ts`, at
`timeout waiting for: p2 all six claimed and blocked` — a 20-second poll waiting
for six `deadline_check` jobs to be claimed and blocked simultaneously, 3+3,
across two spawned worker processes while the test holds
`LOCK TABLE siton.deals IN ACCESS EXCLUSIVE MODE`.

**It was a test-harness defect, now fixed at its root cause, and it was never a
runtime defect or a fencing race.** Across roughly 60 isolated runs the failure
was ALWAYS one of the two "wait until the jobs are claimed and blocked"
arrangements and NEVER a fencing assertion: ownership stayed one worker per job,
leases renewed, the killed owner expired, the survivor reclaimed, completion
stayed exactly-once.

The mechanism, from a captured timeline plus the code path. The blocking device
is `LOCK TABLE siton.deals IN ACCESS EXCLUSIVE MODE`, which is what makes the
`deadline_check` handler's first read block. That mode conflicts with
`ACCESS SHARE`, so it equally blocks any OTHER plain read of `siton.deals` — and
`runWorkerMaintenance()` runs on every worker cycle and calls
`rescheduleStalledFinalizations()`, which scans `FROM siton.deals`. A worker
inside maintenance when the lock lands is stalled there for the whole phase, so
it never reaches its next `claimPendingOutboxBatch` and the jobs it was meant to
claim stay pending. The timeline of a failing run shows one worker claiming its
3 jobs at 271 ms and the other claiming **nothing** for the remaining 19.6 s
while 3 rows stayed pending and both workers kept heartbeating.

Two fixes were tried and one was discarded honestly. Making the phase's jobs
visible in a single INSERT did **not** help (same rate), so it was reverted
rather than shipped as a "stabilization". A longer timeout cannot help either,
because the stalled worker cannot claim until the lock is released, which is the
end of the phase; and the lock mode cannot be weakened, because the handler's own
blocking access is a plain SELECT and only `ACCESS EXCLUSIVE` blocks that.

The fix retries the **arrangement**: on a stall the lock is released, the queue
drains, and the phase is set up again with fresh deals, bounded to two attempts
so the file stays inside its 180 s runner budget. Every assertion and every
`run()` label is byte-identical, and the new readiness predicate is *stricter*
than the count it replaces because it also requires the 3+3 ownership split up
front.

Measured A/B with the same probe on an **idle** host:

| Tree | Result |
|---|---|
| before the fix | **6/12 pass** — 50% failure, always the P2 arrangement |
| after the fix | **12/12 pass** |

The underlying stall still occurs at the same rate: two of the twelve passing
runs took ~39 s instead of ~18 s, which is the retry absorbing it. The earlier
"~14%" figure was measured while another test runner was active on this host,
which is also why this file's historical reputation was "passes in isolation".

A second, quieter defect in the same file was fixed: it killed its worker
children only on the success path, so a failed assertion leaked two live workers
that kept polling a database the harness was about to drop. Orphans accumulated
across runs and degraded every later suite on the same host — which is how one
flaky file poisons the numbers of everything after it. A process `exit` reaper
now kills them on every exit path.

Two earlier first-pass group failures, both explained and resolved rather than
reinterpreted:

- **payments, exit 1** in the first `all` run — one file:
  `review_payment_dual_capture_escalation_validation.ts`, this review's own
  deliberately-red F-12 counterexample. That is the failing-test-first evidence
  for F-12, produced by the full run itself. The group is 60/60 with the fix.
- **integration, ETIMEDOUT** in the first `all` run — the `all` runner caps each
  group child at 30 minutes and the group exceeded it under load. It passes
  31/31 in 72–84 seconds both standalone and in the second full run. A harness
  cap, not a test failure.

Recorded as genuine environment artifacts, neither hidden nor rerun until green:
the group timeout above, the fencing flake above, and the known Windows libuv
teardown crash (`0xC0000409`) that the A/B counterexample hits on the master
baseline tree *after* printing its verdict.

---

## 9. Verdict

```
SAFE_TO_MERGE_CODE = YES_WITH_REQUIRED_FIXES_ON_REVIEW_BRANCH
```

The candidate materially prevents Siton from losing money, charging twice,
marking money successful without provider truth, or corrupting financial state
under retries, crashes, duplicate events, ambiguous results and late provider
events — and it does so at the database as well as in the application. The one
merge blocker is not a money defect but a migration-id collision created by master
advancing during the review; it is fixed on `claude/review-r9c-financial`.

The required fixes are exactly the ones already applied here: the 067/068
renumbering with its reference updates, the F-12 dual-capture escalation, and
merging rather than fast-forwarding so master's newer redemption money gate
survives.

```
BLOCKERS_FOUND  = 2   B-1 migration id 066 collision; F-12 dual capture absorbed silently
BLOCKERS_FIXED  = 2   both on claude/review-r9c-financial, each with its own proof
BLOCKERS_OPEN   = 0
```

Non-blocking follow-ups stay open by choice, not by omission: F-2, F-5 and F-6
touch read models and surfaces this review is instructed not to modify, and F-10
and F-11 are real-money prerequisites whose fixes are owner decisions about
automation, not review remediation.

| Readiness | Verdict |
|---|---|
| `FINANCIAL_CODE_READINESS` | high for the reviewed scope — identity, fencing, atomicity, finality and late-event handling are enforced and independently proved; F-2, F-5, F-6 are open non-blocking follow-ups |
| `GROW_PROVIDER_PROOF_READINESS` | **none.** No sandbox credentials, no provider-side evidence for exact-operation references, amount and currency, positive or negative finality, the real settlement horizon, settle/refund idempotency, or authenticated callbacks matched to actual effects. F-10 must be resolved first |
| `REAL_MONEY_READINESS` | **zero, and blocked.** Beyond the Grow gap: F-11's permissive default, F-7's migration-day operator task, and F-9's fee display under explicit VAT |

```
REAL_MONEY_EXECUTED = 0
GROW_CALLED          = NO
REAL_EMAIL_SENT      = NO
REAL_SMS_SENT        = NO
HOSTED_DB_CHANGED    = NO
MERGED               = NO
```

Every database used by this review was a local disposable one, created and dropped
by the proof scripts. Every provider was an in-process simulator or a local HTTP
stub. The 7-day runtime cap, the long-horizon architecture, UX and notification
code were not touched.

## 10. Next step

Owner decision on merging `claude/review-r9c-financial` into `master`, then the
three non-blocking follow-ups (F-2 read-model buckets, F-5 case participant link,
F-6 targeted fee-ledger conflict). Before any Grow work: resolve F-10 and F-11,
and plan F-7's operator annotation for existing failed captures.
