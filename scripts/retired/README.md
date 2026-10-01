# Retired scripts

Moved here by Lean Refactor D2 (the directory is `retired`, not `archive`, because `scripts/lib/repo_scan_policy.cjs` excludes any directory named `archive` from lint, the secret/PII scan, the compliance scan and the no-real-money proof; these files stay scanned) (`docs/LEAN_REFACTOR_MAP_2026-09-30.md` §3.5, §4 row D2).
Nothing in `package.json`, a workflow, a preflight gate, a compose file or another script
calls these; they are kept because they carry browser-level assertions no automated test
repeats, recovery value, or a procedure a document still describes. Every one of them runs
from the repository root exactly as before, with the `scripts/retired/` prefix:

| Script | Why it is kept | Rule |
|---|---|---|
| `p06a_geolocation_browser_proof.cjs` | the only real-browser exercise of the seller geolocation flow (CDP-granted, emulated and denied permission paths S1–S9) | never deleted before an equivalent browser-level proof exists (map §6 rule 3) |
| `p07_owner_acceptance_proof.cjs` | public deal page owner-acceptance scenarios incl. the seller-inquiry sheet and the 390px layout | same |
| `p07c_polling_browser_proof.cjs` | real-browser polling cadence / 429 / hidden-tab measurement | same |
| `site_cms_rehearsal.cjs` | CMS draft → preview → publish → restore rehearsal against a running service | same |
| `r6_hosted_browser_proof.cjs` | older hosted browser proof; assumes Mall ON and old selectors (1/5 on 2026-09-10), its failures are not regressions | superseded by `../r7r8_browser_proof.cjs` (`docs/DEPLOYMENT_RUNBOOK.md` §10) |
| `migrate_showcase_images_to_supabase.cjs` | regenerates the 16 synthetic staging showcase images deterministically and uploads them through `saveDealImage` into the canonical `deal-images` bucket | recovery tooling: archived, never deleted |
| `dr_backup_restore_drill.cjs` | the older local backup/restore drill, guarded by `../lib/destructive_target_guard.cjs` | superseded by `npm run db:backup-restore-rehearsal` (`docs/BACKUP_RESTORE_RUNBOOK.md`) |
| `r6_staging_showcase_seed.cjs` | hosted staging showcase seeder (`docs/R6_STAGING_SHOWCASE.md`) | re-runnable against staging with out-of-band credentials |
| `review_baseline_candidates.cjs` | reproduces the `docs/CODEX_BASELINE_REVIEW.md` credential-detector matrix; exits 1 by design when candidates fail | review evidence |
| `review_r9c_migration_independent_proof.cjs` | the R9C independent migration proof; its manifest-size assertions date from the 067/068 era and fail on today's 74-entry manifest (`docs/R9C_PRODUCTION_EXTRACTION_AUDIT.md`) | review evidence; loads `../run_migrations.cjs` and `../migration_manifest.cjs` |
| `run_outbox_select.cjs` | legacy `public.outbox_events` probe (the live schema is `siton.*`) | reference only |
| `i18n/extract.cjs` | the one-shot i18n extractor that produced `../i18n/extracted.he.json`; `--src=` and `--write-extracted` still work, output goes to `.i18n-work/` | one-shot tooling |

`extract_base44_inventory_sql.ps1` stays in `scripts/` until D3 retires it together with the
test that reads it.
