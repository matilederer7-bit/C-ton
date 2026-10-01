# Payment Reconciliation Runbook — Siton (C-ton)

Status: daily and after-incident reconciliation procedure. Written 2026-09-27 (Black-Sky branch, base `dd378dd`). It extends `docs/PAYMENT_INCIDENT_RUNBOOK.md` (scenario detail, evidence map, state machines) and `docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md` (standing rules); it does not repeat their scenario lists. Nothing here moves money; the only writes an operator makes are control-plane actions and, for one explicitly owner-authorised case type, a case-status update backed by provider evidence.

Legend: **IMPLEMENTED** (cited file), **EXPECTED** (designed, unobserved live), **OPEN** (no tooling), **OWNER ACTION**.

## 0. Never-do list

1. No manual capture, refund, void, payout, re-dispatch, or `UPDATE` of `participants.money_state` / `seller_payout_batches.payout_status` (`docs/REFUND_POLICY.md`: "No manual refund. No manual credit. No manual void as a commercial support tool.").
2. Never replay a webhook by hand into the ingestion route or insert a `webhook_events` row; the only replay is the provider re-sending the event (dedupe by `(provider, event_id)` makes that a no-op).
3. Never requeue a DLQ'd money event (no redrive exists; `requeue_outbox_event` cannot see `outbox_dlq`).
4. Never call `createPayout` twice for one batch — the rail forbids it (`payout_dispatch_outcome_unknown`, `src/payout_rail.ts:1135-1160`); do not work around it with SQL.
5. Never raise `WORKER_MONEY_CONCURRENCY` above 1 or run a second worker to "drain" reconciliation.
6. Never mark a case `resolved` without the provider evidence named in §7.
7. Never write a buyer- or seller-facing statement about money before the reconciliation for that participant/deal is `resolved` per §7.
8. Never delete or edit `platform_fee_money_events`, `payment_attempts`, `webhook_events`, `seller_payout_attempts`, `seller_payout_reconciliation_cases`, `audit_log`.
9. Never run the invariants CLI with a URL on the command line (it deliberately has no flag: `MONEY_INVARIANTS_DATABASE_URL` or `DATABASE_URL` only, so the URL never enters shell history or `ps`).

## 1. The fee rule you reconcile against

Binding (`AGENTS.md`, `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`, `docs/PLATFORM_FEE_PAYMENTS_8_PERCENT.md`; verified in code by the red team, `docs/archive/RED_TEAM_FINAL_REPORT.md` B1):

- Siton's fee is **8% of the amount actually collected** from the buyer, **including shipping/delivery and every other purchase component collected through Siton**, **excluding the customer VAT component** from the fee base.
- VAT is then added on Siton's fee only (`platform_fee_vat_amount`, rate `SITON_PLATFORM_FEE_VAT_RATE` default 0.18); `platform_fee_total_amount = platform_fee_base_amount + platform_fee_vat_amount`; `seller_net_amount = gross_amount - platform_fee_total_amount`.
- The rate is a hardcoded constant; there is **no per-deal commission override** and **no distributor commission** anywhere (`scripts/distributor_attribution_only_gate.cjs` fails CI if one appears).
- Per participant: `gross_amount = qty * price_per_unit + delivery_cost` from DB values only; browser-sent amounts are never authority.

Worked example (the rehearsal fixture, `scripts/db_backup_restore_rehearsal.cjs:146-147`): gross 50.00, VAT 0 → fee base 50.00 → fee 4.00 + fee-VAT 0.72 = 4.72 → seller net 45.28.

The invariants that encode this: `fee.total_equals_base_plus_vat`, `fee.seller_net_equals_gross_minus_fee_total`, `fee.abs_fee_le_abs_gross`, `payouts.settlement_matches_fee_ledger`, `payouts.batch_item_matches_participant_ledger`, `payouts.batch_items_sum_matches_batch` (`scripts/lib/money_invariants.cjs`).

## 2. Daily reconciliation (10 minutes, read-only)

```bash
# 1. posture — must not change without an owner decision
curl -s https://<web>/health/integrations                       # payment.provider=mockpay, payout.provider=internal-ledger on staging
# 2. control-plane counters
curl -s -H "x-admin-key: $ADMIN_API_KEY" https://<web>/api/admin/payment-ops-status   # attempts_by_type, unknown_count, retry_storm_candidates, signature failures, fee ledger totals
curl -s -H "x-admin-key: $ADMIN_API_KEY" https://<web>/api/admin/outbox-status        # due_now, processing, stuck_candidates, dlq, worker.running, payment_maintenance
curl -s -H "x-admin-key: $ADMIN_API_KEY" https://<web>/api/admin/payout-status        # settlements by status, batches, open reconciliation cases
# 3. invariants (READ ONLY transaction; safe on hosted; prints host and db only)
MONEY_INVARIANTS_DATABASE_URL="<hosted-owner-or-readonly-url>" npm run db:money-invariants -- --json > invariants-$(date -u +%Y%m%d).json
```

