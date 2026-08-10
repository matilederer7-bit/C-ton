# Base44 Migration Checkpoint

Date: 2026-08-10
Branch: `base44-migration-spike`
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)

## Completed

- Stage 0 bridge completed without making the old Render deployment a dependency.
- Canonical C-ton `master` remains untouched and is used as specification, test oracle and rollback source.
- Draft creation migrated to Base44.
- Publish migrated with Draft -> PendingTarget, seller enforcement, 90% threshold, seller confirmations, audit evidence and idempotency evidence.
- Base44 schemas cover Deal, SellerAccount, DealAudit, IdempotencyRecord, Participant, OtpChallenge, OtpDeliveryAttempt, OutboxEvent, OutboxDeadLetter and PaymentAttempt.
- Base44-generated PascalCase/kebab-case schema mirrors are kept identical and checked by a build gate. A real schema-drift defect was found and corrected during migration.
- Deal and SellerAccount mutation security hardened: sellers may read owned records but direct `update`/`delete` is admin-only. State transitions, seller status and KYC cannot be bypassed through the frontend SDK.
- OTP request/verify rail migrated with destination validation, masking/hash, 10-minute TTL, five requests per 15-minute window, three attempts, lockout, proof token and no plaintext OTP storage/response. External delivery remains disconnected.
- Join migrated with OTP proof, payment-disclosure acceptance, repeated purchases, delivery snapshot, authorization reference, JoinedAuthorized/AuthHeld, hold total, tracking token, attribution-only affiliate ref and deterministic idempotency.
- Inventory reservation is canonical inside one Deal aggregate. `reserved_units`, reservation evidence and the idempotency key change in one conditional Base44 update.
- Participant remains a derived projection after canonical Deal reservation.
- PendingTarget -> TargetReached implemented conditionally.
- Public buyer route `/deal/:dealId` implemented outside login. `get-public-deal` exposes safe public fields only. Buyer UI shows price, inventory, 90% progress, deadline, delivery, OTP and explicit authorization-only payment disclosure. Join stays blocked until a real authorization rail exists.
- TargetReached -> ClosedForJoining implemented conditionally and idempotently.
- ClosedForJoining -> ReadyForCharging implemented. JoinedAuthorized/AuthHeld reservations become LockedIn/AuthLocked inside the Deal aggregate; Participant rows are projections.
- ReadyForCharging -> Charging implemented by `start-charging`. HTTP performs no payment I/O. It moves reservations to ChargingAttempt/ChargeAttempt and embeds exactly one pending `charge_deal` event in the same Deal update.
- `OutboxEvent` projection and `reconcile-outbox-projections` added. Missing projections can be rebuilt from canonical embedded Deal events with no money side effect.
- `apply-charge-results` implements the deterministic post-provider boundary. Unknown/temporary truth leaves the deal in Charging. Final truth moves participants to ChargedSuccess or ChargeFailedCompletion, money to ChargedSuccess or ChargeFailedRecovery, opens one immutable-by-contract 24-hour Completion Window, creates finalize at expiry and immediate recovery when failures exist.
- `apply-recovery-results` implements final recovery truth inside CompletionWindow. Success moves ChargeFailedCompletion/ChargeFailedRecovery -> Recovered/RecoveredCharge. Permanent failure moves -> Dropped/AuthReleased. Unknown/temporary truth does not change state.
- `finalize-deal` implements the canonical 90% final decision after Completion Window expiry. It counts only quantities whose money state is ChargedSuccess or RecoveredCharge. Threshold met -> Completed; below threshold -> Failed plus `refund_issue` event.
- `apply-refund-results` implements authoritative refund completion. Only confirmed provider success can move ChargedSuccess/RecoveredCharge -> Refunded. Any non-success result refuses the transition.
- Worker queue infrastructure migrated: `worker-claim-outbox`, `worker-heartbeat-outbox`, `worker-finish-outbox`, OutboxDeadLetter, lease/reclaim, retry, exact deferred retry time and DLQ behavior.
- Worker defaults match C-ton: 60-second lease, `OUTBOX_POLL_MS` default 1000ms, `OUTBOX_MAX_ATTEMPTS` default 4. Retry delay follows the old helper formula.
- No Base44 function currently performs a real authorization, charge/capture, recovery, refund or release. Provider I/O is still deliberately absent.

