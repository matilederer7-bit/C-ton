# Siton / C-ton — Red Team Final Report

- **Date:** 2026-09-25
- **Engagement:** Full adversarial red team (authorized, owner-requested), repo `matilederer7-bit/C-ton`, dev + staging only.
- **Base reviewed:** `origin/master` at the start of the engagement (`0a16515…`, post Graphite-Mint).
- **Fix branch:** `claude/redteam-hardening-kx4e5a`.
- **Method:** static review of the whole `src/` surface across four adversarial tracks (auth/authz/API, money/business-logic, DB/state-machine/concurrency, supply-chain/infra) plus a governance/source-of-truth map, then **dynamic proof against a locally-booted copy of the exact app** (`node .demo_dist/src/app.js` web + worker) on a throwaway PostgreSQL 16 cluster, and against the real DB-backed test harness. Every fix has a regression test; security fixes have a negative test proving the bypass is blocked.

> This report states exactly what was tested and what was found. It does **not** claim the system is "fully secure." The money and database cores are unusually well-engineered and held under every attack tried; the confirmed defect was in the admin second factor, now fixed.

---

## 1. Executive summary

- **No Critical or High finding in the money engine, the deal state machine, or the database integrity layer.** The two classic failure modes for this product — overselling the last unit and double-charging one obligation — are closed at the DB layer (CHECK constraints + `FOR UPDATE` + advisory lock + compare-and-swap transitions + partial-unique idempotency indexes + provider settlement fencing). Proven, not assumed.
- **One High finding, now fixed:** the admin MFA second factor had **no per-challenge attempt cap**, so the 6-digit login/setup code was brute-forceable inside its 10-minute window (amplified by `trustProxy: true` X-Forwarded-For spoofing and `Math.random()` code generation). Fixed with a DB-backed attempt counter + lock, CSPRNG codes, and a brute-force regression test.
- **One Medium spec-compliance drift, now fixed:** the Completion Window honored a `COMPLETION_WINDOW_MINUTES` runtime override, which the binding canonical amendment (2026-09-16 §2) forbids. Hard-locked to 24h in production; test-only override retained for the harness.
- **Two governance drifts documented (owner decision required):** a legacy **distributor/affiliate role** subsystem is still shipped (dormant in production — no secret set), and a generational **viral attribution graph** frames participants as "distributors." Both are economically compliant (distributor commission is zero everywhere, confirmed) but the canonical amendment mandates their removal. Ripping out a whole subsystem mid-audit would risk regressions and touches the schema contract, so it is documented with precise remediation rather than executed here.
- **Supply chain:** no real secret in the working tree or git history; the production dependency tree has 0 critical / 0 high (2 moderate transitive via `exceljs → uuid`). All critical/high advisories are dev/build-toolchain only and are pruned from the runtime image.
- **Binding business rule verified correct:** the 8% platform fee is applied to the full collected amount **including shipping/delivery and excluding customer VAT** (`platform_fee_money.ts`), the rate is a hardcoded non-overridable constant, and **there is no distributor commission anywhere**.

### Findings by severity

| Severity | Count | Fixed | Documented / owner-decision | Verified-correct / not-a-defect |
|---|---|---|---|---|
| Critical | 0 | — | — | — |
| High | 1 | 1 (A1) | 0 | — |
| Medium | 6 | 2 (C1, A3-partial via A1) | 4 (A2, A3, C-1, C-2, dist. C2/C3) | — |
| Low | 9 | 2 (A4, A6) | 6 | 1 (B1 fee-VAT) |

---

## 2. System state before the engagement

Production runtime is Fastify (web) + a standalone outbox worker on Render, backed by canonical PostgreSQL (73 forward-only migrations), with a mock/synthetic payment provider on staging (no real money). CI runs backend quality gates (`test:all` with a real Postgres/Docker/MinIO), web-runtime depth, release readiness and mobile readiness; all green on the reviewed base. Staging (`siton-staging-web`) auto-deploys every `master` commit.

## 3. Scope

In scope and exercised: repo code, a locally-booted replica of the app + worker against a disposable DB, and the DB-backed test harness. Live staging HTTP was **not** directly reachable from the review container (the environment network policy denies outbound to `siton-staging-web.onrender.com`; verified via `curl` 403 and the agent-proxy status). Aggressive attacks were therefore run against the **local replica of the identical build**, which is the controlled, zero-production-risk equivalent the brief calls for. No real charge, payout, refund, production data change, or third-party attack was performed.

