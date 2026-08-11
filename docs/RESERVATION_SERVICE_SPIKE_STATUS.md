# Reservation Service Spike Status

Date: 2026-08-11
Branch: `base44-reservation-service`
Parent migration branch: `base44-migration-spike`

## Completed

- Extracted a deliberately narrow PostgreSQL reservation service instead of reviving the old Siton backend.
- Service owns inventory ceiling and reservation lifecycle only. It stores no buyer PII, OTP, payment identifiers, delivery details or financial state.
- Added immutable inventory sync, transactional Hold, Commit, Release and inventory status operations.
- Hold uses PostgreSQL row locking with `SELECT ... FOR UPDATE`, request idempotency and an additional `reserved_units <= max_units` database constraint.
- Short-lived Holds expire and are reclaimed transactionally by the next inventory operation; correctness does not require a cleanup Worker.
- Added HMAC-SHA256 service authentication covering timestamp, method, path and canonical body hash.
- Added isolated Dockerfile and GitHub Actions concurrency gate using PostgreSQL 16.
- Added concurrency tests for 200 simultaneous joins against 20 units, same-key replay, mixed quantities and expired-hold reclaim.

## Checked

- Code was created as one isolated commit `08ac6ef8212e0a2d8b24d46d751ee1c70d1c8f2b`.
- Existing `base44-migration-spike` branch was not force-moved or overwritten.
- No Base44 Join code has been re-enabled.
- No payment, OTP, Render, Worker or canonical C-ton runtime file was modified.

## Open

- CI must prove the new service compiles and the PostgreSQL concurrency suite passes.
- Only after CI is green: connect Base44 Publish to inventory sync and Join to Hold/Commit/Release behind the existing fail-closed gate.
- End-to-end compensation must prove that Base44 failure after Hold releases the Hold, while failure after Commit preserves a recoverable committed reservation.
- Deployment provider and production secret are intentionally not selected yet.

## Progress

Reservation-service extraction: 70% until CI proof.
Overall Siton-to-Base44 migration estimate: 59%.
Initial technical migration path: 94%.

## Next step

Open a stacked Draft PR from `base44-reservation-service` into `base44-migration-spike`, wait for the dedicated PostgreSQL concurrency gate, fix any failures, then integrate the Base44 reservation client while keeping Join fail-closed until repeated end-to-end race proof passes.
