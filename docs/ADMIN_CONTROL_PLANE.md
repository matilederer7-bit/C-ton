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
- `trigger_reconcile`: internal dry-run/read-only reconcile action. It does not call a live provider and does not mutate deal state.
- `freeze_payouts`: creates an internal payout-freeze flag and blocks payout eligibility/new payout creation for the target.
- `unfreeze_payouts`: removes or expires the internal payout freeze with full audit.
- `content_takedown_request`: hides content with a placeholder and audit trail; it does not physically delete content.
- `pause_joining_emergency`: creates an expiring internal pause that blocks new joins with `423` without changing `deal.state`.
- `pause_charging_emergency`: creates an expiring internal pause that blocks charging/worker execution without manual state edits or money movement.

These actions are internal safe actions only. They do not perform live provider calls, manual captures, manual refunds, manual state edits or external money movement.

## Forbidden Actions

Blocked with `403 admin_action_forbidden`:

- `manual_capture`
- `manual_refund`
- `admin_refund`
- `merchant_refund`
- `seller_refund`
- `support_refund`
- `partial_refund`
- `manual_credit`
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

Refund policy alignment: Admin Actions cannot create commercial refunds. The only allowed refund path is the automatic system-mandated failed-deal outbox path described in [`REFUND_POLICY.md`](REFUND_POLICY.md).

## Second Approval

Required for:

- `freeze_payouts`
- `unfreeze_payouts`
- `pause_charging_emergency`

Self approval is blocked when `x-admin-user` identifies the same requester and approver.

Admin action identity is now session-based for sensitive actions. `ADMIN_API_KEY` remains bootstrap/read-only fallback and is not enough to create, approve or execute sensitive actions.

Security Identity Tracking Gate classification: demo pass, live blocked until named admins are provisioned, MFA is enrolled and shared-key operational fallback is retired or tightly constrained.

## Endpoints

- `GET /api/admin/actions`
- `GET /api/admin/actions/:adminActionId`
- `POST /api/admin/actions`
- `POST /api/admin/actions/:adminActionId/approve`
- `POST /api/admin/actions/:adminActionId/reject`
- `POST /api/admin/actions/:adminActionId/execute`

All endpoints require admin auth.

Action creation/approval/execution requires session identity, RBAC permission, and recent MFA for high-trust actions.

## Tests

```bash
npm run test:admin-control-plane
npm run test:full-e2e-gate
npm run test:mission-control
npx tsc --noEmit
npx tsc -p tsconfig.test.json
```

## Open

- Full worker execution for reconcile/freeze/emergency pause.
- Live admin provisioning/enrollment runbook.
- Full worker log correlation.
- Admin action rate-limit integration beyond existing app rate limit.
