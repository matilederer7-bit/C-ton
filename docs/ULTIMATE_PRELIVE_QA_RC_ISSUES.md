# Ultimate Pre-Live QA and RC Issues

Last updated: 2026-03-31

## Deprecation Note - 2026-04-18

Routes and semantics for affiliate payout profile, affiliate payout administration, and affiliate internal settlement are deprecated and removed from the live product model.
Any references below remain historical only and are not a valid product path.

## Fixed In This Pass

1. Missing-target admin mutations returned ambiguous success.
Severity: `MUST_FIX_BEFORE_EXTERNAL_ACTIVATION`
Affected paths:
- `POST /api/admin/kyc/:subjectType/:subjectId/decision`
- `POST /api/admin/support/:ticketId`
- `POST /api/admin/affiliate-payouts/:affiliateId`
- `POST /api/affiliate/payout-profile`
What happened:
- Some mutation routes could return `200` with an empty result when the underlying seller / affiliate / support ticket did not exist.
Fix:
- Added explicit `404` handling and affiliate KYC UUID validation in [src/frontend_runtime.ts](C:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts).
Revalidation:
- Covered in [tests/ultimate_prelive_qa_rc_validation.ts](C:/Users/Lenovo/Documents/C-ton/tests/ultimate_prelive_qa_rc_validation.ts) and full `npm test`.

## Non-Blocking

1. Payment execution remains mock-backed.
Severity: `NON_BLOCKING`
Reason:
- This pass intentionally did not activate a live payment rail.

2. Notifications remain log-only.
Severity: `NON_BLOCKING`
Reason:
- Internal semantics are proven, but no external delivery transport was activated.

## External-Only

1. Live provider/process-manager restart proof outside in-process harness.
Severity: `EXTERNAL_ONLY`
Reason:
- True external orchestration proof belongs to the first staged external-activation environment, not this internal repo-only pass.

2. Live external rail behavior.
Severity: `EXTERNAL_ONLY`
Reason:
- Invoice transport, shipping, payouts, KYC, and support tooling cannot be fully proven until external activation begins.
