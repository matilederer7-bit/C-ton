# PROJECT STATUS

����� �����: 2026-03-18

## ����� ��� ������

������ ������� ������.
health check ����.
���� ���� ���� ��:
tsx src/app.ts

���� ������ ������� �worker �app.ts ��� ����� handlers ��������.
���� �� ����� DB ����� ������ QA.
���� �� ����� runtime ������ ������ ��� 1.

handlers ������:
- handleRefundEvent
- handleChargeDealEvent
- handleRecoveryDealEvent
- handleFinalizeDealEvent

dispatch ����� �worker:
- deadline_check ���� inline
- charge_deal ����� �handleChargeDealEvent
- recovery_deal ����� �handleRecoveryDealEvent
- finalize_deal ����� �handleFinalizeDealEvent
- refund_issue �cancel_refund ������� �handleRefundEvent

## �� �����

1. ����� workspace
- ���� legacy ������ �archive/legacy_review
- ���� ops ������ �archive/ops_scripts
- ������ refactor ������ �archive/refactor_backups

2. ����� TypeScript
- tsconfig ����� �� ������ �� src/**/*.ts
- archive, node_modules, docs �������
- npx tsc --noEmit ���� ������

3. ����� runtime
- package.json ����� ����� ��:
  tsx src/app.ts
- ����� ����� ����� �� ts-node/esm �runtime ����
- ����� ������ ExperimentalWarning �DEP0180 ���� �Node 24
- health check ����� ����� �����

4. ������ worker
- outbox helper ���� �src/outbox_worker_helpers.ts
- payment attempt helper ���� �src/payment_attempt_helpers.ts
- refund handler ����
- charge handler ����
- recovery handler ����
- finalize handler ����

5. ����� DB ���� QA
- payment_attempts ����� ����� �idempotent insert ������� ON CONFLICT DO NOTHING
- ���� migration:
  src/migrations/012_payment_attempts_idempotency.sql
- ����� ����� �attempt_type = deadline_check
- ����� ����� �attempt_type = cancel_refund
- ���� duplicates ��������� �payment_attempts
- ���� unique index ���� ��:
  participant_id, deal_id, attempt_type, correlation_id

6. ����� outbox DLQ
- ����� INSERT ... SELECT * ������ ������ ��� ������
- ���� mismatch ��� outbox_events ���� outbox_dlq

7. ����� ������
- ����� tsx �runtime ����� ����
- ���� npm audit fix
- npm audit ��� ��� ��� vulnerabilities

## QA �����

1. QA ������� ���� �������
- join
- charging
- finalize
- outbox
- recovery
- retry
- sent_at
- finalize readiness

2. QA ���� �������
- compile check
- health check
- spot checks �� handlers
- spot checks �� dispatch map
- regression flow ��� �� deal ���

3. QA ��� 1
- startup baseline
- restart baseline
- runtime warning investigation
- ����� runtime �tsx
- audit fix
- compile recheck
- clean restart recheck

4. regression ��� ���� ����
�����:
- create deal
- publish
- join buyer-a
- join buyer-b
- close_joining
- prepare_charging
- charging/start
- worker processing
- ���� �CompletionWindow
- ����� finalize_deal
- recovery_deal ���� ����� �����

����� regression ����:
- deal ���� �CompletionWindow
- outbox ��� ����
- recovery ��� ����
- payment_attempts �� ��� ������ �����
- �� ����� DLQ ������ ������

## �� ����

1. ����� ������ ����
�� ������ ����� ���:
- ���� ���
- docs/runtime-contract-resolution.md
- docs/db-drift-resolution.md
- ��� ������� �������� ������� docs

2. ����� ����
������ ���:
- ������ �� deadline_check
- �� ������� ���� inline

3. QA ��� ��� ���� ������
- ��� 2 ���� �����
- ��� 3 ���� ������
- ����� ������� ������ ��� ����� �QA

## ����� ���

- ������ worker handlers: 100%
- ����� workspace: 100%
- compile stability: 100%
- runtime stability: 100%
- DB alignment critical fixes: 100%
- runtime hardening �� Node 24: 100%
- dependency security baseline: 100%
- regression QA ���� �������: 100%

���� ������ �������:
- ��� 1 ������ ����� ����� ����� �����: 100%
- ����� ������ ��� ��� docs: ����� ����
- QA ��� �� ��� ������: ����� ����

