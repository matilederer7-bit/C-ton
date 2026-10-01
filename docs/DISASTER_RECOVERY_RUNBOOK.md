# Disaster Recovery Runbook — Siton (C-ton)

Status: operator runbook for total-loss scenarios (database, region, Render, Supabase project). Written 2026-09-27 on the Black-Sky branch (base `dd378dd`) against the tooling that exists in this checkout. Designed for **one operator** (the owner). It changes no runtime code and no migration file.

Legend: **IMPLEMENTED** = exists in this repository at the cited file. **EXPECTED** = platform behaviour we rely on but have not exercised. **UNVERIFIED** = we have never seen it work and must not claim it. **OWNER ACTION** = needs a hosted console or a credential only the owner holds.

Companions: `docs/BACKUP_RESTORE_RUNBOOK.md` (how backups are taken and drilled), `docs/DATABASE_INCIDENT_RUNBOOK.md` (partial failures: ledger, locks, connections), `docs/INCIDENT_RESPONSE_RUNBOOK.md` (severity, first 15 minutes, emergency controls), `docs/PAYMENT_RECONCILIATION_RUNBOOK.md` (money truth after a restore), `docs/CREDENTIAL_COMPROMISE_RUNBOOK.md` (rotation), `docs/ROLLBACK_RUNBOOK.md` (code/schema compatibility), `docs/BLACK_SKY_THREAT_MODEL.md` (what this runbook is designed to survive).

## 0. Never-do list

1. Never restore over a database that still has a running worker or a serving web process. Suspend the worker first (§4 step 1); the web service may stay up only behind `pause_joining_emergency` (global) so buyers cannot create new money state during the restore.
2. Never run `pg_restore` into the live database "in place". Restore into a **new** database (or a new Supabase project), verify it (§5), then repoint the runtimes. The old database is evidence until the postmortem closes.
3. Never start the worker against a restored database before `migrations:doctor` says `HEALTHY`/`HEALTHY_WITH_EOL_VARIANTS`, the grant re-apply has been verified (§6), and every money-lane outbox row whose provider call may post-date the backup point has been classified (§8). A worker started too early re-fires money operations from stale state.
4. Never use `pg_restore` without `--no-owner --no-privileges` on Supabase. The dump owner is a different principal from the project owner; `--no-privileges` is required, and it is exactly why §6 exists (grants must be re-applied by hand).
5. Never hand-edit `siton.migration_ledger` after a restore. Use `migrations:repair` with the flags in §7 only.
6. Never treat hosted Supabase backups / PITR as verified. As of this document no restore from a Supabase-managed backup has been performed by us (UNVERIFIED). The only proven restore path is `pg_dump` custom format → `pg_restore` on disposable local databases (`npm run db:backup-restore-rehearsal`).
7. Never delete `outbox_dlq`, `audit_log`, `operational_recovery_audit`, `webhook_events`, `payment_attempts`, `seller_payout_attempts` or `seller_payout_reconciliation_cases` rows to make a restored database "look clean".
8. Never reuse the pre-disaster `DATABASE_URL` values if the disaster involved a credential exposure; a total loss is also the moment to rotate (`docs/CREDENTIAL_COMPROMISE_RUNBOOK.md`).
9. Never paste connection strings, the age private identity, the `x-admin-key`, or dump contents into tickets, chat, or `PROJECT_STATUS.md`.
10. Never run `npm test`, `npm run test:*`, `migrations:preflight`, `db:backup-restore-rehearsal` or `qa:cleanup-stale-dbs` with a hosted `DATABASE_URL` in the shell (they create/drop databases; the isolation library refuses non-local hosts, the test runner may not).

## 1. RPO / RTO — stated honestly

