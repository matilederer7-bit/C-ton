# PROJECT STATUS

## Current milestone: Stage 30A - canonical TargetReached and atomic Audit closure

Date: 2026-08-12
Base44 app: ראש גשר

## Completed

- Added the versioned constitutional Action `deal.target_reached` for the system-only `PendingTarget` to `TargetReached` transition.
- TargetReached now requires the full published `min_units`; the 90% rule remains a later financial success threshold and is not used for this state transition.
- Only committed Reservations count. Holds, released, expired and failed outcomes do not.
- Removed the two direct TargetReached mutations from Join and reconciliation. Both now invoke the central Transition Engine with a deterministic idempotency key and an internal secret.
- Publish synchronizes immutable `max_units` and `min_units` into the narrow PostgreSQL reservation boundary.
- PostgreSQL Commit now performs the committed counter update, Deal state transition and append-only `deal.target_reached` Audit insert in one transaction.
- Base44 refuses to project TargetReached unless the authoritative PostgreSQL result already reports `TargetReached` at or above the full minimum.
- Added Addendum v1.5 and marked conflict C-02 resolved.
- Reconciled the strict idempotency scanner with Base44 read-only POST transport. Its 16 P0.4 false positives are gone.
- Documented new conflict C-12 instead of silently legalizing `participant.join_authorize`.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- Full typecheck: PASS.
- Transition Engine, inventory bridge, Join and reconciliation bundles: PASS.
- Canonical Constitution checker: PASS with no failures.
- P0.1 TargetReached centralization, full-minimum gate and internal authentication: PASS.
- GitHub PostgreSQL proof commit: `0085870546b02625112c7a768734843af5dd7f0c`.
- GitHub Actions run 28, id `31586253146`: PASS.
- 20 concurrent threshold-crossing Commits create one TargetReached transition and one Audit row: PASS.
- Forced Audit insertion failure rolls back Reservation status, committed counter and Deal state: PASS.
- Audit UPDATE and DELETE rejection: PASS.
- Strict Constitution gate reduced from 26 findings to 5. All five are the same C-12 `P0.2_ACTION` decision.

## Open

- C-12: `participant.join_authorize` changes Buyer and Money state but is not in the versioned closed Action list. It requires an owner decision before the strict gate can be green.
- P0.11 code-level PostgreSQL atomicity proof is green, but the managed PostgreSQL path is not connected to Base44 and has no live runtime evidence.
- `TRANSITION_INTERNAL_CALL_SECRET`, reservation service URL/database/shared secret and Join enable flags are not configured. Join remains fail-closed.
- P0.7 still requires a live two-worker payment race after a provider Sandbox exists.
- C-08 HTTP-method wording and the remaining payment, payout, invoice, OTP and communication provider proofs remain open.
- No production service, real Join or money path was enabled.

## Progress

Overall Siton-to-Base44 code migration: 98%.
Initial technical migration path: 99%.
Reservation and target-transition code proof: 99%.
Production readiness: not honestly measurable yet; the product is not production-ready.

## Checkpoint

Checkpoint name: `Stage 30A verified code and CI`
Checkpoint id: `6a7c477d08b342b08c16d542`
Sandbox commit: `321c419e5b64545fa75b6617059534007df7fda1`

GitHub reservation Draft PR: `https://github.com/matilederer7-bit/C-ton/pull/5`
GitHub proof commit: `https://github.com/matilederer7-bit/C-ton/commit/0085870546b02625112c7a768734843af5dd7f0c`
GitHub Actions proof: `https://github.com/matilederer7-bit/C-ton/actions/runs/31586253146`

## Next step

Obtain the owner decision for C-12. Recommended: add `participant.join_authorize` as the ninth official Action because it performs canonical Buyer and Money transitions. Keep Join disabled while connecting and repeatedly proving the managed PostgreSQL path.

## Previous milestone

## Current milestone: Stage 27A - full frontend typecheck baseline closure

Date: 2026-08-12
Base44 app: ראש גשר

## Completed

- Closed the previously failing full JavaScript and JSX TypeScript check without disabling `checkJs` or excluding product pages.
- Added explicit declaration contracts for the shared Button, Card, Input, Label, Progress, Select, Textarea, OTP, Badge and AuthLayout components.
- Added the Vite client environment types required by `import.meta.env`.
- Replaced the server-side Map shortcut in `app-params` with a Web Storage-compatible in-memory adapter.
- Marked genuinely optional presentation props as optional in Admin Overview, System Status and Seller Deal Detail.
- Aligned Seller Deal image upload with the documented Base44 SDK `file_url` result.
- Added explicit typed HTTP header maps to the OAuth consent flow.
- No Constitution files, transition logic, money logic, fee rules or distributor financial rules were changed.
- Saved a pre-work restore point and a post-code checkpoint.
- Created a complete one-way GitHub snapshot on Draft PR #4 branch `base44-migration-spike` without touching or merging `master`.
- Snapshot commit `e90449964809233749c75747b0c115fe69242633` contains a 253-file Base44 archive, the status document, tracked-file manifest and SHA-256 verification.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- Full `npm run typecheck`: PASS.
- Canonical `check-base44-constitution.mjs`: expected RED only at the two known C-02/P0.1 TargetReached mutations; P0.2, P0.3, P0.4, P0.5, P0.7, P0.8/P0.9 and P0.10 remain PASS.
- The stricter `base44-constitution-gate.mjs` currently reports 26 findings across P0.1, P0.2_ACTION and P0.4. This conflicts with the canonical checker and is owned by the parallel Stage 30 constitution/enforcement work. This stage does not claim the Constitution gate is green.
- Sandbox working tree after Base44 auto-commit: clean.
- GitHub Base44 migration bridge gate: PASS.
- GitHub Web runtime depth gates: PASS.
- GitHub Backend and deployment quality gates: PASS.

