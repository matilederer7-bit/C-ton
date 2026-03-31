# Stage 12 Restart And Outbox Recovery

תאריך
- 2026-03-30

מטרת השלב
- להוכיח שהמערכת מתאוששת נכון בזמן restart כאשר קיימת עבודה חיה ב-outbox ותחת עומס פעיל

איך נבדק
- הופעל load runner עם prefix:
  `stage12-restart2-1774817815139`
- במהלך הריצה בוצעו שני restarts:
  1. restart מהיר
  2. restart נוסף עם השהיה קצרה של כמה שניות
- אחרי כל restart נבדק `health`
- לאחר סיום הריצה נבדקו נתוני DB עבור prefix הבדיקה

מה נבדק בפועל
- pending תחת restart
- processing תחת restart
- live load בזמן restart
- outbox recovery אחרי restart
- stuck processing
- retries
- DLQ

מה יצא בפועל
- `health` חזר תקין אחרי שני ה-restarts
- `30` deals נוצרו במהלך הבדיקה
- כל `30` הדילים הגיעו ל-`CompletionWindow`
- `charge_deal sent = 30`
- `recovery_deal sent = 2`
- `finalize_deal pending = 30`
- `DLQ = 0`
- `processing rows = 0`
- `stuck processing > 30s = 0`
- נצפו retries נקודתיים שהסתיימו ב-`sent`

מה הוכח
1. אין אובדן אירוע
2. אין כפילות עיבוד לא תקינה
3. אין outbox stuck על `processing`
4. אין state stuck
5. יש התאוששות תקינה אחרי restart
6. מנגנון reclaim/recovery מוכח בפועל

מה עדיין פתוח
- אין blocker פתוח בשלב restart recovery

פסק דין
- השלב עבר
