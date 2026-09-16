# Siton agent efficiency quickstart

Owner goal: give a short task, not a repeated project constitution.

## One-time setup

Run from the canonical repository on the owner machine:

```bash
node scripts/agent.cjs setup
```

This fetches `origin/master`, creates separate permanent Claude and Codex worktrees if missing, and runs the workspace doctor. Do not run a second setup command.

## Start a task

```bash
node scripts/agent.cjs start claude "fix seller image upload"
```

Optional constraints:

```bash
node scripts/agent.cjs start claude "fix seller image upload" --scope "seller image flow only" --do-not-touch "payments, Grow, buyer flow" --mode builder
```

The command creates a clean task branch from current `origin/master` and an untracked task packet inside the worktree Git metadata. The packet includes the task, scope, boundaries, base SHA, branch, compact current status and finish contract.

Default context budget: `AGENTS.md`, the task packet, the relevant current section of `PROJECT_STATUS.md`, and only files needed for the task. Do not read archives or scan the whole repository without evidence.

## Finish a task

The agent supplies its own completion metadata:

```bash
node scripts/agent.cjs finish claude \
  --completed "seller image upload fixed" \
  --tested "targeted tests and repository verifier passed" \
  --open "none in task scope" \
  --percentage "100% of task scope" \
  --next "review PR" \
  --message "fix(seller): harden image upload"
```

Finish is fail-closed. It runs the canonical verifier, `git diff --check`, updates `PROJECT_STATUS.md`, commits, pushes, verifies the remote SHA, opens or reuses a PR through GitHub CLI, prints a compact owner summary, and returns the agent worktree to standby. It never auto-merges.

## Summarize a CI failure

Latest failed run:

```bash
node scripts/agent.cjs ci
```

Specific run:

```bash
node scripts/agent.cjs ci 123456789
```

The output is intentionally compact: workflow, failed job, failed step, first meaningful error, suspect files, reproduction hint and run URL.

## Parallel-agent rule

Claude and Codex may work simultaneously only on non-overlapping scopes in their own worktrees. Builder and reviewer is preferred to two agents independently implementing the same task.

External research on providers, regulation, Grow, market data or web documentation belongs outside coding-agent credit. Give coding agents conclusions and repository tasks, not broad research assignments.

## Safety invariants

- Real money remains zero unless the owner explicitly authorizes activation.
- Grow remains untouched unless explicitly authorized.
- Siton fee remains 8% of the full collected amount including delivery and other applicable charges, excluding VAT.
- There is no distributor commission or payout rail.
