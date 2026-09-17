# SITON PROJECT STATUS

Updated: 2026-09-17
Canonical branch: `master`
Current merged baseline: `17035f900ccaebf185b2cb806fd28acf872d3a6a`

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

- UPDATED: not yet written by v3 workflow
- BRANCH: none
- COMPLETED: none
- TESTED: none
- OPEN: none
- PERCENTAGE: not set
- NEXT STEP: use this slot only from Claude Code finish
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
