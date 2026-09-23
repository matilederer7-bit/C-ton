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

The executable mapping is explicit: Economy uses `gpt-6-luna` with low reasoning; Standard uses `gpt-6-sol` with medium reasoning; Senior uses the same `gpt-6-sol` model with high reasoning; Apex remains the exceptional `gpt-6-astra` path with high reasoning and explicit evidence. The security lane and default head synthesis use Senior; only explicitly justified head synthesis escalates to Apex; test and source-of-truth scans use Economy. Model identifiers must be reviewed when OpenAI changes Codex model availability.

## Definition of done

A managed task closes only after implementation, focused coverage, canonical verification, independent review when available, commit, pushed task branch, Pull Request, repository CI, staging deployment when applicable, smoke or browser verification when applicable, and status update. Merge remains owner-controlled.

## Agent telemetry

Each managed run emits a `siton.agent-run.v1` JSON record as a GitHub Actions artifact. It records routing, builder, reviewer, bounded fix count, verification result, review verdict, duration and Pull Request URL. These records are the basis for later routing changes. Routing policy must not be changed from anecdote alone.

## Required repository configuration

- `SITON_AGENT_GITHUB_TOKEN`, a GitHub token able to push task branches, create Pull Requests and trigger normal CI.
- `OPENAI_API_KEY` for Codex cloud execution.
- Optional: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for Claude cloud execution and cross-provider review.

OpenAI-only operation is a supported first-class mode: Codex may build and review with the same provider, while the four-lane analysis swarm remains available. Adding Claude improves provider independence but is not a prerequisite for computer-independent phone operation. The manager reports same-provider review explicitly.

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

## Verified model support and access boundary (2026-09-23)

