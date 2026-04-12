# Active Product Cleanup Pass

Date: 2026-04-09

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
