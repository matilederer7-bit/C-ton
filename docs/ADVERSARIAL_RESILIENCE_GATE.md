# Adversarial Resilience Gate

Date: 2026-05-07

Scope: defensive local/test/staging validation only. No production, no third-party attack traffic, no external aggressive tooling.

## Start State

- `git status --short`: clean
- `HEAD`: `3db680d chore(deploy): close demo deploy readiness conditions`
- `Get-Process node`: no live node process

## Baseline Readiness

- `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`: PASS
- `npm run bootstrap:demo-db`: PASS, 0 migration warnings
- `npm run bootstrap:demo-db` rerun: PASS, 0 migration warnings
- `npm run test:demo-readiness`: PASS

## Attack Surface Map

### A. Public Buyer Surfaces

- Public deal page/API: `/app/deal/:dealId`, `/api/deals/:id/public`
- Join: `/deals/:id/join`
- OTP: `/app/join/:dealId/otp`, `/api/otp/request`, `/api/otp/start`, `/api/otp/verify`
- Payment authorization: `/api/payments/authorize`, `/api/payments/authorize-mock`, `/api/payments/tokenize`
- Tracking: `/app/track/:participantId`, `/api/participants/:id/tracking`
- Recovery: `/app/recovery/:participantId`, `/api/participants/:id/recovery`
- Chat: `/api/deals/:dealId/chat`
- Public image read: `/api/deal-images/:imageId`

Primary adversarial concerns: oversell under concurrent join, same-buyer repeat purchase contract drift, OTP brute force, unauthorized participant tracking detail, recovery outside the allowed window, XSS in public text/chat, invalid UUID/path handling.

### B. Seller Surfaces

- Session/context/profile: `/api/seller/session`, `/api/seller/session/login`, `/api/seller/context`, `/api/seller/profile`
- Deal creation: `/deals`
- Publish/close/cancel/charging prep: `/deals/:id/publish`, `/deals/:id/close_joining`, `/deals/:id/prepare_charging`, `/deals/:id/charging/start`, `/deals/:id/cancel`
- Duplicate: `/api/seller/deals/:dealId/duplicate`
- Deal reads: `/api/seller/deals`, `/api/seller/deals/:id`
- Exports: `/api/seller/deals/:dealId/shipping-export`, `/api/seller/deals/:dealId/export.xlsx`, `/api/seller/deals/:dealId/delivery-handoff/export.xlsx`
- Analytics: `/api/seller/analytics`
- Delivery handoff: `/api/seller/deals/:dealId/delivery-handoff`
- Images: `/api/seller/deals/:dealId/images`

Primary adversarial concerns: seller ownership isolation, malicious product/seller/shipping text, oversized image/upload payloads, file type spoofing, path traversal in filenames, publish/state transition bypass, export leakage.

### C. Admin Surfaces

- Demo readiness: `/api/admin/demo-readiness`
- Payment/outbox/system/notification ops: `/api/admin/payment-ops-status`, `/api/admin/outbox-status`, `/api/admin/system-status`, `/api/admin/system-ops-status`, `/api/admin/notifications-status`
- Support cases: `/api/admin/support-cases`, `/api/admin/support-cases/:caseId`, `/api/admin/support-cases/:caseId/escalate`, `/api/admin/support`, `/api/admin/support/:ticketId`
- Invoice status: `/api/admin/invoice-status`
- Payout status/readiness: `/api/admin/payout-status`, `/api/admin/payouts/batches/:id`, `/api/admin/sellers/:id/payout-readiness`
- Mission/overview/launch/risk: `/api/admin/overview`, `/api/admin/mission-control`, `/api/admin/launch-console`, `/api/admin/sellers/risk`
- Admin entity reads: `/api/admin/deals/:id/profile`, `/api/admin/deals/:id/ops-summary`, `/api/admin/participants/:id/ops`, `/api/admin/users/:buyerId/profile`
- Admin mutations: `/api/admin/sellers/:sellerId/status`, `/api/admin/seller-auth/:sellerId/provision`, `/api/admin/kyc/:subjectType/:subjectId/decision`

Primary adversarial concerns: fail-closed admin auth, bad admin key, invalid UUID/path params, query injection through admin filters, forbidden manual money actions remaining absent.

### D. Money/State Surfaces

- Authorization: `/api/payments/authorize`, `/api/payments/authorize-mock`
- Capture/recovery/refund state progression: worker/outbox and webhook truth handling, not request-thread capture/finalize.
- Webhooks: `/webhooks/payments`, `/webhooks/payments/mock`, `/webhooks/invoices`
- Invoice: invoice worker/status/provider adapter.
- Payout: seller payout rail/status.
- Platform fee: 8% including shipping, excluding VAT.

Primary adversarial concerns: duplicate webhook, bad signature, late/conflicting webhook, duplicate idempotency key under parallel requests, same idempotency key with different payload, state machine bypass, duplicate charge/capture.

### E. Infra Surfaces

- Bootstrap/migrations: `scripts/bootstrap_demo_db.cjs`, `src/migrations/*`
- Outbox/DLQ: `outbox_events`, `outbox_dlq`, outbox worker helpers/status.
- Notification queue: notification rail/dispatch/status.
- Storage/images: product image storage and `/api/deal-images/:imageId`
- Rate limiter: OTP and runtime guard tests.

Primary adversarial concerns: bootstrap idempotency, stale processing reclaim, provider 5xx retry behavior, DLQ visibility, stuck processing visibility, oversized payload rejection, path traversal prevention, no silent event loss.

## Findings

### P0

- None open.

### P1

- None open.

### P2

- `tests/concurrency_proof.js` was intentionally abandoned after the process hung for several minutes with no useful progress. It was replaced for this gate by the bounded 150-way join storm, same-buyer storm, and last-unit race in `tests/adversarial_resilience_gate_validation.ts`.

## Execution Results

- Compile: PASS.
- Bootstrap clean: PASS, 0 migration warnings.
- Bootstrap rerun: PASS, 0 migration warnings.
- Demo readiness: PASS.
- Load tests: PASS (`150` concurrent join requests, same buyer storm, last unit race).
- Abuse tests: PASS (OTP wrong-code lockout, recovery outside eligible state).
- Auth tests: PASS (admin fail-closed, bad admin key, seller isolation, forbidden constitutional surfaces absent).
- Input validation: PASS (XSS render escaping, SQL-ish params, invalid UUID/path params, oversized title/chat/image).
- Webhook/idempotency: PASS (bad signature, duplicate webhook, late/conflicting webhook, same idempotency key parallel).
- Outbox/worker: PASS (state/audit/outbox atomicity, stale processing visibility, DLQ visibility).
- Storage: PASS (MIME rejection, oversized image rejection, filename traversal safe basename/storage key).

## Fixes During Gate

- `tests/adversarial_resilience_gate_validation.ts`: added focused defensive gate coverage for load, abuse, auth, webhook/idempotency, outbox, input validation, and storage.
- `package.json`: `npm run test:adversarial` now runs the existing adversarial hardening suite plus the new resilience gate; added `npm run test:adversarial-resilience`.
- `tests/adversarial_hardening_validation.ts`: aligned same-idempotency-key/different-payload expectation with the current contract: replay is acceptable, and a clean 409 is also acceptable if no second side effect occurs.

No runtime product feature, constitution, money model, marketplace/search/catalog surface, distributor payout/commission, or test weakening was introduced.

## Verdict

RESILIENCE_READY_FOR_DEMO
