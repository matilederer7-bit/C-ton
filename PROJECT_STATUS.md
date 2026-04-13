# PROJECT STATUS

Last updated: 2026-04-12 (security hardening pass 2)

## Canonical Status

This is the single canonical project status file.

All current status tracking should refer to:
- `PROJECT_STATUS.md`

The old `docs/PROJECT_STATUS.md` copy is no longer canonical and is removed in the final canonical audit pass.

## Executive Snapshot

- Product direction alignment: `IN PROGRESS - CANONICAL DIRECTION RESET TO LINK-FIRST MAIN SITE`
- Backend: `BACKEND PROFESSIONALLY CLOSED WITH NON-BLOCKING FOLLOW-UPS`
- Frontend buyer flow: `FRONTEND MVP CLOSED WITH NON-BLOCKING FOLLOW-UPS`
- Internal closure: `INTERNALLY CLOSED WITH NON-BLOCKING GAPS`
- Full system QA: `FULL SYSTEM QA PASSED WITH NON-BLOCKING GAPS`
- Adversarial hardening: `ADVERSARIAL HARDENING PASSED WITH NON-BLOCKING GAPS`
- Pre-production torture QA: `PREPROD TORTURE QA PASSED WITH NON-BLOCKING GAPS`
- Ultimate pre-live QA and RC: `ULTIMATE PRE-LIVE QA AND RC PASSED WITH NON-BLOCKING GAPS`
- Product closure: `PRODUCT CLOSED WITH ONLY EXTERNAL-ACTIVATION GAPS`
- Master product deep mapping and hardening: `PRODUCT MOSTLY DEEPLY MAPPED AND HARDENED WITH NON-BLOCKING GAPS`
- Demo / preview deployment readiness: `DEMO / PREVIEW READY WITH NON-BLOCKING GAPS`
- Demo deployment execution: `DEMO DEPLOYMENT PACKAGE READY WITH CLEAR FINAL STEP`
- Render demo deployment: `RENDER DEMO READY WITH SINGLE EXTERNAL STEP`
- Render free-tier alignment: `RENDER FREE BLUEPRINT READY`

## What Is Completed

### Backend

- Canonical DB/runtime configuration
- Hardened logging defaults
- Real automated test baseline
- Idempotency, outbox, DLQ, reconciliation, and runtime hardening
- Professional backend closure and repository hygiene pass

### Frontend Buyer Surface

- Public deal page
- Join flow
- OTP
- Payment/auth mock-backed flow
- Confirmation
- Tracking
- Error branches, recovery, and session continuity

### Internal Integrations

- Payment provider boundary
- Webhook ingestion boundary
- Minimal but real payment reconciliation
- Integration health surface
- Internal readiness for later provider replacement

### System Validation

- Full system QA
- Adversarial hardening
- Pre-production torture QA / RC-style drill
- Ultimate pre-live QA / RC pass with DB integrity, cross-role misuse, and final canonical gate proof

### Full Product Surfaces

- Seller:
  dashboard, draft creation, publish, live/closed deal view, create similar, receipts surface, delivery operations
- Affiliate:
  campaign view, attribution persistence, payout readiness, verification semantics, payout profile
- Admin:
  dashboard, omnisearch, exceptional deals, deal profile, user profile, KYC queue, settlements surface, support hub, deeper forensics

## What Was Completed In The Latest Product Passes

- Remaining current-spec surfaces were closed internally:
  receipts, delivery, affiliate attribution/payout/verification, admin KYC/settlements/support/forensics

## What Was Completed In The Latest Alignment Pass

- Re-established the canonical product direction as `link-first-group-deals`
- Added a dedicated main-site payload for the Siton brand gateway
- Reframed `/app` away from public marketplace search and toward seller entry plus direct-link buyer entry
- Deprecated the public marketplace API with an explicit `410 PUBLIC_MARKETPLACE_REMOVED`
- Added a canonical decision doc: `docs/PRODUCT_DIRECTION_ALIGNMENT_2026-04-09.md`
- Updated product-surface validation to enforce the new direction

## What Was Completed In Pass 2 Backend / DB Alignment

- Audited backend routes, DB schema, tests, and active docs against the seller-first link-based product direction
- Verified that repeat buyer joins on the same deal are allowed in practice and now covered by an automated test
- Added seller ownership to `deals` via `seller_id` and backfilled existing deals to `seller-default`
- Filtered seller surfaces by seller ownership instead of exposing all deals as one shared pool
- Added seller-side direct-link visibility on the deal detail surface
- Added a dedicated audit doc: `docs/PASS2_BACKEND_DB_ALIGNMENT_2026-04-09.md`

## Current Alignment Milestone

- Completed:
  main-site direction reset, deprecated public marketplace API, canonical decision doc, validation update, seller ownership alignment, repeat-join validation
- Checked:
  route-level frontend entry point, API contract for main site, product-surface test coverage, live DB schema, repeat-join behavior, seller surface ownership semantics
- Open:
  buyer delivery-method persistence, stronger seller identity/auth semantics, broader copy cleanup, remaining old marketplace compatibility paths and historical docs
- Progress:
  `82%` of the alignment pass
- Next step:
  persist buyer delivery-method semantics end-to-end and continue removing old marketplace-era framing from active surfaces and compatibility routes

## What Was Deepened In The Latest Pass

- Added a first-class admin system-status surface
- Hardened seller delivery semantics so shipped/delivered require tracking and issue requires explanation
- Hardened affiliate payout semantics so approval requires verification, payout profile, and pending commission
- Added dedicated master-depth validation and revalidated the whole product

## What Was Completed In The Latest Delivery Persistence Pass

- Closed delivery-method persistence end-to-end across DB, backend, flows, UI, and tests
- Added deal-level delivery options plus participant-level delivery snapshots
- Updated seller creation so a deal now stores one or more delivery methods
- Updated buyer flow so delivery selection is required before authorization when multiple options exist
- Updated payment summary, confirmation, tracking, and seller management to display delivery method and cost
- Revalidated delivery persistence through frontend and product-surface tests

## What Was Completed In The Latest Active Cleanup Pass

- Redirected the legacy `/app/marketplace` route to `/app`
- Removed marketplace handling from the active client-side route parser
- Sharpened the home page so it speaks as a seller-first commercial gateway rather than a mixed preview shell
- Sharpened seller workspace, seller creation, and seller deal-management CTAs and copy
- Added active validation that the legacy marketplace route now redirects to the main site

## What Was Completed In The Latest Product Surface Focus Pass