## Open

- Stage 30 must reconcile the two Constitution scanners and determine which additional findings are real enforcement gaps versus scanner false positives.
- C-02/P0.1 TargetReached transition conflict remains unresolved.
- P0.11 remains blocked on a managed PostgreSQL State plus Audit transaction proof.
- Base44 runtime code storage remains internal S3. A verified one-way recovery snapshot now exists in GitHub PR #4, but a live two-way GitHub remote is still not connected to the app.
- Real invoice, payment, payout, OTP and external communication provider proofs remain open.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 98%.
Frontend static verification baseline: build, lint and full typecheck are green.
Production readiness: still blocked by Constitution/source-contract items, managed PostgreSQL proof and external provider proofs.

## Checkpoint

Checkpoint name: `Stage 27A - full frontend typecheck green`
Checkpoint id: `6a7c352e1992d1e59fc482b2`
Sandbox commit: `450516bb901e4c5f69d9de2198069791b16c1a7d`

GitHub snapshot commit: `e90449964809233749c75747b0c115fe69242633`
GitHub draft PR: `https://github.com/matilederer7-bit/C-ton/pull/4`
Snapshot SHA-256: `819cd064aefbbc5e41e7953db6b2b6962659128dd281353194cfc4fa84a9d607`

## Next step

Let Stage 30 finish the Constitution/enforcement scope without parallel edits to its owned files. Then reconcile the canonical and strict gates, keep Join fail-closed, and proceed to the managed PostgreSQL State plus Audit proof.

## Previous milestone

## Current milestone: Stage 27 - seller terminal-deal UX and fulfillment operations alignment

Date: 2026-08-12
Base44 app: ראש גשר

## Completed

- Seller Deal Detail now has two distinct UX modes: live Deal and terminal Deal. Completed/Failed/Cancelled no longer reuse the live operational surface.
- Terminal header shows Deal identity, primary image when available, clear terminal status and closed timestamp.
- Completed terminal summary now shows final units, initial successful units, recovered units and excluded units, with a simple supporting pie visualization.
- Completed financial summary is sourced only from canonical Money Ledger fields: gross collected, Siton platform fee total and seller net payable. Distributor attribution remains non-financial.
- Failed terminal Deals show deterministic failure reason and actual collected/refunded amounts when present; no seller money execution controls were introduced.
- Receipts remain limited to financially eligible buyers and visibly fail-closed until a real invoice provider and authoritative financial/VAT snapshot are connected.
- Fulfillment remains available only for Completed Deals and financially eligible buyers.
- Shipping export is now a visible Excel download using dependency-free SpreadsheetML/XLS output; no vulnerable spreadsheet package was retained.
- Fulfillment UI no longer exposes `money_state_at_eligibility` or Audit counters to sellers.
- Added copy-full-address and WhatsApp/Email deep links for fulfillment operations without adding seller-triggered server messaging.
- Shipping issue note is limited to 200 characters in both UI and backend validation.
- Added `צור עסקה דומה`: product/commercial terms are prefilled client-side, but the old deadline is deliberately not copied. Seller must select a new deadline before creating the new Draft; no old Deal is reopened.
- Added C-10: Seller UX requests `support.shipping_issue` in canonical `audit_log`, conflicting with the Constitution's closed seven-Action list. Shipping history remains a separate operational event journal until versioned resolution.
- Added C-11: current sources conflict on seller refund authority. Seller Refund/Capture/Void remain fail-closed until authority and C-03 are versioned and resolved.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- `seller-deal-detail` bundle/parse: PASS.
- `seller-fulfillment` bundle/parse: PASS.
- No direct `xlsx` or `exceljs` dependency remains: PASS.
- Fulfillment seller UI contains no Money State or Audit technical labels: PASS.
- Visible Excel shipping export exists: PASS.
- Clone flow resets deadline instead of copying the old one: PASS.
- Seller terminal/fulfillment UI contains no manual Refund/Capture/Void controls: PASS.
- Constitution gate unchanged: exactly the two known C-02/P0.1 TargetReached mutations remain.
- P0.2, P0.3, P0.4, P0.5, P0.7 structural, P0.8/P0.9 structural and P0.10 remain PASS.
- Sandbox git working tree after auto-commit: clean.

## Open

- C-02/P0.1 TargetReached transition conflict remains unresolved.
- P0.11 remains blocked on managed PostgreSQL State+Audit proof.
- C-10 blocks declaring fulfillment operational events canonical Audit until a legal non-State audit contract or new Action version exists.
- C-11/C-03 keep seller refund execution fail-closed.
- Fulfillment bulk status update and controlled undo are still open; canonical Audit requirements must be resolved before claiming full UX compliance.
- Real invoice, payment, payout and external communication provider proofs remain open.
- Receipt batch issuance/retry remains blocked until invoice provider integration exists.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 98%.
Production readiness: still blocked by unresolved P0/source-contract items and external provider proofs.

## Next step

