# Siton Lean Refactor Map — 2026-09-30

Status: REFERENCE. Audit first, deletions later. Prerequisite: PR #148 (the Product Constitution,
`docs/CURRENT_ARCHITECTURE_2026-09-30.md` and `docs/DOCUMENTATION_MAP.md`) merges before this map;
the owner rule and the §9 capability boundary cited below live there. Every row below is backed by a consumer search
(imports, `package.json` scripts, workflow invocations, CI gate configs, Dockerfile, tests, docs
that operations depend on). Nothing is deleted because of its name or its file count.

Owner rule: the refactor removes fat, duplication and legacy. It never removes the product's
capabilities listed in `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md` §9, and it never lowers
test coverage to make the repository smaller.

Categories: **CORE** (runtime, safety, current product) · **SUPPORT** (tooling that CI, gates,
build or operations invoke) · **ARCHIVE** (history with recovery or evidence value, no active
consumer) · **DELETE CANDIDATE** (no consumer and no history value).

## 1. Baseline (master `d40c23f`)

| Group | Files | Verdict |
|---|---|---|
| repository | 1,388 | — |
| `docs/` markdown | 273 (+14 root reports) | tiered in `docs/DOCUMENTATION_MAP.md` |
| `tests/` | 364 | CORE evidence; auto-discovered by `scripts/run_test_group.cjs`; not a deletion target |
| `scripts/` | 139 (138 + `retired/README.md`) | D2 done: 1 deleted, 12 moved to `scripts/retired/` (still inside `scripts/`), rest SUPPORT/CORE (§3.5) |
| `src/` | 161 | CORE |
| `web/` | 100 | CORE |
| `.i18n-regen/` | 66 → 0 | DELETED by D1 (§3.4) |
| `base44/` | 19 → 0 | DELETED by D3-B (§3.1) |
| `frontend/` | 15 | CORE today: the legacy `/app` shell is still served and built (§3.2) |
| `legacy/` | 12 → 0 | DELETED by D3-B (§3.3) |
| `.github/workflows/` | 10 | 3 operational, 5 blocked on absent secrets, 1 nominal, 1 dormant (§3.6) |
| `.claude/agents/` | 10 | SUPPORT, CI-load-bearing (§3.7) |

## 2. Render (infrastructure, no code)

Verified on 2026-09-30 through the Render connector (workspace `tea-d762ijsr85hc739birrg`):

| Service | ID | Branch / trigger | State | Verdict |
|---|---|---|---|---|
| `siton-staging-web` | `srv-daa5o9u7bikc73fgjskg` | `master` / `checksPass` | live on `d40c23f` (`dep-daud0b3bc2fs73cgdctg`) | **KEEP** (canonical, matches `render.yaml`) |
| `siton-staging-worker` | `srv-daakn0tg1s2s73dfk3pg` | `master` / `checksPass` | live on `d40c23f` (`dep-daud0b3bc2fs73cgddbg`) | **KEEP** (canonical) |
| `siton-staging-web-atp1` | `srv-daa5o9u7bikc73fgjsjg` | `master` / `commit` | every deploy today failed (non-zero exit) | **DELETE** (duplicate of the canonical web, created 2026-08-30 by a Blueprint collision) |
| `siton-demo-preview-atp1` | `srv-d870grl7vvec73apc0q0` | `master` / `commit`, region oregon, health `/health` | deploy failed, `server_failed` loop | **DELETE** (legacy demo) |
| `siton-demo-preview` | `srv-d77p6tgule4c73denj7g` | `master` / `commit`, region oregon, health `/health` | deploy failed, `server_failed` loop | **DELETE** (legacy demo, `legacy/render/render.legacy.yaml`) |

Checks done before recommending deletion:

