# Backup and Restore Runbook — Siton (C-ton)

Status: how backups are taken, verified and drilled. Written 2026-09-27 (Black-Sky branch, base `dd378dd`). The restore procedure for a real loss is `docs/DISASTER_RECOVERY_RUNBOOK.md`; this file covers the standing backup posture, the off-site workflow, the drill cadence and the local restore checklist. `docs/DB_BACKUP_RESTORE_REHEARSAL.md` remains the proof record of the rehearsal script.

Legend: **IMPLEMENTED**, **VERIFIED**, **EXPECTED**, **UNVERIFIED** (never observed by us), **OWNER ACTION**.

## 0. Never-do list

1. Never claim a backup exists until you have listed the object and checked its `manifest.json` sha256s.
2. Never store the age private identity on Render, in GitHub, in CI, in the repository, or on the same account that holds the bucket credentials.
3. Never run `pg_dump` against the hosted database with a runtime login or the owner URL from a shared shell; the off-site role is a dedicated read-only role and the workflow forces `default_transaction_read_only=on`.
4. Never run `npm run db:backup-restore-rehearsal`, `migrations:preflight`, `test:*` or `qa:cleanup-stale-dbs` with a hosted `DATABASE_URL` (they create/drop databases; the isolation library refuses non-local hosts).
5. Never restore into the live database (see `docs/DISASTER_RECOVERY_RUNBOOK.md` §0).
6. Never rotate `--no-privileges` away to "keep the grants": on Supabase the dump owner differs from the project owner and the restore would fail; grants are re-applied from `supabase/staging/*.sql` (DR §6).
7. Never let a drill's result be "SKIPPED_ENVIRONMENT" and call it a pass; the rehearsal prints `DB_BACKUP_RESTORE_REHEARSAL_SKIPPED_ENVIRONMENT` when `pg_dump`/`pg_restore` are missing and that is not `PASS`.

## 1. Backup posture — three layers, honestly labelled

| Layer | What | State | RPO | Who verifies |
|---|---|---|---|---|
| A. Supabase-managed backups / PITR for project `siton-staging` | platform feature | **VERIFIED 2026-10-04: NOT A CURRENT RECOVERY LAYER.** The connected Supabase organisation reports `plan=free` / `tier_free`. Current Supabase documentation states automatic daily backups are for Pro/Team/Enterprise projects; PITR is a paid-plan add-on. We did not observe a hosted backup object or restore point, and none may be claimed. | no hosted-backup RPO to rely on today | plan verified through Supabase project/organisation APIs; upgrade/add-on remains OWNER ACTION |
| B. Off-site encrypted dump | `.github/workflows/offsite-db-backup.yml`: daily `17 2 * * *` UTC + `workflow_dispatch`; `pg_dump --format=custom --compress=9 --no-owner --no-privileges --schema=siton --schema=siton_inventory`; `pg_restore --list` verification before encryption; age public-key encryption; sha256 of plaintext and ciphertext in `manifest.json`; upload to S3-compatible storage; download-back sha256 verify; plaintext shredded | IMPLEMENTED, **secrets-gated**: prints `OFFSITE_BACKUP_SKIPPED missing <names>` and exits 0 until the owner provisions the secrets (§3) | ≤ 24 h once running | the workflow log (`OFFSITE_BACKUP_PASS object=… plain_sha256=… encrypted_sha256=…`) + the quarterly decrypt drill (§5) |
| C. Local restore rehearsal | `npm run db:backup-restore-rehearsal` (`scripts/db_backup_restore_rehearsal.cjs`) on disposable local databases | IMPLEMENTED, run in CI/locally; proves the restore **path**, not any hosted backup | n/a | every release; PASS line in §4 |

What no layer covers: `auth.users` (Supabase Auth), Storage objects (`deal-images`), Render environment values, role passwords, the Edge Function deployment. Each is listed with its recovery in `docs/DISASTER_RECOVERY_RUNBOOK.md` §1/§3.

Read-only inventory on 2026-10-04: `auth.users` = **9**; Storage buckets = **1**; Storage objects = **49**; Storage object bytes from metadata = **19,003,844 bytes (~18.1 MiB)**. These counts prove the gap is real but do not constitute a backup. The app database itself is ~22 MiB (separate read-only census).

## 2. Hosted backups — verified current posture + remaining owner checks

