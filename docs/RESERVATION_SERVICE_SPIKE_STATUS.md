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
- Added isolated Dockerfile and GitHub Actions concurrency/close gate using PostgreSQL 16.
- Base44 now contains the `inventory-bridge` boundary and a rewritten Join Saga. Publish synchronizes inventory, Join stages a recovery intent before Hold, external Commit is projected deterministically, and CloseJoining reconciles pending Join intents before closing inventory.
- Base44 recovery policy is fail-safe: already committed reservations are projected; ambiguous held reservations are released rather than auto-committed; expired, released or never-created outcomes clear their pending intent.
- Join remains fail-closed unless both `RESERVATION_SERVICE_ENFORCED=true` and `JOIN_EXTERNAL_RESERVATION_PROVEN=true` are explicitly configured.

## Checked

- GitHub Actions run `31486075043` / run 13: PASS.
- Reservation Service TypeScript build: PASS.
- PostgreSQL concurrency and close proof: PASS.
- 200 simultaneous Holds on `max_units=20`: exactly 20 winners, no oversell.
- 50 simultaneous same-key replays: one Reservation only.
- Same idempotency key with different payload: rejected.
- Mixed quantities: never exceed the inventory ceiling.
- Commit increments `committed_units` exactly once; replay does not double-count.
- Commit versus Release race: exactly one terminal action wins and inventory invariants remain valid.
- Closed inventory rejects new Holds.
- Expired Hold reclaim plus same-key renewal: PASS.
- Active Hold blocks inventory Close; Close succeeds after the Hold reaches a safe terminal outcome.
- Base44 frontend build: PASS.
- Base44 ESLint: PASS.
- Base44 `join-deal`, `inventory-bridge`, `reconcile-join-intents`, `transition-engine`, `close-joining` and `publish-deal` bundles: PASS.
- Base44 Stage 16 checkpoint: `6a7b080ad80d486a49e868c4`, sandbox commit `ccc35ef51525fe0cfd2f6dbb5ba5219fd4628408`.
- No production reservation URL or shared secret was configured.
- No tracking secret or Join enable flag was configured.
- No real buyer Join and no real payment path was enabled by this milestone.

## Open

- Deploy the narrow reservation service plus PostgreSQL to an approved non-production environment.
- Configure `RESERVATION_SERVICE_URL`, `RESERVATION_SERVICE_SHARED_SECRET` and `TRACKING_TOKEN_SECRET` only as protected runtime secrets.
- Run real Base44-to-service end-to-end proofs with reservation enforcement enabled but before public activation: normal Join, duplicate replay, last-unit race, response loss after Hold, response loss after Commit, CloseJoining during an active Hold, and recovery of committed/held/not-found intents.
- Verify buyer tracking, distribution attribution and public/seller counters after replay and recovery.
- Verify every deadline/failure path that ends joining closes or reconciles inventory through the same canonical transition boundary.
- Only after repeated end-to-end proof set `JOIN_EXTERNAL_RESERVATION_PROVEN=true`.
- Payment authorization/capture/recovery/refund remains a separate production-readiness gate.

## Progress

Reservation critical-section extraction and local/CI proof: 95%.
Overall Siton-to-Base44 migration estimate: 64%.
Initial technical migration path: 98%.

These percentages measure migrated scope, not production readiness. Join is still disabled.

## Next step

Deploy only the narrow reservation service and PostgreSQL to a protected test environment, configure test-only Base44 secrets, then execute the full Base44-to-PostgreSQL Join/Close/recovery race suite. Keep Join fail-closed until that end-to-end gate is green.
