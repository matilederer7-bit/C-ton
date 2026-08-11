# Base44 Migration Checkpoint

Date: 2026-08-11
Branch: `base44-migration-spike`
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)

## Completed

- Stage 0 bridge completed without making the old Render deployment a dependency.
- Canonical C-ton `master` remains untouched and is used as specification, test oracle and rollback source.
- Draft creation and Publish migrated to Base44 with seller enforcement, 90% threshold, deadline rules, confirmations and idempotency evidence.
- OTP request/verify rail migrated with hashing, masking, TTL, rate limit, attempt limit, lockout and proof token. External OTP delivery remains disconnected.
- Join migrated with OTP proof, payment-disclosure acceptance, delivery snapshot, authorization reference, JoinedAuthorized/AuthHeld, hold total, tracking token and attribution-only affiliate reference.
- Inventory reservation is canonical inside one Deal aggregate. `reserved_units`, reservation evidence and idempotency key change in one conditional Base44 update.
- Participant remains a derived projection after canonical reservation.
- Public buyer route `/deal/:dealId` implemented with safe public fields only.
- TargetReached -> ClosedForJoining -> ReadyForCharging -> Charging migrated.
- `start-charging` performs no payment I/O and embeds exactly one canonical `charge_deal` Outbox event in the same Deal mutation.
- Outbox projection and reconciliation implemented.
- Deterministic charge-result application implemented. Unknown/temporary truth stays in Charging. Final truth opens one 24-hour Completion Window and schedules recovery/finalize.
- Recovery application implemented: success -> Recovered/RecoveredCharge; permanent failure -> Dropped/AuthReleased; unknown/temporary -> no state transition.
- Finalize implemented against captured/recovered quantity and the canonical 90% threshold. Success -> Completed; below threshold -> Failed plus `refund_issue`.
- Refund application implemented so only provider-confirmed success can move money to Refunded.
- Worker queue foundation migrated: claim, lease, heartbeat, reclaim, retry, deferred retry and DLQ.
- Deal and SellerAccount direct mutation hardened to admin-only so seller UI cannot bypass Transitions, seller status or KYC controls.
- No Base44 function currently performs real authorization, capture, recovery, refund or release.

## Checked

- Base44 frontend build: PASS.
- ESLint: PASS.
- esbuild parse/bundle: PASS for all migrated backend functions and worker functions.
- Entity schema mirror gate: PASS.
- Live schema verification: Deal/SellerAccount update/delete admin-only; money/outbox control entities admin-only.
- Inventory max=1 sequential probe: first reservation updated one Deal; second updated zero.
- Ceiling + idempotency probe: replay caused zero extra mutation; new key after full inventory also caused zero mutation.
- PendingTarget -> TargetReached conditional transition: PASS.
- ReadyForCharging -> Charging + exactly one embedded `charge_deal`: PASS; replay mutation updated zero.
- Worker claim race probe: Worker A claimed; Worker B updated zero.
- Worker reclaim probe: expired lease returned event to pending; next worker reclaimed it; attempt_count advanced 1 -> 2.
- TRUE simultaneous last-unit race proof: PASS on 2026-08-11. A temporary self-contained deployed Base44 backend function created a one-unit Deal and ran two conditional reservations in the same `Promise.all`. Result: exactly one winner, the other update returned zero, final `reserved_units=1`, one reservation and one idempotency key. HTTP 200. The temporary public probe function was removed immediately after the test. The permanent probe remains admin-protected.
- Full project typecheck remains red because of pre-existing Base44 template JSX/UI/Auth typing; build/lint remain green. Do not represent typecheck as PASS.

## Open

- Connect real OTP delivery provider.
- Connect and verify canonical payment provider for authorization/capture/recovery/refund/release. Stripe is not connected in this Base44 session and no credentials were invented.
- Implement provider-I/O Worker adapter plus UNKNOWN reconciliation/status lookup after Stripe is available.
- Wire Base44 Automation/CRON or Entity Hook to Worker tick. Platform supports it, but the current remote-sandbox surface does not expose a reliable Automation creation/deployment action.
- Exercise Retry/DLQ against a real provider sandbox once Worker Automation exists.
- Implement remaining seller/admin/product UX surfaces and seller profile-update path.
- Resolve the documented KYC runtime/compliance inconsistency before production.
- Update root `PROJECT_STATUS.md` only through a safe non-truncating patch path.

## Progress

Initial technical Base44 migration path: 75%.
Overall Siton-to-Base44 migration estimate: 42%.

- Stage 0 Bridge: complete.
- Stage 1 Draft: complete.
- Stage 2 Publish: complete.
- Stage 3 OTP + Join + atomic inventory: implemented; TRUE concurrency proof now PASS; real OTP/payment provider remain open.
- Stage 4 Public buyer surface: implemented.
- Stage 5 Pre-money charging boundary: implemented.
- Stage 6 Recovery, Finalize, Refund and Worker queue foundation: implemented.
- Stage 7 True last-unit concurrency proof: PASS.

## Current Base44 checkpoint

`Stage 7 true last-unit concurrency proof passed`

Checkpoint id: `6a7aab7c3ee3060483271e2e`

Sandbox commit: `66207334c023c7986d5a50ae0b3eeb29391b43c3`

## Next step

Continue migrating seller/admin/product surfaces that do not depend on external providers. In parallel, the remaining external gates are Base44 Worker Automation, real OTP delivery and Stripe Sandbox. No real money run until all three are connected and UNKNOWN/retry/reconciliation tests pass.