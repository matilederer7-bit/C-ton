# דוח Drift בין האפיון העדכני לבין הקוד

**תאריך:** 2026-04-19
**מקורות אמת (Source of Truth):**
- `Desktop/מתי לדרר/אישי/סיטון/סיטון אפיון מוצר מלא עדכני.docx` (16/4)
- `Desktop/מתי לדרר/אישי/סיטון/UX סיטון.docx` (16/4)

**הקשר:** דוח drift קודם (`CANONICAL_DRIFT_AUDIT_2026-04-18.md`) מיפה 3 אשכולות (distributor, fee, repeat-purchase). מאז — 0 commits של קוד. דוח זה:
1. מאשר שהאשכולות ההם עדיין פתוחים במלואם.
2. מוסיף **ממצאים חדשים** שלא כוסו ושנגזרים מקריאה ישירה של שני המסמכים הקריטיים.

---

## Summary

| חומרה | #drifts | 
|---|---|
| P0 Critical | 9 |
| P1 Major | 8 |
| P2 Minor | 5 |

סה״כ ~22 פערים פתוחים. 3 מהם (P0) לא מופו בדוח הקודם.

---

## P0 — Critical

### D1. חלון השלמה: 15 דקות במקום 24 שעות (**חדש**)

- **באפיון:** K6 / C6 / שכבה 2 — "נפתח חלון השלמה של 24 שעות לעדכון אשראי".
- **בקוד:** [src/runtime_config.ts:19](src/runtime_config.ts#L19) ו-[src/app.ts:31](src/app.ts#L31) — `COMPLETION_WINDOW_MINUTES = 15`.
- **השלכה:** הקונה יקבל חלון של 15 דקות להזין אשראי חדש במקום 24 שעות. זה שובר חוזה מפורש עם הקונה, עלול לגרום לאבדן קונים תקפים ולפסילת העסקה ב-90%.
- **תיקון:** `COMPLETION_WINDOW_MINUTES = 1440` (או משתנה חדש בשעות).

### D2. עמלת סיטון: default 0% במקום 8% (**מופיע בדוח הקודם כ-DRIFT-FEE-01, עדיין פתוח**)

- **באפיון:** "עמלת סיטון היא 8% מסך כל הסכום שנגבה בפועל… לא נגבית עמלה נוספת מעבר לכך."
- **בקוד:** [src/app.ts:1978](src/app.ts#L1978) — `Number(body.commission_rate || 0)`. אם המוכר לא שולח ערך → 0%. השדה גם seller-editable ברמת עסקה.
- **השלכה:** (א) סיטון לא גובה עמלה כלל ב-default; (ב) חוזה המוצר נותן למוכר לקבוע שיעור עמלה — בניגוד מוחלט לספק.
- **תיקון:** להחליף `commission_rate` per-deal בקבוע `PLATFORM_FEE_RATE = 0.08` (חישוב בלבד, בלי שדה DB שהמוכר שולט בו). להפוך את השדה בעסקה לקריאה בלבד או להסיר.

### D3. דדליין: אין enforcement של max 7 ימים / min 2 שעות (**חדש**)

- **באפיון:** "דדליין לעיסקה לא יעלה על 7 ימים" + "מקסימום עד שבעה ימים קלנדריים, מינימום החל מ 2 שעות".
- **בקוד:** [src/app.ts:1977](src/app.ts#L1977) — המוכר יכול לשלוח `body.deadline` חופשי. default = `nowPlusMinutes(60)` (שעה). אין upper/lower bound.
- **השלכה:** מוכר יכול ליצור עסקה של שנה או של 30 שניות. שובר טיימינג-גיים קריטי במוצר.
- **תיקון:** ולידציה ב-POST /deals: `2h ≤ deadline - now ≤ 7d`. במקביל: אכיפה ב-DB trigger (`deadline <= created_at + interval '7 days'`).

### D4. אזור מפיצים כמערכת עמלות פנימית (**DRIFT-DIST-01..04, פתוח**)

- **באפיון (UX מפיץ, עקרון־על):** "המפיץ אינו מקבל תשלום דרך המערכת. אין אזור עמלות, אין אזור תשלומים, אין אזור יתרות, אין אזור משיכות, אין אזור חשבוניות".
- **בקוד:** 
  - [src/product_surface_support.ts:116-144](src/product_surface_support.ts#L116-L144) — `affiliate_accounts.payout_status`, `payout_method`, `payout_details_masked`; `affiliate_attributions.commission_rate`, `commission_amount`, `payout_status`.
  - [src/frontend_runtime.ts:1446](src/frontend_runtime.ts#L1446) — `POST /api/affiliate/payout-profile`.
  - [src/frontend_runtime.ts:2481](src/frontend_runtime.ts#L2481) — `POST /api/admin/affiliate-payouts/:affiliateId`.
- **השלכה:** המערכת מייצגת (ב-DB וב-API) התחייבות כספית של סיטון למפיץ. קונקרטית סותר את האפיון.
- **תיקון:** להסיר שדות payout/commission מהסכמה ומה-API. להשאיר רק: `affiliate_code`, `display_name`, attribution links ומדדי ביצוע.

### D5. מפיץ מקבל שם קונה/פרטים אישיים (**חדש**)

- **באפיון (UX מפיץ, פרטיות):** "המפיץ לא רואה: שמות קונים, טלפונים, אימיילים, כתובות, אמצעי תשלום, סטטוסי חיוב אישיים".
- **בקוד:** אין endpoint מפיץ שמוכיח הפרדה. מה שיש הוא attribution row-by-row. צריך לוודא שלמפיץ מוגש רק aggregate.
- **השלכה:** אם הושאר endpoint שחושף פרטי קונים → עבירה מפורשת על פרטיות.
- **תיקון:** ביקורת כל route תחת `/api/affiliate/*`; לוודא שאין שם buyer_id/phone/email/address.

### D6. ביטול עסקה לאחר נעילה — DEAL_TRANSITIONS רחב מדי (**חדש**)

- **באפיון:** E4 — "לא ניתן לבטל עיסקה לאחר נעילת משתתפים (סטייט 5)". State 9 (Cancelled) — "יכול לקרות רק לפני סטייט 5".
- **בקוד:** [src/app.ts:151-162](src/app.ts#L151-L162) — `DEAL_TRANSITIONS` מתיר `TargetReached → Cancelled`, `ClosedForJoining → Cancelled`, `ReadyForCharging → Cancelled`, `Charging → Cancelled`. ה-DB trigger (`008_db_enforcement_phase2a.sql:52`) *כן* מתיר רק Draft→Cancelled ו-PendingTarget→… לא כולל Cancelled אחרי TargetReached. כלומר: **קוד TypeScript מאפשר יותר מ-DB**; הקוד יעבור validation טייפסקריפטי אבל ייכשל ברמת DB trigger. אי-עקביות.
- **בפועל הראוטר:** `POST /deals/:id/cancel` (src/app.ts:2419) מתיר רק Draft→Cancelled — **זה מתיישר עם האפיון**. אבל ה-map הכללי `DEAL_TRANSITIONS` ב-TS הוא מקור אמת סותר.
- **תיקון:** סנכרון `DEAL_TRANSITIONS` לתואם ל-DB trigger ולאפיון: רק `Draft: ["PendingTarget","Cancelled"]` ו-`PendingTarget: ["TargetReached","Failed","Cancelled"]`, מסטייט 3 ואילך — **בלי Cancelled**.

### D7. חוסר ביטול/החזר E13: אין endpoint החזר למוכר / לאדמין (**חדש**)

- **באפיון:** E13 — "ביצוע על ידי המוכר: למוכר יש כפתור 'ביצוע החזר' בממשק הניהול (מוגבל עד 14 יום מסגירת העסקה). ביצוע על ידי מנהל מערכת: למנהל מערכת יש הרשאה לביצוע החזר בכל שלב במקרה של כשל באספקה או הונאה."
- **בקוד:** סטייט Refunded קיים; money_state מעברים לRefunded קיימים; יש `handleRefundEvent` פנימי; **אבל אין endpoint ציבורי** `POST /api/seller/deals/:id/refund/:participantId` או `POST /api/admin/refund/:participantId`. החזרים יכולים להיווצר רק דרך outbox event — אין טריגר מה-UI.
- **השלכה:** מוכר/אדמין לא יכול לעשות החזר כפי שהאפיון מחייב. E13 לא ממומש.
- **תיקון:** להוסיף 2 endpoints (seller עד 14 יום, admin תמיד), שיוצרים outbox event מסוג `refund_issue` ואז נקרא `handleRefundEvent` הקיים.

### D8. OTP למכשיר חוזר — לא ממומש (**חדש**)

- **באפיון (UX קונה):** "זיהוי קונה חוזר מתבצע רק באותו מכשיר באמצעות Cookie או LocalStorage. אם הקונה חוזר מאותו מכשיר — ניתן לדלג על OTP או לבצע OTP שקוף. אם הקונה מגיע ממכשיר אחר — OTP תמיד נדרש."
- **בקוד:** [src/frontend_runtime.ts:2571-2653](src/frontend_runtime.ts#L2571-L2653) — OTP תמיד נדרש, אין מנגנון cookie/localStorage לזיהוי device. אין "trusted device token".
- **השלכה:** חיכוך לקונים חוזרים. סותר את ה-UX המובטח.
- **תיקון:** אחרי OTP מוצלח — להנפיק cookie ארוך-תוקף (HTTPOnly, Secure) עם device_trust_token השמור ב-DB כ-hash. בזרימה: אם cookie תקף → דלג על OTP או OTP שקוף.

### D9. קידוד עברית שבור ב-`frontend/app.js` (**לא spec drift פר-סה, אבל חוסם את כל ה-UX**)

- **באפיון:** כל המוצר הוא RTL Hebrew.
- **בקוד:** [frontend/app.js](frontend/app.js) — לפחות 10+ מחרוזות מציגות mojibake (`׳₪׳×׳™׳—׳×` במקום `פתיחת`). חלק תקין (שורה 2137 למשל), חלק לא. ככל הנראה מיזוג של עריכות ב-CP-1255/Latin-1/UTF-8.
- **השלכה:** חלקים מהממשק יציגו ג׳יבריש לקונה/מוכר. לא ניתן להעלות live.
- **תיקון:** סריקה+תיקון של כל המחרוזות הפגועות, אפשר ע"י ה-regex ל-`׳[א-ת]` ואז החלטה קונטקסטואלית (האם הטקסט המקורי זוהה) או re-authoring לפי אוצר המילים באפיון UX.

---

## P1 — Major

### D10. מסכי אדמין חסרים — Payouts & Settlements, KYC Queue (**חדש חלקי**)

- **באפיון (UX אדמין):** יש רשימת 8 מסכים מחייבים. מהם נבנו?
  - ✓ Dashboard ראשי: חלקית (`/api/admin/overview`)
  - ✗ Omnisearch: **לא קיים**
  - ~ רשימת עסקאות: חלקי
  - ~ Deal Profile: חלקית (`/api/admin/deals/:id/profile`)
  - ~ User Profile: חלקית (`/api/admin/users/:buyerId/profile`)
  - ✗ Seller Onboarding / KYC Queue: **routes לא קיים** (יש רק כללי `/api/admin/kyc/:subjectType/:subjectId/decision` — אבל אין queue screen)
  - ✗ Payouts & Settlements: **לא קיים כמסך אדמין**
  - ~ Support Hub: חלקי (`/api/admin/support`)
  - ✗ Audit & Forensics screen: **endpoint חסר**
  - ✗ System Status: יש partial (`/api/admin/system-status`) אבל לא טיימליין 24h כמוגדר
- **תיקון:** priority — להוסיף KYC Queue, Payouts & Settlements, Omnisearch, Audit & Forensics.

### D11. מתג עצירת חירום (E12) — לא ממומש (**חדש**)

- **באפיון:** E12 — "מתג עצירה גלובלי — הרשאה מאוד מוגבלת ומאובטחת. מתג זה דורש אישור של שני מנהלי מערכת (2-man rule) כדי למנוע טעויות אנוש או פריצה לחשבון מנהל בודד. כל שימוש במתג נרשם בלוג בלתי ניתן למחיקה."
- **בקוד:** לא קיים.
- **השלכה:** בתקלה כספית חריגה אין דרך לעצור את כל הניסיונות לחיוב באופן מיידי.
- **תיקון:** טבלת `system_kill_switch` + endpoint `POST /api/admin/kill-switch` שדורש 2 אישורי אדמין + בדיקה בתחילת כל outbox event handler.

### D12. Freeze Payouts לאדמין (per-seller) — לא ממומש (**חדש**)

- **באפיון:** Deal Profile — "Freeze Payouts — אישור אדמין נוסף, תוקף 7 ימים, סיבה חובה + טקסט, Alert לכל האדמינים ולמוכר, Audit".
- **בקוד:** לא קיים.
- **תיקון:** טבלת `payout_freezes`, endpoint `POST /api/admin/deals/:id/freeze-payouts`, בדיקה ב-finalize logic.

### D13. Content Takedown — לא ממומש (**חדש**)

- **באפיון:** Deal Profile — "Content Takedown — Replace ב-Placeholder מערכתי, CDN purge, נוטיפיקציה למוכר ולקוניםת, Audit".
- **בקוד:** לא קיים.
- **תיקון:** endpoint `POST /api/admin/deals/:id/takedown`, flag `is_taken_down` על deals, replace ב-public endpoint.

### D14. Ledger Double-Entry לקריאה (**חדש**)

- **באפיון:** עסקה סגורה — "קישור משני: פרטים מתקדמים — פותח Ledger לקריאה בלבד, Double Entry, מסונן לעסקה זו בלבד".
- **בקוד:** אין ledger table. חישוב "ברוטו/עמלה/נטו" נעשה ad-hoc ב-runtime.
- **תיקון:** טבלת `financial_ledger` עם entries Double-Entry (debit/credit לכל פעולה כספית), endpoint קריאה לפי deal_id.

### D15. Status polling — אין מנגנון "מעודכן לפני X שניות" (**חדש חלקי**)

- **באפיון (UX מוכר/דשבורד):** "בראש המסך, קטן: מעודכן אוטומטית כל 20-30 שניות. אם לא בוצע עדכון מעל 60 שניות — Badge צהוב: נתונים עלולים להיות לא עדכניים — רענן".
- **בקוד:** אין polling metadata ב-response. אין last_updated_at מובלט ברמת המסך. UI צריך לבנות fallback הזה.
- **תיקון:** להחזיר `meta.generated_at` בכל API של מסך, ולתרגם זאת ב-frontend לרכיב "מעודכן לפני X שניות".

### D16. Webhook: No תמיכה ב-`E1 duplicate` + `E2 late event` מלא (**חלקי**)

- **באפיון:** E1 "אירוע סליקה כפול — אירוע סליקה מזוהה לפי מזהה ייחודי ומטופל פעם אחת בלבד". E2 "אירוע סליקה מאוחר — סטייט לוגי תמיד גובר על אירוע מאוחר".
- **בקוד:** יש `webhook_ingestion.ts` עם idempotency_log. אבל אין בדיקה מפורשת שאם מגיע webhook מאוחר שלא מתאים לסטייט — הוא נרשם ללוג ולא משנה סטייט.
- **תיקון:** audit של כל מסלול webhook, ולוודא שיש "route to log only" כשסטייט לא תואם.

### D17. שגיאה בקוד `rand01Deterministic` — התפלגות mock (**חדש minor**)

- **בקוד:** [src/app.ts:474-494](src/app.ts#L474-L494) — `paymentCaptureMock`: `if (r < 0.9) return "temporary_fail"` — זה *90%* temp_fail וזה רמז שזו דווקא הצלחה של 10% בלבד? צריך לקרוא שוב.
  - למעשה: הפונקציה הזאת mock-ית ומוקצית בסביבת בדיקה בלבד. אבל יכולה להטעות טסטים — לוודא שלא פועלת בפרודקשן.

---

## P2 — Minor

### D18. OTP_MAX_ATTEMPTS = 5 במקום "לדוגמה 3"

- **באפיון:** "מספר ניסיונות מוגבל, לדוגמה 3".
- **בקוד:** [src/frontend_runtime.ts:109](src/frontend_runtime.ts#L109) — `OTP_MAX_ATTEMPTS = 5`.
- **פתרון:** שנה ל-3 (או יש להפוך ל-env var + default 3). האפיון אומר "לדוגמה 3" — לא מנדטורי.

### D19. Repeat purchase — idempotency key דורש אותו buyer_id (**DRIFT-REPEAT-01, פתוח**)

- **באפיון:** "אותו קונה יכול לבצע מספר רכישות נפרדות באותה עסקה, ללא מגבלה".
- **בקוד:** [src/app.ts:2110-2123](src/app.ts#L2110-L2123) — `idemCheck` מחבר `participant_id` + `buyer_id` + idempotency key. ה-fallback של idempotency key `join:${dealId}:${buyer_id}:${requestId}` כולל requestId רנדומלי, אז זה באמת מאפשר ריבוי — אם ה-client לא מעביר idempotency-key משלו.
- **פתרון:** להבטיח שגם אם client שולח idempotency-key, זה יזוהה כמכוון לרכישה חדשה, ולא יחזיר participant ישן.

### D20. חוזה תקנון — cursor לאישור לא enforced (**חדש**)

- **באפיון:** "לפני שפותחים עיסקה יש חובה לקרוא תקנון עם סמן לאישור שאכן התקנון נקרא".
- **בקוד:** יצירת עסקה לא בודקת `terms_accepted` flag.
- **פתרון:** הוספת `terms_accepted: true` חובה ב-POST /deals ו-checkbox ב-UI (wizard stage 5).

### D21. כמות מינימום ≥ 1, מקסימום ≥ מינימום — חסר enforcement ב-API

- **באפיון:** "מינימום ≥ 1, מקסימום ≥ מינימום".
- **בקוד:** [src/app.ts:1959](src/app.ts#L1959) — `Math.max(1, Number(...))` — הופך ערכים לא תקפים לתקפים במקום לדחות אותם. אין 400 explicit.
- **פתרון:** לדחות עם 400 אם מינימום < 1 או אם מקסימום < מינימום.

### D22. מסכי מוכר "פעולה אחת בלבד: צור עסקה דומה" — לא ממומש כ-endpoint

- **באפיון:** Completed/Failed/Cancelled → "צור עסקה דומה" — טופס מלא מראש, דדליין+חלון השלמה חובה לעדכן.
- **בקוד:** אין endpoint ייעודי. UI יכול לעשות זאת client-side (fetch → populate → submit), אבל אין enforcement של reset דדליין.
- **פתרון:** UI-only — לבנות wizard שיודע להעתיק + למחוק דדליין.

---

## Map לפי אזור קוד

| אזור | מספרי Drift |
|---|---|
| `src/app.ts` (API cores) | D2, D3, D6, D7, D17, D19, D20, D21 |
| `src/runtime_config.ts` | D1 |
| `src/frontend_runtime.ts` | D4, D5, D7, D8, D10, D15 |
| `src/product_surface_support.ts` | D4 |
| `frontend/app.js` | D9, D15, D22 |
| DB migrations | D4 (schema), D6 (triggers), D11 (new table), D12 (new table), D14 (new table) |
| Missing entirely | D11, D12, D13, D14 |

---

## סדר עדיפויות מומלץ (לפי blast radius)

1. **D1** — לשנות `COMPLETION_WINDOW_MINUTES` ל-1440. שינוי של שורה אחת, השפעה כספית עצומה.
2. **D2** — קיבוע שיעור עמלה ל-8% כקבוע מערכת; הסרת commission_rate מ-seller input. השפעה כספית.
3. **D6** — יישור `DEAL_TRANSITIONS` ב-TS לאפיון ולטריגר DB. הגנה מפני ביטול לא חוקי.
4. **D3** — enforcement של 2h ≤ deadline ≤ 7d. מונע עסקאות "שבורות".
5. **D7** — הוספת endpoints החזר (seller + admin). חסם גדול לשימוש אמיתי.
6. **D4** + **D5** — הסרת payout subsystem של מפיצים. תלוי ב-DB migration, שיפוץ routes.
7. **D8** — Trusted device cookie.
8. **D9** — תיקון קידוד ב-frontend. UX-critical.
9. **D10-D14** — הוספת מסכי אדמין חסרים (KYC, Payouts, Takedown, Freeze, Ledger, Kill-switch).
10. **D15-D22** — minor polishing, copy, UX.

---

## הערה אחרונה

הדוח הזה לא מכסה:
- תוכן של `חוקה וצקליסט לסיטון.docx` ו-`סיטון - מפרט מערכת מחייב.docx` (נמצאים בתיקייה אבל לא ציינת שהם קריטיים).
- בדיקות (tests/). חלק מהטסטים בוודאות יעלו drift נוסף.
- copy ניואנסי מלא ב-frontend — D9 עוצר את הבדיקה הזו עד שתוקן הקידוד.

האם להתחיל תיקון? סדר מוצע: D1 → D2 → D6 → D3 → D7 (כולם ב-app.ts, סה"כ פחות מ-100 שורות שינוי).