Read-only verification on 2026-10-04: project `hnptacfzuqebfgeshadq` (`siton-staging`) is ACTIVE_HEALTHY in `eu-central-1`, PostgreSQL `17.6.1.166`; its organisation reports `plan=free` / `tier_free`. Supabase's current backup documentation says automatic daily backups are provided on Pro, Team and Enterprise projects, while PITR requires a paid plan plus add-on. Therefore PR-7 cannot be marked complete on the current plan: there is no hosted-backup layer we can rely on today. Upgrading the plan or enabling a paid backup feature is an owner/cost decision, not something CI may silently do.

| # | Check | Where | Record |
|---|---|---|---|
| 2.1 | Which plan is `siton-staging` on, and does the plan include daily backups? | Supabase organisation/project API + dashboard | **VERIFIED 2026-10-04:** Free (`tier_free`); automatic daily backups are not included by the current Supabase plan contract |
| 2.2 | Is PITR enabled? retention window? | Database → Backups / add-ons | **OPEN OWNER DECISION:** current Free plan is not a PITR recovery layer; paid-plan/add-on cost must be approved before enabling |
| 2.3 | Date of the most recent successful platform backup | Database → Backups list | **NOT ESTABLISHED / must not be claimed:** no hosted backup object or restore point has been observed |
| 2.4 | Has a platform restore **ever** been performed for this project? | your own records | date or "never" |
| 2.5 | Who can trigger a platform restore and does that account have MFA? | Supabase organisation members | names (no credentials) |
| 2.6 | Region of the project; is a cross-region copy available? | project settings | region, yes/no |

Current conclusion: on the verified Free plan, the honest RPO for a hosted loss is **layer B or nothing**. A future paid-plan/PITR decision must be re-verified here before Layer A is upgraded from unavailable to usable.

## 3. Off-site workflow — what to provision (names only; values never appear anywhere)

GitHub → repository → Settings → Secrets and variables → Actions:

| Secret | What it is | How to create (OWNER ACTION) |
|---|---|---|
| `OFFSITE_BACKUP_DATABASE_URL` | connection URL of a **dedicated read-only** role | as owner: `CREATE ROLE siton_offsite_backup LOGIN NOINHERIT PASSWORD '<value>'; GRANT USAGE ON SCHEMA siton, siton_inventory TO siton_offsite_backup; GRANT SELECT ON ALL TABLES IN SCHEMA siton, siton_inventory TO siton_offsite_backup; GRANT SELECT ON ALL SEQUENCES IN SCHEMA siton, siton_inventory TO siton_offsite_backup;` (add `ALTER DEFAULT PRIVILEGES … GRANT SELECT` for future tables); compose a session-mode URL with `sslmode=verify-full`; `pg_dump` needs a session connection, not transaction pooling |
| `OFFSITE_BACKUP_ENCRYPTION_PUBLIC_KEY` | the age **public** recipient (`age1…`) | offline machine: `age-keygen -o siton-offsite-identity.txt` → store the identity file offline (two copies, separate places); paste only the `# public key:` line |
| `OFFSITE_BACKUP_S3_BUCKET` | bucket name | create a bucket with versioning or object lock if the provider offers it |
| `OFFSITE_BACKUP_S3_ACCESS_KEY_ID` / `OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY` | write-oriented credential | IAM policy: `PutObject` + `GetObject` on `<prefix>/*` only; no `DeleteObject`, no `ListBucket` beyond the prefix |
| `OFFSITE_BACKUP_S3_ENDPOINT` (optional) | non-AWS endpoint URL (R2, B2, MinIO …) | |
| `OFFSITE_BACKUP_S3_REGION` (optional, default `us-east-1`) | | |
| `OFFSITE_BACKUP_S3_PREFIX` (optional, default `siton-db/`) | key prefix | |
| repository variable `OFFSITE_BACKUP_PG_MAJOR` (workflow default `16`) | `pg_dump` major ≥ the server's major | **Set to `17` before the first real run.** `siton-staging` is verified on PostgreSQL `17.6.1.166`; the workflow default is not sufficient for this project. |

Object layout: `<prefix><yyyy>/<mm>/siton-<yyyymmddThhmmssZ>.dump.age` and `….manifest.json` (`manifest.json` fields: `format`, `schemas`, `privileges: "not included (--no-privileges): re-apply supabase/staging grant files after restore"`, `created_at`, `repository`, `commit`, `run_id`, `pg_dump`, `plain_sha256`, `encrypted_sha256`, `encrypted_bytes`, `toc_entries`, `verified`).