- Custom domains: none on any of the five services (`renderSubdomainPolicy: enabled` only, no `customDomains`).
- Consumers: no runtime, workflow, test or script depends on the three legacy services. They are
  mentioned in `legacy/render/render.legacy.yaml`, in historical reports (`RC_STAGING_SMOKE`,
  `RED_TEAM_SYSTEM`, `ARCHITECTURE_REBASE_R3`, `OVERNIGHT_ENGINEERING_HANDOFF_2026-08-31`,
  `BLACK_SKY_FINAL_REPORT` item 12) and in `PROJECT_STATUS.md` (PR-18, and an open NEXT line
  "repair or retire `siton-demo-preview`", which the owner's 2026-09-30 decision now answers:
  retire). After the deletion, PR-18 and that NEXT line are closed in the status file.
- Secrets: the legacy services' environment variables were not read (the connector exposes no read).
  The canonical services carry every value `render.yaml` needs; the legacy demo blueprint used a
  different, retired variable set (`EXPECTED_COMMIT_SHA`, `OBJECT_STORAGE_*`, MinIO-era). Nothing to
  preserve is known; if the owner wants to be sure, open each service's Environment tab once before
  deleting.
- Blueprint ownership: the Render connector has no Blueprint, suspend or delete operation, so the
  Blueprint that keeps recreating the `-atp1` duplicates could not be inspected or removed from here.

**Manual owner action (dashboard, in this order):**

1. Blueprints → delete or disconnect every Blueprint whose repo is `matilederer7-bit/C-ton` **except**
   the one that owns `siton-staging-web` + `siton-staging-worker` (its sync must keep pointing at the
   root `render.yaml`). A stale Blueprint that still lists `siton-demo-preview` or a second web
   service is what recreated the duplicates.
2. Delete service `siton-staging-web-atp1` (`srv-daa5o9u7bikc73fgjsjg`).
3. Delete service `siton-demo-preview-atp1` (`srv-d870grl7vvec73apc0q0`).
4. Delete service `siton-demo-preview` (`srv-d77p6tgule4c73denj7g`).
5. Confirm the workspace lists exactly two services and that the next `master` commit deploys only
   those two.

Until then the three legacy services keep building every `master` commit and failing.

## 3. Group census

### 3.1 `base44/` (19 files) — ARCHIVE, held by gates → DELETED (D3-B, 2026-10-01)

- Runtime consumer: none. No code under `src/` references it (the only hit is a SQL comment in
  migration 072); `tests/legacy_runtime_isolation_validation.ts` walks `src/` with negative
  assertions.
- Gate consumers: `scripts/architecture_truth_gate.cjs` (asserts the manifest still says
  `production_runtime = base44`, lines 8–10, 49–53), `scripts/base44_canonical_integrity_gate.cjs`
  + `config/base44-canonical-registry.json` + `config/base44-canonical-callers.json` +
  `tests/fixtures/base44_integrity_clean_snapshot.json`, `npm run test:base44-canonical-integrity`
  (`ci.yml`) and `gate:base44-canonical-integrity` (`package.json`), preflight gates
  `architecture-gate` and `base44-canonical-integrity`, the rollups in
  `scripts/release_checklist.cjs` (owner item at line 33, `GATE_TO_CATEGORY` at line 46) and
  `scripts/release_owner_check.cjs:56`, the classifier rule `legacy-excluded-surfaces`
  (`scripts/ci_change_classifier.cjs:78`), the tests `tests/base44_mall_contract_validation.ts`,
  `tests/base44_canonical_integrity_validation.ts`,
  `tests/supabase_inventory_activation_hardening_validation.ts` (reads `base44/supabase/*.sql`) and
  `tests/supabase_staging_security_foundation_validation.ts:19` (reads
  `scripts/extract_base44_inventory_sql.ps1`), plus the runbook lines that invoke the gate
  (`docs/OUTBOX_WORKER_OPERATIONS.md:150`, `docs/STAGE32B_OPERATIONAL_RECOVERY.md:291`).
  `tests/hosted_v11_activation_gate_validation.ts` only carries a Base44 URL string behind
  `SITON_HOSTED_GATE=1`; decide it separately.
- Contradiction: the gate prints `production=base44` while the runtime is Render + Supabase.
  `docs/SENIOR_ADVERSARIAL_REVIEW.md` F-07 already flagged it.
