# SITON PROJECT STATUS

Updated: 2026-09-16
Canonical branch: `master`
Current merged baseline: `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`

## PRODUCT POLICY ALIGNMENT — 2026-09-16

### COMPLETED

- Owner policy is now explicit and canonical in `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`.
- Every publishable deal must have a finite mandatory `max_units`; no `NULL` or unlimited capacity is canonical.
- Completion Window is fixed at exactly 24 hours and is only for recovery by participants whose initial charge failed and are in `ChargeFailedCompletion`.
- Siton fee is fixed at 8% of all purchase money actually collected through Siton, including shipping/delivery, excluding the customer VAT component. There is no per-deal fee override.
- There is no distributor/affiliate user role or distributor product module. Ordinary deal sharing remains role-neutral.
- Current legal material remains unchanged for now.
- The earlier decision removing the fixed seven-day maximum deal duration remains binding.
- `AGENTS.md` precedence and invariant rules were updated so future agents cannot revive stale distributor, variable-window, unlimited-capacity, fee, or seven-day-deadline behavior.
- A repository-local implementation task was written at `docs/CANONICAL_PRODUCT_POLICY_CODE_CLEANUP_2026-09-16.md`.

### TESTED / CHECKED

- Supabase staging inspection: `siton.deals.max_units` is `NOT NULL`; DB constraint enforces `max_units >= min_units`; `deals.commission_rate` is absent.
- Runtime money inspection: `SITON_PLATFORM_FEE_RATE = 0.08`; product gross plus delivery gross forms the collected amount; customer VAT is excluded from the fee base.
- Runtime completion-window inspection found one remaining policy drift: `src/app.ts` still permits `COMPLETION_WINDOW_MINUTES` environment override even though the default is 1440 minutes.
- Repository schema/runtime inspection found legacy distributor/affiliate tables and product surfaces still present and currently required by `src/schema_contract.ts`.
- Historical applied migration `046_distributor_measurement_surfaces.sql` still documents the prior distributor attribution model. It must not be rewritten; cleanup must use forward changes.
- Updated external DOCX source copies for DB, database constitution, enforcement mechanism, constitution/checklist, UX, and product specification were text-scanned and rendered page-by-page with no material layout break found.
- Runtime test suite was NOT RUN in this source-of-truth commit because runtime code is intentionally deferred to the separate cleanup task to avoid colliding with active parallel work.

### OPEN

- Runtime code cleanup remains required to hard-lock Completion Window to 24 hours and remove the environment override.
- Distributor/affiliate role/session/routes/UI/schema-contract/environment/test surfaces remain legacy implementation drift and must be removed without deleting ordinary sharing or role-neutral viral analytics.
- `max_units` must be audited across create/edit/clone/publish/import/admin paths so the finite upper limit cannot regress.
- The separate active no-seven-day-cap implementation task must land without overlap.
- CMS/content-management work is active in parallel and is deliberately untouched by this policy-alignment task.
- Real money remains 0. Grow remains untouched and unactivated.

### PERCENTAGE

- Canonical product-policy decision and source-of-truth alignment: 100%.
- Runtime implementation alignment for this policy set: approximately 70%; the fee and DB upper-cap invariants are already aligned, while fixed-window hardening and distributor-module removal remain open.

### NEXT STEP

1. Merge the canonical policy/source-of-truth change.
2. Run `docs/CANONICAL_PRODUCT_POLICY_CODE_CLEANUP_2026-09-16.md` on an isolated agent branch after checking active Claude/Codex scopes.
3. Rebase that runtime cleanup after the separate no-seven-day-cap task lands if necessary.
4. Run focused tests, full relevant suite, release gates, update this status, commit, push, and open PR.

## COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #18 closed as superseded by PR #19.
- Agent efficiency v2 is merged to `master` at `294399e32bbcd090761eb9e7774e64ef89d3eca3`.
- PR #22 merged to `master` at `8b9945f2c83a9380c78d9fd75d7d36c944f3cf40`: affiliate visit acknowledgement is emitted only after the recording transaction commits, with deterministic regression coverage.
- PR #21 was closed without merge as the stale-base predecessor superseded by PR #22.
- PR #23 merged to `master` at `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`: agent efficiency v3 isolates Claude/Codex status writes, retains active task branches while PRs remain open, and removes the duplicate aggregate PR test pass while preserving the ten explicit test groups.
- Agent workflow includes isolated permanent Claude and Codex worktrees, one-command setup and doctor, fail-closed branch collision checks, untracked task packets, automated verification/commit/push/PR creation, compact CI failure summaries and no auto-merge.
- Agent efficiency v3 hardening is merged at `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`.
- PR #26 merged to `master` at `563b9ad5f72c6dd296923a3566be55d4c133b351`: canonical product policy amendment 2026-09-16 (finite mandatory `max_units`, 24-hour Completion Window, 8% fee including delivery excluding VAT, no distributor role/module, no seven-day cap) locked in docs and `AGENTS.md`.
- Agent efficiency v4 is implemented on `chore/agent-entrypoints-v4` (PR #27):
  - root `CLAUDE.md` gives Claude Code a compact automatic entry point into `AGENTS.md`, `AI_WORKFLOW.md`, `PROJECT_STATUS.md` and current canonical product sources, so task prompts no longer need to repeat standing rules.
  - GitHub authorization failures have a fixed no-loop fallback: stop equivalent retries, preserve the coherent commit, produce a complete patch, report exact SHAs and apply instructions.
  - push-checkpoint discipline is now binding: prove push access with an early branch push before substantial implementation, push meaningful checkpoints, and verify the remote SHA at the end, so completed work is never left only in a session container.
  - a release-tool contract test requires the Claude entry point, the no-loop fallback and the push-checkpoint rule.

## TESTED

- PR #22 passed Backend and deployment quality gates, Web runtime depth gates and Release readiness before merge, including the complete repository suite and extended Docker smoke.
- Agent efficiency v2/v3/v4 contract coverage lives under `tests/release_tools/agent_efficiency_v2.test.cjs` and remains part of the standard/full release-preflight catalogue.
- PR #27 was refreshed onto merged master `563b9ad` after PR #26; the v4 contract test was run locally on the refreshed head and fresh GitHub CI on that head is the merge authority.

## OPEN

- PR #27 requires green GitHub CI on its refreshed head before merge.
- Owner-machine worktrees should be rechecked with `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` after workflow changes.
- Runtime/production items intentionally remain open: O-1 Render worker/Blueprint live sync, O-2 hosted `OTP_HASH_SALT`, F13 external provider semantics, LONG_HORIZON_DEALS dependent on F13, F-12 production image pruning, F-07 architecture decision, and legacy `/app/...` recovery URL cleanup.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

## PERCENTAGE

- Agent workflow repository-side implementation: 100% for merged v3 scope; v4 entry point and push-checkpoint rule pending PR #27 CI and merge.
- Agent workflow owner-machine activation: not re-verified by this repository-only change.
- Product/real-money readiness percentages are intentionally not globally recomputed here.

## NEXT STEP

1. Merge PR #27 when GitHub CI is green on the refreshed head.
2. Complete canonical policy runtime cleanup without colliding with CMS or duration work.
3. Re-run owner-machine agent doctor after next local sync.
4. From then on, task prompts should contain mainly the task-specific objective, scope, constraints and acceptance criteria instead of repeating standing workflow rules.
5. Continue external-provider and hosted-runtime readiness only under existing real-money safety boundaries.

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

- UPDATED: 2026-09-16
- BRANCH: `chatgpt/distributor-financial-policy-guard`
- COMPLETED: added a repository-wide spec-drift guard that blocks distributor/affiliate commission, payout, balance, withdrawal, wallet, invoice, or entitlement authority while preserving attribution and measurement surfaces.
- TESTED: inspected the existing Wave 3 guard plus migrations 020 and 046; branch implementation committed and GitHub CI is the remaining execution proof.
- OPEN: CI must pass before merge. This guard prevents financial-policy regression but does not itself remove the broader legacy distributor role/module surfaces tracked in the canonical cleanup task.
- PERCENTAGE: 85%.
- NEXT STEP: open PR, run GitHub CI, review the diff, then merge only if green.
<!-- AGENT_STATUS:codex:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is fixed at 8% of the full collected purchase amount including delivery and other applicable purchase charges, excluding the customer VAT component.
- No per-deal commission-rate override.
- Every publishable deal has a finite mandatory `max_units`; no unlimited or `NULL` capacity.
- Completion Window is fixed at exactly 24 hours and only serves failed-charge recovery for `ChargeFailedCompletion` participants.
- No distributor/affiliate user role or distributor product module. Ordinary sharing remains role-neutral.
- No fixed seven-day maximum deal duration.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, PROJECT_STATUS update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.