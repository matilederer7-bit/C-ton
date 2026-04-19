# Buyer Tracking Refinement

Last updated: 2026-04-19

## States Covered

- PendingTarget
- TargetReached
- Closed for joining
- Charging
- Completion window / action-required follow-up
- Completed
- Failed
- Cancelled

## Current UX Principles

- The buyer tracking screen is the source of truth.
- The buyer should understand the current deal state, personal participation state, and money state without backend jargon.
- Authorization and real charge must stay clearly separated.
- The next step should always be visible:
  waiting, no action needed, or action required.

## What The Buyer Should Understand At Every Stage

- What happened already
- Whether only authorization exists or a real charge already happened
- Whether any action is required now
- What the system is waiting for next
- Whether the journey is still active or already closed

## Mobile-First Meaning In This Screen

- Status summary, next-step panel, and action / no-action message stay visible in the first scroll area.
- The supporting timeline and contextual cards collapse cleanly into a single readable column.
- Terminal states and action-required states remain readable without clipped banners or hidden context.

## Still Open For A Later Pass

- A dedicated deeper buyer-tracking pass if we want richer delivery or document follow-up narratives after completed deals.
- Optional route-level browser validation if we later add a focused browser harness for post-join buyer states.
