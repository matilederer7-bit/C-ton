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
| Local worktree helper | `scripts/agent.cjs` | active | Only for the owner's machine. Cloud sessions dispatch builders directly — usually into one shared worktree kept apart by the plan's disjoint `allowed` paths (see Dispatch below), or a separate worktree per builder when scopes cannot be made disjoint. |
| Repository CI | `.github/workflows/backend-quality-gates.yml`, `release-readiness.yml`, `web-runtime-depth.yml`, `mobile-readiness.yml` | active | Authoritative merge gate |
| Error monitoring | Sentry `c-ton/siton-staging`, `docs/ERROR_MONITORING.md` | active | First stop for runtime faults |
| Staging runtime | Render `siton-staging-web`, `siton-staging-worker`; Supabase `siton-staging` | active | Deploy verification and investigation, through the connectors |

The one piece this file adds is `scripts/team_plan_check.cjs`: an executable check of the lead's work plan (see below).

## Lead lifecycle

1. **Preflight.**
   - `git fetch origin`.
   - Confirm `master`, open PRs, and active branches with recent commits.
   - Record in the plan every open branch whose files the task might touch.
   - Create the task branch `claude/<slug>` from `master` and push it before dispatching anyone. This follows the `AGENTS.md` checkpoint rule. If the push fails, stop and follow the authorization fallback in `CLAUDE.md`; never accumulate work only inside the container.
2. **Plan.** Decompose the task. Write `docs/team-plans/<date>-<slug>.json`, with one assignment per builder and reviewer (format below). Assign each of them the cheapest model that fits its risk (`haiku` for recon/lookup, `sonnet` for ordinary build work, `opus` for database, security, payments/money, auth, state-machine or architecture work, and for any senior reviewer). Prefer dispatching independent builders in parallel over serialising them, and prefer splitting a builder whose scope spans two or more areas over keeping it solo. When the task's scope must touch a path an open branch also touches, record that path in `plan.accepted_overlaps` with a justified `plan.overlap_decision` (see the work plan format below) rather than treating a failing overlap check as unsatisfiable or dispatching around it. Run `node scripts/team_plan_check.cjs <plan>` (`npm run team:plan-check <plan>` is the same thing). It must print `TEAM_PLAN_PASS` before any writer starts.
3. **Dispatch.**
   - Builders are sub-agents given their exact packet. Isolation is one of two honest options, chosen per plan: the default is one shared worktree, with builders kept apart by the plan's disjoint `allowed` paths and the mechanical `writer_overlap` check in `scripts/team_plan_check.cjs` (no two builders can be granted the same path) — there is no runtime guard enforcing a builder's `forbidden` list inside a shared tree, so it is the disjoint `allowed` grants, mechanically checked before dispatch, that make this safe, not a sandbox. When a task's scopes cannot be made disjoint, the lead gives each builder its own worktree instead.
   - Independent builders run in parallel.
   - A builder with a dependency receives a fixed interface contract, so its authoring can still run in parallel. Only the verification waits.
   - Builders commit locally, into the shared or separate worktree per the choice above. Only the lead pushes.
4. **Integrate.** The lead brings every builder commit onto the task branch and pushes a checkpoint at each coherent milestone. It re-reads the combined diff and runs the focused tests, the relevant gates, and the canonical verifier when a disposable PostgreSQL is available. It also re-runs mutation checks on security claims.
5. **Pull Request.** One PR per work unit. The body names who built what, who reviews, the plan file, and the evidence.
6. **Review.**
   - Every builder is reviewed by an independent reviewer: a separate read-only sub-agent, plus Codex on the PR.
   - Senior-risk work (see the matrix) needs an independent reviewer marked `senior` with the security-auditor posture. It also needs every Codex finding fixed or answered.
   - Findings are fixed in the same PR, and each review thread gets a reply and is resolved.
