# Demo Deployment Execution Log

## Phase A - Deployment Path Audit

- Canonical demo runtime path:
  - `npm run start:demo`
- Canonical artifact path:
  - `npm run build:demo`
  - `npm run start:demo:prod`
- Build dependencies:
  - Node.js
  - npm dependencies from `package.json`
  - TypeScript compiler for bundling the runtime
- Environment requirements:
  - `APP_DEPLOYMENT_MODE=demo-preview`
  - demo-safe `PAYMENT_PROVIDER_MODE=mock-backed`
  - demo-safe `NOTIFICATION_PROVIDER=log-only`
  - database connectivity
- Hosting requirements:
  - any basic Node host or container host that can expose one HTTP port
- Existing platform hints before this pass:
  - none
- Existing deployment target before this pass:
  - none
- Immediate infra blockers found:
  - no configured host target
  - no `git remote`
  - Docker CLI is not installed in the current environment

## Phase B - Demo Runtime Packaging

- Added canonical demo build script:
  - `npm run build:demo`
- Added canonical demo start scripts:
  - `npm run start:demo`
  - `npm run start:demo:prod`
- Added packaging files:
  - `Dockerfile`
  - `.dockerignore`
  - `Procfile`
  - `tsconfig.demo.json`
  - `scripts/build_demo_bundle.cjs`
- Hardened frontend asset resolution so the compiled runtime can serve frontend assets from `.demo_dist/frontend` or fallback safely.
- Built artifact successfully:
  - `.demo_dist/`

## Phase C - Environment and Config Closure

- Added `.env.demo.example` with demo-safe defaults.
- Confirmed demo-safe runtime config:
  - `APP_DEPLOYMENT_MODE=demo-preview`
  - `PAYMENT_PROVIDER_MODE=mock-backed`
  - `NOTIFICATION_PROVIDER=log-only`
- Confirmed:
  - `/health/integrations` reports deployment mode
  - `/api/preview/meta` reports demo guardrails
  - admin system status exposes demo boundary

## Phase D - Preview Safety and Public-Facing Hardening

- Preview strip remains active in the frontend shell.
- Public/home framing stays preview-oriented, not commercial-live.
- Payment, receipts, delivery, affiliate payout, and admin system status keep explicit demo boundaries.
- No external rails were activated.

## Phase E - Live Deployment Execution

- No real host target was available in the current environment.
- No remote repository was configured for automated preview hosting.
- Docker-based local packaging could not be executed because Docker CLI is absent here.
- Reached the last internal step:
  - ready artifact bundle
  - ready environment example
  - ready start path
  - ready deployment descriptors
- Verified the compiled artifact locally with a real Node startup:
  - `GET /health` -> `200`
  - `GET /health/integrations` -> `200`
  - `GET /api/preview/meta` -> `200`
  - `GET /app` -> `200`

## Phase F - Post-Deploy Sanity And RC Check

- PASS: `node --check frontend/app.js`
- PASS: `npx tsc --noEmit`
- PASS: `npm run build:demo`
- PASS: `npm run test:demo-preview`
- PASS: `npm test`
- PASS: compiled runtime served health, integrations health, preview meta, and app shell
- PASS: `.tmp_test_dist` removed
- PASS: `.demo_dist` exists
- PASS: no lingering `node` process after cleanup
- BLOCKER FOR LIVE URL:
  - missing hosting target / preview platform in the current environment

## Phase G - Final Assessment

- Internal deployment execution work is complete.
- The demo deployment package is ready.
- The only remaining step to get a live URL is attaching this package to an actual host target and applying the demo-safe envs.
