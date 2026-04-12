# P0 Attack Plan

## Executive Summary

This document converts the `P0` items from [GAP_REGISTER_MASTER.md](/c:/Users/Lenovo/Documents/C-ton/docs/GAP_REGISTER_MASTER.md) into an execution plan.

Current `P0` count: `7`

- `P0-A`: immediate and foundational
- `P0-B`: critical but depends on `P0-A`
- `P0-C`: critical but should not be first

Current recommendation:

1. close direct exposure first
2. close unsafe runtime defaults second
3. only then open identity and payment subprojects

The first fix to execute should be:

- `P0-A / GAP-06` `Debug route exposure`

Why first:

- it is a direct internal-state exposure
- it has the smallest blast radius
- it does not require product redesign
- it reduces risk immediately without forcing early decisions on auth or providers

What should **not** be touched yet:

- repeat-join drift resolution
- seller publish acknowledgment flow redesign
- invoice/accounting implementation details before the payment rail and identity boundary are chosen

These are real issues, but they are not the first safe move inside the `P0` campaign.

## P0 Inventory

| Rank | Gap ID | Gap | P0 Tier | Demo Blocker | Preview Blocker | Production Blocker | Recommended Strategy |
|---|---|---|---|---|---|---|---|
| 1 | GAP-06 | Debug route exposure | P0-A | No | No | Yes | Immediate small fix |
| 2 | GAP-07 | Demo-grade webhook secret policy | P0-A | No | No | Yes | Immediate small fix |
| 3 | GAP-04 | OTP is not production-safe | P0-A | No | No | Yes | Phased fix |
| 4 | GAP-01 | No real seller auth | P0-B | No | No | Yes | Infra subproject |
| 5 | GAP-02 | No real payment authorization rail | P0-B | No | No | Yes | Infra subproject |
| 6 | GAP-03 | Capture/recovery/refund + webhook matrix incomplete | P0-C | No | No | Yes | Phased program after GAP-02 |
| 7 | GAP-05 | No real invoice/accounting rail | P0-C | No | No | Yes | Infra subproject after payment truth |

## Attack Cards

### GAP-06: Debug route exposure

- Gap name:
  `Internal debug deal surface is exposed without an effective runtime gate`
- P0 tier:
  `P0-A`
- Why it is P0:
  it exposes deal internals, participant rows, outbox, DLQ, and payment-attempt data directly from a public route and contradicts the Stage 4 readiness claim that this surface is controlled-only
- Demo blocker:
  `No`
- Preview blocker:
  `No`
- Production blocker:
  `Yes`
- Source of truth requiring closure:
  `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `docs/RELEASE_READINESS_CHECKLIST.md`, `docs/FRONTEND_START_GATE.md`
- Where it sits:
  [src/app.ts](/c:/Users/Lenovo/Documents/C-ton/src/app.ts) route `/debug/deals/:id`
- Problematic behavior today:
  the route returns internal operational payloads directly and currently answers in the live local runtime
- Correct target behavior:
  the route must be unavailable outside explicitly authorized debug contexts, and the app server and frontend runtime must enforce the same policy
- Risk if fixed incorrectly:
  an over-broad block can break internal QA/runbook workflows; an under-broad block leaves the exposure in place
- Blast radius:
  low to medium
- Files / layers likely affected:
  [src/app.ts](/c:/Users/Lenovo/Documents/C-ton/src/app.ts), potentially [src/runtime_config.ts](/c:/Users/Lenovo/Documents/C-ton/src/runtime_config.ts), tests that inspect debug surfaces, runbook docs
- Dependencies:
  runtime-mode policy and one explicit definition of what counts as internal debug access
- Prerequisite before starting:
  confirm the canonical policy: either `demo-preview` only, or `DEBUG_SURFACES_ENABLED` only, or both
- How to validate success:
  public runtime returns `404` or `403` when debug is disabled; internal debug runtime still works when explicitly enabled
- Tests to run:
  `npm run test:integrations`
  `npm run test:product-surface`
  targeted tests for `/debug/deals/:id`
- Live browser QA required:
  `No`, but live HTTP QA is required
- Docs change required:
  `Yes`
- DB change required:
  `No`
- API contract change required:
  `Yes`, operationally; the route access semantics change
- Delivery shape:
  `Immediate small fix`
- Recommended strategy:
  contain first, do not bundle with auth or payment work

### GAP-07: Demo-grade webhook secret policy

- Gap name:
  `Webhook secret still falls back to mock-webhook-secret`
- P0 tier:
  `P0-A`
- Why it is P0:
  real payment/webhook authenticity cannot rest on a known default secret
- Demo blocker:
  `No`
- Preview blocker:
  `No`
- Production blocker:
  `Yes`
- Source of truth requiring closure:
  `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, operational readiness for real webhook intake
