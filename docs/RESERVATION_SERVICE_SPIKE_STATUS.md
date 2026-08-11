# Reservation Service Spike Status

Date: 2026-08-11
Branch: `base44-reservation-service`
Parent migration branch: `base44-migration-spike`

## Completed

- Extracted a deliberately narrow PostgreSQL reservation component instead of reviving the old Siton backend.
- Component owns inventory ceiling and reservation lifecycle only. It stores no buyer PII, OTP, payment identifiers, delivery details or financial state.
- Added immutable inventory sync, transactional Hold, Commit, Release and inventory status operations.
- PostgreSQL `SELECT ... FOR UPDATE` serializes the Deal inventory critical section.
- Inventory now distinguishes `reserved_units` from `committed_units`. Active Holds protect capacity, while only committed units may count toward Siton's 90% threshold.
- Short-lived Holds expire and are reclaimed inside the next inventory transaction; correctness does not require a cleanup Worker.
- Same idempotent request can safely renew an expired Hold using the same reservation id and an incremented hold generation.
- Added HMAC-SHA256 service authentication covering timestamp, method, path and canonical body hash.
- Added isolated Dockerfile and GitHub Actions concurrency gate using PostgreSQL 16.
- Base44 now contains an `inventory-bridge` backend boundary. Publish and CloseJoining are wired to inventory Sync/Close when `RESERVATION_SERVICE_ENFORCED=true`; the flag is not enabled and Join remains fail-closed.

## Checked

- GitHub Actions run `31473482667`: PASS.
- TypeScript build: PASS.
- PostgreSQL concurrency suite: PASS.
- 200 simultaneous Holds on `max_units=20`: exactly 20 winners, no oversell.
- 50 simultaneous same-key replays: one Reservation only.
- Same idempotency key with different payload: rejected.
- Mixed quantities: never exceed the inventory ceiling.
- Commit increments `committed_units` exactly once; replay does not double-count.
- Commit versus Release race: exactly one terminal action wins and inventory invariants remain valid.
- Closed inventory rejects new Holds.
- Expired Hold reclaim plus same-key renewal: PASS.
- Base44 frontend build and ESLint: PASS after inventory bridge integration.
- Base44 `inventory-bridge`, `publish-deal` and `close-joining` bundles: PASS.
- Live Base44 Deal schema contains inventory sync/reserved/committed projection fields.
- Temporary Base44 inventory race probe was removed.
- No Base44 Join code has been enabled and no real payment path changed.

## Open

- Replace Base44 Join's old `updateMany` inventory mutation with the external Hold/Commit Saga while keeping the hard 503 gate until end-to-end proof is complete.
- Make Join projection deterministic from `reservation_id` so retries cannot create financial duplicates.
- Prove Base44 projection dedup/reconciliation under concurrent replay.
- Close external inventory before every terminal path that ends joining, including deadline/failure paths.
- Select a production deployment/database arrangement and configure protected Base44 secrets only after the Saga is proven.
- Prove end-to-end compensation and recovery across response loss/crashes.

## Progress

Reservation critical-section extraction: 90%.
Overall Siton-to-Base44 migration estimate: 62%.
Initial technical migration path: 97%.

These percentages measure migrated scope, not production readiness. Join is still disabled.

## Next step

Implement the Base44 Join Saga as: validate -> inventory Hold -> inventory Commit -> deterministic Base44 projection -> threshold from `committed_units`. Retry must be able to reconstruct the same projection after any response loss. Do not enable Join until repeated concurrent end-to-end tests pass.
