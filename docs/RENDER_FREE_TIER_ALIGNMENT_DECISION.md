# Render Free Tier Alignment Decision

## Executive Decision

`RENDER FREE BLUEPRINT READY`

## What Was Inspected

- Existing `render.yaml`
- The currently selected Render pricing behavior
- Render Blueprint defaults for omitted plans
- Render support for free web and free Postgres plans

## What Was Causing Paid Pricing

- The Blueprint omitted explicit `plan` values.
- Render defaults therefore selected:
  - web service: paid default
  - database: `basic-256mb`

## What Was Changed

- Set the Render web service to `plan: free`
- Set the Render Postgres database to `plan: free`

## Why Blueprint Was Kept

- It remains the simplest and cleanest deployment path
- It avoids unnecessary manual setup drift
- It preserves the already prepared demo runtime path

## What Still Remains Demo-Only

- Payment
- Receipts
- Delivery semantics
- Affiliate payouts
- KYC
- Notifications

## What Is Still External-Only

- Git repo accessible by Render
- Render dashboard / account action
- All real external rails

## Recommended Next Step

- Re-open the updated Blueprint in Render
- Confirm the pricing now shows free-tier services
- If the workspace accepts free Postgres, deploy directly from the Blueprint
