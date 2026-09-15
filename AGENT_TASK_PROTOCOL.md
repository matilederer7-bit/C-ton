# Siton Agent Task Protocol

Purpose: let the owner assign work to Codex or Claude Code with a very short prompt because repository rules, architecture, safety boundaries, testing expectations, and completion behavior already live in the repository.

## Minimum task brief

A normal task may be only this:

```text
TASK: <desired outcome>
SCOPE: <optional subsystem, files, or surface>
DO NOT TOUCH: <optional exclusions>
MODE: build | review | parallel-part
```

Only `TASK` is mandatory when the intended scope is obvious.

The agent must derive the rest from `AGENTS.md`, `AI_WORKFLOW.md`, `PROJECT_STATUS.md`, canonical architecture/product files, and the current repository state. Do not ask the owner to repeat rules already present there.

## Defaults when fields are omitted

- MODE defaults to `build`.
- Base is current `origin/master`.
- Make the smallest coherent change that fully solves the task.
- Preserve product and safety invariants from `AGENTS.md`.
- Use focused tests during development.
- Use the canonical completion verification when applicable.
- Update `PROJECT_STATUS.md` after a meaningful milestone.
- Inspect the final diff, commit clearly, push the task branch, and open a PR when integration is expected.
- Do not perform broad external research unless explicitly assigned; ChatGPT normally supplies external facts.

## Builder mode

The builder owns implementation inside the assigned scope.

Before editing:

1. confirm the worktree is the correct agent workspace
2. start a fresh task branch from current `origin/master`
3. read only the current compact status and task-relevant source files before reaching for historical material

At completion leave this handoff packet:

```text
RESULT: PASS | PARTIAL | BLOCKED
BRANCH: <branch>
COMMIT: <sha>
PR: <number/url or none>
CHANGED: <short list>
TESTED: <exact checks + outcomes>
OPEN: <remaining blocker or none>
NEXT: <one next action>
```

Do not paste long command transcripts unless a failure requires evidence.

## Reviewer mode

A reviewer receives a PR number, commit SHA, or branch plus the review objective.

Minimal review assignment:

```text
REVIEW: <PR / commit / branch>
FOCUS: <optional risk or question>
```

Reviewer rules:

- review the actual diff and current code, not the builder summary alone
- run or inspect relevant tests when useful
- look for correctness, regressions, invariant violations, missing tests, hidden scope expansion, and unsafe assumptions
- classify findings by severity and give exact file/behavior evidence
- stay read-only by default
- do not fix the same scope while reviewing unless explicitly switched to repair mode

Review completion format:

```text
VERDICT: APPROVE | CHANGES_REQUIRED | BLOCKED
P0/P1: <count + short findings>
P2: <count + short findings>
TEST_EVIDENCE: <what was checked>
RECOMMENDED_NEXT: <one action>
```

## Parallel-part mode

Use this only when the owner or coordinating agent has split one objective into non-overlapping parts.

Each assignment must name its owned scope and forbidden overlap. Example:

```text
TASK: add seller profile image upload
SCOPE: seller profile API + storage adapter tests
DO NOT TOUCH: seller UI; Claude owns that in parallel
MODE: parallel-part
```

If new information makes the scopes overlap materially, stop changing the overlapping area and report the collision instead of silently competing.

## Builder-to-reviewer handoff

Normal pattern:

1. Builder finishes implementation, status update, commit, push, and PR.
2. Reviewer receives only the PR/commit plus any special focus.
3. Reviewer returns verdict and findings.
4. If changes are required, the original builder repairs them unless ownership is explicitly reassigned.
5. Reviewer re-checks the repaired diff.

This avoids two agents alternately rewriting the same code.

## Role selection

Codex and Claude Code do not have permanently fixed roles.

Choose per task:

- use the agent already closest to the relevant context as builder
- use the other as reviewer for risky or important changes
- use both as parallel builders only for genuinely separate scopes
- for adversarial review, the reviewer should start from the PR/diff rather than the builder's reasoning narrative

The objective is maximum verified progress per owner interaction, not equal work distribution between agents.

## Owner interaction rule

Do not ask routine approval questions. Ask only when an unresolved decision materially affects money, security, legal exposure, irreversible production data, or a major product choice.

For ordinary implementation choices, inspect, decide, implement, test, and report.
