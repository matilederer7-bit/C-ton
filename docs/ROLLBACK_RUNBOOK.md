# Rollback Runbook — Siton (C-ton)

Companion to `docs/DEPLOYMENT_RUNBOOK.md`. Same legend: **IMPLEMENTED** (read in this repository), **EXPECTED** (hosted-platform behaviour, not verifiable from the checkout), **OPEN** (owner decision). Every Render / Supabase / Grow step is a **hosted action — document only, not executed**.

Two invariants that every section below relies on:

1. **Code rolls back; schema rolls forward.** `scripts/run_migrations.cjs` has no down path (the only `ROLLBACK` in `scripts/run_migrations.cjs:113` and `scripts/migrations_repair.cjs:54` is the error handler of a failed statement). A migration is undone only by a NEW forward migration.
2. **Money is at zero and stays at zero through any rollback.** Staging runs `PAYMENT_PROVIDER=mockpay` (`render.yaml:54-59,107-112`); `config/real-money-release-policy.json` is `BLOCKED`; `src/production_guards.ts` refuses live outside production and mock inside production. No rollback step here can change that; see §8.

---

## 1. Decide first: what is actually broken

| Symptom | Layer | Section |
|---|---|---|
| `/readiness` never reached 200 on the new deploy, old build still serving | nothing to roll back — deploy never swapped (observed 2026-09-10, `docs/STAGING_ACCEPTANCE_2026-09-10.md:44`) | fix forward: §5 |
| `/health` 200, `/readiness` 200, React page broken (blank, console errors, overflow) | frontend — baked into the same image (`Dockerfile:29`) | §2 |
| API 5xx / wrong behaviour, `/readiness` 200 | web runtime | §2 |
| `siton.worker_heartbeats` stale, outbox `processing`/`pending` growing, DLQ rising | worker | §3 + §4 |
| `MIGRATIONS_FAILED …`, ledger row `failed`, or `/readiness` 503 `database migrations are incomplete at NNN` | migration | §5 |
| `/health/integrations` shows a provider other than `mockpay` | configuration / money incident | §8 and `docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md` |

Collect before acting: deploy id, running SHA (`GET /api/preview/meta` → `preview.deployment.runtime_commit_sha`, `src/frontend_runtime.ts:1029-1052`), `MIGRATIONS_DOCTOR` verdict, heartbeat age, outbox counts.

## 2. Bad frontend or bad web runtime → Render previous-deploy rollback

Hosted action — document only, not executed. EXPECTED Render behaviour; the repository holds no Render API client.

1. Render dashboard → `siton-staging-web` → *Events* / *Deploys* → pick the last deploy whose SHA passed §7-§10 of the deployment runbook → **Rollback / Redeploy that commit**. Render rebuilds or reuses that image and swaps only when `/readiness` (`render.yaml:22`) answers 200.
2. Do the same for `siton-staging-worker` **only** if the bad change touched worker code (`src/worker.ts`, outbox handlers in `src/app.ts`, notification/payment processors). The two services are independent deploys of one image; a web-only regression does not need a worker rollback.
3. While the old code redeploys, autoDeploy is still armed: any further push to `master` will replace your rollback. Either freeze merges or push the hot-fix with `[skip render]` (`docs/STAGING_ACCEPTANCE_2026-09-10.md:53`) until you intend to redeploy.
4. Verify exactly as after a deploy: `/readiness` 200, `runtime_commit_sha` = the SHA you rolled back to, `/health/integrations` still `mockpay`, then one public deal page and the seller login gate in a browser at 390/1440.
5. Git side: **do not** `git revert` on `master` while the hosted rollback is in flight; open the revert PR afterwards so CI runs on it and autoDeploy carries the reverted code.

Frontend-specific note: the React bundle is built inside the image (`RUN cd web && npm ci --include=dev && npm run build`, `Dockerfile:29`) and served same-origin under `/preview`. There is no CDN, no asset bucket and no separate frontend release — a frontend rollback IS a code rollback. Hosted asset hashes (`/preview/assets/index-*.js`) equal the local `web/dist` build for the same SHA (`docs/STAGING_ACCEPTANCE_2026-09-10.md:46-49`), which is how you confirm which bundle is live.