| Scenario | RPO (data we may lose) | RTO (time to serve again) | Basis |
|---|---|---|---|
| Full DB loss with the off-site workflow provisioned | up to 24 h (daily `02:17 UTC` run, `.github/workflows/offsite-db-backup.yml`) plus anything Supabase PITR would add if it is enabled (UNVERIFIED) | target 4 h from decision to `/readiness` 200; **not measured** on hosted infrastructure | local rehearsal restores a small fixture in minutes; the hosted steps (§4–§9) are manual owner actions never timed end to end |
| Full DB loss with the off-site workflow NOT provisioned (current state until the owner adds the `OFFSITE_BACKUP_*` secrets) | whatever the Supabase plan's own backup gives — UNVERIFIED by us; could be **everything** on a free-tier project | undefined | `OFFSITE_BACKUP_SKIPPED` is what the workflow prints today |
| Render loss (both services) | 0 (state lives in Supabase) | ~30–60 min: new services from `render.yaml` + re-entering `sync: false` secrets | EXPECTED (Blueprint sync) |
| Supabase project loss (DB + Auth + Storage + Edge Function) | DB: as row 1. Auth users: **not in our dumps** (`auth` schema is not dumped; sellers/admins must re-register or be re-invited). Storage objects: **not in our dumps** (deal imagery lost unless the owner keeps a bucket copy). | 1 working day is a realistic floor: new project, grant files, roles, Auth URL configuration, broker function redeploy, both Render services repointed | UNVERIFIED end to end |
| Region loss (eu-central-1 / Frankfurt) | as Supabase project loss | as Supabase project loss, in another region; Render region change is a new service | UNVERIFIED |

What the dump contains (IMPLEMENTED, `.github/workflows/offsite-db-backup.yml:111-114`): schemas `siton` and `siton_inventory` only, custom format, `--no-owner --no-privileges`. Not contained: `auth.*` (Supabase Auth users), `storage.*` (bucket metadata and objects), roles and passwords, grants, the Edge Function, Render environment variables. Each of those has its own row in §3.

## 2. Detection: how you learn it is a DR event, not an incident

| Signal | Where | Meaning |
|---|---|---|
| `/readiness` 503 `not_ready` for more than a few minutes while `/health` is 200 | `curl -s https://<web>/readiness` | DB/schema unreachable — start `docs/DATABASE_INCIDENT_RUNBOOK.md` §1a; escalate to this runbook only if the database is confirmed gone (Supabase dashboard shows the project paused/deleted, or `psql` reports the database does not exist) |
| Supabase dashboard: project missing, paused, or "restoring" | Supabase console (OWNER ACTION) | project-level loss |
| Render dashboard: services missing / workspace gone | Render console (OWNER ACTION) | Render loss |
| `worker_alert` log lines with `alert_key=consecutive_cycle_failures` and `worker_watchdog_fatal` in a loop | Render worker logs / Sentry fingerprint `worker_alert:consecutive_cycle_failures` (`src/worker.ts:62-86`) | worker cannot reach the DB; it exits non-zero and Render restarts it — harmless while the DB is down, but confirms the outage |
| `migrations:doctor --allow-hosted` → `EMPTY_DATABASE` on the hosted URL | operator shell | the database exists but the schema is gone (dropped or a fresh project) |

Decision tree:

```
DB unreachable?
├─ yes, Supabase project exists and is healthy in the dashboard → DATABASE_INCIDENT_RUNBOOK (connections/locks/ledger), not DR
├─ yes, project paused/deleted/region down → §3 "Supabase project loss" (includes full DB loss)
└─ no, DB fine but Render services gone → §3 "Render loss"
Data present but wrong (mass corruption, unauthorised writes)?
└─ treat as DR with a chosen restore point + CREDENTIAL_COMPROMISE_RUNBOOK; restore into a NEW database, never in place
```

## 3. Scenario matrix and restore order

