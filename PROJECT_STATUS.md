# SITON PROJECT STATUS

Updated: 2026-09-17
Canonical branch: `master`
Current merged baseline: `56f5f4a29d8ca84d29910e5d79c522c4e81d8b20` (PR #44)

## CURRENT SNAPSHOT

### COMPLETED

- PR #19 merged: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #22 merged: affiliate visit acknowledgement is emitted only after the recording transaction commits.
- PR #23 merged: isolated Claude/Codex status slots and agent-efficiency v3.
- PR #26 merged: canonical product policy amendment covering finite `max_units`, fixed 24-hour Completion Window, fixed 8% Siton fee, no distributor product role, and no seven-day deal cap.
- PR #27 merged: Claude repository entry point and no-loop Git authorization fallback.
- PR #31 merged: fail-closed distributor attribution-only financial regression guard.
- PR #33 merged: agent workflow v5 refresh with repeated-task branch allocation, focused packets, and start-time push/SHA checkpoint.
- PR #34 merged at `18ba51985f71ebf83563216ec22f88aaa7c023f0`: block-based Site CMS and editable product copy across deal, tracking, seller and support surfaces.
- PR #35 merged at `1d38656950381733cbf2459913be7439038b4ccf`: Cloud Agent Manager reintegrated onto the current product baseline.
- PR #37 Seller Distribution Hub merged at `8bdd401aecef973dbeb65b405bf3e0ffe86a96be` with seller-created attribution links and optional scoped read-only external link dashboards, aggregate analytics only, no buyer PII and no distributor economics.
- Staging deployment failure after PR #37 was diagnosed as missing database migration 070. `070_seller_distribution_links.sql` was applied to Supabase staging; all four required external-viewer tables were verified; Render redeploy `dep-dalsa98ae00c73cf9tbg` reached LIVE on `8bdd401...`.
- Hosted CMS failure `column "draft_jsonb" does not exist` was diagnosed as missing CMS migration 069. `069_site_content_drafts_media.sql` was applied to Supabase staging and the draft/publish columns were verified readable.
- Hosted UX reality audit produced Issue #39 for terminal-deal archive, mature UI cleanup, multi-method receipt/redemption, preview-stage removal and support/deal-context unification.
- LONG_HORIZON_DEALS was promoted to the next blocking integration. Issue #40 is the clean current-master Claude execution packet; old PR #24 is source/provenance only.
- PR #38 integration order was updated: long-horizon owns migration 071; Product Catalog must move to 072 during later current-master reintegration.
- PR #42 merged at `72651b2da2152368b43eb39eabc805257b668f90`: LONG_HORIZON_DEALS rebuilt on current master as migration `071_long_horizon_authorization_renewal.sql`, CMS keeping 069 and the Seller Distribution Hub keeping 070. Old PR #24 was provenance only and is now CLOSED as superseded (verified equivalent apart from the 069->071 renumbering).
- Migration 071 was applied to Supabase staging. The staging ledger, which previously stopped at 068 because 069/070 had been applied as raw SQL without ledger rows, is now in full agreement with the repository manifest: 069/070/071 recorded at positions 62/63/64.
- Canonical documents that still described the seven-day cap as pending were reconciled: the foundation source of truth, the product-policy amendment and the code-cleanup task record it as DONE; the historical spec quote in the already-closed drift map is explicitly marked DEPRECATED rather than rewritten.
- PR #44 merged at `56f5f4a29d8ca84d29910e5d79c522c4e81d8b20`: the last two unmarked seven-day references were marked OBSOLETE.
- PR #38 shelf closeout completed its reintegration onto current master: Product Catalog was renumbered from 071 to 072 (`072_product_catalog_and_fulfillment_estimates.sql`), current master was merged into the branch with the only conflict (`PROJECT_STATUS.md`) resolved in favour of the newer master text, and the temporary `pr38-reconcile-probe.yml` validation workflow was removed now that it has served its purpose.
- Migration 072 is applied to Supabase staging (`product_catalog_and_fulfillment_estimates`, version `20260917142636`), and the Product Catalog runtime grants file `supabase/staging/025_product_catalog_grants.sql` has now been applied on top of it.
- Two real CI failures on the PR #38 head were root-caused and fixed rather than retried:
  - `backend-gates` / distributor attribution-only contract: `scripts/closed_pilot_scenario.cjs` asserts that `affiliate_fee_amount` is **absent** from computed money, and the identifier scanner counted that proof as a violation. The scanner now recognises a negated own-property absence assertion, mirroring its existing `distributor_commission_present: false` allowance, and its self-test was extended with the abuse case: a real reference riding along on the same line still fails.
  - `preflight-database` / `release-tools-tests`: `mobile:sync` (Capacitor) copies the built web bundle into `android/app/src/main/assets/public` and `ios/App/App/public`, and the payment compliance scan walked those generated copies, matching the raw-card term `pan` inside a minified `zoomAndPan` identifier. Because the mobile gate runs before the release-tools tests in the same workspace, the scan passed or failed depending on whether a mobile build had run first. The canonical repo scan policy now excludes those two generated trees by full path, with regression tests.

### TESTED / CHECKED

- PR #37 repository CI was green before merge; its distribution routes reported zero unclassified routes and zero unclassified sensitive routes after the release-tools fixture correction.
- Supabase staging now contains `distribution_link_viewers`, `distribution_link_viewer_grants`, `distribution_link_viewer_sessions`, and `distribution_link_viewer_login_attempts` from migration 070.
- Render staging is LIVE on PR #37 merge SHA `8bdd401aecef973dbeb65b405bf3e0ffe86a96be` after the migration repair.
- Supabase staging `site_content` now contains `draft_jsonb`, `draft_updated_at`, `draft_updated_by`, and `published_at`; a direct read using the new CMS schema succeeds.
- The obsolete seven-day maximum was REMOVED from active seller code by PR #42 (merged `72651b2`): picker, hint, validator, Hebrew error copy, backend validator and legacy `frontend/app.js` all carry no seven-day restriction. A scan of 87 shipped built assets finds no seven-day copy.
- Current seller dashboard still renders terminal deals as full cards instead of a compact archive; current product UI still contains decorative emoji/glyph residues; public support contact still lacks canonical deal/seller context; receipt/redemption remains single-method.
- Old PR #24 source evidence remains: deadline policy 5/5, authorization renewal lifecycle 10/10, worker long-horizon scheduling 4/4. Fresh current-master CI on the replacement PR is authoritative.
- PR #42 CI was green on all six jobs on head `57d6637` (backend-gates, preflight-static, preflight-database, web-runtime-core, web-runtime-resilience, docker-release-lab). The canonical verifier passed release-static, migrations-isolated and route-authorization, with the grouped repository suite at 243/243 test files.
- Staging verification after applying 071: migration high-water `071`, ledger 64 rows all `succeeded`, positions contiguous 1..64 with zero gaps, and a full id/position/filename/checksum comparison against `scripts/migration_manifest.cjs` reporting DRIFT=0. Schema shows 79 tables, all five new binding columns, the `reauthorize` attempt-type constraint, the renewal-shape constraint, the renewal-candidate index and the eligibility trigger.
- Staging Render web is LIVE on the merge SHA (`dep-dalum9vqj5pc73ebfl20`, auto-deployed on commit) and answered `/readiness` with HTTP 200 after migration 071 was applied.
- 30/60/90-day smoke on the merged master build through the real HTTP API: Draft create, deadline persisted exactly, publish, buyer-facing public re-read exact, and all three deals discoverable in the Mall listing. An ordinary 24-hour deal still creates and publishes. Under two hours is still rejected (`deadline_below_minimum`); beyond the technical ceiling is still rejected (`deadline_above_maximum`). 10/10 PASS.
- The same 30/60/90-day and short-deal shapes were exercised against the STAGING database itself inside a rolled-back transaction: all four accepted and stored to the exact instant, with nothing persisted.
- Supabase staging migration high-water is now **072** with no drift. Migration 072 was verified in the live staging database, not assumed: `siton.products` and `siton.product_images` exist; `siton.deals.product_id` and `siton.deals.product_snapshot_jsonb` exist; `siton.deal_delivery_options.estimated_min_business_days` / `estimated_max_business_days` exist; constraints `deals_product_id_fkey`, `deals_product_snapshot_shape_check`, `deals_product_snapshot_presence_check` and the three `deal_delivery_options_estimated_*` checks are present; trigger `trg_deals_product_snapshot_immutable` is installed; indexes `idx_products_seller_status_updated`, `idx_product_images_product_order`, `idx_product_images_storage_ref` and `idx_deals_product_id` are present.
- Product Catalog staging grants verified after application: `siton_web_runtime` holds SELECT/INSERT/UPDATE on `siton.products` and SELECT/INSERT on `siton.product_images`; it holds **no** DELETE, so products are archived and never deleted; `anon`, `authenticated` and `siton_worker_runtime` hold nothing, so the catalogue is not exposed through the Data API. RLS is enabled on both tables with web-runtime-only policies.
- PR #38 head was re-validated locally on a disposable PostgreSQL 16 after the two CI fixes: all 13 `tests/release_tools` files PASS, including the previously failing `raw_card_terms`; `migrations:preflight` PASS at high_water=072 over 65 migrations with fresh install, idempotent rerun, upgrade-from-master drift 0, CRLF-variant acceptance, tampered-checksum refusal, dirty-ledger refusal and both atomic-failure controls; `ci:migrations` PASS; `test:product-catalog` PASS (11 canonical checks plus 9 API checks); `test:pickup-navigation`, `test:visual-brand` and `gate:real-money` PASS; `tsc --noEmit` clean. Static gates PASS: backend enforcement, architecture, payment compliance, runtime DDL, money/tax, legal, secret/PII, logging hygiene, runtime environment, startup config matrix, no-real-money proof, route inventory, repository hygiene, supply chain, docker readiness static, backup/restore rehearsal, health contract, HTTP security smoke, demo build, reproducible build and the mobile PWA gate.
- No test, gate or assertion was weakened to obtain a pass. Both CI fixes narrowed a false positive and each shipped with a regression test that still fails on the real violation.
- REAL MONEY remains 0. Grow remains untouched and unactivated. The smoke created no payment attempt, no reauthorization, no authorization binding, no platform-fee money event and no notification attempt.

### OPEN MERGE / EXECUTION QUEUE

1. ~~Issue #40 — LONG_HORIZON_DEALS on current `master` with migration 071~~ **CLOSED 2026-09-17:** merged as PR #42 (`72651b2`), migration 071 applied to staging, Render staging LIVE on the merge SHA, 30/60/90-day smoke green, PR #24 closed as superseded.
2. PR #38 — reintegration onto current master is complete and both CI failures are fixed. Merge on green CI, confirm `siton-staging-web` reaches LIVE on the new master SHA, then run the hosted smoke: seller login, dashboard, Product Library / Product Catalog, create Product, create Deal from Product, Draft, 30/60/90-day deadlines, absence of any seven-day block, persistence after reload, distribution hub, CMS surfaces, new branding, pickup navigation, and no new 404/401 on central routes.
3. Issue #39 — Claude UX/support lane starts only from the then-current master: terminal-deal archive, remove childish decorative glyphs, multiple receipt/redemption methods, remove standalone preview journey step, unify support with deal/seller context and PII-safe visibility.
4. PR #7 communications — extract only still-missing communications/runtime value on current master; do not merge the stale branch wholesale. See the audit recorded under TESTED / CHECKED.
5. Continue reducing the remaining shelf through current-master PRs, fresh CI, staging deploy and smoke evidence.

### PERCENTAGE

- Agent workflow v5: 100% merged repository-side.
- CMS/product-copy repository integration: 100%; missing staging migration repaired and schema verified. Authenticated CMS browser smoke remains a runtime follow-up.
- Cloud Agent Manager repository integration: 100%; credential activation and harmless computer-off smoke remain operational follow-up.
- Seller Distribution Hub: 100% merged and deployed to staging; authenticated seller end-to-end link-creation smoke remains to be performed.
- Long-horizon current-master integration: 100%. Merged to master (`72651b2`), migration 071 applied to staging with DRIFT=0, staging deployed and smoked at 30/60/90 days. Remaining long-horizon work is outside this track: Grow real-provider stored-instrument re-authorization is an external sandbox gap, not a repository task.
- PR #38 shelf closeout (Product Catalog, mobile readiness, native/PWA branding, acceptance harness, closed-pilot QA tooling, pickup navigation): repository work 100% and locally CI-clean; staging database 100% (migration 072 plus runtime grants applied and verified). Overall ~85% pending merge to master, Render deploy and hosted smoke.
- Hosted UX reality closeout: scoped and queued as Issue #39; implementation not yet merged. 0%.
- PR #7 communications shelf item: audited against current master, not yet reintegrated. 0% merged.
- Real-money readiness: intentionally blocked.

### NEXT STEP

1. Merge PR #38 to master on green CI, confirm `siton-staging-web` deploys the new master SHA and reaches LIVE, and run the hosted staging smoke. Fix, in the same chain, any defect the smoke finds that the repository owns.
2. Audit PR #7 against the resulting master: reintegrate only the genuinely missing communications/UX value, or close it with a documented reason.
3. Execute Issue #39 from the resulting master and drive it through the same CI → master → staging → smoke chain: terminal-deal archive, remove decorative glyph residue, multiple receipt/redemption methods, remove the standalone preview journey step, unify support with deal/seller context and PII-safe visibility.
4. Run an authenticated seller browser smoke against hosted staging from an environment whose egress policy permits `*.onrender.com`. Agent containers so far have been denied CONNECT to that host, so hosted verification has had to fall back to the merged build plus the staging database directly.
5. Do not mark product work complete merely because code exists in a branch or PR; completion requires current master plus applicable staging migration/deployment and smoke evidence.

## PRODUCT POLICY ALIGNMENT

The binding policy source is `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`.

Current invariants:

- Every publishable deal has a finite mandatory `max_units`. Unlimited or `NULL` capacity is non-canonical.
- Completion Window is exactly 24 hours and exists only for failed-charge recovery by eligible participants.
- Siton fee is fixed at 8% of all purchase money actually collected through Siton, including shipping/delivery and other applicable purchase charges, excluding the customer VAT component.
- There is no per-deal fee override.
- There is no distributor/affiliate user role or distributor product module. A seller may create attribution/measurement links and may grant an external viewer scoped read-only access to one link's aggregate dashboard. That viewer receives no buyer PII, seller navigation, Siton-managed commission, balance or payout rights.
- There is no fixed seven-day maximum deal duration. Older seven-day product-deadline references are historical and active code that still enforces them is a defect to remove.
- Current legal material remains unchanged unless the owner explicitly changes it.

## AGENT MILESTONES

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone

- UPDATED: 2026-09-17
- BRANCH: `claude/shelf-heavy-closeout-20260917` (PR #38), with current master `56f5f4a` merged in.
- COMPLETED: PR #38 shelf closeout is reintegrated and unblocked. Scope carried: Product Catalog / Product Library at migration `072_product_catalog_and_fulfillment_estimates.sql`, mobile release readiness, native/PWA C-ton branding, authenticated UI acceptance harness, closed-pilot QA tooling, and pickup navigation including Google Maps + Waze. Migration 072 and its runtime grants (`supabase/staging/025_product_catalog_grants.sql`) are both applied to Supabase staging and verified against the live database — the grants had never been applied and were the real remaining gap. Current master (PR #43 and PR #44) was merged into the branch; the only conflict was `PROJECT_STATUS.md` and it was resolved in favour of the newer master text with the PR #38 facts layered on top. The temporary `pr38-reconcile-probe.yml` workflow was removed. Two genuine CI failures were root-caused and fixed rather than re-run: (1) the distributor attribution-only contract counted an explicit *absence* assertion (`!Object.hasOwn(money, 'affiliate_fee_amount')` in `scripts/closed_pilot_scenario.cjs`) as a violation, and (2) the payment compliance scan walked the Capacitor-synced native web bundles under `android/app/src/main/assets/public` and `ios/App/App/public`, matching the raw-card term `pan` inside a minified `zoomAndPan` identifier — which made that scan's result depend on whether the mobile gate had already run in the same workspace. Superseded legacy work was intentionally not carried. No real money. Grow untouched.
- TESTED: On a disposable local PostgreSQL 16 — all 13 `tests/release_tools` files PASS including the previously failing `raw_card_terms`; `migrations:preflight` PASS at high_water=072 over 65 migrations with fresh install, idempotent rerun, upgrade-from-master drift 0, CRLF-variant acceptance, tampered-checksum refusal, dirty-ledger refusal and both atomic-failure controls; `ci:migrations` PASS; `test:product-catalog` PASS (11 canonical checks including migration 072 shape/constraints and the web-runtime-only grant rule, plus 9 API checks); `test:pickup-navigation`, `test:visual-brand` and `gate:real-money` PASS; `tsc --noEmit` clean. Static gates PASS: backend enforcement, architecture, payment compliance, runtime DDL, money/tax, legal, secret/PII, logging hygiene, runtime environment (all targets), startup config matrix, no-real-money proof, route inventory, repository hygiene, supply chain, docker readiness static, backup/restore rehearsal, health contract, HTTP security smoke, demo build, reproducible build, mobile PWA gate. Supabase staging was verified directly rather than assumed: both catalogue tables, both `deals` product columns, both delivery-estimate columns, all six constraints, the snapshot-immutability trigger, all four indexes, and grants giving `siton_web_runtime` no DELETE while `anon`, `authenticated` and `siton_worker_runtime` hold nothing. Neither CI fix weakened a gate: each narrowed a false positive and shipped with a regression test that still fails on the real violation — a forbidden identifier riding along with an absence assertion, and a genuine `public/` source directory.
- OPEN: The distributor attribution-only contract check could not be executed in this container — the session's auto-mode classifier refuses to run `scripts/distributor_attribution_only_gate.cjs` once that file has been edited. Its syntax is verified and its new matcher was unit-checked against seven positive and negative cases; repository CI runs both the check and its self-test on push and is authoritative. `ci:web-runtime` was likewise not run locally (it needs Docker, which this container does not provide); repository CI covers it. Hosted staging egress (`*.onrender.com`) is denied to this container by the agent proxy, so any hosted browser smoke has to come from an environment that permits it. PR #7 was audited but not reintegrated. Issue #39 was deliberately not touched.
- PERCENTAGE: PR #38 repository implementation 100% and locally CI-clean; staging database 100% (migration 072 plus grants applied and verified); overall ~85% pending merge to master, Render deploy and hosted smoke.
- NEXT STEP: Merge PR #38 on green CI, confirm `siton-staging-web` reaches LIVE on the new master SHA, run the hosted smoke, then act on the PR #7 audit.
<!-- AGENT_STATUS:claude:END -->

Agent slots are intentionally independent. Each coding agent may replace only its own marked block.

<!-- AGENT_STATUS:codex:START -->
### Codex latest milestone

- UPDATED: 2026-09-17
- BRANCH: `master`
- COMPLETED: PR #37 Seller Distribution Hub merged; missing migration 070 was applied to staging; Render redeploy reached LIVE; missing CMS migration 069 was applied and verified; hosted UX/runtime gaps were converted into Issues #39/#40 with collision-safe sequencing.
- TESTED: distribution schema exists; Render is LIVE on `8bdd401...`; CMS draft schema reads successfully; the previously confirmed active seven-day seller restriction was resolved and merged in PR #42 (`72651b2`).
- OPEN: Claude Issue #40 replacement PR, then merge/migration071/deploy/smoke; Issue #39 follows; PR #38 after that with Product Catalog migration 072.
- PERCENTAGE: Distribution Hub merged/deployed 100%; long-horizon current-master integration pending.
- NEXT STEP: integrate Issue #40 output through fresh CI and staging before accepting any later overlapping UX/shelf branch.
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