7. **CI.** Watch the PR (subscription plus a scheduled check-in). A red check is root-caused and fixed, never re-run blindly. Never skip, disable or weaken a test or gate.
8. **Status, then merge.**
   - Before merging, commit the `PROJECT_STATUS.md` update for the task (the `claude` slot: completed, checked, open, percentage, next step) onto the task PR, so it reaches `master` through that PR.
   - Squash-merge only when all of the following hold:
     - CI is green on the current head.
     - There is no merge conflict.
     - No review thread is unresolved.
     - Every review the plan requires has been given.

   Never force-push shared branches, never rewrite history, never write directly to `master`.
9. **Deploy verification.** `master` auto-deploys to Render staging. Confirm both services are `live` on the merge SHA. Check readiness and logs, and confirm no new Sentry issue appeared.
10. **Post-deploy evidence and report.** Evidence that exists only after the merge (deploy ids, live checks) goes into the next task's status update, or into a small docs-only follow-up PR that goes through the same review and CI rules. Then report to the owner.

## Work plan format

```json
{
  "task": "owner outcome in one sentence",
  "lead": "claude-lead",
  "base": "origin/master",
  "open_branches": ["origin/<branch touching nearby files>"],
  "interface_contract": { "<path>": "<exported signature and behaviour>" },
  "solo_justification": "",
  "serialization_justification": "",
  "accepted_overlaps": ["<path an open branch also touches, accepted deliberately>"],
  "overlap_decision": "",
  "assignments": [
    {
      "id": "B1",
      "agent": "claude-subagent",
      "model": "sonnet",
      "role": "builder",
      "scope": "area of responsibility",
      "allowed": ["exact/file.ts", "or/directory/"],
      "forbidden": ["paths it must not touch"],
      "depends_on": [],
      "dod": ["verifiable completion criteria"]
    },
    {
      "id": "B2",
      "agent": "claude-subagent",
      "model": "sonnet",
      "role": "builder",
      "scope": "work authored against the fixed interface contract; only its verification waits on B1",
      "allowed": ["another/exact/file.ts"],
      "forbidden": ["paths it must not touch"],
      "depends_on": ["B1"],
      "depends_on_reason": "",
      "dod": ["verifiable completion criteria"]
    },
    {
      "id": "R1",
      "agent": "claude-subagent",
      "model": "opus",
      "role": "reviewer",
      "senior": true,
      "scope": "independent review",
      "reviews": ["B1", "B2"],
      "depends_on": ["B1", "B2"],
      "dod": ["verdict with concrete failure scenarios"]
    },
    {
      "id": "R2",
      "agent": "codex",
      "model": "n/a",
      "role": "reviewer",
      "scope": "independent cross-provider review through the Codex connector on the Pull Request",
      "reviews": ["B1", "B2"],
      "depends_on": ["B1", "B2"],
      "dod": ["every Codex finding fixed or answered before merge"]
    }
  ]
}
```

`agent` is one of `claude-lead`, `claude-subagent`, `codex`, `chatgpt`, `cloud-manager`. `model` is required on every assignment (builder and reviewer alike) and must be one of exactly `haiku`, `sonnet`, `opus`, or `n/a`.

Three of those agents run on a model **Siton itself chooses**: `claude-lead`, `claude-subagent` and `cloud-manager`. The cloud manager belongs on that list because `.github/workflows/cloud-agent-manager.yml` dispatches its Claude builder, both of its Claude review passes and its bounded fix pass through `anthropics/claude-code-action@v1`, authenticated with this repository's own `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. Which model that workflow runs on is Siton's decision, so a `cloud-manager` builder holding `src/payment_reconciliation.ts` at `haiku` is a real, checkable mistake and not another vendor's business. All three must declare `haiku`, `sonnet` or `opus`; `model: n/a` on any of them fails (`model_not_applicable_misused`). The same workflow also drives Codex lanes — a Codex builder, Codex review passes and a Codex bounded fix pass — through `openai/codex-action@v1` whenever `cloud_agent_manager.cjs` routes that role to Codex instead; a task that actually ran on that lane has no honest Anthropic tier to declare, and belongs in the plan as agent `codex`, not `cloud-manager`.

