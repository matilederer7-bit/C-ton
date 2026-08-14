# אבחון חי מצומצם — Stage 32B

- תאריך תצפית: 2026-08-14
- אפליקציה: ראש גשר
- appId: 6a79b3ce58f678716af8d295
- אופן הבדיקה: כלי Base44 לקריאה בלבד

לא נשמר בקובץ זה payload גולמי, מידע אישי, סוד או פרטי התחברות.

## גישה והיקף

- list_user_apps אימת גישה חיה לאפליקציה ולמזהה.
- list_entity_schemas, list_directory, read_file, grep ו-query_entities שימשו
  לקריאת סכמות, קוד ורשומות טכניות מצומצמות.
- לא הופעלו פונקציות backend, workers, Join, תשלום, מייל או SMS.
- לא בוצעו create/update/delete, כתיבת קובץ, שינוי סכמה, checkpoint, Deploy או
  Publish.

## תמונת מצב מלאה

| משאב | ספירה שנצפתה |
|---|---:|
| Deal | 9 |
| מעברי Deal בתוך transition_journal | 6 |
| DealAudit | 4 |
| OutboxEvent | 1 |
| OutboxDeadLetter | 0 |
| WorkerHeartbeat schema | לא קיים |

ארבעת ה-Audit הקיימים תואמים לארבעה מתוך ששת המעברים. לכן מספר המעברים החסרים
בפועל הוא בדיוק שניים, ולא הנחה מהדוח הקודם.

## חריגת מלאי

מזהה: f2bce36d-0176-4f7e-90ee-3425b5128182

| נתון | מצב נוכחי |
|---|---|
| Deal state | PendingTarget |
| max_units | 1 |
| reserved_units | 2 |
| reservations מוטמעות פעילות | 2, יחידה אחת כל אחת |
| Participant projections | 0 |
| MoneyLedgerEvent rows | 0 |
| נוצר | 2026-08-11T04:56:19.589Z |

החריגה עצמה חד-משמעית: 2 גדול מ-1. התיקון אינו חד-משמעי. שני ה-reservations
נראות פעילות, אין Participant או ledger שמכריע מי מהן תקפה, ושדה
inventory_sync_status אינו מצביע על projection שניתן לאמת. מקור המלאי הקנוני
הוא siton-inventory-bridge מול Supabase, אך הפעלת function לא הייתה ברשימת כלי
הקריאה המותרים ולכן לא הופעלה.

מסקנת repair: blocked — inventory_canonical_overage_unresolved /
inventory_evidence_ambiguous. אסור לבחור reservation לפי זמן יצירה בלבד,
למחוק אותה, לשנות qty או להגדיל max_units.

## Lease שפג

מזהה: 00000000-0000-4000-8000-000000000951

| נתון | מצב נוכחי |
|---|---|
| aggregate Deal | 00000000-0000-4000-8000-000000000904 |
| event_type | charge_deal |
| status | processing |
| attempt_count / max_attempts | 2 / 4 |
| lease owner | קיים |
| lease_expires_at | 2026-08-10T19:05:30.000Z |
| DLQ תואם | אין |
| נוצר | 2026-08-10T19:02:55.634Z |

ה-Lease פג בבירור ועדיין processing. עם זאת אין Entity מסוג WorkerHeartbeat,
ולכן אי אפשר להוכיח בקריאה בלבד שה-owner הישן אינו פעיל. בנוסף סכמת
OutboxEvent החיה אינה כוללת lease_generation או Audit lifecycle.

הקוד החי שנקרא:

- base44/functions/worker-claim-outbox/entry.ts — claim מותנה אך reclaim מאפס
  leases שפגו לפני claim וללא lifecycle Audit.
- base44/functions/worker-heartbeat-outbox/entry.ts — heartbeat בודק owner
  ותפוגה.
- base44/functions/worker-finish-outbox/entry.ts — completion בודק owner
  ותפוגה, אך מסלולי retry/DLQ אינם משתמשים ב-generation.