| Loss | Restore order (each step verified before the next) |
|---|---|
| **Full DB loss** (schema/data gone, project alive) | §4 freeze → §5 restore into a new database → §6 grants → §7 ledger → §8 money + queues → §9 repoint runtimes → §10 verification → §11 release |
| **Supabase project loss** | as full DB loss, plus: create project (OWNER ACTION) → run `supabase/staging/001_siton_inventory_v1.sql` … `026` in order **after** the restore (they create roles, RLS, grants, storage bucket and policies) → set `siton_web_login` / `siton_worker_login` passwords (`ALTER ROLE … PASSWORD`, OWNER ACTION, never in Git) → Auth: Site URL / Redirect URLs (`docs/PILOT_LAUNCH_RUNBOOK.md` §0.4), re-invite sellers/admins → redeploy `supabase/functions/storage-broker` with the broker-key digest → update `SUPABASE_URL`, `DATABASE_URL`, `SUPABASE_ANON_KEY` on both Render services |
| **Region loss** | Supabase project loss in another region; Render: recreate services in another region from `render.yaml` (edit `region:` in a branch, or create via dashboard) |
| **Render loss** | Blueprint sync from `render.yaml` (OWNER ACTION) → re-enter every `sync: false` value (`DATABASE_URL` ×2 distinct, `OTP_HASH_SALT`, `SITON_STORAGE_BROKER_KEY`, `SENTRY_DSN`) and let Render regenerate `ADMIN_API_KEY` / `SELLER_SESSION_SECRET` (`generateValue: true`; this invalidates every seller session and the bootstrap key) → verify `/readiness` `runtime_role=siton_web_runtime` and one `ready` worker heartbeat. No database step. |
| **Storage loss** (bucket `deal-images`) | not covered by the DB dump; published imagery is gone. Re-run the orphan report (`siton.storage_orphan_reports`, `docs/OPERATIONAL_RUNBOOKS.md` §15); never delete `siton.deal_images` rows; sellers re-upload. OWNER ACTION: decide whether to keep a periodic bucket copy (OPEN, no tooling). |

## 4. Freeze (before any restore)

1. OWNER ACTION: Render → `siton-staging-worker` → **Suspend** (`docs/ROLLBACK_RUNBOOK.md` §4). If the DB is gone the worker is crash-looping anyway; suspend it so it cannot come up against the restored database on its own.
2. If the web service still runs: `POST /api/admin/actions` with `action_type=pause_joining_emergency`, `target_type=global`, `reason=<incident id>`, `metadata.expires_at` within 24 h, then `execute` (SuperAdmin, recent MFA; `docs/ADMIN_INTERVENTION_RUNBOOK.md`). If the DB is gone this call fails — note it and rely on `/readiness` 503 keeping Render's health check red.
3. Record: time, last known good `runtime_commit_sha` (`GET /api/preview/meta` if reachable, else the last Render deploy), the doctor's last known high-water migration id, and which backup object you intend to use (`s3://<bucket>/<prefix>/<yyyy>/<mm>/siton-<stamp>.dump.age` + its `manifest.json`).

## 5. Restore into a NEW database (proven path)

Prerequisites on the operator machine: `pg_restore` of a major ≥ the dump's `pg_dump` major (manifest field `pg_dump`), `age`, the age **private identity** (offline, owner-held), read access to the off-site bucket.

```bash
# 1. fetch the object and its manifest (OWNER ACTION: bucket credentials never leave the operator machine)
aws s3 cp s3://"$OFFSITE_BACKUP_S3_BUCKET"/<key>.dump.age ./siton.dump.age
aws s3 cp s3://"$OFFSITE_BACKUP_S3_BUCKET"/<key>.manifest.json ./manifest.json
# 2. integrity of the encrypted object
sha256sum siton.dump.age            # must equal manifest.encrypted_sha256
# 3. decrypt with the offline identity
age --decrypt --identity <path-to-age-identity> --output siton.dump siton.dump.age
sha256sum siton.dump                # must equal manifest.plain_sha256
# 4. table of contents must list the money tables (same check the workflow ran before encrypting)
pg_restore --list siton.dump | grep -E "TABLE DATA siton (migration_ledger|deals|participants|platform_fee_money_events|payment_attempts|audit_log|seller_settlements) "
# 5. restore into a NEW, EMPTY database as the project owner (Supabase: the `postgres` owner URL, direct or session pooler; never a runtime login)
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_URL" siton.dump
```

