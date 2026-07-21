# Load & Capacity Baseline Report

Generated: 2026-07-21T12:28:40.406Z

## Verdict

LOAD_BASELINE_PASS_FOR_SMALL_PILOT

## Summary

נבדקו קריאות public deal, tracking/polling, הצטרפות מקבילה לאותה עסקה, הצטרפות מפוזרת על הרבה עסקאות, outbox worker ללא provider חיצוני, ו-export לעסקה גדולה.

לא נבדקו CDN/cache, staging אמיתי, latency רשת אמיתית, provider חיצוני אמיתי, תשלום אמיתי, או עומס production. הבדיקה רצה מקומית מול `demo-preview`, עם `DISABLE_OUTBOX_WORKER=1`, providers mock/log/internal בלבד, ועם rate limit מוגבה כדי למדוד capacity של הקוד וה-DB ולא של ההגנה הפרימיטיבית.

מה כבר קיים: יש scripts רבים ב-`package.json`, כולל build/test gates; יש `tests/concurrency_proof.ts` שמוכיח no-oversell/idempotency; יש בדיקות server-side money authority ו-state engine atomicity; יש outbox worker עם claim, retry, DLQ ו-stuck reclaim; יש endpoints ל-`/health`, `/health/integrations`, public deal, join, tracking, seller export, ו-admin outbox status; frontend polling הוא 12s למסכים כלליים ו-6s ל-tracking.

מה היה חסר: harness מספרי שמודד latency percentiles, memory, timeout count, outbox pending age, והרצה רחבה של read/join/export תחת concurrency.

## Results

| scenario | total | concurrency | success | failures | error rate | avg ms | p50 ms | p95 ms | p99 ms | max ms | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A1 public deal reads | 100 | 10 | 100 | 0 | 0.00% | 77.3 | 37.6 | 420.7 | 431.8 | 447.9 | PASS |
| B1 tracking reads | 100 | 10 | 100 | 0 | 0.00% | 147.8 | 59 | 875.6 | 949.8 | 975.1 | PASS |
| C1 joins same deal max=100 attempts=100 c=20 | 100 | 20 | 100 | 0 | 0.00% | 412 | 313.3 | 930.3 | 945.6 | 954.4 | PASS |
| C2 joins oversubscribe max=100 attempts=200 c=50 | 200 | 50 | 100 | 100 | 50.00% | 563.6 | 228.6 | 1237.3 | 1262.9 | 1273.6 | PASS |
| D1 10 deals x 10 buyers | 100 | 20 | 100 | 0 | 0.00% | 275.6 | 223.7 | 827.5 | 848.1 | 849.2 | PASS |
| F export completed deal 100 participants | 1 | 1 | 1 | 0 | 0.00% | 328.9 | 328.9 | 328.9 | 328.9 | 328.9 | PASS |
| A2 public deal reads | 500 | 25 | 500 | 0 | 0.00% | 65.9 | 53.7 | 133.7 | 311.7 | 432.2 | PASS |
| B2 tracking reads | 1000 | 50 | 1000 | 0 | 0.00% | 199.3 | 194.3 | 277.8 | 319 | 324.2 | PASS |
| C3 joins same deal max=500 attempts=1000 c=100 | 1000 | 100 | 500 | 500 | 50.00% | 1188.8 | 673.6 | 2297.6 | 2751.9 | 3823.3 | PASS |
| D2 50 deals x 20 buyers | 1000 | 50 | 1000 | 0 | 0.00% | 506.6 | 454.4 | 937.9 | 999.9 | 1088.9 | PASS |
| F export completed deal 500 participants | 1 | 1 | 1 | 0 | 0.00% | 514.7 | 514.7 | 514.7 | 514.7 | 514.7 | PASS |

## Additional Metrics

