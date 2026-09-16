# SITON PROJECT STATUS

Updated: 2026-09-16
Canonical branch: `master`
Current merged baseline: `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`

## COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #22 merged to `master` at `8b9945f2c83a9380c78d9fd75d7d36c944f3cf40`: affiliate visit acknowledgement is emitted only after the recording transaction commits, with deterministic regression coverage.
- Agent efficiency v2 merged at `294399e32bbcd090761eb9e7774e64ef89d3eca3`.
- PR #23 merged to `master` at `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`: agent efficiency v3 now isolates Claude/Codex status slots, retains active PR context and removes the proven duplicate PR test pass while preserving the ten explicit test groups.
- Local agent workflow includes permanent isolated Claude and Codex worktrees, one-command setup/doctor, fail-closed branch collision checks, untracked task packets, automated verification/commit/push/PR creation, compact CI failure summaries and no auto-merge.
- Cloud Agent Manager v1 is implemented on `chore/cloud-agent-manager-v1`:
  - GitHub-hosted `ubuntu-24.04` execution, so the owner computer is not part of task execution after dispatch.
  - owner-only `[agent-manager]` issue trigger plus manual `workflow_dispatch`.
  - automatic builder/reviewer selection across Claude and Codex based on configured cloud credentials.
  - canonical task packet with Siton commercial and production safety invariants.
  - one writer, read-only reviewer, at most one bounded automatic fix pass, then stop.
  - disposable local PostgreSQL service and canonical `scripts/siton_verify.cjs` before commit.
  - isolated Cloud Agent Manager status slot, automated commit/push/PR creation and no auto-merge.
  - draft PR when the final review still requires changes.
- Cloud manager contract tests and a mobile-friendly GitHub issue form are included.

## TESTED

- PR #22 passed Backend and deployment quality gates, Web runtime depth gates and Release readiness before merge, including the complete repository suite and extended Docker smoke.
- Agent efficiency v2/v3 contract tests are under `tests/release_tools/agent_efficiency_v2.test.cjs` and are part of the standard/full release-preflight catalogue.
- Cloud Agent Manager static contract coverage is added under `tests/release_tools/cloud_agent_manager.test.cjs` for role selection, standing safety invariants, read-only review, isolated status updates, owner-only triggers, one bounded fix pass and no auto-merge.
- Cloud Agent Manager branch still requires GitHub PR CI; repository CI is the authority for the new workflow syntax and release-tool test execution.

## OPEN

- Cloud Agent Manager cannot execute an AI coding run until at least one GitHub Actions cloud credential is configured.
- Claude cloud mode supports either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. For Claude Pro/Max, the documented OAuth path is `claude setup-token`, then store the token as a GitHub Actions secret.
- Codex cloud mode requires `OPENAI_API_KEY`; ChatGPT subscription access does not itself create API billing credentials.
- Two-provider independent review requires both a Claude credential and `OPENAI_API_KEY`. With only one provider, the manager records a bounded same-provider review.
- Owner-machine worktrees should still be rechecked with `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` when local operation resumes.
- Runtime/production items intentionally remain open: O-1 Render worker/Blueprint live sync, O-2 hosted `OTP_HASH_SALT`, F13 external provider semantics, LONG_HORIZON_DEALS dependent on F13, F-12 production image pruning, F-07 architecture decision, and legacy `/app/...` recovery URL cleanup.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

## PERCENTAGE

- Local agent workflow repository-side implementation: 100% merged.
- Cloud Agent Manager repository implementation: 90% pending PR CI/merge and one-time cloud credential activation.
- Computer-off execution path: code complete, not yet live until a supported GitHub Actions secret is present.
- Product/real-money readiness percentages are intentionally not recomputed by this workflow-only change.

## NEXT STEP

1. Open the Cloud Agent Manager Pull Request and let all repository CI run.
2. Fix only evidence-backed CI failures and merge when green.
3. Configure at least one cloud credential in GitHub Actions secrets. Preferred first path for the current setup: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
4. Trigger a harmless cloud smoke task through an owner-authored `[agent-manager]` issue and prove end-to-end execution while the owner computer is not participating.
5. Add `OPENAI_API_KEY` later if independent cross-provider Codex review is desired.

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

<!-- AGENT_STATUS:cloud-manager:START -->
### Cloud Agent Manager latest milestone

- UPDATED: 2026-09-16
- BRANCH: chore/cloud-agent-manager-v1
- BUILDER: manager infrastructure
- REVIEWER: repository CI pending
- COMPLETED: GitHub-hosted orchestration, cloud provider selection, task packets, bounded review/fix cycle, canonical verification, status ownership and PR creation implemented.
- TESTED: Static contract tests added; full GitHub CI pending PR creation.
- OPEN: One-time GitHub cloud credential activation and end-to-end smoke run remain.
- PERCENTAGE: 90%
- NEXT STEP: Open PR, pass CI, merge, configure Claude OAuth or API credential, then execute a harmless computer-off smoke task.
<!-- AGENT_STATUS:cloud-manager:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is 8% of the full collected amount including delivery and other applicable charges, excluding VAT.
- No distributor commission or distributor payout rail.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, PROJECT_STATUS update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.