- Official [model catalog](https://developers.openai.com/api/docs/models) lists the GPT-6 family as `gpt-6-luna`, `gpt-6-sol` and `gpt-6-astra`. Sol is documented for complex coding and agentic workflows; Luna is the efficient high-volume model. [Astra documentation](https://developers.openai.com/api/docs/models/gpt-6-astra) remains the exceptional high-compute path.
- The local Codex app advertises `gpt-6-astra` among its available task/agent models. This is app availability, not an entitlement check for a GitHub API key.
- The [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action) accepts `model` and `effort` and invokes Codex through the Responses API. The workflow passes the routed model on every Codex build/review/fix call.
- Inspected the actual OpenAI Action v1 source at commit `86365089eb2b84e0a8fb0717b304f8bdcb13b20e`: `action.yml` declares `model`, `effort` and `permission-profile`; `src/runCodexExec.ts` passes the model directly as `--model` and effort as `model_reasoning_effort`, with no three-model allowlist.
- Before invocation, `scripts/agent_model_access.cjs` uses the actual workflow secret to retrieve the selected model metadata from OpenAI. Fail closed on missing key, unavailable model or request failure, without printing credentials or provider bodies. Metadata access is NOT inference proof; a successful real agent step is still needed.
- This editing session could not inspect repository secrets or perform an authenticated cloud inference. Browser settings access was signed out; the available GitHub connector does not expose secrets or workflow dispatch. Do not claim cloud activation or per-key Astra inference from the public catalog.

## Start work here

The owner's normal entry point is ChatGPT on the phone. GitHub is the execution control plane, not a UI the owner must operate for routine work.

1. State the desired outcome in ChatGPT. ChatGPT acts as the human-facing team lead and creates an owner-authored `[agent-manager]` Issue through the connected GitHub account.
2. `.github/workflows/agent-manager-intake.yml` is the owner-only intake. On an opened or reopened manager Issue, it dispatches `cloud-agent-manager.yml` on `master` through GitHub's supported `workflow_dispatch` API. The optional `agent-manager-run` label is a deliberate retrigger path. No manual Actions button is required.
3. The intake carries the structured Issue fields into the dispatch: task type, risk, compute tier, Apex reason/evidence, scope and protected areas. Ordinary tasks stay on the economical tier selected by the router; database, security, payments and high/critical-risk work have a Senior floor.
4. The manager selects the builder and reviewer, runs the builder in an isolated task branch, performs canonical verification, runs an independent reviewer when credentials allow it, permits at most one bounded fix pass, updates `PROJECT_STATUS.md`, commits and pushes.
5. Sensitive or Apex work must automatically launch `cloud-analysis-swarm.yml` before the PR opens. Four read-only lanes run in parallel: architecture, security, tests and source-of-truth. A fifth head reviewer synthesizes them. A material swarm finding forces the resulting PR to remain draft.
6. The manager opens the PR, attaches reviewer and swarm evidence, emits telemetry even on failed managed runs, and comments the source Issue with the run/PR result. It never auto-merges.
7. Repository CI remains authoritative. ChatGPT can inspect the PR, checks, logs and follow-up findings through the connected GitHub app and can perform the merge when the owner has asked for autonomous execution and the required gates are green.

Required repository configuration remains:
- `SITON_AGENT_GITHUB_TOKEN`, able to push task branches, create PRs and trigger downstream Actions. Its fine-grained permissions must include Actions read and write, because sensitive and Apex runs dispatch and then watch the swarm with this token.
- `OPENAI_API_KEY` for Codex execution.
- Optional: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for Claude and cross-provider review. OpenAI-only operation is valid without it; when Claude is added, `ANTHROPIC_API_KEY` is preferred for unattended cloud runs.

`.github/workflows/cloud-credential-preflight.yml` reports which of those are configured and which the provider actually accepts, without revealing any value. Run it before declaring the team operational and after any credential rotation. `docs/CLOUD_AGENT_MANAGER.md` holds the step-by-step owner activation runbook.

A missing provider must be reported honestly. Sensitive work does not silently drop below Senior. Apex does not silently fall back from Astra.

## Activation evidence log

### 2026-09-23 — ChatGPT-to-cloud path exercised, Codex nested-trigger defect isolated

- ChatGPT created owner-authored Issue #77. The owner-only intake accepted it and dispatched manager run `35917126097` with no local computer involved.
- Credential preflight attempt 2 on run `35751558579` live-checked `SITON_AGENT_GITHUB_TOKEN` and `OPENAI_API_KEY` as present and accepted. Claude remains absent and is now treated as optional for OpenAI-only operation.
- The manager passed dependency install, role resolution, selected-model metadata access and isolated branch creation. It then failed at the first Codex inference because `openai/codex-action@v1` rejected nested actor `github-actions[bot]`.
- The pinned OpenAI action exposes `allow-bots: true` specifically for trusted GitHub-owned bot actors. The manager and swarm now set that input on every Codex invocation. This does not allow arbitrary bots or users.
- Routing is upgraded to GPT-6: Luna for Economy, Sol medium for Standard, Sol high for Senior, Astra only for explicit Apex escalation.
- Post-merge proof still required: rerun credential preflight against the new model IDs, retrigger Issue #77 until a managed PR is created, then run one sensitive smoke that completes the four parallel lanes and fifth synthesis.

### 2026-09-22 — control plane proven, credentials absent

Verified on GitHub-hosted runners with no local computer involved.

| Claim | Evidence | State |
|---|---|---|
| Owner issue reaches the intake | Intake run `35717039463` from Issue #74 | PASS |
| Intake dispatches the manager | Manager run `35717048403` started from that dispatch | PASS |
| Four analysis lanes are genuinely parallel | Swarm run `35732713799`: architecture, security, tests and source-of-truth all started 13:19:31Z on four distinct runners; head synthesis started only at 13:19:44Z | PASS |
| The router executes in the cloud | `Route head synthesis` succeeded in that same run | PASS |
| Missing credentials fail closed, never downgrade | Every lane stopped at `Verify analyst model access`; no lane substituted a reachable model | PASS |
| A blocked run reports to the owner's phone | Manager run `35732726575` posted the missing secret names and the exact owner action to Issue #74 with no `SITON_AGENT_GITHUB_TOKEN` present | PASS |
| Credential state is checkable without a terminal | Preflight run `35732337550` reported `Overall: BLOCKED` with a per-secret table | PASS |
| `SITON_AGENT_GITHUB_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` configured | Preflight run `35732337550`: all four reported `not configured` | BLOCKED, owner action |
| Claude builds, Claude reviews, Codex builds, real Luna/Terra/Sol/Astra inference | Not attempted; requires the credentials above | NOT PROVEN |

Nothing above may be restated as a successful agent inference. Model metadata access and job topology are not proof that a builder or reviewer produced work.

First activation proof is not complete until all of the following have happened on `master`: intake trigger PASS, manager dispatch PASS, a harmless managed task produces a PR, the required model-access step succeeds, a sensitive test launches the four-lane swarm, the fifth synthesis completes, and the source Issue receives the result. Only then may the status be declared `CLOUD AGENT TEAM OPERATIONAL`.