- Retirement plan (one FULL-profile PR, senior review, `ci-gates` family): rewrite
  `architecture_truth_gate.cjs` to assert the Render/Supabase truth (keep every R2/R3/R4 assertion;
  drop the Base44 manifest assertions at lines 8–10 and 49–53 and the
  `legacy/render/render.legacy.yaml` existence check at 12; at lines 23 and 94 remove only the
  `base44` token from the patterns and keep the rest: line 94 also rejects `http(s)`, `fetch` and
  `axios` in `src/inventory_repository.ts`, which is the internal-Postgres inventory boundary, and
  line 23 keeps guarding `render.yaml`; replace the `production=base44` banner at 107); delete the
  integrity gate, its two config files, the fixture, both npm scripts and the `ci.yml` step that
  runs `test:base44-canonical-integrity` (line 181), the preflight gate entry, the two rollup
  entries, the classifier rule and the `.ps1`; delete
  `tests/base44_canonical_integrity_validation.ts` and
  `tests/supabase_inventory_activation_hardening_validation.ts`; before deleting
  `tests/base44_mall_contract_validation.ts`, move its live-schema assertions on migration 049 (Mall
  indexes, acquisition-source constraint, no buyer PII in the projection) into a replacement Mall
  test, since no other test carries them; edit
  `supabase_staging_security_foundation_validation.ts` to drop only its `.ps1` case (never delete a
  test for an unrelated reason); update the two runbook lines; then delete `base44/`. Keep the Mall
  read model in `src/` untouched (it does not depend on Base44).

### 3.2 `frontend/` (15 files) — CORE today

- Served by `src/frontend_runtime.ts` at `/app/*` (`sendShell`, static routes, CSP inline-script
  registration); copied into the image by `scripts/build_demo_bundle.cjs` (Dockerfile line 27);
  probed by `src/admin_mission_control.ts` (`frontend_static_surface_issue`); read by
  `scripts/legal_compliance_gate.cjs` and `scripts/money_tax_invoice_gate.cjs`; icons regenerated by
  `scripts/render_brand_assets.cjs`; about 30 tests read its files.
- The bare domain redirects to `/preview/` (React), so `/app` is a second shell for direct links
  and the PWA. Retiring it is a product-level change (route `/app` must keep answering for shared
  links), touching runtime, build, admin panel, two gates and ~30 tests. Not a refactor target
  until the owner decides the `/app` shell is gone.

### 3.3 `legacy/` (12 files) — ARCHIVE → DELETED (D3-B, 2026-10-01)

- `render.legacy.yaml`: held only by `scripts/architecture_truth_gate.cjs:12`.
- `render_config_gate.legacy.cjs`: held only by `package.json` `legacy:validate-render`; no workflow,
  gate or test runs it.
- `Procfile.legacy`, `README.md`, `docs/*` (7): zero code consumers.
- Retirement: drop the gate line and the npm script in the same PR as §3.1, then delete the tree.

### 3.4 `.i18n-regen/` (66 files) — DELETE CANDIDATE → DELETED (D1, 2026-09-30)

- A stale, Hebrew-only snapshot of `web/src` from before the i18n extraction (58 files differ from
  the live tree; it lacks `i18n/`, `errorReporting.ts`, the admin MFA files, the infographic).
- Consumers: none. Not in any `tsconfig`, not read by `scripts/i18n/*.cjs`, not by any workflow,
  test, Dockerfile or npm script. The only mention is `scripts/ci_change_classifier.cjs:97`, a
  path-classification rule.
- Cost of keeping it: copied into the Docker image (`.dockerignore` does not exclude it) and walked
  by every repo-wide scanner.
- Removal: delete the tree and the classifier rule. `scripts/retired/i18n/extract.cjs` (one-shot extractor, moved by D2)
  keeps working with `--src`.

### 3.5 `scripts/` (139 files)

- **DELETE CANDIDATE (zero references anywhere, including `PROJECT_STATUS.md`, and no
  behavioural assertions or recovery value of its own):** `bounded_load_test.cjs` (local latency
  measurement on a disposable database; states no product behaviour).