`--exit-on-error` is deliberate: a partial restore must fail loudly (`scripts/db_backup_restore_rehearsal.cjs:309`). If it fails, drop the new database and restart from step 5; never "continue" a failed restore.

Shred the plaintext dump when done (`shred -u siton.dump`); keep the `.age` object and manifest as evidence.

## 6. Grants: what `--no-privileges` silently drops (the 321-grant finding)

The rehearsal step `7g grants dropped by --no-privileges` (`scripts/db_backup_restore_rehearsal.cjs:414-425`) measured, on the canonical schema with the staging grant files applied, that a `pg_dump --no-privileges` / `pg_restore --no-privileges` cycle:

- **loses 321 ACL entries**: 229 held by `siton_web_runtime`, 91 by `siton_worker_runtime`, 1 by `service_role`;
- **re-grants EXECUTE to PUBLIC on 36 functions** (the built-in default ACL returns because the explicit `REVOKE … FROM PUBLIC` in `supabase/staging/009_runtime_function_public_fail_closed.sql` is not carried by the dump).

Consequences if you skip this section: `/readiness` may still be 200 (the runtime role can `SET ROLE` and `USAGE` survive only if the role grants were re-run), but the first business query fails with `42501` on one table per feature (`docs/DATABASE_INCIDENT_RUNBOOK.md` §7), and `anon`/`authenticated` regain EXECUTE on `SECURITY DEFINER` helpers — a fail-open regression.

Re-apply, **in this order**, as the database owner (IMPLEMENTED list: `STAGING_GRANT_FILES`, `scripts/db_backup_restore_rehearsal.cjs:192-204`):

```bash
cd <checkout>
for f in 001_siton_inventory_v1.sql 006_canonical_postgres_runtime_boundary.sql 007_runtime_role_admin_set_proof.sql \
         008_runtime_trigger_helper_execute.sql 009_runtime_function_public_fail_closed.sql \
         010_r3_web_login_provisioning.sql 011_r4_worker_login_provisioning.sql 012_web_notification_enqueue.sql \
         013_r6_viral_graph_grants.sql 014_r6_worker_webhook_ingest.sql 016_r8_admin_notification_attempts_read.sql \
         017_r8_admin_payout_rail_read.sql 018_p0_2_bindings_and_deal_delete.sql 019_p0_3_chat_reactions_business_profiles.sql \
         020_p0_4_field_change_audit.sql 021_p0_5_support_messages.sql 022_p0_7_seller_inquiries.sql \
         023_receipt_content_grants.sql 024_r9c_payment_lifecycle_grants.sql \
         026_distribution_link_viewer_grants.sql; do
  psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -f "supabase/staging/$f" || { echo "GRANT_APPLY_FAILED $f"; break; }
done
```

On a Supabase project also apply `004_deal_images_bucket.sql` and `015_r7_supabase_storage_public_read.sql` (they need the `storage` schema, which plain PostgreSQL lacks; that is why the rehearsal excludes them). Then:

```bash
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -f supabase/staging/verify_r1_foundation.sql   # read-only: browser privilege counts must be 0, all_core_rls_enabled true
```

Verify with the rehearsal's own permission diff. Take this snapshot **now, on the healthy database** (OWNER ACTION, once; store the output next to the backup manifests) and again after every restore; the two must be identical. The query is the rehearsal's `aclSnapshot` (`scripts/db_backup_restore_rehearsal.cjs:536-557`), read-only:

```sql
WITH objs AS (
  SELECT 'schema' AS kind, n.nspname::text AS obj, (aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner)))).*
    FROM pg_namespace n WHERE n.nspname IN ('siton','siton_inventory')
  UNION ALL
  SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'relation' END, n.nspname || '.' || c.relname,
         (aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)))).*
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('siton','siton_inventory') AND c.relkind IN ('r','p','v','m','S','f')
  UNION ALL
  SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, (aclexplode(a.attacl)).*
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('siton','siton_inventory') AND a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'function', p.oid::regprocedure::text, (aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner)))).*
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('siton','siton_inventory') OR (n.nspname = 'public' AND p.proname LIKE 'siton%')
)
SELECT kind || '|' || obj || '|' || CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END || '|' || privilege_type || '|' || is_grantable AS entry
FROM objs ORDER BY 1;
```

