# Operational Script Validation

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

תאריך
- 2026-03-30

## Canonical Operational Scripts

- `scripts/run_pg_query.cjs`
- `scripts/restart_server_clean.ps1`
- `scripts/restart_server_tsnode_clean.ps1`
- `scripts/register-ts-node.mjs`

## What Was Validated

### `scripts/run_pg_query.cjs`
- נקרא בפועל
- פשוט, ממוקד, ותואם ל-runbook
- מסווג כ-canonical operational

### `scripts/restart_server_tsnode_clean.ps1`
- תואם למסלול שמוגדר ב-runbook
- עושה stop ל-process על פורט `3000`
- מעלה runtime דרך `node --import ./scripts/register-ts-node.mjs src/app.ts`
- מסווג כ-canonical operational

### `scripts/restart_server_clean.ps1`
- עושה אותו flow דרך `npm run dev`
- שימושי למפתחים
- מסווג כ-active אך פחות קנוני מהנתיב של `restart_server_tsnode_clean.ps1`

### `scripts/register-ts-node.mjs`
- helper קטן וקריא
- מסווג כ-support operational script

## Validation Limits

- סביבת sandbox חסמה חלק ממסלולי spawn ולכן לא כל נתיב PowerShell-interactive אומת end-to-end בתוך אותה סביבת tool.
- runtime עצמו כן אומת דרך build מקומפל ו-`node .tmp_test_dist/src/app.js`.

## Decision

- surface תפעולי קנוני קיים ומוגדר.
- שאר scripts הרבים בריפו אינם operational runtime scripts.
