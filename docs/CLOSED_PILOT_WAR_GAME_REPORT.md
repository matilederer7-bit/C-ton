# Closed pilot war game — 2026-09-09

Tested code commit: `c060596ad08e1fc0b35823c8d620a852db9aadad` (the following commit adds documentation only).

Base master: `d4c7877f9b704734036d69f57f7d98f794f4d034`, verified by `git fetch origin` at task start. Branch: `codex/closed-pilot-war-game`. Isolated worktree: `C:\Users\Lenovo\Documents\C-ton-codex-pilot-war-game`. Initial behind-master count: **0**; initial worktree: **clean**. No financial candidate was used.

**Outcome:** one pilot blocker reproduced and fixed in the admin overview backend read model. The shared local pilot, process restart, worker workload, and focused campaign pass. Closed-web-pilot readiness remains **98%**, an operational assessment retained from master, not a statistical reliability estimate. Real-money readiness remains **0%**, separate and unchanged. This branch is not merged or deployed.

## Reproduce

Install the repository's locked dependencies and have a local PostgreSQL role able to create disposable databases. Supply `DATABASE_URL` through the process environment, then run from the repository root:

```powershell
node scripts/closed_pilot_war_game.cjs
```

The harness does not load a credential file. Its child environment is allowlisted: mock payment provider, internal-ledger payout, log-only notifications, test mode, external-network denial. It refuses missing/nonlocal database URLs, production mode, and URL query overrides. It connects administratively to local `postgres`, creates fresh uniquely named databases, applies the existing 58 migrations and prerequisites, and drops every database with `FORCE` in cleanup. It never modifies the database named in the input URL. No new migrations or hosted DDL.

Options: `--scenario-only` runs the shared day, process restart and worker workload; `--only=<suite-name>` runs one explicitly allowlisted regression; `--skip-compile` reuses an already compiled **unchanged** tree for local diagnosis. Normal release use should omit these flags. Failure exits nonzero; the campaign continues independent selected suites to report all failures. Logs and machine-readable phase results are in ignored `.tmp_pilot_results/`. The synthetic restart snapshot, including synthetic tracking credentials, is stored only in a temporary directory and deleted afterward. Windows timeout cleanup terminates the owned test process tree.

## Shared pilot topology

| Element | Exercised |
|---|---|
| Sellers | 5 named synthetic sellers: 4 approved, 1 pending; two additional framework prerequisite sellers have no pilot journeys |
| Deals | 12: 10 physical products, 1 voucher, 1 ticket |
| Seller assignment | Deals 0–10 round-robin across approved sellers; deal 11 belongs to pending seller and stays Draft |
| Physical delivery | Both pickup and shipping; synthetic recipient, phone, email, address, city and notes |
| Buyers | 130 distinct OTP-verified synthetic identities; 120 successful participation rows; 10 capacity refusals |
| Burst | 40 prepared near-simultaneous joins on deal 0, capacity 30, minimum 25; exactly 30 succeed |
| Other joins | 10 per deal on deals 1–9; all 90 succeed |
| Threshold | Exactly one `deal.target_reached` audit for the burst; canonical active quantity never exceeds max |
| Replay | Same request/key returns same participant; same replay remains idempotent after a fresh process |
| Mixed completion | Deals 1 and 2 seeded along existing trigger-legal fixture paths: 18 eligible successful/recovered orders, 2 released/dropped orders |
| Pause | Deal 10: pause → reopen → pause; retained manual ClosedForJoining state |
| Referral tree | Nine deal-local trees, direct root, child, grandchild, multiple branches; generation 2 asserted |
| Viral data | 120 attributions, 320 events (200 explicit view events plus joins), 16 cached metric scopes |
| Support | Public contact and buyer feedback create two durable operational cases |
| Worker | 200 additional safe `deadline_check` jobs against a Draft deal, 200 unique completion audits; 11 future jobs preserved |

Scenario determinism means fixed actor labels, counts, topology, request keys, assertions and bounded relative schedules. Security credentials, UUIDs and event timestamps remain freshly generated; randomness never chooses an expected business outcome. No real contacts are used or contacted.

The shared day uses existing synthetic fixture transitions for completed read-model reconciliation, not a claim that SQL fixture setup proves payment processing. Real application handlers and mock charging transitions are exercised separately by the listed lifecycle suites. Supplementary isolated fixtures are **not** added to the 5/12/130 shared-day counts.

## States, ownership and fulfillment

