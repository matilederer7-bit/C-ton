# R5 authentication and authorization threat model

Status: repository-specific pre-cutover model. “Current protection” describes inspected code; “required control” is not yet implemented unless explicitly stated.

## Assets and trust boundaries

Protected assets include canonical actor bindings, seller drafts and ownership, buyer participation/order data, admin permissions/audit attribution, affiliate attribution, payment/lifecycle commands, Supabase sessions/refresh tokens, Base44 compatibility mappings, worker credentials, and canonical Postgres data.

Trust boundaries:

1. Anonymous internet to Fastify public routes.
2. Browser/React or current vanilla web client to the Fastify BFF.
3. Capacitor mobile/WebView/native secure storage to Fastify and Supabase Auth.
4. Fastify verified principal to canonical actor binding/authorization.
5. Fastify and Render worker dedicated DB logins to Postgres.
6. Supabase Auth/Auth schema to SITON domain bindings.
7. Legacy Base44 functions/entities to canonical Fastify/Postgres compatibility surfaces.
8. Operators/admins and secret/configuration systems to production control planes.

## Risk rating

- **P0:** credible cross-identity, cross-tenant, admin, or money-control compromise; or an architectural blocker that makes cutover unsafe.
- **P1:** material account/session/data abuse requiring closure before broad production rollout.
- **P2:** defense-in-depth, cleanup, or bounded compatibility debt.

## Attack-case matrix

