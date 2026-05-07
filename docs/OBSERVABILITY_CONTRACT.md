# Observability Contract

מסמך זה מגדיר את חוזה התצפית הפנימי של סיטון. המטרה היא שכל חקירת תקלה תוכל לחבר בין request, audit, outbox, worker, webhook, payment, invoice, payout ו-notification בלי ניחושים ובלי פעולות ידניות מסוכנות.

## מצב נוכחי

- תמיכת `correlation_id` קיימת בחלק מהמסילות: `payment_attempts`, `invoice_documents`, `webhook_events`, `outbox_events` וחלק מאירועי audit.
- הכיסוי עדיין חלקי ולא מובטח בכל request ובכל worker.
- `Admin Mission Control` מציג `correlation_id_support: partial` כאשר נמצאו ראיות, ו-`missing` כאשר אין קישור רוחבי.

## חוזה נדרש

1. כל request נכנס מקבל `request_id` יציב.
2. כל פעולה עסקית מקבלת `correlation_id` אחד שממשיך לכל שרשרת הפעולה.
3. כל רשומת `audit_log` שומרת `request_id` ו-`correlation_id`.
4. כל `outbox_events` ו-`outbox_dlq` שומרים `correlation_id`.
5. כל worker log שומר `correlation_id`, `event_id`, `aggregate_type`, `aggregate_id`, attempt ו-result.
6. כל webhook processing שומר `provider`, `provider_event_id`, `correlation_id` אם קיים, וקישור ל-`deal_id`/`participant_id` כאשר ניתן.
7. כל `payment_attempts` שומר `provider_reference`, `provider_request_id` אם קיים, ו-`correlation_id`.
8. כל invoice/payout/notification שומר provider reference ו-`correlation_id`.
9. raw payloads לא מוחזרים ל-admin UI. מוצגים summary masked בלבד.

## כללים

- לא מייצרים correlation מזויף בדיעבד.
- אם correlation לא ודאי, מציגים “לא ידוע”.
- תיקון state או כסף לא מתבצע דרך Observability.
- פעולות רגישות קיימות בלבד חייבות reason, rate limit ו-audit.

## שלב הבא

להוסיף middleware בקצה ה-HTTP שמייצר `request_id`, להעביר אותו ל-context של פעולות ה-domain, ולחייב כתיבה עקבית בכל audit/outbox/provider adapter.
