# PREPROD TORTURE QA LOG

Date: 2026-03-31

## Phase A - Torture Matrix Planning

1. Load burst
- What was tested: concurrent public-deal reads, frontend shell loads, OTP start/verify, payment authorization, and join attempts.
- Why risky: race conditions could over-admit participants, degrade responses, or create ambiguous buyer-facing state.
- Pass condition: only `200` or expected `409`; no capacity drift; no DLQ growth.
- Blocker condition: over-capacity success, stuck state, or unexplained failure cluster.

2. Soak-style long run
- What was tested: repeated public/tracking reads over many iterations after a real join.
- Why risky: slow degradation, stale reads, or broken tracking semantics under sustained usage.
- Pass condition: stable `200`, stable participant/deal states, no hidden drift in debug surfaces.
- Blocker condition: state drift, unexplained failures, or obvious degradation.

3. Restart and recovery adjacent drill
- What was tested: charging flow, out-of-order recovery webhook, charge failure, late duplicate, recovery success, late duplicate again.
- Why risky: weird ordering can corrupt domain state or create duplicate mutations.
- Pass condition: safe ignore where appropriate, processed once where appropriate, no DLQ growth, coherent tracking.
- Blocker condition: double mutation, broken state, or reconciliation corruption.

4. Cross-flow misuse
- What was tested: payment authorization without OTP/session context, direct confirmation route navigation, tracking without participant, OTP verify without a valid session.
- Why risky: frontend/backend mismatch can create false success or user confusion.
- Pass condition: no false success in domain state, controlled responses, shell remains safe.
- Blocker condition: misleading success or corrupted state.

5. RC drill under pressure
- What was tested: `/health`, `/health/integrations`, key deal routes, frontend shell, webhook secret rejection, and debug surface under concurrent requests.
- Why risky: RC confidence collapses if health and operational surfaces become noisy or ambiguous under pressure.
- Pass condition: green health surfaces, controlled unauthorized webhook rejection, no DLQ/stuck signal.
- Blocker condition: health regression, route failure, or operational blind spot.

## Phase B - Mixed Load and Long-Run QA

- Added `tests/preprod_torture_validation.ts`.
- Added `test:preprod-torture` and folded the suite into `npm test`.
- Mixed-load run proved:
  - concurrent reads stayed healthy
  - concurrent joins capped exactly at `max_units`
  - excess joins were rejected with `409`
  - public-deal availability moved coherently to `stock_exhausted`
- Soak-style read loop proved:
  - no silent degradation across repeated public/tracking reads
  - no debug drift and no DLQ growth in the tested scenario

## Phase C - Restart, Recovery, and Weird-State RC Drill

- Simulated restart-adjacent weirdness through ordering abuse rather than external process orchestration.
- Proved:
  - `recovery_captured` before `charge_failed` is ignored cleanly
  - `charge_failed` processes once
  - late duplicate `charge_failed` is ignored safely
  - `recovery_captured` processes once after the failed state exists
  - late duplicate `recovery_captured` is ignored safely
  - tracking ends in coherent `Recovered` / `RecoveredCharge`

## Phase D - Cross-Flow Abuse and State Drift

- Proved:
  - direct payment authorization does not create participant/deal success by itself
  - direct confirmation route access remains a shell route, not a false domain success
  - missing tracking context returns `404`
  - OTP verify without a valid session returns controlled failure

## Phase E - RC Drill Under Stress

- Ran concurrent `/health` and `/health/integrations` requests.
- Rechecked:
  - public deal route
  - frontend shell route
  - unauthorized webhook path
  - debug surface for DLQ/stuck evidence
- Result:
  - health remained green
  - unauthorized webhook stayed `401`
  - no DLQ growth was observed in the drill path

## Phase F - Revalidation

- `npx tsc --noEmit` passed.
- `npm test` passed.
- No stuck `node` process remained after the successful run.
- No temporary residue needed cleanup for this pass.
