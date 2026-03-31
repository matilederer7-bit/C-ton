# Master Product Deep Map and Hardening Issues

Last updated: 2026-03-31

## Fixed In This Pass

1. Admin system status was thinner than the rest of the admin surface.
Severity: `MUST-HARDEN-INTERNAL`
What was weak:
- Admin UI mentioned `/health` and `/health/integrations`, but did not expose a first-class operational status surface.
Fix:
- Added `/api/admin/system-status` and connected rendering in the admin UI.
Revalidated:
- [tests/master_product_depth_validation.ts](C:/Users/Lenovo/Documents/C-ton/tests/master_product_depth_validation.ts)

2. Seller delivery semantics were too permissive.
Severity: `MUST-HARDEN-INTERNAL`
What was weak:
- `shipped` / `delivered` could be saved without tracking number.
- `issue` could be saved without any explanatory note.
Fix:
- Hardened delivery rules in [src/frontend_runtime.ts](C:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts) and clarified the UI in [frontend/app.js](C:/Users/Lenovo/Documents/C-ton/frontend/app.js).
Revalidated:
- [tests/master_product_depth_validation.ts](C:/Users/Lenovo/Documents/C-ton/tests/master_product_depth_validation.ts)

3. Affiliate payout approval semantics were too soft.
Severity: `MUST-HARDEN-INTERNAL`
What was weak:
- Admin could approve/push payout state without strong gating around verification, payout profile, and pending commission.
Fix:
- Added semantic guards requiring verified affiliate, payout profile, and pending commission before `approved` / `paid`.
Revalidated:
- [tests/master_product_depth_validation.ts](C:/Users/Lenovo/Documents/C-ton/tests/master_product_depth_validation.ts)

## Non-Blocking

1. Payment remains mock-backed.
Severity: `NON_BLOCKING`

2. Notifications remain log-only.
Severity: `NON_BLOCKING`

## External-Only

1. Live provider/payment/invoice/shipping/payout/KYC/support rails.
Severity: `EXTERNAL_ONLY`
Reason:
- These cannot be proven fully without external activation.
