# Independent review — `codex/closed-pilot-war-game` (2026-09-09)

Reviewer branch: `claude/review-codex-war-game` from master `d4c7877f9b704734036d69f57f7d98f794f4d034`.
Reviewed: `origin/codex/closed-pilot-war-game` at `6fa0e627216a9673fd881f9bff6fd6dbe92e98ec`
(reported SHA matches the remote tip; 3 commits ahead of master, 0 behind; merge-base = master).

Nothing in this review touched the Codex branch, master, the Claude UX / communications / long-horizon
branches, Grow, payment provider logic, migrations, Supabase, Render or hosted state. REAL MONEY = 0,
REAL E-MAIL = 0, REAL SMS = 0, HOSTED DB CHANGED = 0.

## 1. Source verification

| Fact | Claimed | Verified |
|---|---|---|
| master at task start | `d4c7877` | `git fetch origin`; `origin/master` = `d4c7877f…4034` |
| Codex tip | `6fa0e62` | `origin/codex/closed-pilot-war-game` = `6fa0e627…8ec` |
| ancestry | derived from `d4c7877` | merge-base = `d4c7877`; `0 behind / 3 ahead` |
| commits | 3 | `79eab3e` test harness, `c060596` fix, `6fa0e62` docs |
| changed files | 1 production file | `src/frontend_runtime.ts` (+5/−2), 2 harness scripts, report, PROJECT_STATUS |
| whitespace | — | `git -c core.autocrlf=false diff --check master..codex` clean |
| forbidden areas | untouched | no migrations, no `supabase/`, no `render.yaml`, no `.env`, no payment/Grow/mobile/web files |

## 2. The production fix (P-1, admin settlement) — CONFIRMED, CORRECT

**What the old code did.** `GET /api/admin/overview` summed `price_per_unit × joined_units` and
`joined_delivery_cost` over `Completed` deals, where `joined_units = SUM(p.qty)` over **every**
participant row of the deal regardless of `money_state`. Joined inventory was treated as revenue.

**Why it overstated.** A Completed deal can carry participants in `AuthReleased` (dropped after a failed
recovery), `Refunded`, or `ChargeFailedRecovery` (unrecovered). None of them settled money; all of them
were counted.

**Why exactly ₪140 in the Codex scenario.** Deal 2 has ten orders at 60 with alternating delivery 0/20;
the two released orders are the first two of that deal (pickup 60+0, delivery 60+20) → 140. Success money
1260 = deal 1 (10×60 + 5×20 = 700) + deal 2 (8×60 + 4×20 = 560). Reproduced independently on unmodified
master with my own matrix: joined money **600** reported where success money is **280** (see §5, A1).

**Incorrect source → canonical source.** `SUM(p.qty)` / `SUM(p.delivery_cost)` over all participants →
the same sums `FILTER (WHERE p.money_state IN ('ChargedSuccess','RecoveredCharge'))`. That filter is the
existing canonical success-money predicate everywhere else: fulfillment eligibility
(`decideFulfillmentIssuance`), receipts (`receiptEligible`), seller analytics, mission control
`gross_charged`, the seller workspace settlement query, Excel exports, and the fee ledger
(`platform_fee_money_events`, written on `charge_captured` / `recovery_captured`). `mapDealListRow`
keeps `joined_units` for inventory, unchanged.

**Leak matrix (my regression `tests/admin_settlement_success_money_validation.ts`, real runtime, fresh
DB):** `ChargedSuccess` counted, `RecoveredCharge` counted, `AuthReleased`/Dropped excluded, `Refunded`
excluded, `ChargeFailedRecovery` (unrecovered) excluded, a captured order on a **Failed** deal excluded
from completed settlements, quantities (qty 1/2/3) and delivery (0/20) applied per order. Master: FAIL
(600 ≠ 280). Codex `6fa0e62`: PASS.

**Only canonical money.** No UI arithmetic is involved; the overview is a backend read model over
`participants` money states. The `LIMIT 100` cap on the deal list (Codex F-1) remains a bounded-history
caveat, not a correctness defect for the pilot.

## 3. The 8% rule — CORRECT in the ledger, ONE surface-level defect found and fixed here

* `SITON_PLATFORM_FEE_RATE = 0.08`; `calculatePlatformFeeMoney` (ledger, receipts, analytics, mission
  control) computes `fee_base = gross − authoritative buyer VAT`, fee = 8% of that, plus 18% VAT on the
  fee, delivery included. Canon tests pass. Distributor commission: none in code (`viral_graph.ts`,
  `admin_mission_control.ts` assert zero; my grep finds no commission/affiliate-fee/distributor-payout
  logic; my A7 asserts no such field on any settlement surface).
