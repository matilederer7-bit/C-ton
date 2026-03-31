# Render Demo Deployment Log

## Phase A - Render Deployment Path Audit

- Chosen hosting target: Render
- Chosen deployment path: Render Blueprint with Docker web service plus managed Render Postgres
- Canonical runtime path:
  - build: `npm run build:demo`
  - bootstrap: `npm run bootstrap:demo-db`
  - start: `npm run start:demo:prod`
- Required envs from `.env.demo.example`:
  - `APP_DEPLOYMENT_MODE=demo-preview`
  - `DB_SCHEMA=siton`
  - `PAYMENT_PROVIDER=mockpay`
  - `PAYMENT_PROVIDER_MODE=mock-backed`
  - `PAYMENT_WEBHOOK_PROVIDER=mockpay`
  - `PAYMENT_WEBHOOK_SECRET`
  - `NOTIFICATION_PROVIDER=log-only`
  - `DATABASE_URL` from Render managed Postgres
- Port binding:
  - app already respects `PORT`
  - Render should inject `PORT`
- Immediate infra blockers found:
  - no `git remote`
  - no Render/GitHub connection from this environment
- Decision:
  - do not use ad hoc start-command deployment
  - use one Render blueprint path only via `render.yaml`

## Phase B - Render Packaging Alignment

- Added `render.yaml` with one web service and one managed Postgres database
- Added canonical demo DB bootstrap:
  - `scripts/bootstrap_demo_db.cjs`
  - `src/migrations/014_demo_preview_bootstrap.sql`
- Updated `package.json` so runtime path becomes:
  - `npm run start:demo:prod` -> bootstrap DB -> start compiled app
- Refined `.env.demo.example` to clarify local-only `PORT=3000`
- Verified bootstrap path locally:
  - `npm run bootstrap:demo-db` passed
- Verified packaging path locally:
  - `npm run build:demo` passed
  - `node --check frontend/app.js` passed
  - `npx tsc --noEmit` passed

## Phase C - Repo / Git / Deploy Surface Preparation

- Render blueprint file now exists at `render.yaml`
- Docker runtime path stays canonical and unambiguous
- `git remote -v` is still empty
- Result:
  - repo is Render-ready internally
  - external repo/Render linkage remains the only external blocker

## Phase D - Render Deployment Execution

- No live Render deployment could be executed from this environment
- Reason:
  - there is no accessible git remote and no Render account/session integration in the environment
- Reached last internal step:
  - repository now contains everything Render needs to create the demo service
  - final external action is to connect/push this branch to a Git repo accessible by Render and create the blueprint deploy

## Phase E - Post-Deploy Sanity and Demo RC

- Local RC on the final Render-oriented package passed:
  - `npm run start:demo:prod` served `/health` with `200`
  - `npm run start:demo:prod` served `/api/preview/meta` with `200`
  - `npm run start:demo:prod` served `/app` with `200`
  - `npm test` passed
- Demo guardrails remain active:
  - payment stays mock-backed
  - notifications stay log-only
  - preview metadata explicitly marks demo mode