Read the last three lines: `MONEY_INVARIANTS_SUMMARY overall=PASS pass=N fail=0 error=0 skipped=… info=… total=…` then `MONEY_INVARIANTS_PASS` (exit 0). `SKIPPED` means a table/column is absent on that database (acceptable and named); `INFO` is a count, not a verdict; any `FAIL` or `ERROR` (exit 1) is an incident: keep the JSON, open `docs/INCIDENT_RESPONSE_RUNBOOK.md` §4.

Daily pass criteria: `MONEY_INVARIANTS_PASS`; `unknown_count=0` or every unknown younger than one worker cycle; `retry_storm_candidates=0`; no `outbox_dlq` row with a money-lane type; no open `seller_payout_reconciliation_cases`; no `operational_cases` with `case_type='PaymentMismatch'` in `Open|NeedsAdmin|WaitingExternal` older than 24 h.

## 3. Reading a FAIL line

Format: `MONEY_INVARIANT FAIL <name> count=N [exact_mismatch=N] samples=[<=5 ids]`.

| Prefix | What it checks | First question |
|---|---|---|
| `fee.*` | arithmetic and shape of `platform_fee_money_events` rows (sign vs entry type, total = base + VAT, net = gross − total, fee ≤ gross, deal/seller consistent with the participant) | did a migration or backfill touch the ledger? which `provider_code`? |
| `participant.*` | one `charge` row and at most one `refund_adjustment` per participant; `ChargedSuccess|RecoveredCharge` ⇔ a charge fee row **and** a successful `charge_start|recovery` attempt; `Refunded` ⇔ refund row; refund never exceeds charge | which side is missing: the state, the ledger row, or the attempt? that decides whether the capture happened (§4) |
| `deal.*` | joined units within `max_units`; `Completed` deals have a charged participant; charged participants only in charged deals; a `Charging` deal has live work (job, DLQ, reconcile or case) | is the worker running? is the deal's `charge_deal` job present? |
| `payment.stale_unresolved_attempt_has_reconcile_or_case` | an `unknown` attempt older than the budget has a `payment_reconcile` job or a case | §4 |
| `inventory.*` | `siton_inventory` counters/reservations agree with participants and `max_units` | canonical RPC path; capacity incident, not money |
| `audit.*` | the latest deal/buyer/money state has a matching latest audit transition | a state was written without its audit row (per-row triggers since migration 076 should make this impossible; treat as tampering or restore artefact) |
| `payouts.*` | amounts ≥ 0; paid ≤ payout; settlement = fee ledger; batch items = participant ledger; items sum = batch | §5 |

Every sample id is a `participant_id`, `deal_id`, `payout_batch_id` or `seller_settlement_id`; pull the ops views (`GET /api/admin/participants/:id/ops`, `GET /api/admin/deals/:id/ops-summary`, `GET /api/admin/payouts/batches/:id`) and the evidence SQL in `docs/PAYMENT_INCIDENT_RUNBOOK.md` §3–§7.

## 4. Unknown outcomes — payment attempts

Definition (IMPLEMENTED): `payment_attempts.result_class='unknown'` is written **before** provider I/O and stays if the answer was ambiguous (timeout, 5xx/429/408, malformed body, auth-routing reply on Grow — `src/grow_payment_adapter.ts` policy `unknown_then_status_lookup_then_manual_case_no_automatic_repeat`). The capture worker then enqueues `payment_reconcile` (money lane, concurrency 1) which asks the provider's status endpoint and applies exactly one canonical event; it never re-fires the capture. Under the lane retry policy a reconcile job retries 8 times over ~45 min (30 s base, 15 min cap, ±30% jitter) before the DLQ; on its last attempt it opens `PaymentMismatch` case `payment-reconcile-unresolved:<participant>:<attempt_type>`. Since migration 068 an inferred failure is fenced by `PAYMENT_SETTLEMENT_HORIZON_MS` (default 24 h): recovery, release and the terminal deal decision wait until the provider can no longer settle the dispatched request.

Decision tree:

```
unknown attempt older than one worker cycle?
├─ payment_reconcile job pending/processing for aggregate_id=<participant> → wait; nothing to do
├─ reconcile in DLQ or case payment-reconcile-unresolved → §7 "resolved" needs PROVIDER evidence:
│    OWNER ACTION: look the correlation_id up in the provider dashboard (the attempt's correlation_id IS the idempotency key)
│    ├─ provider shows captured  → the provider will (re)send charge_captured, or the next status read returns final: the rail applies it. If neither happens within the horizon: open_support_case, keep the deal in CompletionWindow/Charging (do not finalize), escalate
│    ├─ provider shows not executed / declined → after the settlement horizon the rail infers failure (when PAYMENT_NEGATIVE_STATUS_AUTHORITATIVE is not "false"); for Grow it never infers — the case stays until the provider's authoritative status is final
│    └─ provider unreachable → provider outage (INCIDENT_RESPONSE_RUNBOOK §6.2)
└─ no reconcile job and no case → invariant payment.stale_unresolved_attempt_has_reconcile_or_case fails: the worker missed it (crash between attempt and enqueue). trigger_reconcile opens the paper-trail case; the deal's next money step is blocked by the horizon fence. Escalate; do not enqueue by hand.
```

Evidence to attach: the attempt row (`attempt_id`, `attempt_type`, `correlation_id`, `dispatch_state`, `dispatched_at`, `resolved_at`), the reconcile outbox row(s) (`status`, `attempt_count`, `last_error`), synthetic `reconcile:<correlation>:<event_type>` webhook rows, the binding (`provider_reference`, `status`).

## 5. Unknown outcomes — payouts (`seller_payout_reconciliation_cases`)

Case types written by `src/payout_rail.ts` and what each means:

| `case_type` | Written when | Effect | Path to resolution |
|---|---|---|---|
| `dispatch_outcome_unknown` | `createPayout` (or a later `get_payout_status`) answered neither success nor permanent_fail, or threw/timed out (F7, `:1135-1160`, `:1440-1453`) | batch stays `processing`; settlement flagged `has_open_blocking_reconciliation_case`; `seller_payout_reconcile` refuses with `payout_reconcile_blocked_dispatch_outcome_unknown` (permanent fail → DLQ) | the rail re-runs `seller_payout_dispatch` for a `processing` batch as a **lookup** (`dispatchBatch` → `lookupBatchPayoutStatus`, same correlation id, `getPayoutStatus`, never `createPayout`; `:1316`, `:1389-1456`). A conclusive `paid|processing|reconciled` → accepted, case `resolved` with `resolved_by:get_payout_status`; `failed|returned` → batch advances forward-only, case resolved. Inconclusive → case stays open, `last_error=payout_lookup_inconclusive`. **Operator lever:** if the dispatch outbox row is `pending|failed` below its cap, `requeue_outbox_event` triggers another lookup; otherwise OWNER ACTION with the provider statement (§7). |
| `settlement_changed_before_dispatch` | at dispatch the fresh settlement differs from the batch (`seller_net_changed_since_batch`, `refunds_added_since_batch`, or a blocker) (`:1250-1270`) | dispatch held; nothing sent | the rail re-prepares when the settlement stabilises; if the change was a refund, the batch must be superseded — no operator write |
| `batch_item_total_mismatch` | at prepare, payable items do not sum to the settlement (`:905-925`) | no batch created | invariant `payouts.batch_item_matches_participant_ledger` / `payouts.batch_items_sum_matches_batch` will name the rows; fix is a code/data investigation, never an edit |
| `refund_after_payout_dispatch` | reconcile finds refunds added after the batch left (`:1590-1600`) | `processing` batch → `failed` (manual review); a `paid` batch **stays paid** (money that left is never rewritten); settlement `has_open_mismatch`, `mismatch_amount` recorded | OWNER ACTION: commercial decision (claw-back / next-batch offset) recorded in the case `details`; no automatic reversal exists |
| `amount_mismatch` | reconcile finds a different amount for another reason | same as above | same |

Read surfaces: `GET /api/admin/payout-status`, `GET /api/admin/payouts/batches/:id` (batch profile with attempts and cases). Staging runs `PAYOUT_PROVIDER=internal-ledger` (`internal-truth-only`): no external transfer is ever executed there, so a `dispatch_outcome_unknown` on staging is a code or DB problem, not a provider one.

