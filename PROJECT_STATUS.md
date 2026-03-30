
## 2026-03-30 - Frontend Core Execution

סטטוס כללי
הושלם

הכרעה
FRONTEND CORE BUILT

מה הושלם בפרונטד
- חיבור runtime של הפרונט לשרת ב־`src/app.ts`
- shell ו־SPA בסיסי תחת `frontend/`
- public deal page
- join flow עם בחירת כמות וולידציה
- OTP start / verify
- payment authorization mock step
- confirmation screen
- tracking page

מה אומת
- `npm test` עבר
- `npx tsc --noEmit` עבר
- runtime validation הושלם דרך `compile + node`
- `/health` החזיר תקין
- מסלולי `/app/*` החזירו `200`
- `public deal` עבד מול backend חי
- `OTP start / verify` עבדו מול backend חי
- `payment authorize mock` עבד מול backend חי
- `join` יצר `participant_id` אמיתי
- `tracking` החזיר state אמיתי של participant
- שגיאות בסיס אומתו:
  - deal not found -> `404`
  - invalid OTP -> `400`
  - payment failure -> `402`
  - over-capacity join -> `409`

מה partial
- אין עדיין browser automation
- payment נשאר mock-backed
- דף הבית מינימלי ומכוון link-entry, לא discovery surface מלא

מה עדיין פתוח
- happy-path ידני בבוקר מתוך browser אמיתי
- החלטה האם השלב הבא הוא browser automation או polish/copy

אחוז התקדמות משוער של הפרונטד
82 אחוז

הצעד הבא
להריץ מעבר ידני אחד בדפדפן על עסקה מפורסמת, ואז לבחור בין אוטומציית E2E לבין חידוד UX/copy

## 2026-03-30 - Frontend MVP Tightening Pass

סטטוס כללי
הושלם

הכרעה
FRONTEND MVP NEAR-CLOSED

מה הושלם בפרונטד
- tightening משמעותי של UX במסלול הקונה
- copy ברור יותר לאורך deal / OTP / payment / confirmation / tracking
- recovery states עבור session חלקי או חסר
- TTL ל-`sessionStorage`
- חיזוק tracking עם journey ברור ו-next step ברור
- חיזוק תחושת production-like של payment authorization mock

מה שופר
- draft deal מוצג עכשיו באופן ברור כלא-joinable
- payment ו-confirmation כבר לא נשענים על redirectים שבירים בלבד
- tracking מסביר טוב יותר מה קרה ומה יקרה בהמשך
- הקונה יכול להמשיך מסלול פתוח מהעסקה או להתחיל מחדש

מה אומת
- `node --check frontend/app.js`
- `npx tsc --noEmit`
- `npm test`
- runtime validation pass 2 דרך `compile + node`
- live backend validation עבור:
  - public deal page
  - draft deal page
  - OTP start / verify
  - payment authorization success
  - join success
  - tracking success
  - routes: deal / OTP / payment / confirmation / tracking
- error branches:
  - unknown deal -> `404`
  - invalid OTP -> `400`
  - payment failure -> `402`
  - over-capacity join -> `409`

מה נשאר פתוח
- browser automation happy path
- real payment integration במקום mock provider
- polish/copy review נוסף אם רוצים להעלות את רמת התחושה עוד צעד

אחוז התקדמות משוער חדש של הפרונטד
91 אחוז

הצעד הבא
מעבר ידני אחד בדפדפן על עסקה חיה ואז בחירה בין browser automation לבין real payment integration

## 2026-03-30 - Frontend Customer Flow Closure Pass

סטטוס כללי
הושלם

הכרעה
FRONTEND MVP CLOSED WITH NON-BLOCKING FOLLOW-UPS

מה הושלם בבקאנד
- הבקאנד נשאר סגור מקצועית וללא פתיחה מחדש של הכרעות הליבה

מה הושלם בפרונטד
- polling קל למסכי deal ו-tracking
- silent refresh coherence בזמן חזרה לחלון
- service boundary ברור יותר ל-payment authorization ול-join
- אוטומציית validation פרקטית למסלול הקונה דרך `tests/frontend_flow_validation.ts`
- הרחבת `npm test` כך שתכלול גם frontend validation

מה נבדק
- `node --check frontend/app.js`
- `npx tsc --noEmit`
- `npm test`
- כיסוי אוטומטי ל:
  - asset delivery
  - public deal shell
  - draft deal behavior
  - OTP start / verify
  - payment authorization mock
  - join success
  - tracking success
  - error branches

מה partial
- payment עדיין mock-backed
- full browser automation עדיין לא קיים
- דף הבית נשאר מינימלי יחסית

אחוז התקדמות חדש של הפרונטד
95 אחוז

הצעד הבא
להחליט אם השלב הבא הוא real payment integration או browser automation, מבלי לפתוח מחדש את ה-core buyer flow

## Stage 8H  מבחן עומס קיצון 2700 על תקרת 1800

