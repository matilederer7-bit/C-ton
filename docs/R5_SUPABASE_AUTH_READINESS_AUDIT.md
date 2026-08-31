# R5 Supabase Auth readiness audit

Status: **BLOCKED FOR AUTH CUTOVER**

Audit date: 2026-08-31

Branch baseline: `f51579c88c35c1d44e94aacf6163faa1449a24a3` (`origin/master` at branch creation)

Scope: repository inspection and safe planning only. No hosted Supabase configuration, migration, deployment, Base44, payment, or live-data changes were made.

## Executive decision

SITON is not ready to switch its human identities to Supabase Auth. The database already contains useful nullable `auth_user_id` foundations for sellers, admins, and distributors, and the Supabase staging boundary correctly blocks browser roles from the canonical schema. The Fastify runtime, however, does not yet verify Supabase JWTs, resolve a canonical actor from `auth_user_id`, or bind buyers to `auth.users`. The checked-in browser is also a vanilla JavaScript application rather than the target React client described for R5.

Two current-state issues require remediation independently of the eventual provider cutover:

1. **AUTH-P0-01 — buyer OTP proof is not bound to the submitted buyer identity.** A caller can verify an OTP for one destination and submit a different client-controlled `buyer_id`/phone to join a deal. A consumed challenge/proof can also be replayed during its proof window with new idempotency keys. Evidence: `src/app.ts` join and payment authorization handlers plus `ensureJoinOtpVerified` in `src/otp_rail.ts`.
2. **AUTH-P0-02 — the bootstrap admin key is a shared mutation credential.** Many `/api/admin/*` read and write routes call `requireAdminKey` directly, and audit attribution can come from caller-controlled `x-admin-user`. This conflicts with the intended `BootstrapReadOnly` interpretation in `src/admin_identity.ts` and prevents attributable least-privilege administration.

These findings do not authorize a hot fix on this parallel branch. They are explicit release blockers with required negative tests in the cutover plan and threat model.

## Current identity and session inventory

| Actor | Current identity source | Session/token | Current authorization source | Immediate revocation |
|---|---|---|---|---|
| Buyer | OTP challenge/proof tied to channel destination and, optionally, deal | `siton_buyer_session` cookie (24h) plus participant tracking bearer token (45d) | Client `buyer_id`, OTP proof, deal/participant records | Cookie session can be revoked; tracking token can be revoked; an OTP proof remains reusable inside its validity window |
| Seller | `siton.seller_accounts`, `login_email` or `seller_id`, scrypt access secret | `siton_seller_session` opaque cookie (12h); DB stores secret-peppered SHA-256 | Resolved session seller plus per-deal `seller_id` ownership checks | Yes: session revocation and fresh `auth_enabled` check |
| Admin | `siton.admin_users`, scrypt password, optional app-local MFA | Named opaque session (8h) or shared `ADMIN_API_KEY` | Named role/permission map for Admin Actions; shared key on many other routes | Named session: yes; shared key: only by rotating/removing the environment secret |
| Distributor | `siton.affiliate_accounts`, affiliate code/email, scrypt secret | `siton_distributor_session` opaque cookie (12h) | Resolved affiliate account; attribution-only capabilities | Yes: session revocation and fresh verification/auth-enabled checks |
| Worker/system | Render worker using PostgreSQL login `siton_worker_login` | Database connection, no human browser JWT | `siton_worker_runtime` database role plus server code | Credential rotation / worker shutdown |
| Anonymous/public | No identity | None | Published/read-only routes and explicitly public event/chat surfaces | Not applicable |

### Seller

- Non-demo seller authority is server-resolved from `siton_seller_session`; client `x-seller-id` is ignored outside demo mode.
- Opaque session tokens are random, hashed before storage, expire after 12 hours, and are checked against `seller_accounts.auth_enabled` on use.
- Deal mutation handlers generally enforce `deals.seller_id = resolved seller_id` and return not-found for a non-owner, which is the correct anti-enumeration shape.
- `seller_accounts.auth_user_id` exists only in the Supabase staging migration. No runtime code reads it.
- `deals.seller_id` is indexed but is not protected by a database foreign key to `seller_accounts`; orphaned or incorrectly transferred ownership therefore remains possible through privileged code or maintenance operations.
- Provision/rotation revokes existing app-local sessions. Login is subject to the global in-process rate limiter only; there is no account/destination-specific seller login limiter.
- Stored session IP address and user agent are plaintext operational data and need a retention/redaction decision.

### Buyer

