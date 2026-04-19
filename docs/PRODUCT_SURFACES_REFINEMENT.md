# Product Surfaces Refinement

Last updated: 2026-04-19

## Surfaces Aligned In This Pass

- Public deal page
- Seller workspace
- Seller dashboard
- Seller deal page
- Buyer tracking stayed as-is unless needed to preserve the main reading flow

## Current UX Direction

- Public deal pages should feel like real deal-product pages, not technical join forms.
- Seller workspace should answer three questions immediately:
  what needs attention now, what is still draft, and what is already closed.
- Seller deal pages should feel like a live control room:
  current state, progress, urgency, participant snapshot, and only allowed actions.

## What Mobile-First Means Here

- The public deal hero now collapses into a single readable column on narrow screens.
- Seller workspace summaries and seller deal status blocks stack cleanly on mobile instead of relying on desktop KPI strips.
- Primary CTA, progress, and state blocks stay visible without clipped text or side-by-side dependency.

## Accessibility Baseline Kept On These Screens

- Semantic section and heading hierarchy remains intact.
- Buttons and links stay distinct and keyboard reachable.
- Touch targets keep the larger baseline from the frontend foundation pass.
- Status, summary, and empty states remain visible and readable in both mobile and desktop layouts.

## Still Open For The Next Pass

- Deeper seller table interaction polish if inline filtering or bulk actions are added later.
- Optional richer media/gallery support once canonical read-only product media exists in live payloads.
- Buyer tracking can still get a dedicated refinement pass if we decide to deepen the post-join status narrative beyond the current aligned baseline.