הושלם
בוצע מבחן עומס של 2700 ניסיונות join כמעט במקביל
המערכת החזירה בדיוק 1800 הצלחות ו 900 דחיות
לא נרשמו סטטוסים חריגים
לא הייתה חריגה מעל max_units
לא הייתה חריגה מעל מספר המשתתפים המותר
הדיל נשאר במצב TargetReached

נבדק
אכיפת קיבולת תחת concurrency גבוה מאוד
התאמה בין מספר תשובות 200 לבין הכמות בפועל במסד
התאמה בין מספר המשתתפים בפועל לבין תקרת העסקה

פתוח
בדיקת עקביות מפורטת לפי buyer_state ו money_state
בדיקת התאמה לכלל המחייב שלפיו אין מגבלה על רכישות חוזרות של אותו buyer
בדיקת audit_log ו outbox_events לאחר מבחן הקיצון
בדיקות המשך על חוק ה 90 אחוז במסלול charging וה finalize

הערכת מצב
מנגנון max_units תחת עומס קיצון נראה כרגע יציב ומשכנע

אחוז התקדמות
68 אחוז

הצעד הבא
בדיקת consistency עמוקה אחרי המבחן ולאחריה מעבר למסלולי charging recovery finalize

עדכון Stage 8H
מבחן העומס עצמו עבר בהצלחה מלאה
בדיקת ההמשך הראשונה נפלה בגלל שימוש בשם עמודה שגוי בסקריפט הבדיקה
בטבלת participants העמודה הרלוונטית היא buyer_id ולא user_id
לא זוהתה בשלב זה אינדיקציה לכשל לוגי במנגנון הקיבולת עצמו
המשך הבדיקה מתבצע עם סקריפט מתוקן

עדכון טיפול בסדקים לפני המשך
נעצר קידום לשלב charging עד למיפוי מלא של published_at ושל מבנה audit במסלול join
נבדקת כעת האפשרות ש published_at ריק בגלל מסלול יצירת דיל לטסט ולא בגלל כשל לוגי
נבדקת כעת האפשרות ש 3600 רשומות audit משקפות שתי רשומות לכל join
אחת ל buyer_state ואחת ל money_state
רק לאחר הוכחה או הפרכה של שני ההסברים נמשיך הלאה

עדכון כלל מוצר מחייב
הוחלט סופית כי אין כל מגבלה על מספר הקונים בעסקה
הוחלט סופית כי אין כל מגבלה על מספר רכישות חוזרות של אותו buyer באותה עסקה
אותו buyer רשאי לרכוש את כל הכמות בבת אחת או ברצף פעולות join נפרדות
האכיפה היחידה היא על הכמות הכוללת המותרת בעסקה לפי max_units
מכאן נגזר שאין להחיל unique על deal_id עם buyer_id ואין להחיל מגבלת קונים נפרדת או מגבלת רכישות חוזרות בשום שכבה
כל סתירה לכך בקוד, במסד הנתונים או במסמכים מחייבת תיקון


## כלל מוצר קנוני  קיבולת העסקה

הכלל המחייב הוא זה:
אין כל מגבלה על מספר הקונים בעסקה.
אין כל מגבלה על מספר פעולות join של אותו buyer באותה עסקה.
אין כל מגבלה על סך היחידות ש buyer בודד יכול לרכוש, כל עוד לא נחצתה הכמות הכוללת המותרת בעסקה.
האכיפה היחידה היא על הכמות הכוללת של העסקה לפי max_units.
אם נשארו 4 יחידות בלבד, כל בקשה מעל 4 חייבת להידחות או להיות מטופלת לפי חוקי הקיבולת של המערכת.
כל טקסט ישן שמרמז על buyer יחיד, participant יחיד ל buyer, או איסור על רכישה חוזרת, מבוטל.

## 2026-03-29 - Stage 11 Publish QA

סטטוס כללי
הושלם

אחוז התקדמות כולל
84%

מה נבדק
- בוצע publish תקני על הדיל `0272459e-c214-4db3-81d8-0b7258975c40`
- נבדק מצב לפני publish
- נבדק מצב אחרי publish
- נבדקה רשומת outbox שנוצרה
- נבדקה רשומת audit שנוצרה
- נבדקה רשומת idempotency שנוצרה
- נבדק replay עם אותו idempotency key
- נבדקה חסימת שינוי שדה קריטי אחרי publish

מה הוכח
- לפני publish הדיל היה ב-`Draft`
- אחרי publish הדיל עבר ל-`PendingTarget`
- `published_at` נקבע בפועל
- `threshold_units` נשאר עקבי על `9` עבור `min_units = 10`
- נוצר `deadline_check` ב-`outbox_events` עם `available_at` לפי `deadline`
- נרשמה רשומת `audit_log` תקינה עבור `deal.publish`
- נרשמה רשומת `idempotency_log` תקינה עבור `deal.publish`
- replay עם אותו `idempotency-key` החזיר `replay = true`
- ניסיון `UPDATE` ישיר ל-`price_per_unit` אחרי publish נחסם עם:
  `deals.price_per_unit is immutable after publish`

