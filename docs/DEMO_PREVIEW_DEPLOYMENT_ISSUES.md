# Demo / Preview Deployment Issues

## Fixed In This Pass

- Missing canonical demo/preview runtime mode.
  - Fixed by adding `APP_DEPLOYMENT_MODE`, `IS_DEMO_PREVIEW`, and `/api/preview/meta`.
- Admin operational surface did not expose deployment mode explicitly.
  - Fixed by extending `/api/admin/system-status`.
- Seller receipt and delivery semantics could be read too literally for a public demo.
  - Fixed by tightening receipt and delivery notes.
- Affiliate payout messaging could still feel closer to a live payout rail than intended.
  - Fixed by adding explicit preview boundary messaging.
- Demo preview validation suite initially used the wrong app import form.
  - Fixed by switching to named import from `src/app.ts`.

## Non-Blocking

- Payment remains mock-backed by design.
- Notifications remain log-only by design.
- Some buyer-side subpages still rely mainly on the global preview strip rather than fully custom demo copy.

## External-Only

- Live payment provider activation
- Live invoice / accounting delivery
- Live shipping / carrier execution
- Live payout execution
- Live KYC provider activation

## Git / Push

- No `git remote` is configured, so this pass can only be committed locally.