- The present buyer mechanism is proof of possession of a phone/email channel, not a canonical account. There is no `buyer_accounts` row and no buyer `auth_user_id` binding.
- `buyer_sessions.buyer_identity_hash` is a SHA-256 of normalized channel/destination, while participant `buyer_id` and `buyer_phone` remain client-originated text. These are not equivalent identities.
- The join handler validates that an OTP proof is consumed, unexpired, has purpose `buyer_join`, and matches the deal. It does **not** pass the submitted channel/destination to `ensureJoinOtpVerified` and does not compare `verifiedBuyerIdentityHash` with the submitted participant identity.
- `ensureJoinOtpVerified` accepts either a signed `otp_token` or a bare consumed `otp_challenge_id`. The same proof can authorize multiple calls until expiry; idempotency protects duplicate keys, not a different key.
- Participant tracking tokens are strong random bearer secrets stored as hashes, but may be supplied in query parameters and live for 45 days. Query tokens can leak through logs, browser history, referrers, screenshots, and copied URLs.
- Payment authorization repeats the OTP/client-identity split. Payment status is publicly queryable by provider reference/status inputs and should be treated as an information oracle until constrained.

### Admin

- Named admins have a closed role-to-permission mapping: `SuperAdmin`, `OpsAdmin`, `SupportAdmin`, and `ReadOnlyAdmin`. Sensitive Admin Actions support recent-MFA and second-approval controls.
- Many ordinary admin routes bypass that model and accept only `x-admin-key`. The same shared key can provision seller/distributor credentials, change seller status, make KYC decisions, and mutate support workflows.
- `x-admin-user` is not cryptographically bound to the shared key, so it cannot support reliable individual attribution.
- App-local MFA generates a six-digit code with `Math.random()`, hashes it without a secret pepper, has no per-challenge attempts column, and has no complete email delivery rail in the inspected runtime. It is not production-grade MFA.
- Admin login receives only the global in-process per-IP rate limit. A named admin is checked for `status = Active` on every session resolution, which is a strong current revocation property that the Supabase design must preserve.
- The browser does not contain an `x-admin-key` integration. The key must never be added to browser code, so current key-only routes are also an integration blocker for named web admins.

### Distributor

- Distributor identity and sessions mirror the seller pattern and require both `auth_enabled` and `verification_status = verified`.
- `affiliate_accounts.auth_user_id` exists but is unused by runtime resolution.
- The repository correctly models distributors as attribution actors only: they can manage their own affiliate links and view their own attribution analytics, but have no commission, payout, seller, deal, or payment authority.
- Login receives only the global in-process per-IP rate limit.

### Anonymous and worker boundaries

- Published deal/mall discovery surfaces are intentionally public. Public deal-chat writes accept a caller-selected display name and currently have no identity-bound anti-impersonation control.
- The global Fastify limiter defaults to 200 requests/minute/IP. `/api/otp` and `/api/deals*` share a stricter 20 requests/minute/IP bucket. It is an in-memory, single-instance mechanism and therefore not an authoritative multi-instance defense.
- OTP also applies a destination limit of five requests per fifteen minutes, but its count-then-insert pattern is not a distributed atomic rate limiter.
- The worker is not an HTTP identity. It should continue to authenticate to Postgres with a narrowly privileged NOLOGIN runtime role assumed through its dedicated login, not with a human JWT or browser/service-role key.

## Supabase readiness inventory

### Already useful

- `supabase/staging/002_auth_identity_foundation.sql` adds nullable, partially unique `auth_user_id uuid` columns to seller, admin, and affiliate accounts.
- Each binding references `auth.users(id) ON DELETE SET NULL`, preserving business records while removing the deleted identity binding.
- Staging migrations revoke browser-role access to the canonical `siton` schema, tables, sequences, and functions; RLS is enabled and public function execution is revoked.
- Web and worker database logins assume distinct `siton_web_runtime` and `siton_worker_runtime` roles. The roles are NOLOGIN/NOINHERIT and lack superuser, database creation, role creation, replication, and `BYPASSRLS` capabilities.

### Missing or unsafe for cutover

