# Siton agent efficiency quickstart

This is the shortest operational view for the owner/coordinator.

## One-time machine setup

From `C-ton`:

`node scripts/agent_workspace.cjs setup`

Creates:

- `C-ton-codex`
- `C-ton-claude`

## Give work

Normal implementation task:

```text
TASK: <what should be true when done>
```

Add only when useful:

```text
SCOPE: <owned area>
DO NOT TOUCH: <exclusions>
MODE: build | review | parallel-part
```

Standing rules, architecture, testing, status, commit/push and PR behavior are already in the repository. Do not paste them again.

## Start agent branch

Codex:

`node scripts/agent_workspace.cjs start codex <task-slug>`

Claude Code:

`node scripts/agent_workspace.cjs start claude <task-slug>`

## Best two-agent patterns

### One important task

Agent A = builder.

Agent B = reviewer after Agent A opens a PR.

Reviewer gets only:

```text
REVIEW: PR #<number>
FOCUS: <optional concern>
```

### Two independent tasks

Run both as builders in their own worktrees and branches. State each scope and what the other agent owns.

### Overlapping task

Do not use two writers. One writes; one reviews.

## What the owner should receive at the end

Builder:

```text
RESULT / BRANCH / COMMIT / PR / CHANGED / TESTED / OPEN / NEXT
```

Reviewer:

```text
VERDICT / P0-P1 / P2 / TEST_EVIDENCE / RECOMMENDED_NEXT
```

Anything longer is optional evidence, not the default.

## Token rule

Read `PROJECT_STATUS.md` by default.

Do not read `PROJECT_STATUS_ARCHIVE_PRE_2026-09-15.md` unless historical detail is actually needed.