- **ARCHIVE (no automated caller; docs-only or zero references, some of them live runbooks):**
  - unreferenced real-browser / end-to-end proofs that carry browser-level assertions no
    automated test repeats (a proof nobody automates naturally has no caller, so a zero reference
    count does not prove that deleting it keeps coverage): `p06a_geolocation_browser_proof.cjs`
    (the only real-browser exercise of the seller geolocation flow: CDP-granted, emulated and
    denied permission paths S1–S9; `frontend_foundation_geolocation_strategy_validation.ts` covers
    injected dependencies and source wiring only), `p07_owner_acceptance_proof.cjs` (public deal
    page owner-acceptance scenarios incl. seller-inquiry sheet and 390px layout),
    `p07c_polling_browser_proof.cjs` (real-browser polling cadence / 429 / hidden-tab measurement)
    and `site_cms_rehearsal.cjs` (CMS draft → preview → publish → restore rehearsal against a running
    service). D2 moves them under `scripts/retired/`; none is deleted before an equivalent
    browser-level proof exists (§6 rule 3);
  - recovery tooling with no caller: `migrate_showcase_images_to_supabase.cjs` regenerates the 16
    synthetic staging showcase images deterministically and uploads them through `saveDealImage`
    and the storage broker into the canonical, still-active Supabase `deal-images` bucket (the
    retired side is the old local filesystem, not the target); it is the purpose-built way to
    restore those objects if they are lost, so D2 archives it and never deletes it;
  - cited by operational runbooks, so D2 must rewrite those steps before deleting or moving:
    `dr_backup_restore_drill.cjs` (BACKUP_RESTORE, SECURITY_INCIDENT, DB_BACKUP_RESTORE_REHEARSAL;
    superseded by `db_backup_restore_rehearsal.cjs`) and `r6_hosted_browser_proof.cjs` (the
    deployment runbook itself says its failures are not regressions: Mall-ON assumptions, old
    selectors, 1/5 on 2026-09-10);
  - indexed only by `scripts/README.md` or historical docs: `r6_staging_showcase_seed.cjs`,
    `review_baseline_candidates.cjs`,
    `review_r9c_migration_independent_proof.cjs`, `run_outbox_select.cjs`, `i18n/extract.cjs`,
    `extract_base44_inventory_sql.ps1` (Base44; read unconditionally by `tests/supabase_staging_security_foundation_validation.ts:19`, see §3.1 — **excluded from D2**: it stays in place until D3 retires it together with that test edit, so no deletion PR goes red).
- **SUPPORT without an automated caller but prescribed by live runbooks (keep, never in a D2
  batch):** `run_pg_query.cjs` (the incident and operational runbooks' query tool:
  DATABASE_INCIDENT, PAYMENT_INCIDENT, OPERATIONAL, DISASTER_RECOVERY, CREDENTIAL_COMPROMISE,
  PAYMENT_RECONCILIATION), `r3_hosted_proof.cjs` (deployment, credential-compromise,
  disaster-recovery and security-incident runbooks; also an existence assertion in the architecture
  gate), `pilot_readiness_proof.cjs` (`PILOT_LAUNCH_RUNBOOK.md`), `r7r8_browser_proof.cjs`
  (`DEPLOYMENT_RUNBOOK.md:183`: the only prescribed hosted browser proof that requires the
  Supabase-backed Mall and deal-gallery images to render; the retained `p0_browser_proof.cjs` is
  local-only there), the merge-time browser proofs
  `launch_polish_browser_proof.cjs`, `buyer_polish_browser_proof.cjs`,
  `pickup_fulfillment_browser_proof.cjs` and `p0_browser_proof.cjs` (`DEPLOYMENT_RUNBOOK.md:185`
  prescribes them on every merge SHA; the pickup proof is the only end-to-end exercise of the
  React/runtime pickup handoff — camera success/failure, QR and typed code, paid/unpaid,
  pending→fulfilled — so a runbook rewrite alone never retires it: equivalent coverage must land
  first), `restart_server_tsnode_clean.ps1` with `register-ts-node.mjs` and
  `restart_server_clean.ps1` (`OPERATIONAL_RUNBOOK.md` restart procedure; `scripts/README.md` calls
  them operational), `receipt_content_browser_proof.cjs` (`docs/SITE_CMS.md` operations section,
  `docs/RECEIPT_TRUST_CONTENT.md`). Any of these leaves SUPPORT only when the runbook procedure that
  names it is intentionally replaced in the same PR.
