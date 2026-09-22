# Siton AI Development Workflow

Version: 1.0
Date: 2026-09-15
Status: canonical operating workflow for coding agents

This document defines how Codex and Claude Code should execute repository work. `AGENTS.md` is the short binding ruleset. This file contains the detailed workflow.

## Cloud team entry points

- Writable cloud task: open the `Siton Cloud Agent Task` issue form or dispatch `.github/workflows/cloud-agent-manager.yml`.
- Parallel read-only review: dispatch `.github/workflows/cloud-analysis-swarm.yml`; four isolated lanes run concurrently and a fifth head reviewer synthesizes them.
- Apex (Astra) is an exceptional fourth tier requiring a structured reason and evidence; the default head reviewer stays Sol. Exact entry links, triggers and activation checks are in `docs/ENGINEERING_OPERATING_SYSTEM.md`.
- Routing policy and telemetry: `scripts/agent_router.cjs` and `docs/ENGINEERING_OPERATING_SYSTEM.md`.
- Local isolated worktrees remain available through `node scripts/agent.cjs`.

GitHub Issues and Pull Requests are the handoff contract between Codex and Claude. Do not depend on one model's chat transcript being visible to the other.

## 1. Current operating model

The owner defines product intent, priorities, and acceptance criteria.

ChatGPT is normally responsible for external research and for converting product decisions into implementation-ready instructions when outside information is required.

Codex and Claude Code are primarily implementation, repository inspection, testing, code-review, integration, and debugging agents.

The goal is to minimize manual copying, repeated explanations, and owner intervention while keeping changes auditable and reversible.

## 2. Current platform map

Use the repository's newest architecture/status documents for exact details, but the current high-level model is:

- GitHub: source of truth for code and reviewed repository history
- Render: hosted web/backend runtime for staging
- Supabase: PostgreSQL and supporting infrastructure for the current staging architecture
- repository tests and gates: executable evidence of implementation correctness
- Base44: historical/legacy or explicitly bounded material unless a newer current task names a live Base44 responsibility

Do not move business authority back into a deprecated runtime path because old code still exists.

## 3. Product truth and business rules

Before implementing product behavior, inspect the current canonical foundation decision and relevant amendments.

Permanent current rules include:

- Siton fee is 8% of the full amount actually collected from the customer, including shipping/delivery and excluding VAT.
- The 8% is the Siton platform fee model. Do not recreate an older `commission_rate` model.
- Distributors do not receive an in-system commission or payout. Their role is attribution, measurement, and sharing unless the owner explicitly changes this.
- Product and UX decisions that have been superseded by newer dated canonical amendments must not be revived from old documents.

## 4. Task intake

For every meaningful task:

1. read the task literally
2. inspect current branch and working-tree state
3. read the relevant part of `PROJECT_STATUS.md`
4. read `AGENTS.md`
5. read the canonical product/source-of-truth document
6. inspect the relevant implementation and tests before proposing edits
7. identify the smallest coherent implementation boundary

Do not begin by coding from the task description alone when the repository can answer important questions.

## 5. Autonomy rule

Routine engineering actions should be completed without asking the owner for repeated approval.

Examples of routine actions include:

- repository inspection
- targeted refactoring necessary for the task
- adding or updating tests
- running tests and static checks
- creating a task branch
- committing completed work
- pushing the task branch
- opening a Pull Request
- updating `PROJECT_STATUS.md`

Escalate only for genuinely material ambiguity or protected external actions.

## 6. Protected external actions

A normal coding task does not by itself authorize activation of external production effects.

Unless the owner explicitly authorizes the specific action, do not activate or execute real-world production effects such as:

- real customer charging
- real seller payouts
- real refunds
- production customer messaging
- production data destruction
- production schema migration
- credential rotation
- deletion of hosted production resources
- switching live DNS or provider authority

It is acceptable to prepare code, dry-run paths, synthetic proofs, mocks, staging configuration, or deployment instructions when the task requires them.

## 7. Branch discipline

Default for meaningful work:

1. start from current `master`
2. create a descriptive task branch
3. make the task change only
4. test it
5. update status
6. commit
7. push
8. open a Pull Request

Direct edits to `master` should be reserved for trivial low-risk repository maintenance or an explicit owner instruction.

Never force-push `master`.

## 8. Two-agent operation

The repository is expected to be used by both Codex and Claude Code.

### Until Git worktrees are configured

Parallel writing is allowed only when the agents are isolated in separate working directories/process contexts and separate branches.

An agent must not:

- overwrite another agent's uncommitted files
- reset another agent's branch
- clean another agent's working directory
- stash another agent's work
- amend another agent's commit
- force-push another agent's branch

If isolation cannot be guaranteed, one agent is the writer and the other is reviewer/read-only for that task.

### Reviewer role

When one agent reviews the other:

