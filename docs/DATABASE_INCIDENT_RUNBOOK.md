# Database Incident Runbook

Status: operator runbook for PostgreSQL / migration / worker-queue incidents on Siton (C-ton). Written 2026-09-14 against branch `claude/release-readiness-night`. It changes no runtime code and no migration file. Companion documents: `docs/MIGRATION_SAFETY_SYSTEM.md` (tool reference), `docs/DB_BACKUP_RESTORE_REHEARSAL.md`, `docs/OUTBOX_WORKER_OPERATIONS.md`, `docs/OPERATIONAL_RUNBOOK.md` (ready-made SQL), `docs/HEALTH_CHECK_CONTRACT.md`, `docs/INFRASTRUCTURE_HEALTH_AND_CAPACITY.md`. Money-related consequences of any database incident are handled in `docs/PAYMENT_INCIDENT_RUNBOOK.md`.

Legend: **IMPLEMENTED** = exists at the cited line. **EXPECTED** = designed behaviour not yet observed on the hosted database. **OPEN** = no tooling exists; do not improvise.

## 0. Never-do list

1. Never edit a migration file that has been applied anywhere. The runner hashes the LF-normalised body and refuses a changed file with `migration checksum mismatch` (`scripts/run_migrations.cjs:82-85`); the doctor classifies it `real_content_mismatch` and returns `BLOCKED` (`scripts/migrations_doctor.cjs:88-95`). Fix forward with a new numbered file; `063`/`064` are reserved (`scripts/migration_manifest.cjs:62-66`).
2. Never `DELETE FROM siton.migration_ledger` by hand. The only sanctioned deletion is `npm run migrations:repair -- --clear-failed <id> --i-verified-no-partial-effects --yes`, which deletes exactly one row and only if its `status='failed'` (`scripts/migrations_repair.cjs:61-72`).
3. Never `UPDATE siton.migration_ledger SET checksum_sha256=...` by hand. Use `--fix-eol-checksums`, which only rewrites rows whose stored digest equals the CRLF variant of the identical file (`scripts/migrations_repair.cjs:39-58`).
4. Never run `npm test`, `npm run test:*`, `scripts/run_test_group.cjs`, `migrations:preflight`, `db:backup-restore-rehearsal` or `qa:cleanup-stale-dbs` with a hosted `DATABASE_URL`. The test runner connects to `<server>/postgres` and runs `CREATE DATABASE ... TEMPLATE ...` and `DROP DATABASE ... WITH (FORCE)` there; since this branch it refuses any non-local host through the same `assertLocalBase` check as the isolation library (`scripts/run_test_group.cjs`, `scripts/lib/test_db_isolation.cjs`; the override `SITON_TEST_DB_ALLOWED_HOSTS` is for CI service hosts only). `migrations:preflight`, `db:backup-restore-rehearsal` and `qa:cleanup-stale-dbs` refuse non-local hosts the same way; `db:migrate` and `run_pg_query.cjs` do NOT and act on whatever `DATABASE_URL` names.
5. Never run two test runners at once against one local server; both create template databases named by pid and time and one will drop the other's isolated databases during cleanup (`scripts/run_test_group.cjs:82-84,124-130`).
6. Never edit `siton.outbox_events` ownership columns (`worker_id`, `lease_generation`, `lease_expires_at`, `claimed_at`) or delete `processing` rows. The `outbox_processing_requires_fenced_lease` constraint and the cutover triggers reject it (`src/migrations/045_operational_recovery.sql:41-63,157-170`); the sanctioned paths are worker reclaim, the `requeue_outbox_event` admin action and the Stage 32B repair CLI (sections 6 and 9).
7. Never delete `outbox_dlq`, `audit_log`, `operational_recovery_audit`, `webhook_events` or `payment_attempts` rows (`docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md:8`). `audit_log` and `operational_recovery_audit` are append-only by trigger (`src/schema_contract.ts:82-86`).
8. Never restore a hosted database without a documented decision (`docs/OPERATIONAL_RUNBOOKS.md:269`), and never restore over a database that still has a running worker.
9. Never connect application runtimes as `postgres`, `supabase_admin` or `service_role`; `/readiness` refuses it (`src/runtime_database_boundary.ts:36-38`). Migrations need a DDL-capable identity, never the `siton_web_login` / `siton_worker_login` runtime logins (`render.yaml:7-13`).
10. Never paste `DATABASE_URL`, `x-admin-key` or dumps containing data into tickets.

## 1. Tool reference (exact commands)

