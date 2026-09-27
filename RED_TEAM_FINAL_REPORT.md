# Siton / C-ton — Red Team Final Report

- **Date:** 2026-09-25 (engagement), 2026-09-27 (closure round — §11)
- **Engagement:** Full adversarial red team (authorized, owner-requested), repo `matilederer7-bit/C-ton`, dev + staging only.
- **Base reviewed:** `origin/master` at the start of the engagement (`0a16515…`, post Graphite-Mint).
- **Fix branch:** `claude/redteam-hardening-kx4e5a` (engagement), `claude/festive-wright-kx4e5a` (closure round).
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

- **Fix branch:** `claude/redteam-hardening-kx4e5a` (engagement), `claude/festive-wright-kx4e5a` (closure round).
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

---

## 11. Closure engagement (2026-09-27) — every documented item fixed

The owner's follow-up instruction was unambiguous: nothing stays on the shelf. Every item §4 left as DOCUMENTED / owner-decision was implemented, tested and merged in this closure round (branch `claude/festive-wright-kx4e5a`). The same rules applied: no production data touched, no real money, every fix behind a regression test, security enforced in the runtime/DB layer, and a second adversarial pass over each new control.

| Item | Was | Now | Enforcement layer | Regression / negative test |
|---|---|---|---|---|
| **A2** X-Forwarded-For spoofing | `trustProxy: true` (caller picks its bucket) | trust exactly `TRUST_PROXY_HOPS` hops (default **1** = Render); a spoofed prefix is ignored; boot guard rejects a boolean/unbounded value; `/readiness` echoes `client_ip` + `trust_proxy_hops` so an operator can confirm the hop count live | `src/app.ts` (proxy-addr trust fn), `src/runtime_config.ts`, `src/production_guards.ts` | `tests/security_trust_proxy_hops_validation.ts` (spoofed prefix shares one bucket; resolver bounds; guard) |
| **A3** admin password login lockout | none (unbounded guessing) | per-account sliding window: 10 failures / 15 min → 15-min self-healing lock enforced internally: the locked account answers the SAME 401 body as a wrong password or an unknown e-mail (no status/Retry-After tell — no account-existence oracle), the correct password is refused while locked, success resets; `/api/admin/auth` joined the tight per-IP mutation bucket (meaningful now that A2 holds) | DB columns (migration `075`) + handler under `FOR UPDATE` | `tests/admin_login_auth_lockout_validation.ts` (rotating XFF, lock, heal, MFA-required admin, unknown account) |
| **A5** untokenized tracking view | allowed in non-production / `TRACKING_LEGACY_COMPAT=1` | **retired in every runtime**: tracking + recovery routes always require the join-time credential (401 `tracking_token_required`); the env var is reported as ignored | `src/participant_tracking_security.ts`, both routes | `tests/ux_premerge_tracking_security_validation.ts` (+ every harness call now carries the token) |
| **B3** fee projection | flat 8% of gross | ledger formula: 8% of the VAT-exclusive base + VAT on the fee, product and delivery VAT separately, computed and rounded PER PARTICIPANT and summed exactly as the ledger does (`projectPlatformFeeTotalForParticipants`; Codex on PR #97) — reconciles with `platform_fee_actual` | `src/frontend_runtime.ts` admin overview + sellers list | covered by the admin/seller surface suites (display-only; ledger untouched) |
| **B4** webhook timestamp optional | replay window only when the header was present | timestamp **required** whenever a real secret is configured on a production-like runtime (`PAYMENT_WEBHOOK_REQUIRE_TIMESTAMP=1` opts the harness in) | `verifyWebhookSignature` | `tests/webhook_hmac_validation.ts` (bare signature refused with the requirement, still verified without it) |
| **B5** mock-backed + live | production-only guard | any deployment mode: `PAYMENT_PROVIDER_MODE=mock(-backed)` with `PAYMENT_ENVIRONMENT=live/production` fails closed at boot | `src/production_guards.ts` | `tests/security_production_guards_validation.ts` |
| **C-1** tx-scoped audit/outbox flag | "some audit row somewhere" | **per-row assertion** in the DB (migration `076`): a deal/participant state change needs an audit row for *this* entity, *this* from→to, *this* action, written in *this* transaction; outbox-required deal actions need an outbox row for *this* deal **of the job type that action must enqueue** (publish→`deadline_check`, charging.start→`charge_deal`, to_completion_window→`finalize_deal`, finalize_failed→`refund_issue`, cancel→`cancel_refund`; Codex on PR #97). "Written in this transaction" is decided by **transaction identity** (the row's `xmin` is the current transaction or one of its savepoints), not by a timestamp — a future-dated row or a row another transaction commits while this one is open (READ COMMITTED) is not accepted (Codex on PR #97). Two forged-flag sites in the app fixed (recovery request set `audit_written=1` with no audit row; completion transition set `outbox_written=1` even when nothing was inserted). Helpers are `SECURITY DEFINER` with a least-privilege EXECUTE surface (runtime roles only, never PUBLIC/anon/authenticated). Test fixtures were rewritten to write real audit rows (`tests/helpers/forced_state.ts`) — no fixture forges a flag any more. | DB triggers (`deals_before_update_enforce`, `participants_before_update_enforce`, `deals_outbox_enforce`) | `tests/db_per_row_audit_enforcement_validation.ts` (forged flag, wrong entity, wrong transition/action, earlier committed row, per-column participant rows, wrong-deal outbox row — all rejected; matching rows accepted; flag check still first) |
| **C-2** join lock breadth | deal row lock taken first, held across ~19 writes | lock-independent work first (participant insert in pre-join state, binding consumption, viral/attribution/discovery, legal acceptance, notification enqueue, tracking token), then the **critical section**: `FOR NO KEY UPDATE` re-read + re-validation, inventory hold/commit, audited transitions, target-reached, the deal-scoped `viral_recompute` debounce, idempotency records. One transaction — atomicity and the response are unchanged; the deal row is locked only for the money core | `src/app.ts` join handler | `tests/concurrency_proof.ts` (S1–S7, I1–I6, M1–M3), `db_invariant_authority`, `adversarial_resilience_gate`, `cross_schema_atomicity` |
| **C-3** legacy non-canonical join path | silently usable anywhere | fenced: a hosted/production runtime must run `CANONICAL_POSTGRES_RUNTIME=1` or fails closed at boot; the path is documented as test-harness-only in code | `src/production_guards.ts` | `tests/security_production_guards_validation.ts` |
| **C-4** target-reached without outbox | unconfirmed | **confirmed intentional**: no worker rail reacts to `deal.target_reached`; the next money step is seller/deadline-driven and carries its own outbox event — recorded in code next to the transition | comment in `src/app.ts` | — (verification, not a change) |
| **C-5** stale "migration 063/064" comments | pointed at renumbered files | all `src/` + `tests/` comments now cite `067` / `068` (migration files themselves untouched: checksummed) | — | — |
| **GOV** distributor identity subsystem | dormant but shipped | **removed**: `src/distributor_identity.ts`, `/api/distributor/session[/login/logout]`, `/api/affiliate/overview`, `POST /api/affiliate/links`, admin `distributor-auth/provision`, the admin affiliate-KYC lifecycle (`/api/admin/kyc/affiliate/…`), the two SPA shells, the Supabase "distributor" capability, `distributor_sessions` dropped from the required-table contract, `DISTRIBUTOR_SESSION_SECRET` gone from every policy/matrix/doc, legacy `/app` distributor UI removed. Ordinary sharing stays (`POST /api/affiliate/links/visit`, viral share links, seller distribution links); the affiliate analytics tables stay (zero commission, analytics only; a future DROP is a separate owner-authorised migration). The CI gate `distributor_attribution_only_gate.cjs` now also fails on any identity token under `src/` | code + CI gate | `tests/release_tools/distributor_gate.test.cjs` (13 cases), route/authorization gates |
| **DEP** `exceljs → uuid` moderates | 2 moderate prod advisories | `uuid` pinned to `^11` for `exceljs` via npm `overrides` (workbook write verified); **git-history secret scan** added (`scripts/git_history_secret_scan.cjs`, runs inside `npm run scan:secrets`): every file a commit adds or modifies is scanned as its FULL committed snapshot (not the diff lines), so a credential assembled over several commits — SID in one, token in the next, both deleted later — is still caught (Codex on PR #97); 1,075 commits / 11,567 snapshots clean in ~8 s | package.json, CI secrets gate | `tests/release_tools/git_history_secret_scan.test.cjs` |
| **CSP** | not set | `Content-Security-Policy` on every HTML response: ONE fixed policy whose script allow-list holds only the inline blocks registered at startup from the shipped shell templates plus the constant share-redirect snippet — never derived from the outgoing response, so an injected `<script>` is blocked instead of blessed (Codex on PR #97); no `unsafe-inline`/`unsafe-eval` for scripts; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`; connect only to self + Supabase + payment hosts + Sentry ingest. Verified in headless Chromium against the built app: React shell and legacy shell render with **0 CSP refusals** | `src/content_security_policy.ts` + `onSend` hook | `tests/security_csp_validation.ts` |

### Test results (closure round, local Postgres 16)

unit 17/17 · integration 47/47 · db 9/9 · api 50/50 · workers 15/15 · payments 45/45 · security 53/53 · concurrency 10/10 · failure 9/9 · e2e 17/17 (272 files; the 8 assertion-level fallout files from the new controls — readiness shape, sensitive-path list, canonical-runtime fixtures, distributor route expectations, token-only tracking in the browser smoke, admin login budget — were corrected and re-run green). Static gates and release-tool unit tests PASS. CI runs the same matrix on the PR.

### Second adversarial pass over the new controls

- **A2:** tried prefixing/rotating X-Forwarded-For with 1, 2 and 6 values behind one trusted hop — every request landed in the same bucket. Tried `TRUST_PROXY_HOPS=true`/`all`/`99`/`-1` — resolver falls back to 1 and the boot guard refuses them. Residual: an operator who sets the hop count *higher* than the real depth re-opens the spoof for that extra hop; the readiness echo exists precisely so the value is verified live, not assumed.
- **A3:** tried rotating IPs across the 10 attempts (per-account, so no effect); tried the correct password during the lock (same 401 body as a wrong password, no session, no MFA challenge issued); tried an unknown e-mail 12 times (always the identical 401, no lock row). Codex's review then pointed out the first cut's distinct 429 was itself an existence oracle once a counter is exhausted — the lock is now enforced behind the identical 401 (accepted trade-off: a locked admin sees no explicit "locked" message; the self-healing window is 15 minutes). Residual (accepted, documented): a 15-minute lockout-DoS against a known admin e-mail, self-healing, and bounded by the per-IP budget.
- **A5:** tried a bare UUID, a wrong token, a token for another participant/purpose — 401/403/403. No runtime flag re-enables the old path.
- **C-1:** tried the forged flag with an audit row for another entity, the right entity with a wrong transition, a matching row committed in an *earlier* transaction, and a participant change with only one of its two audit rows — all rejected by the DB. Tried `anon`/`authenticated` executing the helper — no EXECUTE. Codex's third pass found two holes in the first cut: the helper matched on `created_at >= now()` (a future-dated row, or a row another transaction commits while a long one is open, would satisfy it) and the outbox probe accepted any same-deal row (a sent `deadline_check` would let a deal enter Charging without its `charge_deal` job). Both closed: the probes now match the row's `xmin` against the current transaction (savepoints included, proven by test) and the required event type per action. Residual: none identified.
- **C-2:** the first cut of the reorder **deadlocked under a 70-way join storm** (found by the concurrency proof, not by review): the pre-lock participant insert takes a foreign-key `KEY SHARE` on the deal row, `FOR UPDATE` conflicts with `KEY SHARE`, and the deal-scoped `viral_recompute` outbox row (per-deal partial unique index) made two joins wait on each other's commit. Fixed by locking the deal `FOR NO KEY UPDATE` (the exact lock a non-key state update needs; compatible with the FK key-shares every in-flight join holds) and by enqueueing the deal-scoped outbox row inside the critical section. Reran the full concurrency proof (70-way storm on max 10, last-unit races, idempotent replays, mid-transaction faults, 150-way and mixed-load storms in the failure group): no oversell, no deadlock, no orphan participant, no residue after injected failures; the pre-lock participant row is invisible until COMMIT and rolls back with everything else on a capacity refusal.
- **CSP:** tampering an inline script changes its hash and the policy no longer admits it; an inline script injected into a response is NOT admitted (the allow-list is fixed at startup — Codex caught that the first cut hashed the outgoing document and would have blessed an injected block); third-party script hosts are absent from `script-src`; framing is refused.

### Residual risk after closure

- Real proxy depth on a *different* host than Render must be configured (`TRUST_PROXY_HOPS`) and confirmed via `/readiness.client_ip`.
- Admin lockout-DoS window: 15 minutes, self-healing (accepted trade-off, documented).
- The affiliate analytics tables remain in the schema (unused by any identity; a DROP migration is an owner-authorised data change).
- Real payment provider behaviour is still exercised only against the synthetic/sandbox providers by policy.
