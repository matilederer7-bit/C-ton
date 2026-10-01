# Incident Response Runbook — Siton (C-ton)

Status: the single entry point for any production/staging incident. Written 2026-09-27 (Black-Sky branch, base `dd378dd`). Designed for **one operator**: the owner is detector, responder, approver and communicator. Where the control plane requires a second approver (`pause_charging_emergency`, `freeze_payouts`, `unfreeze_payouts`), that is a second named admin identity the owner must have provisioned in advance — see §3.

Legend: **IMPLEMENTED** (exists at the cited file), **EXPECTED** (platform behaviour), **OPEN** (no tooling; do not improvise), **OWNER ACTION** (hosted console or owner-held credential).

Companions: `docs/DISASTER_RECOVERY_RUNBOOK.md` (total loss), `docs/DATABASE_INCIDENT_RUNBOOK.md`, `docs/PAYMENT_INCIDENT_RUNBOOK.md`, `docs/PAYMENT_RECONCILIATION_RUNBOOK.md`, `docs/SECURITY_INCIDENT_RUNBOOK.md`, `docs/CREDENTIAL_COMPROMISE_RUNBOOK.md`, `docs/ROLLBACK_RUNBOOK.md`, `docs/ADMIN_INTERVENTION_RUNBOOK.md`, `docs/OUTBOX_WORKER_OPERATIONS.md`, `docs/BLACK_SKY_THREAT_MODEL.md`.

## 0. Never-do list (all incidents)

1. Never move money by hand: no manual capture, refund, void, payout, or `UPDATE` of `money_state` / `payout_status` (`docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md`). The DB rejects illegal transitions; a "legal-looking" edit still bypasses audit and idempotency.
2. Never delete evidence rows: `audit_log`, `operational_recovery_audit`, `outbox_dlq`, `webhook_events`, `payment_attempts`, `payment_webhook_security_events`, `seller_security_events`, `admin_actions`, `admin_control_flag_events`.
3. Never flip the real-money kill switch during an incident (`config/real-money-release-policy.json` stays `BLOCKED`; `npm run proof:no-real-money`).
4. Never raise `WORKER_MONEY_CONCURRENCY` above 1, run a second worker against one database, or raise retry budgets mid-incident to "drain faster".
5. Never paste a secret value, `DATABASE_URL`, `x-admin-key`, OTP, token, or raw provider payload into chat, tickets, commits or `PROJECT_STATUS.md`.
6. Never restore a hosted database in place, and never without the `docs/DISASTER_RECOVERY_RUNBOOK.md` freeze.
7. Never run test/preflight/rehearsal/cleanup scripts with a hosted `DATABASE_URL` in the shell.
8. Never "fix" a 429 storm by setting `RATE_LIMIT_MAX=0` or `TRUST_PROXY_HOPS` higher than the real proxy depth (that re-opens X-Forwarded-For spoofing; `docs/archive/RED_TEAM_FINAL_REPORT.md` A2).
9. Never declare an incident "resolved" or "no impact" in a postmortem without the verification command output that supports it.

## 1. Severity matrix