Run it with `psql "$URL" -At -f acl_snapshot.sql > acl-<label>.txt` and `diff acl-healthy.txt acl-restored.txt`. Pass criteria: empty diff; and `grep -c '|PUBLIC|EXECUTE|' acl-restored.txt` equals the healthy count (the 36 re-appeared defaults must be gone again). Quick counts if you have no healthy snapshot: `grep -c '|siton_web_runtime|'` ≈ 229 and `grep -c '|siton_worker_runtime|'` ≈ 91 on the 2026-09-27 schema (these numbers grow with every grant file; the snapshot diff is the real check).

Local proof that this procedure works: `npm run db:backup-restore-rehearsal` step `7h runtime-role grant re-provision` reports `ACL identical to source` when the runtime roles exist in the local cluster, or `NOT_APPLICABLE` with the exact runbook step otherwise.

## 7. Migration ledger recovery

After the restore, the ledger is whatever it was at the backup point.

```bash
npm run migrations:doctor -- --database "$RESTORE_URL" --allow-hosted     # read-only; artifact .release-artifacts/migrations-doctor.json
```

| Verdict | Action |
|---|---|
| `HEALTHY` / `HEALTHY_WITH_EOL_VARIANTS` | continue to §8 |
| `BEHIND` | the backup predates a migration the deployed code needs (e.g. a backup taken before `077`: the schema contract requires every manifest migration, so `/readiness` stays 503 until it is applied). Apply deliberately with a DDL identity: `DATABASE_URL="$RESTORE_URL" npm run db:migrate` (takes advisory lock `357712547662`; session `lock_timeout` = `MIGRATION_LOCK_TIMEOUT_MS` default 5000 ms, `statement_timeout` = `MIGRATION_STATEMENT_TIMEOUT_MS` default 600000 ms, runner-lock wait `MIGRATION_ADVISORY_LOCK_WAIT_MS` default 60000 ms; `scripts/run_migrations.cjs:53-75`). Re-run the doctor. |
| `BLOCKED` with `dirty rows: 0NN:running` | a runner died between a self-transacting file's `COMMIT` and its ledger `UPDATE` — the backup was taken in that window, or the crash was the disaster. The doctor prints `stale running 0NN: fingerprint verdict=<applied|absent|partial|undetermined>`. Resolve with **exactly one** of: |
| | `npm run migrations:repair -- --clear-running 0NN --mark-succeeded --i-verified-applied --allow-hosted --database "$RESTORE_URL"` (dry run; prints the object fingerprint) then add `--yes` — only when `verdict=applied` |
| | `npm run migrations:repair -- --clear-running 0NN --mark-failed --i-verified-no-partial-effects --allow-hosted --database "$RESTORE_URL"` then `--yes` — only when `verdict=absent`; the row is deleted and `db:migrate` re-applies the file |
| | `verdict=undetermined`: inspect the data by hand, then add `--accept-undetermined` to the matching choice. `verdict=partial`: refused by the tool; stop and follow `docs/DATABASE_INCIDENT_RUNBOOK.md` §2/§9. |
| `BLOCKED` with `dirty rows: 0NN:failed` | `docs/DATABASE_INCIDENT_RUNBOOK.md` §2 (`--clear-failed 0NN --i-verified-no-partial-effects --yes` after the object check) |
| `BLOCKED` with `real_content_mismatch` / `extra` / ordering | wrong backup or wrong branch. Stop. Do not migrate. |

The repair tool refuses while a migration run holds the runner lock (`scripts/migrations_repair.cjs:139-140`) and refuses a hosted host without `--allow-hosted`.

## 8. Money reconciliation and queue triage before the worker starts

