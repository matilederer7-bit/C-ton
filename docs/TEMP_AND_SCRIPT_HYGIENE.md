# Temp And Script Hygiene

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
