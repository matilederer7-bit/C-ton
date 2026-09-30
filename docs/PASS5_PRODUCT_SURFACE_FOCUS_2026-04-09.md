# [HISTORICAL] Product Surface Focus Pass

> **SUPERSEDED — HISTORICAL (2026-09-30).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. Its decisions, "canonical" lists and contracts describe an earlier state of the project. Product rules are in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`, the runtime in `docs/CURRENT_ARCHITECTURE_2026-09-30.md`, current state in `PROJECT_STATUS.md`.

> **V1.1 clarification (2026-08-23):** the no-public-discovery product decision
> below is historical. `/app` is now the single canonical Siton Mall/landing
> surface.

> **Note 2026-04-22:** references below to `/app/marketplace` and "legacy marketplace compatibility routes" describe a prior state. The canonical current product has no public marketplace / search / catalog surface at all, including no compatibility route. See [PROJECT_STATUS.md](/c:/Users/Lenovo/Documents/C-ton/PROJECT_STATUS.md).

Date: 2026-04-09 (historical)

## Primary Product Surface

- Main site
- Seller workspace
- Create deal
- Seller deal management
- Public deal page
- Buyer join flow
- Buyer tracking

## Secondary / Internal Surface

- Affiliate surface
- Admin surface
- Admin deal profile
- Admin user profile

These remain reachable by direct URL, but they are not part of the primary Siton product story and are no longer linked from the main product navigation.

## Legacy / Hidden Surface

- `/app/marketplace`

This route now redirects to `/app` and is no longer treated as an active product surface.

## What Changed

- Removed affiliate/admin links from the main product navigation
- Added internal-surface framing to affiliate/admin screens
- Kept internal routes reachable directly
- Preserved seller-first, direct-link buyer flow as the visible product surface
- Added active validation that the primary nav stays focused and that the legacy marketplace route redirects
