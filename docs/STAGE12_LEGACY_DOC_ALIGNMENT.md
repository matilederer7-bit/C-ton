# Stage 12 Legacy Doc Alignment

תאריך
- 2026-03-30

מטרת השלב
- להבטיח שאין פער מסוכן בין מה שהמערכת מוכיחה בפועל לבין מקורות legacy ישנים

מה מופו כפערי legacy

1. `scripts/init_db.sql`
- כולל `UNIQUE (deal_id, buyer_id)`
- סותר את ההכרעה הקנונית שאין הגבלה על מספר פעולות join של אותו buyer
- לכן אינו מקור אמת קנוני

2. `docs/PROJECT_STATUS.md`
- מסמך ישן
- לא מעודכן לכל אבני הדרך האחרונות
- כולל בעיות encoding
- אינו מקור אמת קנוני

3. `docs/STAGE_9D_DRIFT_REPORT.md`
- מסמך היסטורי נכון לזמן ה-drift
- כולל נתונים של pre-cleanup ו-pre-hardening
- שימושי כהיסטוריה, לא כמסמך מצב נוכחי

4. מסמכי `.docx` היסטוריים
- לא עודכנו ישירות בסבב הזה
- יש להתייחס אליהם כחומר ייחוס היסטורי עד רוויזיה מסודרת

מה הוגדר קנוני מחייב

1. `PROJECT_STATUS.md`
2. `docs/BUYER_CAPACITY_RULE_OVERRIDE.md`
3. `docs/STAGE11_RUNTIME_VERIFICATION_2026-03-29.md`
4. `docs/STAGE12_DUPLICATE_EVENT_VERIFICATION.md`
5. `docs/STAGE12_SOAK_TEST_VERIFICATION.md`
6. `docs/STAGE12_RESTART_AND_OUTBOX_RECOVERY.md`
7. `docs/STAGE12_LEGACY_DOC_ALIGNMENT.md`
8. `docs/STAGE12_OPERATIONAL_CONFIDENCE_SUMMARY.md`

מה עודכן
- נוספו מסמכי Stage 12 החדשים
- `PROJECT_STATUS.md` עודכן

מה לא עודכן ישירות ולמה
- `docs/PROJECT_STATUS.md`
  בגלל חוסר קנוניות ובעיות encoding
- מסמכי `.docx`
  כי יישור בטוח שלהם דורש רוויזיה תוכנית נפרדת
- `scripts/init_db.sql`
  כי זה bootstrap legacy ויש לטפל בו בנפרד ולא “ליישר בשקט” בתוך סבב QA

פסק דין
- התיעוד הקנוני הנוכחי ברור
- מקורות ה-legacy המטעים מופו והוגדרו כלא קנוניים
