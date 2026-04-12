# Seller Auth Attack Plan

## Executive Summary

`GAP-06`, `GAP-07`, and the minimum `GAP-04` floor are closed.

The next structural `P0` is `GAP-01`: real seller authentication.

Today the product does **not** have seller authentication. It has seller-context scoping:

- frontend persistence in `localStorage`
- caller-supplied `x-seller-id`
- optional `seller_id` query selection
- backend scoping that keeps seller surfaces aligned to the chosen context

That is good enough for controlled demo, supervised first-run operation, or single-operator environments. It is **not** a trustworthy production authority boundary for a public multi-tenant seller product.

The correct next move is **not** a rushed full auth rewrite. The correct next move is a staged program:

1. define a server-trusted seller session boundary
2. remove caller-controlled seller identity as production authority
3. preserve current seller ownership semantics on existing deals
4. keep demo-preview explicitly isolated from the production authority model

## Current State Mapping

### Frontend seller identity today

- `frontend/app.js` stores the active seller context in `localStorage` under `siton_seller_context_v1`
- `readSellerContext()` hydrates seller identity directly from browser storage
- `syncSellerContext()` writes the chosen seller identity back into `localStorage`
- seller routes and cache keys use `currentSellerContext().seller_id`
- the seller workspace exposes an explicit seller-context form that lets the caller set:
  - `sellerContextId`
  - `sellerContextName`

### Backend seller identity today

- `src/frontend_runtime.ts` resolves seller identity with `resolveSellerContext()`
- `resolveSellerContext()` accepts seller identity from:
  - `x-seller-id`
  - `seller_id` query param
  - `DEFAULT_SELLER_ID` fallback
- `POST /api/seller/context` accepts caller-selected seller identity and upserts a seller account
- `ensureSellerAccount()` auto-creates or updates seller records for the requested identity

### Seller routes currently relying on caller-selected context

- `GET /api/site/home`
  - returns `site.seller_context`
- `GET /api/seller/context`
- `POST /api/seller/context`
- `GET /api/seller/deals`
- `GET /api/seller/deals/:id`
- `POST /api/seller/deals/:id/delivery/:participantId`

### Guards that already exist

- seller list and detail routes scope results by the resolved seller context
- seller detail returns `404` when the selected seller context does not match the deal owner
- delivery updates reject when the participant's deal seller does not match the resolved seller context
- seller ownership is persisted on deals and used for seller-surface scoping

### What is still weak

- the browser chooses seller identity
- the request can choose seller identity again through `x-seller-id`
- the querystring can choose seller identity through `seller_id`
- seller accounts can be auto-created from caller input
- there is no login
- there is no server-issued seller session
- there is no proof that the caller is the seller they claim to be

## Failure And Spoofing Points

### Local spoofing

- a caller can edit `localStorage` and become a different seller context in the frontend shell
- a caller can use the visible seller context form to switch seller identity intentionally

### Header spoofing

- a caller can send `x-seller-id` directly to seller routes
- the backend currently treats that header as authority input, not only as display metadata

### Query spoofing

- a caller can select `seller_id` through query parameters on routes that call `resolveSellerContext()`

### Auto-provisioning risk

- `ensureSellerAccount()` can create or enrich seller accounts for caller-selected ids
- this is useful for demo bootstrap and dangerous as a production authority rule

### Weak-scoping-only risk

- current guards prevent some accidental cross-seller reads and writes
- current guards do **not** prove identity
- the system is scoped, not authenticated

## Risk Assessment

### Why this is `P0`

- seller create, publish, and management surfaces represent commercial authority
- a public multi-tenant launch cannot trust caller-supplied seller ids
- seller impersonation risk remains real even if surface scoping looks coherent
- the current boundary is acceptable for controlled demo and not acceptable for open production

### Actual risk today

- controlled demo / supervised launch:
  - acceptable with explicit operational discipline
- open multi-tenant launch:
  - not acceptable
- strongest concrete risks:
  - seller impersonation
  - cross-seller workspace access
  - unauthorized publish/manage actions
  - accidental seller-account creation from untrusted input