`codex` and `chatgpt` run on a model Siton does **not** choose, so they declare `n/a` — and `n/a` is now the only value they may declare. Naming an Anthropic tier for one of them fails (`model_fabricated`). That rule exists because the fabrication already reached a committed record: `{"agent": "codex", "model": "sonnet"}` was backfilled into `docs/team-plans/2026-09-24-smoke-worker-log-scrub.json` and committed. Codex does not run on Anthropic's Sonnet, so the plan asserted an unverifiable fact about another vendor's product. The first attempt at a fix corrected that one line by hand and introduced `n/a` — but it also made every model-tier rule skip on the **agent**, which removed the only mechanical detector of the class: before it, a `codex` row declaring `sonnet` on a senior-risk path at least tripped `model_underpowered`; after it, the same row validated clean. The one fabricated value was erased and the mechanism that would have caught the next one went with it. `model_fabricated` puts a detector back, aimed at the fabrication itself rather than at the tier.

The model-tier rules — senior-risk builders require `opus`, a `senior: true` reviewer requires `opus`, and standard-risk work on `opus` draws a warning — are keyed on the **declared model**, not on which agent declared it, and are skipped only for `n/a`. Stating a tier is making a claim, and a claim is checked whoever makes it. Keying the skip on the agent instead is precisely what let `{"agent": "codex", "model": "sonnet"}` validate clean on a payments path.

Four strings share one justification bar, met only when the value (internal whitespace collapsed, then trimmed) clears **all three** of at least 40 characters, at least 8 words, and at least 8 **distinct** words (compared case-insensitively): the two top-level plan strings `plan.solo_justification` and `plan.serialization_justification`, the top-level `plan.overlap_decision`, and the per-assignment `depends_on_reason` on a builder that depends on any other assignment. Below that bar they count as absent — a filler string no longer unlocks an escape hatch. The distinct-word count was added because the length-and-word-count bar was cleared by `"because "` repeated eight times, and equally by `"we "` twenty times, `"TODO "` nine times, or any single word repeated sixteen times. Repetition is what that count catches, not the limit of what filler can be: a third reviewer showed that `"one two three four five six seven eight nine ten eleven"` and `"See the discussion above for the full reasoning behind this decision."` both clear all three thresholds while arguing nothing, and no text metric can do better. The bar stops accidental filler and a lazy `.repeat()`, not a determined author — the control that actually catches a hollow justification is the senior reviewer reading it. `plan.accepted_overlaps` itself is a plain array of paths, not a justified string; it is `plan.overlap_decision` that has to justify accepting them (see below). Drop a key entirely rather than leaving an empty placeholder in a real plan — the example above shows the fields only to name them.

