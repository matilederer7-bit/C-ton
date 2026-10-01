# Temp And Script Hygiene

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

תאריך
- 2026-03-30

## Temp Cleanup

זוהו כ-temp:
- `.tmp_prod_extract/`
- `.tmp_ux_extract/`
- `.tmp_test_dist/`

החלטה
- למחוק לאחר סיום השימוש.

## Scripts Classification

### Canonical Operational
- `scripts/run_pg_query.cjs`
- `scripts/restart_server_clean.ps1`
- `scripts/restart_server_tsnode_clean.ps1`
- `scripts/register-ts-node.mjs`

### Legacy One-Off Mutation
- `fix_*`
- `patch_*`
- `replace_*`
- `add_*`
- `apply_*`
- `switch_*`

### Legacy One-Off Inspection
- `inspect_*`
- `locate_*`
- `show_*`
- `find_*`
- `scan_*`
- `dump_*`
- `list_recent_deals.cjs`

### Legacy QA / Probe
- `stage3*` עד `stage12*`
- `test_*`
- `verify_*`
- `force_*`
- `pre_*`

## Repo Hygiene Decision

- scripts חד-פעמיים נשמרים כהיסטוריה, אבל לא נחשבים operational.
- temp folders נמחקים בפועל.
- canonical operational surface נשאר קטן וברור.