Continue with the remaining non-conflicting terminal operations and admin/product polish. Do not implement seller refunds or canonical fulfillment Audit aliases until C-10/C-11/C-03 are resolved. Keep C-02/P0.1 and P0.11 visibly red.

## Previous milestone

## Current milestone: Stage 26 - seller live-deal and multi-deal dashboard UX alignment

Date: 2026-08-12
Base44 app: ראש גשר

## Completed

- Seller multi-deal dashboard progress now uses `min_units`, not the 90% financial threshold.
- Added seller-facing `volume_amount` projection: active/failed Deals use authorization-volume snapshot; Completed uses canonical Money Ledger gross.
- Failed Deal cards show the lost volume with strike-through and a clear failure reason when final charged units are below the financial threshold.
- Dashboard keeps Charging and CompletionWindow Deals at the top, sorted by nearest end time, with sub-hour urgency copy.
- Seller Deal Detail now receives a clean business summary: final units, pending units, failed units, volume amount, minimum, financial threshold and current financial-threshold outcome.
- Seller live-deal screen no longer exposes Deal IDs, raw Buyer States, raw Money States or transition history.
- Seller live-deal screen now shows volume, final charged units, pending/risk units, failed units, countdown and a deterministic “what happens now” message.
- Progress on Seller Deal Detail now uses the published minimum.
- `close joining` CTA is exposed only in TargetReached and calls the canonical `close-joining` action with idempotency. It is intentionally not exposed in PendingTarget because the current Constitution has no legal PendingTarget -> ClosedForJoining transition.
- Distribution data remains attribution-only and explicitly states there is no distributor financial component.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- `seller-deals` and `seller-deal-detail` bundle/parse: PASS.
- Seller dashboard progress denominator is `min_units`: PASS.
- Seller volume projection exists in both dashboard and detail APIs: PASS.
- Live seller UI contains no Buyer States, Money States or transition-history panels: PASS.
- Close Joining CTA is TargetReached-only: PASS.
- Constitution gate unchanged: exactly the two known C-02/P0.1 TargetReached mutations remain.
- P0.2, P0.3, P0.4, P0.5, P0.7 structural, P0.8/P0.9 structural and P0.10 remain PASS.

## Open

- C-02/P0.1 TargetReached transition conflict remains unresolved.
- P0.11 remains blocked on managed PostgreSQL State+Audit proof.
- Live payment, payout and external communication provider proofs remain open.
- Seller terminal Deal UX still needs final alignment for Completed/Failed/Cancelled, receipts, fulfillment summaries and clone-deal flow.
- Export/shipping operational polish remains open.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 97%.
Production readiness: blocked by unresolved P0/source-contract items and external provider proofs.

## Next step

Align terminal Seller Deal UX for Completed/Failed/Cancelled without opening any manual money operations. Reuse existing receipts/fulfillment/payout rails and keep refunds/capture/void fail-closed.

## Previous milestone

## Current milestone: Stage 25 - public realtime deal UX, buyer tracking alignment and public comments

Date: 2026-08-12
Base44 app: ראש גשר

## Completed

- Public Deal progress bar now represents current committed/reserved units against `min_units`, matching buyer UX. The canonical 90% financial success threshold remains separate and is not presented as the public sales goal.
- Added `remaining_to_minimum` and explicit PendingTarget/TargetReached buyer-facing guidance without changing the unresolved constitutional TargetReached transition logic.
- Added lightweight live FOMO on the public Deal page: when polling observes new purchases, a short aggregate-only notification appears. No buyer identity is exposed.
- Public sold-out state now explicitly says inventory is sold out / sale ended.
- Failed deals are no longer exposed as active public Deal pages; personal Buyer Tracking continues to show Failed truth to the participant.
- Buyer Tracking progress now uses `min_units` rather than `threshold_units`.
- Completion Window recovery UX is shown only to a participant in `ChargeFailedCompletion` while the Deal is in CompletionWindow. It includes a countdown and payment-update CTA that remains disabled until real money is enabled.
- Added public Deal comments/chat with 15-second polling, 50 recent visible comments, 500-character messages and 80-character display names.
- Deal comments are not directly public through entity RLS. Public list/post operations go through `deal-comments`.
- Comment POST requires an idempotency key and a browser session token. Rate limit: max 5 comments per Deal/session in 10 minutes.
- Comments remain supportive UX only and never participate in State, money or Deal truth.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- `get-public-deal`, `get-buyer-tracking`, `deal-comments` bundle/parse: PASS.
- Public progress denominator is `min_units`: PASS.
- Buyer Tracking progress denominator is `min_units`: PASS.
- Aggregate FOMO reacts only to purchase-count increase: PASS.
- Sold-out buyer copy exists: PASS.
- Failed public Deal state excluded: PASS.
- Completion recovery card requires both `ChargeFailedCompletion` and Deal `CompletionWindow`: PASS.
- DealComment live schema exists with admin-only direct RLS: PASS.
- Comment endpoint requires idempotency and enforces 5 per 10 minutes per Deal/session: PASS.
- Constitution gate: unchanged known RED only at the two C-02/P0.1 TargetReached mutations. No new P0 failures introduced.
- P0.2, P0.3, P0.4, P0.5, P0.7 structural, P0.8/P0.9 structural and P0.10 remain PASS.

## Open

