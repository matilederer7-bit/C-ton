# TEST INVENTORY — Unit Mapping

**תאריך:** 2026-05-04
**Branch:** master
**Commit נוכחי:** 31a7fea — docs(rc): add static test results table to RC closure status
**Working tree status:** `?? .rc_rescue_before_changes.patch` (untracked patch file — לא משפיע על הבדיקות)
**Compile status:** `tsc -p tsconfig.test.json --noEmit` — **PASS, אפס שגיאות**

---

## Summary

| קטגוריה | קבצים | Scripts ייעודיים |
|---|---|---|
| **Unit** | 7 | אין scripts ייעודיים (הרצה ידנית לאחר compile) |
| **Static / Contract** | 10 | 4 scripts קיימים, 6 הרצה ידנית |
| **Integration** | 52 | רוב ה-scripts הקיימים |
| **E2E** | 4 | 1 script קיים |
| **Unknown** | 0 | — |
| **סה״כ קבצי בדיקה** | **73** | — |
| **סה״כ scripts בדיקה** | **36** | (כולל `test` הראשי) |

---

## Recommended Unit Gate

פקודות מדויקות להרצה — **ללא DB, ללא שרת חי, ללא browser:**

```bash
# שלב 1: compile (חובה לפני הרצה)
npx tsc -p tsconfig.test.json

# שלב 2: Unit tests (isolated Fastify + fakeWithTx, או HTTP stub)
node .tmp_test_dist/tests/admin_auth_validation.js
node .tmp_test_dist/tests/admin_security_hardening_validation.js
node .tmp_test_dist/tests/payment_authorization_env_guard_validation.js
node .tmp_test_dist/tests/payment_authorization_real_rail_validation.js
node .tmp_test_dist/tests/payment_stripe_adapter_validation.js
node .tmp_test_dist/tests/webhook_hmac_validation.js
node .tmp_test_dist/tests/webhook_secret_policy_validation.js

# שלב 3: Static / Contract tests (סריקת קוד מקור)
node .tmp_test_dist/tests/admin_forbidden_money_actions_validation.js
node .tmp_test_dist/tests/admin_no_public_search_regression_validation.js
node .tmp_test_dist/tests/admin_rtl_surface_validation.js
node .tmp_test_dist/tests/admin_support_product_surfaces_validation.js
node .tmp_test_dist/tests/buyer_document_visibility_validation.js
node .tmp_test_dist/tests/buyer_tracking_refinement_validation.js
node .tmp_test_dist/tests/frontend_foundation_rtl_accessibility_validation.js
node .tmp_test_dist/tests/product_surfaces_refinement_validation.js
node .tmp_test_dist/tests/read_surfaces_truth_alignment_validation.js
node .tmp_test_dist/tests/spec_drift_regression_wave3_validation.js
```

> **הערה על compile:** `tsc -p tsconfig.test.json --noEmit` עובר נקי (0 שגיאות, נבדק 2026-05-04).
> פקודת הרצה בפועל דורשת `tsc -p tsconfig.test.json` (עם emit, כי הקבצים הם ES modules שרצים דרך node).

---

## Unit Tests

| קובץ | פקודת הרצה | מה בודק | requires_db | requires_server | requires_provider | requires_env | safe_for_unit_gate | הערות |
|---|---|---|---|---|---|---|---|---|
| `admin_auth_validation.ts` | `node .tmp_test_dist/tests/admin_auth_validation.js` | Auth middleware: ADMIN_API_KEY validation, HMAC signing, reject/pass | no | no* | no | yes (sets own) | **yes** | יוצר `Fastify()` מבודד + `fakeWithTx`. מגדיר env לפני import |
| `admin_security_hardening_validation.ts` | `node .tmp_test_dist/tests/admin_security_hardening_validation.js` | Security: fail-closed ללא ADMIN_API_KEY, env-driven hardening | no | no* | no | yes (sets own) | **yes** | יוצר `Fastify()` מבודד + `fakeWithTx`. מוחק env vars לפני import |
| `payment_authorization_env_guard_validation.ts` | `node .tmp_test_dist/tests/payment_authorization_env_guard_validation.js` | Guard: provider-ready ללא env fails closed (לא mock) | no | no* | no | yes (sets own) | **yes** | יוצר `Fastify()` מבודד + `fakeWithTx` |
| `payment_authorization_real_rail_validation.ts` | `node .tmp_test_dist/tests/payment_authorization_real_rail_validation.js` | Payment authorization rail — adapter בודק מול HTTP stub מקומי | no | no* | no | no | **yes** | יוצר `http.createServer` stub מקומי + `Fastify()` מבודד, אין DB, אין Stripe אמיתי |
| `payment_stripe_adapter_validation.ts` | `node .tmp_test_dist/tests/payment_stripe_adapter_validation.js` | Stripe adapter: format, HMAC, webhook parsing מול HTTP stub | no | no | no | no | **yes** | HTTP stub בלבד (מדמה Stripe API), אין Fastify app, אין DB |
| `webhook_hmac_validation.ts` | `node .tmp_test_dist/tests/webhook_hmac_validation.js` | Webhook HMAC signature + replay protection | no | no* | no | yes (sets own) | **yes** | יוצר `Fastify()` מבודד + `fakeWithTx`. מגדיר `PAYMENT_WEBHOOK_SECRET` לפני import |
| `webhook_secret_policy_validation.ts` | `node .tmp_test_dist/tests/webhook_secret_policy_validation.js` | Policy: webhook secret validation per deployment mode | no | no | no | yes (sets own) | **yes** | import של `runtime_config.js` בלבד, אין Fastify app, אין DB |

