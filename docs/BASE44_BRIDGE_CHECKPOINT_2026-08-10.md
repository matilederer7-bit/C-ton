# Base44 Migration Checkpoint

Date: 2026-08-11
Legacy branch: `base44-migration-spike`
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)

## Completed

- Base44-first migration remains isolated from canonical `master`; the legacy C-ton code is preserved as specification/test oracle/fallback.
- Draft creation/editing, Publish surface, seller profile, seller dashboard, KYC review, public buyer page and buyer tracking are migrated.
- OTP rail, charging/recovery/finalize worker foundations, Mission Control, Support, Forensics, fulfillment, distribution, notifications, analytics and emergency controls are present in Base44.
- True Base44 inventory concurrency testing proved Entity `updateMany` is not a hard last-unit lock. Production Join remains fail-closed.
- A narrow PostgreSQL reservation component remains isolated on `base44-reservation-service` / Draft PR #5. It owns only inventory ceiling and Reservation lifecycle, not the Siton backend.
- Reservation PostgreSQL CI passed a 200-request race on 20 units with exactly 20 winners plus replay, payload mismatch, expiry/renewal, Commit-vs-Release and serialized Close tests.
- Base44 `inventory-bridge` and the fail-closed Hold -> durable intent -> Commit -> reconcile Join Saga exist, but are not enabled in production.
- Seller fulfillment is limited to `Completed` Deals and participants whose buyer/money eligibility is final. Delivery PII is exposed only through ownership-checked seller Backend.
- Voucher/Ticket UX and fulfillment-unit status foundation are migrated. Full plaintext code issuance remains disabled.
- Invoice/receipt status projection is migrated, but issuance and financial snapshot creation remain disabled until provider/tax truth exists.
- Distribution is attribution-only. No distributor commission, payout, balance or settlement model exists.
- `DistributionEvent` provides anonymous analytics-grade click/visit events without buyer PII or device fingerprinting.
- Admin/Seller distribution analytics include clicks, visits, committed Join attribution, units, conversion and attributed gross measurement. Attributed gross is analytics only and creates no entitlement.
- BuyerTracking now performs silent 15-second polling while visible, shows participant count/refresh time and shares a clean Deal URL without tracking token or distributor ref.
- Deal image metadata and gallery are implemented with Draft-only attach/remove/reorder. Real Base44 UploadFile Runtime proof is blocked because the app is not deployed; the real endpoint returned HTTP 403 `reason=not_deployed`.
- Base44 app source is currently in Base44 internal S3 git, not GitHub. The required owner-driven 2-way GitHub connection is documented in `docs/BASE44_GITHUB_SYNC_REQUIRED.md`; do not overwrite the legacy C-ton repository.
- Constitution conflicts are explicitly recorded in `docs/BASE44_CONSTITUTION_CONFLICTS.md`; no AI agent may silently reconcile them.

## Stage 30: constitutional enforcement foundation

- Added a closed Base44 domain contract for DealState, BuyerState, MoneyState, the seven official Actions and canonical ErrorCodes.
- Added `scripts/base44-constitution-gate.mjs` to mechanically scan for:
  - P0.1 State mutations outside the Transition Engine.
  - P0.2 illegal Action/ErrorCode literals.
  - P0.3 Payment SDK imports outside workers.
  - P0.4 mutating Backend functions without an idempotency contract.
  - P0.5 the canonical 90% ceiling calculation.
- Added a supported Base44 `transition-engine` Backend function because Base44 functions cannot import shared modules from outside their own function folder.
- `publish-deal`, `close-joining`, `prepare-charging`, `start-charging`, `apply-charge-results`, `apply-recovery-results` and `finalize-deal` are now compatibility wrappers or route their State changes through the centralized Transition Engine.
- Transition Engine owns the authoritative Deal aggregate State + embedded transition journal write for migrated Actions.
- `deal.prepare_charging` now locks embedded Buyer/Money states in the same Deal aggregate write as `ClosedForJoining -> ReadyForCharging`.
- `charging.start` now performs `ReadyForCharging -> Charging`, embedded Buyer/Money lock-to-attempt transitions, embedded outbox creation and sets `completion_window_until` once at charging start.
- `apply-charge-results` no longer invents `charging.capture_success` / `charging.capture_failed`. Results are audited under canonical `charging.start`, and `Charging -> CompletionWindow` preserves the already-created 24-hour window.
- Recovery results use canonical `charging.recovery`, not success/failure aliases.
- Finalization uses canonical `charging.finalize`; 90% is computed from units in `ChargedSuccess` + `RecoveredCharge` only.
- On a successful Deal, a buyer who failed to recover is finalized to `Dropped/AuthReleased`, not incorrectly converted to DealFailed merely because that buyer failed.
- Refund result application is now fail-closed pending conflicts C-02/C-08.
- Seller cancellation is now fail-closed pending conflict C-01. The previous Stage 26 cancellation implementation must not be treated as production-complete.

## Checked

