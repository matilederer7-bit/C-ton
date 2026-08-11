# Base44 Migration Checkpoint

Date: 2026-08-11
Branch: `base44-migration-spike`
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)

## Completed

- Base44-first migration remains isolated from canonical `master`; the old Render deployment is not a dependency.
- Draft creation/editing, Publish, 90% threshold, deadline rules, seller terms and seller enforcement migrated.
- Seller profile, dashboard, safe deal detail, KYC review and public buyer page migrated.
- `Deal` and `SellerAccount` direct entity access is Admin-only; seller UI uses Backend projections.
- OTP request/verify rail migrated; external OTP delivery remains disconnected.
- Buyer tracking migrated with opaque-token verification and safe state/delivery projection.
- Charging state machine, Completion Window, Recovery, Finalize, Refund result application and Worker queue foundation migrated without real provider I/O.
- Read-only Admin Mission Control migrated with Deal, seller, Outbox, DLQ, PaymentAttempt and Support visibility.
- True concurrent Base44 last-unit testing disproved Entity `updateMany` as a hard inventory lock. Join remains fail-closed.
- Narrow PostgreSQL reservation component extracted on `base44-reservation-service` / Draft PR #5. It owns only inventory ceiling and Reservation lifecycle.
- Reservation component separates active `reserved_units` from `committed_units`; only committed capacity may count toward the 90% target.
- Reservation component implements transactional Sync, Hold, Commit, Release, status and serialized Close with HMAC authentication.
- Base44 `inventory-bridge` wired. Publish can Sync inventory and CloseJoining can close it when enforcement is enabled.
- Base44 Join rewritten behind disabled gates as Hold -> durable Join intent -> Commit -> authoritative status -> deterministic projection/reconciliation. Old Base44 inventory mutation removed.
- Admin Support Operations migrated at `/admin/support` with lifecycle, priorities, case types, SLA and audit. Support has no refund/money-state action.
- Seller fulfillment migrated at `/seller/deal/:dealId/fulfillment` for `Completed` deals only. Only `DealCompleted` buyers with `ChargedSuccess` or `RecoveredCharge` are projected to delivery.
- Fulfillment supports `ready_to_fulfill`, `shipped`, `delivered`, `issue`, carrier/tracking metadata, Reason audit and CSV shipping export.
- `DeliveryRecord` is Admin-only for direct access and cannot be deleted. Shipping PII is returned only through ownership-checked seller Backend after eligibility is proven.
- Distribution attribution migrated as attribution-only. `DistributionSource` manages active source codes and `DistributionAttribution` records committed Join attribution.
- Join accepts only an active known source code. Arbitrary `ref` values do not create Attribution.
- Admin distribution surface migrated at `/admin/distribution` with source creation, activation/deactivation, attribution count, unit count and share-link generation.
- Seller deal detail shows units by distribution source only. No distributor money surface exists.
- Public deal route recognizes `?ref=` distribution links.
- Admin Forensics migrated at `/admin/forensics` as read-only cross-domain search across Deals, Participants, Outbox, PaymentAttempts, Support, Delivery and Distribution Attribution.
- Forensics redacts buyer identity fields, delivery address, authorization/payment identifiers, tracking hashes and secrets, and reports simple anomaly verdicts for pending Join intents, stale Worker processing and failed/dead-letter events.
- Provider-neutral invoice/receipt status surface migrated. `InvoiceDocument` mirrors the canonical lifecycle `pending -> processing -> issued/failed/skipped`, but document issuance is still disabled.
- Financial values on invoice/receipt records are displayed only when `financial_snapshot_proven=true`. No 8% or VAT calculation is fabricated in Base44.
- Voucher and Ticket public UX migrated. Voucher pages show face value, validity and redemption instructions; Ticket pages show event date, venue and entry instructions. Shipping UI is suppressed for non-physical deals.
- `FulfillmentUnit` foundation migrated for voucher/ticket unit status and `code_display_last4` only. Full plaintext code generation/storage is not enabled.
- Buyer tracking shows voucher/ticket terms and fulfillment-unit status/last4 without exposing full codes.
- Seller digital fulfillment Backend supports read/export/redeem foundation only; it does not mint codes and does not mutate Deal/Buyer/Money state.
- Notification operations control plane migrated with `NotificationEvent` and append-only `NotificationAttempt` entities, status/retry/stuck-processing visibility and Admin reset with Reason. No external notification provider I/O is enabled.
- Seller operational analytics migrated for periods all/30d/90d/year using non-financial operational truth only: Deal states, units, deadline risk, delivery status, support and distribution attribution.
- Admin emergency controls migrated with `pause_joining_emergency`, `pause_charging_emergency`, `payout_freeze`, `content_takedown`. Emergency pauses require expiration and Reason; flags gate actions but do not mutate Deal/Buyer/Money state.
- Join checks active pause-joining flags before any reservation side effect. Charging checks active pause-charging flags before transition/outbox creation. Public deal visibility respects content-takedown flags.
- Seller Draft cancellation migrated as the narrow canonical `Draft -> Cancelled` path only, with ownership, idempotency and audit evidence.
- Deal image surface migrated onto Base44 storage. Deal `images` metadata is attached/removed/reordered only through seller-owned Draft-only Backend logic; images become immutable with the published Deal contract.
- Public deal page now renders a Deal image gallery.

