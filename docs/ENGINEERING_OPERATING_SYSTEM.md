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
| Database, security, payments, authentication and critical concurrency | Senior | Codex | Independent review plus four read-only lanes |

`scripts/agent_router.cjs` is the executable policy. High-risk classification overrides a requested cheaper tier. A provider outage may fall back to the available provider, but the run records that review was not cross-provider.

The executable mapping is explicit: Economy uses `gpt-5.6-luna`, Standard uses `gpt-5.6-terra`, and Senior uses `gpt-5.6-sol`. The security lane and head synthesis use Senior; test and source-of-truth scans use Economy. Model identifiers must be reviewed when OpenAI changes Codex model availability.

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
