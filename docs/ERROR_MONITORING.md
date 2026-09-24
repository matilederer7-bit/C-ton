# Error monitoring (Sentry)

Staging reports runtime errors to the Sentry project **`c-ton/siton-staging`** (region `de.sentry.io`). Claude Code reads them through the Sentry connector.

## What is reported

| Source | Trigger | Correlation tags |
| --- | --- | --- |
| web (`src/app.ts`) | 5xx from the Fastify error handler | `route` (template, e.g. `/api/deals/:id/join`), `method`, `status_code`, `request_id` |
| web | startup failure, uncaught exception, unhandled rejection (the process still exits 1) | `service` |
| worker (`src/worker.ts`) | cycle failure, heartbeat failure, startup failure, fatal process error | `worker_id` |
| browser (`web/`, legacy `frontend/`) | uncaught error, unhandled rejection, relayed through `POST /api/client-errors` | `client_source`, `client_route` (shape only, e.g. `/track/:param`), `client_release` |

Every event carries `environment` and `release`. `release` is the deployed commit SHA, taken from `RENDER_GIT_COMMIT`. The `request_id` tag is the same id that appears in the pino log lines and audit rows, so one Sentry event links to the full server-side trail.

## What is never sent

The client in `src/error_monitoring.ts` has no SDK and builds each event from an allowlist:

- exception type
- scrubbed message
- stack frames
- fixed correlation tags

It never reads request bodies, headers, cookies, query strings, user identity or IP addresses, so none of them can reach Sentry. It scrubs the following out of messages:

- emails
- phone numbers
- card and account numbers
- JWTs
- bearer tokens
- `password=` / `token=` / `otp=`-style pairs
- IP addresses
- long opaque keys

It keeps UUIDs, because deal, participant and request ids are the correlation keys.

`tests/error_monitoring_security_validation.ts` checks the exact outgoing bytes against these rules.

Sending is capped at 30 events per minute per process, and identical errors are deduplicated for 60 s. The browser relay is anonymous by design. It caps each report at 16 KiB, rejects anything outside its schema, accepts 10 reports per minute per IP, and always answers 204.

## Configuration (Render dashboard; never in the repository)

| Variable | Services | Value |
| --- | --- | --- |
| `SENTRY_DSN` | web, worker | DSN of `c-ton/siton-staging`. Monitoring is disabled when it is unset. |
| `SENTRY_ENVIRONMENT` | web, worker | `staging` |
| `SENTRY_SELF_TEST` | web, worker | `1` sends one synthetic `MonitoringSelfTestError` per boot, tagged `self_test:true`, at level warning. It is never thrown, so no request, job, database row or money path sees it. Currently `0`: the proof was recorded on 2026-09-24 as issues `SITON-STAGING-1` and `SITON-STAGING-2`, release `2839ad6`. |

## Investigating with Claude Code

- `search_issues(organizationSlug='c-ton', projectSlugOrId='siton-staging', query='is:unresolved')`
- `get_sentry_resource(url=<issue url>)` returns the stack trace and the latest event
- Search Render logs for the event's `request_id` tag to see the full request

## Known limits

- Sentry shows a `user.geo` inferred from the sending IP. That is always the Render server, never a browser.
- Browser stack frames point at minified bundles. No source maps are uploaded.
- No performance tracing or breadcrumbs, by design: each would be a new channel for personal data.