*\* "no server" = יוצר Fastify מבודד עם `fakeWithTx`, לא מאזין על פורט, לא מחייב DB חי*

---

## Static / Contract Tests

| קובץ | script קיים | מה בודק | requires_db | requires_server | requires_provider | requires_env | safe_for_unit_gate | הערות |
|---|---|---|---|---|---|---|---|---|
| `admin_forbidden_money_actions_validation.ts` | אין | אוסר routes לcapture/refund/void/payout באדמין | no | no | no | no | **yes** | קורא `src/frontend_runtime.ts` + `frontend/app.js`, regex assertions |
| `admin_no_public_search_regression_validation.ts` | אין | אוסר חיפוש ציבורי/marketplace/catalog | no | no | no | no | **yes** | קורא קבצי source, regex assertions |
| `admin_rtl_surface_validation.ts` | אין | RTL, Hebrew copy, admin UI structure | no | no | no | no | **yes** | קורא `frontend/index.html`, `frontend/app.js`, `frontend/styles.css` |
| `admin_support_product_surfaces_validation.ts` | `test:admin-support-surfaces` | Admin dashboard product surfaces, urgency hierarchy | no | no | no | no | **yes** | קורא `frontend/app.js`, `frontend/styles.css` |
| `buyer_document_visibility_validation.ts` | `test:buyer-document-visibility` | Buyer document visibility rules in frontend | no | no | no | no | **yes** | קורא `frontend/app.js`, `src/frontend_runtime.ts` |
| `buyer_tracking_refinement_validation.ts` | `test:buyer-tracking-refinement` | Tracking page: authorization vs charge narrative | no | no | no | no | **yes** | קורא `frontend/app.js`, `frontend/styles.css` |
| `frontend_foundation_rtl_accessibility_validation.ts` | `test:frontend-foundation` | RTL root, skip link, accessibility foundations | no | no | no | no | **yes** | קורא `frontend/index.html`, `frontend/styles.css`, `frontend/app.js` |
| `product_surfaces_refinement_validation.ts` | `test:product-surfaces-refinement` | Deal page, seller workspace, product hierarchy | no | no | no | no | **yes** | קורא `frontend/app.js`, `frontend/styles.css` |
| `read_surfaces_truth_alignment_validation.ts` | `test:read-surfaces-truth-alignment` | Read surfaces truth alignment (no invented IDs etc.) | no | no | no | no | **yes** | קורא `frontend/app.js`, `src/frontend_runtime.ts` |
| `spec_drift_regression_wave3_validation.ts` | `test:spec-drift-wave3` | 5 invariants: no marketplace, fee=8%, fee base, repeat-purchase, no affiliate earnings copy | no | no | no | no | **yes** | `readFileSync` — static source grep. מוגדר במפורש כ-"no DB required" |

---

## Integration Tests

כל הקבצים הבאים דורשים PostgreSQL חי ו/או bootstrap מלא של האפליקציה.

### קבוצה A: import pg ישיר + DB operations