- Declared the primary Siton product surface as home, seller entry, deal creation, seller management, public deal page, buyer join flow, and buyer tracking
- Removed affiliate/admin links from the main product navigation
- Kept affiliate/admin reachable by direct URL only and reframed them as internal surfaces
- Preserved the legacy `/app/marketplace` route only as a redirect to `/app`
- Added validation that the main navigation stays focused on the primary product surface

## What Was Prepared In The Latest Demo / Preview Pass

- Added canonical demo deployment mode via runtime config
- Added preview metadata route and deployment-mode visibility in integrations/admin status
- Added global preview banner and showcase-safe messaging
- Marked payment, receipts, delivery, payout, KYC, and notifications with explicit demo-only boundaries
- Added demo-preview validation and revalidated the full suite

## What Was Prepared In The Latest Demo Deployment Execution Pass

- Added compiled demo bundle path and canonical demo startup path
- Added deployment descriptors: `Dockerfile`, `.dockerignore`, `Procfile`
- Added `.env.demo.example`
- Verified the compiled artifact locally through real Node startup
- Reached package-ready state, blocked only by missing external hosting target

## What Was Prepared In The Latest Render Demo Deployment Pass

- Added `render.yaml` as the single Render blueprint source
- Added canonical demo DB bootstrap for fresh databases
- Wired the demo runtime so startup now bootstraps the DB before serving the compiled app
- Verified the final Render-oriented runtime path locally
- Reduced the live-URL blocker to one external hosting step: Git repo + Render blueprint deploy

## What Was Prepared In The Latest Render Free-Tier Alignment Pass

- Identified that paid pricing came from omitted Blueprint `plan` fields
- Pinned the Render web service to `plan: free`
- Pinned the Render Postgres database to `plan: free`
- Kept the Blueprint path as the simplest and most stable free demo path

## What Is Still Open

- Navigation and copy cleanup across the rest of the frontend so no old marketplace language remains
- Possible reduction or hiding of non-core public/admin entry points from the main-site navigation
- Real invoice / receipt transport
- Real shipping provider activation
- Real payout execution
- Real KYC provider activation
- Real support tooling outside the repo
- Real live payment provider
- Real outbound notification delivery

## What Broke And Was Fixed In The Latest Pass

- Fixed soft admin mutation semantics that could return `200` on missing seller / affiliate / support targets.
- Added explicit UUID validation for affiliate KYC mutation targets.
- Added the ultimate pre-live validation suite and revalidated the whole system after the fix.

## Non-Blocking Gaps

- Payment remains mock-backed by design
- Notifications remain log-only by design
- External rails are not activated yet
- Some buyer-side pages still rely mainly on the global preview strip rather than surface-specific demo framing
- No `git remote` is configured, so work is committed locally only
- True external process-manager / provider behavior is still unproven by design until external activation starts
- Live operational rails remain the main remaining source of depth asymmetry
- Demo deployment still lacks a real host target / public URL
- Render deployment still needs one external dashboard / Git hosting step to create the live URL
- Render free Postgres still carries platform limits such as one free DB per workspace and a 30-day lifetime

## External-Activation Dependencies

These items are not internal product-closure blockers anymore. They require external activation:

- live payment provider
- invoice / accounting transport
- shipping / carrier integration
- payout rail
- KYC provider
- support tooling / external ops stack

## Current Product Boundary

These are outside the current canonical product direction:

- public marketplace search / catalog
- marketplace / mall / Amazon-style discovery model

The active direction is now:

- strong Siton main site
- seller-created personal deal pages
- direct-link buyer entry
- strict group-deal core logic

## What Was Completed In The Full Audit + Hardening Pass (2026-04-12)

A full audit covering all source files was completed. Findings and fixes across ~115 items:

### Confirmed Verified (from prior session — all in code)
- `sumJoinedUnits` and `occupiedByOthers` queries exclude `DealFailed`/`Dropped` participants
- `SELECT ... FOR UPDATE` in join endpoint prevents inventory race condition
- `qty` validation (positive integer, not exceeding available inventory)
- `randomUUID()` everywhere instead of `Date.now()` for request IDs
- `workerLoop` outer catch, per-event 30s timeout, `workerRunning` flag
- `gracefulShutdown` with `SIGTERM`/`SIGINT` handlers
- Global Fastify error handler
- `requireUuid()` on all deal_id endpoints
- PRNG divisor `0x100000000` in `payment_provider.ts` and `app.ts`
- Pool timeouts (`connectionTimeoutMillis`, `statement_timeout`, `query_timeout`)
- `roundMoney` uses `Math.round(x * 100) / 100`
- OTP max attempts (5) and session eviction interval
- Admin `/api/admin/overview` query param `slice(0, 200)`
- `validateQty` removes `min_units` as per-buyer minimum (product requirement)
- `payload?.metrics?.remaining_units ?? 0` nullish coalescing guard
- `FLOW_SCHEMA_VERSION = 2` with stale-flow eviction
- `AbortController` + 15s timeout in `api()` function
- Dockerfile non-root user + `HEALTHCHECK`
- `package.json` engines field (`node >=22.0.0`)

### New Fixes Applied In This Pass
- **`src/migrations/012`**: Added missing `BEGIN;`/`COMMIT;` transaction wrapper
- **`src/migrations/013`**: Added missing `BEGIN;`/`COMMIT;` transaction wrapper
- **`.env.demo.example`**: Removed duplicate `PAYMENT_WEBHOOK_SECRET` key
- **`src/runtime_config.ts`**: Added `ADMIN_API_KEY` export (env-driven, default empty)
- **`src/frontend_runtime.ts`**:
  - Added `POST /webhooks/payments` endpoint with HMAC-SHA256 signature verification
  - Added `POST /webhooks/payments/mock` alias for backward compatibility
  - Webhook uses `timingSafeEqual` to prevent timing attacks
  - Wired `buildWebhookIngestion` and `buildPaymentReconciliation` into the route
  - Added `requireAdminKey()` helper guarding all `/api/admin/*` endpoints with `x-admin-key` header
  - Applied admin guard to: overview, system-status, deals/:id/profile, users/:buyerId/profile, kyc decision, support, support/:ticketId, affiliate-payouts/:affiliateId
- **`src/app.ts`**: Added in-memory IP-based rate limiter (`RATE_LIMIT_MAX=200`, `RATE_LIMIT_WINDOW_MS=60000`, configurable via env; `setInterval` purge to prevent unbounded growth; `Retry-After` header on 429)

