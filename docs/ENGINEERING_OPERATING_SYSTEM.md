# Siton Engineering Operating System

Status: binding operating model for agent-led engineering work.

## Control plane

GitHub is the shared control plane. Issues define work, Pull Requests carry code and evidence, checks supply machine verdicts, and `PROJECT_STATUS.md` remains the executive snapshot. Chat threads are not canonical handoff storage.

The owner's computer is not required for cloud-managed runs. `.github/workflows/cloud-agent-manager.yml` executes on a GitHub-hosted runner and owns the task branch, canonical verification, status slot, commit, push and Pull Request. It never auto-merges.

## Team topology

- The owner states the outcome once.
- The manager classifies task type, risk and compute tier.
- One builder owns each writable scope.
- Independent read-only lanes may inspect architecture, security, tests and source-of-truth in parallel.
- A different provider reviews the actual diff whenever both Codex and Claude credentials exist.
- The manager is the only integrator for a managed run.
- Repository CI runs its jobs in parallel and remains authoritative after the Pull Request opens.

`.github/workflows/cloud-analysis-swarm.yml` is the explicit parallel review path: four isolated analysts run concurrently and a fifth head reviewer reconciles their reports. It is read-only by construction and therefore may run beside a writer without creating code conflicts.

Multiple writers may run only when their file and migration ownership is disjoint. Shared or overlapping code remains serial. This is a correctness boundary, not an optimization preference.

## Routing policy

| Work | Default tier | Preferred builder | Required review |
|---|---|---|---|
| Documentation and bounded test inventory | Economy | Claude | Focused lane |
| Frontend, UX and ordinary refactors | Standard | Claude | Codex when available |
| Backend and operations | Standard | Codex | Claude when available |
| Database, security, payments, authentication and critical concurrency | Senior | Codex | Independent review; run the separate swarm for four read-only lanes |
| Documented exceptional cross-system decisions or exhausted Senior investigations | Apex | Codex or Codex reviewer | Astra on the Codex role; cross-provider review when available |

`scripts/agent_router.cjs` is the executable policy. High-risk classification overrides a requested cheaper tier. A provider outage may fall back to the available provider, but the run records that review was not cross-provider.

The executable mapping is explicit: Economy uses `gpt-5.6-luna`, Standard uses `gpt-5.6-terra`, Senior uses `gpt-5.6-sol`, and Apex uses `gpt-6-astra` with `high` reasoning. The security lane and default head synthesis use Senior; only explicitly justified head synthesis escalates to Apex; test and source-of-truth scans use Economy. Model identifiers must be reviewed when OpenAI changes Codex model availability.

## Definition of done

A managed task closes only after implementation, focused coverage, canonical verification, independent review when available, commit, pushed task branch, Pull Request, repository CI, staging deployment when applicable, smoke or browser verification when applicable, and status update. Merge remains owner-controlled.

## Agent telemetry

Each managed run emits a `siton.agent-run.v1` JSON record as a GitHub Actions artifact. It records routing, builder, reviewer, bounded fix count, verification result, review verdict, duration and Pull Request URL. These records are the basis for later routing changes. Routing policy must not be changed from anecdote alone.

## Required repository configuration

- `SITON_AGENT_GITHUB_TOKEN`, a GitHub token able to push task branches, create Pull Requests and trigger normal CI.
- `OPENAI_API_KEY` for Codex cloud execution.
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for Claude cloud execution.

When only one model provider is configured, cloud execution still works but independent cross-provider review does not. The manager reports this explicitly.

## Safety boundaries

Real-money activation, production charging, payouts, refunds, destructive production data operations and credential rotation are never implied by an engineering task. They require their own owner-authorized production process. Grow remains untouched unless the task expressly changes that boundary.

## Apex escalation contract

Apex is opt-in through structured routing fields, never inferred from a keyword or enabled merely by high/critical risk. Sensitive work still has a Senior floor. Use tier `auto` or `apex`, an approved reason, and at least 40 characters of concrete evidence. Reject contradictory lower-tier requests, unknown reasons, missing evidence and missing Codex credentials. Never silently replace Astra with Sol or Claude.

| Reason | Required evidence from the owner/operator |
|---|---|
| cross-system-architecture | The cross-system architectural decision, affected subsystems and competing alternatives |
| critical-cross-layer | Critical risk plus the coupled layers/invariants, e.g. DB, charging state and idempotency |
| conflicting-reviews | References to the conflicting reports and the unresolved substantive disagreement |
| senior-investigation-exhausted | References to distinct failed Senior attempts and the unresolved cross-layer defect |

The router validates the enum, minimum evidence length and critical-risk requirement; it does not semantically verify the operator's evidence. A routine CSS fix, broken test, standalone migration or ordinary money review does not justify Apex. No automatic retry escalates compute. Head synthesis remains Sol by default; the four analysts keep their original models. Re-run synthesis with evidence only when the above rules apply (the current swarm dispatch re-runs its four lanes as well).

