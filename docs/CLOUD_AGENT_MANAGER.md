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
12. The manager updates only its isolated `PROJECT_STATUS.md` slot, commits, pushes and opens a Pull Request using a dedicated GitHub credential rather than the workflow's default `GITHUB_TOKEN`.
13. If the final reviewer still requires changes, the PR is opened as draft. There is no automatic retry loop.
14. Repository Pull Request CI remains the integration authority. There is no auto-merge.

## Computer-off requirement

The workflow uses `ubuntu-24.04` GitHub-hosted runners and a disposable PostgreSQL service. After a task has been triggered, the owner's Windows computer is not part of execution.

The workflow itself, the agents, tests, Git operations and PR creation run in GitHub's cloud infrastructure.

## Authentication

Computer-off execution needs two credential classes:

1. one coding-agent credential
2. one dedicated GitHub lifecycle credential

All credentials must be stored only as GitHub Actions repository secrets.

### Claude

Exactly one Claude credential is needed. The manager selects it and passes only that one to `claude-code-action`; configuring both is allowed but the OAuth token is then ignored.

- `ANTHROPIC_API_KEY` — preferred for this system.
- `CLAUDE_CODE_OAUTH_TOKEN` — supported fallback.

`ANTHROPIC_API_KEY` is preferred because the whole point of this control plane is that no computer has to be switched on. The OAuth token is produced by running `claude setup-token` on a machine and expires, so every renewal would force the owner back to a terminal. An API key created once in the Anthropic Console has no such recurring local step. Choose the OAuth token only if billing must stay on a Claude Pro or Max subscription rather than API credit.

### Codex

- `OPENAI_API_KEY`

The OpenAI Codex GitHub Action requires an API key. A ChatGPT subscription and API billing are separate surfaces, so do not assume that ChatGPT plan access automatically creates an API key or API balance.

### GitHub lifecycle

Required secret:

- `SITON_AGENT_GITHUB_TOKEN`

Use a dedicated fine-grained personal access token limited to the `matilederer7-bit/C-ton` repository. It should have only the repository permissions needed for the manager lifecycle:

- Actions: read and write
- Contents: read and write
- Issues: read and write
- Pull requests: read and write
- Metadata: read-only (GitHub forces this)

Actions is not optional. Sensitive and Apex runs dispatch `cloud-analysis-swarm.yml` and then watch and download its synthesis artifact with the same token, so a token without Actions write fails at the swarm step after the build has already been paid for.

Do not grant Administration, Workflows or repository-secret access. The builder is forbidden from editing `.github/workflows/`, so the token never needs to push a workflow change.

Why this exists: GitHub's normal `GITHUB_TOKEN` is deliberately kept read-only in the Cloud Agent Manager. GitHub also suppresses normal workflow chaining for events created by `GITHUB_TOKEN`, and repositories may block workflow-created pull requests. A dedicated fine-grained token lets the manager push its task branch and open a PR that enters the repository's ordinary CI flow.

The checkout does not persist credentials. Builders therefore do not inherit the lifecycle token. The dedicated token is exposed only to the final manager-owned Git push/PR/comment steps.

### Credential preflight

`.github/workflows/cloud-credential-preflight.yml` answers "can the agent team actually run?" without a terminal and without revealing any secret value.

Run it from Actions, or from the GitHub mobile app, using `Siton Cloud Credential Preflight` then `Run workflow`. Give the optional `issue_number` input to have the report posted as an issue comment instead of only into the run summary.

It reports, per secret, whether it is configured and whether the provider actually accepts it, plus which of `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol` and `gpt-6-astra` the OpenAI account can reach. A blocked preflight names the exact owner action and fails the run. Secret values are never printed, stored or echoed; every emitted string is scrubbed against the configured secrets first.

### Recommended Siton setup

Minimum useful cloud mode:

- `SITON_AGENT_GITHUB_TOKEN`
- one Claude credential

This gives Claude build plus bounded same-provider review.

Preferred two-provider mode:

