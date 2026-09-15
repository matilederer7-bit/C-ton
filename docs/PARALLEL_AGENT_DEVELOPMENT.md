# Parallel Agent Development — Claude and Codex on one repository

Rules for two (or more) coding agents working on Siton at the same time. Every rule below is either **IMPLEMENTED** (a mechanism in this repository enforces or supports it — path:line given), **EXPECTED** (a convention the history shows working, with no enforcement), or **OPEN** (not yet decided). Grounding: `git worktree list` shows ~50 live checkouts split between `claude/*` and `codex/*` branches; the same shared files have conflicted repeatedly (PROJECT_STATUS.md history, `docs/STAGING_ACCEPTANCE_2026-09-10.md`, migration reservations in `scripts/migration_manifest.cjs:62-64`).

---

## 1. The five separations (all mandatory)

| # | Separation | Mechanism | Status |
|---|---|---|---|
| 1 | **Branches** — one agent, one branch, prefixed `claude/<topic>` or `codex/<topic>`; never commit on `master`; never push to another agent's branch | git convention; CI runs on PRs to `master` only (`.github/workflows/*.yml` `on.pull_request.branches: [master]`) | EXPECTED |
| 2 | **Worktrees** — one checkout per branch: `git worktree add .worktrees/<topic> -b <agent>/<topic> origin/master` (or a sibling directory `../C-ton-<agent>-<topic>` as most existing ones do) | `.worktrees/` is gitignored (`.gitignore:71-72`), excluded from the Docker build context (`.dockerignore:64`), from every repository scanner (`scripts/lib/repo_scan_policy.cjs:20-22`, used by `backend_enforcement_scan`, `compliance_payment_scan`, `secret_pii_scan`), and `repository_hygiene_check` FAILS if any file under `.worktrees/` is ever tracked (`scripts/repository_hygiene_check.cjs:53-54`). TypeScript `include` is `src/**` / `tests/**` only (`tsconfig.json`, `tsconfig.test.json`) | IMPLEMENTED |
| 3 | **Databases** — never share a database between agents or between runs. `scripts/lib/test_db_isolation.cjs` mints `siton_<purpose>_<agent>_<pid>_<time>_<rand>` where `<agent>` = `SITON_AGENT` / `CLAUDE_AGENT` / `CODEX_AGENT` / `AGENT_NAME`, else the checkout directory name (`:21-25`); refuses non-local hosts (`assertLocalBase`, `:41-50`); drops on exit (`:57-70`). Export `SITON_AGENT=claude` / `SITON_AGENT=codex` in each agent's shell; CI sets `SITON_AGENT=ci` (`.github/workflows/release-readiness.yml:96`). The older `run_test_group.cjs` runner still names templates `siton_test_template_<pid>_<time>` without an agent tag (`scripts/run_test_group.cjs:81-82`) — unique per process, but see §5 | IMPLEMENTED (release tooling) / EXPECTED (legacy runner) |
| 4 | **Ports** — never hard-code `3000` (or any port) in new tests or scripts; use `allocateFreePort()` from the same helper (`scripts/lib/test_db_isolation.cjs:191-200`; used by `scripts/lib/local_runtime.cjs:54`). 75 of 208 existing `tests/*.ts` still pin ports (`process.env.PORT = "3481"` style) — those are why two runners cannot overlap (§5). `npm run qa:diagnose` reports occupied ports from `DEFAULT_TEST_PORTS = [3000, 3001, 3100, 4173, 5173, 9222]` (`scripts/lib/process_cleanup_guard.cjs:16`) | IMPLEMENTED (helper) / OPEN (legacy tests not migrated) |
| 5 | **Scopes** — one agent owns one area at a time (financial rail, UX, release engineering, mobile, docs). The owner of a scope is the only one who edits its files; the other agent reads them. Cross-scope needs go through a note in the requesting agent's own PROJECT_STATUS.md section, never through a direct edit | EXPECTED — it is how P0.5/P0.7 (Claude) ran beside `codex/amazon-benchmark-upgrade` with "062+ reserved for Codex" (`PROJECT_STATUS.md:260,322,365`) |

Setup checklist per agent session:

```
git fetch origin
git worktree add ../C-ton-<agent>-<topic> -b <agent>/<topic> origin/master
cd ../C-ton-<agent>-<topic> && npm ci
export SITON_AGENT=<agent>              # tags every isolated database this checkout creates
npm run qa:diagnose                     # must print QA_DIAGNOSE_CLEAN before any test runner starts
```