## Checked

- Base44 frontend build: PASS through Stage 27.
- ESLint: PASS through Stage 27.
- Stage 16 bundles PASS: `inventory-bridge`, `join-deal`, `reconcile-join-intents`, `close-joining`, `publish-deal`.
- Join static gate: no old Base44 `$inc reserved_units` inventory path remains; `INVENTORY_SAGA_PROVEN` is still required.
- Reservation PostgreSQL CI: PASS, including 200 simultaneous Holds on 20 units with exactly 20 winners, replay/payload mismatch, mixed quantities, Commit-vs-Release, expiry/renewal and serialized Close.
- Stage 17 Support bundles and forbidden-action scan: PASS.
- Live `OperationalCase` / `OperationalCaseEvent` RLS: Admin-only and no delete; event update also denied.
- Stage 18 `seller-fulfillment`: build/lint/bundle PASS; static scan found no Refund, money-state, Deal or Participant mutation.
- Live `DeliveryRecord` schema: Admin-only create/read/update; delete denied.
- Stage 19 Distribution bundles: PASS. Static financial-field scan found no commission, payout, settlement, bank-account or affiliate-fee fields in the distribution model/backend.
- Live `DistributionSource` and `DistributionAttribution` schemas verified after checkpoint; source drift was detected and corrected before closing the stage.
- Stage 20 `admin-forensics`: build/lint/bundle PASS; static sensitive-field scan passed.
- Stage 21 seller receipt status surface: build/lint/bundle PASS; no fee/VAT formula exists in the surface.
- Live `InvoiceDocument` schema verified; delete denied and direct access Admin-only.
- Stage 22 voucher/ticket UX and fulfillment foundation: build/lint/bundles PASS. Static scan found no plaintext code generation/storage and no Deal/Buyer/Money-state mutation in digital fulfillment.
- Live `FulfillmentUnit` schema verified; delete denied and direct access Admin-only.
- Stage 23 notification operations: build/lint/bundle PASS; no provider delivery I/O exists in the Admin control-plane function.
- Live `NotificationEvent` and append-only `NotificationAttempt` schemas created.
- Stage 24 Seller Analytics: build/lint/bundle PASS; no platform-fee/VAT/net calculation is performed.
- Stage 25 Admin Emergency Controls: build/lint/bundles PASS; control plane itself does not mutate Deal/Participant financial state.
- Live `AdminControlFlag` schema created; delete denied.
- Stage 26 Draft cancellation: build/lint/bundle PASS and restricted to `Draft -> Cancelled`.
- Stage 27 Deal images: frontend build/lint and Backend bundles PASS. Live Deal schema includes `images` metadata and published Deal immutability is preserved by Draft-only image attach/remove/reorder logic.
- Full project typecheck remains red because of pre-existing Base44 template/UI/Auth typing. Do not represent typecheck as PASS.

## Open

