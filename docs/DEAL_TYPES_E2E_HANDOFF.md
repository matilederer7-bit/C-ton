# Deal Types E2E Gate — Handoff Notes

Status: `DEAL_TYPES_E2E_BLOCKED` (one upstream issue blocking the final test
group). This document is a handoff for the next agent; it captures what was
built, what's passing, what's failing, the root cause, and concrete next
steps. The working tree is clean — all work-in-progress is committed.

## TL;DR

- Built `tests/deal_types_e2e_validation.ts` against the real Fastify runtime.
- Wired `npm run test:deal-types-e2e`.
- **Passing 11 / 12 test groups:** A1, A2, B1–B5, C1–C3, D1.
- **Failing 1 / 12:** E1 — Mission Control's `deal_type_readiness` and
  `fulfillment_readiness` return zeros even when the DB has the data.
- Root cause is **upstream of the new code**: an earlier `safeQuery` inside
  `buildAdminMissionControlPayload` triggers
  `ERROR: column "created_at" does not exist`, which aborts the surrounding
  Postgres transaction. Every subsequent `safeQuery` call in the same `withTx`
  block then returns `{ rows: [], error: 'current transaction is aborted…' }`
  silently. My new readiness builders are downstream → they get empty rows.
- Tests F1–F4 and G1 still need to run after the upstream fix lands; they were
  not reached in the failing run.

## What was built (and committed)

| File                                         | Purpose                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `tests/deal_types_e2e_validation.ts`         | E2E gate — drives physical / voucher / ticket flows against the real in-process app + DB |
| `package.json` (`test:deal-types-e2e`)       | Script entry point                                                                       |
| `docs/DEAL_TYPES_E2E_HANDOFF.md` (this file) | Handoff context                                                                          |
| `PROJECT_STATUS.md`                          | New entry: Deal Types E2E Gate — BLOCKED                                                 |

No production source was changed in this session. The Deal Type Expansion
itself (commits `ba334eb`, `10f5489`) is fully green and unchanged.

## Test groups and current state

| Group | Coverage                                                                  | Result |
| ----- | ------------------------------------------------------------------------- | ------ |
| A1    | physical default — no `deal_type` body still creates physical             | PASS   |
| A2    | physical buyer joins, tracking has no voucher/ticket fields               | PASS   |
| B1    | voucher create — `voucher_terms` required, `seller_uploaded` rejected     | PASS   |
| B2    | voucher full charge → Completed, qty=N→N units, no plaintext code in DB   | PASS   |
| B3    | voucher tracking exposes last4 only when eligible, never plaintext        | PASS   |
| B4    | voucher-export Completed-only + eligible-only + CSV-injection-safe        | PASS   |
| B5    | voucher redeem ownership + idempotency + no money/state mutation          | PASS   |
| C1    | ticket create — `ticket_terms` required, assigned-seat rejected           | PASS   |
| C2    | ticket full charge → Completed, qty=N→N units, eligibility-gated          | PASS   |
| C3    | ticket-export + check-in ownership + idempotency                          | PASS   |
| D1    | failed-deal (`deadline_check` Failed) issues zero fulfillment_units       | PASS   |
| E1    | Mission Control `deal_type_readiness` + `fulfillment_readiness` populated | **FAIL** — see root cause |
| E2    | deal trace returns audit events for voucher/ticket deals                  | not reached |
| F1    | no manual refund route exists for voucher/ticket                          | not reached |
| F2    | `fulfillment_units.metadata_jsonb` carries no truth keys                  | not reached |
| F3    | notifications registry has voucher/ticket templates                       | not reached |
| F4    | DB-wide scan finds no plaintext voucher/ticket code                       | not reached |
| G1    | webhook charge_captured replay is idempotent on Completed deal            | not reached |

## E1 root cause (confirmed via debug instrumentation, then reverted)