* **Defect D-1 (pre-existing on master, NOT introduced by Codex, NOT caught by the war game):**
  `summarizeMoney` (`src/product_surface_support.ts`) accepts `vatAmount` but never subtracts it from the
  fee base (its comment even says so, written before the R9A VAT authority made the canonical rule
  VAT-exclusive). The admin overview passes `sellerSettlementVat.vat_amount` into it expecting
  subtraction; the seller deal detail (`/api/seller/deals/:id → receipts_surface.summary`) passes no VAT
  at all. Under the pilot's `synthetic_zero` VAT the numbers coincide, so the Codex assertion
  (`platform_fee_amount === 118.94`) could not see it; under `SITON_VAT_MODE=explicit` (required for
  real money) both surfaces overstate Siton's fee by 8% × VAT. Proven by A5/A6: FAIL on master and on
  `6fa0e62` (26.43 shown, 22.40 canonical for 280 gross at 18% VAT); PASS after the fix.
* **Fix (review branch, minimal):** `summarizeMoney` fee base = `max(0, gross − vatAmount)` (callers
  that pass no VAT are unchanged — `backend_sanity_suite` expectations hold); the seller deal detail now
  passes the VAT of its success gross through the existing VAT authority. No ledger, provider, rate or
  migration change.

## 4. The harness — what it proves, what it does not

### 4.1 Safety (refusal controls) — PASS, one hook hardened

Reproduced the four reported refusals (non-local host, `NODE_ENV=production`, URL query override,
missing URL) plus two of my own (`APP_ENV=production`, `RENDER=true`): all refuse before any connection.
The scenario additionally refuses any database not named `siton_pilot_<pid>_<ts>_day`. The harness
allowlists the child environment (mock payment, internal-ledger payout, log-only notifications,
`NO_NETWORK_REHEARSAL=1`, `DISABLE_OUTBOX_WORKER=1`) and never loads `.env` itself; children that
`import "dotenv/config"` cannot override the explicit `DATABASE_URL`. All disposable databases were
dropped after my run (no `siton_pilot_*` leftovers). It cannot reach Grow, money, e-mail or SMS: no real
adapter exists in the repository and `NOTIFICATION_PROVIDER_MODE=real` fails closed at boot.

**Finding H-1 (harness, pre-existing script):** `scripts/deny_external_network.cjs` patched only
`net.connect`/`net.createConnection`/`fetch`. `https.request` (TLS), raw `net.Socket#connect` and `pg`
bypassed it (probe to an unresolvable host: DNS `ENOTFOUND`, hook never fired). The report's
"external-network denial" was therefore best-effort for exactly the transports a real provider would
use. Hardened on the review branch at `net.Socket.prototype.connect`; re-probed: `https`, raw socket and
`pg` to a non-local host → `NO_NETWORK_REHEARSAL_BLOCKED`, local Postgres still connects. The effective
safety of the run never depended on this hook (see above), but the claim now matches the code.

### 4.2 Real runtime vs synthetic fixture — the honest split