סדק שזוהה ונסגר
- זוהה שסדר הפעולות ב-`atomicMultiTransition` עלול לגרום לכשל publish מול constraint של `published_at`
- בוצע תיקון נקודתי כך ש-`insideTx` ירוץ לפני עדכון ה-state
- לאחר התיקון publish עבר תקין

מה פתוח
- charging flow
- recovery flow
- finalize flow
- הוכחת כלל 90 אחוז מקצה לקצה

הצעד הבא
להריץ charging flow תקני על דיל מבוקר, לאמת מעבר states של deal ושל participants, ורק אז להמשיך ל-recovery ול-finalize

## 2026-03-29 - Stage 11 Charging Recovery Finalize QA

סטטוס כללי
הושלם

אחוז התקדמות כולל
100%

מה נבדק
- הושלם מסלול charging תקני על הדיל `0272459e-c214-4db3-81d8-0b7258975c40`
- בוצע `join` בכמות `9` עד `TargetReached`
- בוצעו `close_joining`, `prepare_charging`, `charging/start`
- נבדקה עבודת ה-worker על `charge_deal`
- נבדקה יצירת `finalize_deal`
- נבדק ש-`completion_window_until` חסין לשינוי אחרי שנקבע
- בוצעה סימולציית recovery success
- בוצעה סימולציית recovery failure
- בוצעה סימולציית finalize success על כלל 90 אחוז
- בוצעה סימולציית finalize failure מתחת לכלל 90 אחוז

מה הוכח
- במסלול charging התקני:
  הדיל עבר `PendingTarget -> TargetReached -> ClosedForJoining -> ReadyForCharging -> Charging -> CompletionWindow`
- המשתתף במסלול charging התקני עבר:
  `JoinedAuthorized/AuthHeld -> LockedIn/AuthLocked -> ChargingAttempt/ChargeAttempt -> ChargedSuccess/ChargedSuccess`
- נרשמה רשומת `payment_attempts` מסוג `charge_start` עם `success`
- `charge_deal` סומן `sent`
- נוצר `finalize_deal` עם `available_at` לפי `completion_window_until`
- ניסיון לקצר בדיעבד את `completion_window_until` נחסם עם:
  `deals.completion_window_until is immutable once set`

- במסלול recovery success הסימולטיבי על הדיל `baefe692-cca7-43c9-a2d6-cbb95d0a931c`:
  המשתתף עבר `ChargeFailedCompletion/ChargeFailedRecovery -> Recovered/RecoveredCharge`
  נרשמה רשומת `payment_attempts` מסוג `recovery` עם `success`
  `recovery_deal` סומן `sent`

- במסלול recovery failure הסימולטיבי על הדיל `f0bb4f81-91fb-4aa1-aaa8-b91343827220`:
  המשתתף עבר `ChargeFailedCompletion/ChargeFailedRecovery -> Dropped/AuthReleased`
  נרשמה רשומת `payment_attempts` מסוג `recovery` עם `permanent_fail`
  `recovery_deal` סומן `sent`

- במסלול finalize success הסימולטיבי על הדיל `f1c53472-2bba-4cd4-b36b-c2dd3627dae1`:
  `min_units = 10`
  captured units = `9`
  הסף המחייב הוא `ceil(0.9 * 10) = 9`
  הדיל עבר `CompletionWindow -> Completed`
  המשתתף עבר `ChargedSuccess -> DealCompleted`
  `finalize_deal` סומן `sent`

- במסלול finalize failure הסימולטיבי על הדיל `8b4d63c7-c967-4160-a0ca-95d6afe6a502`:
  `min_units = 10`
  captured units = `8`
  הסף המחייב הוא `9`
  הדיל עבר `CompletionWindow -> Failed`
  נוצר `refund_issue`
  המשתתף עבר `ChargedSuccess -> DealFailed` ו-`money_state -> Refunded`
  נרשמה רשומת `payment_attempts` מסוג `refund` עם `success`

סיכום הוכחת כלל 90 אחוז
- כאשר `captured >= ceil(0.9 * min_units)` הדיל מושלם
- כאשר `captured < ceil(0.9 * min_units)` הדיל נכשל ונפתח מסלול refund
- ההוכחה בוצעה בפועל לשני הכיוונים על דילים מבוקרים

מה פתוח
- אין blocker פתוח בחבילת ה-QA שהתבקשה בסבב זה
- אם ממשיכים מכאן, השלב הבא הוא הרחבת QA לאזורי soak, DLQ ו-retry storm, לא למסלולים שכבר הוכחו כאן

הצעד הבא
לעדכן מסמכי ייחוס נוספים אם צריך ולבחור אם להמשיך ל-DLQ ו-retry storm או לעצור כאן עם החבילה העסקית שהושלמה

עדכון הכרעה מחייבת
נוצר מסמך הכרעה קנוני docs/BUYER_CAPACITY_RULE_OVERRIDE.md
המסמך קובע שאין מגבלה על מספר buyers ואין מגבלה על רכישות חוזרות של אותו buyer
ההגבלה היחידה היא max_units של העסקה
כל מסמך ישן שסותר זאת, ובפרט כל אזכור של unique על deal_id עם user_id או buyer_id, נחשב מיושן ודורש תיקון

