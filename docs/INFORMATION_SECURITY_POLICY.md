# Information Security Policy

Written as an initial MVP response; legal validation is recommended later.

- Production uses HTTPS only.
- Secrets, passwords and provider keys are never hard-coded; environment variables only.
- RBAC, Role Based Access Control, separates buyer, seller, distributor and admin access.
- Admin access requires MFA, Multi Factor Authentication, for sensitive operations.
- Sensitive actions are audited: publish, state transitions, capture, refund, recovery, payout, content takedown, seller/distributor suspension and emergency stop.
- Rate limits protect OTP, login, payment and support endpoints.
- Sessions have expiry and revocation paths.
- Buyer PII is limited by role and purpose.
- Distributor permissions expose aggregate attribution only and no buyer PII.
- Seller exports exclude payment provider references and expose only fulfillment/accounting fields needed by the seller.
- Logs must not contain secrets, raw payment details or unnecessary PII.
- Backups must be access-controlled and restorable.
- Security incidents are handled through detection, containment, evidence preservation, user/vendor notification assessment and corrective action.
- Suspicious users or sellers may be blocked, suspended or frozen by controlled admin action.
- Emergency stop may pause charging, payouts or publication paths without bypassing the deal constitution.

## Sensitive Endpoint Review

Admin, seller, distributor, buyer tracking, exports, payment and OTP endpoints are treated as sensitive. The MVP guardrails require:

- no unnecessary PII in API responses;
- no buyer PII in distributor APIs;
- no payment token or auth id in frontend unless required for the current operation;
- no provider references in seller exports;
- no unprotected debug surfaces.
