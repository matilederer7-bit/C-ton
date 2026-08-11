# Reservation Service Spike Status

Date: 2026-08-11
Branch: `base44-reservation-service`
Parent migration branch: `base44-migration-spike`

## Completed

- Extracted a deliberately narrow PostgreSQL reservation component instead of reviving the old Siton backend.
- Component owns inventory ceiling and reservation lifecycle only. It stores no buyer PII, OTP, payment identifiers, delivery details or financial state.
- PostgreSQL `SELECT ... FOR UPDATE` serializes the Deal inventory critical section.
- Inventory distinguishes `reserved_units` from `committed_units`. Active Holds protect capacity; only committed units count toward Siton's 90% threshold projection.
- Added immutable inventory Sync, transactional Hold, Commit, Release, Close, inventory Status, reservation Status and idempotency Lookup operations.
- Lookup by `(deal_id, idempotency_key)` lets Base44 recovery distinguish not-created, held, committed, expired and released outcomes after response loss.
- Short-lived Holds expire and are reclaimed inside the next inventory transaction; correctness does not require a cleanup Worker.
- The same idempotent request can safely renew an expired Hold with the same reservation id and an incremented hold generation.
- Close is transactional and refuses to close while an active Hold exists. Once closed, no new Hold may enter.
- Added HMAC-SHA256 service authentication covering timestamp, method, path and canonical body hash.
- Added isolated Dockerfile and GitHub Actions concurrency/close/recovery gate using PostgreSQL 16.
- Base44 contains the `inventory-bridge` boundary and rewritten Join Saga. Publish synchronizes inventory, Join stages a recovery intent before Hold, external Commit is projected deterministically, and CloseJoining reconciles pending Join intents before closing inventory.
- Base44 recovery policy is fail-safe: already committed reservations are projected; ambiguous held reservations are released rather than auto-committed; expired, released or never-created outcomes clear their pending intent.
- Join remains fail-closed unless both `RESERVATION_SERVICE_ENFORCED=true` and `JOIN_EXTERNAL_RESERVATION_PROVEN=true` are explicitly configured.
- Base44 Deno functions can bundle `npm:pg`; direct runtime PostgreSQL connectivity is now the preferred minimal-infrastructure experiment before deploying a separate Node service.

## Checked

- GitHub Actions run `31487801647` / run 17: PASS.
- Reservation Service TypeScript build: PASS.
- PostgreSQL concurrency and close proof: PASS.
- Saga crash/recovery suite: PASS.
- 200 simultaneous Holds on `max_units=20`: exactly 20 winners, no oversell.
- 50 simultaneous same-key replays: one Reservation only.
- Same idempotency key with different payload: rejected.
- Mixed quantities: never exceed the inventory ceiling.
- Commit increments `committed_units` exactly once; replay does not double-count.
- Commit versus Release race: exactly one terminal action wins and inventory invariants remain valid.
- Closed inventory rejects new Holds.
- Expired Hold reclaim plus same-key renewal: PASS.
- Crash after Hold can be compensated by Release: PASS.
- Crash after Commit survives a new store/process-style replay without double-counting: PASS.
- Active Hold blocks inventory Close; Close succeeds after the Hold reaches a safe terminal outcome.
- Close after committed Join preserves committed capacity and rejects later Holds: PASS.
- Temporary Holds do not count toward the 90% threshold; only committed units do: PASS.
- Base44 frontend build: PASS.
- Base44 ESLint: PASS.
- Base44 `join-deal`, `inventory-bridge`, `reconcile-join-intents`, `transition-engine`, `close-joining` and `publish-deal` bundles: PASS.
- Static Base44 safety check confirms the old `$inc reserved_units` Join path is absent and both enable flags are required.
- Base44 Stage 17 checkpoint: `6a7b0b5cb552ed02ddc9976e`, sandbox commit `dda072313b3e718d725b00e23f7b9da2e28099d0`.
- No production reservation URL, database URL, shared secret, tracking secret or Join enable flag is configured.
- No real buyer Join and no real payment path was enabled by this milestone.

## Open

- Prove whether a Base44 Backend Function can directly connect to a managed PostgreSQL endpoint. If this works, prefer Base44 plus managed PostgreSQL only and retire the separate Node service from the runtime architecture.
- If direct PostgreSQL connectivity fails, deploy the already-proven narrow reservation service plus PostgreSQL as the fallback.
- Configure protected non-production secrets only after a managed PostgreSQL test endpoint exists.
- Run real Base44-to-PostgreSQL end-to-end proofs before public activation: normal Join, duplicate replay, last-unit race, response loss after Hold, response loss after Commit, CloseJoining during an active Hold, and recovery of committed/held/not-found intents.
- Verify buyer tracking, distribution attribution and public/seller counters after replay and recovery.
- Verify every deadline/failure path that ends joining closes or reconciles inventory through the same canonical transition boundary.
- Only after repeated end-to-end proof set `JOIN_EXTERNAL_RESERVATION_PROVEN=true`.
- Payment authorization/capture/recovery/refund remains a separate production-readiness gate.

## Progress

Reservation critical-section extraction and local/CI proof: 97%.
Overall Siton-to-Base44 migration estimate: 66%.
Initial technical migration path: 99%.

These percentages measure migrated scope, not production readiness. Join is still disabled.

## Next step

Use the smallest operational footprint. First prove Base44-hosted direct PostgreSQL access against a managed non-production database. If that runtime proof fails, deploy only the narrow reservation service plus PostgreSQL. Keep Join fail-closed until the repeated end-to-end Join/Close/recovery race gate is green.