## ���� ��� ������

1. ����� �� ��� 2 ���� ������
2. ������ ����� ��� ����, �DB �������
3. ���� ������ ��� drift ���� ������

## 2026-03-18 ������ ���� ������

�� �����
- ���� ����� housekeeping ��� �����
- ���� ��� ������ ������ ������ ������� ����� ��� archive/housekeeping_2026-03-18/root_temp
- ���� ����� �� ������ ������� ������ ���� src ������ ������� ��� archive/housekeeping_2026-03-18/src_temp
- ���� ���� ��������� RUNTIME_CONTRACT_FINAL.md ����� ������� ������ ��� ����
- ��"� ������ ����� ������� reports
- .gitignore ����� ��� ����� ��� �����

�� ����
- ����� ����� ������: src/app.ts, helpers, migrations, scripts, docs ��������
- �� ����� ����� �� ���� ���
- ������ ���� ������, �� ������ �������

�� ����
- ����� ���� ���� ���� ���� �� scripts �� ����� ����� �� ������ ����
- ����� ���� ������ �� �� ���� ������ �� �� ����� �docx ��� git

������
- ������ ����: 90%
- ���� �����: �����
- ����� �����: �����

���� ���
- ����� git status �����
- commit ����� �� ����� ������� �� ������ �����


## 2026-03-23 QA ��� 8 ���� �� finalize

�� �����
- ����� 1 �� 7 ����
- ���� ����� refund ���� ������
- ������ ������ �� ����� ��� Dropped �� AuthReleased
- ������ ��� Recovered �� RecoveredCharge

�� ����
- finalize_deal ���� �outbox
- status ��� ���� pending
- available_at ��� ���
- refund_issue ����� �� ���� �� finalize �� ����� �� �����

�� ����
- ����� ��� finalize_deal �� ���� ��worker ����
- �� ���� ����� �� ���� ����� �� ��� 8 refunds

������
- ����� 1 �� 7: 100%
- ��� 8: ����
- QA ���� �� ��: ���� 70%

���� ���
- ����� ����� ����� �� finalize_deal pending


## 2026-03-23 QA ��� 8 ����

�� �����
- ��� 8 ���� ������
- ���� ����� cancel ����� �� deal �-Draft
- ���� ����� refund ��� �� ���� ������ ���� charging ����
- ���� ��� ���� �-outbox_worker_helpers.ts ���� ����� DLQ �� locked_at ��� ���� �����

�� ����
- deal ��� �-Failed ���� finalize �� captured units ���� ��-threshold
- ���� refund_issue ����� ������
- participant ��� ��� ���� ���� ���� �� AuthReleased
- participant ��� ����� ���� ��� �-Refunded
- buyer_state �� �������� ����� �-DealFailed
- payment_attempts ��� refund �� success
- �� ���� DLQ ������ refund �����

�� ����
- ����� ������ ��� ��� ��� ����� docs ���� ���� ��� ����� ����
- ���� ������ �� ������ deadline_check �-handler ������ ����� inline
- ���� ����� ���� QA ��� �� ������ cleanup �-commit

������
- ����� 1 �� 8: 100%
- QA ������� ����� ������: 100%
- ����� ������ ���: ����� ����

���� ���
- ����� commit �����
- ������ �� ������� ���� QA ��� �� ������ ����� �����


## 2026-03-23 ����� ����� QA 12 �����

����� ��� �����

����� QA ��� �� 12 ����� ����� �� ������ ��� �� �����.
������� ����� ����� �� ���� ������, ��� ���� �������, ��� outbox, ��� worker, ���� debug endpoints.
������ ����� �������� ������� �� ������ ����� ���� ����, ���� ������� ������, ������ ���, recovery, finalize, refund, idempotency, auditability ����� ���.

�� �����

- ��� 1 ������ ����� ����� ����� ���
- ��� 2 ���� ����� ���
- ��� 3 ���� DB ���
- ��� 4 endpoint�� ������� ���
- ��� 5 charging flow ���
- ��� 6 recovery ���
- ��� 7 finalize ���
- ��� 8 cancel �-refund ���
- ��� 9 outbox �-worker ���
- ��� 10 idempotency ���
- ��� 11 auditability ���
- ��� 12 edge cases ���

������� ������� ������ ����� ����

