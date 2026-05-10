# Deal Types — Physical Product / Voucher / Ticket

Status: `DEAL_TYPES_E2E_PASS_READY_FOR_PROVIDER_SANDBOX` (foundation and
deal-types E2E gate passed; Provider Sandbox Validation remains next).

## 1. What is `deal_type`?

A canonical, closed-set column on `siton.deals` that selects the **fulfillment
profile** for a deal. The deal engine itself (minimum, maximum, deadline,
authorization-as-frame, no-charge-before-completion, 90% rule, completion
window, ChargedSuccess/RecoveredCharge eligibility, system-mandated refund on
failure, outbox, audit, idempotency) is **unchanged** by deal_type.

Allowed values:

- `physical_product` (default)
- `voucher`
- `ticket`

Defaulting to `physical_product` keeps every existing deal valid without a
backfill — historical rows keep behaving exactly as before.

## 2. Physical Product

Existing model. Buyer fills delivery / pickup details. Seller receives delivery
handoff CSV / Excel after Completed. Already documented in
`docs/DELIVERY_DATA_HANDOFF.md`.

Required fields: title, price, min_units, max_units, deadline, delivery_options.

UX: existing seller wizard and public deal page.

## 3. Voucher

Stored in `siton.deal_voucher_terms` (one row per deal):

- `face_value_amount` (positive numeric, required)
- `currency` (default `ILS`)
- `valid_from`, `valid_until`
- `redemption_location`, `redemption_instructions`, `terms`
- `is_single_use` (default true)
- `allow_partial_redemption` (default false; partial redemption is **not**
  supported for MVP)
- `voucher_code_mode` ∈ { `system_generated`, `seller_uploaded`,
  `seller_external` } — only `system_generated` is implemented for MVP;
  `seller_uploaded` is rejected with 400 `voucher_code_mode_unsupported`.

UX (public page): face value, purchase price, validity, redemption location +
instructions, no shipping fields. Disclaimer: "the voucher is issued only after
the deal completes and the actual charge is captured."

## 4. Ticket

Stored in `siton.deal_ticket_terms` (one row per deal):

- `event_name`, `event_starts_at` (required)
- `event_ends_at`
- `venue_name`, `venue_address`, `venue_city`
- `entry_instructions`
- `ticket_type` ∈ { general_admission, reserved_external, vip, other }
- `seat_mode` ∈ { general_admission, assigned_seating_not_supported_yet,
  external_seating } — `assigned_seating_not_supported_yet` is rejected with
  400 `ticket_seat_mode_unsupported` (no seating engine exists).
- `transfer_allowed`

UX (public page): event date, venue, entry instructions, no shipping fields.
Disclaimer: "the ticket is issued only after the deal completes and the actual
charge is captured."

## 5. Required fields per type (creation `POST /deals`)

| Type             | Required body                                                                |
| ---------------- | ---------------------------------------------------------------------------- |
| physical_product | `title`, `price_per_unit`, `min_units`, `max_units`, `deadline`              |
| voucher          | physical fields + `voucher_terms.{face_value_amount, …}`                     |
| ticket           | physical fields + `ticket_terms.{event_name, event_starts_at, …}`            |

`deal_type` defaults to `physical_product` if omitted, so legacy clients keep
working.

## 6. Fulfillment Policy

- `siton.fulfillment_units` rows are issued **only after**
  `deals.state = 'Completed'` AND
  `participants.money_state IN ('ChargedSuccess','RecoveredCharge')` AND
  `participants.buyer_state = 'DealCompleted'`.
- Issuance is idempotent on `(deal_id, participant_id, unit_index)`.
- Quantity policy: `qty=N` produces N fulfillment units (one per ticket / one
  per voucher). Documented and asserted in `tests/deal_types_validation.ts`.
- Plaintext voucher / ticket codes are **never** persisted. Only a SHA-256 hash
  and a 4-character display fragment (`code_display_last4`) are stored. The
  full plaintext code is returned exactly once during issuance and visible to
  the eligible buyer on their tracking view as `code_display_last4`.
