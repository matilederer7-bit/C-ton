# SITON PROJECT STATUS

Updated: 2026-09-17
Canonical branch: `master`
Current merged baseline: `17035f900ccaebf185b2cb806fd28acf872d3a6a`

## SELLER DISTRIBUTION HUB — 2026-09-17

Branch: `claude/blissful-pasteur-c1qhiz` (from `master` `18ba51985f71ebf83563216ec22f88aaa7c023f0`). Design note: `docs/SELLER_DISTRIBUTION_HUB_2026-09-17.md`.

### COMPLETED

- Seller distribution links per deal, reusing the canonical rails instead of a parallel system: `siton.affiliate_links` (`origin_type='seller'`, new optional `channel`), `siton.affiliate_link_events` (entries; new opaque `visitor_id` for unique visitors), `siton.viral_attributions.parent_link_id` (join attribution by the existing last-touch resolution inside the Join transaction), `participants.money_state` + `platform_fee_money_events` (final charged units and gross actually collected).
- One documented attribution rule: Last Eligible Distribution Link before Join (same deal, active at Join time). Disabled, foreign or unknown codes degrade to an unattributed Join. Disabling a link keeps its history.
- Migration `070_seller_distribution_links.sql` (manifest + schema contract updated): link channel, visitor id on link events, and the scoped read-only external link viewer (`distribution_link_viewers`, `_grants`, `_sessions`, `_login_attempts`; scrypt-hashed passwords, identity/grant split for future multi-link identities).
- Backend module `src/distribution_hub.ts`: seller routes (list + totals, create, rename/channel/disable, per-link dashboard with 24h/7d/30d/all series, external-access enable/disable/reset) and the external `/api/link-viewer/*` surface (login with per-address and per-username rate limit, state probe, logout, aggregates-only dashboard scoped to the session's grants; a link id in the query is a selector among own grants, anything else is 403).
- `/api/affiliate/links/visit` accepts the opaque `visitor_id`; the browser sends it (`web/src/viral.ts`).
- Seller UI: distribution panel embedded in the deal screen (empty state, first-link CTA, create form, sortable comparison table, copy/share/WhatsApp/rename/performance/disable), per-link dashboard page with metric tiles, windowed totals, metric + range chart and external-access management (one-time credentials, copy login URL, reset, revoke, created/last-login). External `#/link-dashboard` page: login, deal + link name, status, metrics, chart, permanent measurement-only disclaimer, no seller navigation.
- Buyer experience unchanged: same `/d/:dealId?ref=` share route, same page, no distributor/referral/commission wording; `acquisition_source` stays `direct` for seller links.
- Route gates: `/api/link-viewer/` added to `PROTECTED_NAMESPACES`, `requireLinkViewer(` and `requireSellerOperate(` recognised as refusing guards, three reviewed anonymous-by-design entries (session probe, login, logout) pinned in policy and gate; `src/distribution_hub.ts` added to the static route inventory sources.
- No commission, balance, payout, invoice or entitlement for any link holder; Siton's 8% fee logic untouched; no DealState/BuyerState/MoneyState/transition change.

### TESTED / CHECKED

- `npx tsc --noEmit` PASS; `web` `tsc -b` + `vite build` PASS.
- `npm run lint`, `scan:backend`, distributor attribution-only gate (self-test + scan), `scan:payment`, `scan:runtime-ddl`: PASS.
- `scripts/web_route_inventory.cjs`: UNGUARDED_PROTECTED_ROUTES=0 (226 routes, 140 protected, 13 anonymous by design).
- `scripts/migration_preflight.cjs`: PASS (63 migrations, high-water 070, fresh install, upgrade from origin/master, partial ledger, atomicity).
- New proofs PASS on the isolated runner: `seller_distribution_hub_validation` (22 checks: links, visits + refresh dedupe + unique visitors, join attribution, replay, disabled/foreign codes, final charge + money-event gross, series for every range, seller A/B isolation, external access lifecycle, A1-only scope, PII isolation, revocation/reset/logout, rate limit), `distribution_otp_join_attribution_validation` (OTP-required Join keeps attribution through request → verify → resume → Join), `link_viewer_authority_validation` (internal-runtime: viewer credential refused on every seller/admin/affiliate/distributor route, A1 never reads A2, revocation kills sessions), `frontend_foundation_distribution_hub_validation` (browser wiring contract).
- Regression PASS on the isolated runner: `protected_route_authorization_gate`, `seller_route_auth_coverage`, `admin_route_auth_coverage`, `seller_lifecycle_route_authority`, `r6_viral_graph`, `affiliate_visit_response_after_commit`, `stage32c_product_surface_closure`, `stage32d_identity_resume`, `p05_admin_viral_support`, `p07b_seller_draft_preview`, `admin_affiliate_no_commission_regression`, `seller_analytics`, `p04_seller_command_delivery`, `security_identity_tracking`, `r5_guest_join_safety`, `otp_rail`, `buyer_verification_policy`, `frontend_flow`, `frontend_foundation_rtl_accessibility`.
- NOT RUN: the full grouped `npm test`; GitHub CI on the PR is the final authority.

### OPEN

- `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` §4 says "no distributor login/dashboard"; the owner's 2026-09-17 task adds a scoped read-only link-dashboard credential with no economics. The amendment wording should be updated by the owner to name this scoped viewer explicitly (implementation follows the owner's explicit task per the source-of-truth order).
- Hosted runtimes: `LINK_VIEWER_SESSION_SECRET` is optional (falls back to `BUYER_SESSION_SECRET` / `OTP_TOKEN_SECRET`); production-like runtimes without any of them answer 503 on external login. Migration 070 must be applied by the normal deploy path before the hub is used on staging.
- Unique visitors count only entries recorded after this change (older entries carry no visitor id).