1. inspect the actual changed files
2. inspect the diff against the intended base
3. run or inspect relevant tests
4. compare behavior against canonical product/runtime rules
5. look specifically for hidden state, money, security, concurrency, migration, and backward-compatibility regressions where relevant
6. report findings by severity with concrete evidence

A review is not a rewrite contest. Do not replace correct code merely because another style is preferred.

## 9. Scope discipline

Each task should have one clear boundary.

Do not combine feature work with unrelated cleanup, architecture redesign, dependency upgrades, or formatting sweeps unless they are required to complete the task safely.

If a nearby problem is discovered but not required for the current task:

- document it
- classify severity
- leave it for a separate task unless it blocks correctness

This reduces collisions between agents and makes review reliable.

## 10. Test strategy

The repository currently has many dedicated scripts and gates. There is not yet one canonical all-in verification command beyond the grouped `npm test` path.

For each task choose tests based on risk:

### Minimum

- focused regression test for the changed behavior
- relevant type/build/static check

### Medium-risk change

Also run:

- nearby integration tests
- dedicated package script/gate for the touched subsystem

### High-risk or cross-cutting change

Also run:

- `npm test`
- relevant security, DB, payment, concurrency, failure, architecture, migration, or E2E gates

Do not claim complete repository verification if only focused tests were run.

When a test fails, classify it honestly as:

- caused by the current change
- pre-existing
- environment/infrastructure blocked
- flaky/unproven

A failing test may be changed only when the agent can show that the test itself contradicts current canonical behavior.

## 11. Bug-fix rule

For a bug:

1. reproduce or prove the failure where practical
2. identify root cause
3. make the narrow fix
4. add or strengthen a regression test
5. run the focused proof
6. run the nearby regression set
7. inspect the diff for accidental behavior changes

Do not treat symptom suppression as root-cause closure.

## 12. Failure-loop rule

Do not burn time or credits on repetitive loops.

After two materially similar failed attempts:

1. stop the current tactic
2. re-read the error and relevant code
3. inspect runtime/config/data assumptions
4. identify what assumption was wrong
5. start a materially different approach

If still blocked, leave the branch and repository in a clean understandable state and report the exact blocker plus the next best action.

## 13. External research rule

Broad external research belongs outside the coding-agent loop by default.

Do not use Codex or Claude Code credits to investigate current provider docs, legal/regulatory questions, market conditions, pricing, general vendor comparisons, or unrelated web information unless specifically assigned.

When ChatGPT supplies researched conclusions, treat them as task inputs but still validate that the requested implementation fits the repository's actual architecture and contracts.

## 14. PROJECT_STATUS protocol

Every meaningful milestone must append a status entry containing:

### What was completed
A factual summary of the delivered change.

### What was checked
Exact tests, gates, runtime checks, or evidence performed.

### What is open
Known remaining work in the same track and any external blocker.

### Progress percentage
A sober percentage for this specific track, not for the entire company/product unless explicitly requested.

### Next step
One concrete next action.

Do not erase historical status entries unless the task is explicitly a status-document maintenance task.

## 15. Commit and push protocol

Before committing:

- inspect `git status`
- inspect the complete diff
- remove accidental generated/temp files
- verify no secret material is present
- confirm tests were actually run
- update status if required

Then:

- use a clear commit message
- push the branch
- open a Pull Request when integration or review is expected

If a task is incomplete because of a real blocker, do not create a misleading completion commit. Commit only coherent useful work and state the blocker clearly.

## 16. Pull Request content

A Pull Request should state:

- problem or requested outcome
- implementation summary
- files/areas changed
- exact tests and outcomes
- known limitations or remaining work
- whether external rails or hosted environments were touched

Keep it short enough to review.

## 17. Completion report to the owner

Use a compact factual format:

Result

Changed

Tested

Commit

Branch / PR

Open item

Do not narrate every terminal command.

## 18. Current staged improvement plan

The workflow itself will be hardened in stages. Agents should not pretend later stages already exist.

Current stage:

- Stage 1: canonical agent rules and workflow documentation

Planned next stages:

- Stage 2: one canonical Siton verification command
- Stage 3: dedicated Git worktrees for Codex and Claude Code
- Stage 4: Pull Request as the normal integration path
- Stage 5: mandatory CI gates before merge
- Stage 6: automated staging deployment
- Stage 7: browser-level hosted smoke/E2E verification
- later stages: deeper runtime observability, direct tool integrations, and more autonomous cloud execution

When implementing a later stage, update this section and `PROJECT_STATUS.md` rather than assuming it silently exists.

## 19. Final standard

The purpose of this workflow is not maximum agent activity.

The purpose is maximum verified progress with minimal owner intervention, minimal collision between agents, and an audit trail strong enough for an experienced human engineer to understand and challenge.
