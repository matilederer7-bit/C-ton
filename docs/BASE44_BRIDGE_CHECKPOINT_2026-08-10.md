# Base44 Migration Checkpoint

Date: 2026-08-11
Branch: `base44-migration-spike`
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)

## Completed

- Stage 0 bridge completed without making the old Render deployment a dependency.
- Canonical C-ton `master` remains untouched and is used as specification, test oracle and rollback source.
- Draft creation and Publish migrated to Base44 with seller enforcement, 90% threshold, deadline rules, confirmations and idempotency evidence.
- OTP request/verify rail migrated with hashing, masking, TTL, rate limit, attempt limit, lockout and proof token. External OTP delivery remains disconnected.
- Join contract migrated with OTP proof, payment-disclosure acceptance, delivery snapshot, authorization reference, JoinedAuthorized/AuthHeld, hold total, tracking token and attribution-only affiliate reference.
- Participant remains a derived projection after the Deal reservation attempt.
- Public buyer route `/deal/:dealId` implemented with safe public fields only.
- Buyer post-Join tracking migrated at `/app/track/:participantId`. `get-buyer-tracking` validates the opaque tracking token against its SHA-256 hash and expiry before returning buyer/money state, quantity, hold total, delivery summary, Deal progress and Completion Window timing. Provider authorization references and other buyers are not exposed.
- TargetReached -> ClosedForJoining -> ReadyForCharging -> Charging migrated.
- `start-charging` performs no payment I/O and embeds exactly one canonical `charge_deal` Outbox event in the same Deal mutation.
- Outbox projection and reconciliation implemented.
- Deterministic charge-result application implemented. Unknown/temporary truth stays in Charging. Final truth opens one 24-hour Completion Window and schedules recovery/finalize.
- Recovery application implemented: success -> Recovered/RecoveredCharge; permanent failure -> Dropped/AuthReleased; unknown/temporary -> no state transition.
- Finalize implemented against captured/recovered quantity and the canonical 90% threshold. Success -> Completed; below threshold -> Failed plus `refund_issue`.
- Refund application implemented so only provider-confirmed success can move money to Refunded.
- Worker queue foundation migrated: claim, lease, heartbeat, reclaim, retry, deferred retry and DLQ.
- Deal and SellerAccount direct mutation hardened to admin-only so seller UI cannot bypass Transitions, seller status or KYC controls.
- Seller profile safe-edit surface migrated. Authenticated seller can edit only `display_name`, `business_name`, `support_phone` and `support_email` through `update-seller-profile`; `seller_id`, `seller_status`, `verification_status` and `owner_user_id` remain immutable from this path. `/seller/profile` UI added.
- A hard safety gate was added to `join-deal`: production Join is fail-closed with `503 inventory_concurrency_gate_not_proven` until a supported serialized reservation primitive is proven.
- The temporary public concurrency probe function and temporary lock-probe source were removed after testing.
- Read-only Admin Mission Control migrated at `/admin` with backend `role=admin` enforcement. It exposes Deal state counts, seller status/verification counts, Worker/Outbox queue depth, stale leases, DLQ, PaymentAttempt result summaries and recent Deal/DLQ rows without offering state mutation controls.
- Admin Mission Control explicitly reports that Join is disabled by the concurrency gate and that real money is disabled.
- No Base44 function currently performs real authorization, capture, recovery, refund or release.

## Checked

