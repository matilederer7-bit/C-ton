# PROJECT STATUS

תאריך עדכון: 2026-03-17

## תמונת מצב נוכחית

המערכת מתקמפלת בהצלחה.
health check תקין.
השרת עולה תקין עם:
node --loader ts-node/esm src/app.ts

בוצע רפקטור משמעותי ל-worker ב-app.ts תוך חילוץ handlers ייעודיים.
בוצע גם יישור DB משלים בעקבות QA.

handlers שחולצו:
- handleRefundEvent
- handleChargeDealEvent
- handleRecoveryDealEvent
- handleFinalizeDealEvent

dispatch נוכחי ב-worker:
- deadline_check נשאר inline
- charge_deal מועבר ל-handleChargeDealEvent
- recovery_deal מועבר ל-handleRecoveryDealEvent
- finalize_deal מועבר ל-handleFinalizeDealEvent
- refund_issue ו-cancel_refund מועברים ל-handleRefundEvent

## מה הושלם

1. ניקוי workspace
- קבצי legacy הועברו ל-archive/legacy_review
- קבצי ops הועברו ל-archive/ops_scripts
- גיבויי refactor הועברו ל-archive/refactor_backups

2. ייצוב TypeScript
- tsconfig צומצם כך שיכלול רק src/**/*.ts
- archive, node_modules, docs מוחרגים
- npx tsc --noEmit עובר בהצלחה

3. ייצוב runtime
- package.json עודכן להרצה עם:
  node --loader ts-node/esm src/app.ts
- health check מחזיר {"ok":true}

4. רפקטור worker
- outbox helper חולץ ל-src/outbox_worker_helpers.ts
- payment attempt helper חולץ ל-src/payment_attempt_helpers.ts
- refund handler חולץ
- charge handler חולץ
- recovery handler חולץ
- finalize handler חולץ

5. יישור DB לאחר QA
- payment_attempts עודכן לוגית ל-idempotent insert באמצעות ON CONFLICT DO NOTHING
- נוצר migration:
  src/migrations/012_payment_attempts_idempotency.sql
- נוספה תמיכה ב-attempt_type = deadline_check
- נוקו duplicates היסטוריים ב-payment_attempts
- נוצר unique index לוגי על:
  participant_id, deal_id, attempt_type, correlation_id

6. תיקון outbox DLQ
- הוחלף INSERT ... SELECT * לכתיבה מפורשת לפי עמודות
- נמנע mismatch בין outbox_events לבין outbox_dlq

## QA שבוצע

1. QA היסטורי לפני הרפקטור
- join
- charging
- finalize
- outbox
- recovery
- retry
- sent_at
- finalize readiness

2. QA אחרי הרפקטור
- compile check
- health check
- spot checks על handlers
- spot checks על dispatch map
- regression flow מלא על deal נקי

3. regression נקי סופי שעבר
זרימה:
- create deal
- publish
- join buyer-a
- join buyer-b
- close_joining
- prepare_charging
- charging/start
- worker processing
- מעבר ל-CompletionWindow
- יצירת finalize_deal
- recovery_deal נשלח במידת הצורך

תוצאת regression סופי:
- deal הגיע ל-CompletionWindow
- outbox עבד תקין
- recovery עבד תקין
- payment_attempts לא יצר כפילות חריגה
- לא נרשמה DLQ בבדיקה הסופית

## מה פתוח

1. יישור תיעודי
יש ליישר בין:
- הקוד החי
- docs/runtime-contract-resolution.md
- docs/db-drift-resolution.md
- שאר המסמכים המחייבים בתיקיית docs

2. החלטת המשך
להחליט האם:
- מחלצים גם deadline_check
- או משאירים אותו inline
- או עוברים ישירות לשלב הבא בבקאנד

## הערכת מצב

- רפקטור worker handlers: 100%
- ניקוי workspace: 100%
- compile stability: 100%
- runtime stability: 100%
- DB alignment critical fixes: 100%
- regression QA אחרי הרפקטור: 100%
- סגירת שלב הרפקטור המקומי: 100%

השלב הנוכחי בכללותו:
- רפקטור + אימות: 100%
- תיעוד ויישור מסמכים: עדיין פתוח

## הצעד הבא המומלץ

1. לעדכן את מסמכי runtime ו-DB לפי הקוד החי
2. להחליט אם deadline_check נשאר inline
3. רק לאחר יישור מסמכים, לעבור לשלב הבא

## 2026-03-18 ניקיון מבני וארכוב

מה הושלם
- בוצע מיפוי housekeeping מלא לריפו
- קבצי עזר זמניים מהשורש הועברו לארכיון מסודר תחת archive/housekeeping_2026-03-18/root_temp
- קבצי תיקון חד פעמיים וגיבויי ביניים מתוך src הועברו לארכיון תחת archive/housekeeping_2026-03-18/src_temp
- מסמך כפול פוטנציאלי RUNTIME_CONTRACT_FINAL.md הועבר לארכיון תיעודי ולא נמחק
- דו"ח הבדיקה הועבר לארכיון reports
- .gitignore עודכן כדי לצמצם רעש עתידי

מה נבדק
- הליבה נשארה במקומה: src/app.ts, helpers, migrations, scripts, docs המרכזיים
- לא בוצעה מחיקה של ליבת קוד
- הארכוב בוצע בהעברה, לא במחיקה לצמיתות

מה פתוח
- בהמשך אפשר לבצע מעבר נוסף של scripts אם יתגלה שחלקם חד פעמיים בלבד
- בהמשך אפשר להכריע אם יש צורך להשאיר את כל מסמכי ה docx תחת git

אחוזים
- ניקיון מבני: 90%
- ליבת הבקנד: נשמרה
- תיעוד סטטוס: עודכן

הצעד הבא
- בדיקת git status סופית
- commit מסודר של פעולת הניקיון אם התמונה נקייה