## Source Of Truth Requiring Closure

- `docs/GAP_REGISTER_MASTER.md`
- `docs/P0_ATTACK_PLAN.md`
- `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md`
- `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`
- product/system expectation that identity is a server-trusted authority source rather than a caller-selected header or storage value

## Correct Target

### Minimum viable seller auth for first controlled launch

This is the smallest real boundary that is worth building without pretending it is full auth.

- server-issued authenticated seller session
- seller id derived from the session on the server
- seller APIs ignore caller-supplied `x-seller-id` as an authority source in production mode
- seller-scoped routes bind to the authenticated seller from the session
- existing deal ownership stays on `deals.seller_id`
- demo-preview keeps its isolated seller-context mode explicitly, and never pretends to be production auth

This path is suitable for:

- controlled first launch
- limited invited sellers
- internal or supervised onboarding

### Mature production seller auth

- full seller login lifecycle
- credential or magic-link / OTP-based seller login
- durable session issuance and revocation
- seller-to-account linkage with explicit onboarding state
- permission model for seller/admin/support roles
- audited account recovery and device/session management
- clean separation between demo identities and real seller accounts

This path is suitable for:

- open public seller onboarding
- multi-tenant production
- broader operator/support workflows

## Two Repair Tracks

### Track A: Controlled-launch seller auth

Goal:
replace caller-selected authority with server-trusted seller session, without opening a full account-platform rewrite.

Shape:

- introduce a seller auth/session table or signed session token boundary
- add login/bootstrap only for pre-created sellers or invited sellers
- resolve seller identity from session only in non-demo runtime
- keep `deals.seller_id` as the ownership source
- disable seller auto-create from untrusted request input outside demo-preview
- keep current seller surfaces with minimal frontend flow changes

What this solves:

- forged `x-seller-id`
- forged `seller_id` query selection
- browser-only identity switching as production authority

What it does not solve:

- full public onboarding
- rich permissions
- long-term seller account lifecycle

### Track B: Full production seller auth

Goal:
build the real multi-tenant seller identity system.

Shape:

- proper account model
- onboarding and verification states
- production session lifecycle
- role/permission matrix
- support/admin delegation boundaries
- account recovery

What this solves:

- long-term identity trust
- scalable seller lifecycle
- clean production tenancy

Why it should not be first:

- much larger blast radius
- touches more flows than needed for the next safe milestone
- risks dragging payment, support, and onboarding concerns into one oversized program

## Recommended Path Now

The recommended next move is `Track A`.

### Why Track A first

- it closes the real authority hole
- it preserves existing deal ownership
- it avoids pretending that `x-seller-id` is “good enough”
- it does not force full onboarding and permissions on the same pass
- it gives a credible first controlled launch boundary

### What to do now

1. Define one non-demo authority model:
   server-issued seller session only.
2. Keep `demo-preview` on explicitly isolated seller-context mode.
3. Remove `x-seller-id` and `seller_id` query params as production authority sources.
4. Disable seller auto-create from untrusted runtime paths outside demo-preview.
5. Add focused auth-boundary tests before opening implementation.

### What to delay

- public self-serve seller signup
- full permissions matrix
- KYC/account lifecycle
- support impersonation tooling

### What must not be improvised

- a signed header and calling it auth
- keeping `x-seller-id` as a silent fallback in production mode
- changing existing seller ids on deals without a migration plan
- mixing demo fallback logic into production authority rules

## Gap Card

- Gap:
  `Seller identity is caller-selected context, not authenticated identity`
- Why it is `P0`:
  seller authority is currently selectable by the caller, which is incompatible with open production trust
- Demo blocker:
  `No`
- Preview blocker:
  `No`
- Production blocker:
  `Yes`
- What exists today:
  seller-context scoping, seller ownership persistence, basic mismatch rejection on seller surfaces
- What is missing:
  real seller login, server-trusted session authority, production-safe tenant isolation
- Problematic behavior today:
  the browser or caller can choose seller identity through storage, headers, or query params
