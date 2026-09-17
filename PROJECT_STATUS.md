# SITON PROJECT STATUS

Updated: 2026-09-17
Canonical branch: `master`
Current merged baseline: `8bdd401aecef973dbeb65b405bf3e0ffe86a96be`

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

### TESTED / CHECKED

- PR #37 repository CI was green before merge; its distribution routes reported zero unclassified routes and zero unclassified sensitive routes after the release-tools fixture correction.
- Supabase staging now contains `distribution_link_viewers`, `distribution_link_viewer_grants`, `distribution_link_viewer_sessions`, and `distribution_link_viewer_login_attempts` from migration 070.
- Render staging is LIVE on PR #37 merge SHA `8bdd401aecef973dbeb65b405bf3e0ffe86a96be` after the migration repair.
- Supabase staging `site_content` now contains `draft_jsonb`, `draft_updated_at`, `draft_updated_by`, and `published_at`; a direct read using the new CMS schema succeeds.
- Current active seller code was rechecked and still contains the obsolete seven-day maximum in the picker, hint and validator. This is a real current-master defect, not cache.
- Current seller dashboard still renders terminal deals as full cards instead of a compact archive; current product UI still contains decorative emoji/glyph residues; public support contact still lacks canonical deal/seller context; receipt/redemption remains single-method.
- Old PR #24 source evidence remains: deadline policy 5/5, authorization renewal lifecycle 10/10, worker long-horizon scheduling 4/4. Fresh current-master CI on the replacement PR is authoritative.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

### OPEN MERGE / EXECUTION QUEUE

1. Issue #40 — Claude rebuilds LONG_HORIZON_DEALS from current `master`, preserving current CMS + Distribution Hub, using migration 071, full renewable-authorization behavior and fresh CI. ChatGPT retains final merge/deploy authority.
2. After the replacement long-horizon PR is green: merge, apply migration 071 to staging, confirm Render LIVE and smoke 30/60/90-day seller deadlines. Close old PR #24 as superseded.
3. Issue #39 — Claude UX/support lane starts only from the then-current master: terminal-deal archive, remove childish decorative glyphs, multiple receipt/redemption methods, remove standalone preview journey step, unify support with deal/seller context and PII-safe visibility.
4. PR #38 — clean reintegration only after the above; Product Catalog migration becomes 072. Preserve useful product catalog/mobile/native-brand/acceptance-harness work without blind-merging the stale branch.
5. PR #7 communications — extract only still-missing communications/runtime value on current master; do not merge stale branch wholesale.
6. Continue reducing the remaining shelf through current-master PRs, fresh CI, staging deploy and smoke evidence.

### PERCENTAGE

- Agent workflow v5: 100% merged repository-side.
- CMS/product-copy repository integration: 100%; missing staging migration repaired and schema verified. Authenticated CMS browser smoke remains a runtime follow-up.
- Cloud Agent Manager repository integration: 100%; credential activation and harmless computer-off smoke remain operational follow-up.
- Seller Distribution Hub: 100% merged and deployed to staging; authenticated seller end-to-end link-creation smoke remains to be performed.
- Long-horizon current-master integration: source implementation complete on stale PR #24, but 0% merged on current master; replacement execution assigned as Issue #40.
- Hosted UX reality closeout: scoped and queued as Issue #39; implementation not yet merged.
- PR #38 shelf-closeout integration: pending after long-horizon / UX sequencing.
- Real-money readiness: intentionally blocked.

### NEXT STEP