| Claim | Proof class | Notes |
|---|---|---|
| 5 sellers, 12 deals (10 physical, 1 voucher, 1 ticket), business profiles, publish | **real runtime** (`app.inject` on the real Fastify app, real DB) | seller rows inserted by SQL, then real profile/deal/publish routes |
| 130 OTP identities, 120 participations, 40-request burst on capacity 30 (exactly 30 succeed), `qty ≤ max_units`, one `deal.target_reached` audit | **real runtime + real DB concurrency** (in-process concurrent requests, real locks) | runs the **legacy** inventory path: `CANONICAL_POSTGRES_RUNTIME` is unset in the harness and in the local test runner, whereas hosted staging sets it (`render.yaml`). No local suite drives concurrent joins on the canonical RPC path: `canonical_postgres_runtime_boundary_validation` applies `supabase/staging/001…009` but only probes `/health` and `/readiness`; hosted journeys are single joins. See §4.4 for the review-branch proof. |
| Duplicate participation / idempotency | **real runtime** | proves request-key replay returns the same participant (also after process restart). The product has no one-participation-per-buyer rule (a second key creates a second row by design; runbook §4). |
| Pending seller refused publish in production-like mode | **real runtime** | `APP_ENV=production` flipped for one request |
| Cross-seller fulfillment reads refused (11 deals) | **real runtime** | 403/404 |
| Deals 1–2 "Completed" with 18 successful / 2 released orders | **synthetic fixture** (`forceParticipantTo` / `forceDealState`: trigger-legal SQL state walks, no charging, no provider, no worker) | correct for a read-model / fulfillment-projection test; **not** a payment or lifecycle proof — the report says so explicitly |
| Pickup code → resolve → handoff ×2 | **real runtime** on the synthetic completed state | the second handoff reuses the SAME idempotency key (replay); a genuine second handoff with a new key is refused by `seller_pickup_fulfillment_validation` (existing, real) |
| Shipping / handoff Excel vs DB vs admin profile | **real runtime** on synthetic completed state | only `ChargedSuccess`/`RecoveredCharge` rows appear |
| Voucher / ticket **fulfillment** | **not in the scenario** (those deals are only joined) | proven by `deal_types_e2e_validation` (real mock charge worker → Completed → issuance) |
| Full lifecycle Charging → CompletionWindow → Completed/Failed | **not in the scenario** | `deal_types_e2e_validation`, `full_e2e_gate_validation`, `charging_completion_window_validation` (real worker handlers) |
| Admin overview settlement = SQL truth | **real runtime** on synthetic completed state | the assertion that found P-1 |
| 8% fee "240 checks" | **pure function** (`calculatePlatformFeeMoney`) over 120 orders × 2 VAT modes | not the ledger path; the ledger is covered by `platform_fee_payments_8_percent_validation`; the overview's own fee field was asserted only under synthetic-zero VAT (→ D-1) |
| "distributor=0" | pure function: `affiliate_fee_amount` key absent | weak on its own; corroborated by code inspection + existing tests + my A7 |
| Viral attribution / generation 2 / metrics | **real runtime** (joins with `affiliate_ref`) + direct module calls for recompute | persisted across restart |
| Process restart | **real**: a separate `node` process re-opens the same database, compares every row of 9 tables, replays a join, reads 120 tracking links | PostgreSQL itself is not restarted |
| Worker restart: 200 jobs, kill at 100, restart, exactly-once completion audits, 11 future jobs preserved | **real standalone worker process** (`worker.js`, SIGKILL + restart) | jobs are `deadline_check` on a **Draft** deal → the handler returns early (no business effect); the kill happens **between** jobs (the previous job was confirmed `sent` first), so no in-flight lease is reclaimed in the scenario |
| Lease expiry, stale-owner fencing, reclaim, connection loss | **real, two processes** — `worker_two_process_fencing_validation` (existing suite in the campaign) | this, not the scenario, is the lease-reclaim proof |
| Performance table | in-process `inject` timings on one workstation | diagnostics only; my run: join_burst p50 899 ms / p95 917 ms, join p50 21 ms, tracking p50 7 ms |

**Overclaim assessment.** The report itself labels the completed states as fixture transitions and points
to the lifecycle suites; it does not describe fixture state as payment proof. Two phrases overreach:
"external-network denial" (H-1) and "inventory protection" without saying the burst ran the legacy
inventory path while staging runs the canonical RPC path. The hosted section correctly refrains from
claiming a deployed SHA — but the SHA is in fact verifiable (§6).

### 4.3 Reproduction (this review)

`node scripts/closed_pilot_war_game.cjs` at `6fa0e62`, local disposable PostgreSQL: **39/39 phases
PASS** (11 gates/setup/scenario + 28 regression suites), summed phase time 211.6 s on this workstation;
`PILOT_DAY_PASS sellers=5 deals=12 synthetic_identities=130 participants=120 burst=40 capacity=30
threshold_crossings=1 oversold=0 duplicate_effect=0`, `RESTART_PASS`, `WORKER_DAY_PASS due_jobs=200
exactly_once=200 future_preserved=11`, `FEE_PASS order_checks=240`. No `NO_NETWORK_REHEARSAL_BLOCKED`
hit in any phase log (nothing tried to leave the machine).

### 4.4 Canonical inventory path — review-branch proof

`tests/canonical_inventory_concurrency_validation.ts` (review branch) applies the same hosted-only staging SQL the runtime-boundary suite applies (`supabase/staging/001`, `006`–`009`; the canonical path needs `participants.inventory_reservation_id` from 006, which no migration provides) to the fresh isolated database, boots the real app with `CANONICAL_POSTGRES_RUNTIME=1` and fires 40 concurrent joins at a deal with capacity 30 / minimum 25:

* C1 exactly 30 succeed, 10 refused (409/422/400), active units = 30, `siton_inventory.inventory_reservations` committed qty = 30, `inventory_deals.committed_units` = 30 and its `deal_state` mirrors `TargetReached`, every success carries an `inventory_reservation_id` — **PASS** (burst 796 ms in-process)
* C2 exactly one `deal.target_reached` audit, deal `TargetReached`, threshold 23 — **PASS**
* C3 replay of a winning request (same idempotency key) returns the same participant and creates nothing; a fresh request after capacity is refused — **PASS**
* C4 no `NotJoined` orphan, no reservation left `held` — **PASS**

