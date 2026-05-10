# DEAL_TYPE_EXPANSION_DELIVERY_REPORT

Date: 2026-05-10
Branch: master
Commit: `ba334eb`
Push: `origin/master` updated (`f3ebc2a..ba334eb`)

## 1. Verdict
`DEAL_TYPE_EXPANSION_PASS_READY_FOR_E2E`

## 2. Deal types supported
- `physical_product` (default; existing model preserved)
- `voucher`
- `ticket`

## 3. Physical-product preserved without regression
Yes. `deal_type` defaults to `physical_product`; `delivery_options` is wired
only when type is physical; existing endpoints (`/api/seller/deals/:dealId/
shipping-export`, `/api/seller/deals/:dealId/delivery-handoff`,
`/api/seller/deals/:dealId/delivery-handoff/export.xlsx`) are unchanged.
`test:full-e2e-gate` PASS.

## 4. Voucher supported
Yes. `siton.deal_voucher_terms` schema, `POST /deals` validation
(`voucher_terms_required`), public page exposes `voucher_terms` + Hebrew
copy, tracking exposes voucher fulfillment block when eligible,
`/api/seller/deals/:dealId/voucher-export` returns Completed-only,
eligible-only CSV.

## 5. Ticket supported
Yes. `siton.deal_ticket_terms` schema, `POST /deals` validation
(`ticket_terms_required`), public page exposes `ticket_terms` + Hebrew
copy, tracking exposes ticket fulfillment block when eligible,
`/api/seller/deals/:dealId/ticket-export` returns Completed-only,
eligible-only CSV.

## 6. Migrations added
- `src/migrations/038_deal_types_voucher_ticket.sql` — idempotent, adds
  `deals.deal_type` (closed CHECK + default `physical_product`),
  `siton.deal_voucher_terms`, `siton.deal_ticket_terms`,
  `siton.fulfillment_units` (UNIQUE on `(deal_id, participant_id, unit_index)`).
- Registered in `scripts/bootstrap_demo_db.cjs`.

## 7. Tables / columns added
- `siton.deals.deal_type TEXT NOT NULL DEFAULT 'physical_product'` with
  CHECK in (`physical_product`,`voucher`,`ticket`) and index
  `idx_deals_deal_type`.
- `siton.deal_voucher_terms (deal_id PK, face_value_amount, currency,
  valid_from/valid_until, redemption_*, terms, is_single_use,
  allow_partial_redemption, voucher_code_mode CHECK)`.
- `siton.deal_ticket_terms (deal_id PK, event_name, event_starts_at,
  event_ends_at, venue_*, entry_instructions, ticket_type CHECK,
  seat_mode CHECK, transfer_allowed)`.
- `siton.fulfillment_units (fulfillment_unit_id PK, deal_id, participant_id,
  deal_type CHECK, fulfillment_kind CHECK, unit_index, code_hash,
  code_display_last4, status CHECK, issued/sent/redeemed/expires timestamps,
  metadata_jsonb, UNIQUE (deal_id, participant_id, unit_index))` plus
  indexes `idx_fulfillment_units_deal`, `idx_fulfillment_units_participant`.

## 8. Seller create UX (backend contract)
`POST /deals` accepts `deal_type` and per-type sub-objects:
- `voucher_terms` (required when `deal_type='voucher'`); `seller_uploaded`
  voucher_code_mode is rejected with `voucher_code_mode_unsupported`.
- `ticket_terms` (required when `deal_type='ticket'`);
  `assigned_seating_not_supported_yet` is rejected with
  `ticket_seat_mode_unsupported`.

