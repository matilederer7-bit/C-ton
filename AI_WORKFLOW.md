# Siton AI Development Workflow

Version: 1.3
Date: 2026-09-16
Status: canonical execution workflow for coding agents

`AGENTS.md` is the binding ruleset. This file is optional process context, not mandatory standing context for every task.

## Operating model

- Owner: product intent, priorities, acceptance criteria, material decisions.
- ChatGPT: external research and cross-agent task framing when needed.
- Codex / Claude Code: repository implementation, debugging, tests, review, integration.
- GitHub: source of truth for code and reviewed history.
- Render: hosted staging Web/backend runtime.
- Supabase: canonical staging PostgreSQL/supporting infrastructure.
- Base44: legacy/bounded unless a newer explicit task says otherwise.

Goal: maximum verified progress with minimum owner interaction, repeated context, and agent collision.

## Context loading

Normal task startup should stay small:

1. `PROJECT_STATUS.md`
2. `AGENTS.md`
3. task-relevant code/tests/docs only

Load `AGENT_TASK_PROTOCOL.md`, `AGENT_WORKSPACES.md`, this file, the older canonical foundation document, or the project-status archive only when the task actually needs them.

Do not repeatedly load large history files.

## Short task intake

A normal task may be only:

```text
TASK: <desired outcome>
```

Optional:

```text
SCOPE: <owned area>
DO NOT TOUCH: <exclusions>
MODE: build | review | parallel-part
```

Do not ask the owner to restate standing repository rules.

## One command surface

Owner-facing workflow uses:

`node scripts/agent.cjs <command>`

Main commands:

```text
setup
status
doctor
start codex <task>
start claude <task>
review <codex|claude> <PR|commit|branch>
handoff <PR|commit|branch>
finish <codex|claude>
```

The lower-level worktree helper remains an implementation detail.

## Worktree / branch model

Permanent sibling worktrees:

- `C-ton-codex`
- `C-ton-claude`

Every new implementation branch starts from current `origin/master`.

The helper resolves the canonical repository root even when invoked from one of the linked worktrees.

`finish` is conservative: it refuses dirty worktrees, detached state, `master`, an unpushed branch, or a local HEAD that is not fully present on origin. It then returns only that agent workspace to its standby branch.

## Builder flow

1. Start a fresh task branch.
2. Read compact current context plus task-relevant files.
3. Inspect before editing.
4. Implement the smallest coherent change.
5. Run focused tests.
6. Run `npm run siton:verify` when applicable.
7. Inspect final diff.
8. Update compact project status for a meaningful milestone.
9. Commit, push, and open/update PR.
10. Report the compact completion packet.

## Reviewer flow

Reviewer receives a PR, commit, or branch plus optional focus.

Reviewer:

- reads the actual diff/current code
- checks relevant tests/evidence
- looks for regressions, invariant violations, missing tests, unsafe assumptions, and scope creep
- stays read-only by default
- reports concrete findings by severity

Repair normally goes back to the original builder.

## Parallel work

Use two builders only for clearly separate coherent scopes.

Each parallel assignment states owned scope and forbidden overlap. Shared files are not edited concurrently unless one agent is explicitly designated integrator after both parts are complete.

If scopes begin to overlap materially, stop changing the overlap and report the collision.

For risky cross-cutting work, prefer builder + adversarial reviewer.

## Autonomy and loop control

Routine repository work proceeds without asking for repeated approval.

After two materially similar failed attempts, stop repeating the tactic, re-diagnose, and change approach.

Do not repeatedly run the full suite without a new reason. Use focused checks while iterating.

## External research boundary

Broad web research stays outside the coding-agent loop by default.

Do not burn Codex/Claude Code credits on current provider docs, Grow research, law/regulation, market research, vendor pricing, or general web research unless explicitly assigned.

## Protected external effects

A coding task never implicitly authorizes real customer charging, seller payouts, refunds, production messaging, destructive production data changes, production migrations, credential rotation, deletion of hosted resources, or live provider/DNS authority changes.

## Status and handoff

`PROJECT_STATUS.md` contains current state only. Historical milestone detail stays in the archive.

Builder packet:

```text
RESULT / BRANCH / COMMIT / PR / CHANGED / TESTED / OPEN / NEXT
```

Reviewer packet:

```text
VERDICT / P0-P1 / P2 / TEST_EVIDENCE / RECOMMENDED_NEXT
```

PR/commit diff and checks are the primary handoff object. Do not create long handoff documents.

## Final standard

The workflow succeeds when the owner can give a short task, each agent works in an isolated directory, a reviewer can start from a PR alone, context is loaded only on demand, and routine completion requires no owner mediation beyond decisions that genuinely belong to the owner.
