# RC Execution Plan

## Before RC

1. Confirm app health:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/health | Select-Object -ExpandProperty Content
```

2. Capture outbox baseline:

```powershell
node scripts/run_pg_query.cjs "select status, count(*)::int as cnt from siton.outbox_events group by status order by status" "[]"
```

3. Capture stuck-outbox baseline:

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, aggregate_id, status, attempt_count, processing_started_at, updated_at from siton.outbox_events where status='processing' and (processing_started_at is null or processing_started_at < now() - interval '30 seconds') order by updated_at asc" "[]"
```

4. Capture DLQ baseline:

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, aggregate_id, attempt_count, last_error, created_at from siton.outbox_dlq order by created_at desc limit 20" "[]"
```

5. Confirm one known deal is inspectable:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/debug/deals/87c3613b-dfb2-4a8b-aac7-284a35baf10e | Select-Object -ExpandProperty StatusCode
```

6. Confirm execution assumptions:
- no new migration is part of this RC package
- no feature-flag dependency is part of this RC package
- no dedicated kill switch exists; operational stop of app/worker is the fallback

## During RC

1. Deploy the RC runtime.
2. Restart the app/worker process:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart_server_tsnode_clean.ps1
```

3. Re-check health immediately:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/health | Select-Object -ExpandProperty Content
```

4. Re-run the stuck-outbox check.
5. Re-run the DLQ snapshot query and compare against the baseline.
6. Inspect one known deal through `/debug/deals/:id`.

## Immediately After RC

Run these checks at:
- `T+0`
- `T+5m`
- `T+15m`
- `T+30m`

Checks:
- `/health` still returns `{"ok":true}`
- stuck-outbox query stays empty
- no fresh unexpected `outbox_dlq` entries appear
- retry pressure stays bounded
- one known deal remains internally consistent in `/debug/deals/:id`

## Rollback Conditions

Rollback is required if any of the following happens and does not clear immediately under normal recovery:

- `/health` fails or stays unavailable after RC restart
- stuck-outbox query returns rows and they do not clear after the normal reclaim window
- fresh unexpected DLQ entries appear and continue growing
- retry pressure grows without convergence to `sent`
- core app behavior is visibly broken on a live sanity inspection

## Responsibility Map

- Release operator:
  deploy RC, run restart, capture baseline and compare post-RC checks
- DB operator:
  run SQL snapshots, verify outbox/DLQ/retry posture, assist if rollback touches DB
- App/worker runtime:
  process outbox, reclaim stuck `processing`, expose `/health`
- On-call owner:
  decide hold/continue/rollback if a rollback condition appears

## Initial Monitoring Window

- Minimum active watch window: `30 minutes`
- Suggested cadence:
  `T+0`, `T+5m`, `T+15m`, `T+30m`

If all four checkpoints are clean, the RC is considered operationally stable for this execution pass.

## Post-Release RC Sanity Checklist

1. `/health` is green.
2. Stuck-outbox query is empty.
3. No new unexpected DLQ entry appeared since the RC baseline.
4. Retry pressure is bounded.
5. One known deal opens correctly in `/debug/deals/:id`.
