# Release Readiness Checklist

## DB
- schema hardened for `deals`
- critical constraints validated
- `payment_attempts` logical idempotency index present
- backup path known before risky DB work

## Migrations
- production migration order reviewed
- no known blocking drift remains in `deals`
- legacy bootstrap SQL not treated as canonical

## Workers
- worker boot path verified
- restart recovery verified
- reclaim path verified

## Outbox
- claim / sent / retry / DLQ paths verified
- no known stuck `processing` blocker
- runbook stuck-outbox query must include `processing_started_at IS NULL` rows, not only aged timestamps

## Retries
- bounded retry behavior verified
- no uncontrolled retry storm found

## DLQ
- failing event reaches DLQ with retained error context

## Observability
- health endpoint available
- debug endpoint exists for deal inspection
- known operational queries documented in runbook

## Backup
- backup required before destructive data cleanup
- prior suspicious-deal backup exists for earlier cleanup phase

## Rollback
- app rollback: redeploy previous runtime
- DB rollback: use backup / controlled SQL reversal, not ad hoc destructive commands

## Feature Flags
- no feature-flag contract relied on in this QA package

## Kill Switch
- no dedicated kill switch identified
- operational fallback is stopping worker/app process

## Known Limitations
- future webhook ingestion endpoint, if added, still needs runtime duplicate verification at endpoint layer
- some legacy docs remain archival rather than aligned