- migration 013 ���� NOT NULL �� payment_attempts ���� participant_id, deal_id, attempt_type, correlation_id
- create deal idempotency ���� �� ����� Idempotency-Key ����� ���� deal_id �� replay �����
- guards �� prepare_charging ��� charging/start ������
- harness ������ recovery ����� ������� permanent_fail, recovery success �-recovery fail
- �-outbox_worker_helpers.ts ���� ��� ���� �� ����� DLQ ������� �-locked_at ����� ���� ����� �-outbox_events
- publish ���� �� �-deadline_check ������ ���� �-deadline ������ ��� ���� ������
- failAllParticipantsForDeal ���� �� ����� ������� ����� �� ����� �-DealFailed �� AuthHeld �� AuthLocked, ��� ������ �-AuthReleased
- ���� global error handler ������ invalid_state_transition �-409 ����� 500 ����� ����� state mismatch �-illegal transitions

�� ���� �����

- create
- publish
- join
- close_joining
- prepare_charging
- charging/start
- charge success
- charge failure
- recovery success
- recovery failure
- finalize success
- finalize fail
- refund �����
- cancel
- idempotency create
- idempotency join
- audit log consistency
- outbox dispatch
- worker retries
- edge cases �������

�� ����

- ���� ������ ��� ����
- health check ����
- state machine ���� ������� �����
- outbox �-worker ������ �����
- payment_attempts ������ ����
- idempotency ���� ������� �������
- auditability ���� �����
- refund ����� ���� ���� ������ finalize_failed
- ���� ��� ������� ��� ���� ������� 500 ����� ��� ������ domain ������

�� ����

- ����� ������ ��� ��� ��� ����� docs ���� ���� ��� ����� ����
- cleanup �� ������� QA ������ ����� ����
- commit ����� �� ��� ����� ����� ����
- ���� ������ ����� �� ���� �� deadline_check �-handler ������ ����� inline

������

- ����� QA �� 12 �����: 100%
- ������ ���� ������: 100%
- ����� ������ ���: ����� ����
- cleanup �-commit: ����� ����

���� ���

- ���� cleanup ����� �� ������� QA ������
- ����� �� ������ ������ �� ����� �� ���� ���
- ���� commit ����� ���� ����� git status
## milestone update - payload mismatch idempotency closed

תאריך: 2026-03-24

מה הושלם
- הוטמעה שכבת request_hash בזרימת idempotency
- תוקן חישוב ה-hash כך שיתבסס על request payload ולא על response
- תוקן join flow כך שלא יבצע mutation שקט לפני בדיקת idempotency רלוונטית
- נוספה עמודת request_hash ל-siton.idempotency_log
- תוקן global error handler כך שיחזיר 400 בבקשות same key with different content במקום 500

מה נבדק
- בקשה ראשונה עם idempotency key חדש ו-payload תקין הצליחה
- בקשה חוזרת עם אותו key ואותו payload חזרה כ-replay תקין
- בקשה עם אותו key אבל payload שונה נחסמה
- נבדק ישירות ב-DB כי qty נשאר 2
- נבדק ישירות ב-DB כי request_hash נשמר ב-idempotency_log

ממצאים מוכחים
- אין silent mutation תחת אותו idempotency key עם payload שונה
- HTTP contract במצב הנוכחי: same key + different payload מחזיר 400
- row ב-idempotency_log נשמר עם request_hash לא ריק
- participant נשאר עם:
  - buyer_state = JoinedAuthorized
  - money_state = AuthHeld
  - qty = 2

מה פתוח
- worker restart באמצע batch
- zombie processing / stuck in_progress handling
- DLQ behavior
- retry storm / duplicate processing hardening
- duplicate webhook handling
- עומסי קצה ו-concurrency stress

אחוזי התקדמות
- backend runtime + QA hardening: 97%
- סעיף payload mismatch idempotency: 100%

הצעד הבא
- להריץ QA ממוקד על worker restart + zombie lock recovery
## milestone update - zombie reclaim closed

תאריך: 2026-03-24

מה הושלם
- נוספה עמודת processing_started_at ל-siton.outbox_events
- נוספה פונקציית reclaimStuckProcessing ב-outbox worker helpers
- workerLoop חובר להרצת reclaim בכל סבב
- נוסף ניקוי processing_started_at במסלולי sent ובחזרה ל-pending

