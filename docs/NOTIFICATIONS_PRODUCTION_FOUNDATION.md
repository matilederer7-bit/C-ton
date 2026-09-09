# Notifications Production Foundation

Status: foundation extended for the MVP completion pass. Demo-ready. Sandbox-ready depends on a configured external provider. Live not ready by design.

## Provider Abstraction

`src/notification_dispatch.ts` defines `NotificationProvider`:

- `providerCode` — currently `log`.
- `mode` — `dev` | `real` | `disabled` | `log-only`.
- `send(notification)` returning `success` | `temporary_fail` | `permanent_fail` | `skipped`.

`buildNotificationProvider` returns the `LogNotificationProvider` for any provider that is not the canonical demo `log`. A real provider activation is a separate provider gate (credentials, sender identity, sandbox testing).

## Event Types

```
buyer_joined_authorized
buyer_deal_target_reached
buyer_deal_completed
buyer_deal_failed
buyer_recovery_required
buyer_payment_recovered
seller_deal_published
seller_target_reached
seller_deal_completed
seller_deal_failed
seller_excel_ready
seller_kyc_approved
seller_kyc_rejected
seller_payout_frozen
seller_payout_unfrozen
admin_security_alert
```

Each event has a Hebrew template and is constrained to compatible channels (`sms`, `email`, `whatsapp_link`, `internal`). The `notification_events` CHECK constraint is widened idempotently when the schema predates this code.

## Copy Contract

- No `חויבת` / "you were charged" language before the actual completed deal.
- Recovery copy says the payment did not go through and asks for an updated method, not a charge.
- Failed deals say no charge was performed and any held credit will be released by the issuing card provider.
- KYC rejection includes the rejection reason and does not promise appeal timelines.

## Idempotency

`enqueueNotification` enforces a unique `idempotency_key` on `siton.notification_events`. The default key is `event_type:recipient_type:recipient_ref:deal_id:participant_id:seller_id:channel`. Re-enqueueing the same logical event returns `duplicate` and never inserts a second row.

## Retry / Failed

`flushPendingNotifications` keeps notifications in `pending` for `temporary_fail` (re-scheduled `now() + 1 minute`) and moves them to `failed` for `permanent_fail`. Provider exceptions land back in `pending` with a new schedule. There is a per-attempt audit trail in `siton.notification_attempts`.

## Recovery Tokens

Recovery / tracking links sent via SMS or email must use the tokenized participant tracking token (`?t=<token>` or `Authorization: Bearer <token>`). Bare `participant_id` links are demo-only and blocked in production-like mode.

## Mission Control

`mission_control.notifications_readiness` reports:

- `provider_code`, `provider_mode`, `external_delivery`
- `demo_ready=true`, `sandbox_ready` (true only if a non-log provider is configured), `live_ready=false`
- `pending`, `failed`, `oldest_pending_age_seconds`
- `failed_critical_notifications` — recovery / completion / payout / KYC / admin alerts that failed
- `idempotency_enforced=true`
- `retry_to_failed_supported=true`
- `secure_token_in_recovery_links=true`
- `no_premature_charge_language=true`
- `live_blockers` — `notification_provider_live_validation_required`

## Validation

- `npm run test:notifications-readiness`
- `npm run test:notification-rail`
- `npm run test:mission-control`

## Pilot Communications (2026-09-09)

Event wiring, recipient resolution, deterministic idempotency, post-commit policy, the dry-run provider and
the real-adapter contract are specified in `docs/PILOT_COMMUNICATIONS_READINESS.md`. Summary of what
changed on top of this foundation:

- Every pilot event (`buyer_joined_authorized`, `buyer_deal_target_reached`, `buyer_deal_completed`,
  `buyer_deal_failed`, `buyer_recovery_required`, `buyer_payment_recovered`, `buyer_voucher_issued`,
  `buyer_ticket_issued`, `seller_deal_published`, `seller_target_reached`, `seller_deal_completed`,
  `seller_deal_failed`, `seller_customer_inquiry`, `seller_kyc_approved`, `seller_kyc_rejected`,
  `admin_security_alert`) is enqueued INSIDE the transaction that commits its canonical state, under a
  savepoint (`src/notification_events.ts`).
- Legacy aliases `charge_succeeded` and `refund_issued` were removed from the compatibility adapter
  (wrong template / duplicate intent). `seller_excel_ready` is no longer emitted at completion.
- Templates carry `money_mode` (mock money never claims a charge), canonical `/preview/#/…` links
  (tokenized participant tracking token for buyers), brand `C-ton`; KYC rejection reason is optional,
  bounded and sanitized; the internal admin note is never forwarded.
- Provider modes gain `dry-run`; the safety gate validates destination format in dry-run and real modes;
  payload hygiene refuses secret-like values at enqueue.
- Operator inspection: `GET /api/admin/notifications/:notificationId`.
- Validation: `npm run test:notification-pilot`, `npm run rehearsal:communications`.
