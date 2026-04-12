# Operational Runbook

## Quick Health Check

PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/health | Select-Object -ExpandProperty Content
```

Expected:

```json
{"ok":true}
```

## Stuck Outbox Check

This is the real runtime-safe query for the current schema. It catches both:
- old `processing` rows with `processing_started_at IS NULL`
- genuinely stale `processing` rows older than 30 seconds

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, aggregate_id, status, attempt_count, processing_started_at, updated_at from siton.outbox_events where status='processing' and (processing_started_at is null or processing_started_at < now() - interval '30 seconds') order by updated_at asc" "[]"
```

Expected in a healthy state:
- empty result

## DLQ Check

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, aggregate_id, attempt_count, last_error, created_at from siton.outbox_dlq order by created_at desc limit 20" "[]"
```

Use this to answer:
- is DLQ growing right now
- what exact error is repeating
- is the failure old test residue or a fresh release issue

## Retry Pressure Check

```powershell
node scripts/run_pg_query.cjs "select event_type, status, count(*)::int as cnt, max(attempt_count)::int as max_attempt from siton.outbox_events group by event_type, status order by event_type, status" "[]"
```

Watch for:
- repeated retry growth without convergence to `sent`
- many events with high `attempt_count` at the same time

## Duplicate Event Investigation

Replace `<DEAL_ID>` with the relevant deal.

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, status, attempt_count, last_error, created_at from siton.outbox_events where aggregate_id = $1 order by created_at asc" "[\"<DEAL_ID>\"]"
```

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, attempt_count, last_error, created_at from siton.outbox_dlq where aggregate_id = $1 order by created_at asc" "[\"<DEAL_ID>\"]"
```

```powershell
node scripts/run_pg_query.cjs "select audit_id, entity_type, entity_id, state_type, from_state, to_state, action_name, request_id, idempotency_key, created_at from siton.audit_log where deal_id = $1 order by created_at asc" "[\"<DEAL_ID>\"]"
```

```powershell
node scripts/run_pg_query.cjs "select attempt_id, participant_id, attempt_type, result_class, correlation_id, created_at from siton.payment_attempts where deal_id = $1 order by created_at asc" "[\"<DEAL_ID>\"]"
```

## Charging Failure Check

```powershell
node scripts/run_pg_query.cjs "select participant_id, buyer_state, money_state from siton.participants where buyer_state='ChargeFailedCompletion' and money_state='ChargeFailedRecovery' order by created_at asc" "[]"
```

```powershell
node scripts/run_pg_query.cjs "select attempt_id, participant_id, deal_id, result_class, correlation_id, created_at from siton.payment_attempts where attempt_type='charge_start' order by created_at desc limit 20" "[]"
```

```powershell
node scripts/run_pg_query.cjs "select event_uuid, aggregate_id, status, attempt_count, available_at from siton.outbox_events where event_type='recovery_deal' order by created_at desc limit 20" "[]"
```

## Recovery Window Check

Replace `<DEAL_ID>` with the relevant deal.

```powershell
node scripts/run_pg_query.cjs "select deal_id, state, completion_window_until from siton.deals where deal_id = $1" "[\"<DEAL_ID>\"]"
```

```powershell
node scripts/run_pg_query.cjs "select event_uuid, event_type, status, available_at from siton.outbox_events where aggregate_id = $1 and event_type in ('recovery_deal','finalize_deal') order by created_at asc" "[\"<DEAL_ID>\"]"
```

## Deal Sanity Inspection

Replace `<DEAL_ID>` with the relevant deal.

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/debug/deals/<DEAL_ID> -Headers @{ 'x-debug-access-key' = '<DEBUG_SURFACES_ACCESS_KEY>' } | Select-Object -ExpandProperty Content
```

## Worker Restart

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restart_server_tsnode_clean.ps1
```

Expected:
- old port `3000` process stops
- app starts again
- `/health` returns `{"ok":true}`

## Safe Rollback

1. Stop the app/worker process.
2. Redeploy the previous known-good runtime.
3. Restore DB only from a controlled backup path if DB rollback is truly required.
4. Re-run:
   - `/health`
   - stuck outbox check
   - DLQ check
   - one deal sanity inspection

## RC Minimum Sanity

1. `GET /health` returns `{"ok":true}`.
2. Stuck outbox query returns empty.
3. DLQ has no fresh unexpected entries after RC start.
4. One known deal inspected via `/debug/deals/:id` looks internally consistent when explicit debug access is enabled and the request includes `x-debug-access-key`.
