# Siton Claude Code Entry Point

This file is the repository entry point for Claude Code.

Before any meaningful task, read and obey:

1. `AGENTS.md` — binding short operating rules for every coding agent.
2. `AI_WORKFLOW.md` — detailed execution workflow, testing, Git, coordination, and completion protocol.
3. `PROJECT_STATUS.md` — current implementation state and active blockers.
4. `docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md` plus any newer canonical amendments relevant to the task.

Do not ask the owner to repeat rules already defined in those files.

## Default execution mode

Work autonomously within the assigned scope. Inspect before editing. Reuse existing implementation instead of rebuilding it. Keep the patch narrow and coherent. Do not spend coding-agent credits on broad external research unless explicitly assigned.

For meaningful work, use an isolated task branch and do not touch another agent's working tree or branch. When parallel work exists, inspect current branch, status, recent commits, and likely overlap before editing.

Run focused tests first, then the appropriate broader gates for the risk level. Never weaken tests or safety boundaries merely to get green results.

At every meaningful milestone update `PROJECT_STATUS.md` with completed, checked, open, percentage, and next step.

When the task is coherent and verified, commit it clearly, push the branch, and open a Pull Request when integration or review is expected.

## Failure-loop and Git failure rule

Do not repeat materially identical failed tactics more than twice.

If GitHub push fails because the current session lacks repository authorization, especially a repeated 403 after access/setup was already attempted:

1. stop retrying the same push path;
2. keep the working tree clean and the completed commit intact;
3. produce a complete patch from the intended base;
4. report branch, base SHA, final commit SHA, patch path/name, and exact apply command;
5. continue only with work that does not depend on the blocked push.

Do not burn time or credits on authentication loops.

## Protected actions

Do not trigger real customer charges, payouts, refunds, production messaging, production data destruction, production schema changes, credential rotation, or other live irreversible effects unless the owner explicitly authorized that specific action.

## Completion report

Return only useful evidence:

- Result
- Changed
- Tested
- Commit
- Branch / PR
- Open blocker
- Next step

The goal is maximum verified progress with minimum owner intervention and minimum token/credit waste.
