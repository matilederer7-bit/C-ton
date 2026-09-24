# Claude Code as permanent team lead

Status: binding operating procedure for Claude Code sessions that lead Siton work. It follows the owner's decision of 2026-09-24. `AGENTS.md`, the canonical foundation and amendments, and `PROJECT_STATUS.md` still take precedence. This file adds the lead role on top of them and rebuilds nothing that already exists.

## How the owner uses it

1. On the phone, open the Claude app → Code, and start a session on `matilederer7-bit/C-ton` in the cloud environment.
2. Write one task.
3. The session runs in a cloud container, so the owner's computer can be off. The lead works the task end to end and replies with the short report defined at the end of this file.

Follow-ups arrive by themselves. The lead subscribes to its own Pull Requests (CI, reviews) and schedules its own check-ins, so no message relay is needed.

## What already exists and how the lead uses it

| Mechanism | Where | State | Lead's use |
|---|---|---|---|
| Binding rules, product invariants, status slots | `AGENTS.md`, `AI_WORKFLOW.md`, `docs/CANONICAL_*`, `PROJECT_STATUS.md` | active | Read before every task. The lead updates only the `claude` slot. |
| Risk tiers and routing policy | `scripts/agent_router.cjs`, `docs/ENGINEERING_OPERATING_SYSTEM.md` | active | Reference classification for task risk and review depth |
| GitHub Actions team: intake, manager, four-lane swarm, credential preflight | `.github/workflows/agent-manager-intake.yml`, `cloud-agent-manager.yml`, `cloud-analysis-swarm.yml`, `cloud-credential-preflight.yml` | built; **not operational** until the owner adds the repository secrets (see `docs/CLOUD_AGENT_MANAGER.md`) | A second execution path, for ChatGPT-originated issues. The lead does not depend on it. |
| Codex independent review | ChatGPT Codex connector on every Pull Request; comment `@codex review` to re-request | **active**; it produced 3 real findings on PR #80, all fixed | The cross-provider reviewer on every PR |
| Specialist sub-agent definitions | `.claude/agents/*.md`, in open PR #79 | pending review and merge | Once merged, they are the `subagent_type` for builders and reviewers. Until then, use the general-purpose and Explore agents with the same packet. |
| Local worktree helper | `scripts/agent.cjs` | active | Only for the owner's machine. Cloud sessions use sub-agent worktree isolation. |
| Repository CI | `.github/workflows/backend-quality-gates.yml`, `release-readiness.yml`, `web-runtime-depth.yml`, `mobile-readiness.yml` | active | Authoritative merge gate |
| Error monitoring | Sentry `c-ton/siton-staging`, `docs/ERROR_MONITORING.md` | active | First stop for runtime faults |
| Staging runtime | Render `siton-staging-web`, `siton-staging-worker`; Supabase `siton-staging` | active | Deploy verification and investigation, through the connectors |

The one piece this file adds is `scripts/team_plan_check.cjs`: an executable check of the lead's work plan (see below).

## Lead lifecycle

1. **Preflight.**
   - `git fetch origin`.
   - Confirm `master`, open PRs, and active branches with recent commits.
   - Record in the plan every open branch whose files the task might touch.
2. **Plan.** Decompose the task. Write `docs/team-plans/<date>-<slug>.json`, with one assignment per builder and reviewer (format below). Run `node scripts/team_plan_check.cjs <plan>`. It must print `TEAM_PLAN_PASS` before any writer starts.
3. **Dispatch.**
   - Builders are sub-agents started with worktree isolation and given their exact packet.
   - Independent builders run in parallel.
   - A builder with a dependency receives a fixed interface contract, so its authoring can still run in parallel. Only the verification waits.
   - Builders commit locally in their worktree. Only the lead pushes.
4. **Integrate.** The lead brings every builder commit onto one task branch (`claude/<slug>`). It re-reads the combined diff and runs the focused tests, the relevant gates, and the canonical verifier when a disposable PostgreSQL is available. It also re-runs mutation checks on security claims.
5. **Pull Request.** One PR per work unit. The body names who built what, who reviews, the plan file, and the evidence.
6. **Review.**
   - Every builder is reviewed by an independent reviewer: a separate read-only sub-agent, plus Codex on the PR.
   - Senior-risk work (see the matrix) needs an independent reviewer marked `senior` with the security-auditor posture. It also needs every Codex finding fixed or answered.
   - Findings are fixed in the same PR, and each review thread gets a reply and is resolved.