### PERCENTAGE

- Seller distribution hub (backend, migration, seller UI, external dashboard, authorization, PII isolation, proofs): 100% on the branch pending CI and merge.

### NEXT STEP

1. Open the PR against `master`, require Backend, Release readiness and Web runtime depth gates green, merge.
2. Owner: amend the 2026-09-16 policy wording for the scoped link viewer.
3. After merge: apply migration 070 on staging through the normal deploy path and smoke the seller panel + `#/link-dashboard` once.

## AGENT WORKFLOW V5 REFRESH — 2026-09-17

### COMPLETED

- Re-applied the useful workflow-v5 changes from PR #32 on top of the current post-PR-31 baseline without carrying stale status content.
- Repeated task names allocate the first free `-rN` branch suffix instead of dead-ending on an old local or remote branch.
- Task packets include only the active agent's isolated `PROJECT_STATUS.md` slot instead of generic status lines.
- Task start now proves GitHub write access by pushing the new branch and verifying the remote SHA before substantial work begins.
- Release-tool contract coverage includes all three v5 behaviors.
- Stale duplicate PR #28 was closed as superseded.

### TESTED / CHECKED

- The v5 implementation previously passed Backend and deployment quality gates, Release readiness, and Web runtime depth gates on PR #32 head `d7b1676cda510330ab06de1b2abc1237fe1380cc`.
- This refresh preserves those workflow and test files while replacing only stale `PROJECT_STATUS.md` content with the current master status.
- Fresh GitHub CI on this refreshed branch is the final merge authority.
- No product runtime, database, auth, payments, Grow, Render, Supabase, or real-money behavior is changed.

### OPEN

- Fresh CI must pass on the refreshed branch before merge.
- Owner-machine worktrees still need one setup/doctor verification after the next local sync.

### PERCENTAGE

- Agent workflow v5 repository implementation: 95% pending fresh CI and merge.

### NEXT STEP