- Everything else is SUPPORT or CORE with a live caller (`package.json`, a workflow, a preflight
  gate, a compose file or another script). Re-derive with
  `rg -n -F "<basename>" --glob '!scripts/<name>*' .` before touching any file; `scripts/README.md`
  indexes several of the ARCHIVE entries and is updated in the same PR.

### 3.6 `.github/workflows/` (10)

| Workflow | State |
|---|---|
| `ci.yml` | operational; the single required check `ci-verdict` |
| `mobile-readiness.yml` | operational |
| `codex-rereview.yml` | operational (posts `@codex review`) |
| `offsite-db-backup.yml` | nominal: exits 0 with `OFFSITE_BACKUP_SKIPPED` because the `OFFSITE_BACKUP_*` secrets are absent (Production Readiness PR-6) |
| `stripe-sandbox-proof.yml` | dormant: zero runs ever; needs Stripe sandbox secrets; Stripe is not the provider direction |
| `cloud-agent-manager.yml`, `cloud-agent-review.yml`, `cloud-analysis-swarm.yml`, `cloud-credential-preflight.yml`, `agent-manager-intake.yml` | blocked: all four agent secrets absent; every run fails at routing. `PROJECT_STATUS.md` already freezes agent-platform expansion |

- Also registered on GitHub but with no file on `master`: 12 orphan workflow names
  (`base44-bridge-gate`, `chatgpt-*`, `diag-*`, `fix-long-horizon-logging`, `long-horizon-import`,
  `pr38-reconcile-probe`, `reservation-service`). They disappear from the Actions list only when
  their last runs age out; no repository change.
- `tests/release_tools/cloud_agent_manager.test.cjs` and `agent_model_tiers.test.cjs` read the agent
  workflow YAML, so removing those workflows means removing their tests, `scripts/agent_*.cjs`,
  `scripts/cloud_agent_manager.cjs` and `docs/CLOUD_AGENT_MANAGER.md` together. Decision for the
  owner: keep the cloud-agent path dormant (current state) or retire it as one PR.

### 3.7 `.claude/agents/` (10) — SUPPORT

Hard-listed in `scripts/agent_model_tiers.cjs` (`AGENT_TIERS`), asserted by
`tests/release_tools/agent_model_tiers.test.cjs` and `agent_readonly_bash_guard.test.cjs`, run in
CI through `test:release-tools`. Keep.

### 3.8 `docs/` — see `docs/DOCUMENTATION_MAP.md`

CANONICAL 12 / REFERENCE 100 / ARCHIVE 175 (176 before D3-B). Physical moves into `docs/archive/` happen per file
with their consumers updated (`scripts/architecture_truth_gate.cjs`, `scripts/legal_compliance_gate.cjs`,
`scripts/release_checklist.cjs`, `src/admin_mission_control.ts`, ~40 tests read docs by path).

## 4. Safe removal order (each its own PR, single scope, tests, review, green CI)