Money truth first (read-only, safe on the hosted URL; `scripts/money_invariants.cjs` runs one `READ ONLY` `REPEATABLE READ` transaction and prints only host and database name):

```bash
MONEY_INVARIANTS_DATABASE_URL="$RESTORE_URL" npm run db:money-invariants -- --json > money-invariants-restored.json
# last lines: MONEY_INVARIANTS_SUMMARY overall=PASS ...  then MONEY_INVARIANTS_PASS   (exit 0)
```

Any `MONEY_INVARIANT FAIL <name>` line names the invariant and up to 5 sample ids. A restored database that was consistent at the backup point passes; a FAIL means the backup captured an in-flight transaction boundary or a pre-existing defect. Either way: do **not** start the worker; hand the names to `docs/PAYMENT_RECONCILIATION_RUNBOOK.md` §3.

Then the queues (`docs/DATABASE_INCIDENT_RUNBOOK.md` §8 step 4, extended):

```bash
node scripts/run_pg_query.cjs "select event_type, status, count(*)::int as cnt, max(attempt_count)::int as max_attempt, min(available_at) as oldest from siton.outbox_events where status in ('pending','processing','failed') group by 1,2 order by 1,2" "[]"
node scripts/run_pg_query.cjs "select event_type, count(*)::int as cnt, max(created_at) as newest from siton.outbox_dlq group by 1 order by 1" "[]"
node scripts/run_pg_query.cjs "select attempt_type, result_class, count(*)::int from siton.payment_attempts where created_at > (select max(created_at) from siton.audit_log) - interval '2 hours' group by 1,2 order by 1,2" "[]"
```

Classify:

| Finding | Meaning after a restore | Action |
|---|---|---|
| `processing` rows | leases held by a worker that no longer exists | leave them; the first worker cycle reclaims by lease expiry (`WORKER_STUCK_TIMEOUT_MS` default 60 s, `src/worker.ts:44`) |
| `pending` money-lane rows (`charge_deal`, `recovery_deal`, `refund_issue`, `cancel_refund`, `payment_reconcile`, `payment_release`, `seller_payout_dispatch`, `seller_payout_reconcile`) | the provider call may have happened **after** the backup point | each is an unknown outcome by definition: `docs/PAYMENT_RECONCILIATION_RUNBOOK.md` §4. On staging (`mockpay`, `internal-ledger`) no external money exists and they may simply run. |
| `payment_attempts.result_class='unknown'` | expected: the reconcile rail resolves them (`payment_reconcile`, money lane, concurrency 1) | none, but count them in the incident record |
| `seller_payout_batches.payout_status='processing'` | a payout dispatch may have reached the provider after the backup | do not requeue dispatch; `docs/PAYMENT_RECONCILIATION_RUNBOOK.md` §5 (`dispatch_outcome_unknown`) |
| DLQ rows | terminal failures from before the backup | keep; triage per type later |

Record the restore point: `select max(created_at) from siton.audit_log` and `select max(created_at) from siton.payment_attempts`.

## 9. Repoint runtimes (OWNER ACTION)

1. Set the runtime login passwords on the restored database (never in Git or logs): `ALTER ROLE siton_web_login PASSWORD '<new>'; ALTER ROLE siton_worker_login PASSWORD '<new>';` as the owner. New passwords, even if the old ones were not exposed — a DR event is a rotation event.
2. Compose two distinct Supavisor session-mode URLs (port 5432, `sslmode=verify-full`, user `siton_web_login.<project-ref>` / `siton_worker_login.<project-ref>`; `docs/ARCHITECTURE_REBASE_R3_RENDER_WEB.md`). Set `DATABASE_URL` on `siton-staging-web` and, separately, on `siton-staging-worker` (`render.yaml:33-34`, `:101-102`). Never reuse the web URL on the worker.
3. If the project changed: update `SUPABASE_URL` on both services; `SUPABASE_ANON_KEY` where set; redeploy `supabase/functions/storage-broker` (the broker key digest is pinned in `supabase/functions/storage-broker/index.ts:21`; a new project needs the function deployed and `SITON_STORAGE_BROKER_KEY` re-entered on Render).
4. Restart the web service. Keep the worker suspended until §10 passes.