1. Execute Issue #40 on a fresh current-master Claude branch; no routine approval stops.
2. ChatGPT reviews the replacement PR, requires fresh CI, merges it, applies migration 071 to staging, deploys and smokes long deadlines.
3. Execute Issue #39 from the resulting master and drive it through the same CI → master → staging → smoke chain.
4. Reintegrate PR #38 with Product Catalog at migration 072.
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
- BRANCH: `claude/long-horizon-current-master-20260917` (from current master `8cd650b`, not the older SHA quoted in Issue #40)
- COMPLETED: Issue #40 — LONG_HORIZON_DEALS rebuilt on current master as migration `071_long_horizon_authorization_renewal.sql`. CMS keeps 069 and the Seller Distribution Hub keeps 070; 071 is appended in `scripts/migration_manifest.cjs` and every migration-number comment that denotes this migration was renumbered. Old PR #24 was used as provenance only — its change set was 3-way reconciled onto current master, never merged or blind cherry-picked. The 7-day maximum deal duration is gone from every active surface (seller picker, hint, validator, Hebrew errors, backend validator, legacy `frontend/app.js`); the 2-hour minimum stands; a 20-year technical sanity ceiling and an advisory-only >1-year seller notice remain. The full renewable-authorization architecture is preserved, not a UI fix: shared pinned deadline policy (`src/deadline_policy.ts` + `web/src/deadlinePolicy.ts`), renewable authorization metadata on `payment_authorization_bindings`, durable `reauthorize` payment-attempt identity, capture/recovery/release blocked while a renewal is unresolved, expired provider authorization treated as a payment-maintenance condition that never fails a deal or drops a committed participant, atomic renewal application with a settled renewal identity, a reconcile path for ambiguous/pending reauthorization, and lease/idempotency protection against duplicate charges.
- TESTED: focused suites on a disposable local PostgreSQL 16 — deadline policy 5/5 PASS, authorization renewal lifecycle 10/10 PASS, worker long-horizon scheduling 4/4 PASS, backend sanity 16/16 PASS (includes 30/60/90-day acceptance, <2h rejection, ceiling rejection, 8% fee base incl. delivery excl. VAT, attribution-only affiliate overview). CMS + Distribution Hub regressions PASS (`site_content_cms`, `product_copy_cms`, `seller_distribution_hub`, `frontend_foundation_distribution_hub`, `distribution_otp_join_attribution`). Money regressions PASS (`platform_fee_payments_8_percent`, `platform_fee_boundary_rounding`, `refund_policy`, `server_side_money_authority`, `synthetic_money_provider`, `grow_payment_adapter`). Static gates PASS: lint, scan:payment, scan:backend, scan:runtime-ddl, scan:secrets, gate:architecture, gate:real-money, gate:logging-hygiene, gate:money-tax, gate:legal. Migration gates PASS: `migrations:preflight` high_water=071, `ci:migrations` 64/64 with rerun pass, `test:migrations-isolated` drift=0 production_changes=0. `ci:route-authorization` PASS with UNGUARDED_PROTECTED_ROUTES=0. Migration 071's replacement of `guard_payment_attempt_eligibility` was diffed against 067 and is a strict superset. Canonical verifier `scripts/siton_verify.cjs`: release-static PASS, migrations-isolated PASS, route-authorization PASS, and the full grouped repository suite at **243/243 test files PASS**. Four files failed on the first pass for execution-environment reasons only and were re-run green once the environment was provided: `canonical_postgres_runtime_boundary` and `r3_render_web_runtime` needed a `postgres` role in the disposable cluster; `frontend_browser_smoke` and `frontend_browser_v11` needed a Chromium binary on a standard path (the container runs as root, so Chromium also needs `--no-sandbox`). No test, gate or assertion was modified to obtain a pass. REAL MONEY 0; Grow untouched and still exposes no `reauthorize` (documented external sandbox gap).
- OPEN: `ci:web-runtime` was NOT RUN locally (it requires Docker, which this execution container does not provide); repository CI covered it on PR #42 — `web-runtime-core` and `web-runtime-resilience` both passed, as did `preflight-static`, `preflight-database` and `docker-release-lab`. Grow real-provider stored-instrument re-authorization remains an unproven external sandbox gap by design. Staging application of migration 071, Render deploy and a 30/60/90-day seller smoke remain owner/ChatGPT steps after merge. Issue #39 was deliberately not touched.
- PERCENTAGE: Issue #40 repository implementation 100%; long-horizon track overall ~85% pending merge, staging migration 071 and hosted smoke.
- NEXT STEP: ChatGPT reviews the replacement PR on fresh CI, merges to master, applies migration 071 to Supabase staging, confirms Render LIVE and smokes 30/60/90-day seller deadlines, then closes old PR #24 as superseded. Issue #39 starts only from the resulting master.
<!-- AGENT_STATUS:claude:END -->

Agent slots are intentionally independent. Each coding agent may replace only its own marked block.

<!-- AGENT_STATUS:codex:START -->
### Codex latest milestone

- UPDATED: 2026-09-17
- BRANCH: `master`
- COMPLETED: PR #37 Seller Distribution Hub merged; missing migration 070 was applied to staging; Render redeploy reached LIVE; missing CMS migration 069 was applied and verified; hosted UX/runtime gaps were converted into Issues #39/#40 with collision-safe sequencing.
- TESTED: distribution schema exists; Render is LIVE on `8bdd401...`; CMS draft schema reads successfully; current active seven-day seller restriction was independently confirmed as an unresolved current-master defect.
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
