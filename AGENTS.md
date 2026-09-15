# Siton Agent Operating Rules

This file is binding for Codex, Claude Code, and any other coding agent working in this repository.

## Start every meaningful task

Default standing context is intentionally small.

Read first:

1. `PROJECT_STATUS.md`
2. this `AGENTS.md`
3. only task-relevant source, tests, migrations, runbooks, or current product/architecture files

Read these only when needed:

- `AGENT_TASK_PROTOCOL.md` for review, parallel-builder, repair, or handoff semantics
- `AGENT_WORKSPACES.md` for worktree mechanics or troubleshooting
- `AI_WORKFLOW.md` for workflow/process questions
- `docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md` when the task genuinely depends on foundational architecture/product history
- `PROJECT_STATUS_ARCHIVE_PRE_2026-09-15.md` only for older milestone history

Do not load historical or workflow documents by default merely because they exist.

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
- The 8% fee applies to the full customer amount actually collected, including shipping/delivery, excluding VAT.
- There is no in-system distributor commission, distributor balance, payout entitlement, or distributor payment rail.
- Distributor functionality is attribution, measurement, and sharing unless a newer owner decision changes it.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, and 90% success rules remain safety boundaries.
- Green technical checks never authorize real-money activation.

## How to work

A short owner brief is intentional. `TASK: <desired outcome>` is enough when scope is obvious. Optional fields are `SCOPE`, `DO NOT TOUCH`, and `MODE`.

Work autonomously inside the assigned scope. Inspect before editing. Make the smallest coherent change that fully solves the task. Do not mix unrelated cleanup into the same patch.

Do not stop for routine confirmation. Ask only when an unresolved decision materially affects real money, security, legal exposure, irreversible production data, or a major product choice.

Do not weaken tests, gates, security checks, or product invariants merely to make a change pass.

After two materially similar failed attempts, stop repeating the same tactic. Re-diagnose from first principles and change approach.

## External research boundary

Codex and Claude Code are repository execution agents first.

Do not spend coding-agent time on broad external research such as provider documentation, market research, regulation, vendor pricing, Grow documentation, or general web research unless the owner explicitly assigns it.

ChatGPT normally performs external research and gives coding agents implementation facts, constraints, and acceptance criteria. Repository-local investigation is always expected.

## Testing

Use focused tests during implementation.

The canonical completion command is:

`npm run siton:verify`

It is the full repository completion gate when the task and environment require it. It excludes real-money actions and production mutation. It requires Node 22+ and a disposable local PostgreSQL `DATABASE_URL`; hosted staging/production databases are refused.

Never claim a test passed if it was not run. Report PASS, FAIL introduced by this change, pre-existing FAIL, NOT RUN, or BLOCKED by unavailable infrastructure.

Documentation-only/workflow-only changes may use focused contract checks instead of unrelated product QA.

## One owner-facing agent command

Use:

`node scripts/agent.cjs <command>`

Common commands:

- `setup`
- `status`
- `doctor`
- `start codex <task>`
- `start claude <task>`
- `review <codex|claude> <PR|commit|branch>`
- `handoff <PR|commit|branch>`
- `finish <codex|claude>`

`scripts/agent_workspace.cjs` is the lower-level implementation helper. Owners and agents should normally use `scripts/agent.cjs`.

## Two-agent coordination

Codex and Claude Code use separate permanent sibling worktrees:

- `C-ton-codex`
- `C-ton-claude`

Every implementation task starts on a fresh `agent/<agent>/<task>` branch from current `origin/master`.

Default modes:

- single builder: one agent writes
- builder + reviewer: one writes, the other reviews the PR read-only
- parallel builders: allowed only for clearly separate scopes with explicit forbidden overlap

Never let both agents edit the same scope concurrently.

Never reset, clean, stash, checkout over, amend, or force-push another agent's work.

A reviewer reads the actual diff and checks, not the builder summary alone, and stays read-only unless explicitly switched to repair mode.

## Git workflow

For meaningful work, use a task branch and Pull Request rather than direct work on `master`.

Before commit:

1. inspect `git status`
2. inspect the full diff
3. verify no secrets or generated junk were added
4. run appropriate focused checks and canonical verification when applicable
5. update `PROJECT_STATUS.md` for meaningful milestones

Use a clear commit message. Push the completed branch. Open or update the appropriate Pull Request. Never force-push `master`.

## PROJECT_STATUS.md

Keep it compact and current.

After a meaningful milestone record only:

- COMPLETED
- CHECKED
- OPEN
- PROGRESS %
- NEXT STEP

Historical detail belongs in the archive, not the standing context.

## Definition of done

A meaningful task is done when applicable items are true:

- requested behavior is implemented
- relevant tests/checks were run and classified honestly
- final diff was reviewed
- `PROJECT_STATUS.md` was updated
- changes were committed clearly
- branch was pushed
- Pull Request was opened or updated when expected
- remaining blockers and next step are explicit

Builder completion should be compact:

`RESULT / BRANCH / COMMIT / PR / CHANGED / TESTED / OPEN / NEXT`

Reviewer completion should be compact:

`VERDICT / P0-P1 / P2 / TEST_EVIDENCE / RECOMMENDED_NEXT`

No long terminal transcript unless it is needed as failure evidence.
