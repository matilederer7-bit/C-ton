# Siton Agent Workspaces

Codex and Claude Code use separate permanent Git worktrees so they can work concurrently without sharing a working directory or uncommitted state.

Owner-facing command:

`node scripts/agent.cjs <command>`

## One-time setup

From any Siton worktree:

`node scripts/agent.cjs setup`

Creates sibling worktrees when missing:

- `C-ton-codex`
- `C-ton-claude`

Standby branches:

- `workspace/codex`
- `workspace/claude`

The helper resolves the canonical repository root through Git's common directory, so invoking it from `C-ton`, `C-ton-codex`, or `C-ton-claude` targets the same two workspaces.

## Start a task

```text
node scripts/agent.cjs start codex <task name>
node scripts/agent.cjs start claude <task name>
```

Hebrew and English task names are normalized safely into `agent/<agent>/<task>` branches.

Start refuses:

- missing agent worktree
- dirty selected worktree
- local task-branch collision
- remote task-branch collision
- overwrite of an existing non-worktree directory

Every task branch starts from freshly fetched `origin/master`.

## Status and doctor

`node scripts/agent.cjs status`

Shows registered worktrees, branches, heads, and dirty state.

`node scripts/agent.cjs doctor`

Returns a short operational result:

- `DONE` when both worktrees exist, branches are isolated, and both are clean
- `DECISION_NEEDED` when a worktree has uncommitted changes
- `FAILED` when a required workspace is missing or a branch collision exists

## Finish

`node scripts/agent.cjs finish <codex|claude>`

Finish is intentionally conservative. It refuses to leave the current task branch unless:

- the worktree is clean
- it is not detached or on `master`
- the branch exists on origin
- local HEAD exactly matches the pushed remote branch

Then it returns only that agent workspace to its standby branch. It never resets, stashes, cleans, amends, or force-pushes work.

## Review and handoff

`node scripts/agent.cjs review claude "PR #123"`

prints the compact reviewer assignment. Review is read-only by default and the PR/diff is the primary source of truth.

`node scripts/agent.cjs handoff "PR #123"`

prints the minimum handoff contract. Do not create long handoff documents.

## Parallel-work rule

Separate worktrees prevent filesystem collisions. They do not make overlapping scopes safe.

Use two builders only for separate coherent scopes. Each must know its owned scope and the other agent's forbidden overlap.

Shared files must not be edited by both builders concurrently. If integration needs a shared file, designate one integrator after both independent parts are complete.

For overlapping or risky work, use one builder and one reviewer.

Never reset, clean, stash, checkout over, amend, or force-push another agent's work.