Control levers that are legitimate: `freeze_payouts` (seller/deal/global) while investigating; `unfreeze_payouts` afterwards; `requeue_outbox_event` for a dispatch row in `pending|failed` below cap (lookup only). DB guards since migration 077: forward-only `payout_status` triggers, monotonic settlement amounts, amount CHECKs — a hand edit that breaks them is rejected.

## 6. DLQ money events

Money-lane and payout types: `charge_deal`, `recovery_deal`, `refund_issue`, `cancel_refund`, `payment_reconcile`, `payment_release`, `seller_payout_prepare`, `seller_payout_dispatch`, `seller_payout_reconcile`, `invoice_document_*`.

```bash
node scripts/run_pg_query.cjs "select event_uuid, event_type, aggregate_id, attempt_count, left(last_error,160) as last_error, created_at from siton.outbox_dlq where event_type in ('charge_deal','recovery_deal','refund_issue','cancel_refund','payment_reconcile','payment_release','seller_payout_prepare','seller_payout_dispatch','seller_payout_reconcile') order by created_at desc" "[]"
node scripts/run_pg_query.cjs "select audit_sequence, action, reason_code, from_status, to_status, attempt_count, created_at from siton.operational_recovery_audit where subject_type='outbox_event' and subject_id=$1 order by audit_sequence" "[\"<EVENT_UUID>\"]"
```

Per `last_error` class:

| `last_error` / reason | Meaning | Action |
|---|---|---|
| `max_attempts_exhausted` on `charge_deal`/`recovery_deal` | provider stayed temporary-failing for the whole budget | deal partially charged: every participant still `ChargeAttempt` has an attempt row; those `unknown` follow §4, `temporary_fail` ones are re-attempted only by a new `charge_deal` — which does not exist (OPEN); keep `pause_charging_emergency` on the deal, escalate |
| `PermanentFailError` on `refund_issue`/`cancel_refund` | provider refused the refund | `PaymentMismatch` case; OWNER ACTION with the provider; `docs/PAYMENT_INCIDENT_RUNBOOK.md` §7 STOP conditions |
| `payout_reconcile_blocked_dispatch_outcome_unknown` | expected while a dispatch case is open | §5 row 1 |
| `payout_batch_not_reconcilable:<status>` | reconcile for a batch already terminal | informational |
| `expired_lease_max_attempts` | the job kept dying mid-flight (deadline `WORKER_EVENT_TIMEOUT_MS`, watchdog) | worker incident first (`docs/INCIDENT_RESPONSE_RUNBOOK.md` §6.3); the money row is then §4 |
| `worker_event_deadline_exceeded` | per-job deadline hit; job abandoned to lease expiry | same |

Rule: a DLQ row is evidence. It is never deleted and never redriven; the rail's own reconcile job or a new canonical event is the only way forward.

## 7. What "resolved" means

A participant, deal or payout batch is **resolved** when all of the following hold and are written in the case `details` or the incident note:

1. Provider truth is known: a provider event (`webhook_events` row `processed`) or a final status read (`payment_attempts` row with `attempt_type` in `charge_start|recovery|refund|release|reauthorize` and `result_class` in `success|permanent_fail`, `dispatch_state='responded'`), or — for payouts — a `seller_payout_attempts` row with a conclusive `payout_status`.
2. DB state agrees with it: `money_state` matches the table in `docs/PAYMENT_INCIDENT_RUNBOOK.md` §1b; exactly one `charge` fee row per charged participant; `Refunded` ⇔ `refund_adjustment` row.
3. The invariants pass for the sample ids (`npm run db:money-invariants` → `MONEY_INVARIANTS_PASS`, or the only remaining FAILs are unrelated and already tracked).
4. No open case remains for the subject (`operational_cases` `PaymentMismatch`, `seller_payout_reconciliation_cases` `open`), or the remaining case has an owner decision recorded.
5. The buyer/seller statement (if any) was made **after** 1–4.

Manual case closure exists for exactly one situation: a payout `dispatch_outcome_unknown` whose provider statement (OWNER ACTION, attached as a document reference in `details`) proves the payout did **not** exist at the provider, and the rail's lookup cannot obtain that answer. Then, and only with that evidence, the owner updates the case row (hosted SQL as owner) with `case_status='resolved', resolved_at=now(), details = details || '{"resolution":{"resolved_by":"owner","evidence":"<reference>"}}'` and the rail's next reconcile proceeds; a `paid`-at-provider payout is never closed this way — it is accepted through the lookup path. Anything else that "needs" a manual close is an unfinished investigation.

## 8. Webhook replay and duplicates

