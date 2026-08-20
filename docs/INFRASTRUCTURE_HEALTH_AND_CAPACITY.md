# Infrastructure Health and Capacity Control

## Purpose and boundary

The existing `/app/admin#admin-system` System Status section is Siton's single infrastructure-health surface. It translates technical signals into `GREEN`, `AMBER`, or `RED` and Hebrew management copy. It does not add a business Action, change the state machine, move money, replay jobs, or bypass Queue, Worker, Audit, MFA, or idempotency.

`RED` distinguishes a sustained capacity problem from an operational incident. A single CPU spike cannot raise `RED`; immediate incidents are deliberately limited to evidence such as a non-empty DLQ, expired Worker heartbeat while work is queued, an expired CompletionWindow, or a stuck reconcile job.

## Data flow

1. The browser polls `GET /api/admin/system-status` every 45 seconds and can pause polling.
2. `InfrastructureMetricsCollector` queries lightweight PostgreSQL aggregates and application request telemetry. It optionally scrapes Supabase's Prometheus-compatible Metrics API no more than once per minute; 45-second Admin polls reuse the bounded server-side scrape result.
3. A bounded in-process ring buffer retains up to 24 hours / 2,000 samples. This avoids creating a monitoring workload inside the business database. History is process-local and resets on deploy; an external Prometheus store is the production path for durable long-term telemetry.
4. `evaluateInfrastructureHealth` evaluates sustained ratios across configured windows and emits the snapshot, attention items, incident/capacity classification, recommendation, alerts, and `now` / 15-minute / 1-hour / 24-hour summaries.
5. The endpoint preserves the existing integration/readiness/count blocks and adds `system_status.infrastructure` plus `system_status.compute_management`.

## Metric sources

| Signal | Source | Degraded behavior |
|---|---|---|
| DB CPU, memory, disk, I/O wait, Supavisor pool | Supabase Metrics API (`/customer/v1/privileged/metrics`) | `unavailable` with a reason; requires two scrapes for CPU/I/O rates |
| DB connections/max, DB size, query round trip | PostgreSQL read-only statistics/settings | `unavailable` if the query fails |
| Slow queries | `pg_stat_statements`, only when installed and readable | `unavailable`; no query text is returned |
| API p95/error rate | bounded in-process request telemetry | `unavailable` when no requests exist in the window |
| Queue depth/age, DLQ, Worker heartbeat/lag | canonical outbox and Worker heartbeat tables | current values or explicit unavailable state |
| Webhook/payment failure rate | canonical webhook/payment-attempt ledgers over 15 minutes | zero only when the ledger proves requests with no failures; provider latency is unavailable because duration is not persisted |
| CompletionWindow/reconcile stuck | canonical deal/outbox read-only aggregates | current count |

Unavailable values are never fabricated. The monitor records last successful/failed fetch, bounded failure reason, collection latency, and recommendation evaluation time. Metrics-source failure does not make the Admin endpoint return `500`.

## Thresholds and decision engine

Defaults live only in `loadInfrastructureThresholds()`. Every sustained rule has warning, critical, evaluation window, and minimum breached-sample ratio (`0.8`). Representative defaults are CPU `75/90% for 10m`, memory `80/92% for 10m`, connections `70/85% for 10m`, disk `80/90% for 15m`, API p95 `500/1200ms for 5m`, queue depth `100/500 for 5m`, and payment/webhook failures `5/15% for 15m`.

Override names follow `INFRA_<NAME>_WARNING`, `INFRA_<NAME>_CRITICAL`, and `INFRA_<NAME>_WINDOW_MINUTES`; shared controls are `INFRA_THRESHOLD_MINIMUM_RATIO`, `INFRA_METRICS_UNAVAILABLE_WINDOW_MINUTES`, and `INFRA_STALE_AFTER_SECONDS`.

The recommendation engine does not map every problem to an upgrade. Queue/Worker, payment-provider, webhook, and API incidents recommend operational handling. Query latency plus slow-query evidence recommends optimization. Compute upgrade is recommended only when multiple sustained DB saturation signals agree.

## Security and compute approval

Supabase documents compute changes through `PATCH /v1/projects/{ref}/billing/addons` with `addon_type=compute_instance`. Siton wraps that endpoint server-side only.

Implementation references: [Supabase Metrics API](https://supabase.com/docs/guides/monitoring-and-debugging/metrics), [vendor-neutral Metrics API setup](https://supabase.com/docs/guides/monitoring-and-debugging/metrics/vendor-agnostic), and [Management API compute add-on example](https://supabase.com/docs/guides/integrations/supabase-for-platforms).

- Monitoring works while `SUPABASE_COMPUTE_MANAGEMENT_ENABLED=false` (the default).
- A mutation requires production runtime, an authenticated admin session (bootstrap key is insufficient), `admin_actions.execute`, recent MFA, explicit Current/Target display, downtime acknowledgement, only the immediately higher tier, a dedicated rate limit, and an idempotency key.
- Every request is durably recorded in isolated `siton.infrastructure_change_audit`; it is not part of the business state machine or canonical Actions list.
- No downgrade and no automatic/CI/development upgrade exist.
- The browser receives configuration booleans/status only. It never receives the Metrics Secret key, Management token, database credential, or service key.
- Price is not invented. The UI says `בדוק עלות ב-Supabase`.

## Production credentials and failure modes

Read-only hosted resource metrics require `SUPABASE_PROJECT_REF` and a dedicated `SUPABASE_METRICS_SECRET_KEY`. Current-tier discovery and the optional approved mutation require `SUPABASE_MANAGEMENT_API_TOKEN`; a fine-grained token needs `infra_add_ons_read` and `infra_add_ons_write`. Use a secret manager. Missing or rejected credentials produce explicit unavailable reasons and a disabled action.

The Metrics API is beta and metric names can evolve. Parser failures degrade individual hosted metrics. PostgreSQL/application signals continue to load. History is lightweight and local; deploy/restart clears it, and the decision engine waits for sufficient time coverage before declaring sustained capacity pressure.

## Verification

Run `npm run test:infrastructure-health`, `npm run test:admin-control-plane`, `npm run test:security-identity-tracking`, `npm run test:frontend-browser-smoke`, `npx tsc --noEmit`, and the normal repository CI gates. All compute tests use injected fake fetch implementations; tests cannot contact or mutate a real Supabase project.
