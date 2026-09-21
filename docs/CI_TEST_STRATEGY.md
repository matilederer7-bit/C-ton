# CI test strategy

Goal: retain every safety proof, stage work so a pull request gets a fast, complete answer, and keep the canonical backend workflow exactly as it went green on master (PR #12, PR #13). The release-readiness workflow is ADDITIVE: it never replaces or weakens a backend gate.

## Canonical entry points

- Full merge gate: `npm run verify:full`. This is the single normal entry
  point for meaningful changes. It runs static release checks, isolated
  migrations, behavioural route authorization and the complete grouped suite.
- Release gate: `npm run verify:release`. Run this before a deploy candidate.
  It executes the full release-preflight profile, including the dedicated
  security, payment, concurrency, failure, migration and release proofs.

Subsystem commands remain available for focused development and diagnosis.
They are not competing definitions of a complete pass. A developer should not
assemble an ad-hoc release gate from the long script list in `package.json`.

Sources of truth: GitHub = code; Render = web/backend/worker staging runtime; Supabase = canonical PostgreSQL/Auth/infra; Grow = payment provider boundary, currently disabled (mock provider on every checked-in target). Base44 is an excluded legacy surface guarded by the canonical-integrity gate; it is never the business runtime.

## Workflows and what runs where

| Stage | Workflow / job | Runs on | Content | Approx. wall-clock |
|---|---|---|---|---|
| PR fast gates | `release-readiness.yml` / `preflight-static` | every PR, push, dispatch | TypeScript, enforcement scans, semantic raw-card scan, DDL scan, money/tax canon, legal, Base44 canonical-integrity (exclusion) gate, secret/PII scan, logging hygiene, runtime environment policy, startup failure matrix, no-real-money proof, route inventory, migration manifest analysis, demo build, mobile/PWA contract, repository hygiene, supply chain, Docker static | ~5 min |
| PR heavyweight gates | `backend-quality-gates.yml` / `backend-gates` (unchanged) | every PR, push | the ten test groups on fresh databases, `ci:migrations`, route authorization gate (static + behavioural), fault report, **and the complete repository suite (`test:all`)** as the order/isolation regression signal | ~60-75 min |
| PR heavyweight gates | `release-readiness.yml` / `preflight-database` | every PR, push, dispatch | migration preflight (10 scenarios on disposable databases), backup/restore rehearsal, health contract, HTTP security smoke, reproducible build, release-tool tests | ~15 min |
| PR heavyweight gates | `web-runtime-depth.yml` / `web-runtime-core` (unchanged) | every PR, push | route/frontend contract, real-HTTP auth + core E2E in Docker | ~20 min |
| Same-repo PR + master | `backend-quality-gates.yml` Docker smoke; `release-readiness.yml` / `docker-release-lab`; `web-runtime-depth.yml` / `web-runtime-resilience` | same-repository PRs, push, dispatch | image build + start + migrate + smoke + worker + graceful stop (lab); MinIO + two web instances + outbox faults (smoke); load/outage/restart (resilience) | ~15-30 min each |
| Scheduled / deep QA | none yet | - | see "Recommended additions" | - |

## What was deliberately NOT changed

The release-readiness night branch (`claude/release-readiness-night`, 63a108f) proposed making the `test:all` step post-merge-only to save PR wall-clock. That change was **discarded** during reintegration: the owner counts "Complete repository suite: PASS" as a PR gate, PR #13 went green with it, and the probabilistic F4 confidentiality regex (fixed in PR #12) was exactly the kind of order/frequency defect the second run surfaces. The canonical backend workflow is byte-identical to master.

## Duplication that is intentional

- `scripts/web_route_inventory.cjs` runs in `web-runtime-depth` (`web:routes`), in `backend-gates` (inside the route authorization gate) and in `preflight-static` (`route-inventory`). It takes ~2 s and produces the artefact each consumer reads.
- TypeScript compiles in `backend-gates` and in `preflight-static`; both jobs must stand alone for a green/red answer.
- The payment and security groups run in `backend-gates` on every PR; `release:preflight --profile full` runs them again locally on demand. `preflight-database` skips the route authorization behavioural suites and the Docker lab (`--skip route-authorization-behavioural,release-local-lab`) because `backend-gates` and `docker-release-lab` already carry them.

## Local equivalents

| CI stage | Local command |
|---|---|
| PR fast gates | `npm run release:preflight:static` |
| PR heavyweight (release) | `npm run release:preflight` (standard profile; Docker lab SKIPPED_ENVIRONMENT without an engine) |
| PR heavyweight (groups) | `npm run test:payments`, `npm run test:security`, ... or `npm run release:preflight:full` |
| complete suite | `npm run test:all` (never concurrently with another runner on the same `DATABASE_URL`) |
| owner | `npm run release:owner-check` |

The preflight reports four buckets: PASS (WARNING = pass with a documented human decision), FAIL, BLOCKED (governance: real-money activation under `config/real-money-release-policy.json`; environment: a gate that cannot run on this machine) and NOT_APPLICABLE (gates outside the profile / `--only` / `--skip`). `TECHNICAL_READINESS` and `REAL_MONEY_ACTIVATION` are printed separately and never combined.

Never run two test runners at the same time against one `DATABASE_URL` (`docs/PARALLEL_AGENT_DEVELOPMENT.md`); `npm run qa:diagnose` shows leaked runners, connections and stale databases.

## Recommended additions (not implemented here)

1. A nightly `workflow_dispatch`/`schedule` job running `release:preflight:full` plus `ci:web-runtime:extended`, so PRs never wait for the slowest proofs twice.
2. Cache `.tmp_test_dist` compilation between the ten group steps (each currently recompiles).
3. If PR wall-clock becomes a problem, move `test:all` to a post-merge job only with the owner's explicit decision, and only after the second run has stayed green for a sustained period.
