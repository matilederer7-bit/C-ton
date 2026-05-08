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

## Validation

- `npm run test:cache-policy` passed.
- No dependency was added.
- No business state machine or money logic was changed.