- Where it sits:
  [src/runtime_config.ts](/c:/Users/Lenovo/Documents/C-ton/src/runtime_config.ts), webhook tests, `/health/integrations`
- Problematic behavior today:
  the runtime has a known fallback secret and tests are built around it
- Correct target behavior:
  non-demo runtimes must refuse boot or mark themselves unhealthy when the webhook secret is unset or equals the demo default
- Risk if fixed incorrectly:
  aggressive hard-fail can break local/demo flows; weak gating leaves a production bypass
- Blast radius:
  low to medium
- Files / layers likely affected:
  [src/runtime_config.ts](/c:/Users/Lenovo/Documents/C-ton/src/runtime_config.ts), [src/app.ts](/c:/Users/Lenovo/Documents/C-ton/src/app.ts), integration tests, env examples, readiness docs
- Dependencies:
  clear separation between demo-preview env and non-demo env
- Prerequisite before starting:
  decide which deployment modes are allowed to keep the fallback
- How to validate success:
  demo-preview still boots with demo secret; non-demo boot or readiness fails on unsafe secret values
- Tests to run:
  `npm run test:integrations`
  `npm run test:demo-preview`
  env-sensitive startup validation
- Live browser QA required:
  `No`
- Docs change required:
  `Yes`
- DB change required:
  `No`
- API contract change required:
  `No`
- Delivery shape:
  `Immediate small fix`
- Recommended strategy:
  enforce runtime guardrails before starting live provider work

### GAP-04: OTP is not production-safe

- Gap name:
  `OTP / SMS rail is internal-only and exposes development_code`
- P0 tier:
  `P0-A`
- Why it is P0:
  current OTP is not trustworthy for any real launch because code issuance is static and exposed to the client
- Demo blocker:
  `No`
- Preview blocker:
  `No`
- Production blocker:
  `Yes`
- Source of truth requiring closure:
  product and UX expect a real user-trust step, not a development bypass; Stage 4 readiness lists real SMS as still open
- Where it sits:
  [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts) OTP constants and `/api/otp/start` `/api/otp/verify`, [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js) where `development_code` is consumed
- Problematic behavior today:
  the API returns `development_code`, verification uses a single constant `123456`, and there is no external delivery
- Correct target behavior:
  OTP must be per-session, short-lived, not returned to the browser in non-internal modes, and delivered through a real SMS provider or at minimum a controlled internal-only fallback mode
- Risk if fixed incorrectly:
  broken buyer join flow, locked users, brittle OTP expiry behavior, or false sense of security if only the UI changes but backend behavior stays weak
- Blast radius:
  medium to high
- Files / layers likely affected:
  [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts), [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js), tests across frontend/system/preprod flows, readiness docs, env config
- Dependencies:
  SMS provider choice, runtime mode policy, abuse throttling, buyer-flow continuity
- Prerequisite before starting:
  define minimum acceptable MVP:
  no `development_code` outside internal demo
  no static shared OTP
  explicit mode separation between demo and production-safe paths
- How to validate success:
  demo mode still supports controlled QA
  non-demo mode never exposes a code
  OTP verify works only with issued per-session codes
  buyer happy path still reaches confirmation and tracking
- Tests to run:
  `npm run test:frontend`
  `npm run test:product-surface`
  `npm run test:integrations`
  torture/adversarial OTP tests
- Live browser QA required:
  `Yes`
- Docs change required:
  `Yes`
- DB change required:
  `No` for minimum hardening, possibly `Yes` later if persistent OTP audit/log tables are introduced
- API contract change required:
  `Yes`
- Delivery shape:
  `Phased fix`
- Recommended strategy:
  do this in two layers:
  first remove unsafe behavior and formalize mode separation
  then add real SMS delivery

#### GAP-04 minimum acceptable closure

- No `development_code` in non-demo responses
- No static universal OTP
- Per-session server-side OTP generation
- Explicit demo-only fallback path

#### GAP-04 mature closure

- Real SMS delivery
- rate limiting / abuse controls
- delivery status and retries
- operational monitoring

#### GAP-04 what can be done now without breaking the product

- split demo-only OTP behavior from production-safe OTP behavior
- remove leaked code from browser-facing responses outside demo
- generate per-session OTP server-side

#### GAP-04 what must not be improvised

- fake "secure" copy while still using static OTP
- UI-only masking with no backend change
- coupling OTP fix to broad buyer-flow redesign

### GAP-01: No real seller auth