| קובץ | script קיים | מה בודק | requires_db | requires_server | requires_provider | requires_env | safe_for_unit_gate |
|---|---|---|---|---|---|---|---|
| `admin_launch_console_validation.ts` | אין | Launch console routes + auth | yes | yes | no | yes | no |
| `admin_observability_proof.ts` | אין | Observability: outbox monitoring, DB queries | yes | yes | no | yes | no |
| `admin_support_cases_validation.ts` | `test:admin-support-cases` | Admin support cases: DB state, outbox | yes | yes | no | yes | no |
| `buyer_recovery_flow_validation.ts` | `test:buyer-recovery-flow` | Buyer recovery payment flow | yes | yes | no | yes | no |
| `buyer_tracking_command_center_validation.ts` | `test:buyer-tracking-command-center` | Buyer tracking command center | yes | yes | no | yes | no |
| `charging_completion_window_validation.ts` | אין | Charging window timing + outbox (43 refs) | yes | yes | no | yes | no |
| `concurrency_proof.ts` | אין | Concurrency safety: DB transactions | yes | yes | no | yes | no |
| `deal_chat_validation.ts` | אין | Deal chat: DB persistence | yes | yes | no | yes | no |
| `deal_duplicate_validation.ts` | אין | Deal deduplication via DB | yes | yes | no | yes | no |
| `deal_images_validation.ts` | אין | Deal images: DB + file handling | yes | yes | no | yes | no |
| `deal_ops_summary_proof.ts` | אין | Operations summary: DB aggregations | yes | yes | no | yes | no |
| `invoice_dispatch_proof.ts` | אין | Invoice dispatch: DB + outbox | yes | yes | no | yes | no |
| `invoice_morning_activation_validation.ts` | אין | Invoice morning activation: DB + Fastify | yes | yes | no | yes | no |
| `invoice_morning_adapter_validation.ts` | אין | Invoice morning adapter: DB + HTTP stub | yes | yes | no | yes | no |
| `invoice_queue_hardening_proof.ts` | אין | Invoice queue hardening: DB + outbox | yes | yes | no | yes | no |
| `invoice_rail_validation.ts` | אין | Invoice rail: DB + outbox | yes | yes | no | yes | no |
| `legal_trust_layer_validation.ts` | אין | Legal trust layer: DB state | yes | yes | no | yes | no |
| `master_product_depth_validation.ts` | `test:master-depth` | Master product depth: imports `pool` מ-`db.js` | yes | yes | no | yes | no |
| `notification_dispatch_proof.ts` | אין | Notification dispatch: DB + outbox | yes | yes | no | yes | no |
| `notification_ops_proof.ts` | אין | Notification ops: DB | yes | yes | no | yes | no |
| `notification_rail_validation.ts` | אין | Notification rail: DB + outbox | yes | yes | no | yes | no |
| `operational_hardening_proof.ts` | אין | Operational hardening: DB + outbox (64 refs!) | yes | yes | no | yes | no |
| `otp_rail_validation.ts` | אין | OTP rail: DB + session | yes | yes | no | yes | no |
| `otp_runtime_guard_validation.ts` | אין | OTP runtime guard: DB | yes | yes | no | yes | no |
| `outbox_reclaim_precision_proof.ts` | אין | Outbox reclaim precision: DB + outbox (36 refs) | yes | yes | no | yes | no |
| `participant_delivery_snapshot_validation.ts` | אין | Participant delivery snapshot: DB | yes | yes | no | yes | no |
| `payment_capture_webhook_real_rail_validation.ts` | אין | Payment capture webhook: DB + outbox | yes | yes | no | yes | no |
| `payment_production_hardening_validation.ts` | אין | Payment hardening: DB + Stripe (stripe=14) | yes | yes | yes (Stripe) | yes | no |
| `payment_recovery_real_rail_validation.ts` | אין | Payment recovery rail: DB + outbox | yes | yes | no | yes | no |
| `payment_refund_real_rail_validation.ts` | אין | Payment refund rail: DB + outbox | yes | yes | no | yes | no |
| `platform_fee_payments_8_percent_validation.ts` | `test:platform-fee-payments` | Platform fee 8%: DB + fee calculations | yes | yes | no | yes | no |
| `seller_analytics_validation.ts` | אין | Seller analytics: DB queries | yes | yes | no | yes | no |
| `seller_auth_authority_validation.ts` | אין | Seller auth authority: DB | yes | yes | no | yes | no |
| `seller_auth_session_validation.ts` | אין | Seller auth session: DB + session hash | yes | yes | no | yes | no |
| `seller_deal_excel_export_validation.ts` | אין | Seller deal Excel export: DB | yes | yes | no | yes | no |
| `seller_enforcement_validation.ts` | אין | Seller enforcement: DB + risk | yes | yes | no | yes | no |
| `seller_payout_rail_validation.ts` | `test:seller-payout-rail` | Seller payout rail: DB + outbox | yes | yes | no | yes | no |
| `seller_profile_readiness_validation.ts` | אין | Seller profile readiness: DB | yes | yes | no | yes | no |
| `seller_shipping_export_validation.ts` | אין | Seller shipping export: DB + Excel | yes | yes | no | yes | no |
| `state_engine_atomicity_validation.ts` | אין | State engine atomicity: DB + outbox (22 refs) | yes | yes | no | yes | no |
| `ultimate_prelive_qa_rc_validation.ts` | `test:ultimate-prelive` | Ultimate pre-live RC: imports `pool` מ-`db.js` | yes | yes | no | yes | no |
| `webhook_truth_handling_validation.ts` | אין | Webhook truth handling: DB + outbox | yes | yes | no | yes | no |

### קבוצה B: import `{ app }` מלא + data operations (ללא import pg ישיר, אך DB נדרש בפועל)