| Command | Script | Writes? | Hosted? |
|---|---|---|---|
| `npm run migrations:doctor` (`-- --database <url>`) | `scripts/migrations_doctor.cjs` | no (SELECT only) | refused without `--allow-hosted` (`:44-48`) |
| `npm run migrations:repair -- --fix-eol-checksums [--yes]` | `scripts/migrations_repair.cjs:39-58` | ledger checksums only, in one transaction, after printing every row; dry run without `--yes` | refused without `--allow-hosted` (`:32`) |
| `npm run migrations:repair -- --clear-failed <id> --i-verified-no-partial-effects [--yes]` | `scripts/migrations_repair.cjs:61-72` | deletes ONE `failed` ledger row | same |
| `npm run migrations:preflight` (`--base <ref>`, `--skip-db`) | `scripts/migration_preflight.cjs:1-27` | only disposable local databases | never |
| `npm run db:migrate` | `scripts/run_migrations.cjs` | applies the manifest, forward-only, refuses a dirty ledger (`:53-58`) | yes, no guard: run it deliberately |
| `npm run db:backup-restore-rehearsal` | `scripts/db_backup_restore_rehearsal.cjs:1-20` | local disposable databases only; needs `pg_dump`/`pg_restore` (`PG_BIN`) or reports `SKIPPED_ENVIRONMENT` | never |
| `npm run qa:diagnose` | `scripts/qa_process_guard.cjs:1-13` | no; lists occupied test ports, stray runner processes (never killed), leaked test-database connections, stale isolated databases | reads `DATABASE_URL`; use only with a local URL |
| `npm run qa:cleanup-stale-dbs -- --yes [--older-than-minutes N]` | `scripts/qa_process_guard.cjs:24-35` | drops isolated databases whose owning pid is dead | local only (isolation library refusal) |
| `npm run db:inspect` | `scripts/inspect_db.cjs` | no; schemas, tables, columns, indexes, constraints, functions | reads `DATABASE_URL` |
| `node scripts/run_pg_query.cjs "<sql>" "[params]"` | `scripts/run_pg_query.cjs` | whatever the SQL does; use SELECT only | reads `DATABASE_URL`, no guard |
| `npm run ops:repair -- --mode inspect|dry-run|apply --input <file>` | `src/operational_repair_cli.ts:56-72` | `apply` only with plan hash, `--confirm-apply STAGE32B_APPLY`, `--actor-id` and a reviewed repository adapter (`:116-134`) | no live adapter is checked in (OPEN, `docs/STAGE32B_OPERATIONAL_RECOVERY.md:129-135`) |

Doctor verdicts (`scripts/migrations_doctor.cjs:91-96`): `EMPTY_DATABASE` (no ledger table), `BEHIND` (repository has migrations the DB lacks), `HEALTHY`, `HEALTHY_WITH_EOL_VARIANTS` (line-ending-only checksum differences, accepted by the runner), `BLOCKED` (real content mismatch, filename/position mismatch, dirty `running`/`failed` rows, extra rows, duplicate positions, ordering anomalies or static manifest FAIL). Exit 1 only on `BLOCKED`. Artifact: `.release-artifacts/migrations-doctor.json` (`:115-119`).

Ledger table (`scripts/run_migrations.cjs:32-45`): `siton.migration_ledger(migration_id PK, position UNIQUE, filename UNIQUE, checksum_sha256, started_at, completed_at, status IN ('running','succeeded','failed'), error_message)`.

## 1a. First ten minutes (any database incident)

1. Identify WHICH database: local isolated (`siton_<purpose>_<agent>_<pid>_<time>_<rand>`, `scripts/lib/test_db_isolation.cjs:19`), local shared dev, or hosted Supabase staging (host not in `LOCAL_HOSTS`). Every command below behaves differently per target; the hosted target needs `--allow-hosted` for doctor/repair and is refused by everything else.
2. `curl -s <host>/health` then `curl -s <host>/readiness`: liveness vs DB+schema (`docs/HEALTH_CHECK_CONTRACT.md`). A 503 `not_ready` with a 200 `/health` is a database or schema incident, not an app crash.
3. `GET /api/admin/system-ops-status` (`src/frontend_runtime.ts:8172`): `outbox.pending/processing/dlq`, `notifications`, `invoice_documents`, `payout_batches` in one call; then `GET /api/admin/outbox-status` for lease detail and heartbeats.
4. `npm run migrations:doctor -- --database <url> [--allow-hosted]`; keep the verdict line and `.release-artifacts/migrations-doctor.json`.
5. Match the verdict and symptoms to a section using the index below; apply that section's STOP CONDITIONS first.
6. Before any write (migrate, repair, restore, requeue): stop the worker if money-lane work is in flight, and confirm that the shell's `DATABASE_URL` (`node -e "console.log(new URL(process.env.DATABASE_URL).host)"`) names the database you intend.