- C-02/P0.1 TargetReached transition remains unresolved because the closed Action list has no legal Action for PendingTarget -> TargetReached.
- P0.11 remains blocked on canonical PostgreSQL State+Audit transaction proof.
- Live payment, payout and external communication providers remain unconnected.
- Public comments currently have admin-hide capability only at entity level; a dedicated moderation UI can be added later if operationally required.
- Continue seller live-deal/dashboard UX alignment and remaining product polish.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 96%.
Production readiness: blocked by unresolved P0/source-contract items and external provider proofs.

## Next step

Align Seller live-deal and multi-deal dashboard UX with the approved Seller UX without touching C-02/P0.1 or P0.11. Preserve the existing fail-closed provider gates.

## Previous milestone

## Current milestone: Stage 24 - crash-safe Join derived projections and notification recovery

Date: 2026-08-12
Base44 app: ראש גשר

## Completed

- Added provider-neutral communication delivery adapter for SMS/email using HTTPS, HMAC request signing, provider idempotency keys, 8-second timeout, and explicit success/permanent_fail/temporary_fail/unknown classification.
- Real communication provider remains disabled until runtime URL and shared secrets are configured. Disabled mode never pretends a message was sent.
- OTP delivery now routes through the communication adapter when configured. The plaintext OTP exists only in request memory, is never stored, never returned, and is not logged.
- OTP delivery attempts are append-only and support UNKNOWN. If a configured provider outcome is not confirmed, the challenge is cancelled and a new OTP is required.
- Added Notification Worker with claim semantics, idempotent provider key reuse, retry/backoff, permanent failure handling, UNKNOWN handling, and provider-disabled rescheduling.
- Notification attempts are append-only and support UNKNOWN.
- Product events now enqueue idempotent buyer/seller notifications for Join, successful charge, successful Recovery, final Completed/Failed, Shipped and Delivered.
- Notification delivery is deliberately decoupled from business state changes; provider failure cannot roll back a valid business transition.
- Hardened Join crash recovery: a committed reservation remains represented by a pending Join intent until Participant projection, attribution when applicable, IdempotencyRecord, and buyer Join notification all exist.
- Join retry detects an already-projected reservation and completes any missing derived projections before returning replay.
- Pending Join cleanup is verified after the derived projections exist. Failure to clear remains a retryable 503 rather than silently losing recovery state.
- `reconcile-join-intents` replays committed reservations through the same Join path, so notification and derived projection recovery use the same idempotent logic.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- Bundles: communication-delivery, request-otp, verify-otp, deliver-notifications, join-deal, reconcile-join-intents, transition-engine, seller-fulfillment, admin-notifications: PASS.
- Join contains exactly one pending Join cleanup location and it executes after Participant, attribution, idempotency and notification projection: PASS.
- Join verifies pending cleanup and returns retryable failure if cleanup did not persist: PASS.
- Reconciliation reuses `join-deal` for committed reservation replay: PASS.
- Notification idempotency key is deterministic by event, source key and channel: PASS.
- No `otp_code`, plaintext code field or OTP code logging exists in OTP/communication functions: PASS.
- Communication adapter signs requests with `x-siton-signature`: PASS.
- Non-local communication provider URL must use HTTPS: PASS.
- NotificationAttempt and OtpDeliveryAttempt live schemas support UNKNOWN and remain append-only: PASS.
- Central product notification events are wired into real business flows rather than an empty queue: PASS.

## Open

- Connect a real SMS/email provider and configure `COMMUNICATION_PROVIDER_URL`, provider shared secret, internal call secret and provider mode.
- Add/enable Base44 scheduled Automation for the Notification Worker after runtime secrets are configured.
- Execute live OTP and notification Sandbox tests against the selected provider.
- Add exact approved message templates/content before external delivery is enabled.
- PostgreSQL reservation endpoint, real payment provider and real payout provider are still external blockers.
- Continue remaining realtime buyer UX/FOMO/chat and final product-surface gaps.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 95%.
Production readiness: blocked by unresolved P0/source-contract items; percentages do not imply production readiness.

## Next step

Continue only on non-conflicting work: close public deal realtime UX and buyer tracking consistency while P0.1/C-02 and P0.11 remain visibly blocked. Keep Join, payment, payout and external communication fail-closed until their live provider proofs exist.

## Previous milestone

## Current milestone: Stage 23 - Constitution enforcement pass 2 and concurrent Action idempotency proof

Date: 2026-08-11
Base44 app: ראש גשר

## Completed

- P0.10 Completion Window logic moved into shared Constitution helpers and wired into the Transition Engine.
- `charging.start` inside CompletionWindow now returns constitutional `FORBIDDEN_ACTION`.
- `charging.recovery` with no eligible `ChargeFailedCompletion` participant now returns `FORBIDDEN_ACTION` instead of a successful no-op.
- Finalize eligibility and success/failure resolution use shared Constitution helpers.
- P0.4 mutating product wrappers are explicitly checked for idempotency. Read-only Base44 POST transport remains documented as C-08 rather than silently reclassified.
- Hardened P0.2 enforcement: all backend system error codes now use the closed `ErrorCode` contract. 56 legacy auth/JSON codes plus remaining seller/draft/image codes were migrated.
- Reservation Service `sync` and `close` now require the same constitutional Action idempotency key passed by Base44.
- Reservation Service stores canonical Action responses and rejects same-key/different-payload reuse.
- PostgreSQL advisory locks serialize the same `operation + deal + idempotency_key` across concurrent service instances.
- Added PostgreSQL integration proof for concurrent Deal-level Action idempotency.
- Updated Draft PR #5 with the latest P0.6 proof and run 27 results.
- Added C-09 documenting the unresolved conflict between 3 retries→DLQ, 3 immediate retries→delayed reconcile, and PostgreSQL Outbox default max_attempts=10.

