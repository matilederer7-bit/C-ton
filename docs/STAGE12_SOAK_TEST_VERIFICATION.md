# Stage 12 Soak Test Verification

תאריך
- 2026-03-30

מטרת השלב
- להוכיח יציבות תחת traffic רציף לאורך זמן, ולא רק burst קצר

איך נבדק
- רץ soak test על ה-API החי עם prefix:
  `stage12-soak-1774816401952`
- flow חוזר לכל iteration:
  create
  publish
  join
  close_joining
  prepare_charging
  charging/start
- snapshots נאספו במהלך הריצה ובסופה

מה נבדק בפועל
- latency
- error rate
- outbox growth
- payment_attempt growth
- audit growth
- stuck processing
- retries
- DLQ

מה יצא בפועל
- deals שנוצרו: `107`
- requests שנשלחו: `642`
- failures: `0`
- error rate: `0`

latency overall
- avg: `10ms`
- p50: `7ms`
- p95: `19ms`
- max: `157ms`

state סופי
- כל `107` הדילים הגיעו ל-`CompletionWindow`

outbox סופי
- `charge_deal sent = 107`
- `recovery_deal sent = 15`
- `finalize_deal pending = 107`

growth תפעולי
- `payment_attempts = 122`
- `audit_rows = 1635`
- `DLQ = 0`
- `stuck processing > 30s = 0`

retries
- נצפו retries נקודתיים על `charge_deal` ו-`recovery_deal`
- כולם הסתיימו ב-`sent`
- לא נצפה retry storm לא נשלט

פירוש growth
- `finalize_deal` נשאר `pending` כצפוי, משום שחלון ההשלמה עתידי
- זה growth מוסבר, לא זליגה שקטה

מה הוכח
1. המערכת נשארת יציבה לאורך זמן תחת traffic רציף
2. לא נצפתה הידרדרות מהותית בזמני תגובה
3. לא נצפה outbox stuck
4. לא נצפה DLQ תחת ה-soak הזה
5. retries נשארו נשלטים וסופיים
6. לא נצפתה דליפה לוגית

מה עדיין פתוח
- soak ארוך עוד יותר אפשרי כהרחבה, אך אינו blocker לפי הממצאים כאן

פסק דין
- השלב עבר