מה נבדק
- בוצע restart נקי לשרת
- הוזרק ידנית אירוע outbox במצב processing עם processing_started_at ישן
- ה-worker זיהה את האירוע התקוע
- האירוע לא נשאר stuck
- האירוע התקדם בפועל עד status = sent
- processing_started_at אופס ל-null

ממצאים מוכחים
- אין תלות בכך שהתהליך המקורי ש-claim את האירוע יישאר חי
- zombie events אינם נשארים תקועים על processing ללא התאוששות
- worker reclaim מחובר ריצה ולא רק כתוב בקוד

אחוזי התקדמות
- חבילת ה-QA הקריטית שנפתחה כאן: 100%
- backend runtime + QA hardening: 100% לשני הסעיפים הקריטיים שטופלו כעת

מה פתוח
- DLQ behavior תחת כשל חוזר קיצוני
- retry storm hardening
- duplicate webhook handling
- concurrency stress רחב
- volume / soak tests

הצעד הבא
- לעבור ל-DLQ ול-retry storm
## 2026-03-25 - סגירת תיקון join, קנייה חוזרת ואכיפת max_units

סטטוס כללי
הושלם

אחוז התקדמות כולל
78%

מה הושלם
- בוצע מיפוי מלא למסלול join בקוד החי
- הוכח שהמימוש הישן לא אכף max_units במסלול ההצטרפות
- הוסרה חסימת DB שמנעה קנייה חוזרת של אותו buyer באותה עסקה
- תוקן מסלול join כך שכל בקשת רכישה יוצרת participant חדש
- נוספה אכיפת קיבולת כוללת תחת lock על שורת deal
- התיקון בוצע דרך המסלול האטומי הקיים, בלי להחזיר את המערכת למוטציות ידניות
- typecheck נקי
- QA סופי הוכיח:
  - join ראשון הצליח
  - join שני של אותו buyer הצליח עם participant_id חדש
  - join שלישי נחסם עם 409 בגלל max_units exceeded

מה נבדק
- בדיקת קוד חיה של route join
- בדיקת DB constraints ו triggers
- direct insert ל participants כדי לוודא שאין חסימת DB נסתרת
- בדיקות HTTP אמיתיות מול השרת
- בדיקת typecheck עם npx tsc --noEmit
- בדיקת התנהגות חוזרת לאותו buyer
- בדיקת חסימת חריגה מהתקרה הכוללת

מה פתוח
- בדיקת עומס רחבה על concurrency של join בתרחיש ריבוי בקשות כמעט במקביל
- עדכון מסמכי ייחוס נוספים אם צריך מעבר ל PROJECT_STATUS
- בחינה אם נדרש לשמר או להסיר את לוגי הדיאגנוסטיקה שהוכנסו לצורך הבידוד

החלטות מחייבות שנקבעו
- buyer_id נשאר שדה מזהה חשוב, אך אינו מפתח ייחוד עסקי של השתתפות בעסקה
- אותו buyer רשאי לבצע כמה רכישות שירצה
- האיסור הוא רק על חריגה מהתקרה הכוללת של העסקה
- idempotency נשארת ברמת הבקשה, לא ברמת buyer יחיד לעסקה

הצעד הבא
להריץ בדיקת עומס ממוקדת למסלול join על תרחיש ריבוי בקשות במקביל, ולאמת שאין חריגת הצלחות מעל max_units גם תחת concurrency


## כלל מוצר קנוני  קיבולת העסקה

הכלל המחייב הוא זה:
אין כל מגבלה על מספר הקונים בעסקה.
אין כל מגבלה על מספר פעולות join של אותו buyer באותה עסקה.
אין כל מגבלה על סך היחידות ש buyer בודד יכול לרכוש, כל עוד לא נחצתה הכמות הכוללת המותרת בעסקה.
האכיפה היחידה היא על הכמות הכוללת של העסקה לפי max_units.
אם נשארו 4 יחידות בלבד, כל בקשה מעל 4 חייבת להידחות או להיות מטופלת לפי חוקי הקיבולת של המערכת.
כל טקסט ישן שמרמז על buyer יחיד, participant יחיד ל buyer, או איסור על רכישה חוזרת, מבוטל.
## 2026-03-31 real integrations closure