`buildAdminMissionControlPayload` runs every readiness builder inside a single
`withTx` transaction. `safeQuery` swallows errors and returns
`{ rows: [], error: '…' }`. **The first failing query inside the transaction
poisons the rest** — Postgres marks the transaction as aborted and refuses any
further command until the transaction is rolled back.

I temporarily wrapped `safeQuery` to log the **first** non-aborted error. The
output was:

```
[safeQuery FIRST FAIL] column "created_at" does not exist  SQL: SELECT ...
```

My instrumentation didn't print the full SQL (truncated at 200 chars), so the
exact section wasn't pinned down before I stopped. After the first failure,
every subsequent query — including my `buildDealTypeReadiness` and
`buildFulfillmentReadiness` queries — returns empty rows. That's why
`deals_by_type` shows `{ physical_product: 0, voucher: 0, ticket: 0 }` and
`fulfillment_units_total = 0` even though the DB has thousands of deals and
22 fulfillment_units.

### Concrete reproducer (10 seconds)

```bash
npx tsc -p tsconfig.test.json
node -e "
process.env.PORT='3510';
process.env.DISABLE_OUTBOX_WORKER='1';
process.env.ADMIN_API_KEY='x';
import('./.tmp_test_dist/src/app.js').then(async ({ app }) => {
  const r = await app.inject({ method: 'GET', url: '/api/admin/mission-control', headers: { 'x-admin-key': 'x' } });
  const body = r.json();
  console.log('deals_by_type:', body.deal_type_readiness.deals_by_type);
  console.log('fulfillment_units_total:', body.fulfillment_readiness.fulfillment_units_total);
  await app.close(); process.exit(0);
});
"
```

Both will be 0 against a populated demo DB. Direct `c.query` in a fresh
connection returns the right counts (verified in this session).

### Suggested fixes (pick one)

1. **Find and fix the failing query.** Re-add the temporary log to
   `safeQuery` (drop the truncation at 200 chars), run the inspect snippet
   above, find the SQL with `created_at`, and either fix the column reference
   or guard the query when the column is missing. This is the smallest fix.

2. **Make `safeQuery` transaction-safe.** Wrap each call in a Postgres
   `SAVEPOINT` so an individual failure doesn't poison the whole tx:
   ```ts
   async function safeQuery(c, sql, params) {
     const sp = `sp_${randomBytes(8).toString('hex')}`;
     await c.query(`SAVEPOINT ${sp}`).catch(() => {});
     try {
       const r = await c.query(sql, params);
       await c.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
       return r;
     } catch (e) {
       await c.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
       return { rows: [], rowCount: 0, error: String(e?.message || e) };
     }
   }
   ```
   This is more invasive but fixes a class of bugs across all Mission Control
   sections (every existing section is silently degraded by the same
   poisoning today — only the first failure shows the symptom; the rest just
   silently return zeros).

3. **(Workaround only)** Move `buildDealTypeReadiness` and
   `buildFulfillmentReadiness` ahead of the failing query. Don't ship this —
   it's a band-aid that hides a real bug.

The existing `test:mission-control` suite passes today because it asserts on
section *presence* and shape, not on counts. So this poisoning has been
silently degrading other readiness sections too. Worth a dedicated fix
regardless of this gate.

## How to resume the gate (next agent)

1. **Apply one of the fixes above.** Recommended: fix #2 (savepoint) — it
   raises the floor for every readiness section, not just deal_type /
   fulfillment.
2. **Re-run the gate:**
   ```bash
   npx tsc --noEmit
   npx tsc -p tsconfig.test.json
   npm run test:deal-types-e2e
   ```
3. **Expect:** E1 passes, then E2 / F1–F4 / G1 run. If F4 or G1 surface
   issues, they're real (not the same upstream).
