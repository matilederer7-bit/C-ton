# C-ton Sandbox Dry-Run Report

Date: 2026-05-11
Runtime SHA: 9e371d3
Verdict: SANDBOX_DRY_RUN_PARTIAL

## Scope

This report covers a controlled attempt to run the next C-ton sandbox dry-run gate after the MVP audit verdict `READY_FOR_SANDBOX_DRY_RUN`.

This was not a real-money pilot, did not use production, did not enable debug publicly, did not commit, and did not push.

## Environment Safety

- `DEBUG_SURFACES_ENABLED`: unset.
- `DEBUG_SURFACES_ACCESS_KEY`: unset.
- `ADMIN_API_KEY`: unset in the current shell, so a true dry-run runtime cannot be started safely from this environment.
- `PAYMENT_PROVIDER`: unset.
- `PAYMENT_PROVIDER_MODE`: unset.
- `PAYMENT_PROVIDER_BASE_URL`: unset.
- `PAYMENT_PROVIDER_API_KEY`: unset.
- `PAYMENT_WEBHOOK_SECRET`: unset.
- No lingering Node process remained after the run.
- No secret values were printed by the audit commands.

Because required sandbox provider/admin env was missing, an external provider sandbox dry-run was not executed. Existing real-like provider-ready tests were run instead.

## Evidence Run

| Area | Result | Evidence |
| --- | --- | --- |
| Typecheck | PASS | `npx tsc -p tsconfig.test.json` |
| Provider production guard | PASS | `npm run test:provider-production-readiness` |
| Provider-ready authorization transport | PASS | `node .tmp_test_dist/tests/payment_authorization_real_rail_validation.js` |
| Capture + signed webhook + replay safety | PASS | `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js` |
| Server-side money authority | PASS | `npm run test:server-side-money-authority` |
| Seller export money consistency | PASS | `node .tmp_test_dist/tests/seller_deal_excel_export_validation.js` |
| Webhook HMAC negative tests | PASS | `node .tmp_test_dist/tests/webhook_hmac_validation.js` |
| Admin guard | PASS | `node .tmp_test_dist/tests/admin_security_hardening_validation.js` |
| Debug guard | PASS after isolated rerun | `node .tmp_test_dist/tests/debug_surface_guard_validation.js` |
| Payment env fail-closed | PASS | `node .tmp_test_dist/tests/payment_authorization_env_guard_validation.js` |
| Invoice activation guard | PASS | `node .tmp_test_dist/tests/invoice_morning_activation_validation.js` |
| State/outbox atomicity | PASS | `node .tmp_test_dist/tests/state_engine_atomicity_validation.js` |

## Observations

- The current shell is not configured for a true dry-run because `ADMIN_API_KEY`, non-mock payment provider mode, provider base URL, provider API key, and webhook secret are missing.
- The provider-ready local HTTP stub proves non-mock code paths can authorize/capture through a real HTTP adapter shape, but it is not an external sandbox provider.
- Capture was exercised only in the real-like test harness and stayed behind successful deal completion.
- Signed webhook and replay behavior passed in the harness: duplicate webhook was accepted idempotently and did not create a double capture.
- Fake price/amount and invalid quantity were rejected or ignored by server authority tests.
- Webhooks without/with bad signature were rejected.
- Admin/debug without proper keys were blocked.
- Seller Excel export matched server money and blocked unauthorized seller access.

## Negative Tests

| Negative test | Result |
| --- | --- |
| Fake client amount/price/total | PASS via `test:server-side-money-authority` |
| Quantity string/boolean/exponent/invalid | PASS via `test:server-side-money-authority` |
| Webhook missing signature | PASS via `webhook_hmac_validation` |
| Webhook wrong signature | PASS via `webhook_hmac_validation` |
| Debug without access key | PASS via isolated `debug_surface_guard_validation` |
| Admin without/wrong key in production-like mode | PASS via `admin_security_hardening_validation` |
| Unauthorized seller export | PASS via `seller_deal_excel_export_validation` |
| Webhook replay | PASS via `payment_capture_webhook_real_rail_validation` |

## Issues

- A parallel run of `debug_surface_guard_validation` with `state_engine_atomicity_validation` produced a database deadlock; rerunning debug alone passed. Treat this as a harness/concurrency issue, not as evidence that debug is open.
- External provider sandbox env was missing. This prevents `SANDBOX_DRY_RUN_PASS`.
- `invoice_queue_hardening_proof` remains a separate known P1 harness issue from the prior audit.

## Open Items

P0:
- None proven in the code paths exercised here.

P1:
- Configure a real sandbox provider environment outside the repo.
- Configure `ADMIN_API_KEY` for the dry-run runtime.
- Re-run the same flow against the external provider sandbox and record non-sensitive provider request/webhook IDs.
- Fix `invoice_queue_hardening_proof` harness separately.
- Human user test remains external.

## Recommendation

Stay in sandbox. Do not run a money pilot. The next gate is an actual external provider sandbox dry-run with explicit env, admin key, DEBUG disabled, and non-sensitive request/webhook IDs recorded.