עדכון Stage 9G
סווגו 43 עסקאות חשודות
38 עסקאות QA מובהקות
5 עסקאות probe שנשמרות כרגע לבדיקה נפרדת
הוחלט לבצע ניקוי זהיר של QA_TITLE בלבד לפני הקשחת schema
עסקאות probe אינן נמחקות בשלב זה

עדכון Stage 10A
ניקוי עסקאות QA הושלם ואומת
נותרו 5 עסקאות probe לבדיקה נפרדת
השלב הנוכחי הוא preview להקשחת schema של deals
טרם בוצעה מיגרציה חיה
המטרה היא לוודא שאין עוד נתונים חריגים שיפילו את ההקשחה

עדכון Stage 10B
בוצע תיקון נקודתי לשתי עסקאות probe שבהן published_at היה חסר למרות סטייט מתקדם
לאחר התיקון בוצע אימות מחדש שאין עוד נתוני deals שחוסמים הקשחת schema
השלב הבא הוא מיגרציית הקשחה חיה לטבלת deals

עדכון Stage 10C
ניסיון ההרצה הראשון של מיגרציית ההקשחה נפל בגלל אופן הרצה טכני דרך pg ולא בגלל כשל לוגי במיגרציה
בוצעה הרצה מתוקנת דרך Node עם transaction ושאילתות נפרדות
לאחריה בוצע אימות של עמודות, constraints ו trigger
השלב הבא לאחר אימות תקין הוא בדיקת publish תקני על דיל חדש

## 2026-03-29 - Stage 11 DLQ Retry Volume QA

סטטוס כללי
הושלם

אחוז התקדמות כולל
100%

מה נבדק
- בוצעה בדיקת DLQ קצה לקצה עם אירוע `charge_deal` כושל על aggregate לא קיים
- בוצעה בדיקת retry storm עם אירוע כושל נוסף
- בוצעה בדיקת volume עדכנית דרך ה-API החי על `900` בקשות join כמעט במקביל
- בוצע יישור מסמכים מעבר ל-`PROJECT_STATUS.md`

מה הוכח
- ב-DLQ:
  אירוע כושל הוחזר ל-`pending` עם `attempt_count` עולה
  לאחר מיצוי הסף הוא הועבר מ-`outbox_events` ל-`outbox_dlq`
  ה-`last_error` נשמר כ-`deal not found`
  ה-`attempt_count` הסופי ב-DLQ היה `4`

- ב-retry storm:
  אירוע כושל נוסף הראה אותה התנהגות יציבה
  לא נצפתה תקיעה על `processing`
  לא נצפתה כפילות ב-DLQ
  מסלול ה-retry נשאר סופי ודטרמיניסטי גם תחת כשל חוזר

- ב-volume test על הדיל `f8847043-3ea9-455a-b53a-8cc4d2c2aa57`:
  `900` בקשות join נשלחו כמעט במקביל
  `600` החזירו `200`
  `300` החזירו `409`
  לא היו סטטוסים אחרים
  `total_qty = 600`
  `participants_count = 600`
  לא הייתה חריגה מעל `max_units = 600`
  הדיל נשאר ב-`TargetReached`
  `threshold_units = 450` נשאר עקבי עבור `min_units = 500`

מסמכי ייחוס
- נוסף מסמך סיכום חדש:
  `docs/STAGE11_RUNTIME_VERIFICATION_2026-03-29.md`
- המסמך מרכז את הממצאים המאומתים של publish, charging, recovery, finalize, DLQ, retry storm ו-volume

מה פתוח
- אין blocker פתוח בחבילת ה-QA וההקשחה שהתבקשה בסבב זה
- אם ממשיכים מכאן, זה כבר למסלולי הרחבה נוספים ולא לסגירת פער קיים

הצעד הבא
לבחור אם להמשיך למסלולי הרחבה כמו duplicate webhook handling ו-soak ארוך יותר, או לעצור כאן עם חבילת QA סגורה

## 2026-03-29 - Stage 12.1 Duplicate Event Verification

סטטוס כללי
הושלם

מה נבדק
- duplicate של אותו `event_uuid` בדיוק ב-`outbox_events`
- duplicate late של `charge_deal` עם payload זהה אבל `event_uuid` חדש
- duplicate late של `recovery_deal`, `finalize_deal` ו-`refund_issue` אחרי שהעסקה כבר הוכרעה
- duplicate correlation ב-`payment_attempts`
- duplicate `(provider, event_id)` ב-`webhook_events`

איך נבדק
- הוזרקו אירועי outbox כפולים ישירות ל-DB על עסקאות שכבר עברו processing
- נבדקו `outbox_events`, `outbox_dlq`, `audit_log`, `payment_attempts` ו-state סופי
- בוצעה הזרקה ישירה של duplicate row ל-`webhook_events`
- בוצעה הזרקה ישירה של duplicate logical attempt ל-`payment_attempts`