| ID / attack | Current protection | Current gap | Required R5 control | Required regression test | Priority |
|---|---|---|---|---|---|
| T01 Buyer pretends to be a seller | Non-demo seller mutations resolve an opaque seller session and ignore `x-seller-id` | Supabase actor resolver does not exist; a future generic “authenticated” guard would be insufficient | Resolve endpoint-specific seller binding and seller status; never accept body/header role or actor ID | Buyer JWT on every seller mutation returns deny/not-found; no DB write/audit actor confusion | P0 cutover |
| T02 Seller accesses another seller’s draft | Most current mutations compare session seller with `deals.seller_id` and use not-found | Route inventory is large; no central resource policy, and seller FK is absent | Central seller-owner loader used by all draft/image/delivery/lifecycle routes; DB integrity strategy | Table-driven cross-owner GET/POST/PATCH/DELETE tests for every seller resource family | P0 cutover |
| T03 Distributor escalates into seller/commercial rights | Distributor routes resolve own affiliate; schema removed commission/payout authority | Generic JWT role/membership or ambiguous cross-table binding could grant a second actor | Explicit actor context; distributor allowlist ends at own links/analytics; deny commercial fields/actions | Distributor JWT denied on seller, deal, order, payment, commission, payout, admin and worker routes | P0 cutover |
| T04 Seller escalates to admin | Named admin permissions are server-defined | Same Supabase user can currently be bound across actor tables; shared admin key bypasses named identity | Cross-actor uniqueness or explicit step-up context; named admin binding/status/AAL2; remove mutation key | Seller token with forged admin metadata and a multi-bound fixture is denied/quarantined | P0 |
| T05 Client injects role/permission claims | Current app-local sessions load roles from DB | Supabase implementation could trust `user_metadata`, `app_metadata`, or decoded claims; app metadata can be stale | JWT claims authenticate only; canonical DB tables authorize on every request | Tokens with forged user metadata/app metadata cannot change capability | P0 cutover |
| T06 Stale JWT retains disabled seller/distributor rights | Current app-local resolver checks `auth_enabled`/verification on each request | Access JWT persists until expiry; claim-only guards would remain active | Fresh domain binding/status check on every protected request | Disable actor after token issuance; next protected call denied without waiting for token expiry | P0 cutover |
| T07 Deleted/disabled admin token remains usable | Current named admin session checks `status = Active` | Supabase deletion does not inherently revoke an already-issued access JWT; app-local shared key unaffected | `ON DELETE SET NULL` plus fresh admin binding/status; live Supabase session/user check for high trust; short JWT | Delete/unbind/disable/revoke admin and retry read, write and high-trust routes | P0 |
| T08 Buyer OTP identity substitution | OTP purpose/deal/expiry/consumption are checked | Join/payment handlers do not bind proof destination/hash to submitted `buyer_id`/phone; client identity is persisted | Derive buyer from verified Supabase `sub` and canonical buyer row; legacy compatibility must compare immutable identity hash | Verify OTP for A, submit B; must fail with no participant/payment/tracking write | **P0 current** |
| T09 OTP/proof replay | Verify transition is atomic and challenge becomes consumed; proof has 15m expiry | Consumed challenge/proof is reusable across calls and distinct idempotency keys | Single-use join/payment intent atomically bound to buyer, deal and operation; consume in same transaction | Concurrent and sequential replay with different idempotency keys yields exactly one authorized transition | **P0 current** |
| T10 Shared admin-key privilege/audit spoof | Timing-safe secret comparison; production fail-closed if key absent | Many mutation routes require only the shared key; `x-admin-user` can be caller-selected | Named Supabase admin + explicit permission for every mutation; bootstrap key read-only/disabled | Route inventory asserts no mutating admin handler calls only `requireAdminKey`; spoof header has no authority | **P0 current** |
| T11 Horizontal IDOR by identifier guessing | Many seller checks return 404; participant tracking token is required in production | Public payment status, public chat writes, legacy participant identity and heterogeneous route guards leave gaps | Central actor/resource guards, opaque IDs, minimal projections, identity-bound payment/chat/buyer data | Cross-user corpus for valid/invalid UUIDs/provider refs; status/body/timing do not reveal protected existence | P0/P1 |
| T12 Session fixation or credential confusion | App-local login mints a fresh random session and revokes on rotation | No R5 channel rules; cookie and bearer or legacy and Supabase credentials could conflict | Rotate at login/refresh; accept one credential channel; reject conflicts; bind CSRF/state/PKCE to session | Supply two valid identities in cookie/bearer and legacy/new channels; always reject, never choose first | P1 |
| T13 Refresh-token replay | Not applicable to current opaque sessions | Mobile/browser Supabase refresh handling not built | Server/mobile single-flight refresh, atomic token replacement, reuse detection/telemetry, session revocation | Replay old refresh after rotation from same and second device; session follows documented revocation behavior | P1 |
| T14 Login/OTP brute force and enumeration | Global 200/min/IP; sensitive OTP/deals 20/min/IP; OTP five/15m/destination and three verify attempts; masked destination | Limiter is per-process; seller/admin/distributor login gets only global bucket; OTP request count is not distributed atomic; admin MFA has no attempts control | Shared rate limiter/WAF using IP + account/destination/device; generic responses; exponential/circuit policy; CAPTCHA where approved | Multi-instance/concurrent limits, identifier variants, IPv6 normalization, enumeration response/timing tests | P1 |
| T15 OTP secret/hash weakness | OTP codes are not logged and hashes are challenge-specific HMAC | `OTP_HASH_SALT` has a hard-coded default; six-digit space makes DB-offline guessing feasible if secret is known/default | Required high-entropy hosted secret, startup guard, rotation procedure, short retention; Supabase provider protections | Production startup fails with default/missing secret; logs/artifacts never contain OTP | P1 |
| T16 Admin MFA bypass/guessing | Named high-trust actions can require recent MFA/approval | App-local code uses `Math.random()`, unpeppered hash, no attempt counter/distributed limiter, incomplete delivery | Supabase MFA AAL2, verified factor, recent-auth timestamp, recovery/unenrollment dual control | AAL1, stale AAL2, removed factor, guessed/replayed challenge and downgraded token all denied | P0/P1 |
| T17 CSRF/same-site subdomain attack | Cookies are HttpOnly, SameSite=Lax and Secure in production | No explicit CSRF token or Origin/Referer validation; same-site compromise remains relevant | `__Host-` cookies, exact Origin/Referer and double-submit token on mutations; narrow CORS | Cross-origin form/fetch, missing/mismatched token, `Origin:null`, hostile sibling origin all denied | P1 |
| T18 CORS token theft | Same-origin deployment; no permissive CORS plugin found | R5 mobile/bearer integration may add unsafe wildcard/credentials policy | Exact allowlist; never `*` with credentials; minimal methods/headers; no sensitive response on disallowed origin | Preflight and credentialed requests from approved, hostile and `null` origins | P1 |
| T19 Email/phone takeover or unsafe merge | Seller/admin/affiliate emails unique within their tables; OTP proves one current channel | No cross-actor uniqueness; historical buyer data cannot be trusted; recycled phone/email and provider account changes can misbind history | Fresh claim proof plus old trusted session/manual review; conflict quarantine; no automatic email/phone linking; dual-control rebind | Duplicate/recycled identifiers, case/Unicode normalization, provider-change and already-bound cases fail safely | P0/P1 |
| T20 Cross-device recovery hijack | Buyer recovery/OTP rails exist; current sessions are server records | Long-lived tracking/query token can leak and could be mistaken for account proof | New Supabase session only after fresh provider verification; tracking token never establishes canonical binding; notify/revoke old sessions | Leaked tracking URL cannot create/rebind account; recovery revokes/retains sessions per policy | P1 |
| T21 Mobile device/token theft | Native plugin uses Android Keystore AES-GCM and iOS Keychain `AfterFirstUnlockThisDeviceOnly`; 64KiB bound | Auth tokens are not yet wired; access token could be persisted/logged during implementation | Refresh token only in secure storage, access token memory, wipe on logout/reset, redacted telemetry, global revoke response | Static bundle/log scan; cold start/logout/reset/device-clone and stolen-refresh revocation tests | P1 |
| T22 Base44 token used after cutover | Fastify currently does not use Base44 bearer tokens | Legacy SellerIdentity/functions remain production authority; careless compatibility fallback creates split brain | Exact Supabase issuer/audience/JWKS; Base44 tokens categorically rejected; binding ledger reconciled before legacy issuance stops | Valid legacy Base44 tokens against every protected Fastify actor family return 401/deny and alert | P0 cutover |
| T23 Base44 identity mapping takeover/race | Seller bootstrap has deterministic IDs and concurrency handling | Base44 mapping is separate from Supabase binding; automatic import could map wrong domain row | Immutable reviewed mapping ledger, row locks/unique constraints, conflict quarantine, no ownership rewrite | Concurrent claims/imports for same auth user/seller yield one binding or quarantine, never last-write-wins | P0 cutover |
| T24 Service-role key leakage | Browser roles are revoked from canonical schema; no Supabase client dependency today | Staging helper has a service-role grant; future web/mobile code could introduce the key | Web uses publishable key and dedicated DB login only; elevated Auth Admin job isolated; secret/bundle/log scanning | Build artifacts/source maps/mobile resources contain no service-role/JWT/provider secret | P0 |
| T25 Direct browser database access | `anon`/`authenticated` schema/table/sequence/function privileges revoked; RLS enabled; public function exec revoked | Future migrations/functions/views can reopen access; `security definer`/view ownership are common bypass risks | Migration gate inventories all objects/grants, explicit revokes, `security_invoker` views, safe function search path/ownership | Connect as anon/authenticated and prove zero canonical read/write/execute; regression on every migration | P0 cutover |
| T26 Worker impersonation or confused deputy | Dedicated `siton_worker_login`/runtime role; no worker HTTP identity | Admin/Base44 tick paths and overly broad DB grants can blur who triggered a mutation | No human token starts raw worker execution; queued typed commands, leases/idempotency, trigger actor/action audit | Seller/admin/distributor tokens cannot claim jobs; worker cannot create human admin bindings/sessions | P1 |
| T27 Public chat impersonation/spam | Global rate limit and content validation | Writes are public with caller-controlled display name; global limiter is not distributed | Require buyer/owning seller identity for writes, server-derived display, moderation limit and audit | Forged display/actor fields ignored; anonymous write denied; multi-instance abuse limit | P1 |
| T28 Tracking token leaks via URL | Strong random token; hashed in DB; revocable | Query parameters accepted, 45-day lifetime | Reject query tokens; short-lived one-time exchange or authenticated buyer access; rotate old links | Token in query is denied and not logged; exchanged token cannot replay | P1 |
| T29 JWT signing-key rotation/outage | No verifier today | Incorrect key cache can reject all users or accept stale/untrusted key material | Asymmetric keys, bounded JWKS cache, unknown-`kid` refresh once, algorithm/issuer pinning, fail closed, operational alert | Old/new key overlap, unknown key, JWKS timeout/corrupt response and algorithm confusion fixtures | P1 |
| T30 Sensitive information in logs/errors | OTP provider logging redacts code; error handler hides most 5xx detail | Plain session IP/UA retained; future JWT/auth errors may log tokens/provider payloads | Structured allowlisted auth audit, secret/header/PII redaction, retention/access control | Canary secrets/tokens never appear in application, proxy, worker, mobile or analytics logs | P1/P2 |