- Base44 frontend build: PASS after the fail-closed, Admin Mission Control and buyer tracking changes.
- ESLint: PASS after the same changes.
- `join-deal` esbuild parse/bundle: PASS with the hard concurrency gate enabled.
- `admin-overview` esbuild parse/bundle: PASS.
- `get-buyer-tracking` esbuild parse/bundle: PASS.
- Entity schema mirror gate: PASS before the latest safety change.
- Live schema verification: Deal/SellerAccount update/delete admin-only; money/outbox control entities admin-only.
- Sequential inventory probe with max_units=1: first reservation updated one Deal; second updated zero.
- Ceiling + idempotency sequential probe: replay caused zero extra mutation; new key after full inventory also caused zero mutation.
- Worker claim race probe: Worker A claimed; Worker B updated zero.
- Worker reclaim probe: expired lease returned event to pending; next worker reclaimed it; attempt_count advanced 1 -> 2.
- A previous simultaneous last-unit probe happened to return exactly one winner and was initially marked PASS.
- A repeated TRUE simultaneous last-unit probe disproved that conclusion: a Deal with `max_units=1` finished with `reserved_units=2`, two reservations and two idempotency keys. Therefore Base44 Entity conditional `updateMany` is NOT accepted as a hard oversell-prevention primitive.
- SDK/package inspection found an Actor API backed by Durable Objects, but the installed Base44 CLI exposes no Actor create/deploy/config command. Actor is therefore treated as undocumented/unsupported and is not used for Siton inventory.
- Attempting a deterministic record-id lock also failed as a design path because Base44 generated its own entity record id rather than honoring the supplied deterministic id.
- Full project typecheck remains red because of pre-existing Base44 template JSX/UI/Auth typing; build/lint remain green. Do not represent typecheck as PASS.

## Open

- Provide a production-supported serialized reservation mechanism before Join can be enabled. This may be a supported Base44 primitive if one becomes documented, otherwise a deliberately narrow external transactional reservation component.
- Connect real OTP delivery provider.
- Connect and verify canonical payment provider for authorization/capture/recovery/refund/release. Stripe is not connected in this Base44 session and no credentials were invented.
- Implement provider-I/O Worker adapter plus UNKNOWN reconciliation/status lookup after Stripe is available.
- Wire Base44 Automation/CRON or Entity Hook to Worker tick. Platform supports it, but the current remote-sandbox surface does not expose a reliable Automation creation/deployment action and Base44 CLI authentication does not complete in this sandbox.
- Exercise Retry/DLQ against a real provider sandbox once Worker Automation exists.
- Add the payment-method recovery action behind the buyer tracking surface after a real provider is connected.
- Continue migrating remaining admin/product UX surfaces that do not depend on Join being enabled.
- Resolve the documented KYC runtime/compliance inconsistency before production.
- Update root `PROJECT_STATUS.md` only through a safe non-truncating patch path.

## Progress

Initial technical Base44 migration path: 82%.
Overall Siton-to-Base44 migration estimate: 47%.

The percentages measure migrated scope, not production readiness. The concurrency defect does not erase migrated code, but Join is intentionally disabled until the blocker is solved.

- Stage 0 Bridge: complete.
- Stage 1 Draft: complete.
- Stage 2 Publish: complete.
- Stage 3 OTP + Join contract: implemented, but Join is fail-closed because hard inventory concurrency is NOT proven.
- Stage 4 Public buyer surface: implemented.
- Stage 5 Pre-money charging boundary: implemented.
- Stage 6 Recovery, Finalize, Refund and Worker queue foundation: implemented.
- Stage 7 True last-unit concurrency proof: FAILED on repeat; previous PASS was non-authoritative/flaky.
- Stage 8 Seller profile safe-edit surface: implemented and build-verified.
- Stage 9 Admin Mission Control read-only: implemented and build-verified.
- Stage 10 Buyer tracking surface: implemented and build-verified.

## Current Base44 checkpoint

`Stage 10 buyer tracking surface`

Checkpoint id: `6a7ab030de400cb06c00c735`

Sandbox commit: `6a324b60deb4f343edf34c2423c697ad957ae69a`

## Next step

Keep Base44-first architecture, but solve only the narrow inventory-reservation critical section with a proven serialized/transactional primitive. Do not reconnect Join, Stripe, or real money until oversell prevention passes repeated concurrent stress tests. Continue migrating independent admin/product surfaces in parallel without touching the blocked Join path.
