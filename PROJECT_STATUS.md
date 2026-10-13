# SITON PROJECT STATUS

Updated: 2026-10-13
Canonical branch: `master`
Current runtime baseline: `3ea541e` (PR #217, hosted-backup posture evidence), on top of `4285eb2` (PR #250, Lean Refactor closure record) and `6375956` (PR #249, the shared route-module registry). Master Siton CI run 566 (38356898210) on `3ea541e` and run 564 (38355727272) on `4285eb2` both completed successfully with no failed jobs. Black Sky Engineering remains **100% closed**; **Lean Refactor is CLOSED (2026-10-12, record merged 2026-10-13 as `4285eb2`)**; Production Readiness is the active owner-driven track (21%, 6 of 28; 12 open REAL MONEY LAUNCH BLOCKERS) and real money remains blocked.
Render staging: canonical services `siton-staging-web` (`srv-daa5o9u7bikc73fgjskg`) and `siton-staging-worker` (`srv-daakn0tg1s2s73dfk3pg`) are both **LIVE on `3ea541e`** (`dep-db6t1p6q1p3s73emsq10`, `dep-db6t1p6q1p3s73emsqi0`, 2026-10-13 06:34Z; before that on `4285eb2`, `dep-db6ssdcs728c7399f5tg` / `dep-db6ssdcs728c7399f6i0`), directly verified in Render after the green master CI; staging `/readiness` 200 on each new instance (Render app log, 06:23:18Z and 06:34:46Z); no error- or fatal-level logs; worker heartbeat `dlq_count=0`. The web service health check path is `/readiness`. Three legacy services still exist (PR-18, owner dashboard action; `siton-demo-preview` rebuilt again on the 2026-10-13 master commit) and are not touched by this work.
Supabase staging (`siton-staging`, `hnptacfzuqebfgeshadq`, eu-central-1, PostgreSQL `17.6.1.166`, organisation plan **Free / `tier_free`**): migration ledger **75/75**, high-water `082` (re-read 2026-10-13); `deal-images` bucket `public=true`, `file_size_limit=10485760`, MIME exactly JPEG/PNG/WebP/MP4/WebM; `storage-broker` ACTIVE v2 (`verify_jwt=false`, broker-key auth). Backup posture 2026-10-13: **no copy of this database outside Supabase was observed or proven** — the repository's off-site workflow still exits `OFFSITE_BACKUP_SKIPPED` and the Free plan includes no hosted daily backup; a manual export held elsewhere cannot be ruled out from the repository or the connectors; detail in the Claude slot and `docs/BACKUP_RESTORE_RUNBOOK.md`.
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
| PR-6 | Off-site backups: provision `OFFSITE_BACKUP_*` secrets, keep the age identity offline, run once → `OFFSITE_BACKUP_PASS`, then one verified restore. **Verified 2026-10-13:** the scheduled workflow still exits with `OFFSITE_BACKUP_SKIPPED` (run 15, 2026-10-12, every backup step skipped: the five secrets are absent), so no off-site copy produced by this workflow exists (an older or manual export elsewhere is not observed and not ruled out from here); the workflow's `pg_dump` default was `16` against the PostgreSQL 17 server and would have failed the first real run — fixed to `17` (2026-10-13). Remaining: the five secrets (OWNER ACTION, names in `docs/BACKUP_RESTORE_RUNBOOK.md` §3), one manual run, one decrypt-and-restore drill | OPEN — tooling ready, 0 runs | **REAL MONEY LAUNCH BLOCKER** |
| PR-7 | Hosted backups: **VERIFIED 2026-10-04, re-verified 2026-10-13** staging org is Free (`tier_free`), so Supabase automatic daily backups/PITR are not a recovery layer we may rely on today; no hosted backup object/restore point was observed. Still OPEN: owner decision on paid backup/PITR, retention, restore authority/MFA, and any first hosted restore evidence. | OPEN — current hosted layer unavailable | **REAL MONEY LAUNCH BLOCKER** |
| PR-8 | Backup path for `auth.users` and Storage objects. **Read-only census 2026-10-04, identical on 2026-10-13:** 9 Auth users (7 have signed in; newest 2026-09-28); 1 Storage bucket; 49 objects; 19,003,844 bytes (newest object 2026-10-02); all 48 `siton.deal_images` rows have their object, 3 objects have no row. Current app-schema dump covers neither Auth nor Storage object bytes, so separate recovery tooling remains required. | OPEN — gap verified, tooling not complete | **REAL MONEY LAUNCH BLOCKER** |
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

**Production Readiness evidence 2026-10-04 (re-verified 2026-10-13, no change in the 6/28 count):** PR-7 plan posture is now verified (Free / no hosted-backup layer to rely on), and PR-8 has a measured non-empty Auth/Storage gap. Neither item is complete; this evidence narrows the next action without changing the 6/28 completion count. PostgreSQL is 17.6; the off-site workflow's `pg_dump` default is `17` since 2026-10-13. A repository variable `OFFSITE_BACKUP_PG_MAJOR` still overrides that default, and the Actions variables API is not readable from the lead's session (proxy 403), so before the first real PR-6 run the owner confirms the variable is absent or ≥ 17 (Settings → Secrets and variables → Actions → Variables).

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

Two ChatGPT entries that sat here outside any agent slot (PR #239 extraction, 80%/OPEN at the time — merged as `868a746`; demo-readiness threshold closeout, 100%) moved verbatim to `docs/archive/PROJECT_STATUS_OUT_OF_SLOT_ENTRIES_2026-10-06.md` (2026-10-12).

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone — Lean Refactor formally closed; Production Readiness backup census (2026-10-13)

- UPDATED: 2026-10-13
- MERGED: PR #250 (Lean Refactor closure record) as `4285eb2` — final head `6084c34`, all four Codex threads resolved, Codex "Didn't find any major issues" on that head, PR Siton CI run 563 (38235632545) green; master run 564 (38355727272) green; Render web `dep-db6ssdcs728c7399f5tg` + worker `dep-db6ssdcs728c7399f6i0` LIVE on `4285eb2`, `/readiness` 200 at 06:23:18Z, no error/fatal logs. **Lean Refactor: 100%, CLOSED, recorded on master.** PR #217 (ChatGPT's hosted-backup posture evidence) as `3ea541e` — content head `810914a` Codex clean (CI run 451); the branch was synced to master with a merge commit only (`5d11a98`, no history rewrite), PR CI run 565 (38356044289) green; every figure in it was re-read live from Supabase on 2026-10-13 06:18Z before the merge and was identical; master run 566 (38356898210) green; Render web `dep-db6t1p6q1p3s73emsq10` + worker `dep-db6t1p6q1p3s73emsqi0` LIVE on `3ea541e` (06:34Z), `/readiness` 200 at 06:34:46Z, no error/fatal logs.
- BACKUP CENSUS 2026-10-13 (read-only, through the Supabase and Render connectors; nothing changed on either): organisation plan `free` / `tier_free`; project ACTIVE_HEALTHY, PostgreSQL `17.6.1.166`; database 23,538,835 bytes (`siton` 82 tables / 7.2 MB, `siton_inventory` 5 / 0.6 MB, `auth` 27 / 1.7 MB, `storage` 8 / 0.5 MB); 40 deals, 83 participants, 13 seller accounts, 43 payment attempts, 393 audit rows; `auth.users` 9; bucket `deal-images` 49 objects / 19,003,844 bytes; `deal_images` 48 rows, each with its object, 3 orphan objects. Off-site workflow: run 15 (38227888500, 2026-10-12 02:17 UTC schedule) exited 0 with `OFFSITE_BACKUP_SKIPPED`, every dump/encrypt/upload step skipped — **no copy of the database, the Auth users or the Storage objects outside the Supabase project was observed or proven: the two configured layers (repository off-site workflow, Supabase plan backups) produced none, the connector exposes no backup listing, and a manual export held elsewhere cannot be ruled out from here**. The only proven restore path is still the local rehearsal (`npm run db:backup-restore-rehearsal`), which proves the procedure, not any hosted backup. Supabase security advisor: 0 ERROR; WARN `function_search_path_mutable` ×16 (trigger/validator functions), WARN leaked-password protection off (Auth); INFO RLS-without-policy ×7 (REVOKE-only tables, intended).
- FIXED (this PR): `.github/workflows/offsite-db-backup.yml` default `OFFSITE_BACKUP_PG_MAJOR` `16` → `17` (a 16 `pg_dump` refuses a 17 server, so the first real run would have failed even with the secrets in place); `docs/BACKUP_RESTORE_RUNBOOK.md` §3 row aligned. No other code change. `tests/release_tools/offsite_db_backup_workflow.test.cjs` passes locally on this PR's head (`# pass 8 / # fail 0` on `45410f6` and `f15d218`; the CI run on the merge head is the immutable record, see the PR). It pins the safety properties, not the version. Caveat: a repository variable `OFFSITE_BACKUP_PG_MAJOR` overrides the default; the Actions variables API is blocked for this session (403), so its absence is an owner check, not a verified fact.
- NOT VERIFIABLE FROM HERE (unknown, not "no"): MFA on the Supabase / Render / GitHub / Grow owner accounts (PR-9); who can trigger a hosted restore; whether any hosted backup object exists (the connector exposes no backup listing; on the Free plan none is expected); a second SuperAdmin (PR-10). The staging URL is unreachable from this container's network policy, so `/readiness` was read from the Render request log instead of a direct probe.
- PR-18: unchanged — `siton-demo-preview` (`srv-d77p6tgule4c73denj7g`) rebuilt again on both 2026-10-13 master commits and failed both times (`dep-db6sp4ss728c7399bur0` on `4285eb2`, `dep-db6sv4bm8hqs73f1jn40` on `3ea541e`, status `update_failed`); the three legacy services remain an owner dashboard deletion.
- OPEN (owner actions, in order of data-loss risk): PR-6 provision the five `OFFSITE_BACKUP_*` secrets (read-only DB role, age public key, bucket + write credential on a separate account) and run the workflow once → `OFFSITE_BACKUP_PASS`, then the decrypt-and-restore drill (§5); PR-7 decide paid plan / PITR / retention (cost decision) or accept "layer B or nothing"; PR-8 approve building the Auth + Storage export (engineering, after PR-6 has a bucket to write to); PR-9 MFA + separate backup account. Nothing on this track closes without those decisions.
- PERCENT: Production Readiness 21% (6 of 28, unchanged; no checklist item closed today). Backup sub-track: PR-6 tooling 100% / executed 0%; PR-7 posture verified, decision open; PR-8 gap measured, tooling 0%.
- NEXT: owner provisions the PR-6 secrets (names only in `docs/BACKUP_RESTORE_RUNBOOK.md` §3) and triggers "Off-site database backup" once; the lead then verifies `OFFSITE_BACKUP_PASS` and proposes the PR-8 Auth/Storage export as a reviewed PR.

Earlier Claude Code milestones (2026-09-30 to 2026-10-05) moved verbatim to `docs/archive/PROJECT_STATUS_CLAUDE_HISTORY_2026-09-30_TO_2026-10-05.md` (2026-10-12); the 2026-10-12 closure entry is reproduced in `docs/LEAN_REFACTOR_MAP_2026-09-30.md` §9.4 and commit `4285eb2`.

<!-- AGENT_STATUS:claude:END -->

Agent slots are intentionally independent. Each coding agent may replace only its own marked block.

<!-- AGENT_STATUS:chatgpt:START -->
### ChatGPT — slot awaiting its next entry (2026-10-12)

- The previous entry ("active Lean Refactor — seller images merged, renderer deletion rebased", 2026-10-04) was fully superseded by the merges of #239 (`868a746`) and the Lean Refactor closure (#247/#248/#249); it moved verbatim to `docs/archive/PROJECT_STATUS_CHATGPT_SLOT_HISTORY_TO_2026-10-04.md` (2026-10-12). ChatGPT replaces this slot with its next milestone.

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
