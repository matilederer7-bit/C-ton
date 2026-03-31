# Scripts Surface

This directory is intentionally small after the repository final hygiene pass.

Canonical / operational:
- `run_pg_query.cjs`
- `restart_server_clean.ps1`
- `restart_server_tsnode_clean.ps1`
- `register-ts-node.mjs`

Utility / reference:
- `inspect_db.cjs`
- `run_outbox_select.cjs`
- `drop_create_db.cjs`
- `drop_create_db.js`
- `init_db.sql`:
  legacy bootstrap reference only, not the canonical live schema source of truth

Historical one-off scripts were moved to:
- `archive/repository_hygiene_2026-03-30/scripts_historical/`