| קובץ | script קיים | מה בודק | requires_db | requires_server | requires_provider | requires_env | safe_for_unit_gate |
|---|---|---|---|---|---|---|---|
| `admin_affiliate_no_commission_regression_validation.ts` | אין | Affiliate: no commission regression | yes | yes | no | yes | no |
| `admin_dashboard_data_validation.ts` | אין | Admin dashboard: DB-backed data | yes | yes | no | yes | no |
| `admin_deal_profile_validation.ts` | אין | Admin deal profile: DB | yes | yes | no | yes | no |
| `admin_omnisearch_validation.ts` | אין | Admin omnisearch: DB queries | yes | yes | no | yes | no |
| `admin_system_status_validation.ts` | אין | Admin system status: DB health | yes | yes | no | yes | no |
| `backend_sanity_suite.ts` | אין | Sanity suite: state machine + app routes (מייבא `assertValidTransition`, `BUYER_TRANSITIONS`) | yes | yes | no | no | no |
| `buyer_delivery_data_validation.ts` | אין | Buyer delivery data at join time | yes | yes | no | yes | no |
| `debug_surface_guard_validation.ts` | אין | Debug route guard: on/off/key | yes | yes | no | yes | no |
| `demo_preview_deployment_validation.ts` | `test:demo-preview` | Demo preview: guardrails meta endpoint | yes | yes | no | no | no |
| `demo_readiness_validation.ts` | `test:demo-readiness` | Demo readiness: env checks + frontend | yes | yes | no | yes | no |
| `frontend_flow_validation.ts` | אין | Frontend flow: HTML serving + routes | yes | yes | no | yes | no |
| `full_product_surface_validation.ts` | `test:product-surface` | Full product surface: all routes | yes | yes | no | no | no |
| `join_flow_qa_validation.ts` | אין | Join flow: uuid guard, oversell, multi-purchase | yes | yes | no | yes | no |
| `rate_limiter_validation.ts` | אין | Rate limiter: max requests per window | yes | yes | no | yes | no |
| `real_integrations_validation.ts` | `test:integrations` | Real integrations: app health | yes | yes | no | no | no |
| `remaining_product_surfaces_validation.ts` | `test:remaining-product` | Remaining product surfaces: routes | yes | yes | no | yes | no |
| `seller_delivery_excel_export_validation.ts` | אין | Seller delivery Excel: creates deals, validates export | yes | yes | no | yes | no |
| `seller_delivery_handoff_validation.ts` | אין | Seller delivery handoff: creates deals + OTP flow | yes | yes | no | yes | no |
| `seller_delivery_no_logistics_management_validation.ts` | אין | No logistics endpoints exist; handoff JSON clean | yes | yes | no | yes | no |

---

## E2E Tests

| קובץ | script קיים | מה בודק | requires_db | requires_server | requires_provider | requires_env | safe_for_unit_gate | הערות |
|---|---|---|---|---|---|---|---|---|
| `frontend_browser_smoke_validation.ts` | `test:frontend-browser-smoke` | Browser smoke: Edge browser, real server, visual checks | yes | yes | no | yes | no | `execFile`/`spawn` — מפעיל Edge browser. **E2E אמיתי** |
| `adversarial_hardening_validation.ts` | `test:adversarial` | Full adversarial: webhook flows, HMAC, filesystem, all layers | yes | yes | no | no | no | מייבא `{ app }`, מעתיק frontend לתיקיית tmp, בודק כל השכבות |
| `full_system_qa_validation.ts` | `test:full-system` | Full system QA: כל flows ביחד | yes | yes | no | no | no | אותו pattern כמו adversarial |
| `preprod_torture_validation.ts` | `test:preprod-torture` | Pre-production torture: concurrent, edge cases, stress | yes | yes | no | yes | no | `test_ip()` concurrency, rate limits, full stack |

---

## Unknown / Needs Classification

אין. כל 73 קבצים מסווגים.

---

## Excluded From Unit Gate

**לא להריץ ביוניט Gate — DB, E2E, או provider חיצוני נדרש:**

- כל 52 קבצי Integration (קבוצה A + B לעיל)
- `frontend_browser_smoke_validation.ts` (browser)
- `adversarial_hardening_validation.ts` (E2E full stack)
- `full_system_qa_validation.ts` (E2E full stack)
- `preprod_torture_validation.ts` (E2E torture)
- `payment_production_hardening_validation.ts` (Stripe חי)

---

## Next Step

**READY_TO_DEFINE_UNIT_GATE**

כל 17 קבצים (7 Unit + 10 Static/Contract) ניתנים להרצה ללא DB, ללא שרת חי, ללא browser.
פקודות מדויקות מפורטות ב-"Recommended Unit Gate" לעיל.