First run: Actions → "Off-site database backup" → Run workflow. Read the log for `OFFSITE_BACKUP_VERIFY_PASS pg_restore --list ok (N entries)` and the final `OFFSITE_BACKUP_PASS`. A gate refusal `… is not an age public recipient (age1...); refusing` means a private identity was pasted — treat that identity as exposed and regenerate it.

Static controls that keep the workflow honest: `tests/release_tools/offsite_db_backup_workflow.test.cjs` (no third-party actions, `contents: read`, secrets only through `env`, skip-not-fail gate, TOC verification before encryption, shred after).

## 4. The rehearsal script and its PASS line

`npm run db:backup-restore-rehearsal` → `scripts/db_backup_restore_rehearsal.cjs`. Local disposable databases only (`assertLocalBase`); needs `pg_dump`/`pg_restore` on `PATH` or `PG_BIN`. Steps (each aborts the chain on failure):

| Step | Proves |
|---|---|
| `1-2 initialise + migrate` | the full ledgered manifest applies to an empty database |
| `3 synthetic fixtures` | a financially consistent fixture: Completed deal with the full audited chain, one charged participant (gross 50, fee 4.72, net 45.28) with capture attempt, settlement, batch and item; one dropped participant with a released hold; Hebrew text; no real PII |
| `3b runtime-role grants on source` | applies the 21 staging grant files when `siton_web_runtime`/`siton_worker_runtime` exist locally |
| `3c money invariants on source` | `MONEY_INVARIANTS` all PASS on the fixture |
| `3d source content hashes` | md5 per table over every row (order-independent) |
| `4 dump (custom + plain)` | dump has no connection-string credential, Stripe key, JWT, private key or webhook secret shape; the schema has no plaintext `%password%`/`%secret%` column |
| `5-6 drop/recreate + restore` | `pg_restore --no-owner --no-privileges --exit-on-error` into a brand-new database |
| `7a` / `7a2` | 14 key table counts identical; every table byte-identical by content hash |
| `7b` | tables/columns/FKs/constraints/indexes/triggers/functions counts identical; schema fingerprint identical |
| `7c` | ledger identical row by row, checksums match the repository, the runner has nothing to apply |
| `7d` | representative rows survive: Hebrew intact, 8% rate, charged units 2, 0 commission columns, all FKs validated |
| `7e` | money invariants identical on source and restored |
| `7f` | `UPDATE`/`DELETE` on `siton.audit_log` are rejected (append-only triggers fire after restore) |
| `7g` | ACL diff: what `--no-privileges` dropped (on the 2026-09-27 schema: 321 runtime ACL entries — 229 `siton_web_runtime`, 91 `siton_worker_runtime`, 1 `service_role` — and 36 PUBLIC EXECUTE defaults re-appeared) |
| `7h` | re-applying the staging grant files brings the ACL back to identical (or `NOT_APPLICABLE` with the exact runbook step when the roles do not exist locally) |
| `8 negative control` | a corrupted clone makes the checker FAIL on exactly 9 named invariants and nothing else |

Final line: `DB_BACKUP_RESTORE_REHEARSAL_PASS` (exit 0), `DB_BACKUP_RESTORE_REHEARSAL_FAIL`, or `DB_BACKUP_RESTORE_REHEARSAL_SKIPPED_ENVIRONMENT`. Artifacts: `.release-artifacts/db-backup-restore-rehearsal.*`. Per-step lines print `PASS`/`FAIL`/`NOT_APPLICABLE` with a summary; step `7g` also prints the first 40 lost and re-appeared ACL entries.

To exercise `7h` locally, create the runtime roles once in the local cluster: `psql "$DATABASE_URL" -c "CREATE ROLE siton_web_runtime NOLOGIN NOINHERIT; CREATE ROLE siton_worker_runtime NOLOGIN NOINHERIT; CREATE ROLE service_role NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;"` (ignore "already exists").

Older tool: `scripts/retired/dr_backup_restore_drill.cjs` (kept, archived under `scripts/retired/` by Lean Refactor D2 and still runnable from the repository root; guarded by `scripts/lib/destructive_target_guard.cjs`, which refuses `APP_DEPLOYMENT_MODE=staging|production|live`, `PAYMENT_ENVIRONMENT=live|production`, and any non-local host unless named in `SITON_DESTRUCTIVE_ALLOWED_HOSTS` — never set that for a hosted database). Superseded by the rehearsal for release purposes.

