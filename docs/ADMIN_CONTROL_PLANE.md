# Admin Control Plane

Admin Control Plane Phase 2 adds two foundations on top of Admin Mission Control:

- Cross-system `request_id` / `correlation_id`.
- Admin Safe Actions.

## Admin Safe Actions

Admin Safe Actions are controlled records in `siton.admin_actions`. They do not allow manual state edits, manual money edits, evidence deletion or provider-payload exposure.

Every action has:

- `action_type`
- `status`
- `target_type`
- `target_id`
- `reason`
- `correlation_id`
- `request_id`
- `idempotency_key`
- optional second approval fields
- result fields

## Supported Actions

Implemented with bounded, idempotent execution:

- `requeue_outbox_event`: only eligible pending/processing/failed outbox events. Does not delete DLQ and does not reset history.
- `retry_notification`: only failed notifications. Does not duplicate sent notifications.
- `retry_invoice_failed`: only failed invoice documents without provider document reference.
- `open_support_case`: opens or reuses an operational support case.

Foundation-only / NotImplemented when executed:

- `trigger_reconcile`
- `freeze_payouts`
- `unfreeze_payouts`
- `content_takedown_request`
- `pause_joining_emergency`
- `pause_charging_emergency`

These are recorded safely but do not pretend to perform unsafe work without a clear worker/contract.

## Forbidden Actions

Blocked with `403 admin_action_forbidden`:

- `manual_capture`
- `manual_refund`
- `manual_void`
- `manual_state_edit`
- `manual_money_state_edit`
- `manual_buyer_state_edit`
- `manual_db_patch`
- `delete_webhook`
- `delete_outbox`
- `delete_audit`
- `clear_dlq_without_repair`
- `mark_payment_success_manual`
- `mark_deal_completed_manual`
- `edit_amount`
- `edit_platform_fee`
- `edit_seller_net`
- `edit_product_eligibility`

## Second Approval

Required for:

- `freeze_payouts`
- `unfreeze_payouts`
- `pause_charging_emergency`

Self approval is blocked when `x-admin-user` identifies the same requester and approver.

Current limitation: admin identity is still header-based, so enforcement is `partial` until a real admin account/MFA layer exists.

Security Hardening Gate classification: this is a P1 live-pilot limitation, not a demo blocker. `ADMIN_API_KEY` still fails closed in production-like environments, and forbidden money/state/evidence actions remain blocked.

## Endpoints

- `GET /api/admin/actions`
- `GET /api/admin/actions/:adminActionId`
- `POST /api/admin/actions`
- `POST /api/admin/actions/:adminActionId/approve`
- `POST /api/admin/actions/:adminActionId/reject`
- `POST /api/admin/actions/:adminActionId/execute`

All endpoints require admin auth.

## Tests

```bash
npm run test:admin-control-plane
npm run test:mission-control
npx tsc --noEmit
npx tsc -p tsconfig.test.json
```

## Open

- Full worker execution for reconcile/freeze/emergency pause.
- Real admin identity and MFA.
- Full worker log correlation.
- Admin action rate-limit integration beyond existing app rate limit.