| Sev | Definition (any one) | Response time | Emergency control to consider |
|---|---|---|---|
| **S1** | money engine may be wrong (duplicate capture, provider/DB disagreement, invariant FAIL on hosted, `payment-release-*`/`payment-reconcile-*` case, payout `dispatch_outcome_unknown`); DB unreachable > 5 min; S1 credential exposed (`DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `postgres` password, Grow/Stripe live credential); unauthorised writes | immediately; owner stops other work | `pause_charging_emergency` (global), worker suspend, `pause_joining_emergency` (global) |
| **S2** | worker down or DLQ growing with money-lane types; `/readiness` flapping; S2 credential exposed (`ADMIN_API_KEY`, admin session, `SELLER_SESSION_SECRET`, `SITON_STORAGE_BROKER_KEY`); PII in hosted logs; Supabase Auth outage blocking seller/admin login | within 1 h | `pause_joining_emergency` (seller or deal scope), `freeze_payouts` |
| **S3** | single buyer token leak; 429 storm from one source; one seller's deal misbehaving; non-money DLQ entries (`notification_*`, `viral_recompute`); cold-start latency | same business day | none, or deal-scoped pause |
| **S4** | cosmetic/UX, documentation drift, non-blocking gate warnings | next working session | none |

Money impact on staging is expected to be zero (`PAYMENT_PROVIDER=mockpay`, `PAYOUT_PROVIDER=internal-ledger`, `render.yaml`); verify with `GET /health/integrations` before writing it down.

## 2. Roles for a single operator

| Role | Held by | What it means in practice |
|---|---|---|
| Incident lead | owner | decides severity, freezes, communicates, closes |
| First responder | owner | runs the first-15-minutes block (§4) verbatim |
| Second approver | a second **named** admin identity with `emergency.pause` / `payout.freeze` (SuperAdmin) — provisioned in advance with `scripts/create_admin_user.cjs` semantics; self-approval is blocked (`docs/ADMIN_INTERVENTION_RUNBOOK.md`) | without it, `pause_charging_emergency`, `freeze_payouts` and `unfreeze_payouts` cannot execute. OWNER ACTION: provision it before the pilot, keep its MFA device separate. |
| Scribe | owner (the incident note) | one text file per incident, identifiers only, never values |
| Engineering | coding agents on a task branch, after the incident is contained | never during containment against hosted resources |

## 3. Emergency controls that exist (IMPLEMENTED)

| Control | How | Effect | Limits |
|---|---|---|---|
| `pause_joining_emergency` | `POST /api/admin/actions` `{action_type, target_type: global|seller|deal, target_id, reason, idempotency_key, metadata:{expires_at}}` → `POST /api/admin/actions/:id/execute`. Needs `emergency.pause` + recent MFA (15 min). | `POST /deals/:id/join` → `423 joining_paused_by_admin`; existing buyers untouched; deal state unchanged | `expires_at` required (≤ 24 h); release with `POST /api/admin/control-flags/:flagId/release` |
| `pause_charging_emergency` | same, plus second approval (`/approve` by the other admin) | `POST /deals/:id/charging/start` → `423 charging_paused_by_admin` (checked inside the `charging.start` transaction for deal, seller and global scope, `src/app.ts:8516-8520`, `src/admin_intervention.ts:212-227`) — this is what enqueues `charge_deal`, so no new capture work starts | a `charge_deal` already in the outbox still runs: the worker does not re-check the flag (OPEN). To stop queued capture work, also suspend the worker |
| `freeze_payouts` / `unfreeze_payouts` | same, permission `payout.freeze`, second approval for payout/seller/deal scope | settlements gain blocker `payout_freeze_admin_flag_active` and stay `pending`; dispatch is held with `last_error=dispatch_held:payout_freeze_admin_flag_active` (`src/payout_rail.ts:368-394`, `:1240-1247`) | never reverses a paid batch |
| Worker stop | OWNER ACTION: Render → `siton-staging-worker` → Suspend (SIGTERM drains: `stopWorker`, `WORKER_SHUTDOWN_TIMEOUT_MS` 30 s, heartbeat `draining`→`stopped`) | every outbox-driven side effect stops; rows wait; leases expire and are reclaimed on resume | deadlines in the DB do not move; a long stop makes deals fail at their deadline when resumed |
| Web stop | OWNER ACTION: Render → `siton-staging-web` → Suspend | product offline (Render error page) | last resort |
| Deploy freeze | OWNER ACTION: Render autoDeploy off on both services, or push hot-fixes with `[skip render]` | prevents a merge from replacing a rollback | `docs/ROLLBACK_RUNBOOK.md` §2 |
| Session kill | hosted SQL as owner: `UPDATE siton.admin_sessions SET revoked_at=now() WHERE revoked_at IS NULL;` (same shape for `seller_sessions`, `buyer_sessions`) | forces re-login | no bulk-revoke route (OPEN) |
| Bootstrap key rotation | Render regenerate `ADMIN_API_KEY` (both services) | kills the `x-admin-key` read-only identity only | admin sessions are unaffected (`src/admin_identity.ts:118`) |
| Requeue one outbox row | `requeue_outbox_event` admin action | moves a `pending|failed`, unsent, below-cap row back to `pending` with a new generation | cannot touch `processing` rows or the DLQ |
| Paper trail | `open_support_case` (`SystemException` / `PaymentMismatch`), `trigger_reconcile` (opens/reuses a `PaymentMismatch` case; **no provider call**) | keeps the trace | not a fix |

## 4. First 15 minutes (every incident, in order)

```
T+0   open incident note: time (UTC), reporter, one-line symptom, suspected sev. No values.
T+1   posture:  curl -s https://<web>/health ; curl -s https://<web>/readiness ; curl -s https://<web>/health/integrations
        /health 200 + /readiness 503  → database/schema incident (DATABASE_INCIDENT_RUNBOOK §1a)
        /health non-200               → web process/Render incident (§6.5 deploy rollback or Render loss → DR)
        payment.provider != mockpay   → S1 money-posture incident; stop and escalate to PAYMENT_INCIDENT_RUNBOOK §1
T+3   control plane:  GET /api/admin/system-ops-status ; GET /api/admin/outbox-status ; GET /api/admin/payment-ops-status ; GET /api/admin/payout-status
        write down: worker.running, due_now, processing, stuck_candidates, dlq, unknown_count, retry_storm_candidates, open reconciliation cases
T+5   decide severity (§1) and whether a control from §3 is needed NOW. Apply it before investigating further if S1.
T+7   evidence snapshot (§5) — before any rotation, restart, or repair.
T+10  pick the playbook (§6) and follow its STOP CONDITIONS first.
T+15  first communication (§7) if buyers/sellers are affected or if a control was applied.
```

Ledger check whenever `/readiness` mentions migrations: `npm run migrations:doctor -- --database <url> --allow-hosted` (read-only; keep `.release-artifacts/migrations-doctor.json`).

## 5. Evidence preservation

Capture before changing anything; keep in the incident folder (not in Git).

| Evidence | Command / source | Notes |
|---|---|---|
| Control-plane JSON | the four `GET /api/admin/*` calls in §4, saved with timestamps | contains identifiers only |
| Ledger | `.release-artifacts/migrations-doctor.json` | |
| Money truth | `MONEY_INVARIANTS_DATABASE_URL=<hosted-url> npm run db:money-invariants -- --json > invariants-<ts>.json` | read-only; safe on hosted; prints host and db only |
| Queues | the SQL in `docs/DATABASE_INCIDENT_RUNBOOK.md` §12 (outbox by type/status, processing with leases, DLQ by type, heartbeats, triggers present) | |
| Security tables | `docs/SECURITY_INCIDENT_RUNBOOK.md` §3.3 (sessions, `seller_security_events`, `payment_webhook_security_events`, `infrastructure_change_audit`, `admin_actions`) | hosted SQL as owner, read-only |
| Payout cases | `SELECT case_id, case_type, case_status, payout_batch_id, deal_id, expected_payout_amount, observed_payout_amount, created_at FROM siton.seller_payout_reconciliation_cases WHERE case_status='open' ORDER BY created_at` | |
| Logs | OWNER ACTION: export Render logs for both services for the window; Sentry issues with fingerprint `worker_alert:<key>` / `worker_watchdog_fatal` | logs carry request ids, never env values (`docs/ENVIRONMENT_CONTRACT.md`) |
| Git | `git rev-parse origin/master`, running SHA from `GET /api/preview/meta`, `npm run scan:secrets` result | |

Rule: evidence in `siton.audit_log`, sessions and security tables is only useful if captured **before** rotation or restart.

## 6. Per-failure playbooks

### 6.1 Database down / unreachable

Trigger: `/readiness` 503 with `/health` 200; worker logs `worker_waiting_for_migrated_database` or repeated `worker_cycle_failed` then `worker_alert:consecutive_cycle_failures` (threshold `WORKER_ALERT_CYCLE_FAILURES` default 3) and possibly `worker_watchdog_fatal` (the worker exits 1 and Render restarts it — expected, not a second incident).

```
Is the Supabase project up (dashboard)?
├─ no / paused / deleted  → DISASTER_RECOVERY_RUNBOOK §2–§3
├─ yes, 53300/57P03 in logs → DATABASE_INCIDENT_RUNBOOK §4 (connection exhaustion); never pg_terminate_backend a runtime session mid-transaction
├─ yes, 55P03/57014/40P01   → DATABASE_INCIDENT_RUNBOOK §5 (locks)
└─ yes, "migrations are incomplete" / "schema drift" → DATABASE_INCIDENT_RUNBOOK §2/§7; if the ledger row is `running`: migrations:repair --clear-running (DISASTER_RECOVERY_RUNBOOK §7)
```

Owner-only: Supabase compute/pooler settings, project restore/unpause. Rollback: none (no data changed). Verification: `/readiness` 200 with `runtime_role`, one fresh `ready` heartbeat, `stuck_candidates=0` after one reclaim interval. Never: restore from backup to "fix" an outage that is only a connectivity problem.

### 6.2 Provider (Grow / payment) down or unknown outcomes

Trigger: burst of `payment_attempts.result_class='temporary_fail'`; `retry_storm_candidates > 5`; `result_class='unknown'` rows older than one worker cycle; `PaymentMismatch` cases with `auto_key LIKE 'payment-reconcile-%'`; on Grow, malformed or auth-routing replies are classified UNKNOWN by construction (`src/grow_payment_adapter.ts`, "unknown_then_status_lookup_then_manual_case_no_automatic_repeat").

```
Is the provider posture still mockpay/mock-backed (staging)?
├─ yes  → the "outage" is the mock's deterministic temporary_fail share; treat as a worker/outbox problem (6.3)
└─ no (sandbox/live Grow)
   ├─ temporary_fail only, attempt_count climbing → wait; lane retry policy is 30 s base, 15 min cap, 8 attempts (~45 min) before DLQ (src/runtime_config.ts OUTBOX_LANE_RETRY_DEFAULTS); pause_charging_emergency (global, second approval) if the outage exceeds ~30 min so new deals do not enter Charging
   ├─ unknown rows  → PAYMENT_RECONCILIATION_RUNBOOK §4 (reconcile rail; never re-fire capture)
   ├─ money-lane DLQ row → S1: PAYMENT_RECONCILIATION_RUNBOOK §6 (no replay exists)
   └─ payout batch stuck 'processing' with dispatch_outcome_unknown → PAYMENT_RECONCILIATION_RUNBOOK §5
```

Owner-only: provider status page / support ticket; provider dashboard lookups by `correlation_id`. Rollback: release the pause with a reason. Verification: `unknown_count=0` on `/api/admin/payment-ops-status`, `retry_storm_candidates=0`, no open `payment-reconcile-*` case. Never: manual capture/refund at the provider console, `OUTBOX_MAX_ATTEMPTS`/`OUTBOX_RETRY_MONEY_MAX_ATTEMPTS` changes mid-incident, requeue of a DLQ'd money event.

### 6.3 Worker stuck / DLQ growth

Trigger (pushed alerts, `src/worker_scheduler.ts:104-108`, log event `worker_alert`, Sentry fingerprint `worker_alert:<alert_key>`, one emission per key per `WORKER_ALERT_WINDOW_MS` default 5 min):

| `alert_key` | Meaning | First action |
|---|---|---|
| `dlq_increased` | DLQ count grew since the previous cycle | read the newest DLQ rows: `event_type`, `last_error` (DATABASE_INCIDENT_RUNBOOK §12); money types → S1 |
| `oldest_pending_stale` | a due job waited longer than `WORKER_ALERT_OLDEST_PENDING_MS` (default 10 min) | is the worker running? one worker only? money lane starved by a charge run (expected) or by a stuck job? |
| `stale_leases` | `processing` rows past `lease_expires_at` | wait one reclaim interval (`WORKER_RECLAIM_EVERY_POLLS` default 10 polls); persistent → the reclaim itself is failing |
| `consecutive_cycle_failures` | ≥ `WORKER_ALERT_CYCLE_FAILURES` (default 3) cycles failed; `error_code` in details | DB reachability (6.1) or a poisoned claim query |
| `event_deadline_exceeded` | a job ran past `WORKER_EVENT_TIMEOUT_MS` (default 120 s) and was abandoned to lease expiry | the `event_uuid`/`event_type` are in the alert details; a repeated money-lane type is S1 |
| `worker_watchdog_fatal` (`reason` = stall or heartbeat failures) | no cycle completed within `WORKER_WATCHDOG_STALL_MS` or `WORKER_WATCHDOG_MAX_HEARTBEAT_FAILURES` (5) heartbeats failed; process exits 1 | Render restarts it; if it loops, the cause is 6.1 |

Decision: `worker.running=false` → OWNER ACTION restart the Render worker (Restart, not redeploy), then `docs/OUTBOX_WORKER_OPERATIONS.md` post-restart checklist. `worker.running=true` and DLQ rising → suspend the worker, classify the DLQ rows, and do not resume until the poisoned type is understood (`docs/ROLLBACK_RUNBOOK.md` §3 if a deploy caused it). Two fresh `ready` heartbeats → stop the unapproved instance. Verification: `stuck_candidates=0`, `stale_leases=0`, `dlq` stable, one heartbeat. Never: edit `worker_id`/`lease_generation`/`lease_expires_at`, delete `processing` rows, start a local worker against the hosted DB.

### 6.4 DDoS / 429 storms

Trigger: many `429 rate_limit_exceeded` responses (`Retry-After` header) in Render logs; legitimate users report 429; `/readiness` slow.

Facts (IMPLEMENTED, `src/app.ts:5529-5620`): per-IP buckets — global 200/min (`RATE_LIMIT_MAX`), sensitive mutations 20/min (`RATE_LIMIT_SENSITIVE_MAX`), join 60/min (`RATE_LIMIT_JOIN_MAX`) — **payment authorization shares the join budget** (`JOIN_PATH_RE` matches `/deals/:id/join` and `/api/payments/authorize(-mock)`, `src/app.ts:5583`), analytics 60/min, read 120/min (`RATE_LIMIT_READ_MAX`); seller mutations additionally 90/min per **seller identity** (`RATE_LIMIT_SELLER_MUTATION_MAX`) and 150/min per IP (`RATE_LIMIT_SELLER_MUTATION_IP_MAX`) (Black-Sky C4, owner decision C). Join/analytics/seller budgets are floored at the sensitive budget. Seller login attempts are serialized per account by an advisory lock (Black-Sky availability/auth hardening, reported by the coordinator on a parallel branch; not present at base `dd378dd` — verify on the merged head), so parallel guesses cannot race the per-account lockout counter. Client IP = the address `TRUST_PROXY_HOPS` (default 1 = Render) hops in; a caller-prepended `X-Forwarded-For` is ignored. Per-account throttles (OTP destination, seller/admin login lockout) are IP-independent backstops. Store is in-memory per instance (`RATE_LIMIT_SCALE_MODE=single_instance_only`).

```
Who is being limited?
├─ one IP / small set hammering /deals/:id/join or /api/*  → let the limiter work; nothing to change. If the DB is under pressure (C-2 join lock): deal-scoped pause_joining_emergency
├─ many IPs (distributed)  → app-level limits protect the DB, not bandwidth. OWNER ACTION: Render/DNS-level protection (Render has no WAF on this plan — OPEN); pause_joining_emergency (global) if joins are the target
├─ legitimate office/NAT users hit the per-IP budget → raise RATE_LIMIT_SELLER_MUTATION_IP_MAX (not the identity budget) through the reviewed env path; never below RATE_LIMIT_SENSITIVE_MAX
└─ 429s on /readiness or /health → these are outside the sensitive/read buckets but still count against the global per-IP budget (200/min); a Render health check never reaches it. A 429 there from Render's own checker means a proxy in front, not the app
```

Verification: `curl -s https://<web>/readiness` shows `client_ip` equal to your egress IP (proxy depth right); rate of 429 in logs falls; `/api/admin/outbox-status` unaffected. Rollback: env change reverted through the same path. Never: `RATE_LIMIT_MAX=0`, `TRUST_PROXY_HOPS` above the real depth, disabling the per-identity seller budget.

### 6.5 Deploy rollback

Trigger: new `runtime_commit_sha` live and: 5xx, blank React page, DLQ rising, `/readiness` 503 with `database schema drift`/`migrations are incomplete`.

Follow `docs/ROLLBACK_RUNBOOK.md` §1 (decide the layer) → §2 (Render previous deploy) / §3 (worker) / §5 (bad migration; forward-only) / §6 (schema-code compatibility: a rollback target must be a SHA whose `REQUIRED_TABLES` are a subset of the database — since `df9aee3` the schema contract requires **every** manifest migration, so a database that is BEHIND makes `/readiness` fail closed and Render keeps the old build). Freeze autoDeploy during the rollback. Verification: `/readiness` 200, `runtime_commit_sha` = target, `payment.provider=mockpay`, one heartbeat, `dlq` unchanged. Never: `git revert` on `master` while the hosted rollback is in flight; restore a backup to remove a migration.

### 6.5a Deploy that needs a migration first (077 and later)

Since `df9aee3` the runtime schema contract requires **every** manifest migration (`src/schema_contract.ts`). Migration `077_black_sky_money_integrity.sql` (payout forward-only status triggers, monotonic settlement amounts, amount CHECKs, and the `ClosedForJoining → Failed` deal edge) must be **applied to staging before the code that contains it deploys**; otherwise `/readiness` fails closed (`database migrations are incomplete`), Render keeps the old build and the worker waits then exits. Order: OWNER ACTION apply `077` through the migration channel with a DDL identity (`DATABASE_URL=<owner-url> npm run db:migrate`, advisory-locked) → `npm run migrations:doctor -- --database <url> --allow-hosted` → `HEALTHY` → merge/deploy. If the code deployed first: do not roll the schema back; apply 077 and the pending deploy goes live on its next readiness check.

### 6.6 Supabase Auth outage (JWKS)

Facts (IMPLEMENTED, `src/supabase_auth.ts:184-215`): the web process caches the project JWKS for 10 min; on a refresh failure it keeps serving the cached set unless a forced refresh (unknown `kid`) was requested; with no cache (fresh process after a deploy/restart) verification fails closed with `jwks_unavailable` / `jwks_fetch_failed` — no token is ever accepted unverified. Supabase Auth issues the tokens themselves, so **new** seller/admin logins through Supabase fail during the outage regardless of the cache.

Impact table:

| Flow | During outage |
|---|---|
| Seller / admin login via Supabase Auth | fails (login itself is Supabase-side) |
| Already-issued Supabase access tokens | verify from cache for up to 10 min after the last refresh in a warm process; then fail closed |
| Seller cookie sessions (`seller_sessions`, `SELLER_SESSION_SECRET`) and admin cookie login + MFA | unaffected (DB-backed) |
| Buyer join (OTP), tracking links, webhooks, worker | unaffected |

Actions: do **not** restart or redeploy the web service (a cold process has no cache); do not change `SUPABASE_URL` or `SUPABASE_JWT_AUD`; communicate to sellers that login is temporarily unavailable; check `GET /api/preview/auth-config` returns `configured:true` once Supabase recovers. Owner-only: Supabase status page / support. Verification: a fresh seller login succeeds; no `jwks_*` errors in web logs. Never: disable JWT verification, accept the anon key as identity, or hand out `x-admin-key` as a login workaround.

### 6.7 Credential compromise

`docs/CREDENTIAL_COMPROMISE_RUNBOOK.md` — containment first (session kill, key regeneration), evidence (§5 here), then rotation (owner action), then verification. Freeze deploys during rotation.

### 6.8 Total loss

`docs/DISASTER_RECOVERY_RUNBOOK.md`.

## 7. Communication

| Audience | When | Channel | What (never values, never promises of manual money movement) |
|---|---|---|---|
| Sellers | a control affects their deal, or login is down > 30 min | WhatsApp/phone (pilot), seller dashboard notice when available | what is paused, since when, expected next update time |
| Buyers | a tracking page is wrong or a deal was paused with joins | via the seller for pilot deals; tracking page states update automatically | "nothing was charged" only after `GET /health/integrations` confirms `mockpay` |
| Providers (Grow / Stripe / Supabase / Render support) | S1 credential exposure involving their credential, or their outage | their support channel (OWNER ACTION) | the fact, the window, the correlation ids they need |
| Postmortem readers (future you, agents) | at close | incident note + one-line pointer in `PROJECT_STATUS.md` | §8 template |

Update cadence during S1/S2: every 60 min in the incident note, even if "no change".

## 8. Close-out and postmortem template

Record: timeline (detect / contain / evidence / repair / verify / release), severity and why, controls applied and released (flag ids), commands run with their PASS/FAIL markers (`MIGRATIONS_DOCTOR verdict=`, `MONEY_INVARIANTS_PASS|FAIL`, `DB_BACKUP_RESTORE_REHEARSAL_PASS`, `NO_REAL_MONEY_PROOF_PASS`), OWNER ACTIONS performed (what, when, by which console), evidence file names, blast radius (tables, subjects, money impact = expected 0 on staging, verified by …), notification assessment (`docs/SECURITY_INCIDENT_RUNBOOK.md` §11a), detector/gate change made, and the OPEN items touched. Then re-run `npm run release:owner-check -- --reuse` on the live SHA and file the report path.

## 9. Open items this runbook depends on

- OPEN: single operator — every second-approval control needs a pre-provisioned second admin identity (owner action).
- OPEN: no bulk session revocation route; no admin tracking-token revoke surface; no DLQ replay; no per-route kill switch (`docs/SECURITY_INCIDENT_RUNBOOK.md` §13).
- OPEN: alerts are pushed to logs and Sentry only; no pager/SMS routing exists (owner decides where Sentry notifies).
- OPEN: `pause_charging_emergency` is enforced at `charging.start` only (deal/seller/global scope); the worker does not re-check it before a queued `charge_deal`. Pair it with a worker suspend when queued capture work must stop.
- OPEN: network-level DDoS protection (no WAF/CDN in front of Render on the current plan).