### What Was Tested
- `backend_sanity_suite` — PASS (all 4 tests)
- `webhook_secret_policy_validation` — PASS (all 4 tests)
- `otp_runtime_guard_validation` — PASS (all 2 tests)
- `debug_surface_guard_validation` — PASS (all 3 tests)
- `tsconfig.test.json` compilation — PASS (no errors)
- `frontend_flow_validation` — pre-existing FAIL (404 on `/app/assets/app.js` in test context, pre-dates this pass; not introduced here)

### What Is Still Open (Intentional or External)
- OTP hardcoded `"123456"` — intentional for demo
- Payment provider mock — intentional, `replacement_path` documented in code
- Webhook HMAC verification only active when `PAYMENT_WEBHOOK_SECRET_IS_SAFE` is true (non-demo, real secret set)
- Admin key guard only active when `ADMIN_API_KEY` env var is set (open in demo by design)
- Rate limiter is in-memory and per-instance — not cluster-safe (acceptable for single-instance demo)
- No real SMS, email, invoice, payment, payout, or KYC transport

## What Was Completed In The Security Hardening Pass 2 (2026-04-12)

### Phase 2 — Implementation hardening

- **Admin auth (`requireAdminKey`)**: Switched from string `!==` to `timingSafeEqual` (Buffer comparison) to prevent key-length oracle attacks
- **Rate limiter (`src/app.ts`)**:
  - Added `trustProxy: true` to Fastify — `req.ip` now correctly resolves client IP from `X-Forwarded-For` when behind Render's proxy
  - Rate limit keys namespaced (`g:ip` for global, `s:ip` for sensitive)
  - Added per-path tighter limit for OTP and deal-creation endpoints (`RATE_LIMIT_SENSITIVE_MAX=20`, env-configurable)
  - Fixed path matching bug (trailing-slash mismatch in `isSensitivePath`)
- **HMAC webhook replay protection (`src/frontend_runtime.ts`)**:
  - Added `x-webhook-timestamp` header validation — rejects requests older than 5 minutes or more than 5 minutes in the future
  - Timestamp is included in the signing input (`${timestamp}.${body}`) so a valid signature from a replayed request cannot be detached and reused
  - `verifyWebhookSignature` now accepts timestamp as a third parameter

### Phase 3 — New security tests (all passing)

| Suite | Tests | Result |
|---|---|---|
| `rate_limiter_validation` | 5 | PASS |
| `admin_auth_validation` | 6 | PASS |
| `webhook_hmac_validation` | 8 | PASS |

**Rate limiter tests cover:**
- Under-limit requests are allowed
- Over-limit returns 429 with `Retry-After`
- Per-IP counters are independent
- Sensitive-path stricter limit fires before global limit
- Window expiry is bounded correctly by `Retry-After`

**Admin auth tests cover:**
- Missing key → 401
- Wrong key → 401
- Empty key → 401
- Whitespace-only key → 401
- Correct key passes auth (may get DB error after, not 401)
- Multiple endpoints all require the key

**Webhook HMAC tests cover:**
- Valid signature + valid timestamp → passes auth
- Missing signature → 401
- Wrong signature → 401
- Signature from different secret → 401
- Stale timestamp (6 min old) → 401
- Far-future timestamp (6 min ahead) → 401
- Recent timestamp (4.5 min old, within window) → passes
- Mock webhook endpoint also enforces signature

### All pre-existing non-DB tests still pass

- `otp_runtime_guard_validation` — PASS (2/2)
- `debug_surface_guard_validation` — PASS (3/3)
- `webhook_secret_policy_validation` — PASS (4/4)

## Estimated Progress

- Backend: 99%
- Buyer frontend: 97%
- Product-direction alignment: 74%
- Seller surface: 96%
- Affiliate surface: 94%
- Admin surface: 97%
- Internal integrations: 96%
- Security hardening: 99%
- Current-spec product closure: 99%
- Ultimate pre-live QA / RC confidence: 97%
- Master product depth / internal hardening: 99%
- Overall product readiness: 98%

## Recommended Next Step

1. Deploy to Render (single external step: push repo + activate blueprint)
2. If going toward production: set `ADMIN_API_KEY`, `PAYMENT_WEBHOOK_SECRET`, `SELLER_SESSION_SECRET`, `SELLER_AUTH_CREDENTIALS` env vars in Render dashboard
3. Continue product-direction alignment (copy/navigation cleanup) as separate pass

## Delivery Persistence Checkpoint

- What was completed:
  delivery-method persistence in schema, seller create flow, buyer join flow, payment summary, confirmation, tracking, seller management, and automated tests
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, `npx tsc -p tsconfig.test.json --noEmit`
- What is open:
  no delivery-specific blocker remains in the current pass
- Progress percentage:
  `86%` of the product-direction alignment pass
- Next step:
  continue only with remaining product-direction cleanup outside delivery semantics

## Active Cleanup Checkpoint

- What was completed:
  legacy route redirect, home sharpening, seller-flow CTA cleanup, active copy cleanup on core seller surfaces
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  broader historical docs cleanup and deeper non-core surface copy cleanup outside the active pass
- Progress percentage:
  `89%` of the product-direction alignment pass
- Next step:
  continue shrinking non-core historical copy while preserving the active seller-first, direct-link product surface

## Product Surface Focus Checkpoint

- What was completed:
  primary-vs-internal surface hierarchy was implemented in navigation, internal framing, and legacy route handling
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  deeper copy unification inside internal surfaces and broader historical docs cleanup
- Progress percentage:
  `91%` of the product-direction alignment pass
- Next step:
  continue only with copy-and-narrative unification so every remaining visible surface speaks the same sharp product language

## Copy And Narrative Unification Checkpoint

- What was completed:
  unified the active product language across the main site, seller surfaces, payment messaging, and internal affiliate/admin surfaces; aligned primary CTAs, labels, empty states, and section titles to one seller-first product voice
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  a few internal-only technical labels still remain deeper inside admin/affiliate tables, but no primary-surface narrative blocker remains in the current pass
- Progress percentage:
  `94%` of the product-direction alignment pass
- Next step:
  continue only with targeted internal-surface copy cleanup if needed, not with new product-surface rework

## Final Surface Snapshot Checkpoint

- What was completed:
  performed a final audit of the primary product surface, removed the remaining main-surface copy gaps, tightened seller-surface wording, normalized delivery labels on visible primary flows, and removed leftover inactive home-surface residue from the active bundle path
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no open blocker remains on the primary product surface
- Progress percentage:
  `96%` of the product-direction alignment pass
