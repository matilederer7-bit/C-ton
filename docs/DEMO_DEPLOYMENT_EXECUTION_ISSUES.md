# Demo Deployment Execution Issues

## Fixed In This Pass

- No canonical compiled demo bundle existed.
  - Fixed with `build:demo`, `start:demo:prod`, `tsconfig.demo.json`, and `scripts/build_demo_bundle.cjs`.
- Frontend assets were not guaranteed to resolve correctly from a compiled artifact.
  - Fixed by hardening frontend asset lookup in `src/frontend_runtime.ts`.
- No deployment descriptors existed.
  - Fixed by adding `Dockerfile`, `.dockerignore`, and `Procfile`.
- No safe demo env example existed.
  - Fixed by adding `.env.demo.example`.

## Non-Blocking

- `start:demo` is a long-running wrapper command by design, so ad-hoc shell runs should use controlled process launch or hosting runtime.
- No `git remote` is configured, so this pass can only commit locally.

## Infra / Blocking For Live URL

- No hosting target is configured in the current environment.
- Docker CLI is not installed locally, so container execution could not be completed here.
- No external preview platform credentials or repo integration are present.

## Demo-Only Boundaries

- payment remains mock-backed
- notifications remain log-only
- receipts remain internal-ready only
- delivery remains workflow-only
- payout and KYC remain internal semantics only