## 10. Verification (all must pass)

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<web>/health          # 200
curl -s https://<web>/readiness                                       # 200, database "connected", schema "siton", runtime_role "siton_web_runtime", trust_proxy_hops 1, client_ip = your egress IP
curl -s https://<web>/health/integrations                             # payment.provider must still be mockpay on staging; anything else is a money incident
curl -s https://<web>/api/preview/meta                                # preview.deployment.runtime_commit_sha = the SHA you expect
npm run migrations:doctor -- --database "$RESTORE_URL" --allow-hosted  # HEALTHY / HEALTHY_WITH_EOL_VARIANTS
MONEY_INVARIANTS_DATABASE_URL="$RESTORE_URL" npm run db:money-invariants   # MONEY_INVARIANTS_PASS
diff acl-healthy.txt acl-restored.txt                                  # empty
node scripts/r3_hosted_proof.cjs --base-url=https://<web>              # no secret material in responses
```

Enforcement triggers present (11 rows expected; `docs/DATABASE_INCIDENT_RUNBOOK.md` §12) and append-only proof: the rehearsal's step `7f` shows that `UPDATE`/`DELETE` on `siton.audit_log` raise `append-only` on a restored database; on hosted, run the same probe inside a transaction you `ROLLBACK`.

Then resume the worker (Render → Resume). Within two reclaim intervals: `GET /api/admin/outbox-status` → `worker.running=true`, `stuck_candidates=0`, `stale_leases=0`, `dlq` unchanged or explained; one `ready` row in `siton.worker_heartbeats` younger than 30 s. Watch the worker log for `worker_alert` (`alert_key` in `dlq_increased`, `oldest_pending_stale`, `stale_leases`, `consecutive_cycle_failures`, `event_deadline_exceeded`): the first cycle after a restore may legitimately emit `stale_leases` once; a repeated `dlq_increased` means poisoned events — stop the worker and go to `docs/PAYMENT_RECONCILIATION_RUNBOOK.md` §6.

## 11. Release and close

1. Release the pause: `POST /api/admin/control-flags/:flagId/release` with a reason.
2. Owner communication: sellers whose deals were live across the restore point get a plain-language note (deals may show an older state; nothing was charged — staging is `mockpay`). Buyers: only if a tracking page regressed.
3. Postmortem record (never values): backup object key and manifest sha256s, restore point timestamps, doctor verdict, invariants summary line, ACL diff result, DLQ count before/after, every OWNER ACTION performed and when, and the list of unknown-outcome rows handed to reconciliation.
4. Rotate anything that was typed into a console during the event (`docs/CREDENTIAL_COMPROMISE_RUNBOOK.md`).
5. Schedule the next drill (`docs/BACKUP_RESTORE_RUNBOOK.md` §5): a DR event counts as a drill only if the checklist in §10 was completed.

## 12. Rollback of a restore

If the restored database turns out wrong (doctor `BLOCKED`, invariants FAIL, ACL diff non-empty, or data older than expected): do not "fix forward" on it. Point the runtimes back at the previous database if it still exists (it must, per never-do #2), or restore the next-older backup object into another new database and repeat §5–§10. Every restore attempt is a new database; none is edited into shape.

## 13. Open items (do not improvise)

- OPEN: no hosted restore has ever been performed; RTO in §1 is a target, not a measurement. Owner drill required (`docs/BACKUP_RESTORE_RUNBOOK.md` §5).
- OPEN: Supabase-managed backup/PITR existence and retention for `siton-staging` are unknown to the repository (owner console fact).
- OPEN: `auth.users` and Storage objects are outside every backup we make.
- OPEN: no scripted Render or Supabase provisioning; every hosted step is manual.
- OPEN: DLQ replay/redrive does not exist; unknown-outcome money rows are resolved by the reconcile rail or by hand per the reconciliation runbook.
