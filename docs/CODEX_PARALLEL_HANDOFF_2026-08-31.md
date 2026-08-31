# Codex parallel handoff — 2026-08-31

## Branch and isolation

- Branch: `codex/r5-auth-readiness`
- Worktree: `C:\Users\Lenovo\Documents\C-ton-r5-auth-readiness`
- Created from the then-current `origin/master`: `f51579c88c35c1d44e94aacf6163faa1449a24a3`
- Baseline subject: `docs: close overnight run - R4 CI green, final checkpoint and resume steps`
- Scope is documentation/audit only. No hosted Supabase setting, migration, deploy, Base44, payment, production-data, or live-secret action was performed.
- `PROJECT_STATUS.md` was not edited.
- No R3 OTP or R4 Render worker source was edited, avoiding the active parallel workstreams.

After the first R5 push, `origin/master` advanced to `9ef4879227c3997bcd33091bf508ded9fa629514` (`R3: hosted Web runtime CLOSED green on live Supabase staging`). The only mainline change from the R5 baseline is `PROJECT_STATUS.md`; it has no file overlap with this branch. The R5 branch was intentionally not rebased or history-rewritten.

## Deliverables

- `docs/R5_SUPABASE_AUTH_READINESS_AUDIT.md` — current identity/session inventory, Supabase/DB readiness, browser/mobile/server/worker boundaries, Base44 dependency map, prioritized findings, and strict JWT contract.
- `docs/R5_AUTHORIZATION_MATRIX.md` — normative buyer/seller/admin/distributor/anonymous/worker capabilities, route-family mapping, ownership rules, admin controls, ambiguity policy, and negative assertions.
- `docs/R5_AUTH_CUTOVER_PLAN.md` — phased additive rollout, binding/enrollment, canaries, feature flags, rollback, session/revocation behavior, CORS/CSRF, deployment checks, monitoring, and ownership boundaries.
- `docs/R5_AUTH_THREAT_MODEL.md` — thirty repository-specific attack cases with current protection, current gap, required control, regression test, and priority.
- This handoff.

No implementation code was added because the safe, coherent fixes require coordinated OTP, admin-route, schema, frontend/mobile, and hosted configuration decisions. A partial verifier or isolated schema sketch would create a misleading readiness signal.

## Executive verdict

**Supabase Auth cutover is blocked.** Existing staging migrations provide a strong start for seller/admin/affiliate bindings and direct-browser database denial, but Fastify has no Supabase verifier or actor resolver and buyers have no canonical Auth binding.

### Current P0 security findings

1. **AUTH-P0-01: OTP proof is not bound to the submitted buyer identity.** The join and payment authorization paths validate a consumed proof for a deal but persist/use a caller-controlled buyer ID/contact without comparing it to the verified destination hash. Proof is also reusable within the proof window under distinct idempotency keys.
2. **AUTH-P0-02: the shared bootstrap admin key authorizes mutations.** Many `/api/admin/*` routes call `requireAdminKey` directly, including seller/distributor provisioning, seller status, KYC, and support mutation paths. Caller-controlled `x-admin-user` cannot establish attributable identity.

These findings are documented rather than hot-fixed here. AUTH-P0-01 overlaps R3 and needs a single coordinated change. AUTH-P0-02 spans a large route surface and requires a reviewed permission migration, browser integration, and regression inventory.

### R5 P0 readiness blockers

- No strict Supabase JWKS/JWT verifier, refresh/BFF contract, or canonical actor resolver exists.
- No buyer account or buyer `auth_user_id` binding exists; legacy buyer fields are unsafe to auto-link.
- Base44 `SellerIdentity`/seller bootstrap remains a production seller authority and needs an immutable reconciliation ledger before cutoff.
- Independent per-table uniqueness allows the same Supabase user to bind as multiple actor types; the product must approve and enforce a cross-role policy.

## Important current protections to preserve

- Seller and distributor opaque session tokens are strong random secrets stored only as hashes and checked against current account state.
- Named admin sessions re-check active admin status; sensitive Admin Actions already have a permission/recent-MFA/approval model worth preserving.
- Seller mutation paths generally resolve the server-side session owner and return not-found on cross-owner resources.
- The worker uses a dedicated Postgres login/runtime role rather than a human HTTP token.
- Supabase staging revokes browser roles from the canonical schema/tables/functions and uses distinct least-privileged web/worker runtime roles.
- Mobile secure storage is already backed by Android Keystore AES-GCM and iOS Keychain, though auth tokens are not wired to it.