- No Supabase Auth client dependency, backend exchange route, JWKS/JWT verifier, session refresh path, or canonical actor resolver exists.
- No buyer account/binding exists. Historical phone/email data is not safe to auto-link because the current join flow allows a verified channel and submitted buyer identity to differ.
- Unique indexes prevent duplicate bindings within one actor table but do not prevent the same `auth.users.id` from being bound simultaneously as seller, admin, and distributor. An explicit cross-role policy is required.
- Existing login emails are unique only inside their individual actor tables. Email or phone matching across tables is not identity proof and must not be used for automated backfill.
- Domain role/status must be loaded from canonical tables on every protected request. `user_metadata` is user-controlled and must never authorize; `app_metadata` and other JWT claims can remain stale until token refresh.
- Auth user deletion does not immediately invalidate a previously issued access token. The `ON DELETE SET NULL` bindings help only if every protected request performs a fresh binding/status lookup.
- The current broad web runtime table privileges plus RLS `USING (true)` mean Fastify remains the business authorization boundary. This is intentional, but it makes JWT and ownership regressions server-critical.
- The staging inventory helper grants `service_role` execution. R5 web traffic does not require a service-role key and should not introduce one; any retained administrative use must remain server-only and narrowly scoped.

## Required target trust boundaries

```text
Public browser ── public reads ───────────────────────────────▶ Fastify
Browser user ── HttpOnly Supabase session + CSRF proof ─────▶ Fastify
Mobile user ── Supabase access-token Bearer ────────────────▶ Fastify
Fastify ── JWKS verification + fresh actor binding/status ─▶ Canonical Postgres
Render worker ── dedicated DB login/runtime role ──────────▶ Canonical Postgres
Base44 legacy ── explicit compatibility bridge only ───────▶ no authority after cutoff
```

The browser should use a Backend-for-Frontend session: Fastify performs Supabase login/PKCE exchange/refresh using the publishable key, stores access and refresh tokens in `__Host-` HttpOnly, Secure, SameSite=Lax cookies, and requires an exact-origin check plus a double-submit CSRF token on every state-changing request. The frontend must never receive the service-role key or treat decoded claims as authorization.

The mobile application should keep the refresh token only in the existing Keychain/Android Keystore-backed secure-storage plugin, keep access tokens in memory, and send the access token as `Authorization: Bearer`. Logout must revoke the Supabase session and wipe secure storage. Fastify must reject requests that present conflicting cookie and bearer identities.

## Base44 dependency map

| Dependency | Present authority | R5 handling | Priority |
|---|---|---|---|
| `siton-seller-bootstrap` + `SellerIdentity` | Base44 user ID maps to canonical seller ID | Build an audited Supabase `auth_user_id` binding ledger; never accept a Base44 token at the Fastify verifier | P0 before seller cutover |
| `siton-seller-deal-image` + `DealImage` | Base44 auth and service-role entity/storage access | Replace identity check with Fastify seller-owner resolution; storage migration is a separate authorized workstream | P0/P1 |
| `project-mall-deal` | Base44 admin plus service-role projection | Retain as compatibility projection during dual-read validation, then remove | P1 |
| `siton-worker-tick` | Base44 admin invokes service-role worker function | R4/Render worker replacement; do not duplicate work on R5 | P1 |
| `list-mall-deals`, `record-mall-event` | Base44 service-role projection/event entities | Preserve only while the legacy mall remains in service; no human auth authority | P1/P2 |
| Registry/manifests/architecture gates | Declare Base44 current production | Update only in the coordinated production cutover after evidence; not on this branch | P2 cleanup |

## Browser and mobile findings

- The checked-in web client is `frontend/app.js` plus server-generated runtime assets; React is not installed. R5 must either make the BFF contract framework-neutral first or explicitly include the React migration as a separate prerequisite.
- Fetches currently use cookie credentials and same-origin behavior. There is no repository CORS plugin and no explicit CSRF/Origin validation layer.
- `SameSite=Lax`, `HttpOnly`, and production `Secure` cookies are useful controls but do not defend against a compromised same-site subdomain or every CSRF condition.
- Capacitor already provides an HTTPS scheme and a secure-storage bridge. Pending-payment state uses that bridge, but authentication tokens do not.
- Cross-device recovery must create a new Supabase session after fresh verification; tracking URLs and legacy buyer session cookies must never be promoted into canonical account credentials.

## Prioritized findings

### P0 — must close before any auth cutover

