# R5 Supabase Auth cutover plan

Status: execution runbook proposal. Every hosted, migration, secret, deploy, or production-data step requires its own approval and change window. Nothing in this document has been applied.

## Objective and non-negotiable rules

Move buyer, seller, admin, and distributor authentication to Supabase Auth while keeping authorization in the Fastify/Postgres domain model and preserving a rollback path until the new identity/session layer is proven.

Rules:

1. Do not deploy a big-bang switch.
2. Do not import, bind, or merge users solely by matching email, phone, display name, legacy buyer ID, or Base44 user ID.
3. Do not accept a Supabase `user_metadata`/client role as authority.
4. Do not put a service-role key, refresh token, bootstrap admin key, or provider secret in browser assets, mobile logs, URLs, analytics, or error responses.
5. Do not let legacy and Supabase credentials resolve to different actors on the same request. Reject ambiguous/conflicting credentials.
6. Do not transfer seller deal ownership as a side effect of rebinding a login.
7. Do not retire legacy credentials or Base44 identity paths until issuance is stopped, sessions age out/revoke, data is reconciled, and rollback exit criteria are met.

## Target components

### Database bindings

Reuse the staged seller/admin/affiliate `auth_user_id` columns only after an approved migration review. Add a buyer model in a new migration rather than overloading legacy participant text:

```sql
-- Illustrative design; not an executable migration in this branch.
CREATE TABLE siton.buyer_accounts (
  buyer_account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NULL UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('Active', 'Suspended', 'Closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE siton.participants
  ADD COLUMN buyer_account_id uuid NULL
  REFERENCES siton.buyer_accounts(buyer_account_id) ON DELETE RESTRICT;
```

The final migration must follow repository conventions, include indexes, audit fields, validation constraints, rollout/backfill mechanics, and browser-role revokes/RLS treatment. Existing historical participants remain unclaimed until a fresh verified claim or reviewed reconciliation proves ownership.

If one auth user must not span actor types, add a cross-type identity-binding registry with a unique `auth_user_id`. If multi-role membership is approved, add an explicit membership/context model. Do not rely on three independent unique indexes.

### Fastify authentication adapter

Create one provider-neutral request principal interface and one Supabase adapter. A normalized principal should contain only verified fields such as:

```text
authUserId, sessionId, issuer, audience, expiresAt, aal, credentialChannel
```

Actor resolution is a second step returning exactly one domain actor and current status/permissions. Route guards consume the domain actor, not raw JWT claims.

JWT validation requirements:

- JWKS signature verification with an asymmetric algorithm allowlist.
- Exact configured issuer and audience; `role = authenticated`.
- UUID `sub` and `session_id`; valid `exp`, `nbf`, and `iat` with small documented clock skew.
- Reject Supabase anon/service-role/API keys, Base44 JWTs, legacy opaque tokens in the Supabase channel, wrong projects, unsigned/algorithm-confused tokens, and multiple conflicting credentials.
- Cache JWKS safely and retry an unknown `kid` once after bounded refresh; fail closed during sustained key-fetch failure.
- Access-token lifetime target: five minutes, subject to hosted-project support and measured refresh load. Do not exceed one hour.

### Browser contract

Use Fastify as a Backend for Frontend:

