<!--
Binding rules: AGENTS.md. Workflow detail: AI_WORKFLOW.md. Shared state: PROJECT_STATUS.md.
The Builder fills this in. The Reviewer fills in the review section.
-->

## Scope lock

**Builder:** <!-- claude / codex -->
**Reviewer:** <!-- codex / claude -->
**Declared paths** (no other agent may write to these while this PR is open):

-

**Checked before starting:** open PRs and remote `claude/*`, `codex/*`, `agent/*` branches — collisions found: <!-- none / list -->

## Problem or requested outcome

## Implementation summary

## Files and areas changed

## Tests

| Script / gate | Outcome |
| --- | --- |
|  | <!-- PASS / FAIL introduced here / pre-existing FAIL / NOT RUN / blocked --> |

Every result above was actually run. Nothing is reported as passing that was not executed.

## Risk surface

- [ ] Touches money (amounts, fee, payouts, refunds, invoices) — independent review required
- [ ] Touches auth, admin endpoints, webhooks, rate limiting or secrets — independent review required
- [ ] Touches schema or migrations — independent review required
- [ ] Touches hosted/external rails or deploy configuration
- [ ] None of the above

## Invariants

- [ ] Platform fee remains 8% of the full collected amount, including delivery, excluding VAT
- [ ] No distributor commission, balance, payout entitlement or payout rail introduced
- [ ] Real money remains disabled; Grow untouched
- [ ] No test, gate or security check was weakened, skipped or removed
- [ ] No secret added to any tracked file

## Status and remaining work

- [ ] `PROJECT_STATUS.md` updated

**Known limitations / open items:**

**Next step:**

---

## Review

<!-- Reviewer: P0/P1 findings only, each with a concrete failure scenario.
     State which parts of the diff you did not review.
     Verdict: block merge / safe to merge. -->
