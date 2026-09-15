# Siton Agent Operating Rules

This file is binding for Codex, Claude Code, and any other coding agent working in this repository.

## Start every meaningful task

Read, in this order:

1. `PROJECT_STATUS.md` — compact current state
2. `AGENT_TASK_PROTOCOL.md` — task / review / handoff contract
3. `docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md`
4. `AI_WORKFLOW.md`
5. only the task-relevant architecture, product, UX, migration, runbook, and test files

Read `PROJECT_STATUS_ARCHIVE_PRE_2026-09-15.md` only when older milestone history is actually needed. Do not load the archive by default.

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
- The 8% fee applies to the full customer amount actually collected, including shipping/delivery, excluding VAT.
- There is no in-system distributor commission, distributor balance, payout entitlement, or distributor payment rail.
- Distributor functionality is attribution, measurement, and sharing unless a newer owner decision changes it.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, and 90% success rules are safety boundaries.

## How to work

Work autonomously inside the assigned task. Do not stop for routine confirmations.

A short owner brief is intentional. If the owner supplies only `TASK`, or `TASK` plus `SCOPE` / `DO NOT TOUCH` / `MODE`, derive the rest from this repository instead of asking the owner to repeat standing instructions.

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

The canonical repository completion command is:

`npm run siton:verify`

It runs the current static release preflight, isolated migration proof, protected-route authorization gate, and complete grouped repository test suite. It deliberately excludes Docker labs, external provider calls, real-money actions, and production mutation.

The command requires Node 22 or newer and a disposable local PostgreSQL `DATABASE_URL`. It refuses hosted staging or production databases. If the required local database is unavailable, the result is BLOCKED, not PASS.

During implementation, run focused tests for fast feedback. Before completing meaningful code work, run `npm run siton:verify` unless the task is documentation-only or the environment cannot provide its prerequisites. If it cannot run, report that explicitly and do not claim full verification.

Never claim a test passed if it was not run.

Classify results as PASS, FAIL introduced by this change, pre-existing FAIL, NOT RUN, or blocked by unavailable external infrastructure.

## Two-agent coordination

Codex and Claude Code use separate Git worktrees as the canonical parallel-work model.

Expected sibling workspaces:

- `C-ton-codex`
- `C-ton-claude`

If missing, run:

`node scripts/agent_workspace.cjs setup`

Start every new implementation task from current `origin/master`:

- Codex: `node scripts/agent_workspace.cjs start codex <task-slug>`
- Claude Code: `node scripts/agent_workspace.cjs start claude <task-slug>`

See `AGENT_WORKSPACES.md` for the full contract.

Parallel builders are allowed only for separate coherent scopes. When scopes overlap materially, one agent is the writer and the other is reviewer/read-only.

Never reset, clean, stash, checkout over, amend, or force-push another agent's work.

When reviewing another agent, review the actual diff and tests rather than trusting the summary. Stay read-only unless explicitly switched to repair mode.

## Task / review / handoff format

Use `AGENT_TASK_PROTOCOL.md`.

A normal owner assignment can be as short as:

```text
TASK: <desired outcome>
SCOPE: <optional>
DO NOT TOUCH: <optional>
MODE: build | review | parallel-part
```

Builder completion and reviewer verdict must use the compact handoff formats defined there. Do not dump long command transcripts unless needed to explain a failure.

## Git workflow

For meaningful work, use a task branch and Pull Request rather than direct work on `master`.

Before commit:

1. inspect `git status`
2. inspect the full diff
3. verify no secrets or generated junk were added
4. run appropriate focused tests and the canonical verification gate when applicable
5. update `PROJECT_STATUS.md` for meaningful milestones

Use a clear commit message. Push the completed branch. Open a Pull Request when integration or review is expected. Never force-push `master`.

## PROJECT_STATUS.md

`PROJECT_STATUS.md` is intentionally compact and current. Keep it that way.

At the end of every meaningful task, update it with:

- What was completed
- What was checked
- What is open
- Progress percentage for the task or track
- Next step

Do not append unlimited historical detail. Move obsolete milestone history to the archive during deliberate status maintenance, not during ordinary feature work.

Do not mark a track 100% while known required work remains inside that track.

## Definition of done

A meaningful task is done only when the applicable items are true:

- requested behavior is implemented
- relevant tests were added or updated
- focused tests pass, or failures are classified honestly
- `npm run siton:verify` passes when the task and environment require full repository verification, or its inability to run is reported as BLOCKED
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
- canonical verification result when applicable
- commit SHA
- branch or Pull Request
- remaining blocker, if any

Optimize for repository correctness and verifiability, minimal owner intervention, and minimal context waste.
