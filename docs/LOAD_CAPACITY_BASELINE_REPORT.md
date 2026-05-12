# Load & Capacity Baseline Report

Generated: 2026-05-12

## Verdict

LOAD_BASELINE_PASS_FOR_SMALL_PILOT

## Verdict Reason

The load harness now loads `.env` before reading `DATABASE_URL`, so it uses the same local DB path as the rest of the runtime instead of falling back to `postgres/postgres`. Preflight passed, schema was accessible, the public-route warmup prevented first-request pool starvation, outbox worker stayed disabled, and all providers stayed mock/internal/log-only.

Stage 1 and stage 2 completed. There were no DB errors, no timeouts, no oversell, no detected double money effect, and no detected state corruption. This is a local baseline, not a production capacity proof.

## Test Environment

- Local Windows workspace: `c:\Users\Lenovo\Documents\C-ton`
- Runtime mode: `demo-preview`
- DB: local/test `DATABASE_URL` loaded from environment; value not printed
- Providers: `mockpay`, `internal-ledger`, `log-only`, internal invoice mode
- Outbox worker: disabled with `DISABLE_OUTBOX_WORKER=1`
- Real money: not used
- External providers: not used
- Docker: not available on this machine

## Test Limits

- Local in-process Fastify `app.inject`, not real network traffic.
- No CDN/cache/staging/managed Postgres proof.
- Existing local outbox backlog remained present: 109 pending events, oldest about 21.6 hours.
- Node open handles after close: 4.
- Stage 3 was not run.

## Numeric Results

| Scenario | Total | Concurrency | Success | Failure | Error rate | Avg ms | p50 ms | p95 ms | p99 ms | Max ms | Timeouts | DB errors | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A1 public deal reads | 100 | 10 | 100 | 0 | 0% | 19.1 | 4.7 | 164.9 | 223.3 | 252.7 | 0 | 0 | PASS |
| B1 tracking reads | 100 | 10 | 100 | 0 | 0% | 19.0 | 18.6 | 28.1 | 30.1 | 30.9 | 0 | 0 | PASS |
| C1 same deal joins, max 100 | 100 | 20 | 100 | 0 | 0% | 141.0 | 119.4 | 270.3 | 276.2 | 278.4 | 0 | 0 | PASS |
| C2 oversubscribe, max 100 / 200 attempts | 200 | 50 | 100 | 100 expected rejects | 50% expected | 201.1 | 117.3 | 318.3 | 498.4 | 510.3 | 0 | 0 | PASS |
| D1 10 deals x 10 buyers | 100 | 20 | 100 | 0 | 0% | 81.7 | 78.7 | 98.7 | 133.7 | 134.1 | 0 | 0 | PASS |
| F export 100 participants | 1 | 1 | 1 | 0 | 0% | 134.8 | 134.8 | 134.8 | 134.8 | 134.8 | 0 | 0 | PASS |
| A2 public deal reads | 500 | 25 | 500 | 0 | 0% | 21.0 | 21.0 | 25.1 | 26.7 | 29.1 | 0 | 0 | PASS |
| B2 tracking reads | 1,000 | 50 | 1,000 | 0 | 0% | 78.8 | 79.3 | 90.4 | 96.9 | 98.4 | 0 | 0 | PASS |
| C3 same deal joins, max 500 / 1,000 attempts | 1,000 | 100 | 500 | 500 expected rejects | 50% expected | 391.5 | 288.6 | 618.9 | 798.0 | 965.1 | 0 | 0 | PASS |
| D2 50 deals x 20 buyers | 1,000 | 50 | 1,000 | 0 | 0% | 186.7 | 182.2 | 229.1 | 242.2 | 283.3 | 0 | 0 | PASS |
| F export 500 participants | 1 | 1 | 1 | 0 | 0% | 264.8 | 264.8 | 264.8 | 264.8 | 264.8 | 0 | 0 | PASS |

## Business Checks

- No oversell: PASS. C1/C2/C3 all ended at exactly `max_units`.
- Max units not breached: PASS.
- Duplicate money effect: no duplicate participant reservation observed in these scenarios.
- Rejected count: expected in oversubscribe scenarios; 100/200 and 500/1000 were rejected.
- State corruption: not observed.
- Unhandled DB deadlock: not observed.

## First Bottleneck

The first visible bottleneck is concurrent joining at stage 2: C3 p95 was 618.9 ms and p99 was 798.0 ms. Reads and exports were lower.

## Business Interpretation

- 10 deals per week: looks easy for the current local monolith baseline.
- 10 deals per day: looks realistic locally, assuming staging DB is comparable or stronger.
- 100 deals per day: not proven for production; stage 2 is encouraging but needs staging with real observability.
- 500 buyers in one deal: locally passed with max 500 / 1,000 join attempts.
- 1,000 buyers in one deal: not proven; requires stage 3 or a dedicated larger run.

## P0

- None found in this baseline. No oversell, no DB errors, no timeouts, no detected corruption.

## P1

- Run the same baseline in staging with managed Postgres metrics.
- Investigate stale outbox backlog before any public pilot.
- Tune concurrent join path if staging p95 approaches or exceeds 1 second.

## P2

- Add optional stage selector for faster repeated runs.
- Add cache/ETag strategy for public deal and tracking reads if polling grows.
- Consider export streaming/queueing before exports above 1,000 participants.

## Operational Recommendation

Proceed with a small pilot from a capacity perspective, after staging repeats this baseline and the stale outbox backlog is cleaned or explained. Do not claim 100 deals/day production readiness or 1,000-buyer viral deal readiness yet.
