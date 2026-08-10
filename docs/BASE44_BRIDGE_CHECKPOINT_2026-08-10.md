# Base44 Migration Checkpoint

Date: 2026-08-10
Branch: `base44-migration-spike`
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)

## Completed

- Stage 0 bridge completed without making the old Render deployment a dependency.
- Canonical C-ton `master` remains untouched and is used as specification, test oracle and rollback source.
- Draft creation migrated to Base44.
- Publish migrated to Base44 with Draft -> PendingTarget, seller enforcement, 90% threshold, seller confirmations, audit evidence and idempotency evidence.
- Canonical Base44 entity files established for Deal, SellerAccount, DealAudit, IdempotencyRecord, Participant, OtpChallenge and OtpDeliveryAttempt.
- A schema-drift defect caused by duplicate PascalCase/kebab-case entity files was found and fixed. One canonical file per entity now remains.
- OTP request rail implemented: sms/email validation, masked destination, 10-minute TTL, five requests per 15-minute destination window, three attempts, no plaintext OTP storage or response, provider remains log/migration pending external provider connection.
- OTP verification implemented with conditional consume, attempt counting, lockout and short-lived opaque proof token.
- Join contract implemented: OTP proof, payment-disclosure acceptance, multi-purchase by the same buyer, delivery snapshot, authorization reference, JoinedAuthorized/AuthHeld states, hold total, tracking token, affiliate attribution reference only, and deterministic idempotency handling.
- Inventory reservation was moved into the single Deal aggregate. `reserved_units`, reservation evidence and the idempotency key are changed in one conditional Base44 update.
- Participant is a derived projection after the canonical Deal reservation, so a crash after reservation cannot oversell or lose the accepted Join.
- TargetReached transition uses a conditional PendingTarget -> TargetReached update after the reservation, matching the old post-Join target check pattern.
- Test probe records were moved to owner `migration-probe-system` so they do not appear in the seller UI.

## Checked

- Base44 frontend build: PASS.
- ESLint: PASS.
- esbuild parse/bundle: PASS for `create-deal-draft`, `publish-deal`, `request-otp`, `verify-otp`, `join-deal`.
- Entity schemas verified after an additional sandbox commit: PASS; no schema regression after duplicate cleanup.
- Atomic inventory primitive probe with one available unit: first reservation updated one Deal; second reservation updated zero.
- Combined ceiling + idempotency probe: first reservation succeeded; replay using the same key produced zero additional mutation; a different key also produced zero mutation once inventory was full.
- Final stored probe state contained exactly one unit and one reservation.
- Conditional PendingTarget -> TargetReached transition probe: PASS.
- Attempted true simultaneous two-request probe through `base44 exec`; the CLI timed out before returning a result and left the Deal unchanged. True race testing is therefore NOT marked PASS.
- Full project `typecheck` remains red because of pre-existing Base44 template JSX/UI/Auth typing problems; build and lint remain green. Do not represent typecheck as PASS.

## Open

- Execute an authoritative concurrent race test against the deployed Base44 function/API rather than the timing-out CLI path.
- Connect a real OTP delivery provider; current provider intentionally remains log/migration and never exposes the OTP code.
- Connect and verify the canonical payment provider authorization flow; `join-deal` records an authorization reference but Stage 3 does not yet prove that reference against Stripe.
- Build the buyer-facing Deal/OTP/Join UI.
- Migrate close-joining, prepare-charging, charging Worker, Completion Window, reconciliation and refunds only after the Join/concurrency gate is proven.
- Update root `PROJECT_STATUS.md` without truncating its existing large history when a safe patch surface is available.

## Progress

Initial Base44 migration path: 40%.

- Stage 0 bridge: complete.
- Stage 1 Draft: implemented and build-verified.
- Stage 2 Publish: implemented and build-verified.
- Stage 3 OTP + Join + atomic inventory foundation: implemented; concurrency race proof and real authorization provider remain open.

## Current Base44 checkpoint

`Stage 3 Join OTP atomic inventory foundation`

Checkpoint id: `6a7a1526524b50117a46d600`

## Next step

Build the buyer-facing Base44 deal page and execute the Join flow through the deployed function surface. Then attack the last-unit race with concurrent requests. Do not begin real charging until that gate passes.