| ID | Finding | Required closure |
|---|---|---|
| AUTH-P0-01 | OTP proof and submitted buyer identity are not bound; proof can be replayed across distinct requests | Derive buyer identity exclusively from verified Supabase `sub`/canonical buyer row; single-use transition test; reject mismatched legacy proof |
| AUTH-P0-02 | Shared `ADMIN_API_KEY` authorizes mutations and allows spoofed audit actor | Move every admin route to named actor + explicit permission; make bootstrap key read-only/disabled; negative route-inventory test |
| R5-P0-03 | Fastify has no strict Supabase JWT verifier/actor resolver | Implement the validation contract below and fail closed for all protected routes |
| R5-P0-04 | Buyers have no canonical account or `auth_user_id` binding | Add approved schema/migration and safe claim flow; do not auto-link history by phone/email |
| R5-P0-05 | Base44 SellerIdentity remains a production seller authority | Build and reconcile an immutable binding ledger; disable legacy issuance before rejecting Base44 tokens |

### P1 — required before production rollout or immediately scoped follow-up

- Replace app-local admin MFA with Supabase MFA/AAL2 and require a fresh session check for sensitive actions.
- Add shared/distributed rate limiting for login, refresh, recovery, OTP, join, and admin endpoints, keyed by IP plus normalized account/destination/device signals.
- Add CSRF and exact-origin enforcement for cookie-authenticated mutations and an explicit CORS allowlist.
- Reject tracking tokens in query strings; rotate to short-lived exchange codes or authenticated buyer ownership.
- Close the public payment-status oracle and identity-bind payment authorization.
- Identity-bind chat writes and server-derive display identity.
- Enforce and test an explicit one-user/one-actor or allowed-cross-role policy.
- Add the missing seller ownership foreign-key/control strategy without conflating identity rebind with ownership transfer.
- Replace the default OTP hash salt and make OTP consumption/rate limits distributed and atomic. Coordinate with the in-flight R3 OTP task.

### P2 — cleanup after stable cutover

- Retire legacy seller/admin/distributor/buyer session tables, secret hashes, and credential endpoints after the rollback window.
- Remove Base44 compatibility functions/entities and update the canonical registry and architecture gates only after traffic and data reconciliation prove retirement.
- Define retention/minimization for session IP/user-agent and authentication audit data.
- Remove stale app-local MFA and authorization compatibility code.

## Strict JWT and actor-resolution contract

Fastify must perform all of the following before a protected route runs:

1. Accept exactly one configured credential channel: canonical browser access cookie or mobile `Authorization: Bearer`; reject ambiguity and legacy Base44/app tokens.
2. Verify signature against the project JWKS using an allowlist of asymmetric algorithms and cached keys with bounded refresh.
3. Require exact configured issuer, configured audience (normally `authenticated`, verified against project settings), `role = authenticated`, UUID `sub`, valid `exp`, `nbf`/`iat`, and UUID `session_id`.
4. Reject anonymous, service-role, malformed, wrong-project, wrong-audience, expired, future, or algorithm-confused tokens.
5. Resolve `sub` against the endpoint's canonical actor table, require exactly one allowed binding, and load status/role/ownership from Postgres. Never authorize from client metadata or decoded claims alone.
6. For admin and other sensitive operations, require AAL2 where applicable and verify current session/user state through the authoritative Supabase path or a live `auth.sessions` check. A short access-token lifetime is not immediate revocation.
7. Continue returning not-found for cross-tenant object access where that avoids enumeration; log the stable internal denial reason without secrets.

## Evidence and source references

Repository evidence was collected from `src/app.ts`, `src/frontend_runtime.ts`, `src/seller_auth.ts`, `src/admin_identity.ts`, `src/distributor_identity.ts`, `src/buyer_session.ts`, `src/otp_rail.ts`, `src/participant_tracking_security.ts`, migrations `014a`, `015`, `017`, `028`, `031`, `036`, `042`, `046`, and `048`, all `supabase/staging` security/auth migrations, the six checked-in `base44/functions`, Base44 entity/config registries, `frontend/mobile-bridge.js`, and the native secure-storage plugins.

Official Supabase operational references reviewed on 2026-08-31:

- <https://supabase.com/docs/guides/auth/signing-keys>
- <https://supabase.com/docs/guides/auth/jwts>
- <https://supabase.com/docs/guides/auth/sessions>
- <https://supabase.com/docs/guides/auth/signout>
- <https://supabase.com/docs/guides/auth/users>
- <https://supabase.com/docs/guides/auth/server-side/creating-a-client>
- <https://supabase.com/docs/reference/javascript/auth-getclaims>
- <https://supabase.com/docs/guides/database/postgres/row-level-security>

The current changelog endpoint was requested during the audit but returned an empty response from this environment; no absence-of-breaking-change claim is made. The implementation owner must re-check the official changelog and Auth release notes immediately before dependency selection and each production cutover gate.