IMPLEMENTED: `(provider, event_id)` primary key with `ON CONFLICT DO NOTHING`; race-safe claim; classification is state-gated (`already_captured`, `not_waiting_for_charge_capture`, `already_recovered`, `already_refunded`, `missing_correlation_target`, `unsupported_event_type`); HMAC-SHA256 with `timingSafeEqual`; timestamp required on production-like runtimes; Grow callbacks are never money truth (they trigger an authoritative status query).

Replay is therefore the **provider's** action: ask the provider to re-send by `event_id` when a processed event is missing. Verify afterwards with `SELECT provider, event_id, status, payload_jsonb->>'classification_reason', received_at, processed_at FROM siton.webhook_events WHERE participant_id=$1 ORDER BY received_at;`. Signature failures are in `payment_webhook_security_events` (`docs/CREDENTIAL_COMPROMISE_RUNBOOK.md` §3.5 if they were followed by acceptances you did not expect).

## 9. Refund policy gates (what the system will and will not do)

- Refunds happen only on the automatic failed-deal path: `CompletionWindow → Failed` when captured units are below `threshold_units` (90% of `min_units`) after the fixed 24 h window; `refund_issue` refunds every `ChargedSuccess|RecoveredCharge` participant; `cancel_refund` only with `deal.cancel` from Draft (`docs/REFUND_POLICY.md`, `docs/PAYMENT_INCIDENT_RUNBOOK.md` §7).
- Since migration 077 (Black-Sky A-F1/A-F5; must be applied to staging **before** the code that carries it deploys — the schema contract fails closed otherwise): the deadline and the threshold are money gates — `deadline_check` defers before the state filter so a paused deal below threshold still fails at its deadline (`ClosedForJoining → Failed`); `prepare_charging` refuses below threshold (`409 threshold_not_reached`); join and authorization refuse after the deadline by the DB clock (`409 deal_deadline_passed`).
- A refund reconcile that finds the charge still captured re-arms `refund_issue` once and marks the attempt `permanent_fail`; a release reconcile that finds the hold captured opens `payment-reconcile-release-captured` and stops — money moved against intent, S1.
- There is no goodwill refund, no partial commercial refund, no voucher non-redemption refund. Support answers come from `docs/CANCELLATION_REFUND_POLICY_HE.md`; engineering never edits money rows to satisfy a request.

## 10. Admin control-plane actions relevant to reconciliation

| Action | Use | Does |
|---|---|---|
| `trigger_reconcile` | paper trail for an unknown | opens/reuses a `PaymentMismatch` case; **no provider call** |
| `open_support_case` | record a `SystemException`/`PaymentMismatch` with the identifiers | case row only |
| `requeue_outbox_event` | a `pending|failed`, unsent, below-cap row (e.g. a dispatch row for a lookup) | back to `pending` with a new generation + `retry` audit |
| `pause_charging_emergency` | stop new capture work for a deal/seller/global | flag; refused at `charging.start` (which enqueues `charge_deal`); already-queued jobs still run — suspend the worker as well if they must not |
| `freeze_payouts` / `unfreeze_payouts` | hold settlements/dispatch | flag; never reverses paid |
| `retry_invoice_failed`, `retry_notification` | non-money rails | bounded retries |

None of them edits money state. All need a named admin session (recent MFA; second approval where marked in `docs/ADMIN_INTERVENTION_RUNBOOK.md`) — the `x-admin-key` bootstrap identity is read-only.

## 11. After-incident reconciliation (in addition to §2)

1. Run §2 on the affected database **before** the worker resumes (restore) or **after** the pause is released (provider outage).
2. Enumerate every money-lane row whose `dispatched_at`/`created_at` falls inside the incident window; classify each as resolved (§7) or open (§4/§5).
3. Compare the fee ledger totals from `GET /api/admin/payment-ops-status` before and after; any change must be explained by rows in step 2.
4. Attach `invariants-<ts>.json`, the DLQ listing, and the case listing to the incident note; state the money impact only with those attachments (expected 0 on staging).

## 12. Open items

- OPEN: no re-dispatch of a `charge_deal` whose budget was exhausted (partially charged deal needs an owner-decided path).
- OPEN: DLQ replay; worker-side `pause_charging_emergency` check for already-queued `charge_deal` jobs (enforced only at `charging.start`).
- OPEN: Mission Control outbox trace by `event_id` returns empty (`event_uuid` column mismatch); use the SQL here.
- OPEN: live-provider observation of every EXPECTED behaviour; proofs are mock/sandbox.
- OPEN: a dedicated read-only role for the daily invariants run on hosted (today the owner URL is used from the operator machine).
