# Health check contract

Automated proof: `npm run check:health-contract` (`scripts/health_contract_check.cjs`) boots the real web runtime and the real worker against an isolated migrated database and exercises every signal, including a negative control. 2026-09-14: 6/6 PASS. No runtime code was changed for it.

## Signals

| Signal | Endpoint / source | Proves | Does NOT prove |
|---|---|---|---|
| process alive | child pid | the Node process exists | anything about serving |
| HTTP responsive | `GET /health` -> `200 {"ok":true}` (`src/app.ts`) | the HTTP listener answers; security + no-store headers applied | database, provider, worker, schema. **Proven:** after the database is dropped, `/health` still answers 200 |
| DB reachable + schema compatible | `GET /readiness` -> `200 {"ok":true,"database":"connected","schema":"siton",...}` (`src/app.ts` -> `assertCanonicalRuntimeReady` in `src/runtime_database_boundary.ts`) | a query succeeds; `assertDatabaseSchema` requires the contract tables; with `CANONICAL_POSTGRES_RUNTIME=1` also the expected least-privilege runtime role and the inventory RPC probe (`boundary` is `legacy-test` without it) | migration high-water mark equals the repository (a database BEHIND by a migration that adds no contract table still answers 200); worker state |
| worker readiness | `siton.worker_heartbeats` row `status='ready'`, fresh `heartbeat_at` (`src/worker.ts`); the CI/lab compose healthchecks query it | the worker process runs cycles and heartbeats | that jobs are being consumed (queue depth is in `/api/admin/outbox-status`) |
| payment provider intentionally disabled | `GET /health/integrations` (`src/frontend_runtime.ts`) -> `integrations.payment.provider=mockpay`, `mode=mock-backed` | the configured provider and mode; no secret value is echoed (proven) | provider reachability (mock) |
| database gone | drop the database under the running process | `/readiness` -> `503 {"ok":false,"code":"not_ready"}` while `/health` stays 200 | - |

Render health-checks `/readiness` (`render.yaml`), which is the right one. A load balancer configured on `/health` alone would keep routing to a database-less instance.

## Gaps (documented; runtime unchanged)

| Id | Gap | Suggested future runtime change (not on this branch) |
|---|---|---|
| HC-1 | `/readiness` does not include worker readiness; a healthy web with a dead worker looks ready | expose `worker_heartbeats` freshness in `/readiness` or a dedicated `/readiness/worker` for the worker service |
| HC-2 | `/readiness` does not compare the ledger high-water mark with the repository manifest | include `migration_high_water` and a `schema_matches_manifest` boolean (`scripts/lib/migration_tools.cjs` already computes it) |
| HC-3 | `/readiness` carries no `cache-control: no-store` (`isDynamicNoStoreRoute` lists `/health` but not `/readiness`) | add `/readiness` to the no-store route list (`GAP-HTTP-1` in `docs/HTTP_SECURITY_SURFACE.md`) |
| HC-4 | provider "intentionally disabled" is inferred from configuration, not from an explicit switch | keep; `config/real-money-release-policy.json` is the governance switch |

## Operator checks

```
curl -s https://<host>/health                # liveness only
curl -s https://<host>/readiness             # DB + schema (+ runtime role when canonical)
curl -s https://<host>/health/integrations   # provider/mode posture, no secrets
# worker:
select worker_id, status, heartbeat_at from siton.worker_heartbeats;   # via the admin ops surfaces or a read-only console
```