## Material P1 findings

- App-local admin MFA is not production-grade: `Math.random()` code generation, unpeppered hash, no attempts control, and incomplete delivery.
- Rate limiting is in-process only. Defaults are global 200/min/IP and sensitive OTP/deals 20/min/IP; seller/admin/distributor login receives only the global bucket.
- Cookie-authenticated mutations lack explicit CSRF and Origin/Referer enforcement.
- Participant tracking tokens are accepted in query strings and live 45 days.
- Payment status is publicly queryable, and public chat writes permit caller-selected display identity.
- OTP hashing has a hard-coded default salt; request limiting is not distributed/atomic.
- The seller ownership column lacks a database FK/integrity strategy.

## Recommended implementation sequence

1. Close AUTH-P0-01 with R3 and add mismatch/replay/concurrency tests.
2. Convert every admin mutation to named admin permission checks; make `ADMIN_API_KEY` read-only or disabled and test the route inventory.
3. Approve the buyer schema and one-user/actor policy.
4. Add provider-neutral principal parsing, strict Supabase verification, and server-side actor resolution in dark/shadow mode.
5. Add exact browser BFF cookie/CSRF/Origin behavior and mobile bearer/secure-refresh behavior.
6. Enroll and reconcile admins, sellers, distributors, and buyers through fresh proof; quarantine conflicts.
7. Canary per actor, stop legacy issuance, age/revoke sessions, reject Base44 tokens, then retire compatibility only after the rollback deadline.

## Target authentication shape

- Browser: Fastify BFF owns Supabase exchange/refresh; `__Host-` HttpOnly Secure cookies plus double-submit CSRF and exact Origin/Referer checks. React/current vanilla code never reads tokens.
- Mobile: Supabase PKCE/OTP, refresh token only in native secure storage, access token in memory, bearer to Fastify.
- Fastify: asymmetric JWKS verification with exact issuer/audience/role/time/UUID claims; reject ambiguous channels; load domain role/status/ownership fresh from Postgres.
- Admin: named canonical binding plus server permission, AAL2/recent auth and live session checks for high trust.
- Worker: retain dedicated PostgreSQL identity. No human or service-role JWT.
- Direct browser database: keep `anon` and `authenticated` denied from canonical data/functions.

## Validation performed

All focused tests ran through `scripts/run_test_group.cjs`, which compiles `tsconfig.test.json`, creates a migrated disposable database from the localhost Postgres configured in the main worktree, runs each file in its own cloned database, and drops the disposable databases.

Final result: **15/15 focused files passed**.

| Test command/scope | Result |
|---|---|
| `npm run test:security` filtered to admin auth/hardening, seller auth/session authority, OTP rail/runtime guard, rate limiter, production/security guards, and Supabase staging foundation | 11/11 passed |
| `npm run test:integration` filtered to identity resume, Supabase inventory activation hardening, and mobile readiness | 3/3 ultimately passed |
| `npm run test:concurrency` filtered to OTP single-use concurrency | 1/1 passed |

The first mobile readiness invocation failed before assertions because a fresh worktree did not contain the ignored `.mobile_dist` artifact. `npm run mobile:build` generated the expected bundle, and the isolated mobile test then passed all assertions. This was a test prerequisite, not a product regression. No hosted integration was run or authorized.

## Integration guidance for Claude/mainline

- Review/cherry-pick the final R5 documentation commit independently; it should not overlap R3/R4 code changes.
- Treat AUTH-P0-01 and AUTH-P0-02 as explicit release-blocker decisions, not as proof that fixes landed.
- Do not copy the illustrative buyer SQL directly into production. It is a design shape requiring a separately reviewed repository migration.
- Re-fetch current official Supabase Auth changelog/release notes during implementation; the changelog endpoint returned an empty body in this environment.
- Re-run repository and hosted negative tests after any R3/R4/mainline movement that touches OTP, identity, admin routes, worker identity, staging migrations, or browser/mobile runtime.