## Abuse stories that must remain impossible

### Buyer-to-seller

A buyer authenticates successfully, changes `seller_id` or a role field, and calls a draft mutation. The route must resolve the buyer actor first and reject before querying or changing the target draft. A generic `authenticated` check is a failure.

### Cross-seller draft access

Seller A obtains Seller B's deal/image/delivery identifier. Every read and mutation must combine identifier and Seller A's canonical seller ID in the server query. Responses for non-owned and nonexistent resources should be indistinguishable to the caller.

### Distributor commercial escalation

A verified distributor changes a URL/body field to a seller/account/deal/payment ID or forges metadata. The distributor actor can only reach its own link/attribution projections. It cannot acquire commissions, payouts, seller ownership, lifecycle, or payment controls because those capabilities do not exist in its policy.

### Seller-to-admin

A seller binds or forges the same email and adds `role=admin` metadata. Fastify must resolve only the canonical allowed actor context. An ambiguous multi-table binding is a security error, not an invitation to select the most privileged match.

### Deleted admin with unexpired token

An admin's Supabase user or domain binding is deleted/disabled after token issuance. The next high-trust call must fail because Fastify checks the live session/user and fresh active admin binding; ordinary admin calls also fail on the absent/inactive domain row.

### Base44 token after cutoff

A still-valid Base44 token is sent in the bearer header after seller cutover. Signature validation fails the exact Supabase issuer/JWKS contract. No legacy fallback runs, and a redacted legacy-token-attempt metric is emitted.

