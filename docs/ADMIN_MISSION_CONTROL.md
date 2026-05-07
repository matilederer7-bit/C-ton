# Admin Mission Control

`Admin Mission Control` הוא מרכז התצפית והתפעול הפנימי של סיטון. הוא מיועד לאדמין בלבד, מוגן על ידי `x-admin-key`, ופועל כמשטח read-only לציד תקלות מקצה לקצה.

## Endpoints

- `GET /api/admin/mission-control`
- `GET /api/admin/mission-control/anomalies`
- `GET /api/admin/mission-control/deals/:dealId/trace`
- `GET /api/admin/mission-control/participants/:participantId/trace`
- `GET /api/admin/mission-control/correlation/:correlationId`
- `GET /api/admin/mission-control/outbox/:eventId`
- `GET /api/admin/mission-control/webhooks/:provider/:eventId`

כל endpoints החדשים הם GET/read-only. אין שינוי state, אין capture/refund/void, אין payout ידני, אין מחיקה מ-DLQ ואין replay שמשנה state.

## Sections

ה-response המרכזי כולל:

- `system_summary`
- `frontend_surface`
- `api_surface`
- `database`
- `state_machine_integrity`
- `outbox`
- `workers`
- `webhooks`
- `payments`
- `invoices`
- `payouts`
- `notifications`
- `security`
- `storage_uploads`
- `performance`
- `business_metrics`
- `anomaly_center`
- `recommended_actions`

ה-UI ב-`/app/admin` מציג את הסקשנים בעברית/RTL, כולל כרטיסי מצב עליונים, `Anomaly Center`, אירועים אחרונים, pause polling, refresh now, badge לנתונים לא עדכניים, וסקשנים מפורטים שאינם JSON גולמי.

## Verdict

- `red`: כשל קריטי או חשד לפגיעה בכסף, state, webhooks, outbox, DB או security.
- `yellow`: חריגה לא חוסמת, latency גבוה, retries, מידע לא ודאי, config חסר בסביבה לא פעילה או נתונים לא עדכניים.
- `green`: רק כאשר הבדיקות הקיימות מצאו ראיות תקינות.

כאשר מידע לא ניתן לבדיקה הוא מוצג כ-`unknown` או “לא ידוע”, לא כהצלחה.

## Anomalies

המערכת מזהה בין היתר:

- טבלאות קריטיות חסרות.
- DLQ או outbox failed/over max attempts.
- webhooks failed או pending too long.
- עסקה Completed ללא ChargedSuccess/RecoveredCharge.
- יחידות מעל `max_units`.
- עסקאות תקועות ב-Charging/ReadyForCharging.
- payment attempts במצב unknown או retry storm.
- invoice, payout או notification failures.
- admin/debug security posture מסוכן.
- בעיות frontend סטטיות כגון נכסים חסרים או RTL/lang חסר.

כל anomaly כולל severity, domain, evidence, affected entities, recommended next step ו-link ל-trace כאשר ניתן.

## Allowed Admin Actions

מותר:

- צפייה ו-drill-down.
- פתיחת פרופיל עסקה/משתתף קיים.
- העתקת entity/correlation id מהדפדפן.
- פתיחת support case דרך המסלול הקיים.
- ניווט ל-outbox/webhook/deal/participant.

## Forbidden Actions

אסור ומושבת במפורש:

- manual capture.
- manual refund.
- manual void.
- manual payout.
- manual state edit.
- manual DB patch.
- delete event.
- clear DLQ בלי טיפול.
- mark as resolved בלי ראיה.
- webhook replay שמשנה state בלי contract idempotent ברור.

## Security

- אין החזרת API keys, tokens, webhook secrets, DB URLs, cookies או authorization headers.
- env מוחזר כ-presence בלבד: `configured: true/false`.
- payloads של outbox/webhook מוצגים כ-summary masked בלבד.
- כל admin endpoint משתמש ב-`requireAdminKey`.

## What Is Unknown

- telemetry פיזי של חומרה אינו זמין מתוך runtime ענני. מוצג `hardware_visibility: unavailable`.
- correlation רוחבי עדיין חלקי. ראו `docs/OBSERVABILITY_CONTRACT.md`.
- rate limit ו-CORS מוצגים כ-unknown כאשר אין מקור אמת בטוח.

## Tests

הרצה ייעודית:

```bash
npm run test:mission-control
```

Compile:

```bash
npx tsc --noEmit
```

הבדיקה מכסה auth, response contract, masking, anomalies endpoint, no destructive actions ו-drill-down auth.

## Next Step

להעמיק את חוזה ה-correlation ברמת middleware ו-worker כך שכל request, audit, outbox, webhook ו-provider reference יקבלו מזהה חקירה אחד עקבי.