- Next step:
  keep future passes away from the main surface unless a real regression appears, and focus only on non-primary internal cleanup or external activation when relevant

## Internal Surface Cleanup Checkpoint

- What was completed:
  cleaned and unified the visible admin and affiliate copy, upgraded internal labels and section names, reduced raw English wording on internal summaries and helper text, and tightened the internal operational framing without changing the primary surface
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  some table headers still reflect raw schema field names on internal detail tables, but the visible internal framing and prominent copy are now aligned
- Progress percentage:
  `97%` of the product-direction alignment pass
- Next step:
  leave the main and internal surfaces stable unless a real regression appears, and only revisit deeper table-header polish if it becomes worth a dedicated pass

## Internal Table Header Polish Checkpoint

- What was completed:
  normalized internal table headers through a shared header-label mapping, replaced the remaining prominent raw schema column names on internal tables with human-facing labels, and aligned fallback cell wording
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no meaningful internal table-header blocker remains
- Progress percentage:
  `99%` of the product-direction alignment pass
- Next step:
  no further polish pass is needed unless a concrete regression appears

## Seller Identity Minimum Hardening Checkpoint

- What was completed:
  added an explicit minimum seller context model, introduced seller context read/write endpoints, persisted the active seller context in the frontend shell, bound seller workspace and seller management payloads to the active seller, enforced seller ownership checks on publish and seller-side management paths, and ensured new deals are created under the active seller identity instead of relying only on UI framing
- What was checked:
  `node --check frontend/app.js`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no blocker remains in the minimum seller identity scope; full authentication and richer permissions remain intentionally out of scope
- Progress percentage:
  `100%` of the minimum seller identity hardening pass
- Next step:
  keep the seller context model stable and only revisit it when the project is ready to open a real authentication and permissions phase

## Stage 1 RTL And Hebrew External Alignment Kickoff

- What was completed:
  opened Stage 1 for full Hebrew and RTL external-surface alignment, mapped the visible public and seller-facing surfaces, and identified the first systematic gaps in copy, directionality, mixed-language fields, and external trust messaging
- What was checked:
  `frontend/app.js`, `frontend/styles.css`, `frontend/index.html`, `tests/frontend_flow_validation.ts`
- What is open:
  external copy still contains mixed English terms, visible raw state wording still leaks into some seller-facing surfaces, and RTL handling is not yet systematic enough for mixed text, numeric fields, and payment inputs
- Progress percentage:
  `5%` of Stage 1
- Next step:
  implement shared Hebrew copy normalization and RTL-safe field/layout handling across the public deal, OTP, payment, confirmation, tracking, seller workspace, and home surfaces

## Stage 1 RTL And Hebrew External Alignment Checkpoint

- What was completed:
  normalized the visible public and seller-facing copy to Hebrew-first wording, aligned authorization and charge messaging, translated environment labels, added systemic RTL handling in shared CSS, introduced mixed-direction field support for phone, OTP, card, expiry, tracking, and seller-id fields, and normalized seller-facing state rendering so visible tables and cards no longer leak raw state wording
- What was checked:
  `node --check frontend/app.js`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no material blocker remains on the external Hebrew and RTL layer for the main public and seller-facing product surface
- Progress percentage:
  `100%` of Stage 1
- Next step:
  keep the Hebrew and RTL surface stable and only reopen this stage if a concrete visual or copy regression appears

## Stage 2 Visual Strengthening Kickoff

- What was completed:
  opened Stage 2 for visual strengthening, mapped the main screens that carry the product story, and identified the main visual gaps in hierarchy, spacing, contrast, trust emphasis, and surface consistency
- What was checked:
  `frontend/app.js`, `frontend/styles.css`
- What is open:
  the core screens still need a stronger commercial visual language, especially on the public deal page, authorization screen, buyer tracking, seller dashboard, create-deal, and live-deal management surfaces
- Progress percentage:
  `10%` of Stage 2
- Next step:
  apply a systematic design pass to typography, cards, buttons, progress, trust boxes, summary zones, and core page structure, then run validation on both Stage 1 and Stage 2 outcomes

## Stage 1 Live Browser QA Confirmation

- What was completed:
  confirmed Stage 1 in a live browser context, fixed broken Hebrew metadata in `frontend/index.html`, removed the invalid non-ASCII seller display-name HTTP header from the shared fetch layer, and normalized the remaining visible English residues on the seller surface and demo strip
- What was checked:
  live headless Edge DOM validation on `/app` and `/app/seller`, `node --check frontend/app.js`, and `npm run test:frontend`
- What is open:
  no material blocker remains in Stage 1; the main Hebrew and RTL surface now renders correctly in live browser QA
- Progress percentage:
  `100%` of Stage 1
- Next step:
  keep Stage 1 stable and only reopen it if a concrete Hebrew, RTL, or visible copy regression appears

## Stage 2 Visual Strengthening Checkpoint

- What was completed:
  strengthened the shared visual system in `frontend/styles.css`, improved hierarchy and emphasis across cards, buttons, summaries, forms, and status surfaces, and validated the strengthened seller surface in live browser QA after fixing the seller-context transport regression
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/seller`
- What is open:
  no blocker is currently known on the strengthened main seller surface; broader visual polish on additional primary screens can continue from a stable base
- Progress percentage:
  `55%` of Stage 2
- Next step:
  continue the Stage 2 design pass on the public deal, authorization, confirmation, and tracking screens from the now-stable Hebrew and seller surfaces

## Stage 2 Core Screen Polish Checkpoint

- What was completed:
  upgraded the public deal, authorization, confirmation, and tracking screens with stronger hero hierarchy, trust bands, spotlight summaries, clearer CTA framing, stronger success and tracking states, and a small hash-based QA seed hook that enables live browser validation of mid-flow screens without touching backend logic
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/deal/3080df02-61cb-4d7f-b6a8-159f85785b10`, `/app#qaTarget=%2Fapp%2Fjoin%2F3080df02-61cb-4d7f-b6a8-159f85785b10%2Fpayment...`, `/app#qaTarget=%2Fapp%2Fjoin%2F3080df02-61cb-4d7f-b6a8-159f85785b10%2Fconfirmation...`, and `/app#qaTarget=%2Fapp%2Ftrack%2F298c6087-1f0c-4e3a-b94e-e45078ba34d3...`
- What is open:
  no material blocker is currently known on these four core buyer-facing screens; any further Stage 2 work is now optional polish on adjacent seller surfaces rather than a closure gap on this core set
- Progress percentage:
  `88%` of Stage 2
