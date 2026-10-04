# CI test strategy

Goal: every safety proof is kept, and each change pays only for the proofs it needs. Independent proofs run in parallel, so the wall-clock answer on a pull request is short. Nothing is deleted, no assertion is weakened, and no blocking gate becomes advisory.

Sources of truth: GitHub = code; Render = web/backend/worker staging runtime; Supabase = canonical PostgreSQL/Auth/infra; Grow = payment provider boundary, currently disabled (mock provider on every checked-in target). Base44 is history, never the business runtime: `scripts/architecture_truth_gate.cjs` asserts the Render web + Render worker + Supabase runtime and rejects any Base44 reference in the blueprint or the inventory boundary.

## One pipeline: `.github/workflows/ci.yml` ("Siton CI")

It replaces `backend-quality-gates.yml`, `release-readiness.yml` and `web-runtime-depth.yml` (2026-09-28, PR #126). `mobile-readiness.yml` stays a separate, path-filtered, advisory workflow.

```
classify ──┬─ static-gates                      (every profile)
           ├─ tests (10 lanes, parallel)        (STANDARD, FULL)
           ├─ focused-tests                     (FAST: release-tool tests + focused tests)
           ├─ web-runtime-core                  (STANDARD, FULL)
           ├─ web-runtime-resilience            (STANDARD, FULL)
           ├─ docker-smoke                      (STANDARD, FULL)
           ├─ docker-release-lab                (STANDARD, FULL)
           └─ preflight-database                (STANDARD, FULL)
                         └──────────────► ci-verdict   (always; the single required check)
```

`static-gates` does not wait for `classify`. Docker jobs run only for same-repository branches, as before: fork PRs cannot run compose with published ports safely.

### Profiles

| Profile | Level | Typical change | What runs |
|---|---|---|---|
| FAST | trivial, low | docs/prose, copy-only edits of the three bilingual copy sources, stylesheets or raster images only (never SVG); at most 25 files and 300 changed non-doc lines | `static-gates` + `focused-tests`: **all** release-tool tests (they read the canonical docs, AGENTS.md, CLAUDE.md and PROJECT_STATUS.md), the `tests/*.ts` files that name a changed path or assert removed copy, and the browser/i18n/brand suites for visual or copy changes |
| STANDARD | normal | ordinary frontend/backend change (`src/**`, `web/src/**`, tests of non-critical groups, mobile shell, assets, plain SVG) | every lane FULL runs. No lane can be proven irrelevant to a functional change: the backend imports `web/src` modules, and the Docker image, the reproducible build and the HTTP smoke all bundle or serve `web/` and `frontend/`. STANDARD differs from FULL in the review it needs (no senior reviewer), not in CI coverage. |
| FULL | high, critical | DB/migrations/supabase, money, auth/security, state machine, worker/outbox, CI, dependencies, Docker/Render/tsconfig/config, native mobile security configuration (manifest, network security config, entitlements, Info.plist, Gradle), active SVG (script, event handlers, `javascript:`, foreignObject), shared test helpers, tests in the payments/security/db/concurrency/failure groups, deleted or renamed tests, special file modes, cross-cutting (>25 source files), **anything unclassified**, every push to `master`, the nightly run, manual runs | everything; nothing is skipped |

### How the classifier decides (`scripts/ci_change_classifier.cjs`)

1. **Paths.** An ordered allowlist of rules gives each changed file a level. A file that no rule matches is critical ("unclassified"). The risk families are those of `scripts/team_plan_check.cjs`: database, money, security, state-machine and ci-gates.
2. **Change kind and parsing.** Renames count as the riskier of their two ends. A deleted or renamed test is critical. Tests are placed in groups with the same `classify()` that `run_test_group.cjs` uses, and a test in a money, security, db, concurrency or failure group is critical. A symlink, a submodule, a file-type change or a new executable bit is critical. Diffs are read with `-z`, `core.quotePath=false` and forced `a/`/`b/` prefixes. Parsing is hunk-aware, so a removed `-- ` SQL comment or an added `++ ` line cannot end a file's content early. It fails closed: when the lines collected for a text file do not match git's own numstat, the file is critical.
3. **Changed lines.** Code files are checked on both the added and the removed lines. Any line with destructive SQL, transaction or locking vocabulary, money vocabulary, credential/session vocabulary, or destructive filesystem calls makes the file critical. Deleting a `FOR UPDATE` is as critical as adding one.
4. **Size.** Beyond the FAST limits, a trivial or low change becomes STANDARD.
5. **Proposal.** The team lead may propose a profile, either as a PR label (`ci:fast`, `ci:standard`, `ci:full`) or as a `CI-Profile: FAST` line in the PR body. A proposal can only escalate. A proposal below the computed profile is rejected: the lanes still run at the computed profile, and `ci-verdict` fails until the proposal is removed or raised.
6. **Unreadable diff.** If the diff cannot be read, the profile is FULL.

The unit tests are in `tests/release_tools/ci_change_classifier.test.cjs`. They include negative cases, each of which must still come out FULL:

- a docs file renamed into a migration, and a migration renamed into docs;
- a one-line `refund` or `FOR UPDATE` edit in an ordinary module;
- a deleted test, or a weakened payments test;
- a copy dictionary with a structural line;
- a symlink in `docs/`;
- a `FAST` proposal on a payment change.

Preview locally: `node scripts/ci_change_classifier.cjs --base origin/master --head HEAD`.

### The verdict (`scripts/ci_verdict.cjs`)

`ci-verdict` runs with `if: always()` and is red unless all of the following hold:

- `classify` succeeded, and no profile proposal was rejected;
- every job the profile requires ended in `success`;
- every `skipped` job is either one the classifier declared skipped (the reason is shown in the job summary) or a Docker job on a fork PR;
- **coverage is proven from the test manifests**, which each lane writes through `TEST_RESULTS_FILE`:
  - in STANDARD and FULL, every file of the current `tests/*.ts` inventory ran exactly once and passed; no file can be lost by sharding or lane packing;
  - in FAST, exactly the focused files ran and passed.

Branch protection on `master` is currently **off** (checked through the API on 2026-09-28). When it is enabled, require the single check **`ci-verdict`**. Render's `checksPass` deploy gate waits for all checks, and on `master` every push is FULL.

## Test lanes

Each test file still runs in its own fresh database, cloned from a migrated template, exactly as before. Lanes are packed from measured step times: CI run 36463288440 for whole groups, and a local run for the per-file durations used to balance shards.

| Lane | Groups | Extras |
|---|---|---|
| unit-db-workers | unit, db, workers | `ci:migrations` (clean migrations, rerun, schema report) |
| integration-failure | integration, failure | `ci:fault-report` |
| api | api | |
| payments | payments | |
| security-1of2, security-2of2 | security (sharded) | `ci:route-authorization` in shard 1 |
| concurrency | concurrency | |
| e2e-1of3 … e2e-3of3 | e2e (sharded) | bilingual screenshots uploaded per lane |

`TEST_SHARD=k/n` deals files longest-first onto the least-loaded shard, using `scripts/ci_test_durations.json`. The split is disjoint, complete and deterministic; tests enforce this, and the verdict re-checks it from the manifests. The durations file only balances the shards; it never selects or skips a test.

Every test lane builds `.demo_dist`, `web/dist` and `.mobile_dist` from its own checkout (`.github/actions/siton-setup`, `build: "true"`). This is the filesystem state the former single job had before its test steps: the browser suites need `web/dist`, the mobile readiness test needs `.mobile_dist`, and the long-horizon smoke reads `.demo_dist`. No build output is shared between jobs, so no job can see another's state. The npm download cache (`setup-node` `cache: npm`, keyed on both lockfiles) is the only cache, and it is content-addressed and safe.

## Duplicated work that was removed

| Duplication | Before | After |
|---|---|---|
| Static preflight gates (tsc, enforcement scan, architecture, payment scan, runtime DDL, demo build, mobile/PWA gate, …) | up to 3× per PR: the backend job, `preflight-static`, and again inside `preflight-database` (standard profile includes the static gates) | once, in `static-gates` (`release:preflight:static`) |
| `npm run lint` + `npm run scan:backend` | both, and they are the same script (`backend_enforcement_scan.cjs`) | once (inside the static preflight) |
| `test:all` on every push to `master` | re-ran the ten groups (15m00s) right after the same ten groups had passed in the same job | removed from the merge path; the whole pipeline runs FULL nightly (`schedule`), which keeps the order and frequency repetition signal |
| `web-runtime-resilience` waited for `web-runtime-core` | serial | parallel (no data dependency) |
| `preflight-database` | re-ran the static gates before its DB gates | `--only migration-preflight,backup-restore-rehearsal,health-contract,http-security-smoke,reproducible-build,release-tools-tests`. A release-tool test proves that every standard-profile gate runs in exactly one CI job: static-gates, this `--only` list, or the security lane / Docker lab. `release_preflight.cjs` now refuses unknown `--only`/`--skip` ids, so a renamed gate cannot silently drop out. |

Environment: the test environment (`NODE_ENV=test`, `DISABLE_OUTBOX_WORKER=1`, mock payment provider) is set only where the former workflows set it: the backend-derived static steps, the test lanes, focused-tests and preflight-database. The static release preflight, the web runtime jobs and the Docker jobs run without it, as before.

The nightly run replaces the `test:all` repetition that ran after every push to master. It blocks nothing directly. A red nightly run is reported by GitHub's failed-scheduled-workflow notification, and it has to be triaged like any red master check. Every push to `master` still runs the complete FULL pipeline, and its `ci-verdict` is what Render's `checksPass` deploy waits for.

Kept on purpose: `web:routes` in web-runtime-core and the route inventory inside the static preflight. Each takes about 2 s and produces the artefact its own consumer reads.

## Measurements

### Before (single `backend-gates` job was the critical path)

| Run | Event | Wall-clock | Notes |
|---|---|---|---|
| 36463288440 (PR #121) | pull_request | backend-gates **17m54s**; release-readiness 3m53s; web-runtime 3m22s (core → resilience serial) | 10 groups in series: unit 17s, integration 52s, db 38s, api 1m42s, workers 41s, payments 1m42s, route-auth 16s, security 3m00s, concurrency 1m17s, failure 52s, e2e 4m20s, Docker smoke 51s |
| 36465477706 (master 904f72e) | push | backend-gates **34m06s** | the same 10 groups (13m33s), then `test:all` again (**15m00s**), then Docker smoke |

### After (Siton CI, 2026-09-28)

Wall-clock is measured from the run's creation to the moment `ci-verdict` completes.

| Run | Profile | Wall-clock | Jobs | Coverage (from the manifests) |
|---|---|---|---|---|
| 36473206258 (PR #126, first head) | FULL | **3m39s** (idle runners) | 18 in parallel | 321/321 files; the verdict was correctly red on a static-gates failure |
| 36475901545 (PR #126, final head) | FULL | **4m02s** | 18 | 321/321 |
| 36476839666 (master `7d42371`, push) | FULL | **5m04s**, vs 34m06s before | 18 | 321/321 |
| 36476906536 (proof PR #128, docs-only) | FAST | **4m33s**, of which ~2m was waiting for a free runner | 4: classify, static-gates, focused-tests (release-tool tests), ci-verdict | release-tool tests; no `tests/*.ts` references the file |
| 36476911495 (proof PR #129, one line in `web/src/pages/landing.tsx`) | STANDARD | 13m07s, mostly waiting for runners (see below) | 18 | 321/321 |
| 36476916820 (proof PR #130, `src/payment_binding.ts` with `CI-Profile: FAST`) | FULL, proposal rejected | 11m11s, mostly waiting for runners | 18 | 321/321 passed; **`ci-verdict` red**: "proposed profile FAST is below the computed profile FULL" |

A lane on an idle runner takes 2–2.5 minutes: about 40 s of setup (Postgres service, `npm ci`, web install, builds) plus up to about 2 min of tests.

The proof runs #129 and #130 were started together with the master run, #128 and two Dependabot runs. That put about 70 jobs against GitHub's concurrent-job limit, so lanes waited up to 9 minutes for a runner; `web-runtime-core` was created at 20:08:11 and started at 20:17:34. This queueing is the new bottleneck when many PRs run at once. It is a runner-capacity limit, not test time. Larger runners, or fewer simultaneous pushes, remove it.

## 2026-10-04: META profile audit (verdict: no change) and the release-tool bottleneck

Question asked: can a fourth profile, META (`docs/team-plans/**`, `docs/archive/**`, `docs/BRANCH_CENSUS_*.md`, `docs/LEAN_REFACTOR_MAP_*.md`), below FAST, shorten CI for safe metadata changes without weakening a gate? The premise was that FAST barely saves wall-clock because of `static-gates`. The audit measured the runs instead of assuming.

### Baseline (GitHub job timings, 2026-10-03/04)

| Run | Profile | Wall-clock | classify | static-gates | focused-tests | of which release-tool tests | preflight-database | verdict |
|---|---|---|---|---|---|---|---|---|
| 37177876079 (PR #209, status docs) | FAST | **6m26s** | 9s | 1m17s | 5m56s | **4m53s** | skipped | 9s |
| 37179255449 (PR #210, docs map) | FAST | **5m41s** | 7s | 48s | 5m16s | **4m29s** | skipped | 8s |
| 37179074808 (master `7c5c0ed`) | FULL | **5m51s** | 8s | 1m17s | skipped | — | **5m22s** (its preflight step: 4m31s) | 10s |
| 37156327175 (PR #205) | FULL | **6m38s** | 9s | 1m14s | skipped | — | **5m42s** (preflight step: 4m46s) | 6s |

`static-gates` runs beside `focused-tests` from the first second and finishes 4–5 minutes before it. It is not on the critical path of any profile; a profile that skipped it would save no wall-clock at all. The critical path of FAST is the `Release-tool tests` step of `focused-tests` (`node --test tests/release_tools/**/*.test.cjs`), and the critical path of FULL is `preflight-database`, whose gates run serially and include the same `release-tools-tests` gate.

Inside that suite one file dominated. Local timings of each release-tool test file (4 CPUs, no database; the suite runs files in parallel, so its wall-clock is about the longest file):

| File | Serial wall-clock | What it does |
|---|---|---|
| `legal_gate.test.cjs` | **204 s** | 94 runs of `scripts/legal_compliance_gate.cjs` on disposable fixtures (1 real-product check, 21 legitimate-copy controls, 71 mutations), serial, ~2.1 s each, of which ~1.7 s is TypeScript parsing in `scripts/lib/raw_card_terms.cjs` |
| `cdp_launcher.test.cjs` | 21 s | one deliberate 20 s CDP timeout |
| `money_tax_gate.test.cjs` | 16 s | 11 gate runs on fixtures |
| `release_orchestration.test.cjs` | 15 s | preflight on fixtures |
| `git_history_secret_scan.test.cjs` | 12 s | throw-away git repositories |
| the other 24 files | ≤ 9 s each, 23 s in total | |

### Gate audit against the META candidates

For every gate of the FAST path: what it reads, whether a metadata-only change (team plans, archive records, census, refactor map) can affect it, the risk of skipping it, and whether a release-tool test already proves the same claim.

| Gate (job) | Reads | Metadata-only change can affect it | Risk if skipped | Same claim proven elsewhere |
|---|---|---|---|---|
| Production dependency audit (static-gates) | lockfile, registry | no | none for docs; it costs 1 s | no |
| Distributor attribution-only contract (static-gates) | `src/`, `web/src`, `frontend/`, i18n | no | none for docs; 1 s | `distributor_gate.test.cjs` (fixture) |
| Bilingual i18n gate (static-gates) | `web/src`, dictionaries | no | none for docs; 1 s | no |
| Seven-day deal-cap sweep (static-gates) | **every** `.md`/`.docx` under `docs/`, incl. `docs/archive/` | **yes**: an archived record re-stating the retired 7-day cap without its historical marker is exactly what it catches | real: product-invariant drift in a document agents read | no |
| Operational repair validation (static-gates) | `tests/operational_repair_validation.ts` inputs (runbooks) | no for the candidates | none for docs; 8–13 s | no |
| Diff whitespace gate (static-gates) | the diff | yes (any file) | low; 0 s | no |
| Release preflight static (static-gates, 24–42 s): typescript, enforcement scan, architecture gate, payment scan, runtime DDL, money/tax canon, legal gate, **secret/PII scan**, logging hygiene, runtime env policy, startup matrix, no-real-money proof, route inventory, migration static, demo build, mobile/PWA, repository hygiene, supply chain, Docker static | code, config, canon docs; the secret/PII scan walks the whole tree **including `docs/archive/`** (`scripts/lib/repo_scan_policy.cjs` `INCLUDED_DIR_PATHS`) | secret/PII scan: **yes** (a pasted token or phone number in a team plan or archive record); architecture gate: reads named docs only; the rest: no | secret/PII: real; architecture/money/legal: none for the candidates but each costs ≤ 2 s | partly (fixture tests), but the working-tree scan of the actual change exists only here |
| Release manifest and checklist (static-gates) | preflight reports | no | none; 0 s | no |
| Release-tool tests (focused-tests) | fixtures copied from fixed lists (`legal_gate`, `money_tax_gate`, `architecture_truth_gate`, `distributor_gate`, …), one fixed plan fixture `docs/team-plans/2026-09-24-smoke-worker-log-scrub.json` (`team_plan_check.test.cjs`; the other plan tests use synthetic objects, so no test enumerates the plans), `AGENTS.md`/`CLAUDE.md`/`PROJECT_STATUS.md` (`agent_efficiency_v2.test.cjs`), `.github/workflows/*` | `agent_efficiency_v2.test.cjs`: **yes** for `PROJECT_STATUS.md`; `team_plan_check.test.cjs`: only for that one fixture file; `legal_gate.test.cjs` and the other fixture suites: **no** (fixed file lists, none of them under the candidates) | the status drift guard is real; team plans have no CI consumer beyond the static scans (the plan checker runs on demand: `node scripts/team_plan_check.cjs <plan>`); the fixture suites prove the gates, not the documents | — |
| Focused `tests/*.ts` (focused-tests) | the tests that name a changed path | yes, by construction | real (a test that reads the document) | no |
| ci-verdict | classification + manifests | no | n/a | — |

Conclusions:

1. The only job a META profile could remove from the FAST path with a wall-clock effect is `focused-tests`, and the only expensive thing in it is `legal_gate.test.cjs`. Skipping it for metadata changes is defensible in isolation (its fixture list does not touch the candidates), but it needs a new allowlist, new skip reasons in the verdict, a pin that the fixture list never grows into `docs/`, and it saves nothing on STANDARD/FULL, where the same suite sits on the FULL critical path inside `preflight-database`.
2. Letting the 94 independent gate processes of `legal_gate.test.cjs` run concurrently (an async `fixture.runAsync()` and a `describe({ concurrency })` wrapper, assertions unchanged) was tried on PR #211 and **measured on the exact head, then reverted**. Locally it worked (the whole release-tool suite 270 s → 131 s on a container with ~2 effective cores). On the 4-vCPU runner it did not: the `release-tools-tests` gate inside `preflight-database` took 213 006 ms with the change (run 37180889481) against 218 103 ms without it (run 37179074808, master). The baseline FAST log (run 37179255449) explains why: the 94 legal-gate runs already cost 2.8 s each there (267 s of CPU, against 2.1 s alone locally), the other 339 subtests another 147 s, and `node --test` already runs three files side by side, so the runner is CPU-bound at roughly 300 s of work for the suite and more processes only share the same cores. A change that helps the local loop but not CI was not worth the extra contention for the timing-bound sibling tests (`migration_runner_hardening`, `runtime_shutdown`), so it is not in master.
3. `PROJECT_STATUS.md` stays FAST: `agent_efficiency_v2.test.cjs` reads it, and FAST runs that test. Nothing below FAST is introduced; `docs/team-plans/**`, `docs/archive/**`, census and refactor-map files stay `docs` (trivial) under the existing allowlist and keep every static gate (seven-day sweep, secret/PII scan) that actually reads them. For team plans those static scans are the whole automated coverage: no CI job enumerates `docs/team-plans/*.json`, the checker is run by the lead on the plan it commits.

**Verdict: no META profile.** The classifier, the verdict and the workflow are unchanged. FAST, STANDARD and FULL keep exactly their gates.

### Measured on the exact head (run 37180889481, FULL, `d3af172` with the concurrency change)

| Measurement | master `7c5c0ed` (run 37179074808) | PR head with the concurrency change |
|---|---|---|
| `release-tools-tests` gate inside `preflight-database` | 218 103 ms | 213 006 ms |
| `preflight-database` job | 5m22s | 5m37s |
| FULL wall-clock (run created → `ci-verdict` done) | 5m51s | 6m37s (34 s of it waiting for a runner) |
| `npm run test:release-tools`, local, ~2 effective cores | 270 s | 131 s |

### What would shorten FAST and FULL (not done here; each is its own decision)

Both profiles end on the same CPU-bound release-tool suite (about 300 s of CPU on the runner, 160 s of it the legal gate parsing `web/src` with the TypeScript compiler 94 times). Two levers remain, neither of which skips a gate:

1. **Run the suite on its own job.** Today it is the last serial gate of `preflight-database` (FULL) and the long step of `focused-tests` (FAST). A dedicated job for `legal_gate.test.cjs` (or for the whole release-tool suite, out of the preflight chain) would cut the FULL critical path from ~5m30s to the test lanes' ~2m30s–3m30s, and FAST from ~5m30s to about 45 s of setup plus ~100 s of tests, at the cost of one more runner job per run and a `ci_verdict.cjs` row for it. It needs `.github/workflows/ci.yml`, `scripts/ci_verdict.cjs`, the lane contract in `scripts/ci_change_classifier.cjs` and their tests (FULL profile, senior review), and the "every standard gate runs in exactly one job" test keeps the gate from being lost.
2. **Make the legal gate cheaper per run.** Its 1.7 s of TypeScript parsing per run is spent on files the mutation did not change; parsing `web/src` once per process is inherent to a gate that is one process. A gate-side cache or a narrower product scan is a change to `scripts/legal_compliance_gate.cjs` / `scripts/lib/raw_card_terms.cjs` (security tooling, FULL profile, senior review) and must keep every mutation of `legal_gate.test.cjs` failing.

Until one of those is taken, FAST stays as it is: about 5m30s–6m30s, of which `static-gates` is never the limiting job.

## Local equivalents

| CI job | Local command |
|---|---|
| classify | `node scripts/ci_change_classifier.cjs --base origin/master --head HEAD` |
| static-gates | `npm run release:preflight:static` plus `npm run gate:i18n`, `npm run gate:seven-day-cap`, `node scripts/distributor_attribution_only_gate.cjs` |
| a test lane | `TEST_SHARD=1/2 npm run test:security` (any group, any shard) |
| focused-tests | `TEST_FILE_PATTERN='^(a_validation\.ts\|b_validation\.ts)$' node scripts/run_test_group.cjs focused` |
| preflight-database | `npm run release:preflight -- --profile standard --only migration-preflight,backup-restore-rehearsal,health-contract,http-security-smoke,reproducible-build,release-tools-tests` |
| complete suite | `npm run test:all` (never concurrently with another runner on the same `DATABASE_URL`) |

Before a PR, focused tests of the change are enough for FAST and STANDARD work. CI is the canonical proof, so the full suite is not re-run locally only to run it again in CI. FULL (senior-risk) work also runs the relevant groups and gates locally, and the canonical verifier when a disposable PostgreSQL is available.

The preflight reports four buckets: PASS (WARNING = pass with a documented human decision), FAIL, BLOCKED and NOT_APPLICABLE. `TECHNICAL_READINESS` and `REAL_MONEY_ACTIVATION` are printed separately and never combined.

Never run two test runners at the same time against one `DATABASE_URL` (`docs/PARALLEL_AGENT_DEVELOPMENT.md`); `npm run qa:diagnose` shows leaked runners, connections and stale databases.