- Gap name:
  `Seller identity is caller-selected context, not authenticated identity`
- P0 tier:
  `P0-B`
- Why it is P0:
  seller actions are currently scoped, but not authenticated; that is enough for controlled demo and not enough for real production authority
- Demo blocker:
  `No`
- Preview blocker:
  `No`
- Production blocker:
  `Yes`
- Source of truth requiring closure:
  product and system expectations that identities are real authority sources, plus `PASS7` and Stage 4 readiness which explicitly say full auth remains out of scope and still missing
- Where it sits:
  [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js) seller context persistence and request headers, [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts) context resolution and auto-create paths, [src/product_surface_support.ts](/c:/Users/Lenovo/Documents/C-ton/src/product_surface_support.ts) default seller provisioning
- Problematic behavior today:
  the caller can choose seller identity via storage/header/query and the server accepts that context if it matches route scoping
- Correct target behavior:
  seller identity must come from authenticated server-trusted context, with seller ownership resolved from that identity, not from user-supplied headers
- Risk if fixed incorrectly:
  seller workspace lockout, ownership mismatches on existing deals, broken publish/manage flows, orphaned seller data, or accidental single-tenant assumptions hidden inside a multi-tenant design
- Blast radius:
  very high
- Files / layers likely affected:
  seller frontend flows, seller APIs, possibly admin/affiliate context boundaries, provisioning/bootstrap assumptions, tests, docs, env/auth setup
- Dependencies:
  auth provider choice, session model, seller account linkage, migration path for existing seller-owned records
- Prerequisite before starting:
  decide the minimum auth target:
  single-tenant trusted login
  or multi-tenant seller login
  or staged first-launch internal auth
- How to validate success:
  seller APIs ignore forged `x-seller-id`
  authenticated seller can only access owned deals
  publish/create/manage flows still work for the rightful seller
- Tests to run:
  seller surface tests
  auth boundary tests
  regression on create/publish/manage flows
- Live browser QA required:
  `Yes`
- Docs change required:
  `Yes`
- DB change required:
  `Possibly`
- API contract change required:
  `Yes`
- Delivery shape:
  `Infra subproject`
- Recommended strategy:
  staged program, not a one-shot patch

#### GAP-01 minimum acceptable closure

- remove `x-seller-id` as the authority source in production mode
- introduce authenticated seller session/context
- preserve existing seller ownership semantics on deals

#### GAP-01 mature closure

- full seller login lifecycle
- permission matrix
- verified seller onboarding / account management

#### GAP-01 what can be done now without breaking the product

- decide the auth boundary and add a production-only authority model
- keep demo-preview on isolated minimum-context mode if explicitly marked

#### GAP-01 what must not be improvised

- bolting a fake header signature onto the existing flow and calling it auth
- changing seller ids on existing deal records without a migration plan
- mixing demo fallback logic into production authority rules

### GAP-02: No real payment authorization rail

- Gap name:
  `Payment step still stops at mock/provider-ready abstraction`
- P0 tier:
  `P0-B`
- Why it is P0:
  the buyer-facing payment/authorization surface appears meaningful, but no real external authorization rail is active
- Demo blocker:
  `No`
- Preview blocker:
  `No`
- Production blocker:
  `Yes`
- Source of truth requiring closure:
  product/payment expectations, Stage 4 readiness, real payment/reconciliation decision docs
- Where it sits:
  [src/payment_provider.ts](/c:/Users/Lenovo/Documents/C-ton/src/payment_provider.ts), [src/runtime_config.ts](/c:/Users/Lenovo/Documents/C-ton/src/runtime_config.ts), [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts) authorization endpoint, buyer payment screen
- Problematic behavior today:
  `mock-backed` is the default active mode, and `provider-ready` does not yet call a live provider
- Correct target behavior:
  authorization requests must go to a real provider, return provider correlation ids, and follow real success/failure semantics
- Risk if fixed incorrectly:
  broken buyer conversion, false authorization success, mismatched provider references, or corruption in downstream charge/recovery flows
- Blast radius:
  very high
- Files / layers likely affected:
  payment provider abstraction, runtime env, frontend payment step, webhook/reconciliation assumptions, health surfaces, tests, docs
- Dependencies:
  provider decision, credentials/secrets, webhook contract, capture/recovery design
- Prerequisite before starting:
  pick one real provider and freeze the minimum authorization contract
- How to validate success:
  non-demo authorization calls the provider successfully
  provider ids are stored consistently
  buyer flow still transitions cleanly into join/confirmation
- Tests to run:
  integration tests
  buyer-flow tests
  provider adapter unit tests
  contract tests around failure classes
