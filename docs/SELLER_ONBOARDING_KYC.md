# Seller Onboarding And KYC

Status: foundation implemented. Demo can pass the seller onboarding gate. Live pilot requires the live-money/live-security blockers in adjacent gates.

## Statuses

Two independent status fields drive the seller lifecycle:

- `verification_status` (`pending` | `approved` | `rejected`) — KYC decision.
- `seller_status` (`Active` | `UnderReview` | `Restricted` | `Suspended` | `Banned`) — enforcement status applied by ops.

A seller may be `verification_status='approved'` and still be enforcement-restricted (for example after a buyer complaint). The two fields are separate by design.

## Settlement Status

`settlement_status` lives on `siton.seller_accounts` (`active` | `review` | `hold`). It gates payout eligibility from the operations side. The current MVP defaults to `active` for demo sellers; live pilot requires the seller to be approved and the settlement to be active.

## Lifecycle

1. Seller registers and lands in `verification_status='pending'`.
2. Admin reviews via `/api/admin/sellers/risk` and `/api/admin/users/:buyerId/profile` style surfaces.
3. Admin issues a KYC decision via `POST /api/admin/kyc/seller/:sellerId/decision` with `decision=approve|reject` and `admin_note`.
4. Admin can change enforcement status via `POST /api/admin/sellers/:sellerId/status` with `reason` (required).
5. All changes are recorded as `siton.seller_security_events` rows for audit.

## Publish Blocking

- Demo / local / `demo-preview`: publish requires only the existing seller profile readiness (business_name + a contact channel). KYC is not enforced so existing demo flows continue to work.
- Production-like (`NODE_ENV=production` or `RENDER=true`): publish additionally requires `verification_status='approved'`. Unapproved publish attempts return `409 seller_kyc_not_approved`.

## Buyer Protection

- A `Suspended` or `Banned` seller cannot create new drafts or publish via `ensureSellerActionAllowed`.
- `Restricted` blocks `publish` but allows existing operations.
- KYC rejection does not retroactively cancel running deals; ops must use bounded admin actions if they need to halt buyer impact.

## Mission Control

`mission_control.seller_onboarding_readiness` reports:

- `active_sellers`, `pending_review`, `rejected`, `under_review`, `suspended`, `banned`
- `deals_blocked_by_kyc` — drafts whose seller is not approved
- `verdict` — `ready` / `warning` / `blocked`
- `notes` — clarifies that `verification_status` and `seller_status` are independent fields
- `publish_blocked_for_unverified=true`

## Notifications

KYC decisions produce notifications:

- `seller_kyc_approved` → template `seller_kyc_approved_he`
- `seller_kyc_rejected` → template `seller_kyc_rejected_he` (includes the rejection reason)

## Open Items Before Live Pilot

- KYC document storage and retention policy.
- Provider for identity verification when beyond manual review.
- Operator runbook for rejecting / unsuspending sellers.
- Re-review / appeal flow for rejected sellers.
