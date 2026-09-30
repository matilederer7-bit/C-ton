# Backend Professionalization Decision

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

## Executive Decision

BACKEND PROFESSIONALLY CLOSED WITH NON-BLOCKING FOLLOW-UPS

## What Was Weak

- תצורת DB לא הייתה מאוחדת.
- runtime נשען על debug logging רועש כברירת מחדל.
- `npm test` היה placeholder ולא command אמיתי.
- הריפו הכיל residue רב של tmp, QA scripts, patch scripts, ו-legacy docs ללא גבול קנוני חד.
- חלק מהמסמכים היו פגומים ב-encoding.

## What Was Fixed

- נוצר מקור אמת קנוני ל-runtime config ב-`src/runtime_config.ts`.
- `src/app.ts` ו-`src/db.ts` יושרו לתצורת DB אחת.
- SQL logging ו-join logging עברו ל-debug flags מפורשים.
- `npm test` הפך ל-suite אמיתי שעובר.
- `KNOWN_GAPS_AND_DECISIONS` תוקן לגרסה קריאה.
- temp folders נמחקו.
- נוצרו מסמכי audit, canonical decisions, DB/logging/test/hygiene/encoding/operational validation.

## What Is Now Clean

- canonical DB configuration
- default logging posture
- baseline automated tests
- tmp extraction folders
- canonical docs map
- operational script map

## What Is Still Non-Blocking

- ה-worktree עדיין אינו clean ברמת git because many historical files remain uncommitted/unarchived.
- ריבוי גדול של scripts היסטוריים עדיין קיים בריפו, אך כעת מסווג כ-legacy ולא כ-runtime.
- `.docx` historical docs לא עברו normalization מלא.
- sandbox מנע אימות מלא של כל startup path שמבוסס על interactive spawn.

## What Is Still Not Acceptable

- אין blocker אפליקטיבי פתוח שהופך את הבקאנד ללא-רציני.
- הדבר הפחות תקין העיקרי שנותר הוא משמעת worktree / archival, לא weakness בליבת runtime.

## Recommended Next Step

- לקבע את השינויים ב-commit/archival מסודר.
- להתחיל frontend על החוזים שכבר הוכחו, בלי לפתוח מחדש את QA העסקי שנסגר.
