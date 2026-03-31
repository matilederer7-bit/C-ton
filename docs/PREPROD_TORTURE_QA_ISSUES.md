# PREPROD TORTURE QA ISSUES

Date: 2026-03-31

## Non-Blocking

1. True OS-process restart-under-live-load was not proven in this pass.
- Why: this pass intentionally stayed inside repo-local, `app.inject`-driven validation without spinning a separate managed runtime/process supervisor.
- Impact: non-blocking for internal pre-production confidence, but still worth proving during the first external-activation or staging-like pass.

2. External provider behavior remains unprovable by design.
- Why: payment is still mock-backed and no live provider was activated.
- Impact: external-only. Internal reconciliation, duplicate handling, and provider boundary were still exercised as far as possible.

## Resolved During This Pass

1. The initial torture harness assumed webhook-driven reconciliation would always leave a `payment_attempts` row for the charge leg.
- Resolution: corrected the suite to assert only the contract the system actually guarantees in this path: coherent state, safe duplicate handling, controlled statuses, and no DLQ drift.

## Push Status

- No `push` was performed because no `git remote` is configured.
