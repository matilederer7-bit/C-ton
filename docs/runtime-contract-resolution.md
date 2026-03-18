# runtime-contract-resolution

מקור אמת לביצוע כעת

מקור האמת הביצועי הנוכחי הוא הקוד החי בsrc/app.ts יחד עם הhelpers הפעילים:
- src/outbox_worker_helpers.ts
- src/payment_attempt_helpers.ts

המסמכים בתיקיית docs הם מסמכי ייחוס מחייבים, אך במקרה של סתירה מול הקוד החי, הקוד החי הוא הקובע עד לעדכון תיעודי מסודר.

מטרת ההכרעה

למנוע מצב שבו:
1. הDB אוכף עולם אחד
2. הקוד רץ בעולם שני
3. המסמכים מתארים עולם שלישי

הכרעה מחייבת לשלב הנוכחי

1. הלקסיקון הרשמי הנוכחי נגזר מהקוד החי

2. event_type הרשמי הפעיל כעת הוא:
- charge_deal
- recovery_deal
- finalize_deal
- refund_issue
- deadline_check
- cancel_refund

3. attempt_type הרשמי הפעיל כעת הוא:
- charge_start
- recovery
- refund
- deadline_check
- cancel_refund

4. action_name הרשמי הפעיל כעת נגזר מהקוד החי, ובפרט כולל בין היתר:
- deal.publish
- deal.target_reached
- deal.close_joining
- deal.prepare_charging
- charging.start
- charging.capture_success
- charging.capture_failed
- charging.to_completion_window
- charging.recovery_success
- charging.recovery_failed
- charging.finalize_completed
- charging.finalize_failed
- refund.issue
- deal.complete_participant
- deal.fail_participant
- deal.fail_participant_after_completed
- deal.deadline_check
- deal.cancel

5. DB כבר יושר חלקית בפועל לקוד החי
- payment_attempts.attempt_type כולל גם deadline_check
- payment_attempts עבר הקשחת idempotency
- קיים unique index לוגי על:
  participant_id, deal_id, attempt_type, correlation_id

6. recovery אינו עוד שלב עתידי תיאורטי
- recovery כבר חלק מהזרימה הפעילה
- regression QA נקי הוכיח שהזרימה עובדת בפועל

פסק דין לשלב הנוכחי

נכון לעכשיו:
1. חוזה הruntime הפעיל הוכרע בפועל לפי הקוד החי
2. הזרימה הראשית והזרימות המשניות עברו regression QA
3. כל מסמך עתידי חייב להתיישר ללקסיקון זה, אלא אם מתקבלת החלטת refactor חדשה ומפורשת
