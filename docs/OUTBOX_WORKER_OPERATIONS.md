# Outbox Worker — Operational Reference

Short reference for post-restart checks and day-to-day ops.
For implementation details see `src/outbox_worker_helpers.ts` and `src/app.ts`.

---

## Key Concepts

### `processing` status
An event moves from `pending` → `processing` the moment a worker claims it.
While `processing`, `processing_started_at` is set to the claim timestamp.
A healthy event exits `processing` quickly (typically < 30 s).
If an event stays `processing` past the stuck timeout it is considered stuck.

### Stuck timeout (`WORKER_STUCK_TIMEOUT_MS`)
Default: **60 000 ms** (60 s). Set via env var.
Any event with `processing_started_at < now() - timeout` (or `processing_started_at IS NULL`)
is treated as stuck — likely from a crash or unclean shutdown.

### Reclaim interval (`RECLAIM_EVERY_N_POLLS`)
The worker calls `reclaimStuckProcessing` once every **10 poll cycles**.
With the default poll interval of 500 ms that is roughly every 5 s.
Reclaim resets stuck events to `pending` and writes
`last_error = 'worker_reclaim_after_restart'` (if the event had no prior error).

### DLQ (`outbox_dlq`)
An event lands in the DLQ when either:
- `attempt_count >= OUTBOX_MAX_ATTEMPTS` (default 3) after a normal failure, or
- a `PermanentFailError` is thrown by the event handler.

DLQ events are not retried automatically. They require manual investigation.

---

## `/api/admin/outbox-status` — Health Endpoint

```
GET /api/admin/outbox-status
x-admin-key: <ADMIN_SECRET_KEY>
```

Response shape:

```json
{
  "ok": true,
  "outbox": {
    "pending": 0,
    "processing": 0,
    "sent": 1500,
    "failed": 0,
    "dlq": 0,
    "oldest_pending_age_s": null,
    "oldest_processing_age_s": null,
    "stuck_candidates": 0,
    "stuck_timeout_ms": 60000
  },
  "worker": {
    "running": true
  }
}
```

Field meanings:

| Field | Meaning |
|-------|---------|
| `pending` | Events queued, not yet claimed |
| `processing` | Events actively claimed by a worker |
| `sent` | Events successfully processed (accumulates over time) |
| `failed` | Events in transient retry state (rare; usually 0 at rest) |
| `dlq` | Events that exhausted retries or hit a permanent error |
| `oldest_pending_age_s` | Age in seconds of the oldest pending event — should be near-zero under normal load |
| `oldest_processing_age_s` | Age of the oldest processing event — if large, worker may be stuck |
| `stuck_candidates` | Count of processing events older than `stuck_timeout_ms` — should be 0 at rest |
| `stuck_timeout_ms` | The timeout used for the stuck_candidates count |
| `worker.running` | Whether the in-process worker loop is active |

---

## What a Clean System Looks Like

```
pending:             0  (or small positive if events are arriving faster than they drain)
processing:          0  (or 1–2 if the worker is mid-cycle)
stuck_candidates:    0
dlq:                 0  (or a stable number if known historical failures exist)
worker.running:      true
oldest_pending_age_s: < 5 s
oldest_processing_age_s: null or < 30 s
```

---

## Post-Restart Checklist

1. **Call `/api/admin/outbox-status`** and note `stuck_candidates`.
   If > 0, wait one reclaim cycle (~5 s) and call again — they should drop to 0.

2. **Check `processing`** count. If non-zero after 60 s of uptime, the worker may not have
   started. Verify `DISABLE_OUTBOX_WORKER` is not set in your env.

3. **Check `dlq`** count. If it increased since last restart, inspect `outbox_dlq` for
   the `last_error` column to understand the failure class.

4. **Check `oldest_pending_age_s`**. A large value (> 60 s) with `worker.running=true`
   may mean the worker is processing other events slowly. Investigate the handler.

5. **Check `worker.running`**. If `false`, worker did not start — check startup logs.
   If `null`, `getWorkerRunning` was not wired into the deps (config issue).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_STUCK_TIMEOUT_MS` | 60000 | Timeout before a processing event is reclaimed |
| `OUTBOX_POLL_MS` | 500 | Poll interval for the worker loop |
| `OUTBOX_MAX_ATTEMPTS` | 3 | Max retries before DLQ |
| `DISABLE_OUTBOX_WORKER` | unset | Set to `1` to suppress the worker (tests only) |
