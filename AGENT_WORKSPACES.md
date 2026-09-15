# Siton Agent Workspaces

Codex and Claude Code use separate permanent Git worktrees so they can work concurrently without sharing a working directory or overwriting each other's uncommitted state.

## One-time setup

From the canonical `C-ton` repository directory run:

`node scripts/agent_workspace.cjs setup`

This creates sibling worktrees when missing:

- `C-ton-codex`
- `C-ton-claude`

Each receives a standby branch:

- `workspace/codex`
- `workspace/claude`

The setup is idempotent and refuses to overwrite an existing directory that is not already a registered Git worktree.

## Start a task

Codex:

`node scripts/agent_workspace.cjs start codex <task name>`

Claude Code:

`node scripts/agent_workspace.cjs start claude <task name>`

`<task name>` may be a normal multi-word Hebrew or English description. The helper safely normalizes it into a Git branch component, so the owner does not need to invent an English slug.

Example:

`node scripts/agent_workspace.cjs start codex תיקון תמונות מוכר`

creates a branch under `agent/codex/תיקון-תמונות-מוכר`.

The command:

1. requires the agent worktree to exist
2. refuses to continue if that worktree has uncommitted changes
3. fetches current `origin/master`
4. refuses a task-branch name that already exists locally or on `origin`
5. creates a fresh task branch from current `origin/master`
6. switches only the selected agent worktree

Branches are named:

- `agent/codex/<normalized-task-name>`
- `agent/claude/<normalized-task-name>`

## Status / dry plan

`node scripts/agent_workspace.cjs status`

prints all registered worktrees plus the expected Codex and Claude workspace state.

`node scripts/agent_workspace.cjs plan`

prints the intended paths, branch prefixes, and safety boundaries without mutating the repository.

## Parallel-work rule

Separate worktrees prevent filesystem collisions. They do not make overlapping product changes safe.

Use parallel builders only for separate coherent scopes. When two tasks materially overlap, designate one agent as the writer and the other as reviewer/read-only for that task.

Never reset, clean, stash, amend, force-push, or checkout over the other agent's branch or worktree.

## Integration rule

Each builder commits and pushes only its own task branch, then opens a Pull Request into `master`.

Do not integrate by copying files between worktrees.

The reviewer reviews the actual PR diff, tests, and current repository state. The reviewer does not edit the same scope unless the task explicitly changes from review to repair.

## Safety guarantees

`scripts/agent_workspace.cjs` deliberately does not:

- overwrite an existing non-worktree directory
- discard uncommitted changes
- hard-reset a worktree
- reuse an existing local or remote task branch
- force-push
- modify `master`
- merge a Pull Request

Its job is only to create isolated workspaces and clean task branches from current `origin/master`.
