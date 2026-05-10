# Cache Policy

Status: implemented as operational hardening for demo readiness.

## Dynamic Routes

All dynamic API and webhook surfaces are marked non-cacheable:

- `/api/*`
- `/webhooks/*`
- `/health`
- `/health/integrations`
- operational prefixes for admin, seller, buyer, tracking, payments, invoices, payouts and notifications

Response policy:

- `Cache-Control: no-store`
- `Pragma: no-cache`
- `Expires: 0`

This is a response-header hardening only. No Redis, memory cache, business memoization, or provider result cache was added.

The Security Hardening Gate also adds baseline browser security headers globally. These do not change the cache policy and do not override the immutable deal-image exception.

## Deal Images

`GET /api/deal-images/:imageId` remains explicitly immutable:

- `Cache-Control: public, max-age=31536000, immutable`

The global dynamic no-store hook excludes this route.

## Frontend Assets

The frontend is served from `frontend/index.html`, `frontend/app.js`, and `frontend/styles.css`.

- `index.html`: `Cache-Control: no-store`
- `app.js`: `Cache-Control: no-cache, must-revalidate`
- `styles.css`: `Cache-Control: no-cache, must-revalidate`

The JS and CSS filenames are not content-hashed, so they must not be immutable.

## CDN Readiness

This document is the cache contract that any CDN (CloudFront, Cloudflare, Fastly) must respect. The application serves all responses with explicit cache headers. A CDN placed in front of the origin must:

- Honor `Cache-Control: no-store` for `/api/*`, `/webhooks/*`, `/health`, `/health/integrations`, `/admin/*`, `/seller/*`, `/buyer/*`, `/tracking/*`, `/payments/*`, `/invoices/*`, `/payouts/*`, `/notifications/*` and the operational prefixes listed above.
- Honor `Cache-Control: public, max-age=31536000, immutable` for `GET /api/deal-images/:imageId` (content-addressed, safe to cache at edge).
- Treat `frontend/index.html` as `no-store` (so deploys are picked up immediately).
- Treat `frontend/app.js` and `frontend/styles.css` as `no-cache, must-revalidate` (revalidate on every request — these filenames are not content-hashed).

Recommended CDN behaviors (per `docs/AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md`):

| Path pattern | Place behind CDN? | Cache key | TTL |
|---|---|---|---|
| `/api/deal-images/*` | yes | path | 1 year (the asset id changes when the image changes) |
| `/app/*` | yes | path | respect origin headers (`no-store` / `no-cache, must-revalidate`) |
| `/api/*`, `/webhooks/*`, `/admin/*`, `/buyer/*`, `/tracking/*` | **no** — origin-only | n/a | n/a |
| `/health` | optional, but only if CDN propagates `no-store` | n/a | n/a |

A CDN that ignores origin cache headers must **not** be placed in front of `/api/*` or `/webhooks/*`. Misconfigured edge caching of admin or webhook surfaces can leak data, replay-stale state, or break webhook idempotency.

## Validation

- `npm run test:cache-policy` passed.
- `npm run test:aws-accordion-readiness` validates the CDN posture against this policy and the blueprint.
- No dependency was added.
- No business state machine or money logic was changed.
