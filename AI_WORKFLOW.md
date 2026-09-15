# Siton AI Development Workflow

Version: 1.2
Date: 2026-09-15
Status: canonical execution workflow for coding agents

`AGENTS.md` is the binding ruleset. `AGENT_TASK_PROTOCOL.md` defines the short task/review handoff. `AGENT_WORKSPACES.md` defines two-agent Git isolation. This file explains the operating flow without repeating every standing rule.

## 1. Operating model

- Owner: product intent, priorities, acceptance criteria, material decisions.
- ChatGPT: external research, task framing, cross-agent coordination when needed.
- Codex / Claude Code: repository implementation, debugging, testing, review, integration.
- GitHub: source of truth for code/history.
- Render: hosted staging web/backend runtime.
- Supabase: canonical staging PostgreSQL/supporting infrastructure.
- Base44: legacy/bounded unless a newer explicit task says otherwise.

Goal: maximum verified progress with minimum owner interaction, repeated context, and agent collision.

## 2. Context-loading discipline

For normal work read:

1. `PROJECT_STATUS.md`
2. `AGENTS.md`
3. `AGENT_TASK_PROTOCOL.md`
4. task-relevant source/tests/docs
5. canonical product/architecture document when the task touches those rules

Read `PROJECT_STATUS_ARCHIVE_PRE_2026-09-15.md` only when historical context is actually required.

Do not load large historical documents by default merely because they exist.

## 3. Short task intake

The owner may intentionally provide only:

```text
TASK: <desired outcome>
SCOPE: <optional>
DO NOT TOUCH: <optional>
MODE: build | review | parallel-part
```

Only `TASK` is mandatory when scope is obvious.

Do not ask the owner to repeat repository rules, architecture, test policy, status protocol, or completion behavior already documented here.

## 4. Worktree / branch model

Codex and Claude Code use separate sibling worktrees:

- `C-ton-codex`
- `C-ton-claude`

One-time setup:

`node scripts/agent_workspace.cjs setup`

Start a task:

- `node scripts/agent_workspace.cjs start codex <task-slug>`
- `node scripts/agent_workspace.cjs start claude <task-slug>`

Every task branch starts from current `origin/master`.

Worktrees solve filesystem collisions; they do not make overlapping product scopes safe.

## 5. Builder flow

1. Confirm correct worktree and clean state.
2. Start a fresh task branch from current `origin/master`.
3. Read compact current context and task-relevant files.
4. Inspect before editing.
5. Make the smallest coherent implementation.
6. Use focused tests for fast feedback.
7. Run canonical completion verification when applicable.
8. Inspect final diff and secrets/generated junk.
9. Update `PROJECT_STATUS.md` for a meaningful milestone.
10. Commit clearly, push branch, open PR when integration is expected.
11. Leave the compact handoff packet from `AGENT_TASK_PROTOCOL.md`.

Do not stop for routine confirmation.

## 6. Reviewer flow

Reviewer receives a PR, commit, or branch plus optional focus.

Reviewer must:

- inspect actual diff/current code, not rely on builder narrative
- verify scope and current product/runtime invariants
- inspect or run relevant tests
- look for correctness, regressions, unsafe assumptions, missing tests, and hidden scope expansion
- report concrete findings by severity
- remain read-only by default

If repair is needed, the original builder normally fixes it. This prevents two agents from alternately rewriting the same area.

## 7. Parallel work

Use two builders only for genuinely separate coherent scopes.

A parallel-part assignment must explicitly state owned scope and forbidden overlap.

If newly discovered work causes material overlap, stop editing the overlap and report the collision. Do not silently compete.

For risky or cross-cutting work, prefer one builder + one adversarial reviewer.

Roles are not permanently assigned: either Codex or Claude Code may build or review depending on context.

## 8. Autonomy and escalation

Routine engineering work should proceed autonomously: inspection, implementation, tests, branch creation, status update, commit, push, PR.

Escalate only when an unresolved decision materially affects:

- real money
- security
- legal exposure
- irreversible production data
- a major product decision

After two materially similar failed attempts, stop repeating the same tactic and re-diagnose from first principles.

## 9. Protected external effects

A coding task does not authorize real-world production effects.

Without explicit owner authorization do not execute:

- real customer charging
- seller payouts
- real refunds
- production customer messaging
- destructive production data changes
- production schema migration
- credential rotation
- deletion of hosted production resources
- live DNS/provider-authority changes

Synthetic/local/staging-safe proof is allowed when relevant.

## 10. External research boundary

Broad web research stays outside the coding-agent loop by default.

Do not burn Codex/Claude Code credits on current provider docs, Grow research, law/regulation, market research, vendor pricing, or general web research unless explicitly assigned.

ChatGPT normally researches externally and gives coding agents implementation facts and acceptance criteria.

Repository-local investigation is always expected.

## 11. Testing

During implementation: run focused tests and nearby checks for fast feedback.

Before completing meaningful code work, use:

`npm run siton:verify`

when the environment and task require full repository verification.

The command is intended to provide one safe repository completion gate and excludes real-money actions and production mutation.

Valid reporting states are PASS, FAIL, or BLOCKED. Never turn NOT RUN or infrastructure-blocked into PASS.

Do not weaken a gate merely to make a task green.

## 12. Status protocol

`PROJECT_STATUS.md` is the compact current operational status, not an unlimited diary.

After every meaningful milestone update:

- completed
- checked
- open
- progress percentage for the relevant track
- next step

Keep historical detail in the archive when deliberate status maintenance is performed.

## 13. Completion packet

Builder completion:

```text
RESULT: PASS | PARTIAL | BLOCKED
BRANCH: <branch>
COMMIT: <sha>
PR: <number/url or none>
CHANGED: <short list>
TESTED: <exact outcomes>
OPEN: <remaining blocker or none>
NEXT: <one action>
```

Reviewer completion:

```text
VERDICT: APPROVE | CHANGES_REQUIRED | BLOCKED
P0/P1: <findings>
P2: <findings>
TEST_EVIDENCE: <what was checked>
RECOMMENDED_NEXT: <one action>
```

No long terminal transcript unless it is evidence for a failure.

## 14. Current efficiency roadmap

Completed / implemented in repository:

- Stage 1: canonical standing agent rules
- Stage 2: single completion-verification entry point (`npm run siton:verify`)
- Stage 3: separate Codex / Claude Code worktrees, short task protocol, builder-reviewer handoff, compact current status

Next efficiency priorities:

- make PR/issue references the normal handoff object between agents
- reduce owner phone workflow to short task assignment + final decision only
- give agents direct access to the external systems they genuinely need, without routing logs/data through the owner
- automate repetitive branch/PR/review orchestration where it materially saves owner interaction
- only after those workflow gains, add further CI/deployment automation when it improves development throughput rather than for its own sake

## 15. Final standard

The workflow is successful when the owner can give a short task, one agent executes it safely, the second can review it from a PR/commit, and both can work concurrently without re-sending repository context or stepping on each other's work.
