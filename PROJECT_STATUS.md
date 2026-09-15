# Siton current project status

Updated: 2026-09-15
Purpose: compact current-state source for agents. `PROJECT_STATUS.md` remains the historical status archive and is read only when older milestone history is actually needed.

## Current architecture

- GitHub repository `matilederer7-bit/C-ton` is the source of truth for code and reviewed history.
- `master` is the integration branch.
- Render runs the hosted staging Web/backend service `siton-staging-web` and is connected to `master` with auto-deploy enabled.
- Supabase project `siton-staging` is the canonical staging PostgreSQL/runtime data boundary for the current architecture.
- Base44 is legacy/bounded material unless a newer explicit task says otherwise. Do not move business authority back into Base44 because old files still exist.

## Permanent product rules

- Siton platform fee is 8%.
- The fee is calculated on the full customer amount actually collected, including shipping/delivery and excluding VAT.
- There is no in-system distributor commission, balance, entitlement, or payout rail.
- Distributor functionality is attribution, measurement, and sharing unless the owner explicitly changes it.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, and 90% success rules remain safety boundaries.
- Real-money activation is separate from technical readiness and must not be inferred from green code/tests.

## Engineering workflow track

### Completed

- Stage 1: canonical `AGENTS.md` and `AI_WORKFLOW.md` created and merged.
- Stage 2 implementation: canonical `npm run siton:verify` command created. It combines static release preflight, isolated migration proof, route authorization, and the complete grouped repository suite inside a safe local boundary.
- Stage 2 PR #16 has Release Readiness and Web Runtime Depth green. The heavy Backend Quality workflow has passed its individual static, migration, unit, integration, DB, API, worker, payment, authorization, security, concurrency, failure and E2E stages; final duplicate full-suite/Docker completion is still running at the time of this status update.
- Stage 3 implementation prepared: isolated Codex and Claude Code Git worktrees, clean task-branch creation, dirty-worktree protection, documentation and contract test.
- Stage 4 implementation prepared: canonical Pull Request template plus machine-readable PR governance workflow.
- Stage 5 repository-side implementation prepared: canonical required-check list and drift contract.
- Stage 6 infrastructure already exists in Render: staging tracks `master` with auto-deploy, pre-deploy migration command and `/readiness` health check.
- Stage 7 basic implementation prepared: read-only hosted staging smoke workflow after successful master Release Readiness.

### Checked

- No GitHub repository ruleset currently protects `master`.
- Current GitHub connector does not have repository Administration permission, so it cannot create/modify the master ruleset.
- Render service configuration was inspected: branch `master`, auto-deploy enabled, build `npm ci && npm run build:demo`, pre-deploy `npm run db:migrate`, start `npm run start:web:prod`, health check `/readiness`.
- Hosted smoke implementation performs GET requests only and carries no credentials or mutation path.
- Worktree helper contains no hard reset or force-push path and refuses dirty task switching / overwrite of existing non-worktree directories.

### Open

- Merge Stage 2 only after the final Backend Quality workflow is fully green.
- Rebase/land the workflow-hardening branch after Stage 2 is on `master`, run its PR CI, then merge only when green.
- One GitHub owner/admin action is required: create the `master` ruleset described in `docs/GITHUB_MASTER_RULESET.md` and require the contexts in `config/required-merge-checks.json`.
- Verify the Render auto-deploy produced the exact merged commit and that hosted staging smoke is green.
- The historical `PROJECT_STATUS.md` is very large. Do not feed it into every agent task; use this compact file. A future local maintenance pass may archive/rotate the historical file safely without losing history.

### Progress

Engineering workflow efficiency track: approximately 80% implemented, approximately 65% fully enforced/verified.

The gap between implemented and enforced is mainly the pending CI completion, master GitHub ruleset, landing the prepared workflow branch, and post-merge hosted verification.

### Next step

1. finish Stage 2 CI and merge PR #16 if green
2. open the prepared workflow-hardening PR against the new `master`
3. let all CI gates validate it
4. merge when green
5. verify Render deploy and hosted smoke
6. enable the one-time GitHub master ruleset in repository settings

## Agent reading rule

For routine work read this file, not the full historical `PROJECT_STATUS.md`.

Open `PROJECT_STATUS.md` only when the task needs older milestone history that is absent here. When a meaningful milestone closes, update this compact file first with completed, checked, open, percentage and next step. Preserve the historical archive rather than repeatedly loading it into context.
