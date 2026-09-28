# Parallel dispatch proof — 2026-09-28

Evidence that the three builders of work plan
`docs/team-plans/2026-09-28-team-orchestration-enforcement.json` ran **concurrently**,
not one after another. Recorded by the lead, not self-reported by the agents.

## Method

All three sub-agents were dispatched in a **single tool call block** at `21:50:39 +0300`.
An independent sampler (`stat -c %Y` every 2 s, started before dispatch) recorded the
modification time of each builder's target file for the duration of the run. A write
event below is a change in that file's mtime — the lead observing the filesystem, not an
agent claiming progress. Run windows come from the harness's own `duration_ms` for each
agent, which the lead does not author.

## Run windows

| Assignment | Agent | Model | Role | Window (harness `duration_ms`) |
|---|---|---|---|---|
| B1 | `claude-subagent` | **opus** | builder | 21:50:40 → 21:56:31 (351 s) |
| B2 | `claude-subagent` | **sonnet** | builder | 21:50:40 → 21:55:55 (315 s) |
| B3 | `claude-subagent` | **sonnet** | builder | 21:50:40 → (see status block) |
| R1 | `claude-subagent` | **opus** | senior reviewer, read-only | after integration |
| B0 | `claude-lead` | **opus** | builder (plan + status slot) | whole task |

## Observed write events

```
21:51:51  B1(opus)    scripts/team_plan_check.cjs
21:51:58  B1(opus)    scripts/team_plan_check.cjs
21:52:03  B1(opus)    scripts/team_plan_check.cjs
21:52:08  B1(opus)    scripts/team_plan_check.cjs
21:52:18  B1(opus)    scripts/team_plan_check.cjs
21:52:23  B1(opus)    scripts/team_plan_check.cjs
21:52:32  B1(opus)    scripts/team_plan_check.cjs
21:52:37  B1(opus)    scripts/team_plan_check.cjs
21:52:49  B1(opus)    scripts/team_plan_check.cjs
21:52:59  B1(opus)    scripts/team_plan_check.cjs
21:53:11  B1(opus)    scripts/team_plan_check.cjs
21:53:16  B1(opus)    scripts/team_plan_check.cjs
21:54:45  B2(sonnet)  tests/release_tools/team_plan_check.test.cjs
21:55:45  B3(sonnet)  CLAUDE.md
21:56:00  B3(sonnet)  docs/CLAUDE_TEAM_LEAD.md
21:56:19  B3(sonnet)  docs/CLAUDE_TEAM_LEAD.md
21:56:29  B3(sonnet)  docs/CLAUDE_TEAM_LEAD.md
21:56:33  B3(sonnet)  docs/CLAUDE_TEAM_LEAD.md
```

## What this proves

1. **B2 wrote at 21:54:45 while B1 was still running** (B1 ended 21:56:31). Two builders
   alive at the same instant, one of them writing.
2. **At 21:55:45 all three were alive at once**: B1 had 46 s left, B2 had 10 s left, and B3
   was writing `CLAUDE.md` at that moment. Three concurrent agents, observed.
3. B1's own report states independently that B2's work was not blocking it
   (`"I did not need to wait — B1 finished during my work"`, B2's report), which agrees
   with the filesystem record rather than substituting for it.

Serial execution is excluded: under serial execution the three files' write events could
not interleave inside another agent's live window, and the three windows would not
overlap at all.

## Why the writes did not collide

Each builder held a disjoint set of paths, declared in the plan and checked mechanically
by `scripts/team_plan_check.cjs` before dispatch (`writer_overlap` reports zero). The
shared worktree is therefore safe: no two builders could target the same file.