## Checked

- Base44 frontend build: PASS.
- Base44 ESLint: PASS.
- Permanent Constitution gate: P0.2 PASS.
- Permanent Constitution gate: P0.3 PASS.
- Permanent Constitution gate: P0.4 PASS for mutating product endpoints.
- Permanent Constitution gate: P0.5 PASS.
- P0.6 PostgreSQL concurrent same-key Action idempotency: PASS in GitHub Actions run 27 (`31505189365`).
- 20 concurrent `sync` calls: executor ran exactly once; all callers received semantically identical canonical result.
- 20 concurrent `close` calls: executor ran exactly once.
- Same Action key with different payload: rejected.
- Existing reservation concurrency, Close and Saga recovery suites still PASS in run 27.
- Permanent Constitution gate: P0.7 structural PASS.
- Permanent Constitution gate: P0.8/P0.9 structural PASS.
- P0.10 mandatory cases: PASS: charging.start in CompletionWindow forbidden; recovery without eligible participant forbidden; finalize before expiry WINDOW_NOT_EXPIRED; finalize below threshold after expiry Failed.
- Base44 Constitution gate now fails only the two known P0.1 `TargetReached` mutations.

## Open

- P0.1 / C-02 remains unresolved: `PendingTarget -> TargetReached` is required, but no legal Action exists in the closed Action list / audit CHECK. Exactly two non-Engine migration mutations remain and keep the gate red.
- P0.11 remains blocked until managed PostgreSQL State+Audit transactions are connected and proven from Base44.
- P0.7 still needs a live two-worker payment-attempt race proof after payment Sandbox/worker exists.
- Real Payment Webhook rail is not implemented. Duplicate/Late Webhook behavior must remain fail-closed until a concrete provider adapter is selected and signature verification is implemented.
- P1.1/DLQ retry timing remains blocked by source conflict C-09.
- Existing C-03 through C-08 source conflicts remain open.
- Real Stripe/payment provider, notification provider, payout provider and managed PostgreSQL endpoint remain unconnected.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 95%.
Reservation critical-section extraction and CI proof: 99%.
Production readiness: blocked by unresolved P0/source-contract items; percentages do not imply production readiness.

## Next step

Continue only on non-conflicting work: harden immutable/audit/DLQ projections where source behavior is unambiguous, then resume realtime buyer/seller UX. Keep P0.1 and P0.11 visibly red until a versioned constitutional decision and managed PostgreSQL proof resolve them.

## Previous milestone

## Current milestone: Stage 22 - Constitution enforcement pass 1

Date: 2026-08-11
Base44 app: ראש גשר

## Completed

- Added one shared Constitution source at `base44/shared/constitution.ts` for all closed DealState, BuyerState, MoneyState, Action and ErrorCode values.
- Transition Engine contract now re-exports the shared Constitution instead of maintaining a second copy.
- Removed backend State literals outside the Constitution source.
- Removed backend Action and system ErrorCode literals outside the Constitution source. Human-readable error text remains detailed while system `code` is restricted to the nine constitutional ErrorCode values.
- Added permanent `scripts/check-base44-constitution.mjs` enforcement gate. It intentionally fails while known P0 violations remain.
- Added a dated Constitution conflict register at `docs/CONSTITUTION_CONFLICTS_2026-08-11.md`; source conflicts are recorded instead of silently interpreted.
- Proved the five mandatory 90% ceiling cases.
- Added `PaymentReconcileJob` and an embedded Deal reconcile journal for provider UNKNOWN outcomes. UNKNOWN no longer disappears: it records attempts, schedules reconciliation and does not change visible State.
- Added the 24-hour UNKNOWN resolution worker. Timeout reconciliation uses `attempt_type=reconcile` and does not perform a new payment side effect.
- Added a per-Participant/per-Deal payment attempt guard: maximum 3 attempt slots in 30 minutes; a fourth slot returns `FORBIDDEN_ACTION`; duplicate idempotency keys replay without increment.
- Charge and Recovery result application now require valid attempt-guard evidence unless the call is timeout reconciliation.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- Backend State literals outside the shared Constitution: 0.
- Backend Action/ErrorCode literals outside the shared Constitution: 0.
- Non-canonical lowercase system `code:` values in backend functions: 0.
- P0.3 payment SDK import boundary static scan: PASS.
- P0.5 mandatory 90% ceiling cases: PASS.
- P0.7 retry-storm structural enforcement: PASS. Live two-worker race proof is still open.
- P0.8 UNKNOWN creates Reconcile Job and does not change visible State: structural PASS.
- P0.9 24-hour timeout resolution path exists through `attempt_type=reconcile`: structural PASS.
- Live Participant schema contains payment retry guard fields: PASS.
- Live PaymentReconcileJob schema exists: PASS.
- Constitution gate intentionally FAILS P0.1 at exactly two known non-Engine `TargetReached` mutations.

## Open