The check fails when:
- an assignment lacks a scope, a DoD or dependencies
- a builder lacks allowed or forbidden paths
- two builders can write the same path
- a builder can write a path changed on a listed open branch, computed from git, not trusted (`open_work_overlap`) — unless the **conflicting path**, meaning the file already changed on the open branch rather than the builder's grant, is listed verbatim in `plan.accepted_overlaps`, which downgrades it to the warning `open_work_overlap_accepted`, but only when `plan.overlap_decision` meets the justification bar above; an `accepted_overlaps` entry with no qualifying `overlap_decision` leaves the original finding standing and adds `overlap_decision_missing`. Matching the conflict rather than the grant is what stops one broad line waving everything through: a builder granted `src/` plus a single `accepted_overlaps` entry of `src/` used to accept every collision beneath it, migrations and `src/payment_reconciliation.ts` included. A directory grant now has to name each conflicting file
- a reviewer can write
- a builder has no independent reviewer
- senior-risk paths lack an independent `senior` reviewer
- a dependency is unknown or cyclic
- an assignment has no `model`, or one that is not `haiku`/`sonnet`/`opus`/`n/a` (`model_missing`, `model_invalid`); a `claude-lead`, `claude-subagent` or `cloud-manager` assignment declares `model: n/a` (`model_not_applicable_misused`); a `codex` or `chatgpt` assignment declares `haiku`, `sonnet` or `opus` instead of `n/a` (`model_fabricated`)
- a builder whose allowed paths touch any senior-risk family (below) declares a `model` other than `opus` (`model_underpowered`) — skipped only when the declared model is `n/a`, never because of who the agent is
- a reviewer marked `senior: true` declares a `model` other than `opus` (`reviewer_model_underpowered`) — skipped only when the declared model is `n/a`, never because of who the agent is
- there are two or more builders and fewer than two independent agent **identities** among them can start in parallel: a root is a builder whose `depends_on` names no other assignment of any role (a dependency on a reviewer disqualifies it too), and roots that share the same non-`claude-subagent` `agent` value collapse to one identity — for example two `claude-lead` builders, or two `codex` builders, count as one, not two — unless `plan.serialization_justification` meets the justification bar above (`parallel_dispatch_missing`)
- a builder whose `depends_on` names any other assignment — a builder **or a reviewer** — has no `depends_on_reason` meeting the justification bar above (`serial_dependency_unjustified`); waiting on a reviewer is a strictly longer serial chain than waiting on the builder it reviews (finish, then be reviewed), so counting builder ids alone let a plan dodge the rule by pointing the dependency one hop further along
- there is exactly one builder and its allowed paths span two or more areas, where two things each count as an extra span on their own, so a grant naming a single area can still fire: allowed paths reaching two or more risk families (a whole-tree grant such as `allowed: ["src/"]`), and a bare single-segment directory grant such as `allowed: ["scripts/"]` or `["web/"]` — one top-level tree is one area, but it is still every gate script, or the whole frontend, under one writer. Narrower grants stay at one span and do not fire — `scripts/one_gate.cjs`, `web/src/styles.css`, and root files such as `package.json` — and the whole rule is waived when `plan.solo_justification` meets the justification bar above (`solo_justification_missing`)

Three limits of `plan.accepted_overlaps` remain, left deliberately because tightening any of them needs a richer entry shape than a bare string, which is a plan-format change. An entry is not scoped to a branch, so one entry accepts that same file collision on **every** open branch the plan lists. It is not scoped to a builder, so it accepts the collision for **every** builder holding that path. And one justified `plan.overlap_decision` licenses **every** entry in the array rather than one argument per entry. Read an entry as "this file is accepted", not "this file, on this branch, for this builder", and keep the array short enough that `plan.overlap_decision` genuinely argues each line in it.

Before this round, a task whose scope genuinely and legitimately overlapped a file an open branch also touched had no way to pass: `open_work_overlap` always failed the check, so `TEAM_PLAN_PASS` was unreachable for that task and the `CLAUDE.md` rule that a plan must print `TEAM_PLAN_PASS` before any writer starts was silently unsatisfiable — it broke the first time a real task needed it, which was this same round-two plan (`docs/team-plans/2026-09-28-orchestration-enforcement-round2.json` lists `CLAUDE.md` and `PROJECT_STATUS.md` in its own `accepted_overlaps`). `plan.accepted_overlaps` plus a justified `plan.overlap_decision` fixes that: it lets the lead accept one specific, reasoned overlap instead of the check being unsatisfiable or the lead dispatching around a failing result.

Two warnings do not fail the check: a builder with no senior-risk paths that declares `model: opus` (`model_overpowered`) — standard-risk work on the most expensive model is flagged so the lead can downshift it, but the plan still passes, and this warning, like the other model-tier rules, is keyed on the declared model and never fires for `model: n/a`, which is not a tier at all; and an accepted overlap downgraded per `plan.accepted_overlaps` above (`open_work_overlap_accepted`). `claude-lead` itself is exempt from the overpowered-model warning: the lead always runs at `opus` even on a standard-risk assignment.

Codex writes only through its own PRs. It is never assigned files that a Claude builder holds, and in this model it is primarily the independent and adversarial reviewer.

## Risk and review matrix

