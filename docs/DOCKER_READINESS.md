# Docker Readiness

Status: foundation ready for local cloud-like runs and Tier 1 single-instance launches. Live money, multi-instance and live customer traffic remain blocked by separate gates.

## Verdict

- `dockerfile_status`: present and reproducible
- `dockerignore_status`: hardened — secrets, runtime artefacts, archives and IDE state excluded
- `compose_status`: `docker-compose.yml` ships an app + Postgres demo stack
- `windows_path_dependency`: none in runtime / build / docker
- `live_money_performed`: no
- `state_machine_changed`: no
- `money_logic_changed`: no

## What is in the image

The image is built from [`Dockerfile`](../Dockerfile) on top of `node:22-bookworm-slim`. Build stages (single-stage, intentional — multi-stage adds risk for marginal size win at this point):

1. `COPY package*.json ./` + `npm ci` — lockfile-pinned dependency install.
2. `COPY . .` — source copy. `.dockerignore` excludes `.env`, `.env.*` (except `.env.demo.example`), `node_modules`, `.git`, `uploads/`, `.tmp_*`, `.demo_dist`, `archive/`, `backups/`, `docs/`, `.claude/`, `.idea/`, `.vscode/`, OS noise, delivery reports and `PROJECT_STATUS.md`.
3. Defense-in-depth `find ... -delete` removes any `.env` / `.env.local` / `.env.production` / `.env.real` that may have slipped through `.dockerignore`.
4. `npm run build:demo` — produces `.demo_dist/` (the runtime bundle).
5. Non-root `appuser` is created and used.
6. `HEALTHCHECK` probes `GET /health` every 30s.
7. `CMD ["npm", "run", "start:demo:prod"]` — runs `npm run bootstrap:demo-db` (idempotent migration replay) then launches the bundled app.

## What the image does NOT contain

- No real `.env` file.
- No keys, tokens, AWS credentials, payment provider secrets or webhook secrets.
- No `node_modules` from the host (re-installed in the image).
- No upload artefacts, no `.tmp_*` runtime files, no Edge profile directories.
- No `docs/` (the running container does not need documentation).
- No `archive/` or `backups/` history.
- No `.git/` history.

## Required environment for the container

| Env | Required for | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | always | `postgresql://postgres:postgres@localhost:5432/siton` | Override at runtime — the default is for local dev only. |
| `DB_SCHEMA` | always | `siton` | |
| `PORT` | always | `3000` | Render injects this; compose maps host:3000 → container:3000. |
| `HOST` | always | `0.0.0.0` | |
| `APP_DEPLOYMENT_MODE` | always | `demo-preview` | Set to `production` only after production launch readiness gate is closed. |
| `NODE_ENV` | always | `production` | |
| `LOG_LEVEL` | optional | `info` | |
| `ADMIN_API_KEY` | required in production-like | — | Demo compose uses a literal `demo-admin-key-do-not-use-in-production`. Rotate before any external access. |
| `EXPECTED_COMMIT_SHA` | optional | — | When set, mission-control checks deployed commit freshness. |
| `DEBUG_SURFACES_ENABLED` | optional | `0` | Off by default in compose. |
| `DEBUG_SURFACES_ACCESS_KEY` | required if `DEBUG_SURFACES_ENABLED=1` | — | |
| `PAYMENT_PROVIDER` | always | `mockpay` | Demo provider — no live money. |
| `PAYMENT_PROVIDER_MODE` | always | `mock-backed` | |
| `PAYMENT_WEBHOOK_PROVIDER` | always | `mockpay` | |
| `PAYMENT_WEBHOOK_SECRET` | required for live | `mock-webhook-secret` | Demo only. Live mode requires a real webhook secret managed outside the repo. |
| `PAYOUT_PROVIDER` | always | `internal-ledger` | Demo. |
| `PAYOUT_PROVIDER_MODE` | always | `internal-truth-only` | Demo. |
| `INVOICE_PROVIDER` | optional | unset | Activate Morning adapter only after sandbox gate. |
| `NOTIFICATION_PROVIDER` | always | `log-only` | Demo. |
| `DISABLE_OUTBOX_WORKER` | optional | unset | Set `1` if a separate worker container handles outbox. |

The full env contract — including secret/non-secret classification and per-mode required envs — lives in [docs/ENVIRONMENT_CONTRACT.md](ENVIRONMENT_CONTRACT.md).

## How to build and run

### Build the image

```
docker build -t siton-app:local .
```

