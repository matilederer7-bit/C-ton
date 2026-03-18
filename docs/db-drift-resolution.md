# db-drift-resolution

מצב נוכחי

המסמך הזה עודכן לאחר השלמת רפקטור worker, יישור DB קריטי וregression QA מלא.

מקור האמת המחייב כעת

מקור האמת המחייב הוא הקוד החי:
- src/app.ts
- src/outbox_worker_helpers.ts
- src/payment_attempt_helpers.ts

המסמכים ההיסטוריים:
- חוקה לדאטה בייס v1.2
- DB clean v1.2

נשארים מסמכי ייחוס חשובים, אך אינם גוברים על הקוד החי כאשר קיימת סתירה.

הכרעות שננעלו

1. event_type רשמי פעיל
- charge_deal
- recovery_deal
- finalize_deal
- refund_issue
- deadline_check
- cancel_refund

2. attempt_type רשמי פעיל
- charge_start
- recovery
- refund
- deadline_check
- cancel_refund

3. payment_attempts
- נוספה הקשחת idempotency ברמת הקוד
- נוצר unique index לוגי על:
  participant_id, deal_id, attempt_type, correlation_id
- נוקו duplicates היסטוריים לפני יצירת הunique index

4. outbox DLQ
- בוצע יישור בין outbox_events לבין outbox_dlq
- בוטל שימוש בINSERT ... SELECT * לטובת רשימת עמודות מפורשת
- mismatch סכמות תוקן

5. locked_at
- קיים כחלק ממודל outbox
- לא הוכרע במסמך זה כשדה עסקי נוסף מעבר למה שרץ בפועל
- כל הקשחה נוספת סביבו תיעשה רק במסגרת refactor/DB alignment נפרד

6. webhook_events
- לא חלק מהזרימה הפעילה הנוכחית
- לא נחשב רכיב runtime מחייב בשלב זה

7. action_name
הרשימה הרשמית לשלב הנוכחי נגזרת מהקוד החי, ולא מהרשימות ההיסטוריות במסמכים ישנים.
אין להשתמש עוד ברשימות ישנות שאינן תואמות לapp.ts.

מדיניות יישור

1. קודם הקוד החי
2. אחר כך יישור DB
3. אחר כך יישור מסמכים
4. רק לאחר מכן מוסיפים hard checks נוספים

מה נסגר בפועל

1. רפקטור worker הושלם
2. DB alignment קריטי הושלם
3. regression QA אחרי הרפקטור הושלם
4. המסמך הישן עם לקסיקון כמו:
- enqueue_charge_job
- enqueue_recovery_job
- enqueue_finalize_job
- process_webhook
- reconcile

אינו משקף עוד את המערכת החיה ואין להשתמש בו כמקור לקסיקון פעיל.

סטטוס

- רפקטור: הושלם
- DB critical alignment: הושלם
- runtime alignment: הושלם
- documentation alignment: הושלם לשלב הנוכחי
