# SITON PROJECT STATUS

Updated: 2026-09-16
Canonical branch: `master`
Current merged baseline: `3e55aa519eef235ccbdf8537424dff97045f01aa`

## COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #18 closed as superseded by PR #19.
- Production/runtime hardening retained: worker shutdown path, startup guards, logging hygiene, readiness cache policy, dependency advisory reduction, webhook concurrency handling, outbox traceability, buyer recovery and legal-shell alignment.
- Agent workflow baseline from PR #15 is already merged: repository rules, Siton commercial invariants, coding-agent boundaries, project-status discipline, separate Claude/Codex work scopes.
- Agent efficiency v2 is implemented on `chore/agent-efficiency-v2-2026-09-16`:
  - isolated permanent Claude and Codex worktrees
  - one-time `setup` command that also runs doctor
  - fail-closed remote branch collision checks
  - automatic untracked task packet with task, scope, boundaries, base SHA and compact status
  - automated `finish` flow for verification, PROJECT_STATUS update, commit, push and PR creation/update
  - compact GitHub Actions failure summarizer
  - helper-signal handling that cannot falsely print success
  - contract tests for the efficiency layer
  - compact owner quickstart

## TESTED

- PR #19 required GitHub CI was green before merge.
- The original PR #19 integration failure was reproduced as non-deterministic: rerunning the exact same SHA passed the failed integration test and subsequent suites without a code change.
- Agent efficiency v2 contract tests are included under `tests/release_tools/agent_efficiency_v2.test.cjs`.
- Repository CI for the v2 branch is required before merge and remains the source of truth for final qualification.

## OPEN

- Agent efficiency v2 still requires PR review and green GitHub CI before merge.
- One owner-machine action remains after merge: `node scripts/agent.cjs setup`. It creates/checks both local worktrees and runs doctor in the same command.
- Runtime/production items intentionally remain open: O-1 Render worker/Blueprint live sync, O-2 hosted `OTP_HASH_SALT`, F13 external provider semantics, LONG_HORIZON_DEALS dependent on F13, F-12 production image pruning, F-07 architecture decision, and legacy `/app/...` recovery URL cleanup.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

## PERCENTAGE

- Agent workflow repository-side implementation: 98% pending CI and merge.
- Agent workflow owner-machine activation: 0% until the one-time `setup` command is run after merge.
- Product/real-money readiness percentages are intentionally not recomputed by this workflow-only change.

## NEXT STEP

1. Open the clean agent-efficiency v2 PR against current `master`.
2. Run and inspect required GitHub CI.
3. Fix only evidence-backed workflow defects if CI fails. Do not touch product/payment code.
4. Merge when green.
5. On the owner machine run once: `node scripts/agent.cjs setup`.

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is 8% of the full collected amount including delivery and other applicable charges, excluding VAT.
- No distributor commission or distributor payout rail.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, PROJECT_STATUS update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.