Across the shared scenario and isolated suites, exercised states are **Draft, PendingTarget, TargetReached, ClosedForJoining, ReadyForCharging, Charging, CompletionWindow, Completed, Failed, Cancelled**. The deal-type E2E suite drives real mock worker handlers through voucher/ticket completion and the failed deadline path. Charging-completion tests cover unresolved capture/recovery truth and refuse premature or unsupported transitions. Cancellation tests prove Draft-only cancellation and refusal after publication; no guard was weakened.

Pending seller can configure a profile and create a draft. The production-like publish guard is exercised locally and returns `409 seller_kyc_not_approved`. Demo-preview intentionally permits pending KYC publication; this pre-existing mode distinction is documented rather than changed. Seller lifecycle, image, pause/reopen, draft, export and authorization suites cover the approved seller workflow. Cross-seller read refusals run over all 11 published pilot deals; the security/cancellation suites add mutation refusals and anonymous controls.

Physical pickup passes: canonical code issuance, correct seller resolution, quantity/name/product checks, one handoff, harmless second handoff, tracking/fulfillment/admin/Excel agreement, immutable money state. Negative controls include foreign seller, unknown/tampered code, unpaid/recovery/released/refunded states, failed/open deal, already fulfilled, stale quantity and concurrent handoffs. Cancelled eligibility is additionally exercised at the canonical decision/guard level; a live participant-bearing deal cannot be artificially cancelled through the product.

Shipping exports pass with identifiers, recipient/phone/email, quantity, address/city/notes, payment truth and handoff status. The shared assertion parses Excel and compares its rows and fulfilled/awaiting labels to database participants and the admin profile. Only `ChargedSuccess` and `RecoveredCharge` qualify; the two dropped/released orders are absent. Shipping remains manual export/list fulfillment; no carrier or pickup-scanner requirement was added.

Voucher and ticket E2E passes: multi-unit issuance, unique units/codes, stored code hashes, ownership, redemption, double redemption, eligibility, tracking and export checks. Physical orders do not acquire voucher/ticket redemption semantics and nonphysical orders do not gain pickup credentials.

## Restart, worker and operational truth

The first application process exits, then a new process starts against the same disposable PostgreSQL database. Before any tracking request it compares complete JSON rows for deals, participants, join idempotency results, viral attributions/events/cache, fulfillment units, outbox and operational cases to the prior snapshot. All match. All 120 tracking URLs resolve; the fulfilled order stays fulfilled; replay does not create a row. This is a genuine application-process restart, **not** just a module reload. PostgreSQL itself is retained, not restarted or destroyed during this phase.

The shared worker phase keeps the web application alive while the worker is stopped, inserts pending work, starts a real standalone worker, drains 100 jobs, stops it, inserts work while stopped, restarts it and drains another 100. Every selected event has exactly one completion audit; no DLQ or processing residue; 11 future jobs remain pending. The separate two-real-process suite blocks handlers with a database lock, kills an active owner, observes actual lease expiry, proves heartbeat renewal for the survivor, reclaim, stale-owner fencing, restart and connection-interruption recovery. Recovery suites cover duplicate claims/completions, bounded retry/backoff and poison-event DLQ; deliberate poison DLQ is distinguished from harmless restart, which produces none.

Admin capabilities are exercised through overview, launch console, deal profile, support cases and control-plane suites: seller/deal totals, approaching thresholds/deadlines, terminal states, synthetic unresolved payments, awaiting/fulfilled handoffs, case history and outbox due/scheduled/stuck information. The shared scenario reconciles overview settlement gross against a separately computed database sum and checks all 12 deals are represented. The defect below was found by this assertion. Error/incident evidence comes from failed join transactions and their rollback controls, denied seller actions, bad tracking/pickup credentials, worker retry audits, refused redemption, contact/feedback and existing synthetic operational-case tests. Raw security tokens are not included in this report.

No pilot-critical canonical in-memory dependency was found in exercised paths. This does not claim every unexercised application surface is persistent. Durable cases, attribution, metrics, idempotency and fulfillment were specifically compared across processes.

## Economic invariant

240 checks run across all 120 generated orders under both supported synthetic VAT authority modes (`synthetic_zero` and explicit 18% product/delivery VAT). Prices include 1.01, 7.77, 19.99, 60 and 10000.99; delivery is 0 or 20. Expected 8% fee cents are computed independently using integer rounding after subtracting authoritative buyer VAT. Every check passes. Delivery is included, buyer VAT excluded, and no distributor fee field exists. Existing canonical ledger/fee tests additionally cover duplicate event recording and the absence of distributor commission.

