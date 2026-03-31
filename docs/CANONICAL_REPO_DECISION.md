# Canonical Repo Decision

תאריך
- 2026-03-30

## Canonical Code Source of Truth

- runtime backend:
  - `src/app.ts`
  - `src/db.ts`
  - `src/outbox_worker_helpers.ts`
  - `src/payment_attempt_helpers.ts`
  - `src/runtime_config.ts`
- schema and DB contract:
  - `src/migrations/*`

## Canonical QA / RC / Operations Docs

- `PROJECT_STATUS.md`
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

## Legacy Only

- `docs/PROJECT_STATUS.md`
- `docs/db-drift-resolution.md`
- `docs/runtime-contract-resolution.md`
- `docs/STAGE_9D_DRIFT_REPORT.md`
- כל `.docx` ב-`docs/`
- רוב `scripts/` ו-`src/*.cjs` שאינם runtime או operational

## Runtime Operational Scripts

- `scripts/run_pg_query.cjs`
- `scripts/restart_server_clean.ps1`
- `scripts/restart_server_tsnode_clean.ps1`
- `scripts/register-ts-node.mjs`

## One-Off Scripts

- `fix_*`
- `patch_*`
- `inspect_*`
- `replace_*`
- `force_*`
- `stage*`
- `update_project_status_*`

## Decision

- קבצים חד-פעמיים נשמרים כהיסטוריה טכנית בלבד, לא כמקור אמת פעיל.
- כל החלטה חדשה לגבי המערכת חייבת להיצמד למסלולים הקנוניים לעיל.
