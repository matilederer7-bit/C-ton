# SITON PROJECT STATUS

Updated: 2026-09-16
Canonical branch: `master`
Current merged baseline: `8b9945f2c83a9380c78d9fd75d7d36c944f3cf40`

## COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #18 closed as superseded by PR #19.
- Agent efficiency v2 is merged to `master` at `294399e32bbcd090761eb9e7774e64ef89d3eca3`.
- PR #22 merged to `master` at `8b9945f2c83a9380c78d9fd75d7d36c944f3cf40`: affiliate visit acknowledgement is emitted only after the recording transaction commits, with deterministic regression coverage.
- PR #21 was closed without merge as the stale-base predecessor superseded by PR #22.
- Agent workflow includes isolated permanent Claude and Codex worktrees, one-command setup and doctor, fail-closed branch collision checks, untracked task packets, automated verification/commit/push/PR creation, compact CI failure summaries and no auto-merge.
- Agent efficiency v3 hardening is implemented on `chore/agent-efficiency-v3-status-isolation`:
  - Claude and Codex update separate fixed status slots inside this file instead of appending into the same EOF region.
  - `finish` keeps the worktree on the active task branch while the PR remains open so CI fixes continue with the same context.
  - the next `start` automatically releases only a clean prior task whose PR is already merged or closed.
  - an open prior PR blocks task replacement instead of silently discarding context.
  - PR backend CI runs the ten explicit test groups once; the aggregate `test:all` re-run is retained only on push to `master`, eliminating a proven duplicate pass on every PR without reducing PR test inventory.

## TESTED

- PR #22 passed Backend and deployment quality gates, Web runtime depth gates and Release readiness before merge, including the complete repository suite and extended Docker smoke.
- Agent efficiency v2/v3 contract tests are under `tests/release_tools/agent_efficiency_v2.test.cjs` and are part of the standard/full release-preflight catalogue.
- The v3 contract requires isolated Claude/Codex status markers, retained task branches while PRs are open, automatic release only after PR resolution and preservation of all ten explicit PR test groups while `test:all` is push-only.
- PR #23 was refreshed onto merged master after PR #22. Fresh GitHub CI on the resulting combined head remains the merge authority.

## OPEN

- PR #23 requires fresh green GitHub CI after its master refresh and CI de-duplication change before merge.
- Owner-machine worktrees should be rechecked with `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` after v3 merges.
- The deterministic task-branch slug can still collide when the exact same task text is reused after a historical branch remains locally or remotely. This is a workflow follow-up, not a v3 merge blocker.
- Task packets currently use the compact top-of-file status excerpt; later refinement can include the active agent's isolated status slot directly.
- Runtime/production items intentionally remain open: O-1 Render worker/Blueprint live sync, O-2 hosted `OTP_HASH_SALT`, F13 external provider semantics, LONG_HORIZON_DEALS dependent on F13, F-12 production image pruning, F-07 architecture decision, and legacy `/app/...` recovery URL cleanup.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

## PERCENTAGE

- Agent workflow repository-side implementation: 98% pending fresh PR #23 CI and merge.
- Agent workflow owner-machine activation: not re-verified by this repository-only change.
- Product/real-money readiness percentages are intentionally not recomputed by this workflow-only change.

## NEXT STEP

1. Complete fresh GitHub CI on PR #23 and inspect only evidence-backed failures.
2. Merge PR #23 when all required workflows are green.
3. Re-run `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` once on the owner machine.
4. Harden repeated-task branch naming and improve task-packet status targeting in the next workflow-only change.
5. Evaluate further path-sensitive CI optimization only with explicit protection against skipped required checks.

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

- UPDATED: not yet written by v3 workflow
- BRANCH: none
- COMPLETED: none
- TESTED: none
- OPEN: none
- PERCENTAGE: not set
- NEXT STEP: use this slot only from Codex finish
<!-- AGENT_STATUS:codex:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is 8% of the full collected amount including delivery and other applicable charges, excluding VAT.
- No distributor commission or distributor payout rail.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, PROJECT_STATUS update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.
