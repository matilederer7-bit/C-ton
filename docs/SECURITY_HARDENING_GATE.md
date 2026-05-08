# Security Hardening Gate

Status: `SECURITY_HARDENING_GATE_WARNING`.

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

- `SEC-P1-ADMIN-IDENTITY`: admin auth is fail-closed in production-like mode, but still shared-key based. This is acceptable for demo operations, not full production identity/MFA/RBAC.
- `SEC-P1-PARTICIPANT-BEARER-LINK`: participant tracking is bearer-link based by high-entropy participant id. Acceptable for current demo link flow, but should become signed-token or buyer-session bound before live pilot if the tracking surface expands.

### P2

- `SEC-P2-HTTP-SECURITY-HEADERS`: fixed.
- `SEC-P2-TEST-DB-FALLBACK-CREDENTIAL`: fixed.
- `SEC-P2-SELLER-COOKIE-SECURE`: fixed.
- `SEC-P2-RATE-LIMIT-SINGLE-INSTANCE`: documented. In-memory rate limiting remains single-instance only.

### P3

None added in this pass.

## Policies

### Security Headers

Baseline browser hardening headers are applied from the app-level request hook. CSP was not added in this pass because a strict CSP can break future provider iframe/script integration without a provider-specific contract. Add CSP after browser smoke coverage and provider asset requirements are explicit.

### Auth And Authorization

Admin endpoints require `x-admin-key` when configured and fail closed in production-like mode when no admin key exists. Admin identity, MFA, and scoped RBAC remain P1 before live pilot.

Seller-sensitive routes must check seller ownership. Participant tracking remains link-contract based and must not expose raw card data or secrets.

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

Demo is not blocked by this security pass.

Live pilot remains blocked/warning until:

- admin identity/MFA/RBAC exists,
- participant tracking access is strengthened if sensitive data expands,
- distributed or platform rate limiting is closed for multi-instance use,
- existing live-money blockers remain closed in `docs/PROVIDER_LIVE_MONEY_READINESS.md`.