מה יצא בפועל
- duplicate של אותו `event_uuid` נחסם ברמת PK
- duplicate correlation ב-`payment_attempts` לא יצר רשומה נוספת
- duplicate late של `recovery_deal`, `finalize_deal` ו-`refund_issue` סומן `sent` בלי side effects נוספים
- duplicate late של `charge_deal` חשף סדק:
  לפני התיקון הוא ירד ל-`DLQ` עם
  `State mismatch deal ... expected Charging`
- בוצע תיקון נקודתי בקוד:
  `handleChargeDealEvent` מחזיר early אם הדיל כבר אינו ב-`Charging`
- אחרי התיקון duplicate late של `charge_deal` סומן `sent` בלי `DLQ`, בלי `payment_attempt` נוסף ובלי `audit` נוסף

מה הוכח
- רק האירוע הראשון משפיע בפועל
- duplicate late אינו פותח מחדש state
- אין charge כפול תקין
- אין `payment_attempt` כפול לא לגיטימי במסלולים שנבדקו
- duplicate exact identity נחסם ברמת persistence

מה עדיין פתוח
- אין blocker פתוח בשלב duplicate events אחרי התיקון
- אם יהיה בעתיד webhook ingestion runtime פעיל, יהיה צורך לוודא שה-contract של `webhook_events` מיושם גם ברמת endpoint ולא רק ברמת persistence

תוצר
- `docs/STAGE12_DUPLICATE_EVENT_VERIFICATION.md`

הצעד הבא
Stage 12.2 soak test ממושך תחת traffic רציף

## 2026-03-30 - Stage 12.2 Soak Test Verification

סטטוס כללי
הושלם

מה נבדק
- traffic רציף על ה-API החי לאורך זמן, לא burst חד
- flow מלא חוזר:
  create
  publish
  join
  close_joining
  prepare_charging
  charging/start
- מדידת latency
- error rate
- outbox growth
- payment_attempt growth
- audit growth
- stuck processing
- retries
- DLQ

איך נבדק
- רץ soak עם prefix:
  `stage12-soak-1774816401952`
- בפועל נוצרו `107` deals חדשים
- נשלחו `642` בקשות HTTP
- נאספו snapshots לאורך הריצה ועוד snapshot סופי

מה יצא בפועל
- `failure_count = 0`
- `error_rate = 0`
- latency overall:
  `avg = 10ms`
  `p95 = 19ms`
  `max = 157ms`
- כל `107` הדילים הגיעו ל-`CompletionWindow`
- `107` אירועי `charge_deal` סומנו `sent`
- `15` אירועי `recovery_deal` סומנו `sent`
- `107` אירועי `finalize_deal` נשארו `pending` כמצופה לחלון השלמה עתידי
- `DLQ = 0`
- `stuck processing > 30s = 0`
- נצפו retries נקודתיים על `charge_deal` ו-`recovery_deal`, אך כולם הסתיימו ב-`sent`

מה הוכח
- המערכת נשארה יציבה לאורך זמן תחת traffic רציף
- לא נצפתה דליפה לוגית
- לא נצפה outbox stuck
- לא נצפה retry storm לא נשלט
- לא נצפתה הידרדרות מהותית בזמן תגובה
- growth ב-outbox היה צפוי ומוסבר:
  `finalize_deal` נשאר pending עד סוף חלון ההשלמה

מה עדיין פתוח
- אין blocker פתוח בשלב soak

תוצר
- `docs/STAGE12_SOAK_TEST_VERIFICATION.md`

הצעד הבא
Stage 12.3 worker restart תחת outbox פעיל ובזמן עומס אמיתי

## 2026-03-30 - Stage 12.3 Restart And Outbox Recovery

סטטוס כללי
הושלם

מה נבדק
- restart בזמן שיש outbox פעיל
- restart מהיר
- restart עם השהיה קצרה
- restart בזמן שנוצר עומס חי של flows חדשים
- התאוששות worker אחרי restart

איך נבדק
- הופעל load runner עם prefix:
  `stage12-restart2-1774817815139`
- במהלך הריצה בוצעו שני restarts:
  restart ראשון מהיר
  restart שני עם השהיה קצרה של כמה שניות
- לאחר כל restart נבדק `health`
- לאחר הריצה נבדקו:
  deals
  outbox_events
  outbox_dlq
  processing rows
  retry rows

מה יצא בפועל
- `health` חזר תקין אחרי שני ה-restarts
- נוצרו `30` deals תחת ה-prefix של הבדיקה
- כל `30` הדילים הגיעו ל-`CompletionWindow`
- `30` אירועי `charge_deal` סומנו `sent`
- `2` אירועי `recovery_deal` סומנו `sent`
- `0` אירועי `DLQ`
- `0` rows ב-`processing`
- `0` stuck processing מעל 30 שניות
- נצפו retries נקודתיים שהסתיימו ב-`sent`

מה הוכח
- אין אובדן אירוע
- אין כפילות עיבוד לא תקינה
- אין state stuck
- אין outbox stuck על `processing`
- יש התאוששות תקינה אחרי restart
- מנגנון ה-reclaim והריקאברי עובד בפועל ולא רק קיים בקוד