1. Open refreshed PR against current master.
2. Require Backend, Release readiness, and Web runtime depth gates green.
3. Merge only after green CI, then close the older PR #32 as superseded.
4. Re-run owner-machine agent doctor after local sync.

## DISTRIBUTOR ATTRIBUTION-ONLY GUARD — 2026-09-17

### COMPLETED

- PR #31 merged to `master` at `17035f900ccaebf185b2cb806fd28acf872d3a6a`.
- Added fail-closed CI enforcement for the canonical rule that distributor/affiliate behavior is attribution and measurement only, never an in-platform money entitlement.
- The guard rejects distributor/affiliate commission, payout, withdrawal, balance, earnings, entitlement, invoice, fee and reward identifiers while preserving ordinary sharing and attribution measurement.
- The guard includes multi-line SQL regression protection and prevents migration 020 from recreating removed distributor financial fields.

### TESTED / CHECKED

- Verified head `df2a05bea8375277178e6400670930bf9b078fb8` passed all three GitHub workflows before merge: Backend and deployment quality gates, Release readiness, and Web runtime depth gates.
- Backend coverage included TypeScript, lint/enforcement scans, distributor self-test/live scan, payment/raw-card compliance, runtime DDL, integrity checks, unit, integration, database, API, worker, payment, authorization, security, concurrency, failure-injection, E2E, and extended Docker smoke.
- Real money remains 0. Grow remains untouched and unactivated.

### OPEN

- Broader removal of legacy distributor/session/routes/UI/schema surfaces remains a separate cleanup task; ordinary sharing and role-neutral attribution analytics must remain intact.
- Fixed 24-hour Completion Window hardening remains separate because `src/app.ts` overlaps the active duration workstream.

### PERCENTAGE

- Distributor no-money regression protection: 100% merged and verified.
- Broader canonical product-policy runtime cleanup: incomplete.

### NEXT STEP

- Continue separate runtime cleanup only on an isolated branch after checking active scopes.

## CURRENT SNAPSHOT

### COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #22 merged to `master`: affiliate visit acknowledgement is emitted only after the recording transaction commits, with deterministic regression coverage.
- PR #23 merged to `master`: agent efficiency v3 with isolated Claude/Codex status writes, branch retention while PRs remain open, and streamlined aggregate test execution.
- PR #26 merged to `master`: canonical product policy amendment 2026-09-16.
- PR #27 merged to `master` at `7c975d062eecc02faf1c3ab48909b7f05043c7a8`: agent efficiency v4 with root `CLAUDE.md`, no-loop Git authorization fallback, push-checkpoint discipline, and release-tool contract coverage.
- PR #31 merged to `master` at `17035f900ccaebf185b2cb806fd28acf872d3a6a`: distributor attribution-only financial-regression guard.
- Repository-side agent workflow is merged through v4; v5 refresh is in progress.

### TESTED / CHECKED

- `AGENTS.md` declares the no-seven-day-cap product invariant and source-of-truth precedence rules.
- `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` records the no-seven-day-cap decision as binding and marks older seven-day references as historical.
- Current `src/app.ts` still contains the legacy seven-day runtime maximum. This is implementation drift, not current product policy.

### OPEN

- LONG_HORIZON_DEALS remains open in runtime. The legacy seven-day maximum still exists in `src/app.ts` and must not be removed as an isolated two-line change if the durable future-charge/payment semantics are not landed with it.
- Runtime product-policy cleanup remains required for the fixed 24-hour Completion Window and legacy distributor/affiliate surfaces, without touching ordinary sharing or role-neutral viral analytics.
- CMS/content-management work is active in parallel and must remain isolated from unrelated cleanup.
- Owner-machine agent worktrees should be rechecked after the next local sync with `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor`.
- Hosted/runtime readiness remains open for the existing Render worker/Blueprint, hosted OTP secret, external payment-provider semantics, production image pruning, architecture decision, and legacy recovery-URL cleanup tracks.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