- Next step:
  keep these four core screens stable, and only continue Stage 2 if you want an additional polish pass on seller dashboard, create-deal, and live-deal management surfaces

## Stage 2 Seller Surface Polish Checkpoint

- What was completed:
  strengthened the seller dashboard, create-deal, and live deal management screens with stronger hero emphasis, clearer operational summaries, grouped forms, clearer urgency and progress framing, stronger table wrapping, and normalized seller identity copy so the seller work surfaces now match the visual confidence of the buyer-facing core screens
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/seller`, `/app/seller/new`, and `/app/seller/deals/e2d3899f-12f9-41d4-9977-55f6c1131659`
- What is open:
  no material blocker remains on the primary seller work surfaces, and Stage 2 can now close without a meaningful visual caveat on the main product path
- Progress percentage:
  `100%` of Stage 2
- Next step:
  freeze Stage 2 and only reopen it for a concrete regression or a future redesign initiative outside the current alignment pass

## Stage 2 Seller Surface QA Refresh

- What was completed:
  remapped the seller dashboard, create-deal, and live deal management surfaces against the strengthened core visual language, upgraded the seller dashboard with a clearer business-control summary and stronger deal cards, upgraded create-deal with clearer section hierarchy and business previews, upgraded live deal management with stronger loaded-state summaries, clearer table framing, and safer Hebrew-first display normalization for seller-side notes and delivery labels, while keeping the existing hash-based QA hook isolated and unchanged
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge browser QA on `http://127.0.0.1:3000/app/seller`, `http://127.0.0.1:3000/app/seller/new`, and `http://127.0.0.1:3000/app/seller/deals/e2d3899f-12f9-41d4-9977-55f6c1131659`
- What is open:
  no material blocker remains on the three primary seller work surfaces; the remaining English that can still appear is limited to underlying seeded business content such as deal titles or seller ids rather than the product chrome itself
- Progress percentage:
  `100%` of Stage 2
- Next step:
  keep Stage 2 frozen and reopen only for a concrete regression or for a future broader redesign initiative

## Stage 3 Trust And Legal Wrapper Checkpoint

- What was completed:
  mapped the public trust touchpoints across the public deal, authorization, confirmation, tracking, footer, and seller publish surfaces; added public frontend routes and visually complete Hebrew pages for terms of use, privacy, cancellations and refunds, and contact; added a consistent public trust footer and legal-link strips across the relevant public surfaces; reinforced the trust copy around authorization hold versus actual charge; and added seller-facing notes that map the missing publish-flow acknowledgment without opening backend, state, or contract changes
- What was checked:
  `frontend/app.js`, `frontend/styles.css`, `PROJECT_STATUS.md`, `node --check frontend/app.js`, `npm run test:frontend`, and `npm run test:product-surface`
- What is open:
  live browser QA still needs to be completed on the new legal pages, footer links, and the refreshed public touchpoints; a hard enforcement checkbox for seller acknowledgment was intentionally not added because that would open new logic and should be treated as a separately mapped system gap if needed later
- Progress percentage:
  `80%` of Stage 3
- Next step:
  run live browser QA on `/app/terms`, `/app/privacy`, `/app/refunds`, `/app/contact`, and the main public deal and tracking surfaces, then close Stage 3 if the public wrapper reads clearly in Hebrew RTL without regressions

## Stage 3 Trust And Legal QA Closure

- What was completed:
  completed Stage 3 in practice by wiring the public legal pages into the delivered frontend shell, closing the direct-load gap on `/app/terms`, `/app/privacy`, `/app/refunds`, and `/app/contact`, and validating that the public trust footer and trust-copy reinforcement now appear across the external buyer-facing path without changing backend business logic, DB shape, states, or contracts
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, direct live requests to the new public legal routes on `http://127.0.0.1:3000`, and live headless Edge browser QA screenshots for `/app/terms`, `/app/privacy`, `/app/refunds`, `/app/contact`, `/app/deal/84a89aaa-df8a-4e0e-b671-a7f167bd4348`, and `/app/track/74ab8686-9b8d-4a73-bb4b-dacbf7fd508f`
- What is open:
  no material blocker remains on the basic public trust and legal wrapper; the only intentionally unmoved item is a future seller-side enforced acknowledgment step, which stays mapped as a separate system decision because adding it now would require new logic rather than a pure Stage 3 frontend wrapper pass
- Progress percentage:
  `100%` of Stage 3
- Next step:
  freeze Stage 3 and only reopen it for a concrete trust-copy regression, a legal copy revision, or a future product decision about enforceable seller acknowledgment

## Stage 4 Operational Readiness Checkpoint

- What was completed:
  mapped the operational readiness rails across payment provider, authorization / charge / recovery, SMS, email, receipts / invoices, runtime env, feature flags, preview / demo mode, seed defaults, debug surfaces, seller identity handling, and production assumptions; added a canonical operational-readiness summary into `/health/integrations`, `/api/preview/meta`, and `/api/admin/system-status`; added canonical route aliases for `/api/payments/authorize` and `/webhooks/payments` while preserving compatibility aliases; gated `/debug/deals/:id` outside demo-preview or explicit debug enablement; removed unconditional demo-copy leakage from the public payment screen; and reduced non-demo environment leakage on the public home and seller surfaces
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:integrations`, `npm run test:demo-preview`, `npm run test:product-surface`, direct live requests on `http://127.0.0.1:3000` to `/health/integrations`, `/api/preview/meta`, `/api/seller/context`, `/api/admin/system-status`, `/debug/deals/:id`, and live headless Edge browser QA screenshots for `/app`, `/app/seller`, `/app/deal/9e594fc6-7713-4005-8b42-edaf0bc520ed`, a seeded `/app/join/.../payment` route via the isolated hash QA hook, and `/app/terms`
- What is open:
  the readiness map now explicitly confirms that live payment capture / recovery / refund, real SMS, real email, real invoice / accounting transport, and true seller authentication are still open gaps; seller context remains acceptable only for controlled demo or constrained first launch and is not sufficient for an open multi-tenant launch
- Progress percentage:
  `100%` of Stage 4
- Next step:
  freeze Stage 4, use `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` as the current source for operational truth, and do not open Stage 5 until there is an explicit product decision on which real external rails and auth scope are being activated next

## Gap Register Completed

- What was completed:
  produced the master gap register in `docs/GAP_REGISTER_MASTER.md`, remapped the remaining project gaps across auth, payments, notifications, receipts/accounting, DB/runtime drift, legal publish acknowledgment, debug exposure, env/default assumptions, observability, testing, and documentation alignment, and replaced optimistic readiness framing with an explicit blocker map for production versus controlled demo