מה עדיין פתוח
- אין blocker פתוח בשלב restart recovery

תוצר
- `docs/STAGE12_RESTART_AND_OUTBOX_RECOVERY.md`

הצעד הבא
Stage 12.4 יישור תיעוד legacy

## 2026-03-30 - Stage 12.4 Legacy Doc Alignment

סטטוס כללי
הושלם

מה נעשה
- מופו מקורות legacy שסותרים את ההכרעות הקנוניות
- הוגדרו מסמכים קנוניים מחייבים
- סוכם מה לא עודכן ישירות בגלל encoding או כי הוא חומר היסטורי

מה זוהה כפערי legacy
- `scripts/init_db.sql` עדיין כולל `UNIQUE (deal_id, buyer_id)` ולכן אינו קנוני
- `docs/PROJECT_STATUS.md` הישן אינו מקור אמת עדכני וגם סובל מבעיות encoding
- `docs/STAGE_9D_DRIFT_REPORT.md` הוא מסמך היסטורי שלפני הניקוי וההקשחה
- מסמכי `.docx` הישנים לא יושרו ישירות בסבב זה

מה הוגדר קנוני מחייב
- `PROJECT_STATUS.md`
- `docs/BUYER_CAPACITY_RULE_OVERRIDE.md`
- `docs/STAGE11_RUNTIME_VERIFICATION_2026-03-29.md`
- `docs/STAGE12_DUPLICATE_EVENT_VERIFICATION.md`
- `docs/STAGE12_SOAK_TEST_VERIFICATION.md`
- `docs/STAGE12_RESTART_AND_OUTBOX_RECOVERY.md`
- `docs/STAGE12_LEGACY_DOC_ALIGNMENT.md`
- `docs/STAGE12_OPERATIONAL_CONFIDENCE_SUMMARY.md`

מה עדיין legacy
- `scripts/init_db.sql`
- `docs/PROJECT_STATUS.md`
- `docs/STAGE_9D_DRIFT_REPORT.md`
- מסמכי `.docx` הישנים שלא עודכנו נקודתית

תוצרים
- `docs/STAGE12_LEGACY_DOC_ALIGNMENT.md`
- `docs/STAGE12_OPERATIONAL_CONFIDENCE_SUMMARY.md`

הכרעה נוכחית
READY FOR RELEASE CANDIDATE

אחוז התקדמות כולל
100%

הצעד הבא
Release Readiness

## 2026-03-30 - Release Readiness Package

סטטוס כללי
הושלם

מה הושלם
- `docs/RELEASE_READINESS_CHECKLIST.md`
- `docs/OPERATIONAL_RUNBOOK.md`
- `docs/KNOWN_GAPS_AND_DECISIONS.md`

מה נבדק
- הליבה העסקית
- duplicate events
- soak
- restart recovery
- DLQ
- retry storm
- DB hardening
- תיעוד canonical מול legacy

מה נשאר פתוח
- אין blocker פתוח
- נשארו רק פערי מעטפת non-blocking שתועדו

הכרעה סופית
READY FOR RELEASE CANDIDATE

## 2026-03-30 - RC Gate Review

סטטוס כללי
הושלם

מה הושלם
- בוצע מעבר Release Review על מסמכי ה-proof, ה-summary וה-runbook
- נוצר `docs/RC_GATE_DECISION.md`
- בוצעה הפרדה חדה בין closed, must-have לפני RC ו-non-blocking follow-ups

מה נחשב closed
- `publish`
- `charging`
- `recovery`
- `finalize`
- כלל `90%`
- duplicate events
- `DLQ`
- retry storm
- soak
- restart recovery
- DB hardening
- canonical documentation mapping

Must-Have לפני RC
- אין

Non-Blocking
- אימות duplicate handling ברמת HTTP ingestion אם וכאשר יופעל webhook endpoint חי
- soak ארוך יותר בסביבת deployment-like להרחבת ביטחון תפעולי
- יישור נוסף של מסמכי legacy ו-`.docx`
- kill switch ייעודי אם המדיניות התפעולית תדרוש זאת

הכרעת RC
READY FOR RC NOW

השלב הבא
- לאשר RC baseline
- לבצע deployment-readiness pass לפי
  `docs/RELEASE_READINESS_CHECKLIST.md`
  ו-`docs/OPERATIONAL_RUNBOOK.md`
- לנהל את ה-non-blocking follow-ups אחרי RC, לא כתנאי מקדים לו

## 2026-03-30 - RC Execution Discipline

סטטוס כללי
הושלם

מה הושלם
- בוצע מעבר מלא על `docs/RELEASE_READINESS_CHECKLIST.md` מול הסביבה בפועל
- בוצע מעבר מלא על `docs/OPERATIONAL_RUNBOOK.md` מול הסביבה בפועל
- נוצר `docs/RC_EXECUTION_PLAN.md`
- הוגדרה RC sanity checklist קצרה ל-15 עד 30 הדקות הראשונות