Symptom index:

| Observation | Section |
|---|---|
| `MIGRATIONS_FAILED`, ledger row `failed` or `running`, `/readiness` says `migrations are incomplete` | 2 |
| `migration checksum mismatch`, doctor `BLOCKED` on checksum / filename / position / extra | 3 |
| `53300`, `57P03`, connect timeouts, connection percent above threshold | 4 |
| `55P03`, `57014`, `40P01`, slow `/readiness`, blocked pids | 5 |
| `due_now` growing, `stuck_candidates > 0`, `dlq > 0`, no fresh heartbeat | 6 |
| `/readiness` says `database schema drift`, `42501` on one table | 7 |
| after a restore: doctor not `HEALTHY`, queues inconsistent | 8 |
| a repair or manual step was interrupted | 9 |

Hosted vs local capability matrix:

| Capability | Local (`localhost`, `127.0.0.1`, `postgres`, `db`) | Hosted Supabase staging |
|---|---|---|
| `migrations:doctor` | yes | `--allow-hosted`, read-only |
| `migrations:repair` | yes (`--yes` to apply) | `--allow-hosted --yes`; never run on this branch (`docs/MIGRATION_SAFETY_SYSTEM.md:63`) |
| `db:migrate` | yes | yes, operator action with a DDL identity; hosted boot commands do not migrate (`Dockerfile:43`, `render.yaml:78`) |
| `migrations:preflight`, `db:backup-restore-rehearsal`, `test:*`, `qa:cleanup-stale-dbs` | yes | refused by the isolation library, or (test runner) NOT refused and destructive: forbidden |
| `pg_stat_activity` / `pg_locks` reads | yes | needs a privileged console identity; runtime logins are least-privilege |
| backups | `pg_dump` / `pg_restore` rehearsal | Supabase PITR / daily backup, platform console only (EXPECTED, not rehearsed) |
| grants / RLS | applied by migrations locally | `supabase/staging/*.sql` applied by the owner; outside the ledger |

## 2. Migration failure

Symptoms: `MIGRATIONS_FAILED migration failed: <id> <file>: <error>` from `db:migrate` (`scripts/run_migrations.cjs:120,132`); web `/readiness` returns `503 {"ok":false,"code":"not_ready"}` because `assertDatabaseSchema` finds `database migrations are incomplete at <id>` (`src/schema_contract.ts:66-67`); worker logs `worker_waiting_for_migrated_database` up to 30 times then `worker_start_failed` (`src/worker.ts:94-105,151`).

What the runner guarantees (IMPLEMENTED): the ledger row is inserted as `running` before the SQL, the whole file is sent as ONE `client.query(sql)` (`:96-103`), so a mid-file failure is atomic: files with an explicit `BEGIN;/COMMIT;` and files without (23 of 59, executed as one implicit transaction) both leave no partial objects, proven by the two "failing migration is atomic" preflight scenarios (`docs/MIGRATION_SAFETY_SYSTEM.md:41-42`). On failure the row becomes `failed` with `error_message` (`:112-121`) and every later run refuses (`:53-58`).

STOP CONDITIONS: (a) the ledger row is `running`, not `failed` (process killed mid-migration): there is NO repair action for `running`, `--clear-failed` refuses it (`scripts/migrations_repair.cjs:66`). Escalate; resolution is a reviewed manual decision, not a script (OPEN). (b) The failing file is one that already succeeded elsewhere with a different checksum (that is section 3, not a retry). (c) The error is a privilege error (`42501`) on the hosted database: wrong identity or a missing grant from `supabase/staging/*.sql`; do not retry with a superuser.