### PERCENTAGE

- Canonical product-policy decision and source-of-truth alignment: 100%.
- Runtime implementation alignment for the current product-policy set: incomplete.
- Long-horizon runtime integration: not complete on `master`.

### NEXT STEP

1. Close the workflow-v5 refresh after green CI and merge.
2. Review the complete long-horizon implementation against current `master` rather than deleting only the seven-day validator.
3. Continue separate canonical policy runtime cleanup without colliding with CMS or duration work.
4. Re-run owner-machine agent doctor after local sync.
5. Keep real money disabled until provider-readiness gates are explicitly cleared.

## PRODUCT POLICY ALIGNMENT — 2026-09-16

The binding policy source is `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`.

Current invariants:

- Every publishable deal has a finite mandatory `max_units`. Unlimited or `NULL` capacity is non-canonical.
- Completion Window is exactly 24 hours and exists only for failed-charge recovery by eligible participants.
- Siton fee is fixed at 8% of all purchase money actually collected through Siton, including shipping/delivery and other applicable purchase charges, excluding the customer VAT component.
- There is no per-deal fee override.
- There is no distributor/affiliate user role or distributor product module. Ordinary sharing remains role-neutral.
- There is no fixed seven-day maximum deal duration. Older seven-day product-deadline references are historical.
- Current legal material remains unchanged unless the owner explicitly changes it.

## AGENT MILESTONES

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone

- UPDATED: 2026-09-17
- BRANCH: `claude/blissful-pasteur-c1qhiz`
- COMPLETED: seller distribution hub — per-deal distribution links on the canonical affiliate_links / link-events / viral_attributions rails, migration 070, distribution_hub route module, seller panel + per-link dashboard, external scoped read-only `#/link-dashboard`, route-gate coverage, docs and proofs.
- TESTED: tsc, web build, lint/backend/payment/runtime-DDL scans, distributor attribution-only gate, route inventory (0 unguarded), migration preflight, four new proofs and the targeted regression set on the isolated runner (see the SELLER DISTRIBUTION HUB section).
- OPEN: PR + CI; owner wording update of amendment 2026-09-16 §4 for the scoped viewer; staging migration 070 via the normal deploy path.
- PERCENTAGE: 100% on branch pending CI and merge.
- NEXT STEP: open PR, keep CI green, merge.
<!-- AGENT_STATUS:claude:END -->

Agent slots are intentionally independent. Each coding agent may replace only its own marked block.

<!-- AGENT_STATUS:codex:START -->
### Codex latest milestone

- UPDATED: 2026-09-17
- BRANCH: `chatgpt/agent-workflow-v5-refresh-r2`
- COMPLETED: refreshed agent-workflow v5 onto the current post-PR-31 master baseline, preserving the repeated-task branch allocator, focused task packets, and start-time push/SHA checkpoint while removing stale status conflict.
- TESTED: source PR #32 implementation was green in Backend, Release readiness, and Web runtime workflows; fresh CI on this branch is the final merge authority.
- OPEN: fresh CI and merge remain; owner-machine doctor remains after local sync.
- PERCENTAGE: 95%.
- NEXT STEP: open refreshed PR, require all three CI workflows green, merge, close PR #32 as superseded, then run owner-machine doctor after sync.
<!-- AGENT_STATUS:codex:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is fixed at 8% of the full collected purchase amount including delivery and other applicable purchase charges, excluding the customer VAT component.
- No per-deal commission-rate override.
- Every publishable deal has a finite mandatory `max_units`; no unlimited or `NULL` capacity.
- Completion Window is fixed at exactly 24 hours and only serves failed-charge recovery for `ChargeFailedCompletion` participants.
- No distributor/affiliate user role or distributor product module. Ordinary sharing remains role-neutral.
- No fixed seven-day maximum deal duration.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, security, and 90% success rules remain safety boundaries.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, `PROJECT_STATUS.md` update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.