מה הושלם
- backend remains professionally closed with non-blocking follow-ups
- frontend remains MVP closed with non-blocking follow-ups
- payment abstraction was added and unified across frontend authorization and backend execution
- webhook ingestion readiness was added with duplicate-safe HTTP handling
- notification boundary was added
- integration observability now includes `/health/integrations`
- integration validation suite was added

מה נבדק
- `npx tsc --noEmit` passed
- `npm test` passed
- integration validation passed for:
  - `/health/integrations`
  - payment authorization success/failure mapping
  - webhook first delivery handling
  - webhook duplicate acceptance
- existing buyer flow validation still passed after the integration changes

מה partial
- payment provider is still mock-backed
- notifications are still log-only
- webhook ingestion stores/classifies events but does not yet reconcile provider callbacks into domain mutations

מה open
- implement one real payment provider adapter
- implement provider-specific webhook reconciliation
- choose and implement first real notification provider

אחוז התקדמות משוער
- backend: 95%
- frontend: 90%
- real integrations readiness: 80%
- overall product readiness: 88%

השלב הבא
- replace the mock payment provider with one real provider behind the new adapter boundary, then connect its webhook catalog into domain reconciliation
## 2026-03-31 real payment and reconciliation closure

מה הושלם
- payment provider readiness surface was strengthened
- webhook ingestion now performs domain reconciliation for the minimal charge/recovery event set
- frontend/runtime alignment was cleaned where payment/auth APIs touch the buyer flow

מה נבדק
- `npx tsc --noEmit` passed
- `npm test` passed
- charge success reconciliation was validated
- charge failure reconciliation was validated
- webhook duplicate handling still passed
- health endpoints still passed

מה תוקן
- payment readiness env/config surface
- webhook-to-domain mutation path
- correlation and replay behavior for the minimal supported provider event set

מה partial
- active provider remains mock-backed
- provider-ready mode exists but is not yet connected to a live external provider
- reconciliation covers the minimal charge/recovery set, not a full provider catalog

מה non-blocking
- notifications remain log-only
- no git remote is configured, so no push was performed

מה open
- implement one live provider adapter
- extend reconciliation to the chosen provider's full webhook catalog

אחוז התקדמות משוער
- backend: 95%
- frontend: 90%
- real integrations readiness: 88%
- real payment and reconciliation readiness: 85%
- overall product readiness: 90%

השלב הבא
- wire one real payment provider behind the provider-ready boundary and expand webhook reconciliation from the current minimal event set to the provider's full event matrix
## 2026-03-31 internal maximal closure

מה הושלם
- internal closure audit was completed across product, frontend, backend, runtime, payment abstraction, webhook reconciliation, tests, and operational confidence
- real integration validation was expanded to cover recovery success, recovery failure, and unsupported webhook-event safety
- canonical internal-closure decision and handoff documents were added

מה נבדק
- `npx tsc --noEmit` passed
- `npm test` passed
- integration validation passed for:
  - payment authorization contract
  - duplicate webhook handling
  - charge success reconciliation
  - charge failure reconciliation
  - recovery success reconciliation
  - recovery failure reconciliation
  - unsupported webhook-event safety

מה תוקן
- internal validation depth around payment/webhook reconciliation
- canonical truth for what is internally closed versus what depends on future external activation

מה עדיין פתוח
- live payment provider execution
- full provider-specific webhook event catalog
- real outbound notification transport

מה non-blocking
- payment remains mock-backed by design
- notifications remain log-only by design
- no git remote is configured, so no push was performed

מה תלוי ביציאה החוצה
- first live provider adapter
- real provider webhook catalog mapping
- first real notification provider

אחוז התקדמות משוער
- backend: 95%
- frontend: 90%
- real integrations readiness: 88%
- internal maximal closure: 94%
- overall product readiness: 91%

השלב הבא
- keep the system closed internally and only then choose the first real provider for the external activation pass
## 2026-03-31 full system qa pass

מה הושלם
- full-system QA was completed across backend, frontend, internal integrations, reconciliation, tracking, and operational surfaces
- a dedicated full-system validation suite was added and wired into `npm test`
- canonical full-system QA decision and handoff documents were added

מה נבדק
- `npx tsc --noEmit` passed
- `npm test` passed
- full-system QA passed for:
  - public deal page to tracking happy path
  - capacity and availability coherence
  - cancelled and unknown deal handling
  - OTP invalid and OTP missing-session handling
  - payment authorization failure handling
  - charged, recovered, and dropped tracking semantics
  - `/health`
  - `/health/integrations`
  - webhook unauthorized handling

