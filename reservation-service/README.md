# Siton Reservation Service

Narrow transactional service for one responsibility only: preventing inventory oversell during Join.

It is intentionally **not** the Siton backend. Base44 remains the product/control plane and owns sellers, deals, buyers, OTP, payment state, UI, admin and analytics. This service stores no buyer PII, payment identifiers, OTP data, delivery addresses or financial state.

## Why it exists

Repeated true-concurrency testing showed that Base44 Entity conditional `updateMany` can oversell the last unit. The canonical C-ton implementation previously proved PostgreSQL row locking under 70/200-way Join races. This package extracts only that transactional critical section.

## Contract

Protected endpoints use HMAC-SHA256 headers `x-siton-timestamp` and `x-siton-signature`. The signature covers timestamp, HTTP method, path and a SHA-256 hash of canonical JSON body. TLS remains mandatory.

- `POST /v1/deals/sync` creates immutable `max_units` and `min_units` thresholds at Publish time.
- `POST /v1/reservations/hold` serializes on the Deal row with `SELECT ... FOR UPDATE`, reclaims expired holds, enforces the ceiling and writes one idempotent short-lived Hold.
- `POST /v1/reservations/commit` converts a live Hold to a committed Reservation. The Commit that reaches the full `min_units` performs `PendingTarget` to `TargetReached` and inserts its append-only `deal.target_reached` Audit row in the same PostgreSQL transaction.
- `POST /v1/reservations/release` compensates a pre-commit Base44 failure by releasing a live Hold.
- `POST /v1/inventory/status` returns the current ceiling and also reclaims expired Holds.
- `GET /health` is the only unauthenticated route.

The default Hold lease is 120 seconds and is configurable from 5 to 900 seconds. No cleanup Worker is required for correctness: every inventory transaction reclaims expired Holds before checking capacity.

## Required environment

- `DATABASE_URL`
- `RESERVATION_SERVICE_SHARED_SECRET` with at least 32 characters
- optional `HOLD_TTL_SECONDS`, `DB_POOL_MAX`, `PORT`, `HOST`, `SIGNATURE_WINDOW_SECONDS`

## Verification

`npm run test:concurrency` runs against real PostgreSQL and proves:

1. 200 simultaneous quantity-1 Holds on a 20-unit Deal produce exactly 20 winners.
2. 50 simultaneous replays of one idempotency key create one Reservation only.
3. Mixed quantities never push `reserved_units` above `max_units`.
4. Expired Holds are reclaimed transactionally without a background Worker.
5. Holds and sub-minimum Commits do not reach the target; the full minimum does.
6. Concurrent threshold-crossing Commits create one Audit row, and an Audit failure rolls back the Reservation Commit, counter and state together.

This package is not production-enabled merely because the code exists. Join in Base44 must stay fail-closed until CI passes the real PostgreSQL concurrency suite, the service is deployed behind TLS with a protected secret, and Base44 Hold/Commit/Release compensation is verified end-to-end.
