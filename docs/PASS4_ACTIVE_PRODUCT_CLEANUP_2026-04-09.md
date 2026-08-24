# [HISTORICAL] Active Product Cleanup Pass

> **V1.1 clarification (2026-08-23):** the prior removal of discovery was valid
> for its then-current scope but is superseded by the canonical focused Mall.

> **Note 2026-04-22:** this pass removed old marketplace framing in Apr 2026 but references `/app/marketplace` as a "redirect compatibility route". The canonical current product has no public marketplace surface at all. See [PROJECT_STATUS.md](/c:/Users/Lenovo/Documents/C-ton/PROJECT_STATUS.md).

Date: 2026-04-09 (historical)

## Goal

Sharpen the active Siton product surface so the live app no longer speaks in mixed marketplace / technical / placeholder language where the current product direction is already clear.

## What Was Cleaned

- Redirected the legacy `/app/marketplace` route to `/app`
- Removed marketplace handling from the active client route parser
- Strengthened the home page copy around:
  - seller-first entry
  - direct buyer link
  - no public browsing model
- Sharpened seller workspace copy and CTAs so they point to:
  - open deal
  - publish live page
  - manage deal
  - open public page
- Tightened seller creation and seller management language to match the active product story
- Updated active tests to verify the legacy route redirect

## Scope Boundaries

- No wide refactor
- No auth expansion
- No marketplace cleanup outside active product surfaces and compatibility routing