מה תוקן
- otp verify frontend-facing contract now explicitly returns `ok: true`
- full-system QA coverage was added so the system is proven as one coherent product

מה עדיין פתוח
- live external payment provider execution
- full provider webhook catalog
- real outbound notification delivery

מה non-blocking
- payment remains mock-backed by design
- notifications remain log-only by design
- no git remote is configured, so no push was performed

מה תלוי ביציאה החוצה
- first live provider adapter
- provider-specific webhook matrix expansion
- first real notification transport

אחוז התקדמות משוער
- backend: 95%
- frontend: 92%
- real integrations readiness: 88%
- internal maximal closure: 94%
- full system QA: 94%
- overall product readiness: 93%

השלב הבא
- move from internal proof to the first controlled external-activation pass behind the existing provider and webhook boundaries
## 2026-03-31 adversarial hardening pass

מה הושלם
- adversarial hardening was completed across api abuse, input abuse, sequence abuse, idempotency abuse, webhook abuse, frontend misuse, and weird-state operational checks
- a dedicated adversarial validation suite was added and folded into `npm test`
- canonical adversarial decision and handoff documents were added

מה נבדק
- `npx tsc --noEmit` passed
- `npm test` passed
- adversarial validation passed for:
  - malformed deal creation payloads
  - invalid uuid route params
  - otp abuse paths
  - broken flow sequencing
  - idempotent duplicate and conflicting replay behavior
  - malformed, unknown, and duplicate webhooks
  - direct frontend route misuse

מה תוקן
- deal creation input validation
- uuid validation on sensitive route params
- otp phone and session precondition validation
- webhook body-shape validation
- controlled `409` mapping for broken sequence/state abuse

מה עדיין פתוח
- live provider execution
- full provider-specific webhook matrix
- real notification transport

מה non-blocking
- payment remains mock-backed by design
- notifications remain log-only by design
- no git remote is configured, so no push was performed

מה תלוי ביציאה החוצה
- first live payment provider
- provider-specific webhook matrix expansion
- first real notification channel

אחוז התקדמות משוער
- backend: 96%
- frontend: 92%
- real integrations readiness: 89%
- full system QA: 94%
- adversarial hardening: 95%
- overall product readiness: 94%

השלב הבא
- start the first controlled external-activation pass and attack the chosen real provider boundary with the same adversarial methodology

## 2026-03-31 preprod torture qa pass

מה הושלם
- pre-production torture QA and RC-style drill were completed across mixed load, soak-like reads, ugly ordering, route misuse, and operational pressure
- a dedicated preprod torture validation suite was added and folded into `npm test`
- canonical preprod torture decision and handoff documents were added

מה נבדק
- `npx tsc --noEmit` passed
- `npm test` passed
- preprod torture validation passed for:
  - concurrent deal reads, shell loads, OTP, payment, and join pressure
  - exact `max_units` enforcement under concurrent joins
  - soak-style public/tracking reads without silent degradation
  - out-of-order and duplicate charge/recovery webhook handling
  - stale or missing flow context
  - `/health`
  - `/health/integrations`
  - unauthorized webhook rejection under pressure

מה תוקן
- a dedicated torture/preprod harness was added so RC confidence now rests on automated mixed-load and ugly-sequence proof
- the torture harness was corrected to assert the real runtime contract rather than a non-canonical payment-attempt assumption

מה עדיין פתוח
- live provider execution
- full provider-specific webhook matrix
- real outbound notification transport
- true external-process restart proof under staging-like runtime conditions

מה non-blocking
- payment remains mock-backed by design
- notifications remain log-only by design
- no git remote is configured, so no push was performed

מה תלוי ביציאה החוצה
- first live payment provider
- provider-specific webhook expansion
- real notification channel
- staging-like restart/recovery proof outside `app.inject`

אחוז התקדמות משוער של המוצר
- backend: 96%
- frontend: 92%
- real integrations readiness: 89%
- full system QA: 94%
- adversarial hardening: 95%
- preprod torture QA: 96%
- overall product readiness: 95%

מה השלב הבא
- run the first controlled staging/external-activation pass behind the existing provider and webhook boundaries, instead of reopening more internal-only proof cycles