This is a local proof of the same RPC contract staging runs, not a hosted concurrency test. First run of the test failed twice on my own fixture (the mock authorizer declines payment-method ids ending in `0000`; then the missing 006 column) — both were harness corrections, recorded here rather than hidden.

## 5. Independent regression `tests/admin_settlement_success_money_validation.ts`

| Step | master `d4c7877` | Codex `6fa0e62` | review branch |
|---|---|---|---|
| A1 overview gross = success-only money (released/refunded/unrecovered excluded) | FAIL 600≠280 | PASS | PASS |
| A2 captured order on a Failed deal is not a completed settlement | FAIL | PASS | PASS |
| A3 `joined_units` keep inventory meaning (9 / 2) | PASS | PASS | PASS |
| A4 synthetic-zero VAT: fee = 8% of success gross + fee VAT | FAIL (fee on 600) | PASS | PASS |
| A5 explicit 18% VAT: fee base excludes buyer VAT (admin overview) | FAIL | **FAIL** (D-1) | PASS |
| A6 same rule on the seller deal money summary | FAIL | **FAIL** (D-1) | PASS |
| A7 no distributor/affiliate commission on any surface; rate 0.08 | PASS | PASS | PASS |

## 6. Hosted (GET only, no deployment)

`https://siton-staging-web.onrender.com`: `/health` 200 `{"ok":true}`; `/readiness` 200 (database
connected, `siton_inventory_rpc_v1`, `siton_web_runtime`); `/preview/` 200 with assets
`index-B590zxht.js` / `index-DmumZztR.css`; **`/api/preview/meta` reports
`runtime_commit_sha = d4c7877f9b704734036d69f57f7d98f794f4d034`** (Render's `RENDER_GIT_COMMIT`,
`EXPECTED_COMMIT_SHA` unset, `is_stale:false`). So the exact hosted SHA **is** identifiable: hosted
staging runs **master**, not the Codex branch, as expected for an unmerged fix. The Codex report's
"exact hosted Git SHA cannot be verified from these public responses" understates what the runtime
exposes but implies nothing stronger than "plausibly deployed" — no overclaim of the branch being live.

## 7. Regression campaign (this review)

Fresh isolated databases, one runner at a time, mobile artifacts built first (`npm run mobile:verify`, both worktrees).

| Campaign | Result |
|---|---|
| Codex war game at `6fa0e62` (as shipped) | **39/39 phases PASS** (11 gates/setup/scenario + 28 suites); refusal controls 6/6 (4 reported + 2 mine) |
| Codex war game at `6fa0e62` under the hardened hook (`--skip-compile`) | **38/38 PASS**, zero `NO_NETWORK_REHEARSAL_BLOCKED` hits (nothing in the campaign tries to leave the machine) |
| `npm run test:all` at `6fa0e62` (207 files) | unit 15/15, integration 30/30, db 8/8, api 44/44, workers **12/13**, payments 29/29, security 39/39, concurrency 7/7, failure 9/9, e2e 13/13 — the one failure is `worker_two_process_fencing_validation` ("timeout waiting for: p2 all six claimed and blocked", a 20 s poll on two spawned worker processes) under full-suite load; it **passed in the war-game campaign and 2/2 isolated re-runs** on the same code, and has a documented runner-flake history (PROJECT_STATUS 2026-09-06). Not attributable to the 7-line overview change. |
| `npm run test:all` on the review branch (209 files) | unit 15/15, integration 30/30, db 8/8, api **45/45** (incl. the new settlement/VAT suite and `backend_sanity_suite` pinning `summarizeMoney`), workers 13/13 (fencing passed), payments 29/29, security 39/39, concurrency 7/8 → 8/8 after the fixture correction of the new canonical suite (re-run in isolation: 5/5), failure 9/9, e2e 13/13 |
| Static gates on the review branch | lint/backend enforcement, payment compliance scan, runtime DDL scan, architecture gate, `git diff --check`: PASS |

Runs 1–4 were executed on this workstation against local PostgreSQL only; no hosted resource was touched.

## 8. Decision

**SAFE_TO_MERGE_CODE = YES** for `codex/closed-pilot-war-game` at `6fa0e62`: the only production change
is a correct, minimal, canonical-source read-model fix; the harness is safe to run and proves what it
claims once the synthetic/real split in §4.2 is read as written. The two findings here (D-1 fee base under
explicit VAT — required before real money, not before the dry pilot; H-1 hook hardening) are delivered
on the review branch as separate minimal commits and do not block the Codex merge.
