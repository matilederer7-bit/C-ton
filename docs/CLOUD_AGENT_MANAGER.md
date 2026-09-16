# Siton Cloud Agent Manager

Version: 1.0
Date: 2026-09-16
Status: cloud execution control plane

## Goal

Run meaningful Siton coding tasks on GitHub-hosted infrastructure so the owner's computer does not need to stay on.

The manager coordinates one writer and one reviewer. It owns branch creation, canonical verification, PROJECT_STATUS updates, commit, push and Pull Request creation. It never auto-merges.

## Execution model

1. The owner starts a task from GitHub Actions `workflow_dispatch` or opens an owner-authored issue whose title begins with `[agent-manager]`.
2. All Cloud Agent Manager coding runs enter one global writer queue. A second task waits instead of executing concurrently against an overlapping product scope.
3. The workflow checks which cloud credentials are available.
4. `auto` prefers Claude as the builder when Claude credentials exist. Otherwise it uses Codex when `OPENAI_API_KEY` exists.
5. `auto` uses the other provider as reviewer when possible. If only one provider is configured, the same provider performs a bounded second-pass review and the run records that the review was not independent.
6. The builder receives a generated Siton task packet with standing product, safety and Git boundaries.
7. The builder edits the GitHub-hosted checkout. It is explicitly forbidden from owning Git lifecycle or PROJECT_STATUS.
8. The manager verifies that the builder did not change branch, commit, change HEAD, or modify the cloud-manager control plane/shared status.
9. The manager runs `git diff --check` and `node scripts/siton_verify.cjs` against a disposable PostgreSQL service on the GitHub runner.
10. The reviewer inspects the actual diff in read-only mode and must return `VERDICT=PASS` or `VERDICT=CHANGES_REQUIRED`.
11. If changes are required, the builder gets exactly one automatic bounded fix pass. The lifecycle/control-plane guards and canonical verification run again, then the reviewer checks again.
12. The manager updates only its isolated `PROJECT_STATUS.md` slot, commits, pushes and opens a Pull Request.
13. If the final reviewer still requires changes, the PR is opened as draft. There is no automatic retry loop.
14. Repository Pull Request CI remains the integration authority. There is no auto-merge.

## Computer-off requirement

The workflow uses `ubuntu-24.04` GitHub-hosted runners and a disposable PostgreSQL service. After a task has been triggered, the owner's Windows computer is not part of execution.

The workflow itself, the agents, tests, Git operations and PR creation run in GitHub's cloud infrastructure.

## Authentication

At least one cloud agent credential must be configured as a GitHub Actions repository secret.

### Claude

Either of these is supported:

- `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_API_KEY`

For Claude Pro or Max, Anthropic documents `claude setup-token` as a way to create the OAuth token used by Claude Code GitHub Actions. Store the resulting token only as the GitHub Actions secret `CLAUDE_CODE_OAUTH_TOKEN`.

### Codex

- `OPENAI_API_KEY`

The OpenAI Codex GitHub Action requires an API key. A ChatGPT subscription and API billing are separate surfaces, so do not assume that ChatGPT plan access automatically creates an API key or API balance.

### Recommended Siton setup

Minimum useful cloud mode:

- Claude credential only: Claude builds and performs a bounded self-review.

Preferred two-provider mode:

- Claude credential plus `OPENAI_API_KEY`: Claude builds by default and Codex performs an independent read-only review.

The builder/reviewer can be overridden in manual workflow dispatch.

## Security boundaries

The owner-issue trigger is deliberately strict:

- event must be a newly opened issue
- issue author must equal `github.repository_owner`
- title must begin with `[agent-manager]`

This prevents arbitrary public issues from receiving access to cloud-agent credentials.

Additional boundaries:

- Managed cloud writers are serialized through one GitHub Actions concurrency group.
- Real money remains 0.
- Grow remains untouched.
- Production charging, payouts, refunds, customer messaging, destructive production data changes, live migrations and credential rotation are outside normal cloud-agent authority.
- A builder/fix pass fails if it changes branch or HEAD by committing.
- A builder/fix pass cannot modify `.github/workflows/cloud-agent-manager.yml`, `scripts/cloud_agent_manager.cjs`, `AGENTS.md`, `AI_WORKFLOW.md` or `PROJECT_STATUS.md`; the manager control plane cannot rewrite itself during a product task.
- Claude subprocess environment scrubbing is enabled.
- Reviewer mode is read-only and the workflow compares the repository diff/status before and after review.
- The manager performs at most one automatic fix pass.
- The manager never runs `gh pr merge` and never enables auto-merge.
- Pull Request CI remains mandatory evidence before owner-controlled merge.

## Triggering from ChatGPT

Once this workflow is merged and a Claude or Codex cloud credential is present, ChatGPT can create an owner task issue in the repository with the `[agent-manager]` prefix. GitHub then executes the work independently of the owner's computer.

The issue becomes the persistent task record. The manager comments back with the builder, reviewer, verdict and PR URL.

## Triggering directly from GitHub

Use Actions, then `Siton Cloud Agent Manager`, then `Run workflow`.

Inputs:

- `task`: required goal and acceptance criteria
- `builder`: `auto`, `claude`, or `codex`
- `reviewer`: `auto`, `claude`, `codex`, or `none`
- `scope`: allowed repository scope
- `do_not_touch`: additional task-specific boundaries

## Failure behavior

The workflow fails closed when:

- no supported cloud credential exists
- a requested provider is unavailable
- the builder changes branch or HEAD instead of leaving an uncommitted task diff
- the builder touches the manager control plane/shared status
- the builder produces no repository change
- canonical verification fails
- reviewer changes the repository during a read-only pass
- Git push or PR creation fails

A reviewer verdict that still requires changes after the single bounded fix pass does not cause an infinite loop. The manager commits the verified state, opens a draft PR and reports the remaining finding.

## Local agent relationship

The existing local `scripts/agent.cjs` workflow remains useful when the owner's computer is on. It provides permanent local Claude and Codex worktrees.

The cloud manager is a separate execution path for computer-off work. Both paths share:

- `AGENTS.md`
- `AI_WORKFLOW.md`
- `PROJECT_STATUS.md`
- repository tests and gates
- GitHub Pull Requests as the integration boundary

Cloud-managed writes are serialized with each other. Local work still must not edit the same active task scope as the currently running cloud task.