## 2. High-risk shared files

These files are touched by nearly every branch and are where merges break. Treat them as **append-only** or **owner-only** as marked.

| File | Why it conflicts | Rule |
|---|---|---|
| `PROJECT_STATUS.md` | 6,000+ lines; every branch prepends its status at the top → the top of the file conflicts on every cross-merge (measured on 2026-09-14: the financial × UX merge probe conflicted **only** on this file; the release-readiness reintegration of 2026-09-15 conflicted on this file, `.gitignore` and `package.json` only) | Each branch writes under its **own `## <branch> — <date>` heading**; never edit another branch's section; never reflow older text. Resolve by keeping both sections in date order. |
| `scripts/migration_manifest.cjs` + `src/migrations/NNN_*.sql` | one ordered array; position = array index + 1 (`:67`); the runner and `/readiness` refuse gaps, renames, or a changed file (`scripts/run_migrations.cjs:79-85`) | **Append-only.** Reserve an id range in your status section before writing SQL. Current map (2026-09-15): master holds 061 migrations, high-water 068; 062-064 were reserved by parallel branches and never landed; 065/066 landed first; the financial rails took 067/068 AFTER them (PR #9) and are applied on staging at ledger positions 60/61. Next free id: 069. **Renumber rule:** whichever branch merges second takes the next free ids AFTER everything already on master, keeps its files unchanged otherwise, and re-runs `npm run migrations:preflight` (upgrade-from-`origin/master` + schema-drift scenarios). Never renumber a file that any ledger (staging included) already holds. |
| `src/app.ts` (~5,800 lines) | boot, readiness, outbox processing, most write routes | One agent per session may edit it. Additive changes only (new route blocks at the end of a section, no reordering, no reformatting). Say which line ranges you touched in your status section. |
| `src/frontend_runtime.ts` (~11,700 lines) | every public/seller/admin read route and payload | Same as `app.ts`. It auto-merged in the financial × UX probe only because both sides were additive in different regions — keep it that way. |
| `package.json` / `package-lock.json` | scripts block and dependencies | Add scripts at the **end** of the `scripts` block; never re-sort; never bump a dependency in a feature branch without saying so. Lockfile conflicts: take `master`'s lockfile and re-run `npm install` for your own additions only. |
| `.github/workflows/*.yml` | CI budget and job names | Release-engineering scope owns them. Other branches do not edit workflows; they request a change in their status section. |
| `.gitignore`, `.dockerignore`, `config/*.json` | small, edited by "just one line" from several branches (probe: financial × release-night conflicts on `.gitignore`) | Append at the end under a comment naming the branch. |
| `render.yaml` | hosted contract | Hosted-change PRs only, owner-reviewed; never part of a feature branch. |

## 3. Integration order

Order is fixed by risk and by who renumbers whom. This is the order that was actually followed in September 2026 and is the rule for the next round:

1. **Financial branch first** — DONE: `claude/r9c-production-candidate` merged as PR #9 (master `4aaaa73`, migrations 067/068). It carries the money invariants (settlement horizon, dispatch lifecycle) and the migration ids; everything else rebased onto its manifest. `config/real-money-release-policy.json` stays BLOCKED (`FINANCIAL_BRANCH_NOT_INTEGRATED` was cleared by this merge; F-13, Grow live verification, owner activation and the adversarial review are not).
2. **UX branches second** — DONE: deterministic confidentiality proof (PR #12, master `4d1fe81`) then the hardened UX reintegration (PR #13, master `0e53998`). No migrations.
3. **Release engineering last** — DONE as a controlled PORT, not a rebase: `claude/release-readiness-night` (63a108f, 8 ahead / 24 behind) was classified file by file and re-applied onto `claude/release-readiness-reintegration` from master `0e53998`; obsolete hunks (post-merge-only `test:all`) were discarded and the three overlap files (`PROJECT_STATUS.md`, `.gitignore`, `package.json`) merged by hand with master winning. When a branch is this far behind, port; do not rebase.
4. Merge-probe before each step (read-only, no checkout):
   ```
   git merge-tree --write-tree --name-only origin/master <branch>          # exit 1 = conflicts; lists files
   git diff --name-only origin/master...<branch> | grep -E '^(PROJECT_STATUS.md|scripts/migration_manifest.cjs|src/app.ts|src/frontend_runtime.ts|package(-lock)?.json|\.github/workflows/)'
   ```
   Measured on 2026-09-14: master × each of the three branches merged clean; financial × UX conflicted on `PROJECT_STATUS.md` only; financial × release-night on `.gitignore` only; UX × release-night clean. Measured on 2026-09-15 for the release-readiness port: only `.gitignore`, `package.json` and `PROJECT_STATUS.md` were touched on both sides since the merge-base.
5. After every merge to `master`: the merging agent runs `npm run release:owner-check` on the merge SHA and posts the `RELEASE_OWNER_CHECK` line in its status section; the other agent rebases before its next commit.

## 4. Conflict handling

| Conflict in | Resolution |
|---|---|
| `PROJECT_STATUS.md` | keep both branch sections, newest first; never drop the other agent's lines; if both edited the same section, the section owner wins and the other agent re-adds its note below |
| `scripts/migration_manifest.cjs` | never "merge" two arrays by hand-interleaving. Take `master`'s array verbatim, append your entries after the last master entry with the next free ids, rename your `src/migrations/` files to match, re-run `npm run migrations:preflight` (manifest integrity: duplicate ids, `POSITION_GAP`, `OUT_OF_ORDER`, `PREFIX_COLLISION` are FAIL, `scripts/lib/migration_tools.cjs:49,89,100`) |
| `src/app.ts` / `src/frontend_runtime.ts` | resolve additively (both hunks stay); then `npx tsc --noEmit`, `npm run lint`, `npm run web:routes` (route contract), and the test group that covers the routes you touched |
| `package.json` | keep both script additions; lockfile from master + `npm install` |
| `.github/workflows/*` | release-engineering scope decides; other agents do not resolve these |
| `config/real-money-release-policy.json` | never resolved by an agent — owner + second reviewer only (`how_to_change`) |

Migration-file rules that make conflicts survivable (IMPLEMENTED in `scripts/run_migrations.cjs` and `scripts/lib/migration_tools.cjs`): never edit an applied file (checksum `mismatch` refuses), LF line endings (`eol-variant` tolerated, CRLF flagged by the preflight), one file = one transaction, ids append-only, documented ordering anomalies only via `KNOWN_ORDERING_ANOMALIES`.

## 5. Never run two test runners at once on the same DATABASE_URL

The rule: **one `npm run test:*` / `npm run release:preflight` / browser-proof runner per Postgres server at a time**, across all worktrees and both agents. Reasons, all in the code:

1. **Template databases and the shared `postgres` maintenance DB.** `run_test_group.cjs` connects to the base server's `postgres` database as admin, creates `siton_test_template_<pid>_<time>`, migrates it, then `CREATE DATABASE … TEMPLATE` per test file and drops everything at the end (`scripts/run_test_group.cjs:78-130`). Two runners double the connection load on one server, and `DROP DATABASE … WITH (FORCE)` from one runner's cleanup can hit databases the other runner is still creating from a template. The release tooling's isolation helper adds an agent tag but shares the same server.
2. **Port collisions.** 75 of 208 test files pin a port (`process.env.PORT = "34xx"`), several proofs pin 3210/3215/3216 (`scripts/*_browser_proof.cjs` headers) and the web runtime defaults to 3000 (`src/runtime_config.ts`). A second runner gets `EADDRINUSE` or, worse, talks to the other runner's server and produces a false PASS/FAIL.
3. **Compiled test output.** Every group first runs `tsc -p tsconfig.test.json` into `.tmp_test_dist/` of that checkout (`scripts/run_test_group.cjs:74`, `package.json` `test:*`). Two runners in the **same** checkout overwrite each other's compiled files mid-run. (Different worktrees have separate `.tmp_test_dist`, so this reason alone is avoided by the worktree rule.)
4. **Rate limits and Edge/CDP.** Browser proofs share one IP and one headless Edge devtools port (9222 in `DEFAULT_TEST_PORTS`); a parallel proof trips the product's per-IP rate limiter or attaches to the wrong browser.

Before starting any runner (both agents, every time):

```
npm run qa:diagnose
```
Expected: `QA_DIAGNOSE` … `QA_DIAGNOSE_CLEAN`. If it prints `QA_DIAGNOSE_ATTENTION problems=N`, read the lines: `occupied test ports` (someone's runtime is up), `stray runner processes (not killed)` (the other agent is mid-run — wait), `test-database connections … leaked` (a dead runner left sessions), `stale isolated databases` (drop only your own dead ones: `npm run qa:cleanup-stale-dbs -- --yes`, which only drops databases whose owning pid is dead, `scripts/qa_process_guard.cjs:26-33`). Nothing in `qa:diagnose` kills a process (`:12-13`); coordinate in the status file instead.

CI is exempt only because each job has its own Postgres service container and its own runner (`backend-quality-gates.yml:22-40`, `release-readiness.yml:71-96`).

## 6. Daily protocol (both agents)

1. Start: `git fetch`, rebase your branch on `origin/master` if master moved (it moved mid-task twice in the R9C history, landing 065/066 and forcing a renumber), `npm ci` if `package-lock.json` changed, `export SITON_AGENT=…`, `npm run qa:diagnose`.
2. Before editing a shared file (§2): write one line in your PROJECT_STATUS.md section — file, region, purpose. Check the other agent's section for the same file first.
3. Migrations: reserve ids in your section, name them, keep LF endings, run `npm run migrations:preflight` before every push.
4. Commits: small, one scope, `<area>(<scope>): …` subject; `[skip render]` on docs-only commits that reach `master` (`docs/STAGING_ACCEPTANCE_2026-09-10.md:53`).
5. Handoff / stop mid-task: revert debug seams, commit honestly labelled work-in-progress, note BLOCKED rather than an aspirational PASS, list every shared file you touched.
6. Never in-session: modify git credentials, force-push a shared branch, delete another agent's worktree (`git worktree remove`) or branch, run anything against a hosted `DATABASE_URL` (the isolation helper refuses it; do not add `SITON_TEST_DB_ALLOWED_HOSTS` to get around it, `scripts/lib/test_db_isolation.cjs:46`).

## 7. Worktree hygiene

- List: `git worktree list`. Prune stale metadata (only for directories you deleted yourself): `git worktree prune`.
- Detached review worktrees (`.worktrees/f12-round*-review`, `independent-r9c-merge-review`, …) are read-only evidence; do not commit from them.
- Sibling-directory worktrees (`../C-ton-claude-*`, `../C-ton-codex-*`) are the working pattern; `.worktrees/` inside the repo is for short-lived review checkouts and is protected by the ignore/scan/docker exclusions above.
- Each worktree needs its own `npm ci` (and `cd web && npm ci` for the React build); `node_modules` is never shared.
- `.release-artifacts/` and `.tmp_test_dist/` are per-worktree and gitignored; never copy them across.

## 8. Templates

### 8.1 Status-section header (top of PROJECT_STATUS.md, one per branch)

```
## <agent>/<branch> — <YYYY-MM-DD> — <one-line scope>
Base: origin/master <sha>. Migrations: <none | reserved 0NN-0MM | used 0NN>.
Shared files touched: <path (region / purpose)>, ...
Runners: <groups run> on <local | ci>; RELEASE_OWNER_CHECK <line if run>.
Open / blocked: <...>
```

### 8.2 Migration id reservation (write it BEFORE the SQL file exists)

| id | file (planned) | branch | state | note |
|---|---|---|---|---|
| 060 | 060_support_case_messages.sql | master | applied | staging ledger pos 56 |
| 061 | 061_seller_customer_inquiries.sql | master | applied | staging ledger pos 57 |
| 062 | — | codex/amazon-benchmark-upgrade | reserved, never landed | no file exists on any branch; OPEN whether the reservation still stands — ask before reuse |
| 063-064 | — | financial candidate (superseded by 067/068) | released | never applied anywhere |
| 065 | 065_pilot_readiness.sql | master | applied | staging ledger pos 58 |
| 066 | 066_receipt_trust_content.sql | master | applied | staging ledger pos 59 + grants `supabase/staging/023` |
| 067 | 067_payment_operation_lifecycle.sql | master (PR #9) | applied | staging ledger pos 60 + grants `supabase/staging/024` |
| 068 | 068_payment_settlement_horizon.sql | master (PR #9) | applied | staging ledger pos 61 + grants `supabase/staging/024` |
| 069+ | — | next free | free | the UX plan branch proposes 069 for hero-video content (`claude/backend-sensitive-ux-plan`) |

Keep this table current in the reserving agent's status section; the manifest comment in `scripts/migration_manifest.cjs` is the second copy and must agree.

### 8.3 Per-agent shell environment (local only; never a hosted URL)

```
SITON_AGENT=claude                      # or codex — tags isolated database names
DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:5432/postgres   # base server; every run creates its own siton_* database
NODE_ENV=test
DISABLE_OUTBOX_WORKER=1                 # tests drive the outbox explicitly (policy rule for target "test")
PAYMENT_PROVIDER=mockpay
PAYMENT_PROVIDER_MODE=mock-backed
```
`npm run gate:runtime-env -- --target test` validates this shape (`RUNTIME_ENVIRONMENT_GATE_PASS`); a hosted host in `DATABASE_URL` is a FAIL for the test target (`config/runtime-environment-policy.json` test rules) and is refused by the isolation helper anyway.

### 8.4 Pre-push checklist (each agent, each push)

1. `git fetch && git rebase origin/master` — clean.
2. `npm run qa:diagnose` → `QA_DIAGNOSE_CLEAN` (nobody else is running).
3. `npx tsc --noEmit`, `npm run lint`, `npm run scan:payment`, `npm run scan:runtime-ddl`.
4. The test groups for the scope touched (`npm run test:<group>`), never `test:all` while the other agent may be running.
5. If a migration changed: `npm run migrations:preflight` (report `overall=PASS`).
6. If a shared file changed: the status-section line from 8.1 is written and names the region.
7. `npm run release:preflight:static` (no DB, ~minutes) → `RELEASE_PREFLIGHT_PASS`; `REAL_MONEY: BLOCKED` still printed.
8. Push to your own branch only; open the PR against `master`; do not merge your own PR without the other agent having rebased or acknowledged in its section.

## 9. Worked example — the R9C week (what the rules are distilled from)

1. Claude opened `claude/r9c-system-red-team` while Codex reviewed on `codex/r9c-independent-review`; both reserved migration ids in advance (063/064 financial, 062+ Codex Amazon).
2. Master moved twice during the review (`065_pilot_readiness`, `066_receipt_trust_content`), so the financial branch renumbered to 067/068 with a manifest comment explaining why, instead of rewriting master's ids — the "second lander appends" rule.
3. Staging acceptance found ledger rows written from a Windows checkout with CRLF checksums; the runner now classifies those as `eol-variant` and the repair helper fixes them explicitly (`migrations:repair --fix-eol-checksums`) — the "LF-canonical, never edit an applied file" rule.
4. A parallel validation run hit `EADDRINUSE` on port 3000 because two test processes imported the listening app at once; rerun sequentially it passed (`PROJECT_STATUS.md:3461`). A long-lived local dev database produced a false `checksum mismatch: 045` that a fresh database did not (`PROJECT_STATUS.md:159`) — the "never two runners, never a shared database" rules and `qa:diagnose`.
5. Every cross-branch merge probe conflicts on `PROJECT_STATUS.md` and nothing else (or one line of `.gitignore` / the `scripts` block of `package.json`) — the "own section, append-only" rule.
6. The release-readiness branch fell 24 commits behind master while the financial and UX work landed; it was reintegrated as a file-by-file PORT onto a fresh branch (classification: safe new file / safe doc / needs porting / obsolete / conflicts with master / security-or-financial sensitive) with every gate re-run against the merged source, instead of a rebase that would have replayed stale assumptions — the "port when far behind" rule.

## 10. OPEN items

- Legacy tests with pinned ports (75 files) are not migrated to `allocateFreePort()`; until they are, §5 is a hard serial rule, not a guideline.
- `run_test_group.cjs` template names carry no agent tag (pid + time only); adding `agentName()` from the isolation helper would make leaked databases attributable.
- No lock file or lease exists for "a runner is active on this Postgres server"; `qa:diagnose` detects, it does not prevent.
- The scope ownership map (who owns `src/app.ts` this week) lives only in PROJECT_STATUS.md sections; a short `OWNERS`-style table at the top of that file is not yet agreed.
- Whether Codex adopts `SITON_AGENT=codex` in its own tooling is unverified from this repository (`CODEX_AGENT` is honoured by the helper, `scripts/lib/test_db_isolation.cjs:22`).