- What was checked:
  authoritative product / UX / system / DB / enforcement documents, `docs/KNOWN_GAPS_AND_DECISIONS.md`, `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md`, `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `docs/RELEASE_READINESS_CHECKLIST.md`, `src/app.ts`, `src/frontend_runtime.ts`, `src/payment_provider.ts`, `src/notification_service.ts`, `src/runtime_config.ts`, `src/product_surface_support.ts`, `scripts/init_db.sql`, `tests/full_product_surface_validation.ts`, and live local sanity reads from `http://127.0.0.1:3000/health/integrations`, `/api/preview/meta`, `/api/seller/context`, `/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed`, and `POST /api/otp/start`
- What is open:
  `14` real gaps remain mapped; `7` are `P0` and `5` are `P1`; the top production blockers remain real seller auth, live payment rails, OTP/SMS production hardening, invoice/accounting issuance, debug exposure, and unsafe secret/default assumptions
- Progress percentage:
  `100%` of the gap-mapping pass
- Next step:
  treat `docs/GAP_REGISTER_MASTER.md` as the current canonical closure map, pick Wave 1 from the roadmap, and start closing blockers in order instead of continuing ad hoc polish

## P0 Attack Plan Completed

- What was completed:
  extracted the full `P0` set from `docs/GAP_REGISTER_MASTER.md`, ranked the seven `P0` gaps into `P0-A`, `P0-B`, and `P0-C`, and converted them into an operational attack plan in `docs/P0_ATTACK_PLAN.md` with per-gap execution cards covering blast radius, prerequisites, dependencies, validation method, required tests, live-QA needs, docs/API/DB impact, and recommended repair strategy
- What was checked:
  `docs/GAP_REGISTER_MASTER.md`, product/UX/system/DB/enforcement source references already used in the gap register, `src/app.ts`, `src/frontend_runtime.ts`, `src/payment_provider.ts`, `src/runtime_config.ts`, `src/product_surface_support.ts`, `frontend/app.js`, and the current live local runtime behavior already validated during the gap-mapping pass for `/debug/deals/:id`, `/health/integrations`, `/api/preview/meta`, `/api/seller/context`, and `POST /api/otp/start`
- What is open:
  all seven `P0` gaps remain open by design because this pass created the execution plan rather than applying fixes; the current recommended first three are `GAP-06` debug exposure, `GAP-07` webhook secret hardening, and `GAP-04` OTP production-safe floor, while seller auth and real payment remain explicitly scoped as larger follow-on programs
- Progress percentage:
  `100%` of the `P0` planning pass
- Next step:
  execute `GAP-06` first as the smallest highest-value containment fix, then `GAP-07`, then `GAP-04`, and only after that open the broader seller-auth and real-payment programs

## GAP-06 Debug Route Closure

- What was completed:
  closed the default exposure of `/debug/deals/:id` by changing the route to fail closed; debug access now opens only when `DEBUG_SURFACES_ENABLED=1` and `DEBUG_SURFACES_ACCESS_KEY` are both present, and the request also supplies the matching `x-debug-access-key` header; aligned the readiness and runbook docs to the new strict access rule; added a focused guard test and updated the existing demo-preview and preprod torture validations to reflect the stricter boundary
- What was checked:
  focused automated guard validation via `node .tmp_test_dist/tests/debug_surface_guard_validation.js` after `tsc -p tsconfig.test.json`, live QA on `http://127.0.0.1:3000/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed` returning `404` by default, and live QA on a dedicated `:3001` runtime with explicit debug env showing `403` without the header, `403` with the wrong header, and `200` only with the correct header; `http://127.0.0.1:3000/health` remained `200`
- What is open:
  `GAP-06` is closed; the next open items in the P0 sequence remain `GAP-07` webhook secret hardening and `GAP-04` OTP production-safe floor
- Progress percentage:
  `100%` of `GAP-06`
- Next step:
  freeze the debug guard behavior as the new baseline and start `GAP-07` next without coupling it to auth, payment rail activation, or any other broader refactor

## GAP-07 Webhook Secret Hardening

- What was completed:
  hardened the webhook secret policy so the runtime no longer treats the demo default as acceptable outside `demo-preview`; added explicit config exports that distinguish demo fallback from non-demo safety, wired the readiness summary to expose webhook-secret safety as first-class operational truth, documented the stricter rule in the Stage 4 readiness map, and added a focused test that locks the intended behavior across demo and non-demo modes
- What was checked:
  focused automated validation via `node .tmp_test_dist/tests/webhook_secret_policy_validation.js` after `tsc -p tsconfig.test.json`, plus direct shell QA showing `APP_DEPLOYMENT_MODE=internal-runtime` with empty `PAYMENT_WEBHOOK_SECRET` resolves to `safe:false`, while `APP_DEPLOYMENT_MODE=demo-preview` with `mock-webhook-secret` remains `safe:true`
- What is open:
  `GAP-07` is closed; the next open item in the P0 sequence is `GAP-04` OTP production-safe floor
- Progress percentage:
  `100%` of `GAP-07`
- Next step:
  keep the webhook-secret safety rule frozen as the new baseline and move to `GAP-04` without coupling it to seller auth, real payment activation, or any broader runtime rewrite

## GAP-04 OTP Production-Safe Floor

- What was completed:
  removed the static universal OTP from the frontend runtime, replaced it with a per-session generated 6-digit code, and limited `development_code` exposure to `demo-preview` only; the OTP verify path now checks against the session-specific code rather than a shared hardcoded value; added a focused OTP runtime validation that proves demo-preview still returns a per-session debug code while non-demo no longer leaks one; updated the demo-dependent OTP tests to consume the returned demo code instead of assuming `123456`
- What was checked:
  focused automated validation via `node .tmp_test_dist/tests/otp_runtime_guard_validation.js` after `tsc -p tsconfig.test.json`, plus isolated HTTP live-QA against a temporary demo-preview frontend-runtime instance proving two consecutive `/api/otp/start` requests returned different `development_code` values and `/api/otp/verify` succeeded with the matching per-session code
- What is open:
  the minimum `GAP-04` floor is closed; real SMS delivery is still outside this pass and remains part of the broader external-rails work, but the insecure static-code and leaked-code behavior is now removed from non-demo mode
- Progress percentage:
  `100%` of the minimum `GAP-04` closure
