# Repository Final Hygiene Decision

## What Was Cleaned

- `.tmp_*` and build residue were removed.
- `scripts/` was reduced to a small operational + utility surface.
- all `src/*.cjs` historical QA/probe files were removed from active `src/`.
- root-level stage snapshot residue was moved out of the root surface.

## What Was Classified

- operational canonical:
  - `scripts/run_pg_query.cjs`
  - `scripts/restart_server_clean.ps1`
  - `scripts/restart_server_tsnode_clean.ps1`
  - `scripts/register-ts-node.mjs`
- utility:
  - `scripts/inspect_db.cjs`
  - `scripts/run_outbox_select.cjs`
  - `scripts/drop_create_db.cjs`
  - `scripts/drop_create_db.js`
- legacy bootstrap reference:
  - `scripts/init_db.sql`
- active runtime:
  - `src/app.ts`
  - `src/db.ts`
  - `src/outbox_worker_helpers.ts`
  - `src/payment_attempt_helpers.ts`
  - `src/runtime_config.ts`
  - `src/frontend_runtime.ts`
  - `src/migrations/*`
- archive:
  - `archive/repository_hygiene_2026-03-30/scripts_historical/`
  - `archive/repository_hygiene_2026-03-30/src_historical/`
  - `archive/repository_hygiene_2026-03-30/root_historical/`

## What Remains On Purpose

- canonical backend runtime files
- canonical docs and decisions
- a minimal script utility surface useful for operations and local inspection
- legacy bootstrap SQL as reference only

## What Remains Legacy

- archived one-off QA / patch / probe scripts
- archived root snapshots and restart load outputs
- legacy `.docx` documentation
- old `docs/PROJECT_STATUS.md` and other historical docs that remain reference-only

## What Is Not Worth More Time Right Now

- fully normalizing every historical `.docx`
- committing/rebasing every historical git change into a perfectly clean worktree
- further shrinking archived historical material that is already out of the active surface

## Decision

REPOSITORY HYGIENE CLOSED WITH ACCEPTED LEGACY