Steps:
1. `npm run migrations:doctor -- --database <url> [--allow-hosted]`. Expect `BLOCKED` with `dirty rows: <id>:failed`.
2. Read `error_message`: `SELECT migration_id, status, error_message, started_at FROM siton.migration_ledger WHERE status <> 'succeeded'`.
3. Reproduce locally: `npm run migrations:preflight` (fresh install + upgrade-from-`origin/master` + partial-ledger scenarios, `scripts/migration_preflight.cjs:13-24`). If it fails locally the file is wrong: fix forward with a NEW file; never edit the failed one after it has been applied anywhere. If it passes locally, the difference is hosted state (data, grants, extensions).
4. Verify no partial effects before clearing. Inspect the objects the file creates (`grep -n "CREATE\|ALTER\|DROP" src/migrations/<file>`) against `npm run db:inspect` output; every object must be absent or in its pre-migration shape. Only then run `npm run migrations:repair -- --clear-failed <id> --i-verified-no-partial-effects` (dry run), then add `--yes` (`scripts/migrations_repair.cjs:67-70`). The flag is your signed statement; the script does not check objects for you (`:14-19`).
5. Re-run `npm run db:migrate`; then `migrations:doctor` must report `HEALTHY` or `HEALTHY_WITH_EOL_VARIANTS`; then `/readiness` 200 and a fresh worker heartbeat (`siton.worker_heartbeats.status='ready'`).

## 3. Migration ledger mismatch (real vs line-ending-only)

Two different incidents share one symptom (`migration checksum mismatch: <id> <file>`, `scripts/run_migrations.cjs:83-84`). The doctor separates them (`scripts/lib/migration_tools.cjs:209-215`):