| Family | Paths (`scripts/team_plan_check.cjs`) | Required before merge |
|---|---|---|
| database | `src/migrations/`, `supabase/`, schema contract, runtime DB boundary | senior reviewer + Codex; isolated migration proof (`npm run test:migrations-isolated`); never applied to hosted DB without explicit owner authorization |
| money | payment, payout, invoice, fee, VAT, Grow, reconciliation, webhooks | senior reviewer + Codex; `gate:money-tax`, `proof:no-real-money` |
| security | auth, sessions, OTP, tracking tokens, production guards, route policy, PII redaction (`error_monitoring`, `log_redaction`), web client auth/session/token handling (`web/src/auth*`, `session`, `api`, `admin*`) | senior reviewer + Codex; `ci:route-authorization`, security test group |
| state-machine | `src/app.ts`, worker, inventory, authorization lifecycle, outbox | senior reviewer + Codex; affected test groups |
| ci-gates | `.github/workflows/`; **every script under `scripts/`** — gates, proofs, policy checks and migration tooling alike, for example `scripts/team_plan_check.cjs` and `scripts/agent_router.cjs` (`scripts/agent_readonly_bash_guard.cjs` is not on `master` yet; it arrives with the open bootstrap PR, see the sub-agent definitions row above); `tests/release_tools/team_plan_check.test.cjs`, the control file CI runs to enforce this gate; and the deployment definitions `Dockerfile`, `docker-compose*.yml` and `render.yaml` | senior reviewer + Codex; never weaken a gate |
| everything else | docs, UI, tooling | independent reviewer + Codex |

Two kinds of `ci-gates` entry sit outside `.github/` and `scripts/` on purpose. `tests/release_tools/team_plan_check.test.cjs` is not an ordinary test: a workflow step runs it, and that step **is** the enforcement of this gate, so emptying its assertions leaves the step green forever while the checker still appears to run. A control file that a workflow names is gate tooling whatever directory it happens to sit in, and a directory grant of `tests/` or `tests/release_tools/` is scored gate-risk for the same reason. `Dockerfile`, `docker-compose*.yml` and `render.yaml` define the production image and the Render service: they decide what actually runs in production, which is at least as load-bearing as a workflow file.

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
- **A committed plan is re-scored by today's rules, not the rules it ran under.** Widening a risk family makes older records report findings they never could have satisfied: `docs/team-plans/2026-09-24-daylight-visual-refresh.json` and `docs/team-plans/2026-09-25-graphite-mint-brand.json` both report `senior_review_missing` today, and each carries a `retroactive_finding_note` saying which finding, which rule caused it and when. Never edit a historic plan to make the checker pass. Marking a reviewer `senior: true` after the fact, or adding a reviewer row, records a senior review that never happened; a known failing check on an old plan is by far the cheaper outcome.
- **The checker's command line is covered by controls in the same file CI already runs, not by a CI step that invokes the CLI.** `tests/release_tools/team_plan_check.test.cjs` spawns the real `scripts/team_plan_check.cjs` binary as a child process against a throwaway `git init` repository each test builds and tears down itself, and asserts: exit 0 with an exact `TEAM_PLAN_PASS` line for a clean plan; exit 1 with `TEAM_PLAN_FAIL` plus the named finding for a dirty one; exit 2 with the usage line when no plan argument is given; a real `--base` plus `open_branches` resolution against two local branches, proving `branchPaths()` actually shells out to git rather than trusting the plan; and `open_branch_unreadable` for a branch that does not exist. That closes the gap every other control in the file leaves: those call `checkPlan()` in process, so `main()`, `branchPaths()`, the `--base` flag, the exit codes and the literal `TEAM_PLAN_PASS` / `TEAM_PLAN_FAIL` lines that step 2 of the lifecycle is written in terms of would otherwise be exercised by no test — and the CI step `Team work-plan coordination gate` already runs this file, so the new coverage lands exactly where CI already looks. A CI step that instead drove the CLI over a committed plan was considered and rejected: the open branches a plan names get deleted once they merge, so a step that resolves them from `open_branches` would go permanently red even at `fetch-depth: 0` — and because it would depend on a third party's branch tip at CI time rather than a fixture this repository controls, an unrelated push to that branch could turn this repository's PRs red on its own.
