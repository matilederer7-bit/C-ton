# Money Incident Runbook

Status: local operations runbook. This does not authorize manual refunds, manual capture, or production money movement.

## Rules

- Do not run manual refund, manual capture, manual void, manual payout, or manual state edit.
- Do not delete audit, webhook, outbox, DLQ, invoice, or payment-attempt rows.
- Do not expose API keys, webhook secrets, card data, OTP values, or tokens in tickets or logs.
- If real provider money is involved later, compare provider IDs to DB state before taking any business action.
- If there is suspected double capture, pause joining/charging for the affected deal if needed and escalate.

## First Snapshot

Collect only non-sensitive identifiers:

- `deal_id`
- `participant_id`
- `buyer_id` if available
- `correlation_id`
- `provider_reference`
- `provider_event_id`
- `outbox event_uuid`
- timestamps

Check admin surfaces:

- `GET /api/admin/system-ops-status`
- `GET /api/admin/outbox-status`
- `GET /api/admin/invoice-status`
- `GET /api/admin/payment-ops-status`
- `GET /api/admin/deals/:id/ops-summary`
- `GET /api/admin/participants/:id/ops`
- `GET /api/admin/mission-control`

All admin calls require the configured admin key or admin session.

## Buyer Claims Double Charge

1. Look up the participant ops view.
2. Compare `payment_attempts`, `webhook_events`, and platform fee money events.
3. Confirm whether there is more than one successful capture/recovery for the same participant.
4. Check webhook duplicate handling by provider event identity.
5. Check whether multiple participant rows exist because the same buyer intentionally joined more than once.
6. If duplicate capture is suspected, stop further charging for the deal and escalate to provider reconciliation.

Expected local invariant:

- duplicate webhook/retry must not create duplicate capture truth for the same participant.

## Seller Says Deal Succeeded But Buyers Missing

1. Open deal ops summary.
2. Check deal state, threshold units, joined units, captured units, and completion window.
3. Check participant states for `DealCompleted`, `Dropped`, `ChargeFailedRecovery`, and `RecoveredCharge`.
4. Check outbox for pending or failed `charge_deal`, `recovery_deal`, or `finalize_deal`.
5. Check seller export only after `Completed`.

Do not mark a buyer eligible manually.

## Buyer Joined But Nothing Happened

1. Check OTP challenge and legal acceptance rows if available.
2. Check participant row and money state.
3. Check authorization ID/provider reference.
4. Check public tracking route for the participant.
5. If no participant exists, verify whether authorization failed before join.

## Webhook Looks Wrong

1. Verify signature policy first.
2. Check `payment_webhook_security_events` for rejected attempts.
3. Check `webhook_events` for duplicate provider/event identity.
4. Check correlation back to participant/deal.
5. Do not replay webhook manually unless using a controlled test environment.

## Outbox Is Stuck

1. Use `/api/admin/outbox-status`.
2. Check `pending`, `processing`, `failed`, `dlq`, oldest ages, and `stuck_candidates`.
3. Confirm worker status from `/api/admin/system-ops-status`.
4. If processing rows are old, rely on reclaim behavior rather than deleting rows.
5. If rows move to DLQ, keep payload/error context and open an operational case.

## Charge Succeeded But Invoice Failed

1. Use `/api/admin/invoice-status`.
2. Check `invoice_documents`, `invoice_document_attempts`, and reconcile backlog.
3. Confirm whether invoice provider is internal/log-only or external configured.
4. Do not change money state because invoice issuance failed.
5. Open accounting/legal follow-up if external invoice provider mismatch appears.

## Provider And DB Disagree

1. Stop and record the mismatch.
2. Compare provider reference, event ID, correlation ID, participant ID, and deal ID.
3. Check whether the provider event arrived late or duplicated.
4. Check whether the DB recorded temporary provider timeout.
5. Escalate to provider reconciliation before any buyer/seller statement.

## Kill Criteria

Escalate immediately and keep the system in sandbox/demo if any of these happen:

- suspected double capture
- capture before deal success
- provider/DB mismatch that cannot be explained
- webhook accepted without valid signature in non-demo mode
- admin/debug surface exposed without a key
- seller export money differs from canonical backend calculation

## What Not To Do

- Do not promise a manual refund.
- Do not ask engineering to edit money rows.
- Do not delete DLQ rows to make readiness green.
- Do not tell the seller C-ton manages fulfillment.
- Do not tell the buyer C-ton supplies the product.
