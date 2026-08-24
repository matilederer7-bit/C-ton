# Frontend Browser Smoke

## What Was Checked

- public deal page
- public Siton Mall with multiple types/outcomes, filters, newest ordering, and
  canonical deal navigation
- seller workspace
- seller deal page
- signed-out seller entry, authentication/reauthentication, owner-bound Draft,
  image previews and persisted editing
- buyer tracking
- admin dashboard
- admin deal page
- participant ops
- not-found and missing-data browser fallbacks

## Smoke Scenario Set

- Desktop route open:
  open each central surface in a real headless browser and verify hydrated DOM contains the screen-specific hierarchy and primary action language.
- Mobile route open:
  repeat the critical routes at 390px and common iPhone/Android widths and
  verify touch filters, cards, image controls, titles, state framing, and CTAs
  remain present without horizontal overflow.
- Fallback sanity:
  open not-found, missing tracking, and missing participant-ops routes and verify they render readable empty/error states instead of a broken shell.

## Evidence Baseline

- The smoke suite uses a temporary local app runtime.
- It seeds physical-product, voucher, and ticket deals across active,
  target-reached, Completed, and Failed outcomes plus a joined participant.
- It opens the routes with Edge headless and validates the rendered DOM after hydration.

## What This Pass Proves

- The central screens open as a user-facing browser surface, not only as source-level functions.
- RTL/browser hydration does not collapse the main hierarchy on the tested routes.
- The main routes preserve readable state framing and CTA presence on desktop and narrow-mobile viewports.
- Missing-data and not-found states remain sane in the browser.

## Browser-Level Fixes Closed In This Pass

- `participant ops` now has a real browser shell route at `/app/admin/participants/:participantId` instead of falling through to a raw Fastify 404.
- unknown `/app/*` routes now fall back into the SPA shell, so not-found browser states render through the frontend instead of leaking raw JSON.

## External proof that remains

- Repository browser proof is synthetic and local. Final Base44 domain metadata,
  social previews, native camera/share behavior, and real-device rendering must
  be verified only after separately approved publication/domain activation.
- Screenshot evidence is written only to ignored `.ci-artifacts/`; it is test
  evidence, not a production-data capture channel.
