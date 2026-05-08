# Security Hardening Gate

Status: `SECURITY_IDENTITY_TRACKING_GATE_PASS` for demo, `live_security_verdict=blocked`.

## Purpose

This gate is a defensive audit and hardening pass for Siton before a stronger external demo. It does not run external attacks, brute force, DDoS, live provider calls, live money actions, production DB changes, or destructive operations.

## Scope Checked

- Secrets and credential exposure across source, tests, docs, scripts and config.
- Admin auth and Admin Control Plane authorization.
- Seller/buyer authorization and IDOR-sensitive routes.
- Input validation, SQL safety, XSS, CSV/Excel formula injection, path traversal and upload limits.
- Payment, invoice, payout and webhook security boundaries.
- HTTP security headers, CORS/CSRF posture and cookie flags.
- Rate limiting and abuse protection.
- Debug/demo exposure and error disclosure.
- Dependency and package-script supply chain posture.
- Business invariants: no marketplace/search, no distributor payout, 8% Siton fee, no raw card storage, outbox/idempotency/money boundaries.

## What Was Fixed

- Added baseline response security headers globally:
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options: DENY`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()`
- Preserved dynamic `Cache-Control: no-store` and immutable deal-image policy.
- Set seller session cookies to `Secure` in production-like environments while keeping `HttpOnly` and `SameSite=Lax`.
- Neutralized Excel formula injection in the delivery handoff export.
- Removed a hardcoded legacy local test DB fallback credential from tests and replaced it with the standard demo-local fallback.
- Added Mission Control `security_hardening_gate`.
- Added `npm run test:security-hardening`.

## Open Findings

### P0

None found.

### P1

- `SEC-P1-ADMIN-IDENTITY`: fixed for demo foundation. Admin users, hashed sessions, RBAC and sensitive-action identity requirements exist. Shared key remains bootstrap/read-only fallback.
- `SEC-P1-MFA-RBAC`: fixed for demo foundation. Sensitive actions require session identity, permission and recent MFA. Live pilot still needs enrollment/runbooks.
- `SEC-P1-PARTICIPANT-BEARER-LINK`: fixed for demo foundation. Tracking tokens are hash-only with expiry/revocation foundation; legacy links are demo compatibility only.

### P2

- `SEC-P2-HTTP-SECURITY-HEADERS`: fixed.
- `SEC-P2-TEST-DB-FALLBACK-CREDENTIAL`: fixed.
- `SEC-P2-SELLER-COOKIE-SECURE`: fixed.
- `SEC-P2-RATE-LIMIT-SINGLE-INSTANCE`: foundation closed with `RateLimiterStore` abstraction and explicit `single_instance_only` default. Multi-instance still needs shared/platform enforcement.

### P3

None added in this pass.

## Policies

### Security Headers

Baseline browser hardening headers are applied from the app-level request hook. CSP was not added in this pass because a strict CSP can break future provider iframe/script integration without a provider-specific contract. Add CSP after browser smoke coverage and provider asset requirements are explicit.

### Auth And Authorization

Admin read endpoints may still accept `x-admin-key` as bootstrap/read-only fallback. Sensitive admin actions require named session identity, RBAC permission and recent MFA.

Seller-sensitive routes must check seller ownership. Participant tracking now supports tokenized hash-only access; production-like environments block bare participant-id tracking.

### Webhooks

Real payment webhook handling requires configured safe webhook secrets, signature verification, replay-window checks, and dedupe by provider/event id. Demo fallback must not be treated as live provider validation.

### Uploads

Deal image upload security relies on MIME allowlist, size limit, and path traversal protection. SVG/HTML/JS executable uploads are not allowed as images.

### Secrets

Readiness and Mission Control responses report presence or masked posture only. Secret values must remain in ignored env/config surfaces and must not be committed.

### CORS/CSRF

Header-key admin auth is not browser-cookie CSRF sensitive in the same way as cookie auth, but seller sessions are cookie based and keep `HttpOnly`, `SameSite=Lax`, and production-like `Secure`.

### Rate Limit

Current in-process rate limiting is useful for a single-instance demo. Multi-instance deployment requires shared rate limiting, platform WAF/rate limits, or an explicit accepted limitation.

## Dependency Audit

- `npm audit --omit=dev`: 0 vulnerabilities.
- `npm audit`: 0 vulnerabilities.

## Demo And Live Pilot Gates

Demo is not blocked by this security pass and can be treated as `SECURITY_IDENTITY_TRACKING_GATE_PASS`.

Live pilot remains blocked/warning until:

- named admins are provisioned and enrolled in MFA,
- shared-key fallback is removed or tightly constrained operationally,
- participant tracking is token-only in the live environment,
- distributed or platform rate limiting is closed for multi-instance use,
- existing live-money blockers remain closed in `docs/PROVIDER_LIVE_MONEY_READINESS.md`.