## 3. Bad worker

1. Symptoms come from the database, not HTTP: `siton.worker_heartbeats.status` and `heartbeat_at` (`src/worker.ts:34-41`, cadence `WORKER_HEARTBEAT_MS` default 10 s), plus `siton.outbox_events` counts and `siton.outbox_dlq` (`src/worker.ts:44-54`).
2. Roll the worker service back (§2 step 1 applied to `siton-staging-worker`). Because `dockerCommand: npm run start:worker:prod` (`render.yaml:78`) starts the same image, rolling the worker back to a SHA *older* than the web is safe as long as both SHAs accept the current schema (§6).
3. Work in flight is not lost: outbox rows keep `status='processing'` with a lease; when the lease expires the next worker reclaims them (`reclaimWorkerJobs` → `reclaimStuckProcessing(WORKER_STUCK_TIMEOUT_MS)`, `src/app.ts:3042-3046`, cadence `WORKER_RECLAIM_EVERY_POLLS`). Two real worker processes against one database complete every job exactly once (`docs/ARCHITECTURE_REBASE_R4_WORKER.md:77-98`), so an overlap between old and new worker during the swap is covered.
4. Verify: one `ready` heartbeat younger than ~30 s, `stale_leases` back to 0, DLQ count unchanged since the incident began. A rising DLQ after rollback means the events themselves are poisoned — stop and use `docs/OUTBOX_WORKER_OPERATIONS.md`, not another rollback.

## 4. Freezing workers (stop side effects without touching data)

| Where | Action | Effect on outbox | Status |
|---|---|---|---|
| Hosted | Render → `siton-staging-worker` → **Suspend** (or scale to 0). Hosted action — document only. | rows stay `pending` (or expire their lease and stay `processing` until reclaimed); nothing is lost, nothing is delivered | EXPECTED |
| Local / compose | stop the worker process; SIGTERM drains (`stopWorker`, `src/worker.ts:120-…`, `WORKER_SHUTDOWN_TIMEOUT_MS` 30 s) and writes `status='draining'` then `'stopped'` | same | IMPLEMENTED |
| Web process | `DISABLE_OUTBOX_WORKER=1` | **not a switch inside the web process** — `src/app.ts` runs no outbox loop at all (`getWorkerRunning: () => false`, `src/app.ts:5780`) and never reads the variable. It is (a) a boot guard: production web **must** have it set (`src/production_guards.ts:137`), (b) a policy rule for staging/test/production (`config/runtime-environment-policy.json`), (c) a Mission Control display flag (`src/admin_mission_control.ts:2081-2092`). Setting it on the *worker* service does nothing to `src/worker.ts` either — freeze the worker by stopping the process. | — | IMPLEMENTED |

Outbox rows simply wait. Deal state transitions that are driven by the outbox (deadline checks, charging, notifications, finalize) pause with it; deal deadlines in the database do not move. Unfreeze = resume the service; the first cycle reclaims stale leases.

## 5. Bad migration (forward-only)

Facts (IMPLEMENTED, `scripts/run_migrations.cjs`):

- Each migration runs as one `client.query(sql)`; on error the runner issues `ROLLBACK`, marks the ledger row `status='failed'` with the error message, and exits `MIGRATIONS_FAILED …` (`:96-120`). Files with explicit `BEGIN … COMMIT` exist (`src/migrations/007…015`); the migration preflight scenario "failing migration" proves a mid-file failure leaves **no partial objects** (`scripts/migration_preflight.cjs:22-24`).
- Any row with `status <> 'succeeded'` makes every later run refuse: `migration ledger is dirty at NNN (failed)` (`:53-58`), and `/readiness` answers 503 because `assertDatabaseSchema` requires every ledger row to be `succeeded` (`src/schema_contract.ts:66-67`).
- An applied file is never edited: a changed checksum is `mismatch` → `migration checksum mismatch` (`:82-85`); only a line-ending-only difference (`eol-variant`) is tolerated (`:86-92`).