- A1 public deal reads: DB errors=0, timeouts=0, memory 84MB -> 94.8MB, outbox pending 0 -> 0, oldest pending n/as -> n/as
- B1 tracking reads: DB errors=0, timeouts=0, memory 97.9MB -> 112.9MB, outbox pending 0 -> 0, oldest pending n/as -> n/as
- C1 joins same deal max=100 attempts=100 c=20: DB errors=0, timeouts=0, memory 112MB -> 131.7MB, outbox pending 0 -> 0, oldest pending n/as -> n/as, extra={"participants":100,"units":100,"maxUnits":100}
- C2 joins oversubscribe max=100 attempts=200 c=50: DB errors=0, timeouts=0, memory 131MB -> 153.7MB, outbox pending 0 -> 0, oldest pending n/as -> n/as, extra={"participants":100,"units":100,"maxUnits":100}
- D1 10 deals x 10 buyers: DB errors=0, timeouts=0, memory 153.5MB -> 156.2MB, outbox pending 0 -> 0, oldest pending n/as -> n/as, extra={"creation_ms":15.6,"deals":10,"oversold_deals":0}
- F export completed deal 100 participants: DB errors=0, timeouts=0, memory 157.1MB -> 178.3MB, outbox pending 0 -> 0, oldest pending n/as -> n/as, extra={"participants":100,"export_bytes":34720}
- A2 public deal reads: DB errors=0, timeouts=0, memory 190.6MB -> 216.5MB, outbox pending 0 -> 0, oldest pending n/as -> n/as
- B2 tracking reads: DB errors=0, timeouts=0, memory 217.4MB -> 238.3MB, outbox pending 0 -> 0, oldest pending n/as -> n/as
- C3 joins same deal max=500 attempts=1000 c=100: DB errors=0, timeouts=0, memory 238.4MB -> 252MB, outbox pending 0 -> 0, oldest pending n/as -> n/as, extra={"participants":500,"units":500,"maxUnits":500}
- D2 50 deals x 20 buyers: DB errors=0, timeouts=0, memory 253.2MB -> 261.1MB, outbox pending 0 -> 0, oldest pending n/as -> n/as, extra={"creation_ms":129.7,"deals":50,"oversold_deals":0}
- F export completed deal 500 participants: DB errors=0, timeouts=0, memory 261.2MB -> 290.2MB, outbox pending 0 -> 0, oldest pending n/as -> n/as, extra={"participants":500,"export_bytes":126509}

Node open handles after close: 3

## Business Interpretation

- 10 עסקאות בשבוע: נראה קל למערכת מקומית לפי baseline זה.
- 10 עסקאות ביום: נראה ריאלי במונולית הנוכחי, בהנחה שסביבת ה-DB דומה או חזקה יותר מהבדיקה המקומית.
- 100 עסקאות ביום: לא הוכח production-ready. D3 נותן אינדיקציה טובה מקומית, אבל צריך staging/load חוזר עם DB מנוהל ו-observability.
- דיל ויראלי של 500-1,000 קונים: אפשרי כ-baseline מקומי אם C3 ו-export 1,000 עברו, אבל tracking polling ו-export הם המקומות הראשונים שדורשים tuning לפני קמפיין רחב.
- bottleneck ראשון שזוהה: C3 joins same deal max=500 attempts=1000 c=100 לפי p95=2297.6ms.

## P0

- לא זוהה P0 מקומי: אין oversell, אין corruption ידוע, ואין double money effect בבדיקות אלה.

## P1

- להריץ baseline חוזר ב-staging עם DB מנוהל ונתוני CPU/connection pool.
- לבחון polling: tracking endpoint מחשב aggregate ו-activity בכל קריאה, וב-100 משתמשים כל 6 שניות זה נהיה עומס קבוע.
- להוסיף אינדקסים/EXPLAIN על `participants(deal_id, created_at)`, `participants(participant_id)`, `outbox_events(status, available_at, created_at)` אם staging מראה p95 גבוה.
- לשקול הפרדת worker לתהליך עצמאי לפני pilot רחב, גם אם המונולית מספיק כרגע.

## P2

- cache קצר ל-public deal ו-tracking aggregate.
- CDN לנכסים ותמונות.
- דוחות capacity תקופתיים עם trend לאורך commits.
- export streaming/queue אם Excel של אלפי משתתפים הופך כבד.

## Operational Recommendation

אפשר להישאר במונולית כרגע עבור small pilot. ההמלצה היא tuning בלבד בשלב זה: להפחית/לרכך polling אם staging מאשר עומס, לוודא indexes לפי EXPLAIN, ולהריץ בדיקת עומס חוזרת ב-staging לפני pilot רחב. הפרדת worker אינה חובה מיידית לפי baseline מקומי, אבל היא היעד הראשון אם outbox backlog או latency גדלים.
