# RC Execution Result

## RC Start Time

- `2026-03-30T00:29:53.1906665+03:00`

## What Was Executed

1. RC runtime restart was executed via:
   `powershell -ExecutionPolicy Bypass -File .\scripts\restart_server_tsnode_clean.ps1`
2. Monitoring window was executed exactly at:
   - `T+0`
   - `T+5`
   - `T+15`
   - `T+30`
3. At each station the following checks were run:
   - `/health`
   - stuck outbox query
   - DLQ snapshot
   - retry pressure snapshot
   - `/debug/deals/:id` sanity check

## T+0

- Time:
  `2026-03-30T00:30:20.3687953+03:00`
- `/health`:
  `{"ok":true}`
- stuck outbox query:
  empty result
- outbox status snapshot:
  - `pending = 2`
  - `sent = 618`
- DLQ snapshot:
  5 rows, all pre-existing historical entries from prior verified tests
- `/debug/deals/87c3613b-dfb2-4a8b-aac7-284a35baf10e`:
  `200`

Classification:
- non-blocking observation

Observation:
- the restart script's internal `curl` probe timed out before the app was fully up
- direct `/health` check immediately after succeeded
- no rollback condition was met

## T+5

- Time:
  `2026-03-30T00:35:52.9642732+03:00`
- `/health`:
  `{"ok":true}`
- stuck outbox query:
  empty result
- DLQ snapshot:
  unchanged, still only historical rows
- retry pressure snapshot:
  - `charge_deal sent = 278`, `max_attempt = 4`
  - `deadline_check pending = 1`, `max_attempt = 0`
  - `deadline_check sent = 5`, `max_attempt = 0`
  - `finalize_deal pending = 1`, `max_attempt = 0`
  - `finalize_deal sent = 281`, `max_attempt = 0`
  - `recovery_deal sent = 40`, `max_attempt = 3`
  - `refund_issue sent = 14`, `max_attempt = 1`
- `/debug/deals/87c3613b-dfb2-4a8b-aac7-284a35baf10e`:
  `200`

Classification:
- monitor

Observation:
- state remained stable
- no fresh DLQ
- no stuck processing

## T+15

- Time:
  `2026-03-30T00:46:24.1962774+03:00`
- `/health`:
  `{"ok":true}`
- stuck outbox query:
  empty result
- DLQ snapshot:
  unchanged, still only historical rows
- retry pressure snapshot:
  - `charge_deal sent = 278`, `max_attempt = 4`
  - `deadline_check pending = 1`, `max_attempt = 0`
  - `deadline_check sent = 5`, `max_attempt = 0`
  - `finalize_deal sent = 282`, `max_attempt = 0`
  - `recovery_deal sent = 40`, `max_attempt = 3`
  - `refund_issue sent = 14`, `max_attempt = 1`
- `/debug/deals/87c3613b-dfb2-4a8b-aac7-284a35baf10e`:
  `200`

Classification:
- monitor

Observation:
- one previously pending `finalize_deal` moved to `sent`
- this was normal convergence, not a fault

## T+30

- Time:
  `2026-03-30T01:01:55.1591592+03:00`
- `/health`:
  `{"ok":true}`
- stuck outbox query:
  empty result
- DLQ snapshot:
  unchanged, still only historical rows
- retry pressure snapshot:
  - `charge_deal sent = 278`, `max_attempt = 4`
  - `deadline_check pending = 1`, `max_attempt = 0`
  - `deadline_check sent = 5`, `max_attempt = 0`
  - `finalize_deal sent = 282`, `max_attempt = 0`
  - `recovery_deal sent = 40`, `max_attempt = 3`
  - `refund_issue sent = 14`, `max_attempt = 1`
- `/debug/deals/87c3613b-dfb2-4a8b-aac7-284a35baf10e`:
  `200`

Classification:
- monitor

Observation:
- no late instability appeared during the remaining monitoring window

## Exceptions Found

- One non-blocking observation was found during RC execution:
  the restart script's built-in readiness probe was too eager and could fail before the app was fully up.
- This did not become a runtime failure because direct health verification succeeded immediately afterward and the 30-minute monitoring window stayed clean.
- After RC, the restart scripts were tightened to poll `/health` until success or timeout, and the improved restart path was reverified.

## Was Rollback Required

- No.

## Did RC Complete Successfully

- Yes.

## Final Decision

RC PASSED WITH NON-BLOCKING OBSERVATIONS