- Base44 frontend build after Stage 30: PASS.
- ESLint after Stage 30: PASS.
- Bundles PASS for: `transition-engine`, `publish-deal`, `close-joining`, `prepare-charging`, `start-charging`, `apply-charge-results`, `apply-recovery-results`, `finalize-deal`, fail-closed `apply-refund-results`, fail-closed `cancel-deal`.
- Stage 30 Constitution Gate: FAIL as expected, not hidden.
- Constitution findings reduced from 41 at the first measured run to 20 at the Stage 30 checkpoint.
- Current finding split:
  - P0.1 direct State mutation outside Transition Engine: 2.
  - P0.2 illegal Action literals: 6.
  - P0.4 mutating functions without idempotency contract: 12.
- The remaining two P0.1 findings are in `join-deal` / `reconcile-join-intents` around automatic `TargetReached`. Those files were actively changing under the parallel agent and were intentionally not overwritten.
- The remaining TargetReached action name is a real constitution conflict C-07: the required transition exists, but the seven-action closed list provides no legal audit Action for it.
- No active Payment SDK import was found in current source. Browser-provider SDK semantics remain conflict C-06 before real card UI can be activated.
- Full project typecheck remains red because of pre-existing Base44 template/UI/Auth typing. Do not represent typecheck as PASS.

## Constitution conflicts currently blocking silent completion

See `docs/BASE44_CONSTITUTION_CONFLICTS.md` for full evidence.

- C-01: `Cancelled` exists but no legal transition/Action into it.
- C-02: full-refund final BuyerState conflicts between DB contract and product spec.
- C-03: multiple purchases per buyer vs `UNIQUE(deal_id,user_id)` Participant contract.
- C-04: `max_units` optional vs mandatory.
- C-05: platform fee terminology must not reintroduce distributor commission.
- C-06: browser secure payment component vs literal Payment-SDK-only-in-workers rule.
- C-07: automatic `PendingTarget -> TargetReached` has no official audit Action.
- C-08: product permits refund after `RecoveredCharge`; Constitution Money table omits that transition.
- C-09: product requires pre-charge authorization releases that are not all explicit in the Constitution Money table.

## Open

- Resolve the constitution conflicts by a versioned owner decision; do not let an agent invent missing Actions/transitions.
- Remove the final two P0.1 State mutations once the parallel Join work stabilizes and C-07 is resolved.
- Add explicit idempotency contracts to the 12 remaining mutating Backend functions.
- Expand the constitution gate from current high-value static scans to full state/action/error literal enforcement and dedicated behavioral P0 tests.
- Implement the required UNKNOWN -> reconcile path and prove no visible state change plus 24-hour final resolution.
- Implement Retry Storm enforcement: maximum three payment attempts per participant/deal within 30 minutes.
- Prove Completion Window gates and late/duplicate webhook behavior against the centralized Transition Engine.
- Deploy/provision the narrow Reservation component plus PostgreSQL and configure protected Base44 secrets.
- Run Base44-to-reservation end-to-end races, response-loss and crash recovery before enabling Join.
- Connect real OTP delivery.
- Connect payment-provider Sandbox only after C-06 is resolved; then prove authorization, capture, recovery, release and refund.
- Wire supported Base44 Automation/CRON or Entity Hook for worker ticks.
- Keep Voucher/Ticket full-code issuance disabled until one-time delivery is crash/replay safe without plaintext at rest.
- Keep notification delivery and invoice issuance disabled until real providers are connected and idempotency/retry is proven.
- Deploy the Base44 app only to an explicitly safe non-production target before repeating UploadFile Runtime proof.
- Initial Base44-to-GitHub connection still requires the app owner in Base44 Dashboard; current Base44 commits live in internal S3 git.
- Root `PROJECT_STATUS.md` still needs a safe non-truncating update path; this migration checkpoint is the current safe status record.

## Progress

Product/surface migration estimate: approximately 92%.

Production/constitutional readiness: NOT PASSED. Stage 30 P0 gate has 20 open findings plus explicit source conflicts.

The percentage measures migrated product scope, not production safety. Join, refunds, cancellation and real money remain disabled or fail-closed where proof/constitution is incomplete.

## Milestones

- Stages 0-25: Base44 product/control-plane migration foundation complete as previously recorded.
- Stage 26 Seller cancellation: implementation replaced with fail-closed behavior pending C-01.
- Stage 27 Deal images/gallery: code complete; Runtime UploadFile proof blocked by app not deployed.
- Stage 28 Distribution measurement Backend: complete. Public click/visit wiring must be re-verified because parallel edits repeatedly replaced `PublicDeal.jsx`; do not claim Runtime wiring until stable.
- Stage 29 BuyerTracking live polling and clean sharing: complete and gate-verified.
- Stage 30 Centralized Transition Engine and Constitution Gate: foundation complete; P0 gate intentionally still red.

## Current Base44 checkpoint

`Stage 30 centralized transition engine and constitution gate`

Checkpoint id: `6a7b091bd9b206c50554cb5c`

Sandbox commit: `3ce93bc6bf7cd2838b340d5c1d7885908c364445`

## Next step

Continue P0 reduction without colliding with the active Join agent: add idempotency contracts to stable mutating functions, then return to Join/TargetReached only after the parallel file activity stops and C-07 has an explicit constitutional resolution. Do not enable real money or Join merely to make the demo appear complete.