- Live browser QA required:
  `Yes`
- Docs change required:
  `Yes`
- DB change required:
  `Possibly`
- API contract change required:
  `Possibly`, depending on returned provider metadata
- Delivery shape:
  `Infra subproject`
- Recommended strategy:
  start as a staged provider adapter project, not as a blind replacement of current payment code

#### GAP-02 minimum acceptable closure

- one chosen provider
- live authorization HTTP client
- explicit non-demo env requirements
- safe storage of provider correlation data

#### GAP-02 mature closure

- hardened provider adapter
- structured decline/error mapping
- full operational observability

#### GAP-02 what can be done now without breaking the product

- keep the frontend payment contract mostly stable
- switch the backend adapter behind the existing abstraction
- keep demo-preview as explicit mock mode

#### GAP-02 what must not be improvised

- faking provider-ready into production
- changing payment semantics in the UI while backend is still mock
- bundling capture/recovery/refund logic into the first authorization patch

### GAP-03: Capture / recovery / refund and webhook matrix are incomplete

- Gap name:
  `Downstream payment execution remains partial after authorization`
- P0 tier:
  `P0-C`
- Why it is P0:
  even after a live auth rail exists, final money-state closure is still incomplete without live capture/recovery/refund and a full provider event catalog
- Demo blocker:
  `No`
- Preview blocker:
  `No`
- Production blocker:
  `Yes`
- Source of truth requiring closure:
  real payment/reconciliation docs, Stage 4 readiness, enforcement/state-machine expectations
- Where it sits:
  [src/payment_provider.ts](/c:/Users/Lenovo/Documents/C-ton/src/payment_provider.ts), [src/payment_reconciliation.ts](/c:/Users/Lenovo/Documents/C-ton/src/payment_reconciliation.ts), webhook routes and readiness surfaces
- Problematic behavior today:
  downstream execution is simulated or placeholder, and supported webhook events are still a minimal subset
- Correct target behavior:
  charge capture, recovery, refund, and provider callbacks must close money states accurately and idempotently
- Risk if fixed incorrectly:
  irreversible money-state corruption, duplicate charges, false recovery success, refund mismatch, or broken outbox invariants
- Blast radius:
  very high
- Files / layers likely affected:
  payment provider, reconciliation logic, worker/outbox behavior, payment attempts, health views, tests, docs
- Dependencies:
  GAP-02 first, provider event catalog, settlement policy
- Prerequisite before starting:
  real authorization provider is chosen and its event taxonomy is mapped
- How to validate success:
  each provider event results in the intended participant/deal state mutation exactly once
- Tests to run:
  integration tests
  adversarial duplicate/out-of-order webhook tests
  recovery/refund path tests
- Live browser QA required:
  `Limited`; main QA is HTTP/system-level
- Docs change required:
  `Yes`
- DB change required:
  `Possibly`
- API contract change required:
  `Possibly`
- Delivery shape:
  `Phased program after GAP-02`
- Recommended strategy:
  do not start until authorization truth is stable

### GAP-05: No real invoice/accounting rail

- Gap name:
  `Receipt surface exists, legal/accounting issuance does not`
- P0 tier:
  `P0-C`
- Why it is P0:
  financial closure is incomplete without real issuance/compliance transport
- Demo blocker:
  `No`
- Preview blocker:
  `No`
- Production blocker:
  `Yes`
- Source of truth requiring closure:
  Stage 4 readiness, receipt/accounting requirements, trust/legal consistency
- Where it sits:
  [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts) receipt summary generation, readiness docs, seller completed-deal surfaces
- Problematic behavior today:
  receipt IDs and rows are internal artifacts and not legal/accounting documents
- Correct target behavior:
  completed financial events must trigger real invoice/accounting issuance with delivery and audit references
- Risk if fixed incorrectly:
  legal/accounting inconsistency, duplicate issuance, or issuance before the underlying payment truth is final
- Blast radius:
  high
- Files / layers likely affected:
  seller completed-deal surfaces, backend issuance orchestration, accounting provider integration, docs, tests
- Dependencies:
  GAP-02 and GAP-03, seller entity/compliance data
- Prerequisite before starting:
  settle the payment completion truth and issuance trigger policy
- How to validate success:
  only eligible completed financial events create real issuance artifacts and those artifacts are traceable back into the product
- Tests to run:
  completed-deal flow tests
  issuance trigger tests
  failure/retry tests
- Live browser QA required:
  `Yes` for seller-facing completion surfaces
- Docs change required:
  `Yes`
- DB change required:
  `Possibly`
- API contract change required:
  `Possibly`
- Delivery shape:
  `Infra subproject after payment truth`
