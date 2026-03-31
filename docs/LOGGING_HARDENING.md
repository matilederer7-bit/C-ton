# Logging Hardening

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
