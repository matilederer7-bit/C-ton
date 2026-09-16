# SITON PROJECT STATUS

Updated: 2026-09-16
Canonical branch: `master`
Current merged baseline: `294399e32bbcd090761eb9e7774e64ef89d3eca3`

## COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #18 closed as superseded by PR #19.
- Agent efficiency v2 is merged to `master` at `294399e32bbcd090761eb9e7774e64ef89d3eca3`.
- Agent workflow now includes isolated permanent Claude and Codex worktrees, one-command setup and doctor, fail-closed branch collision checks, untracked task packets, automated verification/commit/push/PR creation, compact CI failure summaries and no auto-merge.
- Agent efficiency v3 hardening is implemented on `chore/agent-efficiency-v3-status-isolation`:
  - Claude and Codex update separate fixed status slots inside this file instead of appending into the same EOF region.
  - `finish` keeps the worktree on the active task branch while the PR remains open so CI fixes continue with the same context.
  - the next `start` automatically releases only a clean prior task whose PR is already merged or closed.
  - an open prior PR blocks task replacement instead of silently discarding context.

## TESTED

- Agent efficiency v2 contract tests remain under `tests/release_tools/agent_efficiency_v2.test.cjs`.
- The v3 contract extends those tests to require isolated Claude/Codex status markers, retained task branches while PRs are open, and automatic release only after PR resolution.
- Repository CI remains the source of truth before v3 merge.

## OPEN

- PR #22 contains the clean affiliate visit commit-before-response fix on top of the current master and is awaiting final CI/merge resolution.
- Agent efficiency v3 requires GitHub CI and review before merge.
- Owner-machine worktrees should be rechecked with `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` after v3 merges.
- Runtime/production items intentionally remain open: O-1 Render worker/Blueprint live sync, O-2 hosted `OTP_HASH_SALT`, F13 external provider semantics, LONG_HORIZON_DEALS dependent on F13, F-12 production image pruning, F-07 architecture decision, and legacy `/app/...` recovery URL cleanup.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

## PERCENTAGE

- Agent workflow repository-side implementation: 97% pending v3 CI and merge.
- Agent workflow owner-machine activation: not re-verified by this repository-only change.
- Product/real-money readiness percentages are intentionally not recomputed by this workflow-only change.

## NEXT STEP

1. Run GitHub CI on the v3 branch and inspect only evidence-backed failures.
2. Merge PR #22 when its required CI is green.
3. Merge v3 when its own CI is green.
4. Re-run `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` once on the owner machine.
5. Use the new workflow for the next Claude/Codex parallel task and verify there is no `PROJECT_STATUS.md` collision.

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
