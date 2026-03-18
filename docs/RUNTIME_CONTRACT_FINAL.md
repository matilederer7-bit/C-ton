# Runtime Contract Final

מקור אמת ביצועי
הקובץ המחייב להרצה הוא src/app.ts

event_type רשמי
- charge_deal
- recovery_deal
- finalize_deal
- refund_issue
- deadline_check
- cancel_refund

attempt_type רשמי
- charge_start
- recovery
- refund
- cancel_refund

status רשמי של outbox_events
- pending
- processing
- sent
- failed

action_nameים שנמצאו ב-runtime
- charging.capture_failed
- charging.capture_success
- charging.finalize_completed
- charging.finalize_failed
- charging.recovery_failed
- charging.recovery_success
- charging.start
- charging.to_completion_window
- deal.cancel
- deal.close_joining
- deal.complete_participant
- deal.deadline_check
- deal.fail_participant
- deal.fail_participant_after_completed
- deal.prepare_charging
- deal.publish
- deal.target_reached
- participant.join_authorize
- refund.issue

אכיפות DB שקיימות בפועל
- immutability בסיסי על deals
- immutability בסיסי על participants
- audit enforcement על שינויי state
- outbox enforcement חלקי על מעברי deal מרכזיים
- CHECK סגור על outbox_events.event_type
- CHECK סגור על payment_attempts.attempt_type
- CHECK סגור על outbox_events.status כולל processing

מה הוכח בבדיקות
- recovery failure path עבד
- recovery success path עבד
- worker צורך outbox אמיתי
- payment_attempts נרשם
- outbox מסומן sent

פסק דין
ליבת המערכת תקינה ומבוצרה. מה שנשאר הוא housekeeping ותיעוד, לא תיקון ליבה.
