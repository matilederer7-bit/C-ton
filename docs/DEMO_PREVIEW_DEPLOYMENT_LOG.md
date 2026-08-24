# Demo / Preview Deployment Log

> **Historical product-scope notice (2026-08-23):** this log predates the
> binding V1.1 Siton Mall decision. It is deployment evidence, not current
> product-direction canon.

## Phase A - Demo Deployment Surface Audit

- Display surfaces mapped for preview:
  - public visitor marketplace and public deal page
  - buyer join, OTP, authorization, confirmation, tracking
  - seller dashboard and seller deal detail
  - affiliate workspace
  - admin dashboard, system status, KYC, settlements, support, forensics
- Routes that must stay live for demo:
  - `/app`, `/app/marketplace`, `/app/deal/:dealId`
  - `/app/join/:dealId/otp`, `/app/join/:dealId/payment`, `/app/join/:dealId/confirmation`
  - `/app/track/:participantId`
  - `/app/seller`, `/app/seller/new`, `/app/seller/deals/:dealId`
  - `/app/affiliate`
  - `/app/admin`, `/app/admin/deals/:dealId`, `/app/admin/users/:buyerId`
  - `/health`, `/health/integrations`
- Surfaces that could mislead if left unguarded:
  - payment/auth can look like live charging
  - receipts can look like real invoices
  - delivery can look like live shipping execution
  - affiliate payout and KYC can look externally activated
  - notification hooks can look actually delivered
- Mock-backed or inactive rails:
  - payment provider is still `mock-backed`
  - notifications are still `log-only`
  - invoice, shipping, payout, and KYC rails are still external-only

## Phase B - Demo Safety Guardrails

- Added canonical deployment mode in runtime config:
  - `APP_DEPLOYMENT_MODE`
  - `IS_DEMO_PREVIEW`
- Added `GET /api/preview/meta` for preview guardrails and public demo metadata.
- Added deployment mode to `/health/integrations`.
- Extended admin system-status with explicit deployment boundary.
- Tightened seller receipts/delivery notes so they do not imply live invoice or carrier execution.
- Tightened affiliate note so it does not imply live payout execution.

## Phase C - Preview UX and Messaging Hardening

- Added a global preview strip in the frontend shell.
- Reframed the home page as preview product surface rather than product-build history.
- Added buyer-side demo guardrail copy.
- Added seller receipts and delivery demo notes.
- Added affiliate payout preview boundary note.
- Added runtime mode visibility in admin.

## Phase D - Deployment Packaging and Runtime Readiness

- Runtime mode defaults to `demo-preview`.
- Demo entry command is now available as `npm run start:demo`.
- Validation passed:
  - `node --check frontend/app.js`
  - `npx tsc --noEmit`
  - `npm run test:demo-preview`
  - `npm test`
- `.tmp_test_dist` removed after validation.
- No lingering `node` process remained after the pass.

## Phase E - Demo RC Drill

- PASS: `/health`
- PASS: `/health/integrations`
- PASS: preview meta route
- PASS: buyer critical flow remains live
- PASS: seller, affiliate, and admin surfaces remain reachable
- PASS: receipts and delivery semantics stay contractually honest
- PASS: no temp residue
- PASS: canonical `PROJECT_STATUS.md` updated
- NON-BLOCKING:
  - payment is still mock-backed by design
  - notifications are still log-only by design
- EXTERNAL-ONLY:
  - invoice rail
  - shipping rail
  - payout rail
  - KYC provider
  - real payment provider

## Phase F - Final Assessment

- The system is ready for live showcase as a demo / preview deployment.
- Internal guardrails now make the preview boundary explicit instead of implicit.
- Remaining gaps are external-only or intentional demo-only boundaries.
