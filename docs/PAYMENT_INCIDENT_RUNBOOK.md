# Payment Incident Runbook

Status: operator runbook for money incidents on Siton (C-ton). Written 2026-09-14 against branch `claude/release-readiness-night`. Reintegrated onto current master `0e53998` (PR #9 financial rails, PR #12 confidentiality proof, PR #13 hardened UX already merged) on 2026-09-15 as a controlled port of `claude/release-readiness-night` 63a108f; every reference below was re-verified against that master. Architecture: GitHub = code source of truth; Render = web/backend/worker staging runtime; Supabase = canonical PostgreSQL/Auth/infra; Grow = payment provider boundary, currently disabled; Base44 is never the business runtime. It changes NO financial logic and grants NO new permission. It extends `docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md`, `docs/OPERATIONAL_RUNBOOKS.md` and `docs/ADMIN_INTERVENTION_RUNBOOK.md`; read those first, this document does not repeat their scenario lists.

Legend: **IMPLEMENTED** = exists in the repository at the cited line. **EXPECTED** = behaviour the code is designed to produce but that no operator has observed against a live provider. **OPEN** = not implemented; do not assume it.

## 0. Standing rules (repeated from OPERATIONS_MONEY_INCIDENT_RUNBOOK.md, unchanged)

1. Do not run manual refund, manual capture, manual void, manual payout, or manual state edit (`docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md:7`). There is no admin refund and admin actions never edit state (`docs/ADMIN_INTERVENTION_RUNBOOK.md:52-53`).
2. Do not delete audit, webhook, outbox, DLQ, invoice, or payment-attempt rows (`docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md:8`). `siton.audit_log` and `siton.operational_recovery_audit` are append-only by trigger (`src/schema_contract.ts:82-86`).
3. Do not `UPDATE siton.participants SET money_state=...`. The database rejects illegal transitions through `siton.is_valid_money_transition` (`src/migrations/053_payment_authorization_bindings.sql:90-102`) and the application matrix `MONEY_TRANSITIONS` (`src/app.ts:480-489`); a "legal-looking" manual edit still bypasses audit, outbox and idempotency and is forbidden.
4. Never paste `x-admin-key`, `DATABASE_URL`, provider credentials, webhook secrets, OTPs, raw payloads or card data into a ticket (`docs/OUTBOX_WORKER_OPERATIONS.md:99-101`).
5. Every admin read below needs `x-admin-key` (timing-safe compare, `src/frontend_runtime.ts:1638-1662`) or an admin session identity (`src/frontend_runtime.ts:1669-1680`).

## 1. Real-money kill switch: what it is today

| Layer | State | Evidence |
|---|---|---|
| Release governance | `real_money_allowed=false`, `status=BLOCKED`, 4 uncleared blocking reasons | `config/real-money-release-policy.json` (`docs/REAL_MONEY_RELEASE_GOVERNANCE.md`). IMPLEMENTED |
| Production runtime guard | production refuses `PAYMENT_PROVIDER=mock|mockpay`, `PAYMENT_ENVIRONMENT=sandbox/test/demo`, test credentials; non-production refuses `PAYMENT_ENVIRONMENT=live` | `src/production_guards.ts:41-42,112-126`. IMPLEMENTED |
| Provider factory | production cannot fall back to mock-backed; Grow in a real environment must expose release/status/webhook capabilities or refuse to boot | `src/payment_provider.ts:1560-1610`. IMPLEMENTED |
| Hosted staging | `PAYMENT_PROVIDER=mockpay`, `PAYMENT_PROVIDER_MODE=mock-backed`, `PAYMENT_ENVIRONMENT=demo` for web and worker | `render.yaml:55-59,108-112`. IMPLEMENTED |
| Live provider | none. Grow sandbox transport proven only; live never exercised | `config/real-money-release-policy.json` reason `GROW_LIVE_VERIFICATION_NOT_PERFORMED` |

Consequence for every scenario below: **there is no live money today**. Every `payment_attempts` row, `webhook_events` row and fee-ledger row on staging is synthetic (`src/payment_provider.ts:380-515`, mock provider). The kill switch must REMAIN off (BLOCKED) until every blocking reason is cleared per the governance file's `how_to_change`; an incident is never a reason to flip it, and none of the steps below requires it.

Confirm posture at the start of any incident: `GET /health/integrations` returns `integrations.payment.provider=mockpay`, `mode=mock-backed` (`docs/HEALTH_CHECK_CONTRACT.md`), and `GET /api/admin/payment-ops-status` returns `provider.mock_backed=true`, `provider.real_activation_ready=false` (`src/payment_provider.ts:1613-1627`).

## 1a. First ten minutes (any money incident)

1. Record the time, the reporter and the identifiers (deal, participant, correlation, provider reference). No names, phone numbers or card data.
2. `GET /health/integrations` and `GET /api/admin/payment-ops-status`: write down `provider`, `mode`, `environment`, `mock_backed`, `real_activation_ready`. If any of them differs from the staging posture in section 1, stop and escalate before reading further: a posture change is itself the incident.
3. `GET /api/admin/outbox-status`: `worker.running`, `due_now`, `processing`, `stuck_candidates`, `dlq`.
4. `GET /api/admin/deals/:id/ops-summary` for the deal named by the reporter; then `GET /api/admin/participants/:id/ops` for each participant named.
5. Match the symptom to a section with the index below. Apply that section's STOP CONDITIONS before any other step.
6. If a STOP CONDITION fires: open an `operational_cases` row (`PaymentMismatch` for money, `SystemException` otherwise) through the admin support surface, request `pause_charging_emergency` for the deal or seller when charging could still run, and hand over with the escalation record in section 11.

Symptom index:

| Reporter says | Look at | Section |
|---|---|---|
| "charged twice" | `payment_attempts` success rows, fee-ledger charge rows | 3 |
| "charged but the app says not charged" / `unknown_count > 0` | `payment_attempts.result_class='unknown'`, `payment_reconcile` outbox rows | 4 |
| "hold still on my card after the deal failed" | `money_state` still `AuthHeld` / `AuthLocked`, `payment_release` rows | 5, 6 |
| "deal failed, no refund" | deal `state='Failed'`, `refund_issue` rows, `money_state` still `ChargedSuccess` | 7 |
| many `temporary_fail` in a short window | `attempts_by_type`, `retry_storm_candidates` | 8 |
| `payment_reconcile` pending count keeps growing | outbox by type, money lane | 9 |
| heartbeats flapping, `worker.running=false` | `worker_heartbeats`, `operational_recovery_audit` | 10 |

## 1b. What each money_state implies about provider-side money

| `money_state` | Provider-side expectation | Legal next states | Who moves it |
|---|---|---|---|
| `NoFinancial` | nothing at the provider | `AuthHeld` | join, after consuming an `authorized` binding (`src/app.ts:5209-5220`) |
| `AuthHeld` | a hold (authorization) exists, no capture | `AuthLocked`, `AuthReleased` | `deal.prepare_charging` locks (`src/app.ts:5594-5595`); the release rail releases |
| `AuthLocked` | hold exists, deal closed for joining | `ChargeAttempt`, `AuthReleased` | `charging.start` (`src/app.ts:5604,5663-5664`) |
| `ChargeAttempt` | capture requested; money may or may not have moved | `ChargedSuccess`, `ChargeFailedRecovery` | worker `charge_deal` through webhook truth or reconcile |
| `ChargedSuccess` | captured once; one `charge` fee-ledger row exists | `Refunded` | `refund_issue` / `cancel_refund` only |
| `ChargeFailedRecovery` | capture declined; hold may still exist | `RecoveredCharge`, `AuthReleased` | `recovery_deal` inside the completion window; release rail after failure |
| `RecoveredCharge` | captured once on retry | `Refunded` | refund rail only |
| `AuthReleased` | hold released or expired, with proof | terminal | never edited by hand |
| `Refunded` | refund issued once; one `refund_adjustment` ledger row | terminal | never edited by hand |

Every arrow above is checked twice: in TypeScript (`assertValidTransition`, `src/app.ts:491-500`) and in the database function used by the participant trigger (`src/migrations/053_payment_authorization_bindings.sql:90-102`). An operator who observes a participant in a state whose provider-side expectation does not match provider evidence has found a mismatch: record it, do not correct it.

## 2. Evidence map (tables, columns, surfaces)

| Evidence | Where | Key columns / meaning |
|---|---|---|
| Participant money truth | `siton.participants` | `buyer_state`, `money_state` (`src/migrations/014_demo_preview_bootstrap.sql:89-104`) |
| Money state machine | `MONEY_TRANSITIONS` | `NoFinancial > AuthHeld > AuthLocked > ChargeAttempt > {ChargedSuccess, ChargeFailedRecovery}`; `ChargeFailedRecovery > {RecoveredCharge, AuthReleased}`; `{ChargedSuccess, RecoveredCharge} > Refunded`; `AuthHeld/AuthLocked > AuthReleased`; `AuthReleased`, `Refunded` terminal (`src/app.ts:480-489`) |
| Buyer state machine | `BUYER_TRANSITIONS` | `NotJoined > JoinedAuthorized > LockedIn > ChargingAttempt > {ChargedSuccess, ChargeFailedCompletion} > {Recovered, Dropped} > {DealCompleted, DealFailed}` (`src/app.ts:468-478`) |
| Deal state machine | `DEAL_TRANSITIONS` | `Draft > PendingTarget > TargetReached > ClosedForJoining > ReadyForCharging > Charging > CompletionWindow > {Completed, Failed}`; `Cancelled` only from Draft (`src/app.ts:455-466`) |
| One provider attempt = one row | `siton.payment_attempts` | `attempt_type` in `charge_start, recovery, refund, deadline_check, cancel_refund, release`; `result_class` in `success, permanent_fail, temporary_fail, unknown`; unique `(participant_id, deal_id, attempt_type, correlation_id)` (`014:243-264`, `053:187-190`, `src/payment_attempt_helpers.ts:3-11`) |
| Attempt written BEFORE provider I/O as `unknown`, finalized after | `recordAttemptBeforeIo` / `finalizeAttemptResult` | `src/payment_attempt_helpers.ts:16-47` |
| Rolling cap: max 3 `charge_start`+`recovery` per (participant, deal) per 30 min, DB trigger | `siton.enforce_charge_attempt_rate_limit` | `src/migrations/050_charge_attempt_rate_limit.sql:1-9,28-33` |
| Provider events, dedupe by `(provider, event_id)` PK | `siton.webhook_events` | `status` in `pending, processing, processed, ignored, failed`; `payload_jsonb->>'classification_reason'`; `processed_at` (`007:166-177`, `039:6-8`, `src/webhook_ingestion.ts:98-121`) |
| Why an event was ignored | `classifyEvent` reasons | `already_captured`, `not_waiting_for_charge_capture`, `already_recovered`, `already_refunded`, `missing_correlation_target`, `unsupported_event_type` (`src/payment_reconciliation.ts:88-151`) |
| Rejected webhooks (bad signature) | `siton.payment_webhook_security_events` | `provider, event_id, failure_reason, created_at` (`024:4-11`) |
| Charge/refund ledger, charge-once per participant | `siton.platform_fee_money_events` | unique `charge` and unique `refund_adjustment` per `participant_id`; unique `(provider_code, provider_event_id)` (`019:43-53`) |
| Server-side authorization truth | `siton.payment_authorization_bindings` | `status` in `pending_provider_confirmation, authorized, consumed, expired, released, failed`; one consumed binding per participant; `provider_reference`, `amount_minor`, `expires_at` (`053:24-75`) |
| Canonical transitions | `siton.audit_log` | `entity_type, entity_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, correlation_id` (`014:148-160`, `035:7`) |
| Async money work | `siton.outbox_events` / `siton.outbox_dlq` | money-lane types `charge_deal, recovery_deal, refund_issue, cancel_refund, payment_reconcile, payment_release` (`src/worker_scheduler.ts:8`); DLQ is a moved copy, not a status (`src/outbox_worker_helpers.ts:194-228`) |
| Machine-opened cases | `siton.operational_cases` | `case_type='PaymentMismatch'`, `source='System'`, `opened_by='worker'`, `auto_key` (`034:12-50`, `src/app.ts:1651-1674`) |
| Worker liveness | `siton.worker_heartbeats` | `status` in `starting, ready, draining, stopped`; fresh = `heartbeat_at > now() - 30s` (`040:27-33`, `src/frontend_runtime.ts:7853-7857`) |

Admin read surfaces (all read-only): `GET /api/admin/payment-ops-status` (`src/frontend_runtime.ts:6205`: attempts by type/result, webhook counts, signature failures, fee ledger, last 40 attempts), `GET /api/admin/outbox-status` (`:7824`), `GET /api/admin/system-ops-status` (`:8172`), `GET /api/admin/deals/:id/ops-summary` (`:8438`: deal, participants, outbox, payment_attempts, audit), `GET /api/admin/participants/:id/ops` (`:8263`), `GET /api/admin/mission-control` (`:6666`; anomalies `payment_unknown_or_retry_storm`, `outbox_failure_backlog`, `webhook_processing_issue` at `src/admin_mission_control.ts:1727-1852`).

Caveat (OPEN): `GET /api/admin/mission-control/outbox/:eventId` filters on a column `event_id` that `siton.outbox_events`/`outbox_dlq` do not have (they have `event_uuid`), and the correlation trace reads `payment_attempts.provider_reference`, which does not exist; `safeQuery` swallows both errors and returns empty sections (`src/admin_mission_control.ts:91-110,2381-2384`). Use the SQL in `docs/OPERATIONAL_RUNBOOK.md:51-69` (by `event_uuid` / `aggregate_id`) instead of trusting an empty trace.

Direct SQL (read-only): `node scripts/run_pg_query.cjs "<select ...>" "[params]"` (`scripts/run_pg_query.cjs`). It uses `DATABASE_URL` from `.env` without any hosted-host refusal; never point a developer shell that also runs tests at the hosted URL (see the never-do list in `docs/DATABASE_INCIDENT_RUNBOOK.md`).

## 3. Scenario: suspected duplicate capture

STOP CONDITIONS: any of (a) two `platform_fee_money_events` rows with `logical_entry_type='charge'` for one `participant_id` (impossible while unique index `019:43-45` exists; if you see it the index is missing = schema drift), (b) two `payment_attempts` rows with `attempt_type IN ('charge_start','recovery')`, `result_class='success'` and different `correlation_id` for the same participant and deal, (c) a buyer statement showing two provider debits for one participant. On any of these: stop charging for the deal via `pause_charging_emergency` (second approval, `docs/ADMIN_INTERVENTION_RUNBOOK.md:18-21`) and escalate; keep money BLOCKED.

Evidence to collect (identifiers only):
1. `GET /api/admin/participants/:id/ops` for `buyer_state`, `money_state`, outbox events of the deal.
2. `SELECT attempt_id, attempt_type, result_class, correlation_id, created_at FROM siton.payment_attempts WHERE participant_id=$1 ORDER BY created_at`. One `success` row per capture is the invariant.
3. `SELECT provider, event_id, status, payload_jsonb->>'classification_reason' AS reason, received_at FROM siton.webhook_events WHERE participant_id=$1 ORDER BY received_at`. A second `charge_captured` must be `ignored` with reason `already_captured` (`src/payment_reconciliation.ts:100-103`); a duplicate `(provider, event_id)` is answered from the existing row without reprocessing (`src/webhook_ingestion.ts:25-64`).
4. `SELECT event_type, logical_entry_type, correlation_id, provider_event_id, created_at FROM siton.platform_fee_money_events WHERE participant_id=$1`.
5. `SELECT from_state, to_state, action_name, request_id, created_at FROM siton.audit_log WHERE entity_id=$1 AND state_type='money_state' ORDER BY created_at`. Exactly one `ChargeAttempt > ChargedSuccess` (or `> RecoveredCharge`).
6. Check whether the buyer holds two `participants` rows for the same deal (legitimate double join) before calling it a duplicate (`docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md:44`).

Do NOT retry manually: no re-capture, no manual refund of the "extra" charge, no webhook replay. IMPLEMENTED guards you rely on: per-participant charge-once ledger index, webhook identity dedupe, state-gated classification, `ON CONFLICT DO NOTHING` attempt insert. EXPECTED (unobserved live): provider-side idempotency on the `idempotency-key` / `correlation_id` headers (`src/payment_provider.ts:1667-1671`). OPEN: master carries no settlement-horizon / dispatch-lifecycle protection for real provider money (`config/real-money-release-policy.json` reason `FINANCIAL_BRANCH_NOT_INTEGRATED`); with a live provider, capture-in-flight vs reconcile races are a known unmerged remediation. This is one of the reasons the kill switch stays off.

## 4. Scenario: unknown capture result

Definition: a `payment_attempts` row with `result_class='unknown'` older than one worker cycle, or `mission_control.payments.unknown_count > 0` (`src/admin_mission_control.ts:2135-2136`).

How the system handles it (IMPLEMENTED): the capture worker finalizes the attempt as `unknown` and enqueues `payment_reconcile` (`src/app.ts:2200-2220`); it never re-fires the capture. The reconcile job runs in the MONEY lane (concurrency `WORKER_MONEY_CONCURRENCY`, default 1, `src/worker.ts:21`, `src/worker_scheduler.ts:8`), calls `paymentProvider.status(...)` and applies exactly one canonical event (`src/app.ts:1770-1912`). Ambiguity retries within outbox bounds; on the last attempt it opens `PaymentMismatch` case `payment-reconcile-unresolved:<participant>:<attempt_type>` and the event lands in `outbox_dlq` (`src/app.ts:1916-1927`).

STOP CONDITIONS: (a) an `operational_cases` row with `auto_key LIKE 'payment-reconcile-%'` (`unsupported`, `no-reference`, `amount-mismatch`, `release-captured`, `unresolved`), (b) an `outbox_dlq` row with `event_type='payment_reconcile'`, (c) an unknown older than 24 h (`docs/OPERATIONAL_RUNBOOKS.md:59`). Stop, open or escalate the case, make no buyer or seller statement.

Evidence: the attempt row (`correlation_id` is the provider idempotency key); the `payment_reconcile` outbox row(s) for `aggregate_id=<participant_id>` (`status`, `attempt_count`, `last_error`); any `reconcile:<correlation>:<event_type>` webhook rows (synthetic event ids written by the reconcile path, `src/app.ts:1801-1803`); the binding `provider_reference` (`payment_authorization_bindings.consumed_by_participant_id=<participant>`).

Do NOT: re-run capture, insert a webhook by hand, set `result_class` by hand, or requeue a DLQ'd `payment_reconcile` (there is no DLQ replay; see `docs/DATABASE_INCIDENT_RUNBOOK.md`). `trigger_reconcile` from Mission Control only opens a case and makes NO provider call (`src/admin_control_plane.ts:381-411`); it is a paper trail, not a fix. Note: the mock provider's `status()` always answers `final:true` (`src/payment_provider.ts:515`), so a genuinely stuck unknown on staging indicates a worker/outbox problem, not a provider one.

## 5. Scenario: stuck authorization

Definition: `money_state IN ('AuthHeld','AuthLocked')` (or `ChargeFailedRecovery`) on a deal whose `state IN ('Failed','Cancelled')`, or an `authorized` binding never consumed past its `expires_at`.

IMPLEMENTED: on `charging.finalize_failed` and on deadline failure every still-held participant gets a `payment_release` outbox event (`src/app.ts:1631-1649,2772-2777`); the release worker records a `release` attempt before I/O and transitions to `AuthReleased` only on provider `success` or a reconciled `released` status (`src/app.ts:1960-2080,1881-1890`); it never sets `AuthReleased` without proof. A provider without `release` opens case `payment-release-unsupported:<participant>` (`src/app.ts:1997-2004`); a provider refusal opens `payment-release-failed:<participant>` (`:2067-2078`).

STOP CONDITIONS: (a) any `payment-release-*` case, (b) `outbox_dlq.event_type='payment_release'`, (c) a `payment-reauthorization-*` case or a `payment_attempts` row with `attempt_type='reauthorize'` stuck `unknown` past the reconcile budget. NOT a stop condition (LONG_HORIZON_DEALS, migration 071): a hold older than the provider's authorization validity on a COMMITTED participant of a live deal — on long deals that is expected; the worker renews the authorization from the stored instrument at the charging boundary (`docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md` §4). `/api/admin/outbox-status.payment_maintenance.authorizations_past_declared_validity` counts such renewal candidates as a maintenance signal.

Evidence: `SELECT participant_id, money_state FROM siton.participants WHERE deal_id=$1 AND money_state IN ('AuthHeld','AuthLocked','ChargeFailedRecovery')`; `SELECT status, attempt_count, last_error FROM siton.outbox_events WHERE event_type='payment_release' AND aggregate_id=$1`; `payment_attempts` rows with `attempt_type='release'`; the binding row (`status` should end `released`, `src/payment_binding.ts:360`).

Do NOT: void at the provider console, set `AuthReleased`, mark the binding `released`. OPEN: there is no sweeper for unconsumed `authorized` / `pending_provider_confirmation` bindings; for an UNCONSUMED binding expiry is checked at join time only (`consumeBindingForJoinTx`, pre-commitment: the buyer re-authorizes and joins again), so such holds fall back to provider-side expiry. A CONSUMED binding past `expires_at` is never a failure: see LONG_HORIZON_DEALS above. OPEN: `pause_charging_emergency` is enforced only at `POST /deals/:id/charging/start` (`src/app.ts:5640-5646`), not inside the worker (`docs/ADMIN_INTERVENTION_RUNBOOK.md:85`); a `charge_deal` already in the outbox still runs after the flag is set.

## 6. Scenario: failed release

Same rail as section 5. Distinguish by `payment_attempts.result_class` for `attempt_type='release'`: `temporary_fail` = outbox retry with backoff (`src/app.ts:2034-2043`); `unknown` = `payment_reconcile` with `operation='release'` (`:2046-2062`); `permanent_fail` = case plus DLQ (`:2064-2079`). A release reconcile that finds the hold `captured` opens `payment-reconcile-release-captured:<participant>` and stops (`:1904-1911`). That is a money-moved-against-intent signal: STOP, escalate, keep the deal paused. Never "fix" it with a refund enqueue.

## 7. Scenario: failed refund

IMPLEMENTED: `refund_issue` is enqueued with the `CompletionWindow > Failed` transition (`src/app.ts:2760-2771`); `cancel_refund` with `deal.cancel` (`:5712`, Draft only). The handler refunds every `ChargedSuccess | RecoveredCharge` participant, records `refund` / `cancel_refund` attempts before I/O, and routes success through `refund_issued` webhook truth (`src/app.ts:1433-1580`). `temporary_fail` throws = outbox retry; `unknown` or success-without-event = `payment_reconcile` with `operation='refund'` (`:1558-1577`); `permanent_fail` = `PermanentFailError` = DLQ (`:1579`). A reconcile that finds the charge still `captured` and final re-arms `refund_issue` once and marks the attempt `permanent_fail` (`:1859-1878`).

STOP CONDITIONS: (a) `outbox_dlq.event_type IN ('refund_issue','cancel_refund')`, (b) a refund `unknown` unresolved > 24 h, (c) `platform_fee_money_events` shows `refund_adjustment` while `money_state` is not `Refunded` (or the reverse): ledger/state disagreement, escalate.

Evidence: deal `state` and `completion_window_until`; participants still `ChargedSuccess | RecoveredCharge`; `payment_attempts` refund rows; `webhook_events` `refund_issued` rows; `notification_events.event_type='refund_issued'` (buyer messaging, `src/app.ts:1217`).

Do NOT: refund from a provider console, requeue a DLQ'd refund, promise a refund date (`docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md:114`). Refund policy text is `docs/REFUND_POLICY.md`; it does not authorize manual money movement.

## 8. Scenario: provider outage

Symptoms: bursts of `payment_attempts.result_class='temporary_fail'`; `mission_control.payments.retry_storm_candidates > 5` (`src/admin_mission_control.ts:1837`); `outbox_events.attempt_count` climbing on money-lane types; `payment_webhook_security_events` unchanged (an outage is not a signature problem).

IMPLEMENTED behaviour: `temporary_fail` throws out of the handler; the worker re-schedules with deterministic exponential backoff capped at 15 min (`src/outbox_worker_helpers.ts:42-53`); after `max_attempts` (default 4: `src/migrations/045_operational_recovery.sql:8-9`, `OUTBOX_MAX_ATTEMPTS` in `src/runtime_config.ts:22`) the event is moved to `outbox_dlq` with reason `max_attempts_exhausted` (`src/outbox_worker_helpers.ts:560-570`). The 3-per-30-min DB cap (`050`) means a deal cannot burn more than three real capture attempts per participant per half hour whatever the retry policy says.

STOP CONDITIONS: (a) any money-lane event reaches DLQ during the outage: the deal is now partially charged and needs reconciliation before anything else, (b) `payment_reconcile` itself fails (`status()` unreachable, `error_code='provider_status_unreachable'`, `src/payment_provider.ts:917`), (c) webhooks arrive for attempts the DB never recorded.

Evidence: `SELECT event_type, status, count(*)::int, max(attempt_count)::int FROM siton.outbox_events GROUP BY 1,2` (`docs/OPERATIONAL_RUNBOOK.md:44`); the DLQ check (`:33`); `GET /api/admin/payment-ops-status` field `attempts_by_type`.

Do NOT: raise `OUTBOX_MAX_ATTEMPTS` mid-incident, requeue money events to "catch up", or start charging new deals. Use `pause_charging_emergency` (global or seller scope) for the duration and release it with a reason afterwards (`docs/ADMIN_INTERVENTION_RUNBOOK.md:59-70`), remembering the OPEN worker-side gap in section 5. On staging an "outage" is the mock's deterministic `temporary_fail` share (`src/payment_provider.ts:508`) and proves nothing about a real provider.

## 9. Scenario: reconciliation backlog

Definition: count of `outbox_events` with `status='pending' AND event_type='payment_reconcile'` growing, or `oldest_due_age_s` rising on `/api/admin/outbox-status` while `worker.running=true`.

Why it can grow: `payment_reconcile` shares the MONEY lane with `charge_deal` / `recovery_deal` / refunds at concurrency 1 by default (`src/worker.ts:21`, `src/worker_scheduler.ts:8`), so a large charge run starves reconciliation by design (serialization is the safety property). `WORKER_RECONCILE_CONCURRENCY` governs payout/invoice reconcile only, not payment reconcile (`src/worker_scheduler.ts:9`).

STOP CONDITIONS: (a) backlog older than 24 h, (b) `PaymentMismatch` cases opening faster than they are triaged, (c) backlog with `worker.running=false` (that is a worker incident, section 10).

Evidence: `SELECT count(*)::int, min(available_at) FROM siton.outbox_events WHERE event_type='payment_reconcile' AND status='pending'`; `SELECT count(*)::int FROM siton.payment_attempts WHERE result_class='unknown' AND created_at > now() - interval '7 days'` (the same query `trigger_reconcile` reports, `src/admin_control_plane.ts:385-389`); open `operational_cases WHERE case_type='PaymentMismatch' AND status IN ('Open','NeedsAdmin','WaitingExternal')`.

Do NOT: raise `WORKER_MONEY_CONCURRENCY` above 1 to drain faster (it removes serialization between capture and reconcile for the same participant, the double-money class documented in the financial review), run a second worker against the same DB "temporarily", or delete pending reconcile rows. Acceptable: wait; add worker capacity only through the reviewed deployment path.

## 10. Scenario: worker crash storm

Symptoms: `siton.worker_heartbeats` rows cycling through `starting` / `stopped`, `heartbeat_at` older than 30 s while `outbox_events` rows with `status='pending' AND available_at <= now()` grow; Render restarts; log lines `worker_start_failed` / `worker_cycle_failed` (`src/worker.ts:120,151`); `/api/admin/outbox-status` reports `worker.running=false`.

IMPLEMENTED safety: leases. A claimed event carries `worker_id, lease_generation, lease_expires_at` (`040:5-10`, `045:5-7`); a dead worker's rows are reclaimed after lease expiry (default 60 s, `WORKER_LEASE_MS` / `WORKER_STUCK_TIMEOUT_MS`, `docs/OUTBOX_WORKER_OPERATIONS.md:106-108`) back to `pending` with `attempt_count` preserved, or to DLQ at the cap (`src/outbox_worker_helpers.ts:413-480`). A money handler killed after the provider call but before `finalizeAttemptResult` leaves the attempt `unknown`; the next claim of the same event uses a NEW correlation (`capture:<event>:a<attempt_count>:<participant>`, `src/app.ts:2148`), so the stale attempt stays `unknown` unless a reconcile is scheduled for it. Treat every `unknown` older than one cycle after a crash storm as section 4.

STOP CONDITIONS: (a) any money-lane row reaches DLQ through `expired_lease_max_attempts` (`src/outbox_worker_helpers.ts:458-460`), (b) `worker_start_failed` preceded by `worker_waiting_for_migrated_database` (`src/worker.ts:101`): that is a schema/ledger problem, go to `docs/DATABASE_INCIDENT_RUNBOOK.md` section 2 (migration failure) before restarting again, (c) more than one fresh `ready` heartbeat when only one worker is approved (`render.yaml:65-80`).

Evidence: `SELECT worker_id, status, started_at, heartbeat_at FROM siton.worker_heartbeats ORDER BY heartbeat_at DESC`; the stuck-outbox query (`docs/OPERATIONAL_RUNBOOK.md:24`); `SELECT subject_id, action, reason_code, from_status, to_status, created_at FROM siton.operational_recovery_audit WHERE created_at > now() - interval '1 hour' ORDER BY audit_sequence DESC` (`045:122-138`).

Do NOT: bump `lease_generation` or clear `worker_id` by hand (the `outbox_processing_requires_fenced_lease` constraint and cutover triggers reject unfenced edits, `045:41-63,157-170`), delete `processing` rows, or start a local worker against the hosted DB. Stabilize the process first (memory, DB reachability), then apply the post-restart checklist in `docs/OUTBOX_WORKER_OPERATIONS.md:104-113`.

## 11. Escalation record (fill for every incident)

| Field | Value |
|---|---|
| `deal_id` / `participant_id` / `correlation_id` / `provider_reference` | |
| Money posture at incident start (`/health/integrations` provider + mode) | expected `mockpay` / `mock-backed` |
| `real_money_allowed` at incident start | expected `false` (BLOCKED) |
| Which STOP condition fired (section, letter) | |
| Cases opened (`operational_cases.case_id`, `auto_key`) | |
| Admin actions requested (`admin_actions.admin_action_id`, second approver) | |
| DLQ rows involved (`outbox_dlq.event_uuid`, `event_type`, `last_error`) | |
| What was NOT done (manual capture / refund / state edit / requeue) | must read "none" |

## 12. Open items (not implemented; do not improvise them)

- OPEN: DLQ replay / redrive for money events. `requeue_outbox_event` only touches `outbox_events` rows in `pending | failed` below the cap (`src/admin_control_plane.ts:203-215`); nothing reads `outbox_dlq` back.
- OPEN: worker-side `pause_charging_emergency` check (`docs/ADMIN_INTERVENTION_RUNBOOK.md:85`).
- OPEN: sweeper for unconsumed authorization bindings (section 5).
- OPEN: settlement horizon / dispatch lifecycle for real providers (`config/real-money-release-policy.json`, `FINANCIAL_BRANCH_NOT_INTEGRATED`).
- OPEN: Mission Control outbox / correlation trace column mismatch (section 2 caveat).
- OPEN: live-provider observation of any EXPECTED behaviour above; all proofs are mock or sandbox (`docs/R9B_GROW_SANDBOX_PROOF_RUNBOOK.md`).
