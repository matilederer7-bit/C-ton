# Frontend Browser Smoke

## What Was Checked

- public deal page
- seller workspace
- seller deal page
- buyer tracking
- admin dashboard
- admin deal page
- participant ops
- not-found and missing-data browser fallbacks

## Smoke Scenario Set

- Desktop route open:
  open each central surface in a real headless browser and verify hydrated DOM contains the screen-specific hierarchy and primary action language.
- Mobile route open:
  repeat the critical routes on a narrow viewport and verify the main title, status framing, and CTA copy remain present after hydration.
- Fallback sanity:
  open not-found, missing tracking, and missing participant-ops routes and verify they render readable empty/error states instead of a broken shell.

## Evidence Baseline

- The smoke suite uses a temporary local app runtime.
- It seeds one published deal and one joined participant.
- It opens the routes with Edge headless and validates the rendered DOM after hydration.

## What This Pass Proves

- The central screens open as a user-facing browser surface, not only as source-level functions.
- RTL/browser hydration does not collapse the main hierarchy on the tested routes.
- The main routes preserve readable state framing and CTA presence on desktop and narrow-mobile viewports.
- Missing-data and not-found states remain sane in the browser.

## Browser-Level Fixes Closed In This Pass

- `participant ops` now has a real browser shell route at `/app/admin/participants/:participantId` instead of falling through to a raw Fastify 404.
- unknown `/app/*` routes now fall back into the SPA shell, so not-found browser states render through the frontend instead of leaking raw JSON.

## What Remains Open

- This is a focused smoke pass, not a full browser lab.
- It does not add visual diffing or pixel-level clipping detection.
- If we later need deeper browser confidence, the next step is a small dedicated screenshot or interaction suite for seller/admin drill-downs.
