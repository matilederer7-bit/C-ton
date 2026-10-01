# Database backup / restore rehearsal

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

Command: `npm run db:backup-restore-rehearsal` (`scripts/db_backup_restore_rehearsal.cjs`). Local disposable databases only; never a hosted database; no production data; the dump contains no secret (proven).

## What it proves (2026-09-14: 9/9 PASS on PostgreSQL 18, pg_dump 18.2)

1. **initialise** - a brand-new isolated database (`scripts/lib/test_db_isolation.cjs`).
2. **migrate** - the full ledgered manifest (61 migrations, high-water `068` including the R9C financial migrations 067/068) through `scripts/run_migrations.cjs`.
3. **synthetic fixtures** - a seller account, a deal with a delivery option, two participants (`ChargedSuccess` x2 units, `AuthHeld` x1), one platform-fee ledger row (8% rate, 45.28 seller net). Hebrew titles included. No real PII.
4. **dump** - `pg_dump --format=custom` (restore source) and `--format=plain` (scanned): no connection-string credential, no Stripe-shaped key, no JWT, no private key, no webhook secret; and no plaintext `%password%`/`%secret%` column exists in the schema (only hashed/encrypted forms).
5. **drop/recreate** - a second brand-new database.
6. **restore** - `pg_restore --exit-on-error`.
7. **integrity**
   - 12 key table counts identical (`seller_accounts`, `deals`, `deal_delivery_options`, `participants`, `platform_fee_money_events`, `audit_log`, `migration_ledger`, `outbox`, `payment_attempts`, `webhook_events`, `operational_cases`, `notification_events`);
   - schema objects identical: 75 tables, 986 columns, 73 foreign keys, 1069 constraints, 252 indexes, 15 triggers, 17 functions; schema fingerprint identical;
   - migration ledger identical row by row with checksums matching the repository; the runner has nothing to apply on the restored database;
   - representative records survive (deal, seller, both participants, fee row), Hebrew intact, 8% fee rate, charged-only money truth = 2 units, zero commission columns, every foreign key validated.

Every step aborts the chain on failure so a broken dump is never "restored successfully" downstream. Databases are dropped on exit; the dump lives in a temp directory removed on exit. Without `pg_dump`/`pg_restore` (set `PG_BIN` or install the client) the rehearsal reports `SKIPPED_ENVIRONMENT`, never PASS.

## 2026-09-27 extension (Black-Sky)

The rehearsal now also proves per-table content hashes, money invariants identical on source and restored, append-only triggers firing after restore, the ACL loss of `--no-privileges` (321 runtime ACL entries: 229 `siton_web_runtime`, 91 `siton_worker_runtime`, 1 `service_role`; 36 PUBLIC EXECUTE defaults re-appear) and its re-provision from `supabase/staging/*.sql`, plus a negative control. Final line `DB_BACKUP_RESTORE_REHEARSAL_PASS`. Step list and drill cadence: `docs/BACKUP_RESTORE_RUNBOOK.md` §4–§5; hosted restore order: `docs/DISASTER_RECOVERY_RUNBOOK.md`.

## What it does NOT prove

- Hosted backups. Supabase point-in-time recovery / daily backups are a platform feature outside this repository; the runbooks call them "hosted action - document only".
- Restore under load or with live connections (the rehearsal restores into an empty database).
- Data volume behaviour (fixtures are small).

## Operator use

```
npm run db:backup-restore-rehearsal        # local proof for this checkout
node scripts/migrations_doctor.cjs --database <restored-db-url>   # after ANY real restore: verdict must be HEALTHY or HEALTHY_WITH_EOL_VARIANTS
```

Cross-references: `docs/DATABASE_INCIDENT_RUNBOOK.md` (bad restore), `docs/ROLLBACK_RUNBOOK.md` (schema compatibility), the older `scripts/archive/dr_backup_restore_drill.cjs` (kept under `scripts/archive/` since Lean Refactor D2; superseded by this rehearsal for release purposes).