The existing admin `platform_fee_amount` field includes VAT **on Siton's fee**: on the fixed 1260 synthetic gross, the 8% base fee is 100.80, fee VAT is 18.14, response total is 118.94. Neither the economic rule nor this existing field convention changed.

## Performance observations

Local PostgreSQL and in-process Fastify `inject`, one workstation; these are bounded diagnostic timings, not hosted load-test promises. Only the join and tracking samples have meaningful percentiles. Other operations have one to four samples.

| Operation | Samples | p50 ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|
| join_burst | 40 | 564.5 | 575.2 | 575.3 |
| join | 90 | 13.5 | 18.6 | 21.3 |
| fulfillment_resolve | 1 | 3.2 | 3.2 | 3.2 |
| admin_profile | 2 | 56 | 56 | 56 |
| export | 4 | 10.6 | 35.1 | 35.1 |
| seller_listing | 1 | 5.1 | 5.1 | 5.1 |
| seller_detail | 1 | 6.9 | 6.9 | 6.9 |
| admin_overview | 1 | 5.6 | 5.6 | 5.6 |
| tracking | 120 | 5.3 | 9.5 | 11.2 |

No observed timeout, deadlock, oversell or obvious seconds-long database query in this workload. The standalone worker workload is intentionally paced by polling conditions, not a throughput benchmark.

## Defects and scope

### PILOT_BLOCKER P-1 — admin settlements included released orders — FIXED

**Reproduction:** complete two synthetic physical deals, each with 10 orders at 60 and alternating 0/20 delivery. On one deal release/drop two orders through the existing fixture path; include successful and recovered participants among the other 18. `GET /api/admin/overview` reported gross **1400**, while SQL restricted to `p.money_state IN ('ChargedSuccess','RecoveredCharge')` returned **1260**. The new assertion failed on unmodified master with `1400 !== 1260`; the withheld 140 is exactly those two released orders. Exports already excluded them. The operator-facing settlement read model materially overstated successful money.

**Fix:** `src/frontend_runtime.ts`, only `/api/admin/overview`: add money-state-filtered settled quantity and delivery aggregates; use those for settlement totals. Joined inventory columns are preserved. Five added and two removed lines, no UI markup, financial lifecycle, provider, VAT, fee-rate, migration or authorization changes.

**Regression/negative control:** `scripts/closed_pilot_scenario.cjs` independently sums successful database orders, asserts gross 1260 and existing fee-with-VAT response 118.94, checks eligible Excel rows, and preserves both released counterexamples. It demonstrably failed before the fix and passes after it. Reverting the two settled aggregate consumers reproduces the same failing assertion. Successful/recovered money remains included. Full selected campaign runs against the fix.

### TEST_ONLY T-1 — pre-existing randomized code/hash assertion — documented, not changed

The initial `deal_types_e2e_validation` F4 assertion failed because `/[A-HJ-NP-Z2-9]{16}/` also matches a sufficiently long all-digit substring of a legitimate lowercase SHA-256 hash. The failure output showed a hash, last4, `Issued` and empty metadata, not a plaintext voucher. Subsequent unchanged executions passed with different generated hashes. This is a pre-existing probabilistic test false positive; no assertion was removed or weakened and no retry-until-green behavior was added to the harness. The initial failure is retained here even though the final campaign passes. Treat a future failure by inspecting its evidence, not blindly retrying it.