## Checked

- Base44 frontend build: PASS.
- ESLint: PASS.
- esbuild parse/bundle: PASS for Draft, Publish, OTP request/verify, Join, public deal read, CloseJoining, PrepareCharging, StartCharging, outbox reconciliation, charge-result application, recovery-result application, Finalize, refund-result application and worker queue functions.
- Entity schema mirror gate: PASS for all mirrored Siton schema pairs.
- Live schema verification: Deal and SellerAccount `update`/`delete` are admin-only; OutboxEvent and PaymentAttempt are admin-only.
- Atomic inventory probe max=1: first reservation updated one Deal; second updated zero.
- Ceiling + idempotency probe: first reservation succeeded; same-key replay caused zero extra mutation; new key also caused zero mutation after inventory filled. Final state was one unit and one reservation.
- PendingTarget -> TargetReached conditional transition probe: PASS.
- Pre-money charging probe: ReadyForCharging -> Charging and embedded `charge_deal` happened in one conditional Deal mutation; a second transition attempt updated zero. Final Deal held exactly one charge event.
- Canonical C-ton charging/completion tests rechecked: mixed charge truth opens CompletionWindow and enqueues recovery/finalize; unknown truth stays Charging; finalize waits until expiry and uses `threshold_units` against captured/recovered quantity. Base44 logic follows those boundaries.
- Worker lease probe: Worker A claimed pending event; competing Worker B updated zero.
- Worker reclaim probe: expired lease returned processing event to pending; Worker C reclaimed it; attempt_count advanced from 1 to 2 rather than resetting.
- Attempted true simultaneous inventory race through `base44 exec`; CLI timed out and left the Deal unchanged. True concurrent last-unit proof is still NOT marked PASS.
- Full project `typecheck` remains red because of pre-existing Base44 template JSX/UI/Auth typing problems; build and lint remain green. Do not represent typecheck as PASS.

## Open

- Execute authoritative true-concurrency last-unit race against a deployed Base44 function/API surface.
- Connect real OTP delivery provider. Current provider remains log/migration and never exposes OTP code.
- Connect and verify canonical payment provider for authorization/capture/recovery/refund/release. Stripe is not connected in this Base44 session and no credentials were invented.
- Implement provider-I/O worker adapter plus UNKNOWN reconciliation/status lookup after Stripe is available.
- Wire Base44 Automation/CRON or Entity Hook to worker functions. Platform support exists in the CLI contract, but the current remote-sandbox tool surface exposes no reliable automation deployment action.
- Exercise Retry/DLQ functions through their deployed function surface once an automation/worker invocation surface is available.
- Implement seller profile-update function before exposing profile edits, because SellerAccount direct update is intentionally blocked.
- Resolve the runtime/compliance KYC inconsistency documented in PR #4 before production launch.
- Update root `PROJECT_STATUS.md` without truncating its existing large history when a safe patch surface is available.

## Progress

Initial Base44 migration path: 70%.

- Stage 0 bridge: complete.
- Stage 1 Draft: implemented and build-verified.
- Stage 2 Publish: implemented and build-verified.
- Stage 3 OTP + Join + atomic inventory: implemented; real OTP, real authorization and authoritative race proof remain open.
- Stage 4 public buyer surface: implemented and build-verified.
- Stage 5 pre-money charging boundary: implemented through Charging, canonical Outbox and deterministic charge-result application.
- Stage 6 Recovery, Finalize, Refund application and Worker lease/retry/DLQ foundation: implemented and build-verified. Real provider I/O remains disabled.

## Current Base44 checkpoint

`Stage 6 recovery finalize refund and worker lease foundation`

Checkpoint id: `6a7a20b35629a76a7fb1ee92`

Sandbox commit: `f325506fd4bb910756b91e9678db3af665b1658d`

## Next step

Connect or expose the external integration surfaces needed for real OTP and Stripe Sandbox, then attach Base44 Automation to the worker tick. Before any real money run, execute the true-concurrency last-unit test and UNKNOWN/retry/reconciliation tests against the deployed Base44 surface.
