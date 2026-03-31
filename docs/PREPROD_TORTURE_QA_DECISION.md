# PREPROD TORTURE QA DECISION

## Executive Decision

PREPROD TORTURE QA PASSED WITH NON-BLOCKING GAPS

## What Was Attacked

- mixed concurrent buyer traffic
- long-run public and tracking reads
- join pressure against capacity limits
- ugly webhook ordering and duplicate/replay combinations
- stale or missing flow context
- direct route misuse
- RC-style health and operational checks under pressure

## What Broke

- No product blocker broke in this pass.
- One initial test-harness assumption was too strong: webhook-driven reconciliation was assumed to always leave a `payment_attempts` row for the charge leg. That was a harness error, not a product regression.

## What Was Fixed

- Added a dedicated torture/preprod validation suite in [tests/preprod_torture_validation.ts](/C:/Users/Lenovo/Documents/C-ton/tests/preprod_torture_validation.ts).
- Folded the suite into [package.json](/C:/Users/Lenovo/Documents/C-ton/package.json) so `npm test` now covers the pre-production torture pass.
- Corrected the torture harness to assert the actual runtime contract instead of a stronger non-canonical assumption.

## What Still Feels Soft

- True external-process restart-under-live-load is still approximated rather than proven end-to-end.
- Payment remains mock-backed by design.
- Notifications remain log-only by design.

## What Cannot Be Proven Until External Activation

- live provider behavior
- provider-specific webhook catalog beyond the current supported internal set
- real outbound notification transport
- staging-like restart/proxy/process-manager behavior under genuine long-running traffic

## RC Impact Assessment

- Would fail RC:
  - over-capacity success above `max_units`
  - state corruption under duplicate or out-of-order webhooks
  - broken `/health` or `/health/integrations`
  - silent stuck/DLQ growth in the tested paths
- Would not fail RC right now:
  - lack of live provider activation
  - lack of real notification transport
  - lack of OS-process restart proof in this repo-local pass

## Recommended Next Step

- Keep the current internal confidence as closed, then run the first staging-like external-activation pass with:
  - one real provider behind the existing provider boundary
  - provider-specific webhook matrix expansion
  - true process restart/recovery proof outside `app.inject`