| Classification | Meaning | Action |
|---|---|---|
| `line_ending_only_mismatch` | stored digest = CRLF variant of the identical file (ledger written from a Windows checkout before normalisation) | harmless: the runner accepts it and logs `MIGRATION_LEDGER_EOL_VARIANT` (`:86-91`). Normalise explicitly: `npm run migrations:repair -- --fix-eol-checksums` then `--yes` (`--allow-hosted` on Supabase). `.gitattributes` pins `src/migrations/*.sql text eol=lf` |
| `real_content_mismatch` | the file content differs from what was applied | BLOCKING. STOP. Find who changed the file (`git log -p -- src/migrations/<file>`); the applied database is the truth. Restore the file to the applied content in git (a new commit), and carry the intended change as a new migration. Never rewrite the checksum |
| `filename_mismatch` / `position_mismatch` | manifest order or names changed after application | BLOCKING; same treatment: the ledger is truth, fix the manifest, never the ledger. Known, accepted anomalies (`014` first, `014a`, `015a/b`, `065`) are listed in `scripts/lib/migration_tools.cjs:12-18` |
| `extra_in_database` | a ledger row the repository does not know | BLOCKING; usually a branch applied to the wrong database (e.g. the financial branch's `067`/`068` on a master database). Do not delete; align the deploy branch |

STOP CONDITIONS: any `real_content_mismatch`, `extra_in_database`, duplicate position or ordering anomaly on the hosted database. Do not deploy, do not migrate, escalate with the doctor JSON attached.

## 4. Connection exhaustion

Symptoms: `[db.client.error] {"code":"53300"}` (too_many_connections) or `57P03` (cannot_connect_now) in web/worker logs (safe-code list `src/db.ts:65-67`); `connect ETIMEDOUT`; `/readiness` 503 while `/health` stays 200 (`docs/HEALTH_CHECK_CONTRACT.md`); Admin System Status `database_connection_percent` above the `70/85% for 10m` thresholds (`src/infrastructure_metrics.ts:166-167,199-201`, `docs/INFRASTRUCTURE_HEALTH_AND_CAPACITY.md:33`).

Facts (IMPLEMENTED): each process holds one `pg` pool with default max 10, `connectionTimeoutMillis 10s`, `idleTimeoutMillis 30s`, `statement_timeout 30s`, `query_timeout 30s`, `application_name='siton-web-runtime' | 'siton-worker-runtime'` (`src/db.ts:8-17,38-40`); the worker adds a control pool of 2 (`src/worker.ts:29`). Hosted connections go through the Supavisor session-mode pooler (`render.yaml:12,68`), so a leaked session holds a pooler slot.

Steps (read-only console, `pg_stat_activity` needs a privileged identity):
1. `SELECT application_name, state, count(*) FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2 ORDER BY 3 DESC`. Expected names: `siton-web-runtime`, `siton-worker-runtime`; anything else is a human or a stray tool.
2. `SELECT pid, application_name, state, now()-state_change AS idle_for, left(query,80) FROM pg_stat_activity WHERE state='idle in transaction' ORDER BY idle_for DESC`. Idle-in-transaction sessions are the usual leak.
3. Locally: `npm run qa:diagnose` lists leaked test-database connections and stray runner processes (`scripts/qa_process_guard.cjs:39-45`); it never kills anything.
4. Confirm no second web/worker instance is running (`siton.worker_heartbeats`, Render dashboard). Only one worker is approved (`render.yaml:65-80`).

STOP CONDITIONS: (a) the leak comes from `siton-worker-runtime` while money-lane events are `processing` (check `/api/admin/outbox-status`): do not kill sessions, let leases expire (section 6); (b) `max_connections` is hit by non-Siton identities: hosted platform issue, open a platform ticket.

Do NOT: `pg_terminate_backend` a runtime session that is mid-transaction (the process survives, `src/db.ts:42-53`, but the transaction is lost and any provider call already made becomes an `unknown` attempt); raise pool sizes without a capacity decision (`docs/INFRASTRUCTURE_HEALTH_AND_CAPACITY.md:37`).

## 5. Lock contention

Where Siton takes locks (IMPLEMENTED): row locks `FOR UPDATE` on `deals`/`participants` for every serialized transition (`src/app.ts:672-680`); `SET LOCAL lock_timeout='20s'` plus `pg_advisory_xact_lock` on join (`src/app.ts:4859-4860`) and on one more request path (`:3801-3803`); deal-image and deal-delete advisory locks (`:4239,4512`); outbox claim `FOR UPDATE SKIP LOCKED` (`src/outbox_worker_helpers.ts:343`); reclaim `FOR UPDATE SKIP LOCKED LIMIT 500` (`:425-427`); the charge-cap trigger `pg_advisory_xact_lock` per (participant, deal) (`src/migrations/050_charge_attempt_rate_limit.sql:57-62`); DDL advisory locks inside migrations `035`/`036` (`035:5`). `statement_timeout` is 30 s for every runtime session (`src/db.ts:14`).

Symptoms: `lock_timeout` (`55P03`) or `canceling statement due to statement timeout` (`57014`) in logs; deadlock `40P01` (BASE-only publish-vs-reopen deadlock was removed; a new one is a regression); `/readiness` slow but 200; outbox `oldest_due_age_s` rising with `worker.running=true`.

Steps:
1. `SELECT pid, application_name, wait_event_type, wait_event, now()-xact_start AS xact_age, left(query,80) FROM pg_stat_activity WHERE wait_event_type='Lock' OR now()-xact_start > interval '30 seconds' ORDER BY xact_age DESC`.
2. `SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid, blocking.application_name, left(blocking.query,80) FROM pg_stat_activity blocked JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))`.
3. If the blocker is a migration (`db:migrate` session) let it finish; if it is a human console session, ask the owner to end it.
4. If the blocker is `siton-worker-runtime` on a money-lane event, wait for `statement_timeout`; the worker's failure path records the attempt and retries with backoff.

STOP CONDITIONS: a blocker holding `deals`/`participants` row locks for longer than `statement_timeout` from an unknown `application_name`: treat as unauthorized write access (security escalation) before touching it.

Do NOT: `pg_cancel_backend`/`pg_terminate_backend` runtime sessions while a charge is in flight; disable the charge-cap trigger to "unblock" charging.

## 6. Worker backlog (outbox pending / processing, stale leases, DLQ)

Read first: `GET /api/admin/outbox-status` (`src/frontend_runtime.ts:7824-7880`): `pending`, `scheduled_future` (future `available_at`, e.g. `deadline_check`, not a backlog), `due_now`, `processing`, `dlq`, `oldest_due_age_s`, `oldest_processing_age_s`, `stuck_candidates` (`processing` with expired or missing lease, `:7841-7846`), `worker.running` (a `ready` heartbeat within 30 s). Direct SQL is in `docs/OPERATIONAL_RUNBOOK.md:17-48`.

Model (IMPLEMENTED): `status IN ('pending','processing','sent','failed')` (`014:182`); a claim sets `worker_id`, `lease_generation+1`, `lease_expires_at` (`040:5-10`, `045:5-7`); every completion/retry/failure requires the exact lease (`docs/OUTBOX_WORKER_OPERATIONS.md:10-17`); the worker reclaims expired complete leases every `WORKER_RECLAIM_EVERY_POLLS` polls back to `pending` or, at the attempt cap, into `outbox_dlq` (`src/outbox_worker_helpers.ts:413-480`); DLQ = copy into `outbox_dlq` plus delete from `outbox_events` in one transaction (`:194-228`), so `outbox_events.status='failed'` is rare and transient. Retry delay: exponential from `OUTBOX_POLL_MS`, capped 15 min (`:42-53`). Cap: `max_attempts` default 4 (`045:8-9`).

Triage table:

| Observation | Meaning | Action |
|---|---|---|
| `due_now > 0`, `worker.running=false` | no consumer | fix the worker (`docs/PAYMENT_INCIDENT_RUNBOOK.md` section 10, `docs/OUTBOX_WORKER_OPERATIONS.md:104-113`); nothing in the DB needs touching |
| `stuck_candidates > 0`, `worker.running=true` | leases expired but not yet reclaimed | wait one reclaim interval; verify via `operational_recovery_audit` rows `action='reclaim'` (`045:122-138`) |
| `processing` rows with `lease_generation=0` | legacy quarantined rows | NOT auto-reclaimed (`docs/OUTBOX_WORKER_OPERATIONS.md:44-50`); only `deadline_check` may be repaired through `ops:repair` (`src/operational_repair.ts:795-805`); money event types are `blocked` with `lease_event_type_requires_quarantine` |
| `dlq > 0` | terminal failures archived | read `event_type`, `last_error`, `attempt_count` (`docs/OPERATIONAL_RUNBOOK.md:33`); money types go to the payment runbook; keep the rows |
| `pending` rows at the cap | swept to DLQ before claim (`src/outbox_worker_helpers.ts:274-306`) | none |
| more than one fresh `ready` heartbeat | two workers | stop the unapproved one; leases keep them from double-processing but throughput assumptions break |

Requeue (IMPLEMENTED, bounded): `POST /api/admin/actions` with `action_type=requeue_outbox_event`, then `execute`; it only moves an `outbox_events` row in `pending|failed`, unsent, below the cap, back to `pending` with a new generation and a `retry` audit row (`src/admin_control_plane.ts:203-246`). It cannot take a row from a live worker and it cannot see `outbox_dlq`.

OPEN: DLQ replay/redrive does not exist; no code reads `outbox_dlq` back into `outbox_events`. OPEN: `GET /api/admin/mission-control/outbox/:eventId` queries a non-existent `event_id` column and always returns `event:null` (`src/admin_mission_control.ts:2381-2384`); query by `event_uuid` instead.

STOP CONDITIONS: a money-lane type (`charge_deal, recovery_deal, refund_issue, cancel_refund, payment_reconcile, payment_release`) in DLQ or stuck at generation 0: switch to `docs/PAYMENT_INCIDENT_RUNBOOK.md`.

## 7. Schema drift

Detection layers (IMPLEMENTED):
1. `/readiness` runs `assertDatabaseSchema`: ledger complete for `REQUIRED_MIGRATION_IDS` (`src/schema_contract.ts:39-43,66-70`), `REQUIRED_TABLES` present (`:22-37,72-77`), required triggers present (`:79-102`), `webhook_events_status_check` includes `processing` and `outbox_processing_requires_fenced_lease` exists (`:104-115`). Error text starts with `database schema drift:`.
2. `migrations:doctor` compares ledger vs manifest (section 3). Note the gap HC-2: a database `BEHIND` by a migration that adds no contract table still answers `/readiness` 200 (`docs/HEALTH_CHECK_CONTRACT.md`).
3. `migrations:preflight` "schema drift" scenario proves fresh-install schema == upgrade-path schema for THIS checkout (`scripts/migration_preflight.cjs:24`).
4. `npm run db:inspect` dumps the live catalog for manual diff.

Not covered (OPEN): hosted grant/RLS state applied from `supabase/staging/*.sql` is outside the ledger; the doctor cannot see a missing grant. Symptom is `42501` on one table for one runtime role while `/readiness` is green. Use `supabase/staging/verify_r1_foundation.sql` (read-only) and the grant file for the failing feature; apply grants only through the reviewed path.

STOP CONDITIONS: `database schema drift: missing triggers ...` on a hosted database (someone dropped an enforcement trigger); `real_content_mismatch`; a required table missing after a restore (section 8). Do not run `db:migrate` "to fix it" until the cause is known.

## 8. Bad restore

Definition: a restore that boots but is wrong: missing ledger rows, checksum mismatches, missing triggers/functions, or data older than the last known good state.

Rehearsed path (IMPLEMENTED, local only): `npm run db:backup-restore-rehearsal` proves initialise, migrate, fixtures, `pg_dump` custom+plain, drop/recreate, `pg_restore --exit-on-error`, and integrity (table counts, 75 tables / 15 triggers / 17 functions parity, ledger row-by-row with checksums, runner has nothing to apply, dump has no secret shapes) (`scripts/db_backup_restore_rehearsal.cjs:1-20`, `docs/DB_BACKUP_RESTORE_REHEARSAL.md`). Hosted backups (Supabase PITR/daily) are a platform feature, document only (EXPECTED, not rehearsed).

After ANY real restore, in order:
1. Stop the worker and keep it stopped (`render.yaml:78`; no consumer may run against an unverified database).
2. `node scripts/migrations_doctor.cjs --database <restored-url> --allow-hosted` must say `HEALTHY` or `HEALTHY_WITH_EOL_VARIANTS` (`docs/DB_BACKUP_RESTORE_REHEARSAL.md:31`). `BEHIND` means the backup predates a migration: run `db:migrate` deliberately and re-run the doctor. `BLOCKED` means wrong backup or wrong branch: stop.
3. `/readiness` must return 200 with `schema: "siton"` and, when `CANONICAL_POSTGRES_RUNTIME=1`, `runtime_role` (`src/runtime_database_boundary.ts:45-51`).
4. Reconcile the queues against reality: `SELECT status, event_type, count(*) FROM siton.outbox_events GROUP BY 1,2` and the DLQ. Any `processing` row in a restored database belongs to a worker that no longer exists; it will reclaim by lease expiry (section 6). Any money-lane row whose provider call happened AFTER the backup point is an `unknown` outcome by definition: hand it to `docs/PAYMENT_INCIDENT_RUNBOOK.md` section 4 before starting the worker.
5. `SELECT max(created_at) FROM siton.audit_log` and `... FROM siton.payment_attempts`: the restore point must be recorded in the incident.
6. Start the worker; confirm one `ready` heartbeat; confirm `stuck_candidates=0` after one reclaim interval.

STOP CONDITIONS: (a) doctor `BLOCKED`; (b) `audit_log` newer than `outbox_events` (partial restore across tables); (c) the restore was taken from a database where the financial branch (`067`/`068`) was applied but the deployed code is master, or vice versa.

## 9. Partial operator repair

Meaning: a manual intervention that stopped halfway: an `ops:repair --mode apply` that failed after its audit insert, a `--clear-failed` followed by no re-run, a `--fix-eol-checksums` on a subset, or (forbidden) hand SQL on ledger/outbox rows.

What the tools guarantee (IMPLEMENTED):
- `--fix-eol-checksums` runs in one transaction (`scripts/migrations_repair.cjs:45-56`): either all listed rows changed or none; re-running is idempotent (targets recomputed from the ledger).
- `--clear-failed` deletes one row with `status='failed'` only (`:70`); a repeated run reports `no ledger row` and exits 2 (`:65`).
- `ops:repair` apply verifies the plan hash, refuses `blocked` and non-`repairable` plans (`src/operational_repair_cli.ts:116-131`), writes the `repair_*` audit inside the same transaction and checks post-state (`docs/STAGE32B_OPERATIONAL_RECOVERY.md:155-170`, error codes `repair_mutation_row_count_mismatch`, `repair_postcondition_*` at `:243-245`). A failed apply rolls back with the audit row.

Steps:
1. Re-run `migrations:doctor`; it recomputes everything from the current ledger and file set. Its verdict, not the operator's memory, decides the next step.
2. For outbox repairs: `SELECT subject_id, action, reason_code, from_status, to_status, idempotency_key, created_at FROM siton.operational_recovery_audit WHERE subject_id=$1 ORDER BY audit_sequence`. An audit row with `action LIKE 'repair_%'` and no matching state change means the mutation rolled back; re-plan from a fresh snapshot (`ops:repair --mode inspect`) rather than re-applying the old plan (its hash no longer matches the state).
3. If hand SQL touched `outbox_events`, the fencing constraint has most likely already rejected it; if it succeeded (generation-0 rows), the row is quarantined by design and only the CLI path may move it.
4. Record the partial repair as an `operational_cases` row of type `SystemException` through the admin `open_support_case` action (`src/admin_control_plane.ts:412-420`) so the trace survives.

STOP CONDITIONS: `migration_ledger` row in `running` (no tool; escalate); `--i-verified-no-partial-effects` was passed without the object check in section 2 step 4 (treat the target migration as possibly half-applied: inspect objects before any re-run); any repair on the hosted database without `--allow-hosted` in the shell history (it means it ran against a different database than intended).

## 10. Post-incident verification (every scenario)

1. `npm run migrations:doctor` (with `--allow-hosted` on Supabase): `HEALTHY` or `HEALTHY_WITH_EOL_VARIANTS`.
2. `GET /readiness` 200; `GET /health/integrations` shows `provider=mockpay`, `mode=mock-backed` (money still off).
3. `GET /api/admin/outbox-status`: `stuck_candidates=0`, `due_now` draining, `worker.running=true`, `dlq` unchanged or explained.
4. Stuck-outbox and DLQ SQL from `docs/OPERATIONAL_RUNBOOK.md:24,33` empty / explained.
5. Locally after any test involvement: `npm run qa:diagnose` reports `QA_DIAGNOSE_CLEAN`; otherwise `npm run qa:cleanup-stale-dbs -- --yes` for dead-owner databases only.
6. Attach `.release-artifacts/migrations-doctor.json` and the outbox-status JSON to the incident record; never attach connection strings or payloads.

## 11. Open items

- OPEN: repair for a `running` ledger row (crash mid-migration).
- OPEN: DLQ replay; OPEN: mission-control outbox trace column mismatch (section 6).
- OPEN: grant/RLS drift detection for `supabase/staging/*.sql` (section 7).
- OPEN: hosted backup/restore rehearsal; only local `pg_dump`/`pg_restore` is proven (section 8).
- OPEN: live repository adapter for `ops:repair --mode apply` (section 1).
- OPEN: `/readiness` does not include worker freshness or ledger high-water (HC-1, HC-2 in `docs/HEALTH_CHECK_CONTRACT.md`).
- EXPECTED, unobserved: Supavisor behaviour under connection exhaustion; the safe-code list in `src/db.ts:65-67` was proven with a local backend termination only.

## 12. SQL appendix (read-only; parameters as a JSON array for run_pg_query)

Ledger state:

```
node scripts/run_pg_query.cjs "select migration_id, position, filename, status, left(checksum_sha256,12) as checksum, started_at, completed_at, left(error_message,120) as error from siton.migration_ledger order by position" "[]"
```

Dirty ledger rows only:

```
node scripts/run_pg_query.cjs "select migration_id, status, error_message, started_at from siton.migration_ledger where status <> 'succeeded' order by position" "[]"
```

Outbox by type and status with age (complements `docs/OPERATIONAL_RUNBOOK.md:44`):

```
node scripts/run_pg_query.cjs "select event_type, status, count(*)::int as cnt, max(attempt_count)::int as max_attempt, extract(epoch from now()-min(available_at))::int as oldest_s from siton.outbox_events group by 1,2 order by 1,2" "[]"
```

Processing rows with lease detail (leases are compared with database time, `docs/OUTBOX_WORKER_OPERATIONS.md:30`):

```
node scripts/run_pg_query.cjs "select event_uuid, event_type, worker_id, lease_generation, claimed_at, lease_expires_at, last_heartbeat_at, attempt_count, lease_expires_at <= clock_timestamp() as expired from siton.outbox_events where status='processing' order by claimed_at" "[]"
```

Lifecycle audit for one event (append-only, `src/migrations/045_operational_recovery.sql:122-138`):

```
node scripts/run_pg_query.cjs "select audit_sequence, action, reason_code, from_status, to_status, lease_generation, attempt_count, worker_id, created_at from siton.operational_recovery_audit where subject_type='outbox_event' and subject_id=$1 order by audit_sequence" "[\"<EVENT_UUID>\"]"
```

DLQ by type (never delete; `docs/OPERATIONAL_RUNBOOK.md:33` has the row-level query):

```
node scripts/run_pg_query.cjs "select event_type, count(*)::int as cnt, min(created_at) as oldest, max(updated_at) as newest from siton.outbox_dlq group by 1 order by 1" "[]"
```

Worker heartbeats (fresh = within 30 s, `src/frontend_runtime.ts:7853`):

```
node scripts/run_pg_query.cjs "select worker_id, status, started_at, heartbeat_at, heartbeat_at > now() - interval '30 seconds' as fresh, metadata->>'pid' as pid from siton.worker_heartbeats order by heartbeat_at desc" "[]"
```

Required enforcement triggers present (the same list `/readiness` checks, `src/schema_contract.ts:79-91`):

```
node scripts/run_pg_query.cjs "select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='siton' and not t.tgisinternal and tgname in ('trg_deals_before_update_enforce','trg_participants_before_update_enforce','trg_audit_log_before_insert_enforce','trg_audit_log_append_only_update','trg_audit_log_append_only_delete','trg_operational_recovery_audit_append_only_update','trg_operational_recovery_audit_append_only_delete','trg_outbox_fencing_cutover_update','trg_outbox_fencing_cutover_delete','trg_deals_outbox_enforce','trg_payment_attempts_charge_rate_limit') order by 1" "[]"
```

Expected: 11 rows. Fewer rows on a hosted database is a section 7 STOP CONDITION.

Connections by application (privileged console only):

```
select application_name, state, count(*)::int from pg_stat_activity where datname=current_database() group by 1,2 order by 3 desc;
```
