# PROJECT STATUS — Siton current project status

Updated: 2026-09-15
Purpose: compact current-state source for coding agents. Historical milestone detail before this reset is preserved byte-for-byte in `PROJECT_STATUS_ARCHIVE_PRE_2026-09-15.md` and is read only when needed.

## Current architecture

- GitHub repository `matilederer7-bit/C-ton` is the source of truth for code and reviewed history.
- `master` is the integration branch.
- Render runs the hosted staging Web/backend service.
- Supabase `siton-staging` is the canonical staging PostgreSQL/runtime data boundary.
- Base44 is legacy/bounded unless a newer explicit task says otherwise.

## Permanent product rules

- Siton platform fee is 8%.
- Fee base includes the full customer amount actually collected, including shipping/delivery, excluding VAT.
- There is no in-system distributor commission, balance, entitlement, or payout rail.
- Distributor functionality is attribution, measurement, and sharing unless the owner explicitly changes it.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, and 90% success rules remain safety boundaries.
- Real-money activation is separate from technical readiness and must never be inferred from green tests.

## Agent-efficiency track

### Completed

- Stage 1: canonical `AGENTS.md` and `AI_WORKFLOW.md` created so standing rules no longer need to be pasted into every coding-agent prompt.
- Stage 2 implementation: canonical `npm run siton:verify` command exists on the current efficiency branch baseline and provides one completion-verification entry point. PR #16 is superseded by the consolidated efficiency branch until integration is complete.
- Stage 3 implementation: `scripts/agent_workspace.cjs` creates isolated permanent sibling worktrees for Codex and Claude Code and starts each task on a clean branch from current `origin/master`.
- Worktree helper refuses dirty-worktree switching, existing non-worktree path overwrite, local task-branch reuse, and remote task-branch collision. It contains no hard reset or force-push path.
- `AGENT_WORKSPACES.md` documents the one-time setup and parallel-work contract.
- `AGENT_TASK_PROTOCOL.md` defines the short owner task brief, builder completion packet, reviewer verdict, parallel-scope rule, and builder-to-reviewer handoff.
- `AGENTS.md` now makes the compact task protocol and isolated worktrees the default operating model.
- Status history was rotated: the former ~887 KB `PROJECT_STATUS.md` is preserved as `PROJECT_STATUS_ARCHIVE_PRE_2026-09-15.md`; this compact file is now the default context source.

### Checked

- Repository-side contract test added for the worktree helper.
- Static inspection confirms no destructive reset or force-push path in the helper.
- Historical status archive reuses the exact prior Git blob, so no historical bytes were rewritten during rotation.
- PR #17 Release Readiness and Web Runtime gates passed. Backend gates passed through unit, integration, DB, API, workers, payments, authorization, security, concurrency, and failure/fault checks. The only E2E failure was `mvp_completion_project_status_optional_validation`, caused by the compact status heading no longer containing the compatibility marker `PROJECT STATUS`; that marker is restored by this commit.

### Open

- The actual sibling worktrees must be instantiated once on the development machine with `node scripts/agent_workspace.cjs setup` after this branch is integrated. GitHub cannot create local filesystem worktrees on the owner's PC by itself.
- Confirm the CI rerun after the one-line status-heading compatibility fix, then merge PR #17.
- The next efficiency layer after worktrees is operational orchestration: make task assignment/review from phone require only a short brief plus PR/commit references, without re-sending repository context.

### Progress

- Agent-efficiency foundation: 95%.
- Repository implementation for isolated two-agent work: 99%; only CI confirmation and merge remain.
- Local machine activation of both worktrees: 0% until the one-time setup command is run on that machine.

### Next step

Confirm PR #17 CI after the compatibility-marker fix, merge it, then run the one-time worktree setup on the development machine and verify both agents can start independent task branches concurrently.