### 5.1 The migration failed while applying (dirty ledger)

1. Read the error: `SELECT migration_id, status, error_message FROM siton.migration_ledger WHERE status <> 'succeeded';`
2. Prove atomicity held — check that the objects the file creates are absent (tables via `to_regclass('siton.<name>')`, columns via `information_schema.columns`, triggers via `pg_trigger`). If ANY object exists, do **not** clear the row; write a corrective forward migration instead (5.3).
3. Only when nothing partial exists, delete the failed row so the runner can retry. Dry run first, then apply:
   ```
   npm run migrations:repair -- --clear-failed 0NN                                       # DRY_RUN: prints what it would DELETE
   npm run migrations:repair -- --clear-failed 0NN --i-verified-no-partial-effects --yes   # add --allow-hosted for a non-local host
   ```
   Markers: `MIGRATIONS_REPAIR action=clear-failed … mode=APPLY` then `MIGRATIONS_REPAIR_APPLIED rows=1` (`scripts/migrations_repair.cjs:63-74`). The helper refuses without `--i-verified-no-partial-effects` and refuses a `succeeded`/`running` row.
4. Fix the SQL in a NEW file only if the file was never applied anywhere (a failed row means it was not applied *here*, but check every environment's ledger); then rerun `npm run db:migrate` → `MIGRATION_OK 0NN …`, `MIGRATIONS_COMPLETE count=N`, `npm run migrations:doctor` → `verdict=HEALTHY`.
5. `docs/DATABASE_INCIDENT_RUNBOOK.md` is referenced by the helper (`scripts/migrations_repair.cjs:17`) but does not exist — OPEN; this section is the procedure until it is written.

### 5.2 The migration succeeded but the code that needs it was rolled back

Nothing to do in the database. All recent migrations are additive (new tables/columns/indexes: 065, 066, and the financial 067/068 on their branch). Older code ignores columns it does not know. Leave the schema; see §6.

### 5.3 The migration succeeded and is wrong (bad constraint, bad backfill, wrong default)

1. Never edit `src/migrations/0NN_*.sql` after it has been applied anywhere — the runner will refuse every environment whose ledger holds the old checksum.
2. Write `src/migrations/0MM_<fix>.sql` with the next free id, append it to `scripts/migration_manifest.cjs` (append-only; positions are array order), run `npm run migrations:preflight` (manifest integrity + upgrade-from-`origin/master` + schema-drift scenarios), and ship it through the normal deployment runbook (migration stage before code stage).
3. If data was corrupted, restore data — not schema — from the backup path proven by `npm run db:backup-restore-rehearsal` (pg_dump custom format + pg_restore, `scripts/db_backup_restore_rehearsal.cjs:1-21`) into a **disposable** database, then copy rows forward with reviewed SQL. Supabase point-in-time recovery is a hosted owner action (document only) and is a last resort because it also rewinds every other table (deals, participants, money events).

## 6. Schema / code compatibility during a rollback

| Combination | Works? | Why |
|---|---|---|
| Newer schema, older code (after a code rollback) | yes for additive migrations | readiness checks `REQUIRED_MIGRATION_IDS` (ends at 051, `src/schema_contract.ts:38-42`) and `REQUIRED_TABLES` — extra tables/columns are never a failure |
| Older schema, newer code (code deployed before its migration) | no — by design | the new code adds its tables to `REQUIRED_TABLES`; `/readiness` 503 → Render keeps the old build live (2026-09-10 case) |
| Newer schema, older worker | yes (same rule as web) | `assertWorkerDatabaseReady` shares the schema contract |
| Migration with a destructive step (drop column, rename, tightened CHECK) | rollback of code is NOT safe | write the migration as two forward steps (add + backfill, then drop in a later release once no deployed SHA reads the old shape) |

Rule: a code rollback target must be a SHA whose `REQUIRED_TABLES` are a subset of what the database has. Any SHA that was ever live against this database qualifies.

## 7. When NOT to roll back the schema

- Never to "match" rolled-back code — §6 says older code tolerates newer additive schema.
- Never by restoring a full backup over a live database to remove one migration — it rewinds money events, participants, fulfillment units and the audit log (append-only triggers `trg_audit_log_append_only_*`, `src/schema_contract.ts:79-89`, exist precisely so history is not rewritten).
- Never by deleting a `succeeded` ledger row — the objects stay, the next run re-applies the file against existing objects and fails, and the doctor reports `extra`/`ordering anomalies` → `BLOCKED`.
- Never on the financial tables (`payment_attempts`, `payment_authorization_bindings`, settlement/lifecycle tables from 053/054 and the 067/068 candidates): their invariants back the double-capture protections reviewed in R9C; a corrective forward migration reviewed by a second person is the only path.

## 8. Keeping money at zero through any rollback

Three independent layers (all IMPLEMENTED), each sufficient alone:

1. **Governance file** — `config/real-money-release-policy.json` `real_money_allowed:false`, `status:BLOCKED`, four uncleared reasons. `npm run proof:no-real-money` (`NO_REAL_MONEY_PROOF_PASS` + `REAL_MONEY: BLOCKED`) scans render.yaml, compose files, Dockerfile, `.env` examples and workflows for `PAYMENT_ENVIRONMENT=live`, live Grow hosts (`secure.meshulam.co.il`, `api.meshulam.co.il`) and live credentials (`scripts/proof_no_real_money.cjs:12-20,29`). A rollback to any earlier SHA carries the same or an older policy — never a more permissive one, because ALLOWED has never been committed.
2. **Mock provider in every checked-in target** — `PAYMENT_PROVIDER=mockpay`, `PAYMENT_PROVIDER_MODE=mock-backed`, `PAYMENT_ENVIRONMENT=demo` in both Render services (`render.yaml:54-59,107-112`) and in the release lab (`docker-compose.release-lab.yml`). Console-set env vars are not in git, so after ANY hosted change re-check `GET /health/integrations` → `integrations.payment.provider` must read `mockpay`.
3. **Runtime guard at boot** — `assertProductionRuntimeGuards` (`src/production_guards.ts`): `PAYMENT_ENVIRONMENT=live` is refused outside production mode (`:40-42`); Grow requires sandbox/live plus non-placeholder `GROW_USER_ID`, `GROW_PAGE_CODE`, `GROW_REFERENCE_ENCRYPTION_KEY` and matching host rules (`:43-73`); production refuses mock providers, sandbox/test/demo environments and synthetic VAT (`:110-138`). The staging policy also forbids `PAYMENT_PROVIDER` ≠ `mockpay` outright (`config/runtime-environment-policy.json` staging rules).

Rollback checklist for money: after every hosted change run `curl -s <host>/health/integrations` and confirm `payment.provider=mockpay`, `payout.provider=internal-ledger`, `notifications.provider=log-only`; locally run `npm run gate:runtime-env -- --render-service siton-staging-web` (`RUNTIME_ENVIRONMENT_GATE_PASS`). If anything else appears, this is a money incident, not a rollback: stop the worker (§4), then follow `docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md`.

## 9. Post-rollback record

Append to `PROJECT_STATUS.md` (your branch's own section — see `docs/PARALLEL_AGENT_DEVELOPMENT.md`): incident time, symptom row from §1, deploy ids before/after, SHAs before/after, `MIGRATIONS_DOCTOR` verdict, worker heartbeat age, `/health/integrations` provider line, and whether a forward migration or revert PR is still owed. Then re-run `npm run release:owner-check -- --reuse` on the SHA that is live and file the report path.

## Appendix — OPEN items

- No Render API client or scripted rollback exists in the repository; every hosted step is manual in the Render dashboard.
- `docs/DATABASE_INCIDENT_RUNBOOK.md` (referenced by `scripts/migrations_repair.cjs`) is not written.
- The financial migrations 067/068 are on `claude/review-r9c-financial`, not on master; their rollback posture (§7) applies once integrated.
- Supabase PITR / backup retention settings for `siton-staging` are owner-console facts not recorded in this repository.
