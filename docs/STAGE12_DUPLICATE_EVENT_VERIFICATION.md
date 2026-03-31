# Stage 12 Duplicate Event Verification

תאריך
- 2026-03-29

מטרת השלב
- להוכיח שאירוע חיצוני או לוגי כפול אינו מייצר שינוי כפול במערכת

הערת scope
- בריצה החיה אין כרגע endpoint פעיל ל-webhook provider חיצוני.
- ה-surface הרלוונטי בפועל הוא:
  `outbox_events`
  `payment_attempts`
  `idempotency_log`
  `webhook_events` כטבלת persistence מוכנה

## מה נבדק

1. duplicate של אותו `event_uuid` בדיוק
2. duplicate late של `charge_deal` עם payload זהה ו-`event_uuid` חדש
3. duplicate late של `recovery_deal`
4. duplicate late של `finalize_deal`
5. duplicate late של `refund_issue`
6. duplicate correlation ב-`payment_attempts`
7. duplicate `(provider, event_id)` ב-`webhook_events`

## איך נבדק

1. נוצר deal מבוקר:
- `c44a283e-73cc-413b-a583-146c5c73de20`

2. הדיל הועבר במסלול מלא עד:
- `CompletionWindow`
- participant יחיד ב-`ChargedSuccess`

3. הוזרקו duplicate events ישירות ל-`outbox_events`

4. נבדקו בפועל:
- `outbox_events`
- `outbox_dlq`
- `payment_attempts`
- `audit_log`
- state סופי של הדיל והמשתתף

## מה יצא בפועל

### 1. אותו `event_uuid` בדיוק

ניסיון insert עם אותו `event_uuid` של `charge_deal` קיים נכשל עם:
- `duplicate key value violates unique constraint "outbox_events_pkey"`

מסקנה
- אותו event identity בדיוק לא יכול להיכנס פעמיים ל-`outbox_events`

### 2. duplicate late של `charge_deal`

לפני התיקון
- duplicate late עם payload זהה ו-`event_uuid` חדש ירד ל-`DLQ`
- `last_error`:
  `State mismatch deal c44a283e-73cc-413b-a583-146c5c73de20 expected Charging`

פירוש
- האירוע הכפול לא יצר charge כפול
- אבל כן יצר תוצאה לא רצויה תפעולית: `DLQ` במקום ignore

תיקון שבוצע
- ב-`src/app.ts`
- בתחילת `handleChargeDealEvent`
- נוסף guard:
  אם הדיל כבר לא ב-`Charging` הפונקציה מחזירה מייד

אחרי התיקון
- duplicate late נוסף:
  `5348cfaa-b7ee-45e8-829f-21fe86061a38`
- סומן `sent`
- לא יצר `DLQ`
- לא יצר `payment_attempt` נוסף
- לא יצר `audit` נוסף

מסקנה
- duplicate late של `charge_deal` עכשיו ignored בפועל

### 3. duplicate late של `recovery_deal`

deal:
- `baefe692-cca7-43c9-a2d6-cbb95d0a931c`

תוצאה
- duplicate late סומן `sent`
- לא נוצר `payment_attempt` נוסף
- לא נוצר `audit` נוסף

### 4. duplicate late של `finalize_deal`

deal:
- `f1c53472-2bba-4cd4-b36b-c2dd3627dae1`

תוצאה
- duplicate late סומן `sent`
- לא נוצר `audit` נוסף
- לא נפתח מחדש state

### 5. duplicate late של `refund_issue`

deal:
- `8b4d63c7-c967-4160-a0ca-95d6afe6a502`

תוצאה
- duplicate late סומן `sent`
- לא נוצר `refund` attempt נוסף
- לא נוצר שינוי state נוסף

### 6. duplicate correlation ב-`payment_attempts`

ניסיון insert נוסף עם אותו:
- `participant_id`
- `deal_id`
- `attempt_type`
- `correlation_id`

תוצאה
- count נשאר `1 -> 1`

מסקנה
- duplicate logical attempt ignored ברמת unique index

### 7. duplicate `(provider, event_id)` ב-`webhook_events`

provider:
- `mockpay`

event_id:
- `dup-event-1`

תוצאה
- ה-insert השני נחסם ב-PK

מסקנה
- persistence של webhook event identity מוגנת

## מה הוכח

1. רק האירוע הראשון משפיע בפועל
2. duplicate exact identity נחסם ברמת persistence
3. duplicate late לא פותח מחדש state במסלולים שנבדקו
4. אין `payment_attempt` כפול לא לגיטימי במסלולים שנבדקו
5. אין `audit` כפול לא לגיטימי במסלולים שנבדקו
6. אין charge כפול
7. duplicate late של `charge_deal` תוקן כך שיהיה ignore ולא DLQ

## מה עדיין פתוח

1. אין blocker פתוח בשלב זה
2. אם בעתיד יופעל endpoint webhook runtime, יש לאמת שגם ברמת endpoint duplicate נרשם כ-ignored או log-only ולא רק נחסם ב-persistence

## פסק דין

- השלב עבר אחרי תיקון ממוקד אחד
- duplicate events במסלולים שנבדקו אינם יוצרים השפעה כפולה
