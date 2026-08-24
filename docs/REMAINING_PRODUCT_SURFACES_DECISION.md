# [SUPERSEDED — NOT CANONICAL] REMAINING PRODUCT SURFACES DECISION

> **V1.1 clarification (2026-08-23):** the broad historical marketplace plan
> below is still not restored wholesale, but the later ban on all discovery was
> superseded. Current canon is the disciplined Mall defined in
> `SITON_V1_1_MALL_PRODUCT_DIRECTION.md`; distributor payout remains excluded.

> **STATUS: SUPERSEDED 2026-04-22.** This decision listed "Affiliate verification and payout readiness" and "Public marketplace search and discovery / Marketplace / mall / Amazon-style catalog experience" as live scope. Both are **NOT part of the current product**. Affiliate economic subsystem was dismantled in Wave 2.5; public marketplace/search was never part of the canonical 2026-04-18 spec. See [PROJECT_STATUS.md](/c:/Users/Lenovo/Documents/C-ton/PROJECT_STATUS.md) (Wave 4 Final Audit).

## Executive Decision (historical)

`PRODUCT CLOSED WITH ONLY EXTERNAL-ACTIVATION GAPS`

## What Was Missing Before This Pass

- Seller receipts
- Seller delivery operations after a deal closes successfully
- Affiliate attribution persistence
- Affiliate verification and payout readiness
- Admin KYC queue
- Admin settlements surface
- Admin support hub
- Admin deeper forensics around deal closure

## What Was Closed In This Pass

- Seller receipts surface with canonical eligibility:
  only `ChargedSuccess` and `RecoveredCharge`, and only on `Completed` deals
- Seller delivery persistence and operational updates
- Affiliate attribution persistence via `affiliate_ref` carried through the join flow
- Affiliate payout profile and verification status semantics
- Admin KYC queue and approve/reject actions
- Admin settlement overview for seller/platform/affiliate visibility
- Admin support hub and deeper deal forensics
- Product-surface validation for the newly closed areas

## What Is Now Closed Across Buyer / Seller / Affiliate / Admin

- Buyer:
  public deal, join, OTP, authorization, confirmation, tracking
- Seller:
  draft creation, publish, live deal view, completed-deal receipts, completed-deal delivery operations, create-similar
- Affiliate:
  campaign links, attribution visibility, verification state, payout readiness visibility, payout profile submission
- Admin:
  dashboard, omnisearch, exceptional deals, deal profile, user profile, KYC queue, settlement overview, support hub, deeper deal forensics

## What Is Still Open

- No internal blocker remained after this pass.
- The remaining gaps are all tied to activation of real external rails.

## What Is Open Only Because External Activation Did Not Start Yet

- Real invoice / receipt generation outside the repo
- Real shipping provider integration
- Real affiliate payout execution
- Real KYC provider activation
- Real support tooling outside the repo
- Real live payment provider and notification channels from previous passes

## What Is Product Expansion Rather Than Product Completion

- Public marketplace search and discovery
- Marketplace / mall / Amazon-style catalog experience

These already exist as expansion work and are not part of the closure decision for the original current spec.

## Recommended Next Step

Run the first controlled external-activation pass:

1. choose one external rail at a time
2. start with payment / receipts / payouts in a controlled staging-like environment
3. keep the newly closed internal surfaces as the canonical product contract while activating the real providers behind them