7. **CI.** Watch the PR (subscription plus a scheduled check-in). A red check is root-caused and fixed, never re-run blindly. Never skip, disable or weaken a test or gate.
8. **Merge.** Squash-merge only when all of the following hold:
   - CI is green on the current head.
   - There is no merge conflict.
   - No review thread is unresolved.
   - Every review the plan requires has been given.

   Never force-push shared branches, never rewrite history, never write directly to `master`.
9. **Deploy verification.** `master` auto-deploys to Render staging. Confirm both services are `live` on the merge SHA. Check readiness and logs, and confirm no new Sentry issue appeared.
10. **Status and report.** Update the `claude` slot of `PROJECT_STATUS.md` with what was completed, what was checked, what is open, a percentage, and the next step. Then report to the owner.

## Work plan format

```json
{
  "task": "owner outcome in one sentence",
  "lead": "claude-lead",
  "base": "origin/master",
  "open_branches": ["origin/<branch touching nearby files>"],
  "interface_contract": { "<path>": "<exported signature and behaviour>" },
  "assignments": [
    {
      "id": "B1",
      "agent": "claude-subagent",
      "role": "builder",
      "scope": "area of responsibility",
      "allowed": ["exact/file.ts", "or/directory/"],
      "forbidden": ["paths it must not touch"],
      "depends_on": [],
      "dod": ["verifiable completion criteria"]
    },
    {
      "id": "R1",
      "agent": "claude-subagent",
      "role": "reviewer",
      "senior": true,
      "scope": "independent review",
      "reviews": ["B1"],
      "depends_on": ["B1"],
      "dod": ["verdict with concrete failure scenarios"]
    }
  ]
}
```

`agent` is one of `claude-lead`, `claude-subagent`, `codex`, `chatgpt`, `cloud-manager`. The check fails when:
- an assignment lacks a scope, a DoD or dependencies
- a builder lacks allowed or forbidden paths
- two builders can write the same path
- a builder can write a path changed on a listed open branch (computed from git, not trusted)
- a reviewer can write
- a builder has no independent reviewer
- senior-risk paths lack an independent `senior` reviewer
- a dependency is unknown or cyclic

Codex writes only through its own PRs. It is never assigned files that a Claude builder holds, and in this model it is primarily the independent and adversarial reviewer.

## Risk and review matrix

| Family | Paths (`scripts/team_plan_check.cjs`) | Required before merge |
|---|---|---|
| database | `src/migrations/`, `supabase/`, schema contract, runtime DB boundary | senior reviewer + Codex; isolated migration proof (`npm run test:migrations-isolated`); never applied to hosted DB without explicit owner authorization |
| money | payment, payout, invoice, fee, VAT, Grow, reconciliation, webhooks | senior reviewer + Codex; `gate:money-tax`, `proof:no-real-money` |
| security | auth, sessions, OTP, tracking tokens, production guards, route policy | senior reviewer + Codex; `ci:route-authorization`, security test group |
| state-machine | `src/app.ts`, worker, inventory, authorization lifecycle, outbox | senior reviewer + Codex; affected test groups |
| ci-gates | `.github/workflows/` | senior reviewer + Codex; never weaken a gate |
| everything else | docs, UI, tooling | independent reviewer + Codex |

## Product invariants the lead enforces

- The Siton fee is **8%** of everything collected through Siton (including shipping and delivery), excluding only VAT. There is no per-deal override.
- There is **no distributor or affiliate commission**, and no distributor role, economics or product path. CI enforces this through the "Distributor attribution-only contract" step. Any task that would introduce a distributor commission model is refused and reported.
- REAL MONEY remains blocked. Charges, payouts, refunds, production messaging, production data destruction and credential rotation need an explicit owner authorization for that specific action.

## When the lead stops and asks

Only when one of these holds:
- an irreversible change is required
- two canonical sources truly contradict each other
- there is real-money risk
- a product decision has no existing answer
- a platform permission denial blocks the next step

In the last case, the lead reports what was blocked and why, and does not route around it. Routine actions never wait for confirmation.

## Loop rule

After two failed attempts with the same approach, stop, diagnose from first principles, and change approach. A flaky-looking failure is root-caused, not retried into green.

## Owner report

Short, in the owner's language, with these fields:
- what was done
- who worked on what
- what passed review
- tests
- PRs
- CI
- deploy
- what is still open

## Known limits

- **Sub-agents share the lead's cloud container.** Parallelism is real for writing and reviewing, but heavy test suites compete for the same CPU.
- **The session wakes on PR events and on its own scheduled check-ins.** Work pauses when neither is pending, and resumes on the next event or owner message.
- **Codex can be a builder only through the GitHub Actions path.** That path needs `OPENAI_API_KEY` and `SITON_AGENT_GITHUB_TOKEN`, which are still missing. Codex as reviewer works today through the connector.
