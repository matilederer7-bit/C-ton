# Outbox Worker — Operational Reference

The canonical worker is the standalone process in src/worker.ts. The Web
process never starts an in-process Outbox loop.

For the Stage 32B design, repair modes, error codes and rollback contract, see
STAGE32B_OPERATIONAL_RECOVERY.md.

## Ownership model

An event moves from pending to processing through an atomic PostgreSQL claim
using FOR UPDATE SKIP LOCKED. A valid lease is identified by:

    event_uuid + worker_id + lease_generation + lease_expires_at > DB now()

lease_generation increments on every claim. Heartbeat, completion, retry,
failure and DLQ all require the exact current generation. A stale worker gets
outbox_lease_lost and cannot report completion.

Migration 045 also installs database cutover triggers on Outbox update and
delete. A rolling old worker cannot acknowledge, retry, complete, or delete a
legacy generation-0 processing row. Only an unchanged `deadline_check`
identity/payload with unchanged attempt policy and request/correlation fields
can cross that boundary as `pending`, generation 1, unsent and ownership
cleared. A matching append-only `repair_lease` Audit for the event, generation,
attempt count and `processing` to `pending` transition must already be visible;
the controlled adapter inserts it first in the same transaction. Delete
remains forbidden.

All timestamps that control ownership or retry use PostgreSQL time.

## Recovery

The default lease and stuck timeout are 60 seconds. The standalone worker
periodically calls reclaimStuckProcessing:

- an expired, complete protocol lease at generation 1 or later and below the
  attempt cap returns to pending for any canonical event type;
- attempt_count is preserved;
- owner, claim time, heartbeat and expiry clear; the next claim increments the
  generation before processing resumes;
- a reclaim Audit is appended in the same transaction;
- a row at the effective attempt cap goes to DLQ instead.

Generation 0 or a processing row with incomplete lease evidence is not
automatically reclaimed. It remains quarantined for explicit evidence-backed
repair. The manual repair planner is deliberately narrower: it permits only
`deadline_check` to move to `pending`, and blocks money/external work. In
particular, the known live legacy `charge_deal` has no generation field, must
not be moved to `pending` by manual repair, and must not be replayed without
dedicated payment reconciliation.

Pending rows already at the cap are swept to DLQ before claim. They do not
remain unclaimable zombies.

Batch claim and capped-row archival use a savepoint per event. A row-local
constraint or Audit-idempotency conflict rolls back only that event, records a
bounded failure reason, and quarantines the active row as `failed`; independent
healthy rows continue. An identical Audit replay is accepted only when every
immutable field matches. Unknown database errors still abort the transaction
instead of being misclassified as poison.

## Retry and DLQ

The default event maximum is four attempts. A lower per-event value remains
authoritative; worker policy is a hard upper bound.

Normal retry uses deterministic exponential backoff based on DB now, capped at
15 minutes. Permanent failure or exhausted attempts copy all Outbox evidence
to outbox_dlq with an explicit column list and delete the source in the same
transaction.

The append-only operational_recovery_audit table records:

- claim;
- reclaim;
- heartbeat;
- completion;
- failure;
- retry;
- DLQ.

It stores technical identifiers and bounded reason codes. It is separate from
audit_log, which remains reserved for canonical business state transitions.

## Health endpoint

    GET /api/admin/outbox-status
    x-admin-key: <protected admin key>

A clean system normally has:

- stale leases: 0;
- stuck candidates: 0;
- pending age near zero;
- processing rows only while work is active;
- stable DLQ count;
- at least one fresh standalone worker heartbeat.

Never print the admin key, connection string, payload, recipient, provider
credential or payment reference in an operational report.

## Post-restart checklist

1. Read the status endpoint and worker heartbeat age.
2. Wait one reclaim interval, then confirm eligible generation-fenced protocol
   rows fell to zero or moved to DLQ; review quarantined rows separately
   without replaying them.
3. Inspect lifecycle Audit for the exact event UUID.
4. Confirm the current generation has only one owner.
5. For outcome-unknown external work, reconcile through the provider's stable
   idempotency key before retry. Never replay money blindly.
6. Run the Canonical Integrity Gate.

## Manual intervention

The admin requeue action cannot take an actively processing row away from a
worker. It only requeues explicit pending/failed rows below the attempt cap and
writes recovery Audit. Only complete, generation-fenced processing work uses
the automatic canonical reclaim path; manual repair remains restricted to
`deadline_check`.

The Stage 32B repair CLI defaults to inspect and requires an explicit target.
Apply additionally requires a matching plan hash, explicit confirmation and a
reviewed repository adapter. For an evidence-complete legacy
`deadline_check`, manual repair fences generation 0 as generation 1 before it
clears ownership. Its conditional preconditions include `claimed_at`, all
lease/heartbeat timestamps, `available_at`, attempt limits, `sent=false` and
`sent_at=null`. The adapter must return the exact database mutation timestamp,
and the verified post-state must set `available_at` to that value. Any delivery
ambiguity stays quarantined. No live Base44 adapter is configured.

## Environment variables

| Variable | Default | Meaning |
|---|---:|---|
| WORKER_LEASE_MS | 60000 | Event lease duration |
| WORKER_STUCK_TIMEOUT_MS | 60000 | Diagnostic stuck threshold; never authority to reclaim incomplete legacy evidence |
| WORKER_RECLAIM_EVERY_POLLS | 10 | Reclaim cadence |
| WORKER_HEARTBEAT_MS | 10000 | Process heartbeat cadence |
| OUTBOX_POLL_MS | 1000 | Poll and retry base |
| OUTBOX_MAX_ATTEMPTS | 4 | Hard retry cap |
| DISABLE_OUTBOX_WORKER | unset | Test-only suppression |

## Focused verification

    npm run test:workers
    npm run test:operational-repair
    npm run test:failure
    npm run gate:base44-canonical-integrity

All tests must use disposable databases and fake/log-only handlers. Do not use
live records to prove recovery behavior.