מה אומת בפועל מול סביבת היעד
- `GET /health` מחזיר `{"ok":true}`
- `/debug/deals/:id` ישים בפועל ומחזיר `200`
- ה-DB נגיש דרך `DATABASE_URL`
- עמודות ההקשחה הקריטיות ב-`siton.deals` הן `NOT NULL`
- ה-constraints הקריטיים של `deals` קיימים
- `payment_attempts_unique_logical_attempt` קיים
- קובץ הגיבוי `docs/qa_suspicious_deals_backup.json` קיים
- אין feature flags מחייבים בחבילת RC הזו
- אין kill switch ייעודי; fallback תפעולי הוא עצירת app/worker

RC blocker שזוהה ונסגר
- זוהו `outbox_events` ב-`processing` עם `processing_started_at = null`
- מנגנון reclaim לא תפס אותם ולכן גם שאילתת ה-runbook הישנה לא זיהתה אותם
- בוצע תיקון runtime ב-`src/outbox_worker_helpers.ts`
- בוצע תיקון תיעוד תפעולי ב-`docs/OPERATIONAL_RUNBOOK.md`
- לאחר restart ואימות, שאילתת stuck-outbox מחזירה ריק

מה נחשב closed
- RC execution path ישים בפועל
- runbook ישים בפועל
- release checklist מיושר למציאות
- blocker ה-outbox orphan processing נסגר

Must-Have לפני RC
- אין

Non-Blocking
- webhook ingestion duplicate verification אם וכאשר יופעל endpoint חי
- soak ארוך יותר בסביבת deployment-like
- יישור נוסף של מסמכי legacy ו-`.docx`
- kill switch ייעודי אם יידרש ברמת מדיניות

הכרעה סופית
READY TO EXECUTE RC

השלב הבא
- לבצע RC לפי `docs/RC_EXECUTION_PLAN.md`
- לנטר לפי חלון המעקב הראשוני שהוגדר שם

## 2026-03-30 - RC Execution Result

סטטוס כללי
הושלם

מה בוצע בפועל
- בוצע RC לפי `docs/RC_EXECUTION_PLAN.md`
- בוצע restart ל-runtime
- בוצע חלון מעקב מלא:
  `T+0`
  `T+5`
  `T+15`
  `T+30`
- נוצר `docs/RC_EXECUTION_RESULT.md`

מה הוכח בפועל
- `/health` נשאר ירוק לאורך כל חלון המעקב
- שאילתת stuck-outbox נשארה ריקה לאורך כל חלון המעקב
- לא הופיעו רשומות DLQ חדשות
- retry pressure נשאר תחום
- `/debug/deals/:id` נשאר ישים ומחזיר `200`

חריגות שהתגלו
- סקריפט ה-restart כולל `curl` פנימי שעלול להיכשל מוקדם מדי לפני עליית השרת
- זו סווגה כ-`non-blocking`
- לא היה צורך ב-rollback

מה נחשב closed
- RC execution הושלם בפועל
- monitoring window הושלם בפועל
- לא זוהה RC blocker במהלך הביצוע

Must-Have פתוח
- אין

Non-Blocking
- לשקול ריכוך או הארכת זמן ההמתנה של בדיקת ה-`curl` בתוך סקריפט ה-restart
- webhook ingestion duplicate verification אם וכאשר יופעל endpoint חי
- soak ארוך יותר בסביבת deployment-like
- יישור נוסף של מסמכי legacy ו-`.docx`

הכרעה סופית
RC PASSED WITH NON-BLOCKING OBSERVATIONS

השלב הבא
- להתייחס ל-RC כעובר
- לנהל את ההערות ה-non-blocking כ-follow-up תפעולי, לא כחסם

## 2026-03-30 - Post-RC Hardening And Backend Closure

סטטוס כללי
הושלם

מה תוקן
- `scripts/restart_server_tsnode_clean.ps1` הוקשח ל-polling אמיתי של `/health` במקום probe חד ושביר
- `scripts/restart_server_clean.ps1` הוקשח באותה צורה
- `scripts/init_db.sql` סומן במפורש כ-legacy bootstrap ולא כמקור אמת קנוני

מה אומת
- restart מחודש עבר עם `{"ok":true}` מתוך הסקריפט עצמו
- `/health` נשאר ירוק אחרי restart
- שאילתת stuck-outbox נשארה ריקה אחרי restart

מה נחשב קנוני
- `PROJECT_STATUS.md`
- `docs/BUYER_CAPACITY_RULE_OVERRIDE.md`
- `docs/STAGE11_RUNTIME_VERIFICATION_2026-03-29.md`
- `docs/STAGE12_*`
- `docs/RC_GATE_DECISION.md`
- `docs/RC_EXECUTION_PLAN.md`
- `docs/RC_EXECUTION_RESULT.md`
- `docs/BACKEND_CLOSURE_DECISION.md`

מה נחשב legacy
- `scripts/init_db.sql`
- `docs/PROJECT_STATUS.md` הישן
- מסמכי `.docx` ההיסטוריים

Blockers פתוחים
- אין

Non-Blocking Follow-Ups
- webhook ingestion duplicate verification אם וכאשר יופעל endpoint חי
- soak ארוך יותר בסביבת deployment-like
- יישור נוסף של מסמכי legacy ו-`.docx`
- kill switch ייעודי אם יידרש ברמת מדיניות

