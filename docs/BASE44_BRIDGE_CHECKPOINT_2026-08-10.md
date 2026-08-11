# Base44 Migration Checkpoint

Date: 2026-08-11
Branch: `base44-migration-spike`
Base44 app: `ראש גשר` (`6a79b3ce58f678716af8d295`)

## Completed

- Base44-first migration remains isolated from canonical `master`; the old Render deployment is not a dependency.
- Draft creation, Draft editing, Publish, 90% threshold, deadline rules, seller terms and seller enforcement migrated.
- Seller profile, seller dashboard, safe seller deal detail and public buyer page migrated.
- Seller KYC review is explicit: new sellers start `pending`; Publish requires an Admin-reviewed approval with reviewer/timestamp evidence.
- `Deal` and `SellerAccount` direct entity access is Admin-only. Seller UI uses ownership-checked Backend projections.
- OTP request/verify rail migrated with hash, TTL, rate limit, attempt limit, lockout and proof token; external delivery is still disconnected.
- Buyer tracking migrated with opaque token verification and safe state/delivery projection.
- Charging state machine, Completion Window, Recovery, Finalize, Refund result application and Worker queue foundation migrated without real provider I/O.
- Read-only Admin Mission Control migrated with Deal, seller, Outbox, DLQ and PaymentAttempt visibility.
- True concurrent Base44 last-unit testing disproved `updateMany` as a hard inventory lock. Join was kept fail-closed.
- A deliberately narrow PostgreSQL reservation component was extracted on branch `base44-reservation-service` / Draft PR #5. It owns only inventory ceiling and Reservation lifecycle, not the Siton backend.
- Reservation component separates active `reserved_units` from `committed_units`; only committed capacity may count toward the 90% target.
- Reservation component supports transactional Sync, Hold, Commit, Release, status and serialized Close. Close rejects while Holds are in flight.
- Reservation component has HMAC-SHA256 request authentication and no buyer PII, OTP, delivery details, payment identifiers or financial state.
- Base44 `inventory-bridge` was added. Publish can Sync the inventory ceiling and CloseJoining can close it when enforcement is enabled.
- Base44 Join was rewritten behind disabled gates as Hold -> durable `pending_join_intent` -> Commit -> authoritative reservation status -> deterministic projection/reconciliation. The old Base44 `$inc reserved_units` inventory path is gone.
- `reconcile-join-intents` can recover committed/expired/released reservations and project committed units back into Base44.
- Join remains fail-closed unless both `RESERVATION_SERVICE_ENFORCED=true` and `INVENTORY_SAGA_PROVEN=true`. Neither production proof flag is enabled.
- Temporary Base44 inventory race probe removed.
- Admin Support Operations migrated at `/admin/support` using one Admin-only Backend function. It supports list/filter/create/update/assign/escalate with the canonical lifecycle, priorities, case types and SLA windows.
- Support closing to `Resolved` or `Closed` requires `resolution_note`; every case change requires Reason.
- Support cannot delete cases/events, execute or approve refunds, or mutate Deal/Participant money state.
- Support audit evidence is embedded in the canonical Case and projected to append-only `OperationalCaseEvent` records.
- Mission Control now includes Support Case counts and `support_readiness`; an overdue Urgent case produces `blocked`.

## Checked

- Base44 frontend build: PASS after Stages 16 and 17.
- ESLint: PASS after Stages 16 and 17.
- Stage 16 bundles PASS: `inventory-bridge`, `join-deal`, `reconcile-join-intents`, `close-joining`, `publish-deal`.
- Static Stage 16 gate: no old `$inc reserved_units` / Base44 inventory-ceiling mutation remains in Join.
- Static Stage 16 gate: Join requires `INVENTORY_SAGA_PROVEN`; CloseJoining blocks unresolved `pending_join_intents`.
- Live Deal schema includes inventory sync/reserved/committed projections and pending Join intents.
- Reservation GitHub Actions PostgreSQL gate: PASS. 200 simultaneous Holds on 20 units produce exactly 20 winners.
- Reservation tests PASS for same-key replay, payload mismatch, mixed quantities, committed-count idempotency, Commit-vs-Release race, expiry/renewal and closed-inventory rejection.
- Reservation close gate PASS: active Hold blocks Close; Close after Commit or expiry succeeds; no new Hold after Close.
- Stage 17 bundles PASS: `admin-support-cases`, `admin-overview`.
- Stage 17 static forbidden-action scan: no refund, money-state, Deal/Participant mutation or delete action exists in the Support Backend.
- Live `OperationalCase` schema: Admin-only create/read/update; delete denied.
- Live `OperationalCaseEvent` schema: Admin-only create/read; update/delete denied.
- Full project typecheck remains red because of pre-existing Base44 template/UI/Auth typing. Do not represent it as PASS.

## Open

- Deploy/provision the narrow reservation component plus PostgreSQL, then configure protected Base44 secrets. No production URL or secret is configured yet.
- Run repeated Base44-to-reservation end-to-end races and crash/response-loss tests before enabling Join.
- Prove deterministic Base44 Join projection/reconciliation under concurrent replay; Participant remains a derived projection without a documented unique constraint.
- Ensure every deadline/failure path closes the external inventory before a terminal state.
- Connect real OTP delivery.
- Connect Stripe Sandbox / canonical payment provider and verify authorization, capture, recovery, release and refund.
- Implement provider status reconciliation for UNKNOWN plus real Retry/DLQ behavior.
- Wire supported Base44 Automation/CRON or Entity Hook for Worker ticks.
- Add buyer payment-method recovery after provider connection.
- Continue remaining seller/admin product surfaces, especially fulfillment/delivery, receipts/invoice projections and deeper forensics.
- Preserve current business rule: distributors are attribution-only; no distributor commission or payout surfaces may be reintroduced.
- Apply Siton's 8% fee to the correct non-VAT base including shipping once tax basis and real financial records are available; do not invent VAT allocation.
- Remove empty Admin-only `_noop` schema once a supported remote schema delete surface is available.
- Update root `PROJECT_STATUS.md` only through a safe non-truncating patch path; the connector cannot safely replace the huge file from truncated content.

## Progress

Initial technical Base44 migration path: 99%.
Overall Siton-to-Base44 migration estimate: 68%.

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
- Stage 17 Admin Support Operations and SLA: complete and build-verified.

## Current Base44 checkpoint

`Stage 17 admin support operations and SLA`

Checkpoint id: `6a7ae707e6912615a5db58d6`

Sandbox commit: `42a33de6f3ff3691c69d0aa2ac1adc60cf98c8f4`

## Next step

Continue Base44-first migration with independent product surfaces while Join remains disabled. Next independent surface: seller fulfillment/delivery operations for Completed deals, using only participants with `ChargedSuccess` or `RecoveredCharge`. No payment or refund action may be embedded in fulfillment. In parallel, keep PR #5 isolated until a real reservation deployment and end-to-end Saga proof are available.