Apex applies to the Codex role. If Claude builds, Astra reviews; if Codex builds, Astra builds and handles the one bounded fix pass. Explicit role overrides that remove every Codex role are rejected. Claude's model is currently provider-default, not mapped to the OpenAI tier names. Telemetry records the exact Codex model and escalation reason.

## Verified model support and access boundary (2026-09-22)

- Official [model catalog](https://developers.openai.com/api/docs/models) lists Luna, Terra, Sol and Astra with the exact IDs above. [Astra documentation](https://developers.openai.com/api/docs/models/gpt-6-astra) supports high reasoning and tool use through Responses.
- The local Codex app advertises `gpt-6-astra` among its available task/agent models. This is app availability, not an entitlement check for a GitHub API key.
- The [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action) accepts `model` and `effort` and invokes Codex through the Responses API. The workflow passes the routed model on every Codex build/review/fix call.
- Inspected the actual OpenAI Action v1 source at commit `86365089eb2b84e0a8fb0717b304f8bdcb13b20e`: `action.yml` declares `model`, `effort` and `permission-profile`; `src/runCodexExec.ts` passes the model directly as `--model` and effort as `model_reasoning_effort`, with no three-model allowlist.
- Before invocation, `scripts/agent_model_access.cjs` uses the actual workflow secret to retrieve the selected model metadata from OpenAI. Fail closed on missing key, unavailable model or request failure, without printing credentials or provider bodies. Metadata access is NOT inference proof; a successful real agent step is still needed.
- This editing session could not inspect repository secrets or perform an authenticated cloud inference. Browser settings access was signed out; the available GitHub connector does not expose secrets or workflow dispatch. Do not claim cloud activation or per-key Astra inference from the public catalog.

## Start work here

The team lives in GitHub Actions jobs, not in a permanent group chat. You can submit from a phone or any browser, then turn the computer off. GitHub-hosted Ubuntu runners execute the work; Issues, PRs and Actions artifacts retain the results.

1. Merge the reviewed PR into master first. Issue events use workflows on the default branch; the manager explicitly checks out master even when manually dispatched from another workflow ref.
2. In [Actions secrets](https://github.com/matilederer7-bit/C-ton/settings/secrets/actions), configure `SITON_AGENT_GITHUB_TOKEN` and `OPENAI_API_KEY`; configure `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for cross-provider review. ChatGPT/Codex subscription access does not establish API-key billing or model permissions. A single provider runs with same-provider review and records that limitation.
3. As `matilederer7-bit`, open [Siton Cloud Agent Task](https://github.com/matilederer7-bit/C-ton/issues/new?template=agent-manager.yml). Keep the `[agent-manager]` title prefix. Paste the outcome and acceptance criteria in Task. Set Task type, Risk and Compute tier; normally keep Auto and Apex reason = none. Opening the issue triggers the manager. Editing an existing issue or adding a comment does NOT trigger it.
4. Alternatively open [Siton Cloud Agent Manager](https://github.com/matilederer7-bit/C-ton/actions/workflows/cloud-agent-manager.yml), choose Run workflow on master, and enter the task. CLI equivalent:

```sh
gh workflow run cloud-agent-manager.yml --repo matilederer7-bit/C-ton --ref master -f task="Add a short docs-only example to the team runbook" -f task_type=docs -f risk=low -f model_tier=auto
```

5. Track execution in Actions. The manager creates a task branch, builds, verifies, reviews, permits one bounded fix, updates its status slot, commits, pushes and opens a PR. For issue-triggered success it comments with the PR link. Failures are visible in Actions; there is no guaranteed issue failure comment. Merge remains owner-controlled.
6. For four independent read-only analysts and the fifth synthesis, use [Siton Read-Only Analysis Swarm](https://github.com/matilederer7-bit/C-ton/actions/workflows/cloud-analysis-swarm.yml). Enter Task and target_ref. This is a separate workflow, NOT automatically launched by the manager's routing lanes. Reports are Actions artifacts and job summaries. For exceptional synthesis supply apex_reason and apex_evidence; critical-cross-layer also requires risk=critical.

Task type, Risk, Compute tier, Apex reason and Apex evidence are parsed from the Issue form. Scope, Allowed paths and Dependencies currently remain task-packet instructions; they are not automatic path locks or dependency scheduling. Check dependencies and local writer ownership before submitting overlapping work. GitHub concurrency serializes managed writers but retains only one pending run; it is not a durable FIFO queue. Submit the next task after the active run completes rather than flooding Issues.

For first activation, use the docs-only example above, inspect successful model access and the actual Codex step, and confirm a new PR with checks. Then run a harmless read-only swarm with a justified Apex synthesis to prove the workflow key can execute Astra. Until those runs succeed, setup is implemented but operational activation remains unproven.
