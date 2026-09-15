# Siton Agent Workspaces

This repository supports permanent isolated Git worktrees for Codex and Claude Code.

The purpose is simple: both agents may work at the same time without sharing one working directory or overwriting each other's uncommitted state.

## One-time setup

From the canonical C-ton repository directory run:

`node scripts/agent_workspace.cjs setup`

The command creates sibling worktrees when they do not already exist:

- `C-ton-codex`
- `C-ton-claude`

Each worktree receives its own standby branch:

- `workspace/codex`
- `workspace/claude`

The setup is idempotent. It refuses to overwrite an existing directory that is not already a registered Git worktree.

## Starting a task

For Codex:

`node scripts/agent_workspace.cjs start codex <task-slug>`

For Claude Code:

`node scripts/agent_workspace.cjs start claude <task-slug>`

The command:

1. requires the agent worktree to exist
2. refuses to continue if that worktree has uncommitted changes
3. fetches the latest `origin/master`
4. creates a fresh task branch from that exact remote master
5. switches only the selected agent worktree to the new task branch

Branch names are created under:

- `agent/codex/<task-slug>`
- `agent/claude/<task-slug>`

## Status

Run:

`node scripts/agent_workspace.cjs status`

This prints every registered Git worktree plus the expected Codex and Claude workspace state.

For a non-mutating preview of the setup contract run:

`node scripts/agent_workspace.cjs plan`

## Parallel work rule

Parallel implementation is allowed only when the tasks have separate coherent scopes.

The agents must still avoid editing the same logical feature at the same time even though their files are physically isolated. If two tasks touch the same subsystem heavily, use one writer and one reviewer instead.

## Merge rule

Each agent pushes its task branch and opens a Pull Request into `master`.

Do not merge by copying files between worktrees.

Do not reset, clean, stash, amend, or force-push the other agent's branch or worktree.

## Safety guarantees of the helper

`scripts/agent_workspace.cjs` deliberately does not:

- overwrite an existing non-worktree directory
- discard uncommitted changes
- hard-reset a worktree
- force-push a branch
- modify `master`
- merge a Pull Request

It only creates isolated worktrees and creates clean task branches from current `origin/master`.