- P0.1 / C-02: `PendingTarget -> TargetReached` is required by the transition table, but the closed Action list has no legal Action for it. Two migration paths still mutate it outside the Transition Engine. Do not invent an eighth Action.
- P0.11: canonical PostgreSQL State+Audit atomic transaction proof is not available because managed PostgreSQL is not connected. Supabase connector remains disconnected.
- P0.7: run real concurrent-worker integration proof after payment worker/provider Sandbox exists.
- C-03: refund is a legal Action but canonical Outbox/PaymentAttempt contracts do not define a refund job/attempt representation.
- C-04: Cancelled is a legal DealState but the closed transition/action tables do not provide a legal cancellation transition. Cancellation remains fail-closed.
- C-05/C-06: repeat-purchase and buyer-cancellation product requirements conflict with canonical Participant/BuyerState contracts.
- C-07: migration Outbox event names/statuses differ from the canonical PostgreSQL contract.
- C-08: P0.4 wording says all POST/PUT/DELETE need idempotency while Base44 uses POST for read-only function transport; mutating Actions must remain idempotent pending versioned clarification.
- Real Stripe/payment webhooks, payout provider, notification provider and managed PostgreSQL remain unconnected.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 93%.
Production readiness: blocked by unresolved P0/source-contract items; percentages do not imply production readiness.

## Next step

Continue Constitution-first enforcement: verify and close non-conflicting P0.10 Completion Window rules and mutating-action P0.4 idempotency. Keep the permanent gate failing on unresolved P0.1/P0.11 rather than weakening it.

## Previous milestone

## Current milestone: Stage 21 - provider-neutral notifications and OTP delivery rail

Date: 2026-08-11
Base44 app: ראש גשר

## Completed

- Added provider-neutral communication adapter for SMS/email with HTTPS enforcement, HMAC request signing, provider idempotency key and explicit `success|temporary_fail|permanent_fail|unknown|skipped` result classes.
- Provider defaults to disabled. No real external message can be sent without explicit environment configuration.
- OTP delivery now uses the communication adapter while the plaintext OTP exists only in request memory; it is never stored, logged or returned.
- OTP delivery attempts are append-only. Unconfirmed real delivery cancels the challenge so an uncertain code cannot remain valid.
- Added notification worker with conditional claim, retry/backoff, provider idempotency and append-only attempts.
- Product events now enqueue idempotent notifications for Join, successful charge, successful recovery, deal Completed/Failed, seller final result, Shipped and Delivered.
- Notification delivery is asynchronous and does not determine product State.
- Hardened Join crash recovery: canonical reservation remains recoverable until Participant, attribution, idempotency record and Join notification projections are complete. Pending Join intent is removed only after those derived projections succeed.
- Replay of an already committed Join completes missing derived projections before returning the original idempotent response.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- Communication, OTP, notification worker, Join, Join reconcile, transition engine, fulfillment and admin notification functions bundle/parse: PASS.
- Communication provider disabled by default: PASS.
- HMAC signature and HTTPS gate present: PASS.
- NotificationAttempt and OtpDeliveryAttempt are append-only: PASS.
- Static scan found no OTP plaintext logging or OTP-code response field: PASS.
- Join crash-boundary ordering proof: PASS.
- Exactly one pending Join cleanup site remains, inside `finishJoinDerived`: PASS.
- Participant, Join idempotency and Notification projections fail closed before pending intent cleanup: PASS.
- All core product notification event families are wired to the queue: PASS.

## Open

- Configure a real SMS/email provider endpoint and shared secrets, then run live Sandbox delivery proof.
- Configure `NOTIFICATION_WORKER_INTERNAL_SECRET` and schedule the notification worker through a Base44 Automation or equivalent supported trigger.
- Connect Stripe/payment Sandbox before any real authorization/capture/recovery/refund.
- Connect managed PostgreSQL before enabling the external reservation path.
- Connect payout provider before any external seller transfer.
- Run full Constitution enforcement scan against the migrated Base44 code before expanding realtime UX.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 91%.
Production readiness: not implied by these percentages.

## Next step

Run a Constitution-first P0/P1/P2 enforcement audit against the migrated Base44 implementation. Fix P0 violations before adding realtime/FOMO/chat UX.

## Previous milestone

## Current milestone: Stage 20 - canonical money ledger and seller payouts internal truth

Date: 2026-08-11
Base44 app: ראש גשר

## Completed

