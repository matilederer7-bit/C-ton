# CI test strategy

Goal: retain every safety proof, remove accidental repetition, and stage work so a pull request gets a fast, complete answer while master and scheduled runs carry the deepest checks.

## Workflows and what runs where

| Stage | Workflow / job | Runs on | Content | Approx. wall-clock |
|---|---|---|---|---|
| PR fast gates | `release-readiness.yml` / `preflight-static` | every PR, push, dispatch | TypeScript, enforcement scans, semantic raw-card scan, DDL scan, money/tax canon, legal, Base44 integrity, secret/PII scan, logging hygiene, runtime environment policy, startup failure matrix, no-real-money proof, route inventory, migration manifest analysis, demo build, mobile/PWA contract, repository hygiene, supply chain, Docker static | ~5 min |
| PR heavyweight gates | `backend-quality-gates.yml` / `backend-gates` | every PR, push | the ten test groups on fresh databases, migrations report, route authorization gate (static + behavioural), fault report | ~45-60 min |
| PR heavyweight gates | `release-readiness.yml` / `preflight-database` | every PR, push, dispatch | migration preflight (10 scenarios), backup/restore rehearsal, health contract, HTTP security smoke, reproducible build, release-tool tests (55) | ~15 min |
| PR heavyweight gates | `web-runtime-depth.yml` / `web-runtime-core` | every PR, push | route/frontend contract, real-HTTP auth + core E2E in Docker | ~20 min |
| Same-repo PR + master | `backend-quality-gates.yml` Docker smoke; `release-readiness.yml` / `docker-release-lab`; `web-runtime-depth.yml` / `web-runtime-resilience` | same-repository PRs, push, dispatch | image build + start + migrate + smoke + worker + graceful stop (lab); MinIO + two web instances + outbox faults (smoke); load/outage/restart (resilience) | ~15-30 min each |
| Master post-merge gates | `backend-quality-gates.yml` "Complete repository suite (post-merge deep check)" | push to master, dispatch only (changed on this branch) | `npm run test:all` - every group again in one runner as an order/isolation regression signal | ~45 min |
| Scheduled / deep QA | none yet | - | see "Recommended additions" | - |

## Redundancy removed

| Before | After | Why safe |
|---|---|---|
| PR ran each of the ten groups AND `test:all` (the same ten groups again) | `test:all` only after merge | identical tests on identical code; the second run's only extra signal (order/isolation) is still captured post-merge |

Nothing in payment or security validation was reduced: the payment and security groups still run on every PR in `backend-gates`, the route authorization behavioural suites run there too (and are deliberately skipped in `preflight-database` to avoid a second run), and the Docker smoke keeps its same-repo condition.

## Duplication that is intentional

- `scripts/web_route_inventory.cjs` runs in `web-runtime-depth` (`web:routes`), in `backend-gates` (inside the route authorization gate) and in `preflight-static` (`route-inventory`). It takes ~2 s and produces the artefact each consumer reads.
- TypeScript compiles in `backend-gates` and in `preflight-static`; both jobs must stand alone for a green/red answer.

## Local equivalents

| CI stage | Local command |
|---|---|
| PR fast gates | `npm run release:preflight:static` |
| PR heavyweight (release) | `npm run release:preflight` (standard profile; Docker lab SKIPPED without an engine) |
| PR heavyweight (groups) | `npm run test:payments`, `npm run test:security`, ... or `npm run release:preflight:full` |
| owner | `npm run release:owner-check` |

Never run two test runners at the same time against one `DATABASE_URL` (`docs/PARALLEL_AGENT_DEVELOPMENT.md`); `npm run qa:diagnose` shows leaked runners, connections and stale databases.

## Recommended additions (not implemented here)

1. A nightly `workflow_dispatch`/`schedule` job running `release:preflight:full` plus `ci:web-runtime:extended`, so PRs never wait for the slowest proofs twice.
2. Cache `.tmp_test_dist` compilation between the ten group steps (each currently recompiles).
3. When the financial branch lands, move its lab suites (`tests/lab`) into the scheduled deep QA job rather than the PR path if their wall-clock exceeds ~15 minutes.