## 5. Drill cadence

| Drill | Cadence | Command / action | Pass evidence |
|---|---|---|---|
| Local restore path | every release (CI) and before any migration that touches money tables | `npm run db:backup-restore-rehearsal` | `DB_BACKUP_RESTORE_REHEARSAL_PASS` in the release report |
| Off-site object integrity | weekly (owner, 2 min) | list the bucket; open the newest `manifest.json`; compare `created_at` to now (≤ 25 h) and `toc_entries` to the previous manifest (should not shrink) | note in the ops folder |
| Off-site decrypt + restore | quarterly (owner, ~1 h) | on the operator machine: download the newest object + manifest; `sha256sum` vs `encrypted_sha256`; `age --decrypt --identity <file> --output siton.dump …`; `sha256sum` vs `plain_sha256`; `pg_restore --no-owner --no-privileges --exit-on-error --dbname="$LOCAL_SCRATCH_URL" siton.dump` into a **local** scratch database; `npm run migrations:doctor -- --database "$LOCAL_SCRATCH_URL"`; `MONEY_INVARIANTS_DATABASE_URL="$LOCAL_SCRATCH_URL" npm run db:money-invariants`; shred the plaintext | doctor `HEALTHY*`, `MONEY_INVARIANTS_PASS`, timings recorded (this is the only RTO measurement we have) |
| Hosted restore into a new database | once before real money, then yearly | `docs/DISASTER_RECOVERY_RUNBOOK.md` §5–§10 on a throw-away Supabase project | the §10 checklist with timings; updates the RTO in DR §1 |
| Grant re-provision | with every hosted restore, and whenever a new `supabase/staging/0NN_*.sql` lands | DR §6 ACL snapshot diff | empty diff |
| Age identity availability | quarterly, with the decrypt drill | confirm both offline copies open the newest object | note |

A drill that is skipped is recorded as skipped; a drill whose evidence is missing did not happen.

## 6. Local restore checklist (refresh of `docs/LOCAL_RESTORE_CHECKLIST.md`)

When rebuilding a developer machine or a local lab from scratch:

1. Clone `master`, `node --version` ≥ 22, `npm install`.
2. Local PostgreSQL 16+ with `pg_dump`/`pg_restore` on `PATH` (or set `PG_BIN`); a superuser-ish local URL in `.env` as `DATABASE_URL` (gitignored; the canonical default is `postgresql://postgres:postgres@localhost:5432/siton`).
3. `npm run migrations:doctor` → `EMPTY_DATABASE` on a fresh DB is expected; `npm run db:migrate` → `MIGRATIONS_COMPLETE count=N`; doctor → `HEALTHY`.
4. `npm run db:backup-restore-rehearsal` → `DB_BACKUP_RESTORE_REHEARSAL_PASS` (this is the machine's restore-readiness proof).
5. `npm run check:health-contract` → `HEALTH_CONTRACT_PASS`; `npm run release:preflight:static` → all static gates PASS.
6. `.env` values are restored from the owner's secret store, never from Git, chat or screenshots; the variable names are in `docs/ENVIRONMENT_CONTRACT.md`.
7. To load a real off-site dump locally (data inspection, forensics): the quarterly drill steps in §5 — local scratch database only, plaintext shredded afterwards, never with `NODE_ENV=production`/`RENDER` set, and never start a worker against it with a real provider configured.
8. Before wiping the machine: `git status --short` clean, `git rev-list --left-right --count origin/master...HEAD` = `0 0`, no secret in Git (`npm run scan:secrets`), local `uploads/` disposable or copied, the age identity is **not** on this machine (or is copied to its offline homes first).

## 7. Open items

- OPEN (OWNER ACTION): provision the `OFFSITE_BACKUP_*` secrets — until then layer B does not run.
- OPEN (OWNER ACTION): answer the §2 checklist for `siton-staging`.
- OPEN: no hosted restore performed; RTO unmeasured.
- OPEN: `auth.users` and Storage objects have no backup path in this repository.
- OPEN: a dedicated read-only hosted role for the daily invariants run (the off-site role can double for it once created).
