# GitHub master ruleset

Status: repository-side contract implemented; one GitHub administration action remains.

The repository defines the required contexts in `config/required-merge-checks.json` and verifies that the corresponding workflow jobs still exist. GitHub must also enforce them at the branch level so nobody can merge or push around the checks.

## One-time GitHub setting

Create one branch ruleset targeting `master` with these rules:

- Require a pull request before merging
- Required approvals: 0
- Require status checks to pass before merging
- Require branch to be up to date before merging
- Required checks:
  - `pr-governance`
  - `backend-gates`
  - `preflight-static`
  - `preflight-database`
  - `docker-release-lab`
  - `web-runtime-core`
  - `web-runtime-resilience`
- Block force pushes
- Block branch deletion
- Do not allow direct pushes to `master`

Zero approvals is deliberate for the current owner-operated workflow: the objective is to enforce machine evidence and Pull Request discipline without forcing a second human reviewer on every change. Codex or Claude Code may still be assigned explicitly as reviewer when independent review is useful.

## Why this cannot be completed by the repository itself

Workflow files can create checks, but a workflow cannot safely make itself mandatory. That authority belongs to the repository's GitHub ruleset / branch administration layer.

Once the ruleset is enabled, `master` becomes a controlled integration branch: task branches may move freely, but merge occurs only through a Pull Request whose required checks are green.

## Drift protection

Run:

`node scripts/required_merge_checks_contract.cjs`

The `pr-governance` workflow runs this automatically on Pull Requests. If someone renames or removes a required workflow job without updating the canonical contract deliberately, the governance check fails rather than silently weakening `master` protection.
