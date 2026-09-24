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

A Claude credential is optional: without one the team runs OpenAI-only, and review is Codex reviewing Codex rather than cross-provider. When configured, exactly one Claude credential is used. The manager selects it and passes only that one to `claude-code-action`; configuring both is allowed but the OAuth token is then ignored. A configured Anthropic key that the provider rejects blocks the preflight, because the manager selects Claude from key presence alone and would route Claude steps to the failing key: replace it, or delete the secret to return to OpenAI-only mode.

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

It is `workflow_dispatch` only, on purpose. A `push` trigger would run the pushed revision of the workflow and of the script it invokes with all four long-lived secrets bound, on any branch and before any review, which would let an unreviewed branch exfiltrate every cloud credential. The script's own regression tests run secretless on every Pull Request inside the release-tools suite, so nothing is lost by refusing the automatic trigger.

It reports, per secret, whether it is configured and whether the provider actually accepts it, plus which of `gpt-6-luna`, `gpt-6-sol` and `gpt-6-astra` the OpenAI account can reach. Secret values are never printed, stored or echoed; every emitted string is scrubbed against the configured secrets first.

Three verdicts:

- `BLOCKED` — something needed is missing or refused. The report names the exact owner action and the run fails. An unreachable Luna or Sol blocks, because ordinary routed work stops at the manager's own model-access gate. A missing Claude credential does not block; a present but rejected Anthropic key does.
- `READY, WITH UNVERIFIED TOKEN PERMISSIONS` — everything checkable passed, but the lifecycle token is fine-grained. `permissions.push` proves Contents write and nothing else; GitHub does not expose a fine-grained token's own permissions and there is no side-effect-free way to exercise them, so **Actions, Issues and Pull requests write are not verified**. The report lists them so you can confirm them on the token. This matters: without Actions write the swarm dispatch fails, and without Pull requests write the Pull Request fails, both *after* the build has already run.
- `READY` — everything checkable passed with nothing left unverified. Only a classic token carrying the `repo` scope reaches this, because that scope is readable from the API response.

An unreachable `gpt-6-astra` is a warning, not a blocker: Apex is opt-in, so ordinary routed work is unaffected.

### Recommended Siton setup

Minimum useful cloud mode (OpenAI-only):

- `SITON_AGENT_GITHUB_TOKEN`
- `OPENAI_API_KEY`

This gives Codex build plus bounded same-provider review. The preflight reports READY with a warning that cross-provider review is unavailable.

Preferred two-provider mode:

- `SITON_AGENT_GITHUB_TOKEN`
- Claude credential
- `OPENAI_API_KEY`

Claude builds by default and Codex performs an independent read-only review.

The builder/reviewer can be overridden in manual workflow dispatch.

## No separate Claude runtime is required

`anthropics/claude-code-action@v1` is enough to run Claude in the cloud. It installs and drives Claude Code on the same GitHub-hosted runner that already holds the checkout, the installed dependencies and the disposable PostgreSQL service, so the builder tests and inspects the exact tree the manager verifies and commits.

A separate Claude Code remote environment, a self-hosted runner or a hosted agent session would add a second execution surface, a second credential path and a second place for the working tree to diverge, while adding nothing the action does not already provide. It is deliberately not used.

What the action does not grant by default is Bash. The manager therefore declares the builder's tool boundary explicitly: npm, npx and node for focused tests, read-only git for diff inspection, and no `git commit`, `git push` or `gh`. The Git lifecycle is refused at the tool layer as well as by the branch/HEAD check that follows.

## Security boundaries

The owner-issue trigger is deliberately strict:

- event must be a newly opened issue
- issue author must equal `github.repository_owner`
- title must begin with `[agent-manager]`

This prevents arbitrary public issues from receiving access to cloud-agent credentials.

Additional boundaries:

- Managed cloud writers are serialized through one GitHub Actions concurrency group.
- The workflow's default `GITHUB_TOKEN` is read-only for code. It holds `contents: read` and `pull-requests: read`, so it can never push a branch, create a Pull Request or merge.
- It holds `issues: write` for one reason: the run result, including a credential blocker, must reach the owner even when `SITON_AGENT_GITHUB_TOKEN` is absent. GitHub scopes permissions per job, not per step, so the builder's `github_token` carries that same issue-comment ability. This is a recorded trade-off, not an oversight: a builder that can comment on an issue is a far smaller exposure than a control plane that fails silently, and the boundaries that matter (no push, no PR, no merge, no workflow edit, no HEAD change) are unaffected.
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
2. **Anthropic API key (optional).** Needed only for Claude as builder or cross-provider reviewer. Open https://console.anthropic.com/settings/keys , choose *Create Key*, name it `siton-cloud-agent`, and copy the value. It is shown once. Skip this step for OpenAI-only operation.
3. **OpenAI API key.** Open https://platform.openai.com/api-keys , choose *Create new secret key*, name it `siton-cloud-agent`, and copy the value. Confirm the project has credit; a ChatGPT subscription does not by itself grant API access.
4. **Store them as repository secrets.** Open https://github.com/matilederer7-bit/C-ton/settings/secrets/actions and use *New repository secret* once per credential, with these exact names: `SITON_AGENT_GITHUB_TOKEN`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` only if you created it in step 2.
5. **Verify.** Run `Siton Cloud Credential Preflight` from Actions. It must not report `BLOCKED`. With the fine-grained token from step 1 it reports `READY, WITH UNVERIFIED TOKEN PERMISSIONS` and lists the three write permissions it cannot check; confirm those against step 1 rather than assuming them.

Until step 5 stops reporting BLOCKED, every managed run stops at credential resolution and comments the missing secret names back on its source issue.

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