Harness development corrections (demo KYC policy, existing fault suites' required `siton_test_` database prefix, fee-with-VAT response convention) were test setup corrections, not production defects. One compiler process timed out during an intermediate run; a later clean compile passed. These are not counted as pilot blockers.

### POST_LAUNCH F-1 — overview bounded to 100 deals

The existing admin overview uses `LIMIT 100` before deriving its summary. All 12 pilot deals are covered, but that endpoint is not an all-history aggregate beyond its cap. Documented future backend/read-model work; no broad scale optimization was made.

Pilot blockers found **1**, fixed **1**, open **0 in exercised local scope**. Post-launch findings **1**; test-only findings **1**. Hosted deployment of this fix and the existing owner console readiness actions remain outside the local proof. Existing real-money blockers are not reduced.

## Test campaign

Final command: `node scripts/closed_pilot_war_game.cjs` with an externally supplied local `DATABASE_URL`. Each selected suite receives a fresh migrated database. The expensive R9C financial torture/fuzz lab, mobile tests and full 207-file suite were not run. No 700-case financial fuzz campaign.

**39/39 phases PASS, including 28/28 selected regression files; summed phase runtime 138.478 seconds.**

| Phase / exact suite stem | Result | Duration ms |
|---|---|---:|
| `typescript` | PASS | 13441 |
| `backend_enforcement_scan` | PASS | 1068 |
| `runtime_ddl_scan` | PASS | 87 |
| `architecture_truth_gate` | PASS | 80 |
| `compliance_payment_scan` | PASS | 190 |
| `migrations` | PASS | 906 |
| `migration_rerun` | PASS | 378 |
| `prerequisites` | PASS | 198 |
| `pilot_day` | PASS | 6592 |
| `process_restart` | PASS | 1454 |
| `worker_day` | PASS | 29690 |
| `seller_pickup_fulfillment_validation` | PASS | 1842 |
| `pickup_fulfillment_concurrency_validation` | PASS | 2044 |
| `seller_fulfillment_security_validation` | PASS | 947 |
| `seller_shipping_export_validation` | PASS | 10899 |
| `seller_deal_excel_export_validation` | PASS | 1135 |
| `seller_delivery_excel_export_validation` | PASS | 10992 |
| `deal_types_e2e_validation` | PASS | 2078 |
| `p03_pause_reopen_business_profile_validation` | PASS | 978 |
| `seller_lifecycle_route_authority_validation` | PASS | 1084 |
| `seller_onboarding_validation` | PASS | 92 |
| `concurrency_proof` | PASS | 16444 |
| `outbox_worker_recovery_validation` | PASS | 2644 |
| `outbox_worker_failure_recovery_validation` | PASS | 242 |
| `worker_two_process_fencing_validation` | PASS | 17758 |
| `worker_separation_validation` | PASS | 446 |
| `buyer_feedback_support_operations_validation` | PASS | 1230 |
| `admin_support_cases_validation` | PASS | 1238 |
| `admin_control_plane_validation` | PASS | 1443 |
| `r6_viral_graph_validation` | PASS | 1281 |
| `platform_fee_payments_8_percent_validation` | PASS | 391 |
| `money_tax_invoice_canon_validation` | PASS | 115 |
| `charging_completion_window_validation` | PASS | 2496 |
| `full_e2e_gate_validation` | PASS | 1906 |
| `read_surfaces_truth_alignment_validation` | PASS | 73 |
| `deal_images_validation` | PASS | 1398 |
| `p05_admin_viral_support_validation` | PASS | 1217 |
| `admin_launch_console_validation` | PASS | 928 |
| `seller_cancel_ui_validation` | PASS | 1053 |

Suite stems resolve to `tests/<stem>.ts`; compilation uses `tsconfig.test.json`. The four static gates cover lint/backend enforcement, runtime DDL, architecture and payment compliance. Migration checks cover a clean install plus two idempotent reruns and ledger completeness.

Additional harness refusal checks: **4/4** (nonlocal host, production mode, query host override, missing URL), each refuses before connecting. `git diff --check` passes. Focused tests were run before the production fix; the complete relevant campaign was then run against the fix. Logs retain detailed per-suite assertions locally; only concise nonsensitive evidence is committed.

## Hosted read-only smoke

GET-only checks against `https://siton-staging-web.onrender.com`:

| Surface | Result |
|---|---|
| `/preview/` | 200, HTML, 2564 characters |
| `/preview/assets/index-B590zxht.js` | 200, JavaScript, 565602 bytes; seller pickup and fulfillment handoff markers present |
| `/preview/assets/index-DmumZztR.css` | 200, CSS, 75838 bytes |
| `/health` | 200, `{"ok":true}` |
| `/readiness` | 200, database connected, `siton_inventory_rpc_v1`, `siton_web_runtime` |

Sprint 3 assets are plausibly deployed; an exact hosted Git SHA cannot be verified from these public responses. The browser-fetch tool could not open the preview URL, so the smoke used direct HTTPS GETs. No hosted write rehearsal, migration, financial state mutation, communications, Render plan change or deployment was performed.

## Delivery boundaries

Production files changed: **`src/frontend_runtime.ts` only**, backend-only overlap explained in P-1. Added harness files: `scripts/closed_pilot_war_game.cjs`, `scripts/closed_pilot_scenario.cjs`. Documentation: this report and `PROJECT_STATUS.md`.

Payment code changed **NO**; Grow changed **NO**; migrations added **NO**; hosted DB changed **NO**; real money **0**; real email **0**; real SMS **0**; distributor commission **0**. Claude-owned legal, viral, search, quantity, maps/Waze, scroll and long-horizon UX/architecture, and all mobile files remain untouched.

**Next step:** review and merge the isolated admin read-model fix together with its reusable pilot proof.
