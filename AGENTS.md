# Siton Agent Operating Rules

This file is binding for Codex, Claude Code, and any other coding agent working in this repository.

## Start every meaningful task

Read:

1. `PROJECT_STATUS.md`
2. `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`
3. `docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md`
4. `AI_WORKFLOW.md`
5. the task-relevant architecture, product, UX, migration, runbook, and test files

Do not rely on memory of an older Siton phase when newer repository decisions exist.

## Source of truth

When sources disagree, use this order:

1. the owner's explicit current task or decision
2. current canonical repository decisions and amendments
3. current architecture/runtime contracts and `PROJECT_STATUS.md`
4. current implementation plus passing tests as evidence of what is implemented
5. older foundation, delivery, and historical documents

Never revive deprecated behavior only because an old file still exists.

## Current product invariants

Do not change these unless the owner explicitly changes them:

- Siton platform fee is 8%.
- The 8% fee applies to the full customer amount actually collected, including shipping/delivery and any other purchase amount collected through Siton, excluding the customer VAT component.
- There is no per-deal commission-rate override.
- Every publishable deal has a finite mandatory `max_units`; unlimited or `NULL` capacity is not canonical.
- Completion Window duration is exactly 24 hours, is not configurable, and exists only for recovery by participants whose initial charge failed and are in `ChargeFailedCompletion`.
- There is no distributor/affiliate user role or distributor product module. Canonical user roles are buyer, seller, and administrator.
- Ordinary deal sharing and role-neutral viral/acquisition analytics may exist only if they do not create distributor identity, permissions, economics, or a separate distributor product path.
- There is no fixed seven-day maximum deal duration. Older seven-day product-deadline references are historical.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, security, and 90% success rules are safety boundaries.

## How to work

Work autonomously inside the assigned task. Do not stop for routine confirmations.

Inspect before editing. Make the smallest coherent change that fully solves the task. Do not mix unrelated cleanup into the same patch.

Do not weaken tests, gates, security checks, or product invariants merely to make a change pass.

When fixing a bug, add or strengthen a regression test when practical.

After two materially similar failed attempts, stop repeating the same approach. Diagnose from first principles and try a different path.

Ask the owner only when a decision cannot be derived safely from current sources and the ambiguity materially affects money, security, legal exposure, irreversible data changes, or a major product decision.

## External research boundary

Codex and Claude Code are repository execution agents first.

Do not spend coding-agent time on broad external research such as provider documentation, market research, regulation, vendor pricing, Grow documentation, or general web research unless the owner explicitly assigns it.

The normal flow is that ChatGPT performs external research and gives the coding agent implementation facts, constraints, and acceptance criteria. Repository-local investigation is always expected.

## Testing

Until a single canonical `siton:verify` command is introduced, use the existing repository scripts truthfully.

At minimum:

- run focused tests for the changed area
- run relevant TypeScript, build, lint, scan, or architecture checks
- run `npm test` when scope or risk justifies the full grouped suite
- run additional named gates when the touched area has a dedicated script in `package.json`

Never claim a test passed if it was not run.

Classify results as PASS, FAIL introduced by this change, pre-existing FAIL, NOT RUN, or blocked by unavailable external infrastructure.

## Two-agent coordination

Codex and Claude Code may work in parallel, but must not edit the same working tree concurrently.

Until dedicated Git worktrees are configured:

- use separate branches and separate working directories/process contexts for parallel work
- never reset, clean, stash, checkout over, amend, or force-push another agent's work
- inspect `git status`, current branch, and recent commits before editing
- if another agent has active uncommitted work in the same tree, do not touch it

When reviewing another agent, review the actual diff and tests rather than trusting the summary.

## Git workflow

For meaningful work, prefer a task branch and Pull Request rather than direct work on `master`.

Before commit:

1. inspect `git status`
2. inspect the full diff
3. verify no secrets or generated junk were added
4. run appropriate tests
5. update `PROJECT_STATUS.md` for meaningful milestones

Use a clear commit message. Push the completed branch. Open a Pull Request when integration or review is expected. Never force-push `master`.

### Push checkpoint rule

Completed work must never exist only inside a session container. For every substantial task:

1. `git fetch origin` and start an isolated task branch from current `master`
2. push the branch before substantial implementation to prove GitHub write access
3. commit and push a meaningful checkpoint at each coherent milestone
4. after tests and the `PROJECT_STATUS.md` update, make the final commit and push
5. verify the remote SHA (`git ls-remote origin <branch>`) before reporting completion or opening the Pull Request

If the early preflight push fails, stop substantial work and apply the authorization fallback below instead of accumulating hours of local-only changes.

If push fails because the current session lacks GitHub authorization, especially a repeated 403 after access/setup was already attempted, do not keep retrying equivalent push methods. Preserve the coherent local commit, generate a complete patch from the intended base, and report the branch, base SHA, final commit SHA, patch path/name, and exact apply command. Continue only with work that does not depend on the blocked push.

## PROJECT_STATUS.md

At the end of every meaningful task, append a concise status block with:

- What was completed
- What was checked
- What is open
- Progress percentage for the task or track
- Next step

Do not mark a track 100% while known required work remains inside that track.

## Definition of done

A meaningful task is done only when the applicable items are true:

- requested behavior is implemented
- relevant tests were added or updated
- relevant tests pass, or failures are classified honestly
- the diff was reviewed
- `PROJECT_STATUS.md` was updated when required
- changes were committed clearly
- branch was pushed
- Pull Request was opened when expected
- remaining blockers and next step are explicit

## Completion report

Report only useful evidence:

- result
- changed files
- tests and exact outcomes
- commit SHA
- branch or Pull Request
- remaining blocker, if any

Optimize for repository correctness and verifiability, not for producing a reassuring progress report.