- Recommended strategy:
  do not start before the money rail is real enough to be the accounting source of truth

## Mandatory Order Of Execution

| Order | Gap | Why now |
|---|---|---|
| 1 | GAP-06 Debug route exposure | fastest direct risk reduction with the smallest blast radius |
| 2 | GAP-07 Webhook secret policy | hardens the external callback boundary before provider activation |
| 3 | GAP-04 OTP production-safe floor | removes the most obvious trust/security fiction in the buyer path |
| 4 | GAP-01 Seller auth | establishes real authority boundaries before real seller-facing launch |
| 5 | GAP-02 Real payment authorization rail | only after authority and unsafe defaults are contained |
| 6 | GAP-03 Capture/recovery/refund completion | depends on the chosen live auth provider and event taxonomy |
| 7 | GAP-05 Invoice/accounting rail | must sit on top of real payment completion truth |

## Strategy Calls For The Three Biggest P0s

### Seller Auth

- Minimum sensible closure:
  authenticated seller session, no trust in caller-supplied seller headers for production mode, existing seller ownership preserved
- Mature closure:
  full seller auth/account lifecycle and permissions
- What can be done now safely:
  define authority model and introduce production-only authenticated context while keeping demo-preview isolated
- What must not be improvised:
  fake signed headers, hidden single-tenant assumptions, or rewriting seller ownership without migration discipline
- Strategy:
  `Infrastructure subproject`

### Payment Rail

- Minimum sensible closure:
  one real provider for authorization, explicit env/secret validation, provider correlation IDs, safe failure mapping
- Mature closure:
  live auth plus full capture/recovery/refund and reconciliation observability
- What can be done now safely:
  keep the frontend contract mostly stable and replace the adapter behind the backend abstraction
- What must not be improvised:
  "provider-ready" relabeling without real provider execution, or bundling all payment phases into a single uncontrolled patch
- Strategy:
  `Infrastructure subproject with staged rollout`

### OTP Production-Safe

- Minimum sensible closure:
  per-session OTP, no leaked code outside demo, explicit mode split
- Mature closure:
  real SMS provider, throttling, delivery observability
- What can be done now safely:
  remove leaked code and static OTP behavior behind runtime policy before the SMS provider is fully integrated
- What must not be improvised:
  UI-only concealment, static OTP kept server-side, or coupling OTP change to broad buyer-flow redesign
- Strategy:
  `Phased fix`

## Dangerous Fixes

These are the changes most likely to damage the system if attempted casually:

### Dangerous Fix 1: Changing seller authority without a migration plan

- Why dangerous:
  deal ownership, seller bootstrap defaults, and route scoping already exist; replacing authority rules can lock out legitimate records or silently remap ownership
- Guardrail:
  separate identity authority from ownership data migration

### Dangerous Fix 2: Swapping the payment provider and downstream money logic in one pass

- Why dangerous:
  authorization, capture, recovery, refund, and webhook semantics are not one problem; combining them raises the chance of silent financial drift
- Guardrail:
  stabilize auth first, then downstream execution, then accounting

### Dangerous Fix 3: "Hiding" OTP development behavior only in the frontend

- Why dangerous:
  if the backend still returns or accepts static OTP behavior, the product remains insecure while looking fixed
- Guardrail:
  backend semantics must change first; frontend copy follows truth

### Dangerous Fix 4: Gating debug only in one runtime surface

- Why dangerous:
  the repo already showed drift between documentation, frontend runtime, and app runtime; fixing only one layer leaves a second exposure path
- Guardrail:
  apply one canonical gate and test both runtime surfaces

### Dangerous Fix 5: Starting invoice/accounting integration before payment completion truth

- Why dangerous:
  accounting issuance built on simulated or partial money truth creates downstream legal/compliance damage
- Guardrail:
  invoice rail starts only after payment completion semantics are trustworthy

## Recommended First Move

Fix first:

- `GAP-06 Debug route exposure`

Then immediately:

- `GAP-07 Demo-grade webhook secret policy`
- `GAP-04 OTP production-safe floor`

This sequence is recommended because it:

- lowers immediate exposure
- hardens the runtime boundary
- removes the most blatant trust/security fiction
- avoids opening the larger auth/payment subprojects before the floor is stable

## What Must Wait

Do not start these before the first three steps above are finished:

- real seller auth implementation
- real payment provider activation
- invoice/accounting rail implementation

Do not mix these into the first pass:

- repeat-join drift resolution
- seller publish acknowledgment redesign
- feature-flag / kill-switch expansion

Those remain important, but they are not the first safe execution sequence for the current `P0` campaign.