- Added canonical `money_ledger_events` inside each Deal. Charge and Recovery final provider outcomes write Money State and Money Ledger in the same Deal mutation.
- Added append-only `MoneyLedgerEvent` projection for search/reporting. Projection is derived; the embedded Deal ledger remains canonical.
- Canonical financial event types imported: `charge_captured`, `recovery_captured`, `refund_issued`. Refund support is represented in the ledger contract but the current refund execution path remains fail-closed under the existing Constitution conflict.
- Siton platform fee formula is centralized: 8% of collected gross including delivery, with VAT applied to Siton's fee. Distributor commission remains zero and never enters settlement math.
- `SITON_PLATFORM_FEE_VAT_RATE` is runtime-configurable with canonical fallback 0.18. Invalid values fail closed.
- Added Seller `settlement_status` (`active|review|hold`) independent from KYC and seller enforcement status. Admin changes require a reason and are journaled.
- Added `SellerSettlement` and `SellerPayoutBatch` with canonical lifecycle statuses: pending, ready, batched, processing, paid, failed, returned, reconciled.
- Settlement eligibility uses only Deal `money_ledger_events`, Deal Completed state, active seller settlement status, absence of payout freeze, positive gross/net, and duplicate/inflight payout guards.
- Batch key is deterministic from seller plus sorted settlement ids so retry cannot create a second logical payout batch.
- Admin Payout UI exists at `/admin/payouts`; Seller Payout UI exists at `/seller/payouts`.
- Internal batching is enabled. External Dispatch and Retry remain hard-blocked with `payout_provider_not_connected`; no bank transfer can execute.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- `transition-engine`, `admin-payouts`, `seller-payouts`, `admin-sellers` bundle/parse: PASS.
- Live SellerAccount schema includes `settlement_status`: PASS.
- Live MoneyLedgerEvent schema is append-only: PASS.
- Live SellerSettlement and SellerPayoutBatch schemas exist: PASS.
- Old/unfinal provider outcomes `unknown` and `temporary_fail` are rejected before money ledger creation: PASS.
- Charge and Recovery Money Ledger are written in the same Deal update as their canonical Money State changes: PASS.
- Only one source defines `SITON_PLATFORM_FEE_RATE = 0.08`: PASS.
- Numeric proof for gross 120 ILS: fee base 9.60, fee VAT 1.73 at configured 18%, total Siton fee 11.33, seller net 108.67: PASS.
- Refund calculation produces the same financial snapshot with negative signs: PASS.
- Settlement reads `deal.money_ledger_events` rather than InvoiceDocument or UI state: PASS.
- Batch idempotency key exists and external Dispatch/Retry remain blocked: PASS.
- Static scan found no distributor commission, distributor balance or distributor payout amount fields in payout scope: PASS.

## Open

- Connect and prove a real payment provider before any charge/capture/recovery/refund execution.
- Connect and prove a real payout provider before `processing/paid/failed/returned` can represent external bank truth.
- Add provider webhook/reconciliation proof before declaring payout production-ready.
- Refund execution remains fail-closed until Constitution conflict C-01 is resolved.
- Execute live synthetic settlement/batch E2E after payment Sandbox produces canonical ledger events.
- Continue real notification/OTP delivery and remaining realtime UX.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 86%.
Production readiness: not implied by these percentages.

## Next step

Import and prove notification delivery/OTP provider boundaries while payment and PostgreSQL live connections remain externally blocked. Keep all real money actions fail-closed.

## Previous milestone

## Current milestone: Stage 19 - distributor portal and deal-scoped attribution

Date: 2026-08-11
Base44 app: ראש גשר

## Completed

- Added an authenticated distributor portal at `/distributor`.
- Admin can grant a registered user distributor access to a specific Deal and revoke it with a documented reason.
- Distributor can create multiple unique attribution links only for Deals with active access.
- Distributor-created `DistributionSource` records are bound to owner user, Deal and access id.
- Revoking distributor access deactivates all distributor links created under that access.
- Click/visit tracking rejects distributor Sources reused for another Deal or tied to inactive access.
- Join attribution and Join recovery enforce the same Deal/access scope before writing attribution.
- Distributor portal exposes clicks, visits, joins and units only. It exposes no buyer PII and no monetary balance.
- Business rule is explicit in code/UI: distributor commission is zero; attribution creates no payout or settlement entitlement.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- `distributor-portal`, `admin-distribution`, `track-distribution-event`, `join-deal`, `reconcile-join-intents` bundle/parse: PASS.
- `/distributor` authenticated route exists: PASS.
- Live `DistributorDealAccess` schema exists: PASS.
- Live `DistributionSource` schema includes distributor owner, Deal and access scope: PASS.
- DistributionAttribution and DistributionEvent remain append-only: PASS.
- Deal-scope/access enforcement exists in visit tracking, Join attribution and recovery attribution: PASS.
- Static scan found no distributor commission/balance/payout amount fields in the new distributor scope: PASS.

## Open

- Execute a live admin grant, distributor link creation, attribution and revoke test with two real registered users.
- Real Join remains fail-closed until external inventory is connected, so final Join-attribution E2E cannot execute yet.
- Continue Payouts & Settlements for sellers only, real notification delivery, OTP provider, payment provider and realtime UX.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 78%.
Production readiness: not implied by these percentages.

## Next step

Import seller Payouts & Settlements from the canonical specification. Keep distributor attribution entirely outside payout calculations.

## Previous milestone

## Current milestone: Stage 18 - two-admin emergency controls and append-only audit

Date: 2026-08-11
Base44 app: ראש גשר

## Completed

- Emergency joining and charging pauses now use a real two-admin workflow. The requesting admin cannot approve the activation.
- Emergency release is also two-step. A release request leaves the control effective until a different admin approves release.
- Added `AdminControlAudit` as append-only signed evidence for emergency activation and release.
- Emergency enforcement no longer trusts mutable `AdminControlFlag.status`; Join and Charging verify HMAC-signed audit events from Backend Functions.
- Direct admin mutation of the projection cannot forge an activation or release because the server secret is not exposed to the client.
- Join performs reconciliation only for an already-pending Join during an emergency; it never performs a new Commit while joining is paused.
- `DealAudit` is now append-only at RLS level: update and delete are disabled.
- Seller cancellation remains fail-closed under the existing Constitution conflict, so there is no active cancel path that bypasses emergency read-only behavior.

## Checked