- Deploy/provision the narrow reservation component plus PostgreSQL and configure protected Base44 secrets. No production URL or secret is configured.
- Run repeated Base44-to-reservation end-to-end races and crash/response-loss tests before enabling Join.
- Prove deterministic Base44 Join projection/reconciliation under concurrent replay; Participant remains a derived projection without a documented unique constraint.
- Ensure every deadline/failure path closes external inventory before a terminal state.
- Connect real OTP delivery.
- Connect Stripe Sandbox / canonical payment provider and verify authorization, capture, recovery, release and refund.
- Implement provider status reconciliation for UNKNOWN plus real Retry/DLQ behavior.
- Wire supported Base44 Automation/CRON or Entity Hook for Worker ticks.
- Add buyer payment-method recovery after provider connection.
- Prove a real Base44 `UploadFile` Runtime call with an actual JPEG/PNG/WebP file. Current image layer is build-verified but runtime upload is not yet proven.
- Base44 does not currently expose a documented DeleteFile primitive in this implementation path; detached image files may require orphan cleanup policy/tooling.
- Voucher/Ticket full-code issuance remains disabled until reliable one-time full-code delivery survives crash/replay without storing plaintext code at rest.
- Connect a real notification provider and prove retry/idempotency before enabling outbound delivery.
- Invoice/receipt issuance remains disabled until a real document provider and authoritative tax/payment snapshots exist.
- Preserve current business rule: distributors are attribution-only; no distributor commission or payout surfaces may be reintroduced.
- Siton fee is 8% on the correct non-VAT base including shipping. Do not calculate until an authoritative VAT/tax basis exists.
- Remove empty Admin-only `_noop` schema once supported remote schema deletion exists.
- Update root `PROJECT_STATUS.md` only through a safe non-truncating patch path.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 89%.

The percentages measure migrated scope, not production readiness. Join and real money remain disabled.

## Milestones

- Stage 0 Bridge: complete.
- Stage 1 Draft: complete.
- Stage 2 Publish: complete.
- Stage 3 OTP + Join contract: migrated; production Join remains fail-closed.
- Stage 4 Public buyer surface: complete.
- Stage 5 Pre-money charging boundary: complete.
- Stage 6 Recovery, Finalize, Refund and Worker queue foundation: complete.
- Stage 7 Base44 native concurrency proof: failed on repeat; external critical section required.
- Stage 8 Seller profile: complete.
- Stage 9 Admin Mission Control: complete.
- Stage 10 Buyer tracking: complete.
- Stage 11 Seller dashboard: complete.
- Stage 12 Safe seller projections/detail: complete.
- Stage 13 Seller KYC review gate: complete.
- Stage 14 Seller Draft editing: complete.
- Stage 15 Inventory bridge Publish/Close boundaries: complete in code, enforcement disabled.
- Stage 16 External inventory Saga wired fail-closed: complete in code, end-to-end deployment proof open.
- Stage 17 Admin Support Operations and SLA: complete.
- Stage 18 Seller fulfillment and shipping export: complete.
- Stage 19 Distribution attribution-only surfaces: complete.
- Stage 20 Admin Forensics: complete.
- Stage 21 Invoice/receipt status projection: complete; issuance and financial snapshot creation blocked.
- Stage 22 Voucher/Ticket UX and digital-fulfillment foundation: complete; full-code issuance blocked.
- Stage 23 Notification operations control plane: complete; provider delivery blocked.
- Stage 24 Seller operational analytics: complete.
- Stage 25 Admin emergency control flags: complete.
- Stage 26 Seller Draft cancellation: complete.
- Stage 27 Base44 deal images and public gallery: complete in code; real UploadFile runtime proof open.

## Current Base44 checkpoint

`Stage 27 Base44 deal images and public gallery`

Checkpoint id: `6a7afaed570ac28c2d09f3da`

Sandbox commit: `a77cb65a94f2bd71714b87d19397e9af57522b7f`

## Next step

Prove the Base44-native image upload path with a real file, then move to the remaining production-readiness blockers rather than adding more decorative surfaces. Join and real money stay disabled until reservation deployment, payment-provider Sandbox proof and the canonical P0/P1 gates are satisfied.