הכרעת backend
BACKEND CLOSED WITH NON-BLOCKING FOLLOW-UPS

השלב הבא
- לעבור למצב release follow-through ותחזוקה תפעולית

## 2026-03-30 - Backend Professionalization Pass

סטטוס כללי
הושלם חלקית ברמת closure עם follow-ups לא חוסמים

מה תוקן בפועל
- drift אמיתי בתצורת DB נסגר דרך `src/runtime_config.ts`
- `src/db.ts` ו-`src/app.ts` יושרו למקור אמת קנוני אחד
- noisy SQL logging ברירת מחדל ב-`src/db.ts` נסגר ועבר ל-`DEBUG_SQL_LOGGING=1`
- noisy join logging ב-`src/app.ts` נסגר ועבר ל-`DEBUG_JOIN_LOGGING=1`
- `npm test` כבר אינו placeholder ומריץ suite אמיתי
- נוצר baseline test ב-`tests/backend_sanity_suite.ts`
- נוצר `tsconfig.test.json` למסלול test יציב
- `scripts/init_db.sql` יושר כך שלא יישאר בו `UNIQUE (deal_id, buyer_id)` שסותר את כלל המוצר
- `docs/KNOWN_GAPS_AND_DECISIONS.md` הוחלף בגרסה קריאה ותקינה

מה נבדק בפועל
- `npm test` עבר
- `npx tsc --noEmit` עבר
- runtime validation עבר דרך build מקומפל ו-`node .tmp_test_dist/src/app.js`
- `/health` החזיר `{"ok":true}`
- תיקיות `.tmp_*` ו-`.tmp_test_dist` נוקו בפועל

מה נשמר לדיסק
- `src/runtime_config.ts`
- `tests/backend_sanity_suite.ts`
- `tsconfig.test.json`
- `docs/BACKEND_PROFESSIONALIZATION_AUDIT.md`
- `docs/CANONICAL_REPO_DECISION.md`
- `docs/DB_CONFIGURATION_UNIFICATION.md`
- `docs/LOGGING_HARDENING.md`
- `docs/TEST_BASELINE_DECISION.md`
- `docs/TEMP_AND_SCRIPT_HYGIENE.md`
- `docs/DOC_ENCODING_AND_READABILITY.md`
- `docs/OPERATIONAL_SCRIPT_VALIDATION.md`
- `docs/RUNTIME_VALIDATION_LIMITATIONS.md`

מה נוקה
- `.tmp_prod_extract/`
- `.tmp_ux_extract/`
- `.tmp_test_dist/`

מה נשאר non-blocking
- worktree עדיין אינו clean ברמת git כי קיימים שינויים וקבצים היסטוריים רבים שטרם קיבלו commit/archival סופי
- חלק ניכר מ-`scripts/` ו-`src/*.cjs` עדיין נשמר כהיסטוריה טכנית ולא אורגן עדיין מחוץ לשורש הריפו
- אימות מלא של מסלולי spawn אינטראקטיביים נשאר מוגבל תחת sandbox
- יישור מלא של מסמכי `.docx` ההיסטוריים לא בוצע

אחוז התקדמות
93 אחוז

הכרעת מצב
הבקאנד נראה רציני משמעותית יותר:
- יש מקור אמת קנוני ל-DB
- אין debug logging רועש כברירת מחדל
- יש test command אמיתי
- יש מסמכי professionalization ייעודיים
- יש runtime validation מתועד

הצעד הבא
- להשלים archival/commit discipline כדי להגיע ל-worktree clean
- ואז להתחיל frontend על גבי ה-endpoints וה-flows שכבר הוכחו

## 2026-03-30 - Repository Final Hygiene Pass

סטטוס כללי
הושלם

מה נוקה
- כל `src/*.cjs` ההיסטוריים הוצאו ממשטח `src/` הפעיל
- רוב `scripts/` ההיסטוריים הועברו לארכיון ייעודי
- קבצי stage snapshot ושאריות root הועברו לארכיון
- לא נשארו תיקיות `.tmp_*`

מה סווג
- `scripts/` כעת מכיל רק operational canonical ו-utility קטן
- `archive/repository_hygiene_2026-03-30/` מכיל את בית הקברות ההיסטורי
- `scripts/init_db.sql` נשאר כ-reference legacy בלבד

מה נשאר בכוונה
- מסמכי החלטה, RC, runbook, ו-stage docs קנוניים/ייחוסיים
- utility scripts בודדים שעדיין מועילים לעבודה מקומית
- historical archive שנשמר כהקשר ולא כ-runtime active surface

מה נשאר legacy accepted
- `.docx` היסטוריים
- historical scripts בארכיון
- worktree שאינו clean לחלוטין ברמת git history discipline

הכרעת hygiene
REPOSITORY HYGIENE CLOSED WITH ACCEPTED LEGACY

הצעד הבא
- להפסיק לעסוק ב-backend hygiene ולעבור לפרונטד