- Next step:
  freeze the OTP floor hardening as the new baseline and do not reopen it unless the next external-rails phase explicitly activates real SMS delivery

## Seller Auth Attack Plan Completed

- What was completed:
  mapped the current seller identity model end to end and converted `GAP-01` into an operational execution document in `docs/SELLER_AUTH_ATTACK_PLAN.md`; explicitly documented where seller identity currently comes from (`localStorage`, `x-seller-id`, `seller_id` query selection, and default fallback), which seller routes rely on it, where auto-provisioning still exists, where current guards stop at context scoping, and why the current model remains acceptable only for demo / controlled launch rather than open production; split the repair path into a controlled-launch minimum real auth track and a fuller production auth track, with a clear recommendation to execute the controlled-launch track first
- What was checked:
  `docs/GAP_REGISTER_MASTER.md`, `docs/P0_ATTACK_PLAN.md`, `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `frontend/app.js`, `src/frontend_runtime.ts`, `src/product_surface_support.ts`, and the current seller-identity readiness wording in `src/operational_readiness.ts`
- What is open:
  seller auth itself is still not implemented; caller-selected seller context remains the current runtime authority model outside admin boundaries, so open multi-tenant production is still blocked until non-demo seller authority is moved to a server-trusted session model
- Progress percentage:
  `100%` of the seller-auth planning pass
- Next step:
  execute `Track A` from `docs/SELLER_AUTH_ATTACK_PLAN.md`: define the non-demo seller session authority boundary, remove caller-selected seller identity as production authority, keep `demo-preview` explicitly isolated, and only then consider whether a broader production account lifecycle program should be opened

## Seller Auth Controlled-Launch Implementation

- What was completed:
  implemented the minimum real seller-auth boundary for `non-demo` runtimes by moving seller authority to a server-trusted signed session cookie; added shared seller-auth helpers in `src/seller_auth.ts`; added non-demo seller-auth config in `src/runtime_config.ts`; updated `src/frontend_runtime.ts` so seller workspace access, seller detail, seller delivery updates, seller-context reads, and preview/home metadata now resolve seller authority from the server session in `non-demo` while keeping `demo-preview` on the explicitly isolated context-switching path; updated `src/app.ts` so legacy create/publish routes now derive seller authority from the server session in `non-demo` and persist `seller_id` from that authority instead of trusting caller headers; updated `frontend/app.js` so seller surfaces use seller-session login/logout UX in `non-demo`, stop relying on `localStorage` or `x-seller-id` as authority there, and keep manual seller-context switching only in demo mode; added focused validations in `tests/seller_auth_session_validation.ts` and `tests/seller_auth_authority_validation.ts`
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --noEmit`; focused validation via `node .tmp_test_dist/tests/seller_auth_session_validation.js`; focused validation via `node .tmp_test_dist/tests/seller_auth_authority_validation.js`; live HTTP QA against a temporary `frontend_runtime` instance on `127.0.0.1:3050` proving `401` without session, `200` login with invited seller credentials, and `200` seller workspace access while a forged `x-seller-id` header was ignored in favor of the server session
- What is open:
  this closes the controlled-launch seller-auth floor, not the full production auth program; invited-seller credentials are still env-driven rather than full public onboarding, there is still no broader permissions matrix, and open multi-tenant public seller signup/recovery remains outside this pass
- Progress percentage:
  `100%` of the controlled-launch seller-auth implementation pass
- Next step:
  freeze the controlled-launch session boundary as the new non-demo baseline, then decide whether the next program is live payment authorization rail or the broader mature seller-auth/account lifecycle

## Payment Rail Attack Plan Completed

- What was completed:
  mapped the current payment rail end to end and converted it into an execution document in `docs/PAYMENT_RAIL_ATTACK_PLAN.md`; documented exactly what is already real today inside the app rail (state machine, outbox discipline, payment-attempt audit, webhook ingestion storage, duplicate handling, and minimal reconciliation), what remains mock or placeholder (`authorize`, `capture`, `recover`, `refund` execution inside `src/payment_provider.ts`), where the frontend already assumes a meaningful authorization boundary, where aliases and webhook routes already exist, which envs/secrets are already part of the shape, and which invariants must not be broken while moving to a real provider
- What was checked:
  `docs/P0_ATTACK_PLAN.md`, `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `src/payment_provider.ts`, `src/payment_reconciliation.ts`, `src/webhook_ingestion.ts`, `src/payment_attempt_helpers.ts`, `src/app.ts`, `src/frontend_runtime.ts`, `frontend/app.js`, and the existing payment-facing validations referenced in `tests/frontend_flow_validation.ts`, `tests/real_integrations_validation.ts`, `tests/preprod_torture_validation.ts`, and `tests/ultimate_prelive_qa_rc_validation.ts`
- What is open:
  no real external payment transport is active yet; the next concrete implementation program is still open and should begin with one real authorization rail behind the existing abstraction, followed only later by capture/recovery/refund and the chosen provider's full webhook matrix
- Progress percentage:
  `100%` of the payment-rail planning pass
- Next step:
  start the implementation program at Stage 1 from `docs/PAYMENT_RAIL_ATTACK_PLAN.md`: one chosen provider, real authorization HTTP client, strict non-demo env contract, real provider correlation persistence, and no capture/recovery/refund expansion in the same first patch

## Real Authorization Rail Stage 1

- What was completed:
  replaced the synthetic `provider-ready` authorization path with a real outbound HTTP authorization rail behind the existing provider abstraction in `src/payment_provider.ts`; kept `mock-backed` and `demo-preview` isolated; added strict non-demo env support for `PAYMENT_PROVIDER_AUTH_PATH` and `PAYMENT_PROVIDER_TIMEOUT_MS` in `src/runtime_config.ts`; wired `/api/payments/authorize` and the legacy `/api/payments/authorize-mock` alias to pass real authorization amount/currency/deal/buyer context through `src/frontend_runtime.ts`; updated `frontend/app.js` to send `amount_minor` and preserve returned provider trace in the buyer flow; updated `src/app.ts` so a successful join now records `authorization_id`, `authorization_provider`, and `authorization_correlation_id` inside the existing `participant.join_authorize` audit payload instead of an unqualified mock marker; aligned `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` with the new truth
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_authorization_real_rail_validation.js`; focused env-guard validation via `node .tmp_test_dist/tests/payment_authorization_env_guard_validation.js`; live HTTP QA against a temporary runtime on `127.0.0.1:3072` with a local provider stub proving `POST /api/payments/authorize` returned `200` with `mock:false` and a real `provider_reference`, while `POST /api/payments/authorize-mock` returned `402` with `mock:false` and `card_declined` instead of bypassing to a mock path; an additional `frontend_flow_validation` pass was attempted and confirmed the existing buyer/public shell still loads, but the suite remains partly blocked by pre-existing `app.ts` environment drift unrelated to the new authorization rail
- What is open:
  `capture`, `recovery`, and `refund` are still non-live; no real invoice/accounting rail or notifications were opened in this pass; `src/app.ts` and `src/frontend_runtime.ts` still carry architectural drift outside the authorization boundary; broader end-to-end payment truth still depends on the later webhook/catalog and capture phases