| Step | Scope | Profile | Blockers to clear first |
|---|---|---|---|
| D1 | **DONE 2026-09-30** — deleted `.i18n-regen/` + the classifier rule (was `ci_change_classifier.cjs:97`); the branch classified as FULL exactly as predicted (66 × unclassified/critical + the classifier file) | FULL | none |
| D2 | **DONE 2026-10-01** — deleted `bounded_load_test.cjs`; moved the 12 ARCHIVE scripts under `scripts/retired/` (named `retired`, not `archive`, because `scripts/lib/repo_scan_policy.cjs` skips any `archive` directory and the files must stay scanned — found by the independent review; requires rewritten, each run once from the root; `extract_base44_inventory_sql.ps1` left for D3; the three REFERENCE runbooks, `scripts/README.md`, `R6_STAGING_SHOWCASE`, `CODEX_BASELINE_REVIEW` and `DB_BACKUP_RESTORE_REHEARSAL` rewritten; the purely historical ARCHIVE records `R9C_PRODUCTION_EXTRACTION_AUDIT`, `STAGING_ACCEPTANCE_2026-09-10`, `REPOSITORY_FINAL_HYGIENE_DECISION` keep their original paths as history). Original plan: delete the 1 zero-reference script; move the ARCHIVE scripts under `scripts/retired/` (the unreferenced browser proofs are never deleted, see §3.5; `extract_base44_inventory_sql.ps1` is left in place for D3 because a test still reads it) or delete the ones whose docs are themselves ARCHIVE; a relocated script must keep working: rewrite its relative requires and root derivations (`dr_backup_restore_drill.cjs` loads `./lib/destructive_target_guard.cjs`; `review_r9c_migration_independent_proof.cjs` loads sibling migration modules; `i18n/extract.cjs` derives the repository root from its own directory; `migrate_showcase_images_to_supabase.cjs` dynamically imports `../src/product_image_storage.ts`) and run each moved script once after the move (none has an automated caller to expose a `MODULE_NOT_FOUND` or a wrong scan root) — a script whose dependency layout cannot be kept cheaply stays in place; rewrite the runbook steps that name them and `scripts/README.md` | FULL (scripts are gate-or-tooling) | re-run the reference grep per file; runbooks updated in the same PR |
| D3 | split in two by owner decision 2026-10-01. **D3-A (PR, 2026-10-01):** `architecture_truth_gate.cjs` rewritten to the Render/Supabase truth (module + CLI, `tests/release_tools/architecture_truth_gate.test.cjs` proves 32 drifts by mutation), the live invariants of the Base44-era tests moved to `tests/canonical_sql_invariants_validation.ts`, the `base44-canonical-integrity` gate unwired from the preflight catalogue, `release_checklist` (gate map + owner item O-4, decided), `release_owner_check` and the `ci.yml` step. **D3-B (PR, 2026-10-01):** deleted `base44/` (19), `legacy/` (12), the integrity gate + its two configs + fixture, the four Base44-only tests (`base44_canonical_integrity`, `base44_mall_contract`, `supabase_inventory_activation_hardening`, `hosted_v11_activation_gate`), the `.ps1` (+ its single test case), the `legacy-excluded-surfaces` classifier rule and the three npm scripts; the architecture gate gained the Base44 SDK/token scan of every code tree (the retired integrity gate's only live check); the runbook and reference-doc lines rewritten. Original plan: retire the Base44 gate cluster + `legacy/` (`architecture_truth_gate.cjs` rewritten to the Render/Supabase truth) | FULL, senior review (`ci-gates` family) | update `.github/workflows/ci.yml` (the `test:base44-canonical-integrity` step), `release_checklist.cjs`, `release_owner_check.cjs`, the classifier rule, `config/release-preflight-gates.json`, the two runbook lines, the `supabase_staging_security_foundation` test (drop only its `.ps1` case); the runtime never depended on it |
| D4 | Product Library schema drop (`products`, `product_images`, `deals.product_id`, `deals.product_snapshot_jsonb`, trigger, constraints; new migration, never an edit of 072; `supabase/staging/025` retired from the grant lists) | FULL, senior review | PR B merged; staging census re-run (2026-09-30: 40 deals, 2 with product columns, both `PendingTarget` smoke deals from 2026-09-17, 1 product, 0 product images) and owner confirmation that those two smoke deals may lose their snapshot; **production is a separate owner-managed database** (PROJECT_STATUS.md PR-5), so before the migration is applied there: either proof from its ledger that 072 was never applied, or a production census (`products`, `product_images`, deals with `product_id` / `product_snapshot_jsonb`) plus an explicit data disposition (export or accepted loss) and owner confirmation for that database — a staging census never authorises the production drop |
| D5 | **IN PROGRESS 2026-10-01 — batch 1 (PR #163):** moved five HISTORICAL Morning Handoff records into `docs/archive/` after zero active-code search hits; contents unchanged, `DOCUMENTATION_MAP` paths updated. `docs/archive/` stays scanned: `scripts/lib/repo_scan_policy.cjs` excludes any `archive` directory, so it gained `INCLUDED_DIR_PATHS = ["docs/archive"]` (secret/PII scan and the repository-wide sweeps cover the moved documents exactly as under `docs/`; tested in `repo_scan_policy.test.cjs`), and `.gitignore` un-ignores `docs/archive/` (a plain `archive/` rule would otherwise hide new files from `git add`). **Batch 2:** five more zero-consumer Morning Handoff records (`ADVERSARIAL_HARDENING`, `BACKEND_PROFESSIONALIZATION`, `PREPROD_TORTURE_QA`, `REAL_INTEGRATIONS`, `ULTIMATE_PRELIVE_QA_RC`), byte-identical. **Batch 3:** the 41 zero-consumer DECISION / ISSUES / LOG companions of those handoffs plus the last five Morning Handoffs (consumer check on the extension-less stem, every file already carries the SUPERSEDED/HISTORICAL marker). Continue only in small consumer-proven batches; trim `PROJECT_STATUS.md` only after concurrent status-owning PRs close. | FAST/STANDARD | none |
| D6 | decision: dormant cloud-agent workflows + `stripe-sandbox-proof.yml` (keep dormant or retire with their tests) | FULL | owner decision |
| later | `/app` legacy shell (`frontend/`) | product decision | owner decision; shared links must keep resolving |

## 5. Supabase finding: `siton.outbox_enqueue_evidence` without RLS

- What it is: the insert-only evidence table of migration 076. An `AFTER INSERT` trigger on
  `outbox_events` (SECURITY DEFINER, owner `postgres`) records every enqueue; the
  `outbox_row_written_in_tx` helper (SECURITY DEFINER) reads it so a state transition can prove its
  outbox job was inserted in the same transaction. A `BEFORE UPDATE` trigger refuses updates. Rows
  older than 30 days are pruned by the same trigger. It is runtime safety, not test or legacy.
- Who can reach it (staging, 2026-09-30): only `postgres` holds privileges. `anon`, `authenticated`
  and `service_role` have no USAGE on schema `siton` and no table privilege; `siton_web_runtime`
  and `siton_worker_runtime` have schema USAGE but no table privilege. 1 row. Not listed by the
  Supabase security advisor (the "RLS disabled" lint covers the `public` schema; the dashboard
  badge is what the owner saw).
- Every other table in schema `siton` has RLS enabled; this one was created with REVOKE-only
  protection.
- Smallest safe fix: forward migration `081_outbox_enqueue_evidence_rls.sql` that enables RLS with
  no policy. Functionally nothing changes: the table owner (also the definer of both 076 functions)
  bypasses RLS, every other role already has no privilege. It only closes the door a future
  accidental GRANT would open, and removes the dashboard badge. Requires the manifest entry,
  `REQUIRED_MIGRATION_IDS`, a test assertion, and application to staging before merge (readiness
  fails closed on a missing manifest migration). Implemented as its own PR.

## 6. Rules for every deletion PR

1. Prove zero consumers with a full-tree search (imports, `package.json`, workflows, preflight gate
   config, compose files, Dockerfile, tests, migration/recovery scripts, runbooks) and paste the
   search in the PR.
2. Never edit an applied migration; schema removal is a new forward migration.
3. Never delete a test to make a suite smaller; delete a test only together with the feature it
   proves, and carry any still-valid assertion into a replacement test.
4. One group per PR. CI green on the head. Independent review + Codex.
5. After merge with runtime impact: confirm both Render services live on the merge SHA and
   `/readiness` 200.
