# Product Surface Focus Pass

Date: 2026-04-09

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