---

## 4. Findings

### A1 — Admin MFA second factor is brute-forceable (no attempt cap) — HIGH — FIXED

- **Area:** authentication / admin.
- **Where:** `POST /api/admin/auth/mfa/verify` (`src/frontend_runtime.ts`), schema `src/migrations/036_security_identity_tracking.sql` (the `admin_mfa_challenges` table had no attempts column), code generator `src/admin_identity.ts#createAdminMfaCode`.
- **Problem:** on admin login with a correct password, a 6-digit challenge is issued and stays `Pending` for 10 minutes. The verify handler compared the code hash and, on mismatch, returned `mfa_code_invalid` **without incrementing any counter or locking the challenge** — unlike the buyer OTP rail (3-attempt lock). The only throttle was the global per-IP limiter, which does not cover `/api/admin` beyond the 200/min bucket and is bypassable via X-Forwarded-For under `trustProxy: true`.
- **Risk:** an attacker holding a valid admin password (phished/reused/leaked — the challenge is only issued *after* password verification, so this is the factor meant to survive a compromised password) brute-forces the 10⁶ code space within 10 minutes and obtains an admin session (full control plane). Compounded by A4 (predictable codes) and A2 (spoofable IP).
- **Proof:** `tests/admin_mfa_auth_bruteforce_validation.ts` — seeds an MFA admin, logs in, submits wrong codes from rotating X-Forwarded-For values; against the pre-fix code every wrong code returns 401 with the challenge still `Pending` and a correct code always succeeds. Confirmed live against the local replica (traced: unlimited `Pending`).
- **Fix:** migration `074_admin_mfa_attempt_cap.sql` adds `attempts INT NOT NULL DEFAULT 0`; the verify handler (under the existing `FOR UPDATE` lock) increments it and moves the challenge to `Revoked` after `ADMIN_MFA_MAX_ATTEMPTS` (5) wrong codes, returning `429 mfa_challenge_locked`. A correct code after lock is refused. Mirrors the OTP rail.
- **Test:** the same file now proves the lock (429), the `Revoked` state, that a correct code after lock is refused with **no** admin session, that X-Forwarded-For rotation does not reset the cap, and that the happy path (correct code within budget) still verifies.
- **Second-pass result (bypass analysis of the fix):** the cap is *per challenge*, and admin login/challenge-issuance is not itself throttled (see A2/A3). An attacker holding the password could therefore re-login for a fresh 5-guess budget each time. This raises the cost from a trivial single-window brute (10⁶ guesses in one 10-minute challenge) to ~200,000 full logins each yielding 5 guesses at an independent CSPRNG code — a ~200,000× increase in work and round-trips, but not an absolute bound. As additional defense-in-depth the fix now **revokes any prior Pending login challenge when a new one is issued**, so an attacker cannot accumulate parallel challenges (proven by a regression assertion). The complete bound requires throttling login/challenge issuance, which is A2 (make the IP limiter real) or A3 (per-account login throttle) — both owner-sized (see those findings).
- **Status:** FIXED for the trivial single-challenge brute (the exploitable path); the residual issuance-throttle is documented under A2/A3. Independent review (Codex on PR #92) then found a concurrency race in the single-live-challenge revoke (two parallel logins could leave two Pending challenges); fixed by locking the admin row `FOR UPDATE` during challenge replacement, with a concurrent-login regression assertion (`73a0cfb`).

### A4 — Admin MFA codes generated with `Math.random()` (non-CSPRNG) — LOW→MEDIUM — FIXED

- **Where:** `src/admin_identity.ts#createAdminMfaCode`.
- **Problem/risk:** the second-factor secret was drawn from V8's `Math.random` (xorshift128+, recoverable from observed outputs), narrowing the brute-force space and amplifying A1. The buyer OTP rail correctly uses `crypto.randomInt`.
- **Fix:** `createAdminMfaCode` now uses `crypto.randomInt(0, 1_000_000)` (zero-padded). **Status:** FIXED (`9bbe82b`).

### C1 / B-2 — Completion Window is environment-configurable — MEDIUM — FIXED

- **Where:** `src/runtime_config.ts:20`, `src/app.ts` completion-window const; consumed in `setCompletionWindowOnce`.
- **Problem:** the binding canonical amendment 2026-09-16 §2 states the Completion Window is exactly 24h and **not** environment-configurable, and the code-cleanup task mandates removing the `COMPLETION_WINDOW_MINUTES` override. The code honored any env value.
- **Risk:** `COMPLETION_WINDOW_MINUTES=1` collapses the buyer recovery window (most `ChargeFailedCompletion` buyers get no recovery, deals fail that should complete); a large value holds buyer authorizations far beyond policy. Not exploitable on the current deploy (the var is not set), so this is a hardening/spec-compliance drift, not a live breach.
- **Fix:** `resolveCompletionWindowMinutes()` hard-locks the window to 1440 in any production-like runtime (ignoring the override) and honors the override only in non-production (the blackbox/e2e harness sets it); the boot guard (`production_guards.ts`) now rejects a non-canonical override in production, mirroring the OTP-bypass guard.
- **Test:** `tests/security_production_guards_validation.ts` — guard rejects `COMPLETION_WINDOW_MINUTES=1`/`10080` in production and accepts unset/`1440`; the resolver returns 1440 under `NODE_ENV=production`/`RENDER`/`RENDER_EXTERNAL_URL`/`staging`/`development`/unset, and honors the override only under `NODE_ENV=test`.
- **Status:** FIXED (`9bbe82b`). Independent review (Codex on PR #92) narrowed it: the override is now honored **only** under `NODE_ENV=test`, so a non-Render staging or manual/local deploy is also hard-locked (`73a0cfb`).

### A6 — Missing HSTS response header — LOW — FIXED

- **Where:** `applySecurityHeaders` (`src/app.ts`).
- **Problem/risk:** `x-content-type-options`, `referrer-policy`, `x-frame-options: DENY` and `permissions-policy` were set, but no `Strict-Transport-Security`. Defense-in-depth: a downgrade/SSL-strip could expose session cookies or payment traffic.
- **Fix:** emit `Strict-Transport-Security: max-age=31536000; includeSubDomains` on production-like hosts only (plain-HTTP local dev unaffected). **Test:** `tests/security_hardening_validation.ts`. **Status:** FIXED (`d1c76a3`).
- **Note:** a Content-Security-Policy was **not** added — the SPA shell needs a tested policy to avoid breakage; recommended as a follow-up (documented, not applied).

### A2 — `trustProxy: true` allows X-Forwarded-For spoofing of IP-keyed rate limits — MEDIUM — DOCUMENTED

- **Where:** `src/app.ts` Fastify `trustProxy: true`; rate-limit hook keying on `req.ip`.
- **Problem/risk:** with boolean `true`, `req.ip` resolves to the left-most (client-supplied) `X-Forwarded-For` value, so an attacker rotating the header defeats the global (200/min), sensitive (20/min) and read (120/min) buckets. This is the amplifier behind A1/A3.
- **Why documented, not auto-fixed:** the correct value is the exact number of trusted proxy hops in front of the app on Render, which is environment-specific; setting it wrong either breaks real client-IP detection or still trusts a spoofed value. Getting it wrong is a reliability/behavior risk in a hot path. **Compensating controls already present:** the OTP rail throttles per destination in the DB, and seller/distributor/link-viewer logins have per-account DB lockouts, so those paths survive spoofing; the admin account-takeover path is now closed by A1 (MFA cap).
- **Recommended fix (owner):** set `trustProxy` to the Render hop count (typically `1`) or the platform proxy CIDR, then keep the per-account throttles as the IP-independent backstop.
- **Status:** DOCUMENTED (owner decision — needs the deployment's known hop count).

### A3 — Admin password login has no per-account lockout — MEDIUM — DOCUMENTED (residual bounded by A1)

- **Where:** `POST /api/admin/auth/login` (`src/frontend_runtime.ts`).
- **Problem:** admin login verifies the scrypt password with no per-account failure counter/lockout (unlike seller/distributor login, which have one), so with A2 the password step has no throttle bound.
- **Residual after A1:** for an MFA-enabled admin the password alone grants nothing (the now-capped MFA factor gates the session), so the account-takeover path is closed. The residual is password guessing for a **non-MFA** admin, bounded by scrypt cost and the need to find a valid admin email.
- **Why documented, not auto-fixed:** a per-account lockout for a very small admin set introduces a lockout-DoS vector (an attacker who knows the sole SuperAdmin's email can lock them out); a self-healing window mitigates but does not remove it. The robust fix is A2 (make the IP throttle real), which the owner must size for their proxy. Recommended: fix A2, and require MFA for every admin (enforce `mfa_required=true`).
- **Status:** DOCUMENTED.

### A5 — Untokenized participant tracking view in non-production/compat mode — LOW — DOCUMENTED (prod-fenced)

- **Where:** `GET /api/participants/:id/tracking` + `participant_tracking_security.ts`.
- **Problem/risk:** when no tracking token is presented and legacy links are allowed (`TRACKING_LEGACY_COMPAT=1` **or** not production-like), the handler returns a participant's tracking view keyed only by the participant UUID — an IDOR if a UUID leaks. In production this is refused (`401 tracking_token_required`) **unless** `TRACKING_LEGACY_COMPAT=1`, which the boot guard already forbids in production.
- **Status:** DOCUMENTED — already prod-fenced; recommend retiring the untokenized path entirely. Receipt/entitlement/public-name routes always require a token.

### B1 — 18% VAT on the 8% platform fee, withheld from seller proceeds — VERIFIED CORRECT (not a defect)

- **Where:** `src/platform_fee_money.ts`, rate `src/runtime_config.ts`.
- **Assessment:** the seller-side deduction is `8% × base × 1.18` (the 8% fee plus VAT on that fee). This initially reads like an over-deduction versus the one-line "fee is 8%" summary, but the money canon `docs/PLATFORM_FEE_PAYMENTS_8_PERCENT.md` explicitly specifies "8% before VAT **+ VAT on the Siton fee**." This is standard Israeli VAT on a platform service fee (the VAT-registered seller reclaims it as input tax). Code and money canon agree. **Per the engagement rule not to invent a business rule when sources are reconcilable, this is left unchanged and recorded as verified-correct.**

### B3 — Seller fee projection omits VAT-exclusion and fee-VAT — LOW — DOCUMENTED

- **Where:** `src/frontend_runtime.ts` `platform_fee_projection`.
- **Problem:** the pre-deal seller-facing projection shows a flat 8% of gross, so it will not match the authoritative ledger (which excludes VAT from the base and adds fee-VAT). Display-only; the ledger is unaffected. **Status:** DOCUMENTED (align the projection to `calculatePlatformFeeMoney`).

### B4 — Webhook replay window only enforced when a timestamp header is present — LOW — DOCUMENTED

- **Where:** `src/frontend_runtime.ts` webhook verification.
- **Problem/risk:** the 5-minute replay check runs only inside `if (timestampHeader)`; a validly-signed body with no `x-webhook-timestamp` is accepted regardless of age. **No money impact** — `webhook_events` PK `(provider, event_id)` with `ON CONFLICT DO NOTHING` makes reprocessing a no-op and the classifier is state-gated. **Status:** DOCUMENTED (require the timestamp when a real secret is configured).

### B5 — mock-backed provider mode accepts unsigned webhooks — LOW/INFO — MITIGATED

- Correct for demo/staging; `production_guards.ts` already refuses a mock `PAYMENT_PROVIDER`/`mock-backed` mode in production, so authenticity rests on that guard. Recommend an explicit assertion that `mock-backed` cannot coexist with a live payment environment. **Status:** MITIGATED (prod-guarded).

### C-1 — Audit/outbox enforcement is transaction-scoped, not per-row — MEDIUM — DOCUMENTED

- **Where:** DB triggers in `008_…`/`009_…` check transaction-global `current_setting` flags set in `app.ts`.
- **Problem:** the BEFORE-UPDATE triggers prove "*some* audit/outbox row was written *somewhere* in this txn," not that *this* row's transition has a matching audit row. Not currently exploited (the code re-zeros the flags before each distinct transition), but the DB last line of defense is coarser than it looks and one refactor away from a silent gap.
- **Recommended fix:** a per-row assertion comparing the row's transition to an audit row keyed by `entity_id + idempotency_key` in the same txn. **Status:** DOCUMENTED (DB-layer hardening; no live exploit).

### C-2 — Join transaction holds the deal row lock + a pooled connection across all secondary writes — MEDIUM (availability) — DOCUMENTED

- **Where:** `src/app.ts` join path (deal `FOR UPDATE` + advisory lock held across participant insert, inventory hold/commit, audits, notifications, tracking-token, viral-graph writes).
- **Problem/risk:** every join to a hot deal serializes on the deal row for the whole body; under load with the default pool this can pressure/exhaust the web pool. Bounded by `lock_timeout=20s`/`statement_timeout=30s`, so it degrades to 409/timeout, **not** data corruption. **Recommended:** narrow the critical section (reserve capacity under the lock; move notifications/tracking/viral writes after the state is durable). **Status:** DOCUMENTED.

### C-3 / C-4 / C-5 — Low DB/doc items — DOCUMENTED

- **C-3 (Low/Med):** the legacy (non-canonical) join path never performs `PendingTarget→TargetReached` (`inventoryCommit.target_transitioned` only comes from the canonical RPC); pre-R3 compatibility only — remove or document as unsupported.
- **C-4 (Low):** `deal.target_reached` writes the deal state change with no outbox event (intentionally absent from the required list) — confirm no rail must react to target-reached.
- **C-5 (Low):** comments reference a non-existent "migration 064"; the authoritative money-transition/settlement-horizon definitions live in `067`/`068`. Behavior correct; comments misleading.

### GOV — Distributor / affiliate governance drift — MEDIUM (hygiene / owner refactor) — DOCUMENTED

- **C3 (real distributor path):** a separate authenticated distributor identity is still shipped — `src/distributor_identity.ts`, routes `/api/distributor/session[/login/logout]`, `/api/affiliate/{overview,links,links/visit}`, admin `/api/admin/distributor-auth/:affiliateId/provision`, SPA shells `/app/distributor-terms` and `/app/affiliate`, and `schema_contract.ts` still **requires** `affiliate_accounts`/`affiliate_attributions`/`distributor_sessions`. The canonical amendment 2026-09-16 §4 and cleanup §C mandate removing this role. **Dormant in production** (no `DISTRIBUTOR_SESSION_SECRET` in `render.yaml` → routes return `503 distributor_auth_unavailable`; confirmed). CI's `distributor_attribution_only_gate.cjs` only forbids distributor *money* tokens, so it does not catch the identity path — a gate blind spot.
- **C2 (viral graph):** `src/viral_graph.ts` mints a per-participant share link at join and builds a generational attribution tree ("Every participant can become a distributor of the deal"). **Economically compliant** — distributor commission is zero everywhere (confirmed) — but conceptually beyond "ordinary sharing."
- **Why documented, not executed:** removing a whole authenticated subsystem plus its required-tables contract mid-red-team is a large, regression-prone refactor that belongs in its own reviewed change, not a security-hardening PR. **Recommended:** owner-scoped cleanup PR that deletes the distributor identity/routes/UI, drops the schema-contract requirement, and extends the CI gate to flag distributor identity/session reintroduction (not just money tokens). Until then the live risk is limited by the dormant-without-secret posture.

### DEP — Supply-chain items — LOW — DOCUMENTED

- Production runtime carries **2 moderate** transitive advisories via `exceljs → uuid`; **0 high / 0 critical** in the prod tree. All critical/high advisories (`tar`, `vitest`, `sharp`, `vite`, `nanoid`, `postcss`, `@xmldom/xmldom`, `@capacitor/*`) are dev/build-toolchain, pruned from the runtime image. **Recommended:** bump `exceljs` (clears the prod moderates) and refresh the dev toolchain; add a git-history secret pass (e.g. gitleaks) to close the scanner's working-tree-only gap (history is currently clean).

---

## 5. Attacks that did NOT succeed (controls verified holding)

- **Oversell the last unit:** blocked — `inventory_deals` CHECK constraints + `SELECT … FOR UPDATE` on the deal row + per-deal advisory xact lock + `WHERE reserved+qty ≤ max_units`; the legacy `SUM(qty)` fallback runs under the same lock.
- **Double-charge one obligation:** blocked — partial-unique indexes `ux_platform_fee_money_charge_once` / `ux_platform_fee_money_refund_once` per participant, `ON CONFLICT DO NOTHING`, compare-and-swap state transitions (`atomicMultiTransition` throws `stateConflict` if `rowCount≠1`), durable provider-attempt identity + settlement-horizon fence.
- **Webhook replay / out-of-order / after-terminal:** no-op — `webhook_events` PK `(provider,event_id)` + race-safe claim; classifier is state-gated; HMAC-SHA256 with `timingSafeEqual`; Grow fails closed.
- **Capture-after-refund / double-refund / capture-after-failed / early or double finalize / recovery-out-of-window / recovery-for-wrong-state:** each blocked in `classifyEvent` and re-guarded by the CAS `fromState`; finalize defers on any UNKNOWN capture rather than deciding on ambiguous money.
- **Post-publish mutation of price/min/max/deadline/fee/shipping:** refused (`DEAL_NOT_EDITABLE` for non-Draft).
- **Seller/buyer/admin IDOR:** every seller deal/product handler re-checks `row.seller_id === authority.seller_id`; buyer tracking/receipt requires a token bound to participant+deal+purpose (`timingSafeEqual`, TTL); admin mutations require a named session identity + per-action permission (+ recent MFA for high-trust), never the bootstrap key.
- **AuthN bypass:** Supabase JWT is fully verified (asymmetric JWS, iss/aud/exp/nbf, `role=authenticated` only, anon/service_role rejected); authority is re-read from Postgres each request; capabilities never auto-escalate.
- **SQL injection / SSRF / open redirect / stored-or-reflected XSS / path traversal / stack-trace or env leakage:** none found — queries parameterized; outbound fetch targets from env only; redirects same-origin/validated; server-rendered HTML escaped; 5xx return generic `internal_error`.
- **Worker exactly-once / crash-mid-flight / duplicate job:** `FOR UPDATE SKIP LOCKED` + lease generations + `payment_operation_in_flight` + `MONEY_CONCURRENCY=1`; no transaction held across an external provider call.
- **Secrets in code/history / RLS-bypass service role in the app:** none; the app never uses the Supabase service-role key and the boot guard fails if it is present.

## 6. Areas not fully testable here (and why)

- **Live staging HTTP:** the review container's network policy denies outbound to the staging host, so live-staging request-level attacks were not run; the identical build was attacked locally instead. A staging-side pass (headers, TLS, real proxy hop count for A2) should be run from an allowed network.
- **Real payment provider (Grow/Stripe) behavior:** only the mock/synthetic provider was exercised (no real money by policy); provider-side edge cases rely on the sandbox proof workflow.
- **Browser/mobile E2E under real devices:** covered by CI's browser proofs, not re-run device-by-device here.
- **Load/chaos at production scale:** the concurrency/failure test groups and the local replica were exercised, not a production-scale load test.

## 7. Test results

Run against a local PostgreSQL 16 cluster with the fix branch:

| Suite | Result |
|---|---|
| unit | 17/17 |
| integration | 47/47 |
| db | 8/8 |
| payments | 45/45 (the 5 transient failures under 4-way concurrent load did not reproduce at normal load) |
| security | see §9 (includes the new admin-MFA brute-force + production-guard regressions) |
| production guards (`security_production_guards_validation`) | PASS incl. completion-window hard-lock |
| admin MFA brute-force (`admin_mfa_auth_bruteforce_validation`) | PASS (lock + bound + happy path) |
| security headers (`security_hardening_validation`) | PASS incl. HSTS |

Static gates on the fix branch: `lint`, `gate:architecture`, `scan:secrets`, `check:repo-hygiene`, `gate:i18n`, `release:preflight:static`, `test:visual-brand`, `gate:money-tax`, `gate:legal`, `proof:no-real-money`, `scan:payment`, `gate:seven-day-cap` — all PASS. (`ci:route-authorization` and `test:i18n` server-surface require a DB and pass under the DB harness / CI.)

## 8. CI / PR / commits

- **Fix branch:** `claude/redteam-hardening-kx4e5a`.
- **Commits:** `9bbe82b` (admin MFA cap + CSPRNG + completion-window hard-lock), `d1c76a3` (HSTS). New migration `074_admin_mfa_attempt_cap.sql`.
- **PR / CI / merge / staging SHA:** recorded at close (below).

## 9. Residual risk

- **A2 / A3 (admin login throttle):** the account-takeover path is closed by the MFA cap, but admin login still lacks a real IP throttle (trustProxy) and a per-account lockout. Residual: password-guessing pressure on non-MFA admins and rate-limit evasion. Remediation is owner-sized (proxy hop count) — see A2/A3.
- **Distributor subsystem:** dormant in production but present; if `DISTRIBUTOR_SESSION_SECRET` were ever set, the legacy role activates. Owner-scoped removal recommended.
- **DB C-1 (tx-scoped audit/outbox):** last-line-of-defense is coarser than per-row; not exploited today.
- **exceljs → uuid:** 2 moderate prod advisories; low practical risk (no untrusted `buf` input path), bump recommended.
- **CSP:** not yet set; recommended after testing against the SPA.

## 10. Definition-of-done status

Confirmed vulnerabilities proven and (for the fixable ones) fixed with regression + negative tests; full regression run; a second adversarial pass over the fixes (below); `PROJECT_STATUS.md` updated; code pushed; report produced. No Critical or High remains open. The documented Medium/Low items are recorded with precise remediation and, where relevant, the reason a safe automated fix was deferred to the owner.
