# Admin / Support Observability

Quick reference for all operational endpoints available to admin and support.
Covers: what each endpoint returns, what to check when there's a problem,
and how to confirm each queue is clean.

---

## Endpoint Index

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/outbox-status` | GET | Outbox queue health: pending/failed counts, stuck candidates, worker running |
| `/api/admin/notifications-status` | GET | Notifications queue health: counts by status and channel |
| `/api/admin/invoice-status` | GET | Invoice document queue health: counts by status and document type |
| `/api/admin/system-ops-status` | GET | Unified snapshot: all three queues in one call |
| `/api/admin/participants/:id/ops` | GET | Cross-system read surface for one participant |
| `/api/admin/deals/:id/profile` | GET | Full deal support profile: participants, outbox, payments, audit, delivery |
| `/api/admin/users/:buyerId/profile` | GET | Buyer join history across all deals |
| `/api/admin/system-status` | GET | Broader system health: integrations, readiness, deployment mode |
| `/api/admin/overview` | GET | Admin dashboard: deal listings, KYC queue, support tickets, settlements |

All endpoints require the `x-admin-key` header when `ADMIN_API_KEY` env var is set.
In demo/dev mode with no key set, all admin endpoints are open.

---

## Endpoint Details

### `GET /api/admin/invoice-status`

Returns per-status counts and oldest-age metrics for `siton.invoice_documents`.

```json
{
  "ok": true,
  "invoice_documents": {
    "pending": 0,
    "processing": 0,
    "issued": 147,
    "failed": 2,
    "skipped": 0,
    "retryable": 0,
    "unique_document_keys": 149,
    "oldest_pending_age_s": null,
    "oldest_failed_age_s": 3602.1
  },
  "by_type": [
    { "document_type": "charge_receipt", "pending": 0, "issued": 100, "failed": 2 },
    { "document_type": "refund_receipt", "pending": 0, "issued": 47, "failed": 0 }
  ]
}
```

| Field | What to watch |
|-------|--------------|
| `pending` | Should drain to 0; non-zero means documents queued but not yet issued |
| `failed` | Should be 0; non-zero means permanent issuance failure — check `last_error` in DB |
| `oldest_pending_age_s` | Should be low (< 60s); high value means flush worker is not running |
| `oldest_failed_age_s` | Reference: how long ago the last permanent failure occurred |

---

### `GET /api/admin/system-ops-status`

Single call covering outbox + notifications + invoice_documents.
Use this as the first check when something looks wrong.

```json
{
  "ok": true,
  "worker_running": true,
  "outbox": {
    "pending": 0,
    "processing": 0,
    "failed": 0,
    "dlq": 0,
    "oldest_pending_age_s": null,
    "stuck_candidates": 0
  },
  "notifications": {
    "pending": 0,
    "failed": 0,
    "oldest_pending_age_s": null
  },
  "invoice_documents": {
    "pending": 0,
    "failed": 0,
    "oldest_pending_age_s": null
  }
}
```

**Healthy system**: all `pending`, `failed`, `dlq`, `stuck_candidates` are 0, `worker_running` is true.

---

### `GET /api/admin/participants/:id/ops`

Cross-system read for a single participant. Use this to diagnose why a participant
did not receive a notification or invoice document.

```json
{
  "ok": true,
  "participant": {
    "participant_id": "...",
    "deal_id": "...",
    "buyer_id": "+972501234567",
    "qty": 2,
    "buyer_state": "DealCompleted",
    "money_state": "ChargedSuccess",
    "deal_title": "Test Deal",
    "deal_state": "Completed",
    "created_at": "..."
  },
  "notifications": [
    {
      "event_key": "charge_succeeded:...:sms",
      "notification_event_type": "charge_succeeded",
      "channel": "sms",
      "status": "sent",
      "attempt_count": 1,
      "last_error": null,
      "sent_at": "...",
      "provider_message_id": "log-xxx"
    }
  ],
  "invoice_documents": [
    {
      "document_key": "charge_receipt:...",
      "document_type": "charge_receipt",
      "status": "issued",
      "attempt_count": 1,
      "provider_document_id": "log-doc-xxx",
      "last_error": null,
      "issued_at": "...",
      "gross_amount": "200.00",
      "money_state_at_issue": "ChargedSuccess"
    }
  ],
  "outbox_events_for_deal": [
    {
      "event_type": "finalize_deal",
      "aggregate_type": "deal",
      "status": "sent",
      "attempt_count": 1,
      "last_error": null
    }
  ]
}
```

Returns 404 if participant_id not found.

---

### `GET /api/admin/outbox-status`

Full outbox queue metrics with worker status.
See `docs/OUTBOX_WORKER_OPERATIONS.md` for field meanings.

---

### `GET /api/admin/notifications-status`

Full notifications queue metrics by status and channel. Includes `provider` block:
```json
"provider": { "code": "log-only", "mode": "log-only", "external_delivery": false }
```
`external_delivery: true` means real SMS is active (Twilio credentials set).
See `docs/NOTIFICATIONS_OPERATIONS.md` for field meanings.

---

## What to Check When There's a Problem

### Participant did not receive a notification

1. `GET /api/admin/participants/:id/ops` — check `notifications` array
2. If notification is `failed`: `last_error` tells you why
3. If notification is `pending` with old `created_at`: flush worker may be down — check `worker_running` in `system-ops-status`
4. If no notification row at all: the enqueue call was skipped (check if participant state was correct at the time of the business event)

### Participant did not receive an invoice document

1. `GET /api/admin/participants/:id/ops` — check `invoice_documents` array
2. If document is `failed`: `last_error` says why; `attempt_count` shows how many times it was tried
3. If document is `pending` and old: flush worker down — check `system-ops-status`
4. If no document row at all: the participant may not have been eligible (check `buyer_state` — must be `DealCompleted` for charge_receipt; `money_state` must be `Refunded` for refund_receipt)

### Deal finalization seems stuck

1. `GET /api/admin/deals/:id/profile` — check `outbox` array for `finalize_deal` event
2. If stuck in `processing`: reclaim logic will reset it within 60s; or reset manually via DB
3. If `failed`: check `last_error`; deal may have failed a guard condition

### All queues have growing pending counts

1. `GET /api/admin/system-ops-status` — confirm `worker_running` is true
2. If `worker_running` is false or null: worker is not running; restart the application
3. If `worker_running` is true and counts still grow: check application logs for flush errors

---

## How to Confirm Each Queue Is Clean

| Queue | Check |
|-------|-------|
| Outbox | `outbox-status`: `pending=0`, `failed=0`, `dlq=0`, `stuck_candidates=0` |
| Notifications | `notifications-status`: `pending=0`, `failed=0` |
| Invoice Documents | `invoice-status`: `pending=0`, `failed=0` |
| All at once | `system-ops-status`: all three queues show `pending=0`, `failed=0` |

---

## What Is Not Yet Covered

| Gap | Status |
|-----|--------|
| Invoice document provider mode | **Done** — `invoice-status` returns `provider.{code,mode,external_issuance}` |
| Notification provider mode | **Done** — `notifications-status` returns `provider.{code,mode,external_delivery}` |
| Stuck invoice_documents reclaim | **Done** — `reclaimStuckInvoiceDocuments` wired into `workerLoop` |
| Per-deal cross-system summary (deal_id → notifications + invoices) | Not built; use `deals/:id/profile` + manual queries |
| Support ticket creation via API | Exists at `POST /api/admin/support` |
