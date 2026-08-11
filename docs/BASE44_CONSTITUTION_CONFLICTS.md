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

## C-06 Browser payment component vs Payment SDK worker-only rule

The enforcement checklist states that importing a Payment SDK outside `/workers/` is a P0 failure.

The buyer UX simultaneously requires card entry inside the payment provider's secure iframe/component so raw card data never touches Siton servers.

The Base44 package currently includes Stripe.js client dependencies but no current source import was found. A future card-entry screen cannot be activated until the rule is clarified as either:

- server-side payment SDK only in workers, while the provider's PCI client component is explicitly allowed in the browser; or
- no payment-provider SDK of any kind outside workers, requiring a different provider-hosted redirect/tokenization approach.

Migration rule: do not activate a browser payment SDK until the constitution explicitly resolves this distinction.

## C-07 Automatic TargetReached transition has no official Action

The constitution requires `PendingTarget -> TargetReached` when the threshold is reached, but its closed Action list contains no Action for this automatic system transition. Database Contract v1.2 also restricts `audit_log.action_name` to the same seven official Actions, so there is no legal audit Action currently available for this required state change.

The legacy implementation used `deal.target_reached`, but that value is not legal under the binding closed Action list and must not be copied into Base44.

Migration rule: the automatic target transition remains a constitutional blocker until a versioned constitution defines its legal audit/action semantics.

## C-08 Refund after `RecoveredCharge`

The full product specification allows a refund after either an initial successful charge or a recovered charge. The binding Constitution v1.4 Money transition table lists `ChargedSuccess -> Refunded` but does not list `RecoveredCharge -> Refunded`.

Migration rule: do not add `RecoveredCharge -> Refunded` silently. Refund execution remains fail-closed until the transition is explicitly versioned.

## C-09 Pre-charge authorization release pathways

The product/UX requires authorization release when a Deal fails or is cancelled before money is captured. Constitution v1.4 Money transitions list `ChargeFailedRecovery -> AuthReleased`, but do not explicitly list every pre-charge release path such as `AuthHeld -> AuthReleased` or `AuthLocked -> AuthReleased`.

Migration rule: no new pre-charge release transition may be invented in Base44. The authoritative release matrix must be versioned before these pathways are called constitution-complete.

## Resolution policy

- No AI agent may resolve these conflicts by renaming a state/action or adding a transition on its own.
- A conflict can be closed only by a new explicit constitution/database-contract version or a direct project-owner decision recorded in project status.
- Until resolved, production paths that depend on the conflict remain disabled or fail-closed.