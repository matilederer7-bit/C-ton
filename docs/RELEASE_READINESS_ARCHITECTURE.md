# Release readiness architecture

Status: release-engineering layer built on branch `claude/release-readiness-night` from canonical master `82c91d62fd092350748405c8aec15a23d0e2af5e`, reintegrated onto master `0e53998bb4bb24b191a8d8fdfa921048c7b5a8b5` on 2026-09-15 (branch `claude/release-readiness-reintegration`). Reintegrated onto current master `0e53998` (PR #9 financial rails, PR #12 confidentiality proof, PR #13 hardened UX already merged) on 2026-09-15 as a controlled port of `claude/release-readiness-night` 63a108f; every reference below was re-verified against that master. Architecture: GitHub = code source of truth; Render = web/backend/worker staging runtime; Supabase = canonical PostgreSQL/Auth/infra; Grow = payment provider boundary, currently disabled; Base44 is never the business runtime. Nothing here changes the financial runtime, the UX runtime, migration contents, Grow configuration, or any hosted environment. Real money is BLOCKED by release governance (`config/real-money-release-policy.json`).

This document is the map. Every box names the command that proves it and the document that explains it.

## One-line answers

| Question | Command | Output |
|---|---|---|
| Can this exact commit go to staging/production? | `npm run release:preflight` | `RELEASE_PREFLIGHT_PASS/FAIL` + `.release-artifacts/release-preflight.md` |
| What is this commit, precisely? | `npm run release:manifest` | `.release-artifacts/release-manifest.md` (SHA, migrations, build hashes, real-money status) |
| What is proven and what is still an owner decision? | `npm run release:checklist` | `.release-artifacts/release-checklist.md` |
| The owner's one command | `npm run release:owner-check` | `READY FOR CODE DEPLOY: YES/NO`, `READY FOR REAL MONEY: NO` |
| Can commit X migrate the previous production schema? | `npm run migrations:preflight` | 10 disposable-database scenarios |
| Is the target database's ledger healthy? | `npm run migrations:doctor` | read-only verdict `HEALTHY / BEHIND / BLOCKED ...` |
| Does this release accidentally enable money? | `npm run proof:no-real-money` | `REAL_MONEY: BLOCKED` + 16 checks |

## Map

```
source ──► CI (GitHub Actions) ──► build (Docker image) ──► migration ──► deploy ──► health ──► smoke ──► release decision
   │            │                       │                       │             │           │          │
   │            │                       │                       │             │           │          └─ docs/DEPLOYMENT_RUNBOOK.md, docs/ROLLBACK_RUNBOOK.md
   │            │                       │                       │             │           └─ scripts/http_security_smoke.cjs, scripts/release_local_lab.cjs
   │            │                       │                       │             └─ scripts/health_contract_check.cjs, docs/HEALTH_CHECK_CONTRACT.md
   │            │                       │                       └─ scripts/run_migrations.cjs (ledger), migration_preflight / migrations_doctor / migrations_repair
   │            │                       └─ Dockerfile, docker-compose.release-lab.yml, scripts/reproducible_build_check.cjs
   │            └─ backend-quality-gates.yml, web-runtime-depth.yml, release-readiness.yml (new), docs/CI_TEST_STRATEGY.md
   └─ scanners on the canonical file policy (scripts/lib/repo_scan_policy.cjs)
```

### Source

- Canonical scan policy: `scripts/lib/repo_scan_policy.cjs`. Every static scanner walks the repository through it: `.git`, `.worktrees`, `node_modules`, build output, `.tmp*`, review artefacts and generated binaries are never inspected; `src`, `tests` (incl. `tests/lab`), `scripts`, `supabase`, `legacy`, `frontend`, `web/src`, `config`, `docs` always are.
- Semantic raw-card scanner: `scripts/lib/raw_card_terms.cjs` (identifiers, keys, SQL columns, form fields; prose is never a finding; `config/raw-card-term-allowlist.json`).
- Static gates hardened to invariants, not phrases: `scripts/money_tax_invoice_gate.cjs` (executed fee vectors + AST), `scripts/legal_compliance_gate.cjs` (shared semantic raw-card scan, AST-located KYC refusal, regex bug fixed).
- Secret / PII scan: `scripts/secret_pii_scan.cjs` (`config/secret-scan-allowlist.json`).
- Logging hygiene: `scripts/logging_hygiene_gate.cjs` (`config/logging-data-classification.json`, `docs/LOGGING_DATA_CLASSIFICATION.md`).
- Route inventory: `scripts/route_inventory_report.cjs` (`config/route-classification.json`; every route classified; unclassified sensitive route fails).
- Repository hygiene: `scripts/repository_hygiene_check.cjs` (whitespace, tracked artefacts, env files, migration line endings, dirty tree).

### CI

- `.github/workflows/backend-quality-gates.yml` (existing): TypeScript, enforcement scans, payment/raw-card scan, DDL scan, Base44 integrity, demo build, architecture, mobile/PWA, whitespace, migrations, ten test groups, route authorization gate, fault report, Docker smoke (same-repo PRs + push). The duplicate full-suite re-run is now post-merge only.
- `.github/workflows/web-runtime-depth.yml` (existing): route/frontend contract, real-HTTP core E2E; resilience on same-repo PRs + push.
- `.github/workflows/release-readiness.yml` (new): `preflight-static` (no DB), `preflight-database` (Postgres service: migration preflight, backup/restore rehearsal, health contract, HTTP security smoke, reproducible build, release-tool tests), `docker-release-lab` (same-repo PRs + push: image build, start, migrate, smoke, worker heartbeat, graceful stop, down).
- Strategy and redundancy map: `docs/CI_TEST_STRATEGY.md`. Flake handling: `docs/FLAKE_CLASSIFICATION.md`.

### Build

- Production image: `Dockerfile` (node:22, `npm ci`, `build:demo`, `web` Vite build, non-root, HEALTHCHECK `/health`, demo-preview default). Static readiness: `scripts/docker_readiness_static.cjs`.
- Reproducibility: `scripts/reproducible_build_check.cjs` (demo bundle, mobile bundle and Vite build were each DETERMINISTIC across two clean builds on 2026-09-14; `docs/REPRODUCIBLE_BUILD.md`).
- Identity: `scripts/release_manifest.cjs` records tree hashes for `.demo_dist`, `.mobile_dist`, `web/dist`.

### Migration proof

- Runner: `scripts/run_migrations.cjs` (ledger `siton.migration_ledger`, dirty-ledger refusal, LF-canonical checksum, CRLF-era checksum accepted as line-ending variant, forward-only).
- Preflight: `scripts/migration_preflight.cjs` (fresh install + idempotent rerun, upgrade from `origin/master`, partial-ledger catch-up, CRLF ledger, tampered checksum refused, dirty ledger refused, failing migration atomic with implicit and explicit transactions, schema drift fresh-vs-upgrade).
- Doctor / repair: `scripts/migrations_doctor.cjs` (read-only), `scripts/migrations_repair.cjs` (explicit, dry-run by default). `docs/MIGRATION_SAFETY_SYSTEM.md`.
- Backup / restore: `scripts/db_backup_restore_rehearsal.cjs`, `docs/DB_BACKUP_RESTORE_REHEARSAL.md`.

### Security gates

- Runtime environment contract: `config/runtime-environment-policy.json` + `scripts/runtime_environment_gate.cjs` (`docs/RUNTIME_ENVIRONMENT_POLICY.md`).
- Startup failure matrix: `config/startup-config-matrix.json` + `scripts/startup_config_matrix.cjs` (23 unsafe combinations against the REAL boot guard and the release policy; 6 documented runtime gaps).
- Real-money governance: `config/real-money-release-policy.json` + `scripts/proof_no_real_money.cjs` (`docs/REAL_MONEY_RELEASE_GOVERNANCE.md`).
- HTTP surface: `scripts/http_security_smoke.cjs` (`docs/HTTP_SECURITY_SURFACE.md`). Route authorization behavioural suites stay the authority (`scripts/ci_route_authorization_gate.cjs`).
- Data access boundaries: `docs/PRODUCTION_DATA_ACCESS_BOUNDARIES.md`.

### Docker

- Local lab: `npm run release:local-lab` (`docker-compose.release-lab.yml`). Reports `SKIPPED_ENVIRONMENT` where Docker is absent (this build machine); proven in CI.
- Existing CI smoke: `scripts/ci_docker_smoke.cjs` (MinIO, two web instances, worker, outbox faults).

### Staging / release / rollback

- Staging blueprint: `render.yaml` (web + worker, `/readiness` health check, mock money, Supabase Storage broker). The release policy evaluates it statically; found `OTP_HASH_SALT` missing (owner action, hosted).
- `docs/DEPLOYMENT_RUNBOOK.md`: CODE DEPLOY, DATABASE MIGRATION and REAL-MONEY ACTIVATION are three separate actions.
- `docs/ROLLBACK_RUNBOOK.md`: forward-only schema, worker freeze, money at zero.

### Monitoring / incident response

- Health signals: `docs/HEALTH_CHECK_CONTRACT.md` (`/health` liveness only; `/readiness` DB + schema + runtime role; worker = `siton.worker_heartbeats`; gaps HC-1..).
- Runbooks: `docs/PAYMENT_INCIDENT_RUNBOOK.md`, `docs/SECURITY_INCIDENT_RUNBOOK.md`, `docs/DATABASE_INCIDENT_RUNBOOK.md`.
- Local QA hygiene: `npm run qa:diagnose` (`scripts/qa_process_guard.cjs`), `scripts/lib/test_db_isolation.cjs`, `docs/PARALLEL_AGENT_DEVELOPMENT.md`.

## Verdict model

Every gate reports one of `PASS`, `FAIL`, `WARNING`, `SKIPPED_ENVIRONMENT` (`scripts/lib/release_report.cjs`). Only `FAIL` blocks. `SKIPPED_ENVIRONMENT` is never upgraded to `PASS`; it is visible in every summary so an operator sees what was not proven on this machine. `WARNING` means a documented human decision (owner, provider, hosted) is attached.

## Scorecard

`docs/RELEASE_READINESS_SCORECARD.md` holds the honest percentages per area with evidence and next steps. `F-13` keeps real money BLOCKED.
