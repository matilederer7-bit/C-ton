# Backend Professionalization Audit

תאריך
- 2026-03-30

## Worktree Reality

מצב שנמדד
- היו שינויים קיימים ב-`src/app.ts`, `src/outbox_worker_helpers.ts`, `package.json`, `scripts/init_db.sql`, ומסמכי docs שונים.
- היו קבצים חדשים רבים ב-`docs/`, `scripts/`, `src/`, `frontend/`.
- נמצאו תיקיות tmp לא קנוניות:
  - `.tmp_prod_extract/`
  - `.tmp_ux_extract/`
  - `.tmp_test_dist/` לאחר test/runtime validation

סיכום
- הריפו לא היה clean.
- רוב אי-הסדר היה משאריות של QA, patching, doc extraction, ו-scratch scripts.

## Classification

### CANONICAL
- `PROJECT_STATUS.md`
- `src/app.ts`
- `src/db.ts`
- `src/outbox_worker_helpers.ts`
- `src/payment_attempt_helpers.ts`
- `src/migrations/*`
- `package.json`
- `tsconfig.json`
- `docs/BUYER_CAPACITY_RULE_OVERRIDE.md`
- `docs/OPERATIONAL_RUNBOOK.md`
- `docs/RELEASE_READINESS_CHECKLIST.md`
- `docs/RC_GATE_DECISION.md`
- `docs/RC_EXECUTION_PLAN.md`
- `docs/RC_EXECUTION_RESULT.md`
- `docs/STAGE11_RUNTIME_VERIFICATION_2026-03-29.md`
- `docs/STAGE12_DUPLICATE_EVENT_VERIFICATION.md`
- `docs/STAGE12_RESTART_AND_OUTBOX_RECOVERY.md`
- `docs/STAGE12_SOAK_TEST_VERIFICATION.md`
- `docs/STAGE12_OPERATIONAL_CONFIDENCE_SUMMARY.md`

### ACTIVE
- `scripts/run_pg_query.cjs`
- `scripts/restart_server_clean.ps1`
- `scripts/restart_server_tsnode_clean.ps1`
- `scripts/register-ts-node.mjs`
- `frontend/`
- `tests/backend_sanity_suite.ts`
- `tsconfig.test.json`
- `src/runtime_config.ts`

### LEGACY
- `docs/PROJECT_STATUS.md`
- `docs/db-drift-resolution.md`
- `docs/runtime-contract-resolution.md`
- `docs/STAGE_9D_DRIFT_REPORT.md`
- כל קובצי `.docx` ב-`docs/`
- רוב `stage*.cjs` ב-`scripts/` ו-`src/`
- רוב `inspect_*`, `patch_*`, `fix_*`, `replace_*`, `force_*`, `dump_*`, `locate_*`, `show_*`

### TEMP
- `.tmp_prod_extract/`
- `.tmp_ux_extract/`
- `.tmp_test_dist/`

### DELETE_CANDIDATE
- `.tmp_prod_extract/`
- `.tmp_ux_extract/`
- `.tmp_test_dist/`

### UNKNOWN
- אין קובץ קריטי שנשאר בקטגוריית unknown אחרי המיפוי הזה.

## Duplicate / Residue Findings

- `scripts/` מכיל ריבוי גבוה של גרסאות `v2`, `clean`, `exact`, `regex`, `final` לאותו סוג תיקון.
- `src/` מכיל עשרות קבצי `stage*` ו-`inspect*` שהיו חלק מ-QA חד-פעמי ולא runtime.
- יש שכפול סטטוס היסטורי בין `PROJECT_STATUS.md` הקנוני לבין `docs/PROJECT_STATUS.md` הישן והפגום ב-encoding.

## Audit Decision

- ליבת הריפו היא backend runtime + migrations + canonical docs + מספר קטן של scripts תפעוליים.
- רוב היתר הוא residue היסטורי או one-off tooling, ולכן חייב להיות מסווג במפורש כ-legacy או temp ולא כ-active runtime.