- Frontend build: PASS.
- ESLint: PASS.
- `admin-control-flags`, `transition-engine`, and `join-deal` bundle/parse: PASS.
- Live `AdminControlAudit` schema exists and has update/delete disabled.
- Live `DealAudit` schema has update/delete disabled.
- Emergency activation requires a different second admin: static gate PASS.
- Emergency release requires a different second admin: static gate PASS.
- Join uses signed `AdminControlAudit` enforcement: PASS.
- Charging uses signed `AdminControlAudit` enforcement: PASS.
- No function mutates or deletes `AdminControlAudit`: static scan PASS.
- HMAC canonicalization used by signer and verifier is byte-identical: PASS.
- No `ADMIN_CONTROL_INTEGRITY_SECRET` is configured yet, therefore emergency approval remains fail-closed rather than silently unsigned.

## Open

- Configure `ADMIN_CONTROL_INTEGRITY_SECRET` as a protected non-production secret before executing a live two-admin emergency proof.
- Execute a live two-admin activation/release proof with two distinct admin accounts.
- Continue the managed PostgreSQL connectivity proof and Stripe Sandbox activation.
- Continue importing remaining product surfaces: distributor portal, payouts/settlements, real notifications/OTP delivery, and remaining realtime UX.
- The separate `DealAudit` entity is now WORM-like, while the embedded Deal transition journal remains the same-document canonical transition evidence. Full seven-year retention still depends on platform retention/export policy and is not yet claimed.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 74%.
Production readiness: not implied by these percentages.

## Next step

Continue importing independent product scope while external service connections remain blocked. Next: distributor portal with authorized Deal access and attribution-only links, explicitly zero distributor commission.

## Previous milestone

## Current milestone: Stage 17 - Reservation saga crash/recovery proof

Date: 2026-08-11
Base44 app: ראש גשר

## Completed

- Base44 remains the product and workflow owner. The external component is deliberately limited to transactional inventory reservation.
- `inventory-bridge`, Publish sync, Join Hold/Commit saga, deterministic projection, reconciliation, and transactional Close remain wired behind fail-closed gates.
- Added a dedicated PostgreSQL saga recovery suite covering crash boundaries instead of only inventory races.
- Join remains fail-closed unless both `RESERVATION_SERVICE_ENFORCED=true` and `JOIN_EXTERNAL_RESERVATION_PROVEN=true` are explicitly configured.
- The unsafe Base44 Entity-only `$inc reserved_units` Join path is absent from the current Join implementation.
- Before Hold, Base44 stores a recovery intent and pending key. A committed Join is projected back into the Deal with the external reservation id as the deterministic participant id.
- Reconciliation projects authoritative committed reservations, releases ambiguous held reservations, and clears expired/released/not-created intents.
- `transition-engine` is the canonical CloseJoining owner and reconciles Join intents before external inventory Close.
- Temporary Holds protect capacity but never count toward the product 90% threshold; only committed units do.
- Distributor/source attribution remains tracking metadata only. No distributor commission or money flow was introduced.

## Checked

- Base44 frontend build: PASS.
- ESLint: PASS.
- `join-deal`, `inventory-bridge`, `reconcile-join-intents`, `transition-engine`, `close-joining`, and `publish-deal` bundle/parse: PASS.
- Static safety gate: old `$inc reserved_units` Join mutation absent: PASS.
- Static safety gate: both reservation enable flags are required together: PASS.
- Static safety gate: CloseJoining reconciliation precedes external Close: PASS.
- Reservation Service GitHub Actions run 17: PASS.
- Reservation Service TypeScript build: PASS.
- PostgreSQL concurrency/close suite: PASS.
- Saga recovery suite: PASS.
- Crash after Hold is compensated by Release: PASS.
- Crash after Commit survives replay/restart without double-counting: PASS.
- Close while an active Hold exists: rejected as required.
- Close after committed Join preserves committed capacity and rejects later Holds: PASS.
- Nine temporary Holds against a 10-unit Deal leave `committed_units=0`; after Commit, `committed_units=9`: PASS.
- No reservation service URL, PostgreSQL URL, tracking secret, or Join enable flag is configured in Base44, so no real buyer Join is possible yet.

## Open

- Prove the preferred minimal-infrastructure shape: Base44 Backend Function directly calling a managed PostgreSQL database. `npm:pg` bundles in the Deno function environment, but an actual outbound PostgreSQL connection is not yet proven.
- If direct PostgreSQL from Base44 fails at runtime, deploy the already-proven narrow reservation Node service as the fallback.
- Configure protected non-production secrets only after a managed PostgreSQL test endpoint exists.
- Run real Base44-to-PostgreSQL end-to-end proofs: successful Join, duplicate retry, response loss after Hold, response loss after Commit, last-unit race, CloseJoining during active Hold, and committed/held intent recovery.
- Prove source attribution, buyer tracking and seller/public counters under replay and recovery.
- Only after repeated end-to-end proof set `JOIN_EXTERNAL_RESERVATION_PROVEN=true`.
- Real payment authorization/capture/recovery/refund remains a separate production-readiness gate.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 66%.
Reservation critical-section extraction and local/CI proof: 97%.
Production readiness: not implied by these percentages.

## Current Base44 checkpoint

Stage 16 external reservation Join saga and recovery gates
Checkpoint id: `6a7b073848f66f6faa41bb80`
Sandbox commit: `61e2101f110236fbc9e849db20b651a4e69f4b6e`

## Next step

Prefer the smallest operational footprint: prove a Base44-hosted PostgreSQL adapter against a managed non-production PostgreSQL endpoint. If that runtime proof fails, deploy only the narrow reservation service plus PostgreSQL. In both cases keep Join fail-closed until the repeated end-to-end race/recovery gate is green.