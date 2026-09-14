# Migration safety system

Answers "Can commit X migrate from the canonical previous production schema safely?" with disposable local databases only. Financial migration contents (`053`, `067`, `068`) and every other migration file are untouched by this system.

## Components

| Component | Command | Role |
|---|---|---|
| Runner | `npm run db:migrate` (`scripts/run_migrations.cjs`) | applies `scripts/migration_manifest.cjs` in order; ledger `siton.migration_ledger` (`migration_id`, `position`, `filename`, `checksum_sha256`, `status running/succeeded/failed`, `error_message`); refuses a dirty ledger; refuses a changed file (checksum mismatch); forward-only |
| Preflight | `npm run migrations:preflight` (`scripts/migration_preflight.cjs`) | static manifest analysis + 9 database scenarios; `--base <ref>` (default `origin/master`), `--skip-db` |
| Doctor | `npm run migrations:doctor` (`scripts/migrations_doctor.cjs`) | READ-ONLY verdict for a target database; refuses hosted hosts without `--allow-hosted` |
| Repair | `npm run migrations:repair -- <action> --yes` (`scripts/migrations_repair.cjs`) | separate, argument-gated, dry-run by default |
| Rehearsal | `npm run db:backup-restore-rehearsal` | see `docs/DB_BACKUP_RESTORE_REHEARSAL.md` |
| Shared analysis | `scripts/lib/migration_tools.cjs` | manifest analysis, ref materialisation, ledger read, schema fingerprint, comparison |
| Isolation | `scripts/lib/test_db_isolation.cjs` | unique, agent-tagged, local-only databases with exit cleanup |

## Checksums and line endings (the CRLF finding)

The git index stores every migration with LF. A Windows checkout with `core.autocrlf=true` materialises CRLF, and the runner used to hash the bytes it read. The same file therefore hashed differently on Windows and on Linux/CI, and a ledger written from one platform rejected the other with a false "checksum mismatch".

Fix on this branch (`scripts/run_migrations.cjs`):

- the canonical checksum is computed over the BOM-stripped, LF-normalised body; the SQL executed is the same normalised body;
- a stored checksum equal to the CRLF variant of the current file is accepted on read as an "EOL variant" (`MIGRATION_LEDGER_EOL_VARIANT ...` is logged; `eol_variants` is returned) and never written any more;
- `.gitattributes` pins `src/migrations/*.sql text eol=lf` (verified: no working-tree status change on the existing CRLF checkout).

Ledgers written from Linux/CI are valid unchanged. Ledgers written from a Windows checkout keep working and can be normalised explicitly with `npm run migrations:repair -- --fix-eol-checksums --yes`.

## Preflight scenarios (`npm run migrations:preflight`, 2026-09-14: 10/10 PASS)

| Scenario | Proves |
|---|---|
| manifest integrity | no duplicate ids/filenames, contiguous positions, every file present, no orphan `.sql`, documented ordering anomalies only (`014` bootstrap first, `014a`, `015a/b`, `065`), no lone CR, no BOM, no empty file, at most one COMMIT per file |
| line-ending policy | `.gitattributes` pin + CRLF count in this checkout |
| fresh install + idempotent rerun | 59 applied, rerun applies 0, all checksums match, schema object counts |
| upgrade from `origin/master` | base manifest applied first, branch manifest on top; edited-after-applied files fail; schema fingerprint fresh-vs-upgrade identical |
| partial ledger catch-up | first half applied, then the rest (staging-style) |
| CRLF-era ledger | every row rewritten with the CRLF checksum: runner accepts all as EOL variants, applies 0; doctor classifies `line_ending_only_mismatch` |
| tampered checksum refused | runner refuses; doctor classifies `real_content_mismatch` |
| dirty ledger blocks the run | a `failed` row refuses every later run |
| failing migration is atomic (implicit transaction) | `CREATE TABLE ...; INSERT ...; SELECT 1/0` leaves no table, marks the row failed with the error message, next run refuses |
| failing migration is atomic (explicit BEGIN/COMMIT) | same with the file managing its own transaction |

Schema fingerprints compare columns, constraints (by table/type/definition without names or parentheses: PostgreSQL 18 materialises NOT NULL as named catalog constraints that `pg_restore` legitimately renames), indexes, function bodies and triggers.

## Doctor verdicts

| Verdict | Meaning | Exit |
|---|---|---|
| `EMPTY_DATABASE` | no ledger table | 0 |
| `BEHIND` | repository has migrations the database lacks | 0 |
| `HEALTHY` | every row matches the repository | 0 |
| `HEALTHY_WITH_EOL_VARIANTS` | only line-ending-only checksum differences (accepted by the runner) | 0 |
| `BLOCKED` | real content mismatch, filename/position mismatch, dirty rows, extra rows unknown to the repository, duplicate positions, ordering anomalies, or static manifest FAIL | 1 |
| `NO_DATABASE` / `REFUSED_HOSTED` / `UNREACHABLE` | could not evaluate | 2 |

The doctor reports: database count vs repository count, missing, extra, per-row classification, dirty rows, duplicate positions, ordering anomalies, and writes `.release-artifacts/migrations-doctor.json`.

## Repair (never automatic)

- `--fix-eol-checksums`: rewrites only rows whose stored checksum equals the CRLF variant of the current file, in one transaction; prints every row first; needs `--yes`.
- `--clear-failed <id> --i-verified-no-partial-effects --yes`: deletes a `failed` ledger row so the runner retries it. The verification flag is the operator's statement that the migration's objects are absent (see `docs/DATABASE_INCIDENT_RUNBOOK.md`).
- Hosted hosts need `--allow-hosted` for both tools; this branch never ran either against a hosted database.

## Numbering rule for parallel branches

`063`/`064` are reserved by the financial candidate; master took `065`/`066`; the financial branch appends `067`/`068`. Whichever branch lands second appends AFTER the other so ledger positions stay contiguous (`scripts/migration_manifest.cjs` comment). The preflight's "upgrade from origin/master" scenario is the check that a branch did not edit an already-applied file and that the merged manifest still produces the fresh-install schema.

## Controls

`tests/release_tools/migration_tools.test.cjs` (6/6): checksum normalisation and classification, static analysis catching duplicate ids / orphans / empty / missing files, isolation naming + hosted refusal, doctor refusals, doctor verdict walk (EMPTY -> BEHIND -> HEALTHY -> EOL variants -> repair dry-run -> repair apply -> BLOCKED on real mismatch -> failed row -> clear-failed refused without the flag -> cleared -> BEHIND -> HEALTHY), preflight static half.
