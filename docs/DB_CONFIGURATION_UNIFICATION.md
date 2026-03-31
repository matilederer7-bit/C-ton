# DB Configuration Unification

תאריך
- 2026-03-30

## Problem Proven

נמצא drift אמיתי:
- `src/db.ts` השתמש בברירת מחדל `postgres://postgres@localhost:5432/c-ton`
- `src/app.ts` השתמש בברירת מחדל `postgresql://postgres:postgres@localhost:5432/siton`

זה יצר שני עולמות אפשריים:
- DB name שונה
- credentials שונים
- risk של runtime מול tooling שמדברים למסד אחר

## Fix Applied

נוצר מקור אמת אחד:
- `src/runtime_config.ts`

הקבצים שיושרו אליו:
- `src/db.ts`
- `src/app.ts`

מקור האמת המאוחד עכשיו:
- `DATABASE_URL`
- `DB_SCHEMA`
- `PORT`
- `HOST`
- `OUTBOX_POLL_MS`
- `OUTBOX_MAX_ATTEMPTS`
- `COMPLETION_WINDOW_MINUTES`

## Canonical Defaults

- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/siton`
- `DB_SCHEMA=siton`

## Validation

- `npm test` עבר
- `npx tsc --noEmit` עבר
- runtime validation דרך build מקומפל עבר עם `/health`

## Decision

- אין יותר שתי ברירות מחדל סותרות ל-DB בתוך runtime code.
- `src/runtime_config.ts` הוא מקור האמת הקנוני היחיד לתצורת runtime.
