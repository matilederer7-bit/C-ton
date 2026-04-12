# Siton Product Direction Alignment

Last updated: 2026-04-09

## Canonical Decision

- Siton is a link-first group-deal platform.
- The main public surface is a strong Siton brand site, not a public marketplace.
- The main site must let any seller or deal initiator create a deal, generate a personal public deal page, and distribute a direct link.
- Buyers should enter a deal through the direct deal link.
- Public catalog browsing, searchable public discovery, and mall-style marketplace framing are out of scope for the current product direction.
- Core deal logic stays strict: no new states, no weakening of money-state or buyer-state rules, no weakening of the 90% rule, no confusion between authorization and actual charge, and no return of per-buyer purchase caps beyond total `max_units`.

## What Stays

- Direct-link public deal page
- Buyer OTP flow
- Authorization-only payment join flow
- Buyer tracking page
- Seller draft creation and basic deal management
- Strict state, audit, idempotency, locking, completion-window, and inventory enforcement

## What Drops Or Weakens Now

- Public marketplace search
- Public catalog framing on the main site
- Marketplace-expansion positioning in canonical status docs

## Current V1

- Strong Siton main site
- Seller deal creation
- Personal public deal page
- Direct distribution link
- Buyer quantity and delivery-option selection
- OTP
- Authorization only until deal closes successfully
- Buyer tracking
- Basic seller management

## Out Of Scope Right Now

- Public marketplace
- Public searchable discovery
- Mall / Amazon-style browsing
- Secondary expansion features before the core loop is fully aligned and hardened