- Login/callback/refresh/logout endpoints perform Supabase Auth exchanges with the publishable key.
- Store the access and refresh token in distinct `__Host-` cookies: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`.
- Store a separate unpredictable non-HttpOnly CSRF value and require the same value in `x-csrf-token` on every state-changing cookie-authenticated request.
- Validate `Origin` against an exact allowlist; where absent by browser semantics, validate `Referer` origin. Reject `null` and unexpected origins.
- Rotate the refresh token/cookies after every successful refresh; use a single-flight refresh per browser session.
- Clear all auth/CSRF cookies on local logout even if the upstream revocation call fails; report the upstream failure for retry/operations.
- Do not expose refresh/access tokens to React or the current vanilla client. The endpoint contract should be framework-neutral.

Proposed browser routes:

```text
POST /api/auth/browser/login
GET  /api/auth/browser/callback
POST /api/auth/browser/refresh
POST /api/auth/browser/logout
GET  /api/auth/me
```

### Mobile contract

- Use Supabase Auth PKCE/OTP flow with the publishable key and an exact application redirect URI/universal-link allowlist.
- Put only the refresh token in `@siton/secure-storage`; keep the short-lived access token in memory.
- Send `Authorization: Bearer <access-token>` to Fastify. Do not duplicate it into cookies or query parameters.
- Serialize refreshes, rotate stored refresh tokens atomically, and wipe storage on logout, account removal, terminal refresh failure, or device security reset.
- Redact tokens and authorization headers from native/WebView logs, crash telemetry, analytics, and screenshots.
- A stolen unlocked device is handled through global Supabase session revocation plus the server's sensitive-route live-session checks.

### Server and worker secrets

Fastify needs public project URL/issuer, expected audience, publishable key for auth exchange, and JWKS configuration. It should not need a Supabase service-role key for normal web authentication or business queries. The Render worker continues using its dedicated PostgreSQL login. Hosted admin scripts that genuinely need elevated Auth Admin operations must be isolated, audited, short-lived, and never bundled with the web client.

## Phased rollout

### Phase 0 — freeze the contract and close current P0s

Entry: this audit is reviewed by backend, frontend/mobile, security, and operations owners.

Actions:

- Remediate AUTH-P0-01: bind join/payment intent to the verified identity and consume it exactly once. Coordinate with R3; do not produce competing OTP changes.
- Remediate AUTH-P0-02: inventory every `/api/admin/*` route, require a named actor and explicit permission for mutations, and reduce/disable bootstrap-key scope.
- Approve one-user/actor ambiguity policy and the buyer account schema.
- Decide whether the target web application is React now or later. Keep the auth BFF interface independent of that choice.
- Define exact issuer, audience, allowed redirect URIs, web origins, mobile app links, access-token lifetime, inactivity/absolute session timeouts, password/OTP/MFA policy, CAPTCHA/abuse controls, SMTP/SMS delivery, and audit retention.
- Re-fetch the official Supabase changelog/Auth release notes and pin supported SDK/JWT dependencies.

Exit:

- P0 fixes have unit, API, DB, concurrency, and negative security tests.
- Route inventory proves no admin mutation uses only `ADMIN_API_KEY`.
- Buyer schema and historical-claim policy have data/privacy approval.

Rollback: ordinary code rollback; no Supabase identities have been linked.

### Phase 1 — additive schema and verifier in dark mode

Actions:

- Apply reviewed additive binding/buyer/audit migrations in staging first.
- Implement strict JWT verification and actor resolution behind `SUPABASE_AUTH_ACCEPT=false` and per-actor feature flags.
- Add `auth_binding_audit`/equivalent immutable events for create, claim, rebind, unbind, conflict, and denial.
- Add distributed abuse limits and exact CORS/Origin/CSRF enforcement.
- Shadow-verify valid Supabase test tokens without changing the authority used by business routes. Compare resolved candidate actor with the legacy session actor; never fall back from an invalid Supabase credential to a legacy credential on the same request.
- Test JWKS rotation, cache expiry, upstream outage, clock skew, malformed claims, session revocation, and user deletion.

Suggested flags:

```text
SUPABASE_AUTH_ACCEPT=false
SUPABASE_AUTH_SHADOW=true
SUPABASE_AUTH_BUYER=false
SUPABASE_AUTH_SELLER=false
SUPABASE_AUTH_ADMIN=false
SUPABASE_AUTH_DISTRIBUTOR=false
LEGACY_AUTH_ISSUE=true
BASE44_AUTH_BRIDGE=true
```

Exit:

- Zero unexplained actor mismatches in staging/rehearsal.
- The verifier/actor resolver test suite passes without network dependency by using deterministic signing fixtures, plus one isolated hosted integration check.
- Canonical browser roles still cannot access `siton` tables/functions directly.

Rollback: turn shadow off; additive nullable columns/tables remain unused. Do not down-migrate user data as an incident response.

### Phase 2 — verified enrollment and binding

Actions by actor:

- **Admin:** invite named admins through a separately authenticated, dual-controlled enrollment. Require MFA enrollment and AAL2 before enabling the binding. Never match or invite from a shared key alone.
- **Seller:** seller logs into the existing trusted session, performs fresh Supabase verification, and confirms a binding nonce. A named identity admin reviews conflicts. Base44 `SellerIdentity` mapping is imported only as evidence, not as proof by itself.
- **Distributor:** same trusted-session plus fresh verification claim; require current verified/auth-enabled affiliate status.
- **Buyer:** create a new buyer account after fresh Supabase verification. Claim historical participation only per record through a signed, expiring, single-use claim challenge or manual review. Do not bulk match legacy phone/email/buyer IDs.

All binding transactions must lock the domain row, reject already-bound auth users/domain accounts, write immutable before/after audit, and leave deal/participant ownership unchanged except through a separate approved claim workflow.

Exit:

- Reconciliation totals by actor: eligible, invited, verified, bound, conflicted, declined, disabled, and unclaimed.
- Every conflict is quarantined; no last-write-wins binding.
- Support has safe recovery/rebind procedures that require fresh proof, AAL2 for admins, and dual control for privileged identities.

Rollback: unbind only through audited operations and preserve the domain row. Supabase account deletion is not the normal rollback.

### Phase 3 — canary authority by actor

Order: internal admins in non-production/staging, a small seller cohort, distributors, buyer cohort, then broader rollout. Admin production authority should wait until AAL2 and live revocation checks are proven; buyer authority should wait until AUTH-P0-01 is closed.

For each cohort:

1. Enable Supabase acceptance for an explicit server-side allowlisted cohort.
2. Keep legacy sessions readable for rollback, but stop accepting both credentials on one request and never silently fall back after a Supabase validation denial.
3. Compare authorization decisions, ownership, status, latency, refresh success, denial codes, and support contacts.
4. Exercise logout, password/OTP recovery, device loss, disabled user, deleted user, revoked session, key rotation, and expired token.
5. Hold for at least the longest important business lifecycle relevant to the cohort, not merely one login session.

Exit per cohort:

- No cross-tenant authorization event.
- No unresolved binding mismatch.
- Refresh/login availability and latency meet the approved SLO.
- Denial, recovery, and rollback drills succeed.

Rollback: disable that actor flag and re-enable its legacy acceptance if issuance has not yet been permanently stopped. Preserve new binding/audit records. Invalidate problematic Supabase sessions rather than deleting domain data.

### Phase 4 — make Supabase primary and stop legacy issuance

Actions:

- Set actor-specific Supabase authority on only after its canary exit passes.
- Stop issuing new legacy seller/admin/distributor/buyer sessions for that actor.
- Keep a time-bounded, monitored legacy-session read path solely for rollback/migration completion. Display a forced migration/re-authentication path rather than minting another legacy session.
- Remove all browser reliance on `x-admin-key`; rotate it after mutation scope is gone and disable it in normal production.
- Stop Base44 seller identity issuance/bootstrap after the seller mapping ledger is reconciled. Continue only explicitly approved compatibility reads/projections.
- Make Base44 tokens unconditionally invalid at Fastify; count and alert on attempts.

Exit:

- Legacy issuance count is zero for the agreed aging window.
- Active legacy session count reaches zero or all remaining sessions are intentionally revoked.
- Supabase binding coverage and conflict quarantine meet the approved threshold.
- No production code path authorizes from Base44 user/role for a canonical Fastify mutation.

Rollback: before the rollback deadline, restore legacy acceptance for existing valid app-local sessions only; do not restart password issuance automatically. If rollback needs new credentials or data changes, open a separate incident change.

### Phase 5 — retire compatibility paths

Actions only after a final approval:

- Revoke legacy sessions; remove legacy login/provision endpoints and secret hashes.
- Remove app-local admin MFA/session code once all admin flows use Supabase AAL2 and named permissions.
- Remove query tracking-token acceptance and legacy buyer-session elevation paths.
- Retire Base44 SellerIdentity/image/worker/mall compatibility in its owning workstreams; then update canonical registries/manifests/architecture gates.
- Rotate/remove obsolete environment secrets and perform a repository/build artifact secret scan.
- Consider later destructive schema cleanup only after backups, retention review, and a separate migration window.

Rollback after this phase requires a new forward migration. This is the irreversible boundary and should be declared explicitly.

## Session, revocation, and deletion policy

- Supabase refresh tokens are one-time-use session credentials; access JWTs remain usable until expiry unless Fastify performs a live session check.
- Logout must call the appropriate Supabase sign-out scope and clear local state. Use global sign-out for confirmed compromise; use local sign-out for ordinary device logout.
- Admin, identity rebind, KYC/status, payment-control, and other high-trust requests require live user/session state, current domain status, and AAL2/recent authentication as applicable.
- Every ordinary protected request still performs a fresh domain binding/status lookup, so an `auth.users` deletion that sets `auth_user_id = NULL` immediately removes business authority even while a JWT has time remaining.
- Cache public profiles freely; do not cache allow/deny actor status beyond a request for sensitive operations.
- Session audit must record stable actor/session/action IDs, outcome, reason code, source class, and correlation ID without JWTs, OTPs, secrets, or raw authorization headers.

## CORS and CSRF configuration checklist

- Exact production/staging web origins; no wildcard with credentials.
- Explicit methods and headers: `Authorization`, `Content-Type`, `X-CSRF-Token`, correlation header if used.
- Browser credentials enabled only for the exact BFF origin contract.
- Preflight caching bounded and included in change testing.
- Cookie-authenticated mutations require both exact Origin/Referer and CSRF match.
- Bearer-only mobile requests do not use browser cookies; if a request carries both channels, reject it.
- OAuth/PKCE callback state and nonce are single-use, session-bound, expiring, and exact redirect URI matched.

## Deployment checklist

Before each environment promotion:

- [ ] Fetch/review current Supabase Auth changelog and pinned SDK advisories.
- [ ] Confirm issuer, audience, JWKS URL, asymmetric signing keys, redirect origins, SMTP/SMS, CAPTCHA/abuse controls, and MFA policy.
- [ ] Confirm no service-role/bootstrap/provider secret exists in client bundles, source maps, logs, or mobile resources.
- [ ] Run unit, API, DB, security, concurrency, browser, and mobile suites from the threat-model checklist.
- [ ] Run the direct-browser RLS/revoke proof as `anon` and `authenticated`.
- [ ] Rotate a test signing key and prove unknown-`kid` behavior.
- [ ] Revoke/delete/disable test users and prove expected denial timing.
- [ ] Verify exact CORS/CSRF behavior from allowed and hostile origins.
- [ ] Reconcile binding/cohort counts and inspect conflict quarantine.
- [ ] Confirm feature flags, rollback owner, observability dashboard, support script, and decision deadline.
- [ ] Record deployed commit/migration IDs and approval evidence.

## Monitoring and stop conditions

Monitor by actor and release cohort:

- Login/OTP/MFA/refresh success and error reason; latency and provider delivery failures.
- JWT denial reason (redacted), unknown `kid`, issuer/audience mismatch, expired/stale session, ambiguous/unbound actor.
- Binding creates/rebinds/conflicts and Base44/legacy credential attempts.
- Authorization denials by route/resource class, including cross-owner probes.
- CSRF/origin/CORS failures, rate-limit saturation, and anomalous IP/device patterns.
- Admin high-trust actions, approvals, and live-revocation denials.

Immediately stop cohort expansion for any cross-tenant access, privilege escalation, duplicate/incorrect binding, un-attributable admin mutation, token/secret disclosure, systematic refresh failure, or inability to execute the tested rollback.

## Ownership and coordination boundaries

- R3 owns its OTP work; R5 supplies identity-binding requirements and tests without competing edits.
- R4 owns Render worker readiness; R5 preserves the dedicated worker identity boundary and does not duplicate runtime/worker changes.
- Payment and Base44 transitions are separate authorized workstreams. R5 identifies their auth dependencies but makes no live or compatibility change.
- `PROJECT_STATUS.md` is intentionally untouched by this branch.