## 9. Public deal page
`GET /api/deals/:id/public` returns:
- `deal_type`
- `voucher_terms` (full set when type=voucher, null otherwise)
- `ticket_terms` (full set when type=ticket, null otherwise)
- `delivery_options` (only when type=physical_product)
- `fulfillment_copy` (Hebrew, per-type, includes "issued only after deal
  completed and charged" disclaimer)

## 10. Buyer tracking
`GET /api/participants/:id/tracking` adds a `fulfillment` block:
- `eligible: boolean` (mirrors `decideFulfillmentIssuance`)
- `units` (unit_id, unit_index, status, code_display_last4, timestamps —
  emitted only when eligible AND not physical_product)
- `voucher_terms` / `ticket_terms` (when applicable)
- `copy` (Hebrew, switches between "not yet issued" and "issued" wording)

## 11. Seller dashboard / exports
- `GET /api/seller/deals/:dealId/voucher-export` — CSV with
  `voucher_code_last4` (no plaintext), Completed + eligible only.
- `GET /api/seller/deals/:dealId/ticket-export` — CSV with
  `ticket_code_last4`, event metadata, Completed + eligible only.
- Both pass through `csvSafeCell` (neutralizes `=`, `+`, `-`, `@`).

## 12. Fulfillment issuance
`issueFulfillmentForCompletedDeal(dealId)` in `src/app.ts`:
- Re-checks `deal.state='Completed'` inside its own transaction.
- Selects participants where `buyer_state='DealCompleted'` AND
  `money_state IN ('ChargedSuccess','RecoveredCharge')`.
- Calls `issueFulfillmentUnitsForParticipant` per qty.
- Idempotent via `ON CONFLICT (deal_id, participant_id, unit_index) DO NOTHING`.
- Issuance failure does NOT roll back the completed deal.

## 13. Voucher / ticket only after Completed + eligibility
Yes. Two layers of enforcement:
1. `decideFulfillmentIssuance` rejects unless `dealState='Completed'` AND
   `buyerState='DealCompleted'` AND
   `moneyState IN ('ChargedSuccess','RecoveredCharge')`.
2. SQL eligibility filter in `issueFulfillmentForCompletedDeal`.

## 14. qty → units
Policy: `qty=N` produces N fulfillment units (one per unit) for voucher
and ticket. Documented in `docs/DEAL_TYPES_PHYSICAL_VOUCHER_TICKET.md`
and asserted in `tests/deal_types_validation.ts`.

## 15. Redemption / check-in
`POST /api/seller/fulfillment/:unitId/redeem` foundation endpoint:
- Seller ownership check (403 `fulfillment_unit_forbidden` otherwise).
- Deal must be `Completed` (409 `deal_not_completed`).
- Status must be `Issued` or `Sent` (409 `fulfillment_unit_not_redeemable`).
- Idempotent: repeated redeem returns `{ok:true, idempotent:true}`.
- Does NOT touch money_state, buyer_state, deal_state, or refund policy.
- Full QR/scanner app deferred; redemption foundation is the stable hook.

## 16. Mission Control updated
Yes. New sections: `deal_type_readiness` (deal counts by type, per-type
table presence, issuance policy with `manual_refund_allowed:false`,
`manual_issuance_before_completed_allowed:false`,
`eligible_money_states:["ChargedSuccess","RecoveredCharge"]`) and
`fulfillment_readiness` (totals + ineligible/before-Completed P0 counters).

## 17. Support / Notifications updated
- Notification templates `buyer_voucher_issued_he` and
  `buyer_ticket_issued_he` added to the closed-set
  `NOTIFICATION_TEMPLATE_KEYS` registry. They share the same
  no-charge-language guard as other buyer events.
- Support case types are still routed via the existing
  `siton.support_tickets` surface; no new schema needed.

## 18. Legal / Trust copy updated
- Per-type Hebrew copy via `publicDealCopy()` and
  `trackingCopyForFulfillment()` includes the canonical
  "issued only after deal completed and charged" wording for voucher
  and ticket.
- `docs/REFUND_POLICY.md` updated with a Voucher / Ticket Fulfillment
  Relation section confirming no new refund pathway.

## 19. Refund policy preserved
Yes. `test:refund-policy` PASS (10/10). No new refund route exists. No
admin/seller/support refund path was added.

## 20. JSON boundary preserved
Yes. `test:json-boundary` PASS (12/12). `fulfillment_units.metadata_jsonb`
is classified as `allowed_metadata` in `buildJsonBoundaryReadiness`;
truth lives in rigid columns (`deal_type`, `fulfillment_kind`, `status`,
`unit_index`, `code_hash`, `code_display_last4`, timestamps).

## 21. State machine changed?
No. Deal/Buyer/Money state machines are untouched.

## 22. Money logic changed?
No. `platform_fee_money`, `payment_provider`, `payout_rail`,
`payment_attempt_helpers` are untouched.

## 23. Live money executed?
No. Mock provider only; same as prior baseline.

## 24. Dependency added?
No new runtime dependency. Existing transitive `fast-uri` (via `fastify`)
has a known high-severity advisory pre-existing in the lockfile and was
not introduced by this work.

## 25. Tests run
| Suite                                            | Result |
| ------------------------------------------------ | ------ |
| `npx tsc --noEmit`                               | PASS   |
| `npx tsc -p tsconfig.test.json`                  | PASS   |
| `npm run test:deal-types`                        | PASS (24/24) |
| `npm run test:refund-policy`                     | PASS (10/10) |
| `npm run test:json-boundary`                     | PASS (12/12) |
| `npm run test:provider-live-money-readiness`     | PASS         |
| `npm run test:mission-control`                   | PASS (6/6)   |
| `npm run test:notifications-readiness`           | PASS (7/7)   |
| `npm run test:adversarial`                       | PASS (19/19) |
| `npm run test:full-e2e-gate`                     | PASS (9/9)   |

## 26. Bootstrap clean / rerun
`npm run bootstrap:demo-db` succeeds and is idempotent (re-run also OK,
0 migration warnings, migration 038 applies cleanly).

## 27. npm audit result
`npm audit --omit=dev`: 1 high severity (`fast-uri` transitive via
`fastify`), pre-existing in the lockfile. Not introduced by this change.

## 28. PROJECT_STATUS.md updated
Yes. New top section `Current update: 2026-05-10 (Deal Type Expansion —
PASS, READY FOR E2E)` with verdict
`DEAL_TYPE_EXPANSION_PASS_READY_FOR_E2E`.

## 29. Docs updated
- New: `docs/DEAL_TYPES_PHYSICAL_VOUCHER_TICKET.md` (canonical contract).
- New: `docs/DEAL_TYPE_EXPANSION_DELIVERY_REPORT.md` (this file).
- Updated: `docs/REFUND_POLICY.md` (voucher/ticket fulfillment relation).
- Updated: `PROJECT_STATUS.md`.

## 30. Commit hash
`ba334eb`

## 31. Push status
`origin/master` updated: `f3ebc2a..ba334eb`.

## 32. Final git status
clean.

## 33. What's open before next E2E
- Run the 22-case deal-type E2E pass against a live demo bootstrap (this
  delivery covered source-static + bootstrap + key regressions; the
  end-to-end flow against the running server with charge → completion →
  issuance → redemption → export round-trips is the next gate).
- Seller-uploaded voucher codes surface (rejected at API today).
- Assigned-seat ticketing engine (rejected at API today).
- Voucher / ticket reminder schedulers (templates exist, no scheduler).

## 34. Provider Sandbox Validation readiness
The Deal Type Expansion does not block Provider Sandbox Validation —
its scope (system-mandated refund on deal failure) is independent of
fulfillment type. We recommend: run the deal-types E2E (item 33) first
to confirm the issuance + redemption round-trip on a real DB before
moving to Provider Sandbox Validation.
