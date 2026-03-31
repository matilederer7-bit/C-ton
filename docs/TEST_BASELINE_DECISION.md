# Test Baseline Decision

תאריך
- 2026-03-30

## Previous State

- `npm test` היה placeholder ריק ולא סיפק שום signal אמיתי.

## New Baseline

- `npm test` כעת מריץ:
  - קומפילציה ל-`tsconfig.test.json`
  - הרצת `tests/backend_sanity_suite.ts`

## Baseline Coverage

- health endpoint sanity
- state transition sanity
- outbox retry sanity
- outbox DLQ permanent-fail sanity

## Why This Runner

- סביבת העבודה חסמה runners שתלויים ב-fork/spawn חיצוני.
- לכן נבחר baseline in-process שמחזיר pass/fail אמיתי ואינו cosmetic.

## Validation

- `npm test` עבר
- `npx tsc --noEmit` עבר

## Decision

- test command אמיתי קיים ורץ.
- זה baseline מקצועי מינימלי, לא כיסוי מלא.
- הרחבת suite בעתיד היא follow-up, לא blocker ל-pass הזה.
