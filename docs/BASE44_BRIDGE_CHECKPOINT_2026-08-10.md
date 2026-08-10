# Base44 Migration Checkpoint

Date: 2026-08-10
Branch: `base44-migration-spike`
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)

## Completed

- Stage 0 bridge completed without making the old Render deployment a dependency.
- Canonical C-ton `master` remains untouched and is used as specification, test oracle and rollback source.
- Draft creation migrated to Base44.
- Publish migrated with Draft -> PendingTarget, seller enforcement, 90% threshold, seller confirmations, audit evidence and idempotency evidence.
- Base44 schemas now cover Deal, SellerAccount, DealAudit, IdempotencyRecord, Participant, OtpChallenge, OtpDeliveryAttempt, OutboxEvent and PaymentAttempt.
- Base44 generates PascalCase and kebab-case mirror files for several entity schemas. A schema-drift defect was found and corrected; the mirror pairs are now intentionally kept identical and are checked by a build gate.
- Deal and SellerAccount mutation security was hardened. Sellers may read their own records, but direct `update`/`delete` is admin-only so state transitions, seller status and KYC cannot be bypassed through the frontend SDK.
- OTP request rail implemented: sms/email validation, masked destination, 10-minute TTL, five requests per 15-minute destination window, three attempts, no plaintext OTP storage or response. Provider remains log/migration pending external provider connection.
- OTP verification implemented with conditional consume, attempt counting, lockout and short-lived opaque proof token.
- Join contract implemented: OTP proof, payment-disclosure acceptance, multi-purchase by the same buyer, delivery snapshot, authorization reference, JoinedAuthorized/AuthHeld states, hold total, tracking token, affiliate attribution only and deterministic idempotency.
- Inventory reservation moved into the single Deal aggregate. `reserved_units`, reservation evidence and idempotency key change in one conditional Base44 update.
- Participant is a derived projection after the canonical Deal reservation, so a projection failure cannot oversell or erase an accepted Join.
- Conditional PendingTarget -> TargetReached implemented.
- Public buyer route `/deal/:dealId` implemented outside the login shell.
- `get-public-deal` exposes only safe public deal fields and does not expose buyer data, audit evidence or internal reservations.
- Buyer UI now shows price, inventory, threshold progress, deadline, delivery selection, OTP and explicit authorization-only payment disclosure. Join remains disabled until a real payment authorization rail is connected.
- TargetReached -> ClosedForJoining implemented with conditional idempotent transition.
- ClosedForJoining -> ReadyForCharging implemented. All JoinedAuthorized/AuthHeld reservations are locked to LockedIn/AuthLocked inside the canonical Deal aggregate; Participant rows are projections.
- ReadyForCharging -> Charging implemented by `start-charging`. The HTTP function performs no payment I/O. It changes buyer/money states to ChargingAttempt/ChargeAttempt and embeds exactly one pending `charge_deal` Outbox event in the same Deal update.
- `OutboxEvent` projection added for worker-oriented querying. The embedded Deal outbox event remains canonical.
- `reconcile-outbox-projections` added. It recreates a missing OutboxEvent projection from the canonical embedded event without any money side effect.
- `PaymentAttempt` schema added for provider-result evidence.
- `apply-charge-results` added as the deterministic post-provider boundary. It refuses unknown/temporary truth and leaves the deal in Charging. Final success/failure truth moves participants to ChargedSuccess or ChargeFailedCompletion, moves money to ChargedSuccess or ChargeFailedRecovery, opens one 24-hour Completion Window, creates `finalize_deal` for window expiry and creates immediate `recovery_deal` when failures exist.
- No Base44 function currently performs a real charge, capture, recovery, refund or release.

## Checked

- Base44 frontend build: PASS after seller and public buyer surfaces.
- ESLint: PASS.
- esbuild parse/bundle: PASS for `create-deal-draft`, `publish-deal`, `request-otp`, `verify-otp`, `join-deal`, `get-public-deal`, `close-joining`, `prepare-charging`, `start-charging`, `reconcile-outbox-projections` and `apply-charge-results`.
- Entity schema mirror gate: PASS for all existing mirrored Siton schema pairs.
- Entity schemas verified after additional sandbox commits: PASS; required Deal fields and hardened RLS remain present.
- Atomic inventory primitive probe with one available unit: first reservation updated one Deal; second reservation updated zero.
- Combined ceiling + idempotency probe: first reservation succeeded; replay using the same key produced zero additional mutation; a different key also produced zero mutation once inventory was full.
- Final inventory probe state contained exactly one unit and one reservation.
- Conditional PendingTarget -> TargetReached transition probe: PASS.
- Pre-money charging probe: ReadyForCharging -> Charging and the canonical embedded `charge_deal` event happened in one conditional Deal mutation; a second transition attempt updated zero rows. Final Deal state contained exactly one pending charge event.
- Canonical C-ton test contract rechecked: `charging.start` must create one charge outbox and perform no money; mixed final charge truth opens CompletionWindow and enqueues recovery/finalize; unknown provider truth must remain in Charging. Base44 implementation follows those boundaries.
- Attempted true simultaneous two-request inventory probe through `base44 exec`; the CLI timed out before returning a result and left the Deal unchanged. True race testing is therefore NOT marked PASS.
- Full project `typecheck` remains red because of pre-existing Base44 template JSX/UI/Auth typing problems; build and lint remain green. Do not represent typecheck as PASS.

## Open

- Execute an authoritative concurrent last-unit race test against a deployed Base44 function/API surface rather than the timing-out CLI path.
- Connect a real OTP delivery provider. Current provider intentionally remains log/migration and never exposes the OTP code.
- Connect and verify the canonical payment-provider authorization/capture/recovery rail. Stripe is not connected in this Base44 session and no credentials were invented.
- Implement Recovery and Finalize state application after the provider boundary, including 90% decision and refund scheduling.
- Implement refund/release behavior and UNKNOWN reconciliation before any real money test.
- Wire Base44 Automation/CRON or Entity Hook to the worker functions. Platform support exists in the CLI contract, but the current remote-sandbox tool surface does not expose a reliable automation deployment action, so this remains an integration blocker rather than a code guess.
- Add seller profile-update function before exposing profile editing, because direct SellerAccount mutation is intentionally blocked.
- Resolve the runtime/compliance KYC inconsistency documented in the PR before production launch.
- Update root `PROJECT_STATUS.md` without truncating its existing large history when a safe patch surface is available.

## Progress

Initial Base44 migration path: 60%.

- Stage 0 bridge: complete.
- Stage 1 Draft: implemented and build-verified.
- Stage 2 Publish: implemented and build-verified.
- Stage 3 OTP + Join + atomic inventory foundation: implemented; real OTP, real authorization and authoritative race proof remain open.
- Stage 4 public buyer surface: implemented and build-verified.
- Stage 5 pre-money charging boundary: implemented and build-verified through Charging, Outbox recovery and deterministic charge-result application. No real money executed.

## Current Base44 checkpoint

`Stage 5 pre-money charging outbox and completion-window boundary`

Checkpoint id: `6a7a1d39c0bf8b41b21c5966`

Sandbox commit: `45b4f2f2f450c39aadfcc67b7c48a71119da36d3`

## Next step

Implement deterministic Recovery and Finalize behavior from the canonical C-ton charging/completion-window tests, then update the worker boundary. Keep Stripe, OTP delivery and real money disabled until their external integrations are explicitly proven.
