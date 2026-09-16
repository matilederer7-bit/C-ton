# PROJECT STATUS — Siton current project status

Updated: 2026-09-16
Purpose: compact current-state source for coding agents. Historical milestone detail before this reset is preserved in `PROJECT_STATUS_ARCHIVE_PRE_2026-09-15.md` and is read only when needed.

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

### COMPLETED

- Standing agent rules and compact current status exist in-repo, so routine tasks no longer require pasted instruction blocks.
- Historical status was rotated out of standing context into `PROJECT_STATUS_ARCHIVE_PRE_2026-09-15.md`.
- Canonical completion verification exists as `npm run siton:verify`.
- Separate permanent Codex/Claude worktree model exists with dirty-worktree, path-overwrite, local-branch, and remote-branch collision guards.
- Remote branch collision checks now fail closed: if `git ls-remote` cannot verify origin because of network/auth/Git failure, the helper stops instead of treating the branch as absent and risking a collision.
- `agent.cjs` now fails closed if the workspace helper terminates by signal or returns no numeric exit status, preventing a false `DONE` after abnormal helper termination.
- Owner-facing workflow is consolidated behind `node scripts/agent.cjs` with `setup`, `status`, `doctor`, `start`, `review`, `handoff`, and `finish`.
- Worktree path resolution now uses Git's common directory, so the helper targets the canonical `C-ton` root even when invoked from `C-ton-codex` or `C-ton-claude`.
- `finish` refuses dirty, detached, master, unpushed, or not-fully-pushed task branches before returning an agent to standby.
- Default context loading was reduced to `PROJECT_STATUS.md`, `AGENTS.md`, and task-relevant files. Workflow/history documents are on-demand.
- Builder/reviewer and parallel-builder contracts use PR/commit diff and checks as the primary handoff object.
- Owner quickstart is reduced to one short phone-friendly page.

### CHECKED

- Existing PR #17 Release Readiness, Web Runtime, and Backend quality gates passed on the previous head.
- Existing worktree contract checks cover two isolated agents, dirty guard, local/remote branch collision guard, Unicode task names, and absence of destructive reset/force-push paths.
- The worktree contract explicitly requires `remote_lookup_fail_closed=true` and verifies the helper contains the fail-closed remote-lookup error path.
- The CLI contract now verifies abnormal helper termination guards for both signaled exits and missing numeric exit status, so a child-process failure cannot silently produce `DONE`.
- Workflow contract coverage includes the single `agent.cjs` command, review/handoff output, canonical-root resolution, pushed-head finish guard, remote-lookup fail-closed behavior, and abnormal-helper-exit handling.
- Repository-wide product QA is intentionally out of scope for this workflow-efficiency track.

### OPEN

- Confirm the fresh PR #17 CI run on the latest safety-hardening head.
- PR #17 must remain separate until PR #19 is qualified and integrated. Then update #17 from the new `master`, preserving newer product/production status and PR #19 dependency hardening.
- GitHub cannot create the physical sibling worktrees on the owner's Windows machine. After PR #17 is integrated, run `node scripts/agent.cjs setup` once on that machine.
- After local setup, run `node scripts/agent.cjs doctor` and start one disposable task branch in each workspace to prove local isolation end-to-end.

### PROGRESS %

- Agent-efficiency repository implementation: 99% pending fresh CI.
- Standing-context compression and short-task protocol: 100%.
- Two-agent repository safety controls: 99% pending fresh CI confirmation of the two fail-closed guards.
- Local Windows worktree activation: 0% until the one-time local setup is run.

### NEXT STEP

Confirm PR #17 CI, keep it isolated while PR #19 is qualified, then update #17 from the integrated master, rerun all three workflows, merge it, and run `node scripts/agent.cjs setup` plus `node scripts/agent.cjs doctor` on the development PC.
