# CI test strategy

<!-- proof PR: FAST profile -->

Goal: every safety proof is kept, and each change pays only for the proofs it needs. Independent proofs run in parallel, so the wall-clock answer on a pull request is short. Nothing is deleted, no assertion is weakened, and no blocking gate becomes advisory.

Sources of truth: GitHub = code; Render = web/backend/worker staging runtime; Supabase = canonical PostgreSQL/Auth/infra; Grow = payment provider boundary, currently disabled (mock provider on every checked-in target). Base44 is an excluded legacy surface guarded by the canonical-integrity gate; it is never the business runtime.

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
| Static preflight gates (tsc, enforcement scan, architecture, payment scan, runtime DDL, Base44 gate, demo build, mobile/PWA gate, …) | up to 3× per PR: the backend job, `preflight-static`, and again inside `preflight-database` (standard profile includes the static gates) | once, in `static-gates` (`release:preflight:static`) |
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

### After

Filled from the real runs of PR #126; see the PR and `PROJECT_STATUS.md` for the run ids.

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
