# Reservation Service Spike Status

Date: 2026-08-12
Branch: `base44-reservation-service`
Parent migration branch: `base44-migration-spike`

## Completed

- PostgreSQL remains deliberately narrow: inventory, Reservation lifecycle, Deal target state and the canonical target-transition Audit only.
- Publish Sync persists immutable `max_units` and `min_units`.
- Holds protect capacity but never count toward the target.
- Only committed units count toward target progress.
- The Commit that reaches the full `min_units` performs `PendingTarget` to `TargetReached` and inserts one `deal.target_reached` Audit row in the same database transaction.
- The Audit table is append-only at the database layer.
- `SELECT ... FOR UPDATE` serializes concurrent Deal commits; a deterministic target idempotency key and a unique constraint prevent duplicate target Audit rows.
- The 90% rule is not a target-state threshold. It remains a later financial success rule.
- HMAC authentication, Hold/Commit/Release, expiry reclaim, Close, status and action idempotency remain unchanged.
- Base44 Join remains fail-closed behind `RESERVATION_SERVICE_ENFORCED` and `JOIN_EXTERNAL_RESERVATION_PROVEN`.

## Checked

- TypeScript build and PostgreSQL CI gate are required on this Draft PR.
- Holds do not trigger `TargetReached`.
- A sub-minimum Commit remains `PendingTarget`.
- The full minimum creates one canonical Audit.
- 20 concurrent Commits crossing the minimum create exactly one Audit.
- Forced Audit insertion failure rolls the Reservation status, committed counter and Deal state back together.
- Audit UPDATE and DELETE are rejected.
- Existing concurrency, Close, recovery and action-idempotency suites remain in the gate.

## Open

- This proves the PostgreSQL code path in isolated CI, not a live Base44-to-managed-PostgreSQL path.
- Configure no production URL, database, shared secret or enable flag until a protected non-production database exists.
- Run repeated Base44 end-to-end Join, replay, last-unit race, response-loss, Close and recovery tests.
- P0.11 remains operationally open until the managed PostgreSQL path is connected and observed.
- Payment authorization, capture, recovery and refund remain a separate production-readiness gate.

## Progress

Reservation critical-section and target-transition code proof: 99%.
Overall Siton-to-Base44 code migration estimate: 98%.
Initial technical migration path: 99%.

These percentages measure transferred code scope, not production readiness. Production readiness is not honestly measurable yet, and Join remains disabled.
