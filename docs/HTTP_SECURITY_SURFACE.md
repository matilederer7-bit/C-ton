# HTTP security surface (release smoke)

Command: `npm run smoke:http-security` (`scripts/http_security_smoke.cjs`). Boots the real web runtime locally (isolated database, free port, mock provider, an admin key set so admin routes are guarded) and checks the response contract a release depends on. No UX component is touched; gaps are recorded, not patched. 2026-09-14: 11/11 checks PASS, 1 documented gap.

## Contract verified

| Check | Expectation | Source of the behaviour |
|---|---|---|
| health + readiness responses | JSON; `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`, `permissions-policy` (camera/geolocation self only); `cache-control: no-store` + `pragma` + `expires` on `/health` and `/health/integrations` | `applySecurityHeaders` + `isDynamicNoStoreRoute` onRequest hook in `src/app.ts` |
| public API 404 | JSON `{"ok":false,"error":"deal not found"}`, no-store, security headers, no stack frames or file paths | error handler in `src/app.ts` (`exposeDetails` gating) |
| private tracking data | refusal (404 here) with no-store; presented token never echoed | `/api/participants/:id/tracking` in `src/frontend_runtime.ts` |
| admin surfaces anonymous | 401/403 with no-store on mission-control, system-ops-status, outbox-status | `requireAdmin*` guards; behavioural authority in `tests/protected_route_authorization_gate.ts` |
| malformed JSON body | 400 JSON, no stack | Fastify body parser + error handler |
| unknown route | 404, security headers, no stack | Fastify not-found handler |
| request id | sane `x-request-id` echoed; a 4000-byte hostile value with markup replaced by a minted 40-char id | `safeHeaderId` / `genReqId` in `src/app.ts` |
| CORS | no `access-control-allow-origin` for a foreign `Origin` on GET or OPTIONS preflight (same-origin API by construction; no CORS plugin registered) | absence of CORS middleware |
| debug surfaces | `/debug/deals/:id` -> 404 when `DEBUG_SURFACES_ENABLED` is unset | `debugSurfacesActive()` in `src/app.ts` |
| unsigned webhook | `POST /webhooks/payments` without signature -> 401 `invalid_webhook_signature`, never 500, no-store | `verifyWebhookSignature` in `src/frontend_runtime.ts` |
| app shell HTML | `/`, `/app`: text/html with security headers and no-store/no-cache | `src/frontend_runtime.ts` shell routes |

## Gaps (documented; no runtime change on this branch)

| Id | Finding | Risk | Suggested change |
|---|---|---|---|
| GAP-HTTP-1 | `/readiness` has no `cache-control: no-store` (`isDynamicNoStoreRoute` lists `/health` and `/health/integrations` but not `/readiness`) | an intermediary could cache a readiness verdict | add `/readiness` to the list in `src/app.ts` |
| GAP-HTTP-2 | no `strict-transport-security` header is emitted by the application | TLS termination is at Render; HSTS should be set at the edge or by the app once the custom domain is final | decide edge vs app; add to `applySecurityHeaders` if app-level |
| GAP-HTTP-3 | no `content-security-policy` header on the HTML shells | inline scripts in the legacy shell would need nonces; the React shell could carry a strict policy | UX-owned; out of scope here |

## What this smoke is NOT

It is not the authorization proof (that is `scripts/ci_route_authorization_gate.cjs` + the security test group), not a penetration test, and not a hosted check (`docs/DEPLOYMENT_RUNBOOK.md` runs the same probes against staging after a deploy, by hand).