## Mandatory test layers

### Unit

- JWT claim/signature/algorithm/clock validation fixtures.
- Credential-channel conflict parsing.
- Actor binding resolution: zero, one, multiple, inactive, unbound, wrong actor.
- Permission/ownership decision tables and CSRF/origin decisions.

### Database and migration

- Uniqueness, FK deletion behavior, actor ambiguity enforcement, historical nullability, row locking, and binding audit immutability.
- Direct-role proofs for `anon`, `authenticated`, web runtime, worker runtime, and any narrowly retained service role.
- No unsafe `SECURITY DEFINER`, default execute, view owner bypass, or writable browser path.

### API and browser

- Positive matrix paths plus every negative assertion in `R5_AUTHORIZATION_MATRIX.md`.
- Exact-origin CORS/CSRF, cookie flags, refresh rotation/single flight, logout, expired/stale/deleted/revoked sessions.
- No cross-tenant response distinction or protected-field leakage.

### Concurrency

- OTP/join/payment intent single consumption.
- Seller/buyer/admin/distributor bind and rebind races.
- Refresh reuse, duplicate callbacks, duplicate approvals, job lease/idempotency.

### Mobile

- PKCE/deep-link state and redirect validation.
- Secure refresh-token persistence, access-token memory-only, wipe/recovery, offline expiry, concurrent refresh, revoked/device-lost behavior.
- Android/iOS build artifact and logging scans.

### Operational drills

- Supabase/JWKS/SMTP/SMS outage, signing-key rotation, global session revocation, user deletion, actor disable, feature-flag rollback, legacy credential rejection, Base44 shutdown, and audit export/review.

## Acceptance condition

R5 is security-ready only when all P0 rows have implemented controls and passing tests, all production-entry P1 rows have an accepted closure or time-bound risk owner, and the staged cutover/rollback drills produce attributable evidence. A green happy-path login test alone is not an auth readiness signal.
