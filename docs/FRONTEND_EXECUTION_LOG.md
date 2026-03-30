# Frontend Execution Log

## PHASE A - Audit, Scope, Architecture, Contract

What was checked
- existing frontend surface under `frontend/`
- runtime support file `src/frontend_runtime.ts`
- backend endpoints in `src/app.ts`
- product/UX source priority from the three required `.docx` files

What was found
- there is already a static frontend shell and CSS, but no `frontend/app.js`
- there is already a backend-side frontend runtime layer with endpoints for:
  - public deal data
  - OTP start / verify
  - mock payment authorization
  - participant tracking
- the runtime layer was not yet registered into `src/app.ts`

Architecture decision
- use one simple frontend stack only: server-served vanilla SPA
- no extra bundler/framework pass right now
- route shell served by Fastify under `/app/*`
- static assets live in `frontend/`
- state strategy:
  - API as source of truth
  - `sessionStorage` for in-progress join flow continuity
- API strategy:
  - one lightweight fetch client in `frontend/app.js`
- loading/error strategy:
  - explicit route-level loading, empty, unavailable, and fallback states
- reusable UI strategy:
  - plain component render helpers in one JS module for speed and clarity

Must build now
- public deal page
- join flow
- OTP step
- payment/auth stub step
- confirmation
- tracking page

Should build if time allows
- richer copy and state explanations
- stronger inline validation polish

Later
- seller/admin surfaces
- richer affiliate / attribution surfaces
- non-core operational dashboards

Open
- need to build the actual frontend application file
- need to validate the runtime routes end-to-end

## PHASE B - Main Customer Flow

What was built
- public deal page under `/app/deal/:dealId`
- deal loading through `/api/deals/:id/public`
- quantity selection with validation against `min_units` and `remaining_units`
- join flow handoff into OTP
- shell routing for deal, OTP, payment, confirmation, and tracking

What was connected
- backend frontend runtime was registered in `src/app.ts`
- static frontend shell now serves `frontend/index.html`, `frontend/styles.css`, and `frontend/app.js`
- frontend state continuity was added through `sessionStorage`

What was fixed
- missing frontend runtime wiring in the server
- missing `frontend/app.js`
- broken frontend shell title / metadata baseline

What remains open after Phase B
- live runtime proof on a real server process
- explicit closure docs and final decision

## PHASE C - OTP, Payment/Auth, Confirmation, Tracking

What was built
- OTP start and verify step against `/api/otp/start` and `/api/otp/verify`
- payment authorization step against `/api/payments/authorize-mock`
- join submission against real `POST /deals/:id/join`
- confirmation screen with participant and authorization references
- tracking page against `/api/participants/:id/tracking`

What was connected
- state mapping from backend deal, buyer, and money states into buyer-facing copy
- confirmation to tracking navigation
- error mapping for not found, closed join, over-capacity, invalid OTP, payment failure, backend unavailable

What was fixed
- frontend flow now uses one consistent API client
- authorization and join are sequenced coherently before confirmation

What remains open after Phase C
- live runtime validation pass
- final docs and status closure

## PHASE D - Runtime Validation, Error Coverage, Decision

What was checked
- server startup through `compile + node` path
- `/health`
- frontend shell routes
- frontend asset delivery
- public deal API
- OTP start / verify
- payment authorization mock
- live join against backend
- live tracking fetch
- basic error cases

What was proven
- `/health` returned `{ \"ok\": true }`
- frontend shell routes returned `200`
- `/app/assets/app.js` served correctly
- public deal route loaded a published deal from the live backend
- OTP start and verify worked against the live backend
- payment authorization mock worked against the live backend
- join worked against the live backend and produced a real `participant_id`
- tracking worked against the live backend and returned `JoinedAuthorized / AuthHeld`
- basic error coverage returned expected statuses:
  - valid unknown deal -> `404`
  - invalid OTP -> `400`
  - payment authorization failure -> `402`
  - over-capacity join -> `409`

What remains open after Phase D
- no browser automation was added in this pass
- payment remains intentionally mock-backed

## 2026-03-30 - MVP Tightening Pass

### PHASE 1 - UX Tightening Pass

What improved
- clearer buyer-facing copy across deal, OTP, payment, confirmation, and tracking
- stronger CTA wording and step framing
- better loading language per action instead of one generic loading state
- stronger recovery states for missing or partial flow session

What changed in UX
- deal page now explains availability more clearly by deal state
- OTP now explains exactly what is being validated and what remains to be done
- payment step now explains authorization versus actual charge in clearer language
- confirmation now explains what happened and what the next step is
- tracking now reads as a progress/status product screen instead of a raw state dump

### PHASE 2 - Error and Edge Completion

What was covered
- deal not found
- draft deal
- closed for joining / unavailable
- capacity exceeded
- invalid OTP
- missing OTP session
- payment authorization failure
- backend unavailable mapping remains in place
- generic unknown error fallback remains in place
- missing or stale frontend session now leads to explicit recovery states

What improved
- route refreshes no longer rely on silent assumptions about `sessionStorage`
- OTP reset flow now exists
- payment and confirmation routes now show recovery states instead of brittle redirects

### PHASE 3 - Tracking and State Clarity

What improved
- tracking now explains:
  - מצב העסקה
  - מצב ההשתתפות
  - המצב הכספי
  - איפה המסלול עומד
  - מה השלב הבא
- journey rail was added to reduce ambiguity
- tracking now stores a session-linked last viewed timestamp for continuity

### PHASE 4 - Reduce Mock Feeling

What improved
- payment screen now presents the authorization step as a real integration boundary
- UI explicitly explains that the current provider is mock-backed but contractually separated
- the flow order `OTP -> authorization -> join -> confirmation -> tracking` is now explained more clearly

### PHASE 5 - Session and Flow Robustness

What improved
- flow storage now uses TTL
- stale flow is dropped instead of silently trusted forever
- deal page can resume an existing flow
- tracking refresh stores continuity context back into the flow

### PHASE 6 - Frontend Validation Pass 2

What was validated live
- `/health`
- live published deal page
- draft deal page
- OTP start / verify
- payment authorization success
- join success
- tracking success
- route delivery for deal / OTP / payment / confirmation / tracking
- error branches:
  - unknown deal -> `404`
  - invalid OTP -> `400`
  - payment failure -> `402`
  - over-capacity join -> `409`

What was proven
- frontend tightening did not break the live backend-connected flow
- draft deals remain non-joinable
- tracking remains coherent after UX tightening