- Failed deals issue **no** fulfillment units. If a unit is somehow issued
  while the deal is not Completed, Mission Control's `fulfillment_readiness`
  raises a P0 blocker.

## 7. Who is eligible?

Only buyers that finished a successful charge:

- `money_state = ChargedSuccess` (succeeded on first attempt), or
- `money_state = RecoveredCharge` (succeeded after recovery).

`buyer_state` must be `DealCompleted`. Anything else (Dropped, ChargeFailed,
DealFailed, UserCancelled, ChargeFailedCompletion-stuck) gets no fulfillment
unit.

## 8. Redemption / Check-in

`POST /api/seller/fulfillment/:unitId/redeem` is the foundation endpoint. It
enforces:

- Seller ownership of the deal (forbidden otherwise).
- Deal state must be `Completed`.
- Unit must be in status `Issued` or `Sent`.
- Idempotent: repeated redeem returns `ok=true, idempotent=true`.
- Does not change money state, buyer state, or deal state.

A full redemption / check-in app (QR scan, attendee list filter, etc.) is **not**
in MVP. The endpoint is the stable foundation other surfaces can call when the
need arises.

## 9. Exports

- `GET /api/seller/deals/:dealId/voucher-export` — CSV, voucher deals only,
  Completed only, only eligible buyers, columns include `voucher_code_last4`
  (never plaintext).
- `GET /api/seller/deals/:dealId/ticket-export` — CSV, ticket deals only,
  Completed only, only eligible buyers, columns include event_name and
  `ticket_code_last4`.
- Both pass values through `csvSafeCell` to neutralize CSV injection prefixes
  (`= + - @`).
- The existing `/api/seller/deals/:dealId/delivery-handoff` is unchanged for
  physical deals.

## 10. Notifications

- `buyer_voucher_issued` / `buyer_voucher_issued_he`
- `buyer_ticket_issued` / `buyer_ticket_issued_he`

Both are wired through the existing `notification_templates.ts` registry and
inherit the `NOTIFICATION_TEMPLATE_KEYS` allowed-set guard. They are **never**
emitted before the deal is Completed and the buyer is eligible.

## 11. Refund Policy Relation

No new refund pathway is introduced. See `docs/REFUND_POLICY.md`. Vouchers /
tickets are not refundable just because they were not redeemed.

## 12. JSON Boundary Relation

`fulfillment_units.metadata_jsonb` is classified as `allowed_metadata` in
`buildJsonBoundaryReadiness`. Truth lives in rigid columns:
`status`, `deal_type`, `fulfillment_kind`, `unit_index`, `code_hash`,
`code_display_last4`, timestamps. Eligibility lives in the participant /
deal rigid state machines, never in JSON.

## 13. What's not implemented yet

- Seller-uploaded voucher codes (`voucher_code_mode = 'seller_uploaded'`) —
  rejected at API boundary; needs a separate upload + assignment surface.
- Assigned-seat ticketing (`seat_mode = 'assigned_seating_not_supported_yet'`)
  — rejected at API boundary; needs a real seating engine.
- Voucher reminder before expiry, ticket reminder before event — design wired
  via notification template registry but no scheduler call yet.
- QR generation / scanner app — out of scope; redemption foundation endpoint
  exists.

## 14. Test surface

- `npm run test:deal-types` — 24 source-static + behavioral checks across the
  schema, API, exports, mission control, and copy.
- `npm run test:deal-types-e2e` - real Fastify + PostgreSQL E2E coverage for
  physical regression, voucher full flow, ticket full flow, failed-deal no
  fulfillment, Mission Control E1, refund/JSON/plaintext-code guardrails, and
  webhook replay idempotency.
- Existing regression suites (`test:full-e2e-gate`, `test:refund-policy`,
  `test:json-boundary`, `test:mvp-completion`, etc.) must remain green.