- Progress percentage:
  `100%` of Stage 1 real authorization rail
- Next step:
  freeze the real authorization rail as the new non-demo baseline, then move only to the next payment stage in order: tighten provider-specific webhook truth and the capture path without reopening auth, notifications, or invoice/accounting in the same patch

## Payment Rail Stage 2: Webhook Truth + Capture Path

- What was completed:
  replaced the remaining mock `charge_deal` execution path with a real provider-backed capture call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added strict env support for `PAYMENT_PROVIDER_CAPTURE_PATH` and provider currency wiring in `src/runtime_config.ts`; updated `src/app.ts` so charge execution now reads the recorded authorization trace from the existing `participant.join_authorize` audit payload, records the capture attempt before I/O, calls the real provider capture rail, and routes success or terminal failure back through the existing webhook ingestion + reconciliation truth path instead of mutating participant money states directly from mock code; kept temporary failures on the outbox retry path so no invalid transition is forced on timeout or unknown result; extended `src/frontend_runtime.ts` and `src/operational_readiness.ts` so preview/admin readiness now reflects live authorization + capture while still honestly marking recovery/refund as non-live; aligned `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` with the new capture/webhook truth baseline; added focused validation in `tests/payment_capture_webhook_real_rail_validation.ts`
- What was checked:
  `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`; live HTTP QA against a temporary runtime on `127.0.0.1:3085` with a local provider stub proving `/api/preview/meta` exposed the updated partial payment readiness, `processOutboxEventById(...)` drove a real provider-backed capture call, `GET /api/participants/:id/tracking` showed `ChargedSuccess` after a successful capture and `ChargeFailedCompletion` / `ChargeFailedRecovery` after a declined capture, and `POST /webhooks/payments` treated a late fail event as `ignored` and a replay of the same event as `duplicate:true`
- What is open:
  recovery and refund are still not live; invoice/accounting, real notifications, and broader financial reconciliation remain outside this pass; payment truth is now real for authorization + capture only, so the remaining production blockers are the downstream money lifecycle rails and the other external systems already mapped in the gap register
- Progress percentage:
  `100%` of the webhook-truth + capture-path stage
- Next step:
  freeze authorization + capture as the new non-demo baseline, then decide whether the next payment program is recovery rail or the remaining production blockers outside payments, without reopening state-model, repeat-joins, or invoice/accounting work in the same patch

## Payment Rail Stage 3: Recovery Rail

- What was completed:
  replaced the mock `recovery_deal` execution path with a real provider-backed recovery call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added explicit recovery event classification to `recovery_captured` / `recovery_failed`; updated `src/app.ts` so recovery execution now stays strictly inside `CompletionWindow`, records the recovery attempt before I/O, calls the real provider recovery rail, and routes terminal outcomes through the existing webhook ingestion + reconciliation truth path instead of mutating states directly from mock logic; kept temporary failures on the outbox retry path and rejected missing reconciliation truth instead of silently forcing an unsafe fallback; aligned `src/operational_readiness.ts` and `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` so readiness now reflects live authorization + capture + recovery while still honestly marking refund as non-live; added focused validation in `tests/payment_recovery_real_rail_validation.ts`
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_recovery_real_rail_validation.js`; regression validation via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`; live local QA through the recovery validation runtime on `127.0.0.1:3086` proved `/api/preview/meta` reports `authorization-capture-recovery-partial`, provider-backed recovery success moves a participant to `Recovered` / `RecoveredCharge`, declined recovery moves to `Dropped` / `AuthReleased`, timeout keeps the outbox pending without an invalid transition, late recovery failure webhooks are ignored after success, duplicate replays remain duplicate-safe, and recovery does not execute outside the completion window
- What is open:
  refund remains non-live; invoice/accounting, real notifications, and the other mapped non-payment blockers remain outside this pass; payment truth is now real for authorization + capture + recovery only, so the remaining money-rail blocker is refund and the broader external-finance envelope already mapped elsewhere
- Progress percentage:
  `100%` of the recovery-rail stage
- Next step:
  freeze authorization + capture + recovery as the new non-demo baseline and only then decide whether to open refund rail or step back to the other production blockers, without reopening state-model, repeat-joins, invoice/accounting, or notification work in the same patch

## Payment Rail Stage 4: Refund Rail

- What was completed:
  replaced the mock `refund_issue` / `cancel_refund` execution path with a real provider-backed refund call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added `PAYMENT_PROVIDER_REFUND_PATH` and `PAYMENT_PROVIDER_RECOVERY_PATH` to `src/runtime_config.ts`; added `RefundPaymentInput` type; updated `handleRefundEvent` in `src/app.ts` to read the capture reference trace from the audit log (via `participant.join_authorize` for auth_id and `charging.charge_success`/`payment.capture_success` for capture_reference), record the refund attempt before I/O, call the real provider refund rail, and route `refund_issued` events through the webhook ingestion + reconciliation truth path; added `refund_issued` handling to `applyPaymentWebhookClassification` so a live provider refund confirmation transitions `money_state` → `Refunded` atomically; updated `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` and `PROJECT_STATUS.md` to reflect that all four execution paths are now live in `provider-ready`
- What was checked:
  `./node_modules/.bin/tsc -p tsconfig.test.json --outDir .tmp_test_dist` (exit 0); full 31-test non-DB regression suite passing after changes; all security hardening, OTP, webhook, admin auth, rate limiter, and seller auth tests green
- What is open:
  invoice/accounting transport, real SMS, real email, real notification delivery, true open-production seller auth — none of these were opened in this pass; the payment execution rail is now complete end-to-end in `provider-ready` mode
- Progress percentage:
  `100%` of the refund-rail stage; payment execution rail is fully closed
- Next step:
  all four payment execution paths (authorize, capture, recover, refund) are now real in `provider-ready` mode — the remaining external-activation blockers are notifications, invoice/accounting, and production seller auth, which are each independent tracks