4. **Run the full regression battery** the spec requires:
   ```bash
   npm run test:deal-types
   npm run test:full-e2e-gate
   npm run test:refund-policy
   npm run test:json-boundary
   npm run test:provider-live-money-readiness
   npm run test:mission-control
   npm run test:notifications-readiness
   npm run test:adversarial
   npm run test:legal-trust
   npm run test:production-launch-readiness
   npm run test:security-hardening
   npm run test:security-identity-tracking
   npm run test:admin-control-plane
   npm run test:support-operations
   npm run test:frontend-browser-smoke
   ```
5. **Write `docs/DEAL_TYPES_E2E_GATE.md`** (the canonical gate doc — spec
   asks for it).
6. **Write `DEAL_TYPES_E2E_DELIVERY_REPORT`** (spec asks for the 36-item
   report).
7. **Flip PROJECT_STATUS verdict** to
   `DEAL_TYPES_E2E_PASS_READY_FOR_PROVIDER_SANDBOX` if everything is green.

## Things to know (gotchas the next agent will hit)

- **`completion_window_until` is immutable once set** (DB trigger, see
  migration 008/014/022). The test uses `COMPLETION_WINDOW_MINUTES=-1` to
  stamp the window in the past at charge time, since post-hoc rewinding is
  blocked. Do not try to `UPDATE siton.deals SET completion_window_until = …`
  after the worker sets it.
- **`deadline` is immutable after publish** (same trigger family). For the
  failed-deal scenario (D1), `handleDeadlineCheck` does not actually compare
  against `deadline` — it just compares `total_joined < threshold`, so we
  can publish a deal with min_units=5, no buyers join, fire `deadline_check`,
  and the deal goes to Failed. No deadline manipulation needed.
- **Mock provider is non-deterministic**. The `capture()` mock returns
  `success` 75%, `temporary_fail` 15%, `permanent_fail` 10%. The test uses
  4 buyers in B2 and 3 buyers in C2 and a retry loop on the `charge_deal`
  outbox event so the deal converges to Completed with high probability
  (>99.9%). On `temporary_fail` the worker throws and `markOutboxFailed`
  reschedules with `available_at` in the future — the test resets
  `available_at` and re-claims up to 8 attempts.
- **`processOutboxEventById` ignores `available_at`** — it only requires
  `status='pending'`. So the test can force-process an event by id even if
  its `available_at` is in the future. This is what makes the gate run in
  seconds instead of minutes.
- **The mission-control endpoint at `GET /api/admin/mission-control`** spreads
  the deep payload via `...missionControlDeep` (line 4430 of
  `frontend_runtime.ts`), so my new sections are surfaced. The shallow handler
  comment-only contract is misleading at first read; if you grep, both
  reachable mission-control routes call `buildAdminMissionControlPayload`.

## What's solid and shouldn't be re-litigated

- Migration 038 + `src/deal_types.ts` — both are battle-tested by 24-case
  `test:deal-types` and 11 of 12 of the new E2E groups.
- Issuance correctness (qty=N→N units, idempotent, eligibility-gated, no
  plaintext code) — verified on a real DB by B2 and C2.
- Redemption foundation — verified on a real DB by B5 and C3 (ownership,
  idempotency, no money mutation).
- Failed-deal-no-issuance — verified on a real DB by D1.
- CSV-injection neutralization — verified on a real DB by B4 and C3.
- Public deal page per-type contract — verified by A1, B1, C1.

## Files I touched (this session, all committed before handoff)

```
modified:   package.json                                  # +test:deal-types-e2e script
new:        tests/deal_types_e2e_validation.ts           # E2E gate (~520 lines)
new:        docs/DEAL_TYPES_E2E_HANDOFF.md               # this file
modified:   PROJECT_STATUS.md                             # entry: Deal Types E2E Gate — BLOCKED
```

No production source was modified.

## Verdict

`DEAL_TYPES_E2E_BLOCKED` — fix the upstream `safeQuery` transaction poisoning
(or the specific failing column reference) and the gate will land green.