מסקנת repair: `blocked/quarantined`. זהו סיווג אבחוני בלבד; הרשומה החיה נשארה
`processing` ולא שונתה. אסור ל-requeue אותה ל-`pending` או לעבד אותה באמצעות
תיקון lease כללי, משום שסוגה `charge_deal` ועלול להגיע למסילת כסף. גם לאחר
פריסת generation/Audit והוכחת owner inactivity יידרשו reconciliation ייעודי
למסילת הכסף ואישור מפורש נפרד.

## שני Audit חסרים

### Deal 00000000-0000-4000-8000-000000000902

- מעבר: PendingTarget אל TargetReached.
- action מקורי: deal.target_reached.
- request_id: probe.
- idempotency_key:
  target-reached:00000000-0000-4000-8000-000000000902.
- transition occurred_at: חסר ברשומת `transition_journal`.
- זמני Entity שנצפו: `created_date=2026-08-10T18:09:56.066000`,
  `updated_date=2026-08-10T18:14:12.060000`.
- Audit תואם: אין.

זמני היצירה והעדכון הם זמני רשומת ה-Entity, ואינם הוכחה לזמן שבו המעבר
התרחש. לכן אין ראיית `occurred_at` קנונית, התוכנית חסומה ונכשלת סגור; אסור
להסיק זמן מעבר או ליצור backfill עד שתימצא ראיית מקור מתאימה. apply לא הופעל.

### Deal 00000000-0000-4000-8000-000000000904

- מעבר: ReadyForCharging אל Charging.
- action מקורי: charging.start.
- idempotency_key: probe-start.
- request_id ו-transition occurred_at אינם קיימים ברשומת המעבר ההיסטורית.
- זמני Entity שנצפו: `created_date=2026-08-10T18:39:35.791000`,
  `updated_date=2026-08-10T18:39:51.131000`.
- Audit תואם: אין.

המעבר עצמו ברור, אך ראיית ה-Audit אינה מלאה. זמני ה-Entity אינם הוכחה לזמן
המעבר. מנגנון 32B אינו ממציא request ID או זמן מקורי; לכן התוכנית נכשלת סגור
עד ראיית מקור נוספת שמוכיחה את ה-transition occurred_at ואת יתר שדות המקור.

בנוסף, ה-Deal מכיל Outbox מוטמע עם מזהה 00000000-0000-4000-8000-000000000942,
בעוד רשומת OutboxEvent היחידה היא 00000000-0000-4000-8000-000000000951.
הפער הוא ראיית projection נוספת המחייבת reconcile לפני עיבוד.

## מה אומת ומה לא

אומת:

- גישה חיה לאפליקציה;
- כל 9 ה-Deals וכל 6 מעברי ה-Deal;
- בדיוק שתי רשומות Audit חסרות;
- חריגת 2 מול 1;
- Outbox processing יחיד עם lease שפג;
- אפס DLQ;
- היעדר WorkerHeartbeat schema;
- קוד claim/heartbeat/finish החי.

לא אומת בגלל גבול הקריאה:

- projection חי של Supabase דרך siton-inventory-bridge;
- מצב authorization/provider של שתי ה-reservations;
- חיות תהליך ה-worker הישן מחוץ ל-Base44 entities;
- השפעה של mutation, reclaim או backfill חי;
- כל מסילת תשלום, מייל או SMS.

## סדר apply עתידי מומלץ

1. לפרוס לאחר review את generation, lifecycle Audit ואת adapter ה-repair
   הקנוני; להשאיר worker חיצוני וכסף חסומים.
2. להריץ inspect ו-dry-run מחדש על מזהים מפורשים ולהשוות plan hash.
3. להשלים ראיית Supabase/provider עבור חריגת המלאי. אם אין הכרעה — לא לתקן.
4. להשאיר את backfill של 902 ושל 904 חסום עד ראיית מקור שמוכיחה את זמן המעבר;
   זמני created/updated של ה-Entity אינם תחליף ל-transition occurred_at.
5. להשאיר את אירוע ה-`charge_deal` בהסגר תפעולי: לא להעביר ל-`pending` ולא
   לעבד. טיפול עתידי דורש reconciliation ייעודי למסילת הכסף, הוכחת owner
   inactivity ואישור מפורש נפרד.
6. להריץ שוב Canonical Integrity Gate ולתעד before/after ללא מידע אישי.

כל apply דורש אישור מפורש נפרד. לא בוצע apply בריצה זו.
