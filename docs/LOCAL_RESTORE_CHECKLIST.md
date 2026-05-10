# Local Restore Checklist

Use this when moving machines, formatting, or rebuilding the C-ton dev/demo environment. Do not store secret values in this file or in git.

## 1. Clone

```powershell
git clone https://github.com/matilederer7-bit/C-ton.git
cd C-ton
git checkout master
git fetch origin
git status
git rev-list --left-right --count origin/master...HEAD
```

Expected branch: `master`.
Expected sync before work: `0 0` from the rev-list command.

## 2. Node and Install

Required Node version from `package.json`: `>=22.0.0`.

```powershell
node --version
npm install
```

## 3. Restore Local Env Manually

Create a local `.env` from the saved private values. `.env` is gitignored and must stay out of git.

Required / common variables to restore without committing values:

- `DATABASE_URL`
- `DB_SCHEMA`
- `APP_DEPLOYMENT_MODE`
- `HOST`
- `PORT`
- `LOG_LEVEL`
- `ADMIN_API_KEY`
- `PAYMENT_PROVIDER`
- `PAYMENT_PROVIDER_MODE`
- `PAYMENT_WEBHOOK_PROVIDER`
- `PAYMENT_WEBHOOK_SECRET`
- `EXPECTED_COMMIT_SHA`
- `INVOICE_PROVIDER`
- `INVOICE_PROVIDER_MODE`
- `INVOICE_PROVIDER_BASE_URL`
- `INVOICE_PROVIDER_API_KEY`
- `INVOICE_PROVIDER_BEARER_TOKEN`
- `INVOICE_WEBHOOK_SECRET`
- `NOTIFICATION_PROVIDER`
- `DEBUG_SQL_LOGGING`
- `DEBUG_JOIN_LOGGING`
- `DEBUG_SURFACES_ENABLED`

Optional external-provider variables may also be needed if those integrations are enabled:

- `PAYMENT_PROVIDER_API_KEY`
- `PAYMENT_PROVIDER_PUBLIC_KEY`
- `PAYOUT_PROVIDER_API_KEY`
- `DEBUG_SURFACES_ACCESS_KEY`
- `SELLER_SESSION_SECRET`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM`

## 4. Render Database

`DATABASE_URL` for the demo deployment is configured in Render as the managed database connection string. Do not paste it into git, docs, screenshots, or chat.

Current demo DB details to preserve:

- name: `cton-demo-db`
- database: `cton_demo`
- user: `cton_demo_user`
- region: Frankfurt
- PostgreSQL: 18
- status: available
- plan: free
- note: DB expires on 2026-06-09 unless upgraded

Before applying `render.yaml`, verify whether Render resources should keep the current compatibility names or be aligned to C-ton naming.

## 5. Basic Checks

Run only scripts that exist in `package.json`:

```powershell
npm test
```

Useful focused checks:

```powershell
npm run test:deal-types
npm run test:deal-types-e2e
npm run test:refund-policy
npm run test:json-boundary
```

There is no `typecheck`, `build`, or `lint` script currently declared in `package.json`.

## 6. Local Run

For local development:

```powershell
npm run dev
```

For demo bundle flow:

```powershell
npm run build:demo
npm run start:demo:prod
```

`npm run start:demo` runs both steps through the package script.

## 7. Demo DB Bootstrap

Use only against the intended demo database:

```powershell
npm run bootstrap:demo-db
```

Confirm `DATABASE_URL` points at the correct Render/local demo DB before running.

## 8. Render Demo Deployment

1. Confirm `origin/master` contains the intended commit.
2. Confirm Render env vars are configured in the Render dashboard and no secrets are committed.
3. Confirm the Render database is available.
4. Set `EXPECTED_COMMIT_SHA` to the commit being deployed.
5. Trigger the Render demo service deploy.
6. Check `/health` and Mission Control readiness after deploy.

## 9. Pre-Format Final Check

Before formatting, confirm:

- `git status --short` is clean.
- `git rev-list --left-right --count origin/master...HEAD` returns `0 0`.
- `.env` values are backed up outside git.
- Render dashboard secrets are backed up or recoverable from the provider dashboards.
- Local `uploads/` are either backed up or confirmed disposable.
- No secret values were added to git.