- `SITON_AGENT_GITHUB_TOKEN`
- Claude credential
- `OPENAI_API_KEY`

Claude builds by default and Codex performs an independent read-only review.

The builder/reviewer can be overridden in manual workflow dispatch.

## Security boundaries

The owner-issue trigger is deliberately strict:

- event must be a newly opened issue
- issue author must equal `github.repository_owner`
- title must begin with `[agent-manager]`

This prevents arbitrary public issues from receiving access to cloud-agent credentials.

Additional boundaries:

- Managed cloud writers are serialized through one GitHub Actions concurrency group.
- The workflow's default `GITHUB_TOKEN` is read-only.
- The dedicated GitHub lifecycle token is not persisted into the checkout and is used only by manager-owned Git/PR/comment steps.
- Real money remains 0.
- Grow remains untouched.
- Production charging, payouts, refunds, customer messaging, destructive production data changes, live migrations and credential rotation are outside normal cloud-agent authority.
- A builder/fix pass fails if it changes branch or HEAD by committing.
- A builder/fix pass cannot modify any `.github/workflows/` file, `scripts/cloud_agent_manager.cjs`, `AGENTS.md`, `AI_WORKFLOW.md` or `PROJECT_STATUS.md`; the manager control plane cannot rewrite itself during a product task.
- Claude subprocess environment scrubbing is enabled.
- Reviewer mode is read-only and the workflow compares the repository diff/status before and after review.
- The manager performs at most one automatic fix pass.
- The manager never runs `gh pr merge` and never enables auto-merge.
- Pull Request CI remains mandatory evidence before owner-controlled merge.

## Owner activation runbook

These are the only steps a person must perform by hand. Everything after them is automatic.

1. **GitHub lifecycle token.** Open https://github.com/settings/personal-access-tokens/new . Set Token name to `siton-agent-manager`, Resource owner to `matilederer7-bit`, Expiration to your preferred rotation period, and Repository access to *Only select repositories* → `matilederer7-bit/C-ton`. Under Repository permissions set Actions, Contents, Issues and Pull requests to *Read and write* (Metadata becomes read-only automatically). Generate the token and copy it.
2. **Anthropic API key.** Open https://console.anthropic.com/settings/keys , choose *Create Key*, name it `siton-cloud-agent`, and copy the value. It is shown once.
3. **OpenAI API key.** Open https://platform.openai.com/api-keys , choose *Create new secret key*, name it `siton-cloud-agent`, and copy the value. Confirm the project has credit; a ChatGPT subscription does not by itself grant API access.
4. **Store all three as repository secrets.** Open https://github.com/matilederer7-bit/C-ton/settings/secrets/actions and use *New repository secret* three times, with these exact names: `SITON_AGENT_GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
5. **Verify.** Run `Siton Cloud Credential Preflight` from Actions. It must report `Overall: READY`.

Until step 5 reports READY, every managed run stops at credential resolution and comments the missing secret names back on its source issue.

## Triggering from ChatGPT

Once this workflow is merged and the GitHub lifecycle credential plus at least one coding-agent credential are present, ChatGPT can create an owner task issue in the repository with the `[agent-manager]` prefix. GitHub then executes the work independently of the owner's computer.

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

- `SITON_AGENT_GITHUB_TOKEN` is absent
- no supported coding-agent credential exists
- a routed Codex model is not reachable with the configured `OPENAI_API_KEY`
- a requested provider is unavailable
- the builder changes branch or HEAD instead of leaving an uncommitted task diff
- the builder touches the manager control plane/shared status
- the builder produces no repository change
- canonical verification fails
- reviewer changes the repository during a read-only pass
- Git push or PR creation fails

Every blocked run still reports to its source issue. The result comment is posted with `SITON_AGENT_GITHUB_TOKEN` when it exists and otherwise with the workflow's own read-only-for-code token, which holds `issues: write` for exactly this reason. A credential failure therefore reaches the owner's phone instead of leaving the issue silent.

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