# SITON PROJECT STATUS

Updated: 2026-10-04
Canonical branch: `master`
Current runtime baseline: `4acc867` (PR #212 health/readiness route extraction), on top of `1008ec7` (PR #210 documentation-map cleanup) and `7c5c0ed` (PR #202 Mission Control route extraction). Master Siton CI run 424 on `4acc867` completed successfully with no failed jobs. Black Sky Engineering remains **100% closed**; Production Readiness remains a separate owner-driven track and real money remains blocked.
Render staging: canonical services `siton-staging-web` (`srv-daa5o9u7bikc73fgjskg`) and `siton-staging-worker` (`srv-daakn0tg1s2s73dfk3pg`) are both **LIVE on `4acc867`**, directly verified in Render after the green master CI. The web service health check path is `/readiness`. Three legacy services still exist and are not touched by this work.
Supabase staging (`siton-staging`, `hnptacfzuqebfgeshadq`): migration ledger **75/75**, high-water `082` (re-read 2026-10-03); `deal-images` bucket `public=true`, `file_size_limit=10485760`, MIME exactly JPEG/PNG/WebP/MP4/WebM; `storage-broker` ACTIVE v2 (`verify_jwt=false`, broker-key auth).
Agent-platform expansion is frozen until there is a concrete product-delivery need and live provider evidence. PR #211 (CI META audit) was closed without merge after evidence supported **NO CHANGE**; no classifier/workflow/gate change entered master. The health/readiness Lean Refactor slice is complete: replacement PR #212 was rebuilt from current master, merged, master CI is green and both canonical staging services are live on the merge SHA. PR #205 was superseded. Dependabot work remains separate.

History moved out of this file by the Lean Refactor D5 status trim (2026-10-02), verbatim: `docs/archive/PROJECT_STATUS_HISTORY_TO_2026-09-30.md` (former header lines, the 2026-09-22 agent-team snapshot, the 2026-09-18 night closeout and Claude Code milestones up to 2026-09-28).


## TRACKS (owner decision 2026-09-27: two separate percentages)

- **Black Sky Engineering: 100% — CLOSED.** All code fixes merged (#99 `c1c361f`, #117 `f02414b`, #116 `73026b4`); CI green on master `73026b4`; the latest Codex review of each final head is clean (#117 `26a6f82`, #116 `1534bde`); migrations 077–079 + grant file 027 applied to staging (ledger 72/72); staging live and checked on `73026b4`; recovery / failure / money / DB suites pass (314 files / 0 failures, `RECOVERY_PROOF_PASS`, `DB_BACKUP_RESTORE_REHEARSAL_PASS`). No further hardening, adversarial round or scope expansion on this track unless a new concrete finding appears.
- **Production Readiness: 21% (6 of 28 items done) — OPEN, owner-driven.** External actions, not code changes. Items marked **REAL MONEY LAUNCH BLOCKER** (12 open) must be closed before any real charge; real-money activation stays BLOCKED by policy until then. By owner decision these deployment/provisioning actions (incl. report E1 CRIT off-site backups and E5 HIGH storage broker, whose code is done) are the scope of this track, not completion criteria of Black Sky Engineering.

### Production Readiness checklist

| # | Item | Status | Class |
|---|---|---|---|
| PR-1 | Staging DB: 077–082 + `supabase/staging/027`–`028` | DONE (ledger 75/75; 080 = admin provisioning, 081 = RLS on `outbox_enqueue_evidence`, applied 2026-09-30; 082 = Product Library schema retirement, applied 2026-10-01 with the owner-approved staging disposition) | — |
| PR-2 | `SUPABASE_MANAGEMENT_API_TOKEN` absent on Render | DONE (boot guard passed) | — |
| PR-3 | Render deploys gated on CI (`checksPass`) | DONE | — |
| PR-4 | Production env: `OTP_TOKEN_SECRET` (≥32 random chars), `OTP_HASH_SALT` (random, not the public default; also still missing on both staging services) and `SITON_OWNER_AUTH_USER_ID` on the production web/worker — production refuses to boot without them (`src/production_guards.ts`) | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-5 | Production DB: apply 077–081 + grant files 027–028 (owner-authorized schema change); deploy `admin-provisioner` and set `SITON_ADMIN_PROVISIONER_KEY` on the production web. **Note (C2, 2026-10-01):** `npm run db:migrate` now also runs `082_retire_product_library_schema.sql`, and master builds require it; on a database with Product rows or Product-backed Deals 082 refuses until a production census, an owner-approved data disposition and backup/rollback evidence exist and the apply carries `siton.product_library_c2_disposition = 'accepted'`; Product image rows are refused always. **A runner refusal leaves a `failed` 082 ledger row, which turns the LIVE production `/readiness` red (503, web restarts, a restarted worker blocks) until `npm run migrations:repair -- --clear-failed 082 --i-verified-no-partial-effects --allow-hosted --yes`.** So on production apply 077–081 alone first, and 082 only after the census and disposition, as on staging: file SQL + `SET LOCAL siton.product_library_c2_disposition = 'accepted'` + ledger INSERT in ONE transaction (a refusal then rolls back with no ledger row); if the flag is ever set with `ALTER DATABASE`, `RESET` it afterwards | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-6 | Off-site backups: provision `OFFSITE_BACKUP_*` secrets, keep the age identity offline, run once → `OFFSITE_BACKUP_PASS`, then one verified restore | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-7 | Hosted backups checklist: plan/PITR, retention, last backup, restore ever done, who can restore (with MFA) | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-8 | Backup path for `auth.users` and Storage objects | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-9 | MFA on the Supabase, Render, GitHub and Grow owner accounts; backup bucket on a separate account | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-10 | Second SuperAdmin with a separate MFA device (dual approval for payout freeze/unfreeze, emergency pause, payout attestation) | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-11 | Alert routing for `worker_alert:*` (a human is paged for money cases) | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-12 | Decision: handling of a partly charged deal whose charge retries are exhausted | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-13 | Grow: provider contract for real money resolved (F-13) and live-mode verification performed (policy reasons `F13_PROVIDER_CONTRACT_UNRESOLVED`, `GROW_LIVE_VERIFICATION_NOT_PERFORMED`) | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-14 | Supabase "Confirm email" on | OPEN | launch prerequisite |
| PR-15 | `SITON_BROKER_ALLOWED_PREFIXES` set and `storage-broker` edge function redeployed (report E5, HIGH: code fixed, deploy pending) | OPEN | launch prerequisite (security) |
| PR-16 | GitHub: Dependabot security updates on, required checks kept on master | OPEN | recommended |
| PR-17 | WAF/CDN in front of Render | OPEN | recommended |
| PR-18 | Delete the three legacy Render services (`siton-staging-web-atp1`, `siton-demo-preview-atp1`, `siton-demo-preview`): manual owner action, exact steps in `docs/LEAN_REFACTOR_MAP_2026-09-30.md` §2; re-verified 2026-10-01: all three still auto-deploy on every `master` commit and fail (`update_failed`) | OPEN | cleanup |
| PR-19 | Clear `ADVERSARIAL_REVIEW_NOT_PERFORMED` in `config/real-money-release-policy.json` with dated evidence (owner decides whether the red-team and Black-Sky reports suffice or a further review is required) | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-20 | Owner approval of production payment activation (`PRODUCTION_PAYMENT_ACTIVATION_NOT_APPROVED`), then the separately reviewed commit that flips the policy to `ALLOWED` with evidence for every reason (`docs/REAL_MONEY_RELEASE_GOVERNANCE.md`); runtime variables are set only after that | OPEN | **REAL MONEY LAUNCH BLOCKER** |
| PR-21 | Render web plan (currently `free`, hibernates) and Supabase Site URL decisions for launch | OPEN | launch prerequisite |
| PR-22 | Decide whether Base44 remains an intended runtime (`scripts/release_checklist.cjs` O-4) | DONE (2026-09-30: Base44 is historical, never a runtime — `docs/CURRENT_ARCHITECTURE_2026-09-30.md`; retiring the gate cluster that still asserts `production=base44` is Lean Refactor step D3) | — |
| PR-23 | Confirm the production seller-approval step (`verification_status='approved'` required to publish, else `409 seller_kyc_not_approved`) and staff an approval process (`docs/SELLER_ONBOARDING_KYC.md`) | OPEN | launch prerequisite |
| PR-24 | Hosted browser proofs (seller journey, buyer join, admin) re-run against the deployed launch SHA | OPEN | launch prerequisite |
| PR-25 | Owner acknowledges the runbooks: deployment, rollback, payment incident, security incident, database incident | OPEN | launch prerequisite |
| PR-26 | Mobile store placeholders (`SITON_APP_ID`, app link host, signing credentials) — store build only | OPEN | recommended |
| PR-27 | Render worker start command `node .demo_dist/src/worker.js` (SIGTERM drain) | DONE (live on the worker service) | — |
| PR-28 | Production image without the dev toolchain (`npm prune --omit=dev`) | DONE (Dockerfile; docker-release-lab green) | — |

This list reconciles every open item of `scripts/release_checklist.cjs`; its per-release gates (Docker lab green and all workflows green for the exact launch SHA) are checked at the Launch Gate itself. Detail per item: `docs/archive/BLACK_SKY_FINAL_REPORT.md` §7–§8, `docs/BACKUP_RESTORE_RUNBOOK.md`, `docs/CREDENTIAL_COMPROMISE_RUNBOOK.md`, `docs/CONFIG_INVENTORY.md`. Next step: the owner works the REAL MONEY LAUNCH BLOCKERs, then the Launch Gate.

## PRODUCT POLICY ALIGNMENT

The binding policy source is `docs/SITON_PRODUCT_CONSTITUTION_2026-09-30.md` (owner decisions of 2026-09-30), then `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`. Runtime: `docs/CURRENT_ARCHITECTURE_2026-09-30.md`. Document tiers: `docs/DOCUMENTATION_MAP.md`.

Added 2026-09-30: no Product Library (removal in progress); the Mall exists but is hidden for the current launch; distribution links are analytics/attribution only; Base44 is historical.

Current invariants:

- Every publishable deal has a finite mandatory `max_units`. Unlimited or `NULL` capacity is non-canonical.
- Completion Window is exactly 24 hours and exists only for failed-charge recovery by eligible participants.
- Siton fee is fixed at 8% of all purchase money actually collected through Siton, including shipping/delivery and other applicable purchase charges, excluding the customer VAT component.
- There is no per-deal fee override.
- There is no distributor/affiliate user role or distributor product module. A seller may create attribution/measurement links and may grant an external viewer scoped read-only access to one link's aggregate dashboard. That viewer receives no buyer PII, seller navigation, Siton-managed commission, balance or payout rights.
- There is no fixed seven-day maximum deal duration. Older seven-day product-deadline references are historical and active code that still enforces them is a defect to remove.
- Current legal material remains unchanged unless the owner explicitly changes it.

## AGENT MILESTONES

### ChatGPT latest milestone — Lean Refactor: admin operational status reads extracted (2026-10-06)

- BRANCH / PR: `chatgpt/admin-operational-status-routes-20261005`, PR #239. Scope is exactly three read-only GET routes: `/api/admin/outbox-status`, `/api/admin/notifications-status`, `/api/admin/invoice-status`. Admin mutations, payout reads and system-ops reads are out of scope.
- COMPLETED (code): moved the original contiguous 300-line block byte-for-byte from `src/frontend_runtime.ts` into `src/admin_operational_status_routes.ts` and wired `registerAdminOperationalStatusRoutes` once at the original registry position, after compute-upgrade and before payout-status. No SQL, auth ordering, thresholds, response shape, provider summary or transaction boundary changed. `frontend_runtime.ts` is 8,540 → 8,251 lines by newline count and 128 → 125 direct route registrations.
- COMPLETED (coverage): added the module to `scripts/web_route_inventory.cjs`, `REFUND_READINESS_ROUTE_MODULES`, legal/money gates, release-tool fixtures and every relevant source-concatenation / route-file census touched by the moved text. The moved block remains covered instead of silently disappearing from static gates.
- COMPLETED (tests): added `admin_operational_status_routes_extraction_validation.ts` (registration/order, exact wiring dependencies, admin-read guard, invoice schema check, read-only/no-side-effect rules, response-surface pins and targeted mutants) and `admin_operational_status_read_validation.ts` (401 before DB reads; outbox counts/ages/worker signal; notification provider fallback; invoice provider/webhook/reconcile summaries; SELECT-only fake DB).
- FIXED DURING CI: the first CI pass exposed two TypeScript defects introduced by the extraction: explicit `undefined` values under `exactOptionalPropertyTypes`, and an invalid `assert.throws` overload in the mutant harness. Both were fixed; Docker/route-contract failures were cascading from that compile failure.
- TESTED (pre-final-base): exact head `793fbc0` passed Siton CI run 512, including all lanes and `ci-verdict`. The API lane explicitly passed both new tests: `ADMIN_OPERATIONAL_STATUS_READ_PASS` and `ADMIN_OPERATIONAL_STATUS_ROUTES_EXTRACTION_PASS`. The moved handler block was also compared byte-for-byte with master `493e01f`: exact match, 17,584 characters / 300 lines.
- REVIEW: an early Codex money/security/auth review was requested on `793fbc0`; final review is still required after this lifecycle/status commit, so any earlier verdict is not merge authority.
- BEHAVIOUR: intended none. Read-only extraction only; no migration, real money, refund, payout, provider activation, auth-policy or production mutation.
- OPEN: current-base CI on the final head, final Codex review, merge, master CI, staging web/worker verification and status closeout.
- PERCENT: 80%.
- NEXT: mark PR #239 ready, require green CI + clean Codex on the final head against current master, then merge and verify staging before closing at 100%.

### ChatGPT latest milestone — Demo Readiness threshold regression suite closeout (2026-10-06)

- COMPLETED: `tests/demo_readiness_thresholds_validation.ts` pins the existing read-only `GET /api/admin/demo-readiness` safety boundaries: one DLQ row blocks; 3600s pending age does not warn while 3601s does; `environment.demo_preview` echoes the injected runtime flag; readiness executes no payment or payout provider operation.
- COMPLETED (focused gate): `npm run test:demo-readiness` runs both the original readiness validation and the threshold regression suite.
- TESTED (PR head): PR #238 exact head `c23e75a` passed Siton CI run 506 after a clean rerun of the previously cancelled jobs, including `ci-verdict`; Mobile canonical/static readiness run 211 passed; Codex reviewed exact head `c23e75a` and found no major issues, and the automatic Codex re-review workflow rerun passed.
- MERGED: PR #238 squash-merged as `19c9a0c20a908d9dc7ae447793dfb1bca9ed3f73`.
- BEHAVIOUR: test-only. No runtime, DB, migration, money, payment, provider, auth, UX or API-contract change; no staging redeploy is required.
- TESTED (master): Siton CI run 513 on `19c9a0c20a908d9dc7ae447793dfb1bca9ed3f73` passed all 18 jobs, including preflight-database and `ci-verdict`.
- OPEN: none for this demo-readiness follow-up.
- PERCENT: 100%.
- NEXT: continue PR #239 (admin operational status read extraction) against the current master.

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone — Lean Refactor closure: #239 merged, census done, closure tasks in flight (2026-10-12)

- UPDATED: 2026-10-12
- PR #239 (ChatGPT's admin operational status extraction): merged as `868a746` after a master merge (`PROJECT_STATUS.md` conflict only) and the fix for an unhandled Codex P2 (`scripts/money_tax_invoice_gate.cjs` `distributorSurface` had dropped the new module; fixture mutation added). Codex clean on the final head `ec00248`; master Siton CI run 545 green; Render web (`dep-db691lavcj2c73fcehmg`) + worker (`dep-db691lavcj2c73fcei4g`) live on `868a746`; staging `/readiness` 200; no error logs. This supersedes the "80% / OPEN" lines of the ChatGPT #239 entry above.
- CLOSURE CENSUS: `docs/LEAN_REFACTOR_MAP_2026-09-30.md` §9 (merged in #247 `e5e0999`). No dead runtime module, no unused dependency, no Base44 runtime code, no canonical-doc contradiction. Mandatory closure set approved by the owner 2026-10-12: F1 one shared route-module registry; F2 `PROJECT_STATUS.md` trim + `AI_WORKFLOW.md` §14 alignment.
- F2 — DONE: Claude slot trimmed in #247 (356 lines moved verbatim to `docs/archive/PROJECT_STATUS_CLAUDE_HISTORY_2026-09-30_TO_2026-10-05.md`; file 553 → ~200 lines). `AI_WORKFLOW.md` §14 now says "replace your own slot" (this PR, #248): the automated slot writers replace without archiving, and verbatim archival is a deliberate maintenance step for entries with evidence value, not a routine rule.
- F1 — IMPLEMENTED, PR pending: `scripts/lib/route_modules.cjs` (ROUTE_MODULES 14, FRONTEND_RUNTIME_FAMILY 8) + `tests/helpers/route_sources.ts`; 13 inline family concatenations, 9 extraction-test sibling lists, the admin mutation inventory, spec-drift wave 3, legacy isolation, security hardening, 3 release-tool fixtures and the three gates (route inventory, legal, money) read the registry; new `tests/route_module_registry_validation.ts` (registry == `REFUND_READINESS_ROUTE_MODULES`, every `src/*_routes.ts` listed, an unlisted probe fails it). No assertion changed; route inventory output byte-identical; every touched test, the gates, release-tools 426/426 and lint pass locally. Opens as the next PR on this branch after #248 merges (local commit `1f2e8c0`).
- BEHAVIOUR: none. No DB, migration, money, auth, provider or API-contract change in any of these PRs.
- OPEN: F1 PR (CI + Codex + merge). PR-18 (three legacy Render services) unchanged: re-verified 2026-10-12, still build and fail on every master commit (`update_failed`) — owner dashboard action.
- PERCENT: Lean Refactor ≈95%: census done, F2 done, F1 implemented and verified locally, not yet merged.
- NEXT: merge #248, open and merge the F1 PR, then record Lean Refactor CLOSED and move to Production Readiness (owner-driven checklist, 21%).

Earlier Claude Code milestones (2026-09-30 to 2026-10-05) moved verbatim to `docs/archive/PROJECT_STATUS_CLAUDE_HISTORY_2026-09-30_TO_2026-10-05.md` (2026-10-12).

<!-- AGENT_STATUS:claude:END -->

Agent slots are intentionally independent. Each coding agent may replace only its own marked block.

<!-- AGENT_STATUS:chatgpt:START -->
### ChatGPT active Lean Refactor — seller images merged, renderer deletion rebased

- UPDATED: 2026-10-04
- COMPLETED:
  - PR #215 merged to `master` as `ec084934107b344d12879bd54b57c836b291ea4d`: seller deal-image upload/reorder/delete routes extracted from `src/app.ts` into `src/seller_deal_image_routes.ts`. Exact PR-head CI #434 was green; Claude senior re-review was clean; merge commit records Codex clean on the final head.
  - Renderer-deletion work rebuilt from exact new master on isolated branch `chatgpt/delete-dead-legacy-renderers-v2`, avoiding the status conflict of old PR #216.
  - Seven no-dispatcher legacy renderers are removed from `frontend/app.js`; completed-deal Excel export is preserved on live `renderCtonSellerDealPage`; payment hold-copy assertions target live `renderCtonPaymentPage`; `renderTrackingPage` remains pending §8.2.
- TESTED:
  - #215 PR head: Siton CI #434 SUCCESS and senior review clean.
  - Renderer deletion: prior CI exposed two real gaps; both were fixed by preserving behavior/coverage, not by weakening gates. The rebased v2 still requires a fresh exact-head CI and review.
- OPEN:
  - #215 post-merge closeout: master CI on `ec084934` and canonical Render web/worker on the same SHA are not yet verified; do not call the slice 100% until both are true.
  - Renderer deletion v2: PR, exact-head CI, independent review, merge, master CI and staging verification.
  - Tracking document-visibility + cumulative-chart gaps remain an explicit owner/product decision.
- PERCENT:
  - #215 slice: 95% (merged; post-merge CI/deploy verification open).
  - Renderer deletion v2: 80% (code/gap preservation/rebase done; final PR gates open).
- NEXT:
  - Verify master CI + Render exact SHA for #215.
  - Replace superseded #216 with the rebased v2 PR and require fresh exact-head review + CI before merge.
<!-- AGENT_STATUS:chatgpt:END -->


<!-- AGENT_STATUS:codex:START -->
### Codex latest milestone — post-PR #87 cleanup complete

- UPDATED: 2026-09-25
- MERGED: PR #88 into master as `e4136a8`.
- COMPLETED:
  - Removed the accidentally tracked root `node_modules` symlink; `.gitignore` continues to exclude `node_modules/`.
  - Closed the repository-hygiene blind spot so both a root `node_modules` entry and files below `node_modules/` fail the hygiene gate.
  - Root-caused PR #87's intermittent E2E failure to Chromium startup rather than product behavior.
  - Hardened every active browser E2E Chromium launch path: OS-assigned debugging port, `DevToolsActivePort` discovery, bounded startup deadline, early-exit detection, Chromium stderr diagnostics and temporary-profile cleanup. Existing per-suite browser flags were preserved.
- TESTED:
  - PR #88: all 6 checks green on the final head.
  - `backend-gates`: green without a rerun.
  - E2E: `passed=17 failed=0` in 219814ms on the first run.
  - TypeScript, lint, product contracts, migrations, unit, integration, DB, API, workers, payments, protected-route authorization, security, concurrency and failure suites all passed before E2E.
  - Master verification after merge: root `node_modules` entry is absent.
- OPEN: none from PR #87's two cleanup items. Open PRs #70, #71, #78 and #79 remain separate parallel work and were not modified by this cleanup.
- PERCENTAGE: 100%.
- NEXT STEP: no further action for this cleanup. Continue only with the independent open workstreams.
<!-- AGENT_STATUS:codex:END -->

<!-- AGENT_STATUS:cloud-manager:START -->
### Cloud Agent Manager latest milestone

- UPDATED: 2026-09-17
- BRANCH: `master`
- BUILDER: manager infrastructure from PR #35
- REVIEWER: repository integration completed
- COMPLETED: GitHub-hosted orchestration, serialized writer queue, provider selection, task packets, builder lifecycle/control-plane guards, bounded review/fix cycle, canonical verification, dedicated autonomous Git lifecycle token path, isolated status ownership and PR creation are merged on master.
- TESTED: repository integration completed through PR #35; no product runtime, database, payment or Grow behavior was changed by that merge.
- OPEN: configure the required minimal credentials and execute one harmless computer-off smoke task.
- PERCENTAGE: 100% repository-side; operational activation pending.
- NEXT STEP: perform credential activation and harmless cloud smoke without enabling real money or Grow.
<!-- AGENT_STATUS:cloud-manager:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is fixed at 8% of the full collected purchase amount including delivery and other applicable purchase charges, excluding the customer VAT component.
- No per-deal commission-rate override.
- Every publishable deal has a finite mandatory `max_units`; no unlimited or `NULL` capacity.
- Completion Window is fixed at exactly 24 hours and only serves failed-charge recovery for `ChargeFailedCompletion` participants.
- No distributor/affiliate product role, commission, balance, payout rail, or separate distributor product module. Seller-created attribution links and a scoped read-only aggregate dashboard for an external link viewer are allowed without exposing buyer PII or creating platform economics.
- No fixed seven-day maximum deal duration.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, security, and 90% success rules remain safety boundaries.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, `PROJECT_STATUS.md` update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.
