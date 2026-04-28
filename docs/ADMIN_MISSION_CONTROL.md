# Admin Mission Control

Admin Mission Control is Siton's internal operations console. It is an admin-only surface, not a public marketplace or buyer-facing search.

## Endpoint

- `GET /api/admin/mission-control`
- Protected by the existing `x-admin-key` guard.
- Read-only by default.
- Uses existing operational truth tables and does not change deal state, buyer state, money state, payments, invoices, payouts, or settlements.

## Included Areas

- System status: green / yellow / red, stale-data threshold, outbox, DLQ, payment, invoice, notification, payout, and support counters.
- Exception cards: Completion Window ending soon, DLQ not empty, Completed without charged success, payment failures, reconcile backlog, invoice failures, payout exceptions, and PendingTarget near deadline.
- Admin Omnisearch: internal operational lookup by deal, participant, seller, support ticket, invoice document, or payout batch identifiers.
- Exceptional deals: operational deal list with target, charged, pending, not-charged, gross, reason, and profile link.
- Seller Onboarding / KYC: seller readiness and missing profile fields from existing seller accounts.
- Payouts & Settlements Control: status visibility only. No manual transfer is executed from request thread or UI.
- Support Hub: open support tickets from the existing support table.
- Audit & Forensics: recent append-only audit events.

## Explicit Non-Goals

- No buyer-facing marketplace.
- No public catalog.
- No public deal search.
- No affiliate commission or payout.
- No manual capture, refund, void, or payout operation.
- No admin state override.
- No editing critical deal terms.
- No shipping management / OMS.

## Safety

The response includes an `action_policy` object where forbidden operations are explicitly disabled:

- `state_override_enabled: false`
- `manual_capture_enabled: false`
- `manual_refund_enabled: false`
- `manual_void_enabled: false`
- `manual_payout_enabled: false`

Any future sensitive admin mutation must remain API-authorized, require a reason, and write audit before it is exposed in the UI.
