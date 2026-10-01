# Logging Hardening

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

תאריך
- 2026-03-30

## What Was Noisy

נמצא debug logging לא מקצועי כברירת מחדל:
- `src/db.ts` לוג של כל query
- `src/db.ts` לוג מפורט של כל שגיאת query
- `src/app.ts` לוגי `[JOIN]` מפורטים על כל join

## Fix Applied

- נוספה בקרה דרך `DEBUG_SQL_LOGGING=1`
- נוספה בקרה דרך `DEBUG_JOIN_LOGGING=1`
- ברירת המחדל כעת היא שקטה
- logger של Fastify נשאר פעיל דרך `LOG_LEVEL`

## What Remains Legitimate

- Fastify request logging
- application errors
- logs תפעוליים שצריך כדי להבין health ו-runtime failures

## Validation

- `npm test` עבר
- runtime validation עבר
- לא נשאר default mode שמדפיס כל query בלי opt-in

## Decision

- noisy debug logging נסגר.
- detailed logging נשמר רק תחת debug flags מפורשים.
