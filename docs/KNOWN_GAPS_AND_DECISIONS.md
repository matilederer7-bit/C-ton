# Known Gaps And Decisions

## Product Decisions That Stay Closed

- אין מגבלה על מספר buyers בעסקה.
- אין מגבלה על מספר joins של אותו buyer.
- אין `UNIQUE (deal_id, buyer_id)` כמגבלת מוצר.
- `max_units` הוא סף הכמות היחיד.
- finalize מוכרע לפי `ceil(0.9 * min_units)`.

## What Is Not Being Reopened

- webhook ingestion runtime duplicate handling, כל עוד אין endpoint ingestion חי במסלול הנוכחי
- יישור מלא של כל מסמכי `.docx` ההיסטוריים
- kill switch ייעודי ברמת מוצר

## Why These Are Not Blockers

- אין blocker פתוח בליבת המערכת או ב-hardening התפעולי שכבר נבדק.
- מה שנשאר הוא חיזוק מעטפת, לא פער שמערער את ה-runtime שהוכח.

## Current Non-Blocking Follow-Ups

- soak ארוך יותר בסביבת deployment דמוית production
- duplicate verification ב-webhook ingestion layer אם וכאשר endpoint כזה יופעל
- המשך ניקוי ואחוד legacy docs

## RC Execution Discipline Update

- זוהה במהלך RC שצריך לזהות גם orphan `processing` rows עם `processing_started_at IS NULL`.
- זה תוקן ברמת reclaim runtime וברמת runbook.
- לאחר התיקון זה אינו נחשב פער פתוח.
