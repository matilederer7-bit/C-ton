# Notification Operations

Operational reference for the `siton.notifications` delivery layer.
Covers: status meanings, what healthy looks like, how to identify failures,
and the admin endpoint for monitoring.

---

## Status Meanings

| Status | Meaning |
|--------|---------|
| `pending` | Queued, not yet attempted or scheduled for retry |
| `processing` | Claimed by the flush worker right now (transient — milliseconds) |
| `sent` | Delivered successfully; `provider_message_id` and `sent_at` are set |
| `failed` | Permanently failed after exhausting all retry attempts (`attempt_count >= max_attempts`); `last_error` is set |
| `skipped` | No template for this event type + channel, or email provider not configured; will not be retried |

A row stuck in `processing` for more than a few seconds indicates a crashed worker.
The outbox reclaim job does **not** reclaim stuck notifications — use the query below
to identify and reset them manually if needed.

---

## Admin Endpoint

```
GET /api/admin/notifications-status
Authorization: x-admin-key: <ADMIN_API_KEY>
```

Example response:

```json
{
  "ok": true,
  "notifications": {
    "pending": 3,
    "processing": 0,
    "sent": 147,
    "failed": 2,
    "skipped": 0,
    "retryable": 1,
    "unique_event_keys": 152,
    "oldest_pending_age_s": 12.4,
    "oldest_failed_age_s": 3601.0
  },
  "by_channel": [
    { "channel": "sms", "pending": 3, "sent": 147, "failed": 2 }
  ]
}
```

Fields:

| Field | What to watch for |
|-------|-------------------|
| `pending` | Should drain to 0 within seconds on a running system |
| `processing` | Should be 0 outside of an active flush cycle |
| `failed` | Should be 0; any non-zero value means delivery permanently failed — inspect `last_error` |
| `retryable` | `pending` rows that have been attempted at least once — in backoff |
| `oldest_pending_age_s` | Should be low (< 60s); high values mean the flush worker is not running |
| `oldest_failed_age_s` | Reference for how long ago the last permanent failure occurred |

---

## What a Healthy System Looks Like

```
pending:    0      (or draining)
processing: 0
sent:       > 0    (deliveries accumulating)
failed:     0
skipped:    0
oldest_pending_age_s: null or < 30
```

If `oldest_pending_age_s` is growing and `processing` stays at 0, the flush worker
is not running. Check that the application started and `DISABLE_OUTBOX_WORKER` is
not set to `1`.

---

## Identifying Failures

### Find all permanently failed notifications

```sql
SELECT notification_id, event_key, notification_event_type,
       recipient, attempt_count, last_error, updated_at
FROM siton.notifications
WHERE status = 'failed'
ORDER BY updated_at DESC;
```

### Find notifications stuck in processing (> 5 minutes)

```sql
SELECT notification_id, event_key, updated_at,
       EXTRACT(EPOCH FROM (now() - updated_at)) AS stuck_seconds
FROM siton.notifications
WHERE status = 'processing'
  AND updated_at < now() - INTERVAL '5 minutes'
ORDER BY updated_at ASC;
```

### Reset stuck processing rows manually

```sql
UPDATE siton.notifications
SET status = 'pending', available_at = now(), updated_at = now()
WHERE status = 'processing'
  AND updated_at < now() - INTERVAL '5 minutes';
```

### Find pending rows overdue for dispatch

```sql
SELECT notification_id, event_key, attempt_count, available_at,
       EXTRACT(EPOCH FROM (now() - available_at)) AS overdue_seconds
FROM siton.notifications
WHERE status = 'pending' AND available_at <= now()
ORDER BY available_at ASC;
```

---

## Retry Backoff Schedule

| Attempt | Delay before next try |
|---------|----------------------|
| 1 (first failure) | 30 seconds |
| 2 | 90 seconds |
| 3+ | 270 seconds |

Default `max_attempts` is 3. After the third failure the row becomes `failed` permanently.

---

## Provider Modes

The system logs the active SMS provider on startup:

| Log message | Meaning |
|-------------|---------|
| `[notification] Twilio SMS provider active` | Real SMS delivery — requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| *(no message)* | Log-only mode — messages are logged to console, `provider_message_id` starts with `log-` |

To activate Twilio, set all three environment variables and restart. The mode is
reflected in `provider_message_id` on sent rows (`log-xxx` vs. a real Twilio SID).

---

## Event Key Format

`{notification_event_type}:{participant_id_or_deal_id}:{channel}`

Example: `join_authorized:a1b2c3d4-...:sms`

The UNIQUE constraint on `event_key` prevents double-dispatch for the same business
event and channel. Calling `enqueueNotification` multiple times with the same key is
safe — it returns `"duplicate"` without inserting.
