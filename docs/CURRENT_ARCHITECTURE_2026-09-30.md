# Siton Current Architecture — 2026-09-30

Status: **BINDING architecture source of truth.** Supersedes `docs/archive/CANONICAL_ARCHITECTURE_V1.md`
(Base44-era, now historical) and every older document that names Base44 as the
production or canonical runtime.

Evidence this page is built from: `render.yaml` at the repository root, the live Render
services, the Supabase project `siton-staging`, `src/schema_contract.ts`, the migration
manifest, `PROJECT_STATUS.md` and the R2–R4 rebase records.

## One answer

Siton runs as **Render web + Render worker + Supabase PostgreSQL**.

| Concern | Authority |
|---|---|
| Code | GitHub `matilederer7-bit/C-ton`, branch `master` |
| Web runtime | Render web service `siton-staging-web` (`srv-daa5o9u7bikc73fgjskg`), Docker image from the root `Dockerfile`, Fastify app in `src/` |
| Background worker | Render background worker `siton-staging-worker` (`srv-daakn0tg1s2s73dfk3pg`), same image, `node .demo_dist/src/worker.js` |
| Database, Auth, Storage | Supabase project `siton-staging` (`hnptacfzuqebfgeshadq`, eu-central-1); schema `siton`, migrations under `src/migrations/`, grants under `supabase/staging/` |
| Deploy trigger | `autoDeployTrigger: checksPass` on `master` for both services; CI (`.github/workflows/ci.yml`, `ci-verdict`) is the merge gate |
| Frontend | React app in `web/` served at `/preview/` (the bare domain redirects there); the legacy `frontend/` shell remains at `/app` for direct links until it is retired in its own change |
| Payments | Provider adapters in `src/`; every checked-in target runs the mock provider; real money blocked by policy |
| Error monitoring | Sentry `c-ton/siton-staging` |

The two services above are the **only** canonical Render services. Anything else in the
Render workspace is legacy (see the Render cleanup record in `PROJECT_STATUS.md`).

## What is not a runtime

- **Base44** is historical. It is not a production or staging runtime, no request or
  worker path depends on it, and `tests/legacy_runtime_isolation_validation.ts` asserts
  `src/` never references it. `scripts/architecture_truth_gate.cjs` asserts this
  page's runtime (Render web + Render worker + Supabase PostgreSQL) and rejects any
  blueprint, inventory boundary or architecture document that names Base44 again
  (Lean Refactor D3-A; `tests/release_tools/architecture_truth_gate.test.cjs` proves
  every assertion by mutation); the gate also rejects a Base44 SDK call in any code
  tree and the Base44 token in the runtime, shell, scripts, web, workflow and root
  build files. The `base44/` directory, `config/base44-*.json`,
  `scripts/base44_canonical_integrity_gate.cjs`, the Base44-only tests and
  `legacy/render/` were deleted by Lean Refactor D3-B (2026-10-01).
- **`legacy/render/`** (pre-R3 Render evidence) was deleted by Lean Refactor D3-B; the root `render.yaml` is the only Render blueprint.
- **Docker Compose / local PostgreSQL** are the local and CI harness, not a deployment.

## Non-negotiable runtime boundaries

- The web runtime connects as `siton_web_login` and adopts `siton_web_runtime`; the worker
  as `siton_worker_login` → `siton_worker_runtime`. Neither is a superuser and neither is
  `anon`, `authenticated` or `service_role`.
- `anon` and `authenticated` have no USAGE on schema `siton`.
- Applied migrations are never edited. Schema changes are forward migrations with a
  manifest entry and a `REQUIRED_MIGRATION_IDS` entry.
- `/readiness` is the health check and fails closed on schema, role or contract drift.
- Secrets live only in Render and Supabase configuration, never in Git.

## Where to look next

- Product rules: `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md`
- Agent rules: `AGENTS.md`, `AI_WORKFLOW.md`, `docs/CLAUDE_TEAM_LEAD.md`
- CI: `docs/CI_TEST_STRATEGY.md`
- Operations: `docs/DEPLOYMENT_RUNBOOK.md`, `docs/CONFIG_INVENTORY.md`, the incident runbooks
- Document tiers: `docs/DOCUMENTATION_MAP.md`
