# Base44 Constitution Conflict Register

Date: 2026-08-11
Status: blocking silent reconciliation

Purpose: record contradictions between the binding Siton constitution/database contract and later UX/product documents. The migration must not silently invent a rule when two sources disagree.

## C-01 Seller cancellation / `Cancelled`

Binding constitution v1.4 defines `Cancelled` as an allowed DealState, but its closed Deal transition table contains no transition into `Cancelled` and its closed Action list contains only:

- `deal.publish`
- `deal.close_joining`
- `deal.prepare_charging`
- `charging.start`
- `charging.recovery`
- `charging.finalize`
- `refund.issue`

There is no `deal.cancel` Action.

The UX/product documents nevertheless require seller cancellation before the charging lock and a final `Cancelled` screen/state.

Current Base44 implementation contains `cancel-deal` using `deal.cancel` and `Draft -> Cancelled`. This is product-aligned but constitution-invalid until the constitution is versioned or the cancellation pathway is removed/disabled.

Migration rule: do not treat `deal.cancel` as canonical. Keep the path fail-closed for production until the constitution is explicitly reconciled.

## C-02 Refund final buyer state

Database Contract v1.2 requires an atomic rule: whenever `money_state = Refunded`, `buyer_state` must be `Dropped` in the same update.

The later full product specification says a fully refunded buyer loses product eligibility and moves from the successful final path to the failed/not-entitled final buyer path, described there as K10 / Deal Failed.

These are not the same BuyerState.

Migration rule: no production refund transition may be declared constitution-complete until the authoritative final BuyerState for a full refund is explicitly chosen and versioned.

## C-03 Multiple purchases by the same buyer

The full product specification allows one buyer to make multiple separate purchases in the same Deal.

Database Contract v1.2 requires `UNIQUE (deal_id, user_id)` on Participants.

Those rules can coexist only if multiple purchases are aggregated into one Participant row/aggregate rather than represented as multiple Participants, or if the DB contract changes.

Migration rule: Base44 may preserve multiple Join reservations, but the canonical Participant projection must not be declared final until the identity/aggregation rule is explicitly fixed.

## C-04 `max_units` optional vs mandatory

Constitution v1.4 describes maximum units as optional.

The later full product specification says maximum inventory is mandatory at Deal creation.

Migration rule: current Base44 flow may require `max_units` for safety, but this is a product-policy decision that should be reflected in the next constitution/database-contract version rather than silently treated as unchanged v1.4.

## C-05 Platform fee terminology

The binding project rule for the migration is:

- no distributor commission;
- Siton platform fee is 8%;
- the 8% applies to the charged base including shipping/everything except VAT.

Older DB/constitution fields use the generic name `commission_rate`. This must not be interpreted as distributor commission.

Migration rule: in Base44, avoid reintroducing distributor money surfaces. Any future financial snapshot must name the Siton platform fee explicitly and must not calculate it until the VAT/tax base is authoritative.

## Resolution policy

- No AI agent may resolve these conflicts by renaming a state/action or adding a transition on its own.
- A conflict can be closed only by a new explicit constitution/database-contract version or a direct project-owner decision recorded in project status.
- Until resolved, production paths that depend on the conflict remain disabled or fail-closed.