### Run with an external Postgres

```
docker run --rm \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/db \
  -e ADMIN_API_KEY=<rotate-me> \
  siton-app:local
```

### Run the local cloud-like stack (recommended for demos)

```
docker compose up --build           # app on :3000, postgres on host :5433
docker compose down -v              # stop and discard the demo DB volume
docker compose logs -f app          # tail app logs
```

The compose stack:
- Brings up `postgres:16-alpine` with a healthcheck.
- Builds the app image and waits for postgres to be healthy.
- Bootstraps the `siton` schema on every container start (idempotent).
- Exposes `/health` for liveness and `/api/admin/mission-control` (with `x-admin-key`) for full readiness.
- Uses local volumes — does not persist beyond `docker compose down -v`.

### Smoke tests inside the container

```
# liveness — used by the load balancer
curl -fsS http://localhost:3000/health

# static assets — served directly from the app process
curl -fsS http://localhost:3000/app
curl -fsS http://localhost:3000/app/assets/app.js

# admin readiness — requires admin key
curl -fsS -H "x-admin-key: <key>" http://localhost:3000/api/admin/mission-control | jq '.accordion_scaling_readiness'

# admin without key — must 401 in production-like mode
curl -fsS -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/admin/mission-control
```

## What the readiness validation tests

Run from the host:

```
npm run test:docker-readiness        # static Dockerfile + dockerignore + compose validation
npm run test:aws-accordion-readiness # blueprint and mission-control accordion section validation
npm run test:cache-policy            # CDN/cache header policy
npm run test:scale-readiness         # in-memory state, worker, idempotency posture
npm run test:mission-control         # mission control sections including accordion_scaling_readiness
```

The Docker engine is not required by the static validation. Container build / runtime / compose smoke tests are gated on `docker --version` succeeding — they report `skipped` with reason when Docker is unavailable, never a false `pass`.

## What is NOT production-ready

- The shipped Dockerfile is single-stage and includes devDependencies in the runtime layer (because `dotenv` is currently a devDependency consumed at runtime by `runtime_config.ts`). This is an image-size concern, not a security one.
- The image runs as non-root (`appuser`) but is not minimised (no distroless base, no read-only FS).
- The container expects a managed database — it does NOT bundle Postgres for production use. The compose stack bundles Postgres for demo only.
- No object storage adapter is wired. `STORAGE_ADAPTER=object` is documented in [STORAGE_PRODUCTION_FOUNDATION.md](STORAGE_PRODUCTION_FOUNDATION.md) but not implemented in this MVP.
- No Redis / shared rate-limit. The in-process rate limiter is `single_instance_only`.
- No live money. Real provider validation and live charges are blocked behind the Provider Sandbox / Live Money Validation gate.
- No production admin identity / MFA enforcement. `ADMIN_API_KEY` is the demo bootstrap fallback.

## App vs Worker separation

The current container runs the API + outbox worker in a single process. To scale, the next step is to split into:

- **app**: API only, `DISABLE_OUTBOX_WORKER=1`
- **worker**: dedicated worker process — runs the outbox poller, idempotent claim via `FOR UPDATE SKIP LOCKED`

Both services share the same image. Splitting is a deployment concern, not a code concern — the worker entry-point is already `outbox_worker_helpers` (see [HORIZONTAL_SCALE_READINESS.md](HORIZONTAL_SCALE_READINESS.md)).

## Cross-references

- [docs/AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md](AWS_ACCORDION_DEPLOYMENT_BLUEPRINT.md) — how to go from `docker compose` to small-market launch to accordion scale on AWS.
- [docs/ENVIRONMENT_CONTRACT.md](ENVIRONMENT_CONTRACT.md) — full env list, secret/non-secret classification, per-mode required envs.
- [docs/HORIZONTAL_SCALE_READINESS.md](HORIZONTAL_SCALE_READINESS.md) — what blocks multi-instance.
- [docs/STORAGE_PRODUCTION_FOUNDATION.md](STORAGE_PRODUCTION_FOUNDATION.md) — local vs object storage.
- [docs/CACHE_POLICY.md](CACHE_POLICY.md) — cache headers, CDN-readiness contract.
- [docs/PROVIDER_LIVE_MONEY_READINESS.md](PROVIDER_LIVE_MONEY_READINESS.md) — what blocks live money.
- [docs/PRODUCTION_LAUNCH_READINESS.md](PRODUCTION_LAUNCH_READINESS.md) — full launch checklist.
