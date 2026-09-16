# SITON PROJECT STATUS

Updated: 2026-09-16
Canonical branch: `master`
Current merged baseline: `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`

## COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #18 closed as superseded by PR #19.
- Agent efficiency v2 is merged to `master` at `294399e32bbcd090761eb9e7774e64ef89d3eca3`.
- PR #22 merged to `master` at `8b9945f2c83a9380c78d9fd75d7d36c944f3cf40`: affiliate visit acknowledgement is emitted only after the recording transaction commits, with deterministic regression coverage.
- PR #21 was closed without merge as the stale-base predecessor superseded by PR #22.
- PR #23 merged to `master` at `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`: agent efficiency v3 isolates Claude/Codex status writes, retains active task branches while PRs remain open, and removes the duplicate aggregate PR test pass while preserving the ten explicit test groups.
- Agent workflow includes isolated permanent Claude and Codex worktrees, one-command setup and doctor, fail-closed branch collision checks, untracked task packets, automated verification/commit/push/PR creation, compact CI failure summaries and no auto-merge.
- Agent efficiency v4 is implemented on `chore/agent-entrypoints-v4` and opened as PR #27:
  - root `CLAUDE.md` now gives Claude Code a compact automatic entry point into `AGENTS.md`, `AI_WORKFLOW.md`, `PROJECT_STATUS.md`, and current canonical product sources.
  - Claude is explicitly instructed not to ask the owner to repeat repository rules already defined in those files.
  - GitHub authorization failures now have a fixed no-loop fallback: stop equivalent retries, preserve the coherent commit, produce a complete patch, and report exact SHAs and apply instructions.
  - a release-tool contract test now requires the Claude entry point and its efficiency/failure-loop guarantees.

## TESTED

- PR #22 passed Backend and deployment quality gates, Web runtime depth gates and Release readiness before merge, including the complete repository suite and extended Docker smoke.
- PR #23 merged after GitHub CI and is now the canonical workflow baseline.
- Agent efficiency v2/v3/v4 contract coverage lives under `tests/release_tools/agent_efficiency_v2.test.cjs` and remains part of the standard/full release-preflight catalogue.
- v4 repository diff was reviewed through GitHub and PR #27 was opened. Execution of the new contract test is delegated to normal PR CI because this repository-only ChatGPT session has no local repository runtime.

## OPEN

- PR #27 requires green GitHub CI before merge.
- Owner-machine worktrees should be rechecked with `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` after v4 merges.
- The deterministic task-branch slug can still collide when the exact same task text is reused after a historical branch remains locally or remotely. This is a workflow follow-up, not a v4 merge blocker.
- Task packets currently use the compact top-of-file status excerpt; later refinement can include the active agent's isolated status slot directly.
- Runtime/production items intentionally remain open: O-1 Render worker/Blueprint live sync, O-2 hosted `OTP_HASH_SALT`, F13 external provider semantics, LONG_HORIZON_DEALS dependent on F13, F-12 production image pruning, F-07 architecture decision, and legacy `/app/...` recovery URL cleanup.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

## PERCENTAGE

- Agent workflow repository-side implementation: 99% pending PR #27 CI and merge.
- Agent workflow owner-machine activation: not re-verified by this repository-only change.
- Product/real-money readiness percentages are intentionally not recomputed by this workflow-only change.

## NEXT STEP

1. Inspect PR #27 CI and merge only when green.
2. Re-run `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` once on the owner machine.
3. From then on, task prompts should contain mainly the task-specific objective, scope, constraints, and acceptance criteria instead of repeating standing workflow rules.
4. Harden repeated-task branch naming and improve task-packet status targeting in the next workflow-only change.

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
