# Local Restore Checklist

Use this when moving machines, formatting, or rebuilding the C-ton development environment. Do not store secret values in this file or in git. Refreshed 2026-09-27 (Black-Sky E11): the old Render demo database (`cton-demo-db`, expired 2026-06-09) and the Base44 runtime are historical; the canonical topology is Render Web + Worker on Supabase Postgres/Storage (`render.yaml`). The full list of settings that live outside git is `docs/CONFIG_INVENTORY.md`.

## 1. Clone

```bash
git clone https://github.com/matilederer7-bit/C-ton.git
cd C-ton
git checkout master
git fetch origin
git status
git rev-list --left-right --count origin/master...HEAD
```

Expected branch: `master`. Expected sync before work: `0 0`.

## 2. Node and install

Required Node version from `package.json` `engines`: `>=22.0.0` (the image and CI use Node 22).

```bash
node --version
npm ci
npm ci --prefix web
```

## 3. Local database

Tests and local runs need a disposable PostgreSQL 16 on localhost. The test runner (`scripts/run_test_group.cjs`) creates and drops one database per test file and refuses non-local hosts (`scripts/lib/test_db_isolation.cjs`). Never point `DATABASE_URL` at the hosted Supabase project for local work.

```bash
docker compose up -d postgres   # or any local PostgreSQL 16
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/siton
npm run db:migrate
```

## 4. Local `.env`

Create `.env` from `.env.demo.example`. `.env` is gitignored and must stay out of git. For local/demo runs the defaults are sufficient; only restore private values if you need a real provider sandbox. Production-only secrets (`OTP_TOKEN_SECRET`, `SITON_OWNER_AUTH_USER_ID`, …) are never needed locally — see `docs/CONFIG_INVENTORY.md` §1 for where each hosted value lives.

## 5. Checks

```bash
npx tsc -p tsconfig.json --noEmit           # typecheck
npm run -s lint                             # backend enforcement scans
node --test tests/release_tools/*.test.cjs  # release tooling
DATABASE_URL=... node scripts/run_test_group.cjs security   # one group; "all" runs every group
node scripts/siton_verify.cjs               # canonical verifier (needs local PostgreSQL)
```

## 6. Local run

```bash
npm run dev                    # tsx src/app.ts
npm run build:demo && node .demo_dist/src/app.js   # the same program the image runs
```

## 7. Hosted environment (reference only — owner console actions)

- Render services `siton-staging-web` and `siton-staging-worker` deploy from `master` only after CI checks pass (`autoDeployTrigger: checksPass`).
- Their secrets are set in the Render dashboard (`docs/CONFIG_INVENTORY.md` §1); nothing needs restoring from a local machine.
- Supabase settings, Edge Function `storage-broker` and its secrets: `docs/CONFIG_INVENTORY.md` §2.
- GitHub Actions secrets: `docs/CONFIG_INVENTORY.md` §3.

## 8. Pre-format final check

Before formatting, confirm:

- `git status --short` is clean and `git rev-list --left-right --count origin/master...HEAD` returns `0 0` (no work exists only locally).
- `.env` values you care about are backed up outside git.
- Hosted secrets are recoverable from the Render / Supabase / GitHub / provider dashboards (they are not stored locally).
- Local `uploads/` are backed up or confirmed disposable.
- No secret values were added to git.
