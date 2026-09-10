# Receipt, seller identity and site content

This change extends the existing Postgres/Fastify/React product. It does not add logistics, financial states, payment operations, commissions or provider integrations.

## Receipt model

Migration `066_receipt_trust_content.sql` adds a nullable `deals.receipt_config`. The five values are `qr`, `code`, `name_phone`, `digital_link` and `instructions`. A seller can configure their own draft; the configuration is locked after publication. Existing deals keep their prior physical pickup flow, with voucher/code and ticket/QR defaults.

Entitlements remain the existing `fulfillment_units`, unique per participant and unit index. A read rechecks the canonical eligibility predicate: Completed deal, DealCompleted buyer, ChargedSuccess or RecoveredCharge money state. Failed, dropped, unsettled or refunded buyers receive no active artifact. Expired/voided units are never revived.

The new order-level code is a stable 128-bit random locator stored in unit metadata, with a unique index on the first unit. It is not an authorization credential. Buyer access always requires a participant-bound tracking token, even when legacy tracking links are enabled. Seller access requires authenticated seller identity and deal ownership. Public deal/profile endpoints never select digital URLs or participant contact details. Only a name explicitly opted into publication is returned, reduced to a safe first name.

Issuance and redemption lock the deal and participant, then units. Redemption changes only eligible Issued/Sent units, records an authenticated seller event, and returns after transaction commit. Concurrent repeats have one durable redemption and audit event. Previously redeemed units are excluded from the remaining quantity. The old unit redemption endpoint now rechecks participant eligibility too.

QR uses the existing qrcode-generator and browser scanner (native BarcodeDetector or jsQR). The new scanner decoder is optional; the physical pickup decoder remains the default. Camera access is user initiated. Typed codes and name/phone search remain available without camera access. A live device camera test remains an operational acceptance check, not a requirement for typed redemption.

## Surfaces

- `#/seller/new`: receipt choice in the existing creation flow; configuration failure leaves the draft available for repair.
- `#/seller/deal/:id`: receipt configuration and its publication lock.
- `#/deal/:id`: receipt summary before joining and compact public seller card. Joining waits for the receipt summary.
- `#/track/:id`: authenticated entitlement, instructions/link/code and optional public first-name preference.
- `#/seller/receipts`: seller search, camera scan and redemption.
- `#/seller/profile`: public name, About and logo/photo alongside the existing business profile.
- `#/public-seller/:id`: public identity, deterministic statistics and paginated historical deals.
- `#/admin/content`: fixed sections, preloaded editable content and image replacement.
- `#/content/about` and `#/content/legal_*`: content in the existing app shell. Existing `/legal/:slug` URLs also read the saved content.

The API implementation is in `receipt_content_routes.ts`; the static route inventory and live authorization gate include its routes. There are no changes to Grow or to the transition engine.

## Seller statistics

Published deals require `published_at IS NOT NULL` and a non-Draft state. Success rate is Completed / (Completed + Failed + Cancelled) among published deals, rounded to a whole percentage. No finalized deals means an unavailable rate, not fabricated success. Counts cover the whole history; display pages contain 24 deals and expose next/previous navigation. Sellers cannot write statistics.

## Content and storage

`site_content` holds allowlisted structured text sections, revision, updated time, authenticated admin identity and the previous value. Defaults use the existing legal and landing copy. Admin writes require the existing named administrative mutation guard and management permission; a bootstrap/read-only key cannot edit. Revision checks prevent one editor from overwriting another. Raw HTML is rejected and React renders text without HTML execution.

`content_assets` records the reference and owner of images stored through the canonical image validation/storage adapter. Only PNG/JPEG/WebP artifacts with matching signatures are accepted. Profile images must belong to that seller; homepage images must come from admin uploads. The existing orphan report recognizes these additional storage references. No user-supplied storage path is accepted. Migration 066 must be applied through the canonical migration runner before this code is deployed; this task does not deploy or apply migrations to production.

## Verification

`tests/receipt_content_integration_validation.ts` covers entitlement eligibility and uniqueness, cross-buyer/seller isolation, concurrent redemption, refunded unit refusal, all five methods, optional-name privacy, seller statistics/history, admin-only content mutation, persistence, revision conflicts, HTML rejection, canonical image storage and chat title constraints.

`node scripts/receipt_content_browser_proof.cjs` exercises the real React components with deterministic local API fixtures at 320/390/768/1440px. It checks vertical title/body layout, enforced title length, conditional receipt fields, all new screen widths and CMS preloading/edit submission. The API fixtures do not substitute for the separate database/authorization tests. Screenshots are local ignored artifacts. The complete regression outcome is recorded in PROJECT_STATUS.md.
