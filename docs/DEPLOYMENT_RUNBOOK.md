# Deployment Runbook — Siton (C-ton)

Status legend used below: **IMPLEMENTED** = exists in this repository and was read to write the line; **EXPECTED** = hosted-platform behaviour or a branch/workflow that is not verifiable from the checkout; **OPEN** = an owner/provider decision that no gate can close. Anything that touches Render, Supabase or Grow is a **hosted action — document only, not executed**.

Grounding baseline: originally worktree `claude/release-readiness-night` on top of `origin/master` `82c91d6`; re-grounded on master `0e53998` on 2026-09-15 (R9C migrations 067/068 on master and on staging, hardened UX merged). Reintegrated onto current master `0e53998` (PR #9 financial rails, PR #12 confidentiality proof, PR #13 hardened UX already merged) on 2026-09-15 as a controlled port of `claude/release-readiness-night` 63a108f; every reference below was re-verified against that master. Architecture: GitHub = code source of truth; Render = web/backend/worker staging runtime; Supabase = canonical PostgreSQL/Auth/infra; Grow = payment provider boundary, currently disabled; Base44 is never the business runtime. Render services: `siton-staging-web` (web) and `siton-staging-worker` (worker), both built from the same `Dockerfile`, both `autoDeploy: true` from `branch: master` (`render.yaml:15-23`, `render.yaml:71-79`).

---

## 0. Three actions that are never one step

```
+====================================================================================+
|  WARNING — "DEPLOYING CODE" NEVER MEANS "ENABLING REAL MONEY"                       |
|                                                                                    |
|  1. CODE DEPLOY        push to master -> Render builds the image -> new process.   |
|                        Money stays PAYMENT_PROVIDER=mockpay (render.yaml:54-59).   |
|  2. DATABASE MIGRATION separate, manual, forward-only. Render runs NO migration    |
|                        step: Dockerfile CMD is `npm run start:web:prod` =          |
|                        `node .demo_dist/src/app.js` (Dockerfile:43, package.json)   |
|                        and render.yaml has no preDeployCommand / buildCommand.     |
|  3. REAL-MONEY         requires ALL THREE, in order, none implied by 1 or 2:        |
|     ACTIVATION         (a) config/real-money-release-policy.json flipped to        |
|                            real_money_allowed:true / status:ALLOWED in a           |
|                            second-person-reviewed commit, every blocking_reasons   |
|                            entry cleared WITH evidence (how_to_change steps 1-3);  |
|                        (b) production env vars set in the hosting console          |
|                            AFTERWARDS (PAYMENT_PROVIDER=grow,                       |
|                            PAYMENT_ENVIRONMENT=live, credentials) - step 4;        |
|                        (c) src/production_guards.ts accepting the configuration    |
|                            at boot (assertProductionRuntimeGuards, called from     |
|                            startApplication() src/app.ts:5786).                    |
|                        Today the policy is BLOCKED with 4 uncleared reasons and     |
|                        every release command prints REAL_MONEY: BLOCKED.           |
+====================================================================================+
```

Why the guard cannot be bypassed by a deploy: `config/runtime-environment-policy.json` production rule `PAYMENT_ENVIRONMENT not_equal live` is `governed_by: real-money-release-policy`; `scripts/proof_no_real_money.cjs` fails the release when any checked-in target (render.yaml, compose files, Dockerfile, .env examples, workflows) selects `PAYMENT_ENVIRONMENT=live`, a live Grow host, or live credentials, and re-executes `src/production_guards.ts` to prove it still refuses live outside production and mock inside production. IMPLEMENTED.

| Action | Trigger | Who | Reversible by |
|---|---|---|---|
| CODE DEPLOY | merge to `master` (autoDeploy) | GitHub + Render | Render "previous deploy" (hosted) — see `docs/ROLLBACK_RUNBOOK.md` |
| DATABASE MIGRATION | operator runs it explicitly | operator with DB access | never (forward-only; new forward migration) |
| REAL-MONEY ACTIVATION | reviewed governance commit + console env | owner + second reviewer | env revert + governance revert |

---

## 1. Stage: pre-merge (on the feature branch, local)

1. Clean tree, correct base: `git status --short` empty; `git merge-base --is-ancestor origin/master HEAD` exits 0.
2. Run the canonical preflight. Profiles (`config/release-preflight-gates.json`): `static` (no DB/Docker), `standard` (static + local DB gates + Docker lab when available), `full` (standard + payment and security test groups).
   ```
   npm run release:preflight -- --profile standard      # or release:preflight:full
   ```
   Expected tail (`scripts/release_preflight.cjs:127-135`):
   ```
   CATEGORY SUMMARY
     CODE         PASS ...
     ACTIVATION   BLOCKED           real-money-activation:B
   VERDICT BUCKETS
     PASS / FAIL / BLOCKED (governance + environment) / NOT_APPLICABLE
   TECHNICAL_READINESS: PASS (...)
   REAL_MONEY_ACTIVATION: BLOCKED
   REAL_MONEY: BLOCKED
     - F13_PROVIDER_CONTRACT_UNRESOLVED
     - GROW_LIVE_VERIFICATION_NOT_PERFORMED
     - PRODUCTION_PAYMENT_ACTIVATION_NOT_APPROVED
     - ADVERSARIAL_REVIEW_NOT_PERFORMED
   RELEASE_PREFLIGHT_RESULT technical=PASS real_money_activation=BLOCKED overall=PASS report=.release-artifacts/release-preflight.md logs=.release-artifacts/preflight/
   RELEASE_PREFLIGHT_PASS
   ```
   `SKIPPED_ENVIRONMENT` is never PASS; `WARNING` needs a human decision; `BLOCKED` on `real-money-activation` is the intended governance state and never counts against technical readiness; `NOT_APPLICABLE` lists the catalogue gates outside the profile; exit code is non-zero only on FAIL.
3. Migration-specific gates when `src/migrations/` or `scripts/migration_manifest.cjs` changed:
   ```
   npm run migrations:preflight          # fresh / upgrade-from-origin-master / partial / CRLF / drift / dirty / atomic / schema-drift scenarios on disposable DBs
   npm run db:backup-restore-rehearsal   # pg_dump + pg_restore on a disposable DB; SKIPPED_ENVIRONMENT without pg tools
   ```
   Markers: `MIGRATION_PREFLIGHT` lines and the report in `.release-artifacts/`.
4. One-line owner answer (runs preflight, manifest and checklist):
   ```
   npm run release:owner-check            # add -- --reuse to re-read the latest report for this SHA
   ```
   Expected: `READY FOR CODE DEPLOY: YES (preflight PASS, profile standard)` and `READY FOR REAL MONEY: NO`, then `RELEASE_OWNER_CHECK code_deploy=YES real_money=NO ...` (`scripts/release_owner_check.cjs:58-84`). `Staging deployment: NOT CHECKED (hosted; see docs/DEPLOYMENT_RUNBOOK.md)` is printed by design.
5. Hygiene before pushing: `npm run qa:diagnose` prints `QA_DIAGNOSE_CLEAN` (no occupied test ports, no stray runners, no leaked test-DB connections).

## 2. Stage: PR CI

| Workflow | Trigger | Proves | Status |
|---|---|---|---|
| `.github/workflows/backend-quality-gates.yml` | PR + push to master | tsc, enforcement scans, payment/raw-card scan, runtime-DDL scan, architecture gate, mobile/PWA gate, `ci:migrations` (`CI_MIGRATION_REPORT_PASS`), test groups unit → e2e, route-authorization gate, fault report; `test:all` and `ci:docker-smoke` only on push / same-repo PR (`:139-145`) | IMPLEMENTED |
| `.github/workflows/web-runtime-depth.yml` | PR + push to master | `web:routes` contract, `ci:web-runtime` (real HTTP auth, core E2E, Docker runtime), `ci:web-runtime:extended` (load, outage, restart, multi-instance) | IMPLEMENTED |
| `.github/workflows/release-readiness.yml` | PR + push to master + dispatch | `preflight-static` (`npm run release:preflight:static`), `preflight-database` (standard profile on a Postgres service, skipping `route-authorization-behavioural,release-local-lab`), `docker-release-lab` (`npm run release:local-lab`, same-repo PRs only) | IMPLEMENTED on this branch (committed in `bf0ef55`); EXPECTED on `master` until the branch is merged |

Merge rule: all three green on the PR head SHA. A red `Security tests` or `API tests` step has been a real bug both times it happened (PROJECT_STATUS.md history) — never merge on "CI-only flake".

## 3. Stage: merge

1. Merge via PR into `master` (fast-forward or merge commit; both trigger autoDeploy).
2. If the commit must NOT redeploy (docs/status only), put `[skip render]` in the commit message — used on `82c91d6` so the status push did not replace the approved application SHA (`docs/STAGING_ACCEPTANCE_2026-09-10.md:53`). EXPECTED (Render feature).
3. Record the merge SHA; it is the only identity the rest of this runbook uses.

## 4. Stage: build

1. Render builds `Dockerfile` for both services: `npm ci` → `npm run build:demo` (→ `.demo_dist`) → `cd web && npm ci --include=dev && npm run build` (→ `web/dist`, served same-origin under `/preview`) → non-root `appuser` (`Dockerfile:5-36`). The frontend is baked into the image; there is no separate frontend deploy. IMPLEMENTED.
2. `.dockerignore` excludes `.env*`, `docs`, `.worktrees`, `.release-artifacts` (`.dockerignore:3-6,49,64-65`); the Dockerfile additionally deletes any surviving `.env` file (`Dockerfile:15`).
3. Local equivalents: `npm run check:docker-static` (`DOCKER_READINESS_*`), `npm run check:reproducible-build` (`REPRODUCIBLE_BUILD_PASS`), `npm run release:local-lab` (`RELEASE_LOCAL_LAB_PASS`: image build, Postgres, migrate job, web + worker healthy, HTTP smoke, worker heartbeat, graceful stop exit 0, `down -v`).
4. Optional hosted-image identity: `npm run release:manifest -- --image <ref>` writes `.release-artifacts/release-manifest.{json,md}` with SHA, migration high-water + LF checksums and build tree hashes.

## 5. Stage: database migration (separate action)

Facts that shape this stage (all IMPLEMENTED unless marked):

- Runner: `npm run db:migrate` = `scripts/run_migrations.cjs`. Ledger `siton.migration_ledger` (`:33-44`); refuses a dirty ledger (`:53-58`); checksum classes `match` / `eol-variant` (accepted, `MIGRATION_LEDGER_EOL_VARIANT`) / `mismatch` (refused, `:82-92`); each file runs inside one `client.query(sql)`, the row is marked `failed` on error (`:112-120`). Forward-only: no `down` mechanism exists (`grep -rniE "\bdown\b|rollback" scripts/run_migrations.cjs scripts/migrations_*.cjs` finds only the error-path `ROLLBACK`).
- Manifest: `scripts/migration_manifest.cjs` is an append-only ordered list; position = array index + 1. Master holds 061 migrations with high-water 068: ids 062-064 were reserved by parallel branches and never landed, 065/066 landed first, and the R9C financial migrations 067/068 (PR #9) append after them (manifest comment). Ledger positions stay contiguous (067 @ 60, 068 @ 61).
- Nothing on Render runs migrations: web CMD is `start:web:prod`, worker `dockerCommand: npm run start:worker:prod`; the worker waits (bounded) for a migrated schema (`src/worker.ts:95-104`, `worker_waiting_for_migrated_database`).
- Order of operations is **schema first, then code**: readiness requires every `REQUIRED_TABLES` entry (`src/schema_contract.ts:21-35,72-76`). On 2026-09-10 the automatic deploy `dep-dah89onavr4c73e6skng` failed its health check because `content_assets`/`site_content` (066) were missing, and the old build stayed live (`docs/STAGING_ACCEPTANCE_2026-09-10.md:44`). That is the safe failure, not an accident to avoid.
- How staging migrations were actually applied: no direct staging DB credential is held locally; 065, 066 and later 067/068 (2026-09-14, ledger 61/61 verified, paired grants `supabase/staging/024`) were applied by the owner as the unmodified SQL plus the ledger `INSERT` (canonical LF checksum) transported through Supabase MCP `apply_migration`, DDL and ledger row in one transaction (`docs/PILOT_LAUNCH_RUNBOOK.md:22-42`, `docs/STAGING_ACCEPTANCE_2026-09-10.md:22-28`). Hosted tables also need the separate least-privilege grants in `supabase/staging/NNN_*.sql` (`023_receipt_content_grants.sql` repaired a deploy that migrated but could not read its own tables, `:31-38`).

Steps:

1. Diagnose before touching anything (read-only; hosted host requires `--allow-hosted`, still SELECT only):
   ```
   DATABASE_URL=<target> npm run migrations:doctor -- --allow-hosted
   ```
   Expected before applying: `MIGRATIONS_DOCTOR verdict=BEHIND` with `missing (not yet applied): 0NN`. `BLOCKED` (real content mismatch, dirty row, extra/duplicate/ordering) stops the release; `HEALTHY_WITH_EOL_VARIANTS` is acceptable (`scripts/migrations_doctor.cjs:88-93`).
2. Confirm the ledger row that will be written: id, position (= manifest position), filename, canonical checksum from `npm run release:manifest` (migration high-water + LF checksums).
3. Apply — hosted action, document only, not executed:
   - Preferred when a least-privilege migration credential exists: `DATABASE_URL=<migration-role url> npm run db:migrate` → `MIGRATION_OK 0NN <file>` … `MIGRATIONS_COMPLETE count=<manifest length>`.
   - Established staging path (no local credential): unmodified file SQL + ledger `INSERT` in ONE transaction via Supabase MCP `apply_migration`, then the matching `supabase/staging/NNN_*_grants.sql`.
4. Verify: rerun the doctor → `MIGRATIONS_DOCTOR verdict=HEALTHY` (or `HEALTHY_WITH_EOL_VARIANTS`), `missing: none`, `dirty rows: none`. A rerun of the runner is a no-op (`ci:migrations` proves rerun idempotency in CI).
5. Grants check for new tables: query `has_table_privilege('siton_web_runtime', 'siton.<table>', 'SELECT')` (pattern in `supabase/staging/verify_receipt_content.sql`). Missing grants show up as 42501 in `/readiness` or as route 500s after deploy.

## 6. Stage: deploy (code)

1. Render autoDeploys both services from the merge SHA (`autoDeploy: true`). Hosted action — document only. EXPECTED: Render builds, starts the new container, polls `healthCheckPath: /readiness` (`render.yaml:22`) and swaps traffic only on 200; the worker has no health check path (Render workers are not HTTP) and restarts on exit.
2. Watch the boot line. Web boot = `assertProductionRuntimeGuards("web")` then `assertCanonicalRuntimeReady(pool,"web")` then `listen` (`src/app.ts:5785-5788`). A guard failure prints a `production runtime guard failed: …` / `external storage runtime guard failed: …` message and exits — that is the runtime part of the three-action rule.
3. If the deploy fails health, the previous build stays live (observed 2026-09-10). Go to `docs/ROLLBACK_RUNBOOK.md` §2 only if the *new* build went live and misbehaves.

## 7. Stage: health

What each signal proves (`scripts/health_contract_check.cjs:1-23`, `docs/HEALTH_CHECK_CONTRACT.md`, proven locally by `npm run check:health-contract` → `HEALTH_CONTRACT_PASS`):

| Probe | Code | Proves | Does NOT prove |
|---|---|---|---|
| `GET /health` → `200 {"ok":true}` | `src/app.ts:3570` | HTTP listener alive | DB, schema, provider, worker (stays 200 with the DB dropped) |
| `GET /readiness` → `200 {ok,database:"connected",schema:"siton",boundary,…}` | `src/app.ts:3572-3578` → `src/runtime_database_boundary.ts:14-44` | ledger complete, required tables/triggers present, connected as `siton_web_runtime` (never postgres/service_role), inventory RPC `siton_inventory_rpc` v1 | worker liveness (documented gap) |
| `GET /health/integrations` | `src/frontend_runtime.ts:1538-1558` | `integrations.payment.provider=mockpay`, mode `mock-backed`, payout `internal-ledger`, notifications `log-only`; no secret echoed | correctness of money flows |
| `GET /api/preview/meta` → `preview.deployment.runtime_commit_sha` | `src/frontend_runtime.ts:1029-1052,2166-2181` | which SHA is running (`RENDER_GIT_COMMIT`); `is_stale` only when `EXPECTED_COMMIT_SHA` is set (OPEN: not set on staging today, policy WARNING) | — |

Commands (replace host):
```
curl -s https://siton-staging-web.onrender.com/health
curl -s https://siton-staging-web.onrender.com/readiness
curl -s https://siton-staging-web.onrender.com/health/integrations
curl -s https://siton-staging-web.onrender.com/api/preview/meta | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).preview.deployment))"
```
Pass = `/readiness` 200 AND `runtime_commit_sha` equals the merge SHA AND `payment.provider` is `mockpay`.

## 8. Stage: smoke (HTTP, no browser)

1. `npm run smoke:http-security` locally against the same SHA → `HTTP_SECURITY_SMOKE_PASS` (content types, no-store on dynamic routes, security headers, request-id, no stack leak, no foreign CORS, `/debug/*` 404, anonymous admin refused).
2. Hosted (read-only, prints no secrets): `node scripts/r3_hosted_proof.cjs --base-url=https://<service>.onrender.com`.
3. Hosted API journey (creates ONE synthetic deal under the owner's seller account; mock authorization only):
   ```
   node scripts/pilot_readiness_proof.cjs --base-url=https://siton-staging-web.onrender.com --email=<owner> --password=<pw> --keep
   ```
   Expected: PASS per step (`docs/PILOT_LAUNCH_RUNBOOK.md:44-50`).

## 9. Stage: worker verification

1. Worker readiness lives in the database, not HTTP: `siton.worker_heartbeats` row with `status='ready'` and fresh `heartbeat_at` (`src/worker.ts:34-41,106-112`; default cadence `WORKER_HEARTBEAT_MS=10000`). Query (hosted action via an admin read path or MCP, document only):
   ```sql
   SELECT worker_id, status, heartbeat_at, now()-heartbeat_at AS age FROM siton.worker_heartbeats ORDER BY heartbeat_at DESC;
   SELECT COUNT(*) FILTER (WHERE status='pending') AS pending, COUNT(*) FILTER (WHERE status='processing') AS processing,
          (SELECT COUNT(*) FROM siton.outbox_dlq) AS dlq FROM siton.outbox_events;
   ```
   Pass = one `ready` row younger than ~3× heartbeat, `processing` not growing, DLQ unchanged.
2. Role separation: the worker connects as `siton_worker_login` → `siton_worker_runtime`; `RUNTIME_ROLE=worker` mismatch fails closed at boot (`src/production_guards.ts:102-103`). The web service has `DISABLE_OUTBOX_WORKER=1` and the worker deliberately has none (`render.yaml:31-32`; worker block `render.yaml:69-70,80-112` carries no such key).
3. Admin view: `/api/admin/mission-control` (x-admin-key) reports outbox worker enabled/disabled and `commit_sha` (`src/admin_mission_control.ts:2023-2025,2081-2092`).

## 10. Stage: browser verification

| Proof | Target | Note |
|---|---|---|
| `scripts/r7r8_browser_proof.cjs --base-url=https://…` | hosted | images render from Supabase Storage, RTL, admin login screen |
| `scripts/r6_hosted_browser_proof.cjs` | hosted | assumes Mall ON and old selectors — returned 1/5 on 2026-09-10; do not treat its failures as regressions (`docs/STAGING_ACCEPTANCE_2026-09-10.md:78`) |
| `scripts/launch_polish_browser_proof.cjs`, `buyer_polish_browser_proof.cjs`, `pickup_fulfillment_browser_proof.cjs`, `p0_browser_proof.cjs` | LOCAL demo-preview runtime only (headless Edge CDP; need raised `RATE_LIMIT_*`) | run on the merge SHA before the hosted pass |

Manual minimum on the hosted preview at 390 and 1440: landing renders (no horizontal overflow), one public deal opens, seller login gate, hidden admin gate (two taps). OPEN: hosted authenticated seller/admin screens are proven only by API, not browser (same doc, `:80`).

## 11. Stage: rollback decision

Decide within the first 15 minutes after traffic swap, using only the signals above:

| Observation | Decision |
|---|---|
| `/readiness` 503 on the new build | Render never swapped; fix forward (usually a missing migration or grant). No rollback. |
| `/readiness` 200 but `/health/integrations` shows a provider other than `mockpay` | STOP. Env drift — treat as a money incident (`docs/OPERATIONS_MONEY_INCIDENT_RUNBOOK.md`), roll back code and env. |
| Worker heartbeat stale > 60 s, `processing` rising | worker rollback / restart (`docs/ROLLBACK_RUNBOOK.md` §4); web can stay. |
| Frontend broken, API fine | code rollback (`ROLLBACK_RUNBOOK.md` §2); frontend has no separate deploy. |
| Migration applied, code rolled back | acceptable when the migration was additive (all recent ones are); never roll the schema back (`ROLLBACK_RUNBOOK.md` §5-6). |

Record the decision, SHA, deploy id and timestamps in `PROJECT_STATUS.md` under the branch's own section.

---

## Appendix A — markers cheat sheet

| Command | Success marker |
|---|---|
| `npm run release:preflight` | `RELEASE_PREFLIGHT_PASS` (+ `REAL_MONEY: BLOCKED`) |
| `npm run release:owner-check` | `RELEASE_OWNER_CHECK code_deploy=YES real_money=NO` |
| `npm run release:checklist` | `RELEASE_CHECKLIST proven=… open=…` (OPEN items are never marked done) |
| `npm run migrations:doctor` | `MIGRATIONS_DOCTOR verdict=BEHIND` → apply → `verdict=HEALTHY` |
| `npm run db:migrate` | `MIGRATION_OK …` then `MIGRATIONS_COMPLETE count=N` |
| `npm run migrations:preflight` | report `overall=PASS` (exit 1 on any FAIL) |
| `npm run check:health-contract` | `HEALTH_CONTRACT_PASS` |
| `npm run smoke:http-security` | `HTTP_SECURITY_SMOKE_PASS` |
| `npm run proof:no-real-money` | `NO_REAL_MONEY_PROOF_PASS` + `REAL_MONEY: BLOCKED` |
| `npm run gate:runtime-env` | `RUNTIME_ENVIRONMENT_GATE_PASS` (+ `RUNTIME_GAP OPEN …` lines) |
| `npm run gate:startup-matrix` | `STARTUP_CONFIG_MATRIX_PASS cases=… runtime_gaps=…` |
| `npm run release:local-lab` | `RELEASE_LOCAL_LAB_PASS` (or `_SKIPPED_ENVIRONMENT` without Docker — never PASS) |

## Appendix B — OPEN items this runbook cannot close

- `OTP_HASH_SALT` absent from both Render services (policy WARNING in staging, FAIL in production) — owner console action.
- `EXPECTED_COMMIT_SHA` not set on staging → `is_stale` detection is `unknown`.
- Render Starter plan for the web service and Supabase Site URL (`docs/PILOT_LAUNCH_RUNBOOK.md` 0.3-0.4).
- `docs/DATABASE_INCIDENT_RUNBOOK.md` is referenced by `scripts/migrations_repair.cjs:17` but does not exist; `docs/ROLLBACK_RUNBOOK.md` §5 carries the procedure until it is written.
- Real money: 4 blocking reasons in `config/real-money-release-policy.json`; no gate in this repository can clear them.