- Correct target behavior:
  the server derives seller identity from authenticated session state, not caller-selected context
- Risk if fixed incorrectly:
  seller lockouts, broken create/publish/manage flows, ownership mismatches, orphaned seller data, or hidden single-tenant assumptions
- Blast radius:
  high
- Files and layers affected:
  - `frontend/app.js`
  - `src/frontend_runtime.ts`
  - `src/product_surface_support.ts`
  - seller surface tests
  - env/runtime docs
- API changes required:
  `Yes`
- DB changes required:
  `Possibly`
- Frontend flow changes required:
  `Yes`, but can stay narrow in Track A
- Delivery shape:
  `Subproject`

## Blast Radius

### Frontend

- seller context bootstrapping
- seller workspace hydration
- seller create-deal flow
- seller deal management flow
- any surface assuming seller identity can be swapped client-side

### Backend

- seller-context resolution
- seller route authorization
- seller account provisioning
- any route currently using `resolveSellerContext()`

### Data / model

- seller account linkage
- invite/bootstrap model for first controlled launch
- possible session storage table or token validation model

## Dependencies

- decision on session model
- decision on controlled-launch seller onboarding
- explicit split between `demo-preview` behavior and non-demo production authority
- migration plan if any new DB artifacts are introduced

## Likely File Impact

- `src/frontend_runtime.ts`
- `frontend/app.js`
- `src/product_surface_support.ts`
- `src/runtime_config.ts`
- new auth/session support module or table migration if Track A introduces server sessions
- seller-focused validation tests and live-QA scripts

## Prerequisites Before Implementation

1. Freeze the production authority rule:
   non-demo seller authority comes from server session only.
2. Decide Track A session shape:
   signed cookie vs server session store.
3. Decide bootstrap policy:
   invited/pre-created sellers only for first controlled launch.
4. Decide whether any non-demo route may still expose `POST /api/seller/context`.
   Current recommendation: no authority-setting route in non-demo.

## Validation Plan

### Success criteria

- forged `x-seller-id` no longer changes seller authority in non-demo
- forged `seller_id` query params no longer change seller authority in non-demo
- seller routes bind to authenticated seller only
- rightful seller can still create, publish, and manage owned deals
- demo-preview remains operational under its explicitly isolated rules

### Tests required

- seller auth boundary tests
- seller create flow regression
- seller publish/manage regression
- session issuance/validation tests
- negative tests for forged header/query/local context

### Live QA required

- seller login or session bootstrap
- seller dashboard access
- create deal
- publish deal
- live deal management
- forged request attempts with mismatched seller ids
- demo-preview seller mode still working under explicit demo rules

### Docs required

- readiness map
- operational runbook
- seller-auth attack plan execution notes
- environment/setup docs for session authority

## Execution Order

1. Lock the target:
   Track A controlled-launch seller auth.
2. Define the session authority boundary.
3. Remove caller-selected seller authority in non-demo.
4. Keep demo-preview isolated and explicit.
5. Add focused boundary tests.
6. Run seller flow QA.
7. Only after Track A stabilizes, decide whether and when to open Track B.

## Dangerous Fixes

### Dangerous fix 1: Reusing `x-seller-id` with a thin wrapper

This keeps the same weak authority model and only hides it cosmetically.

### Dangerous fix 2: Turning off seller auto-create without a controlled bootstrap path

This can break seller flows immediately without replacing the missing authority boundary.

### Dangerous fix 3: Rewriting seller ownership on existing deals

This risks corrupting ownership semantics and creates migration debt before the auth boundary is settled.

### Dangerous fix 4: Mixing demo and production authority rules

This creates exactly the kind of fallback leakage that Stage 4 was meant to eliminate.

## Sharp Recommendation

Start with `Track A`: a real server-trusted seller session for non-demo, limited to controlled-launch sellers, while keeping `demo-preview` on explicitly isolated minimum-context mode.

Do **not** start with:

- full public seller onboarding
- broad permissions redesign
- payment-rail coupling
- deal-ownership migrations
- a cosmetic header-signing shortcut
