# PROJECT_STATUS entries outside any agent slot (2026-10-06)

> **SUPERSEDED — HISTORICAL (2026-10-12).** This document is tiered ARCHIVE in `docs/DOCUMENTATION_MAP.md`: history, never authority. It holds, verbatim, the two ChatGPT milestone entries that sat in `PROJECT_STATUS.md` above every marked `AGENT_STATUS` slot, so no routine slot replacement could retire them. Both are complete: PR #239 merged as `868a746` (see the Claude slot) and the demo-readiness threshold suite merged in #238/#240. Moved as a deliberate status-maintenance step (AI_WORKFLOW.md §14).

### ChatGPT latest milestone — Lean Refactor: admin operational status reads extracted (2026-10-06)

- BRANCH / PR: `chatgpt/admin-operational-status-routes-20261005`, PR #239. Scope is exactly three read-only GET routes: `/api/admin/outbox-status`, `/api/admin/notifications-status`, `/api/admin/invoice-status`. Admin mutations, payout reads and system-ops reads are out of scope.
- COMPLETED (code): moved the original contiguous 300-line block byte-for-byte from `src/frontend_runtime.ts` into `src/admin_operational_status_routes.ts` and wired `registerAdminOperationalStatusRoutes` once at the original registry position, after compute-upgrade and before payout-status. No SQL, auth ordering, thresholds, response shape, provider summary or transaction boundary changed. `frontend_runtime.ts` is 8,540 → 8,251 lines by newline count and 128 → 125 direct route registrations.
- COMPLETED (coverage): added the module to `scripts/web_route_inventory.cjs`, `REFUND_READINESS_ROUTE_MODULES`, legal/money gates, release-tool fixtures and every relevant source-concatenation / route-file census touched by the moved text. The moved block remains covered instead of silently disappearing from static gates.
- COMPLETED (tests): added `admin_operational_status_routes_extraction_validation.ts` (registration/order, exact wiring dependencies, admin-read guard, invoice schema check, read-only/no-side-effect rules, response-surface pins and targeted mutants) and `admin_operational_status_read_validation.ts` (401 before DB reads; outbox counts/ages/worker signal; notification provider fallback; invoice provider/webhook/reconcile summaries; SELECT-only fake DB).
- FIXED DURING CI: the first CI pass exposed two TypeScript defects introduced by the extraction: explicit `undefined` values under `exactOptionalPropertyTypes`, and an invalid `assert.throws` overload in the mutant harness. Both were fixed; Docker/route-contract failures were cascading from that compile failure.
- TESTED (pre-final-base): exact head `793fbc0` passed Siton CI run 512, including all lanes and `ci-verdict`. The API lane explicitly passed both new tests: `ADMIN_OPERATIONAL_STATUS_READ_PASS` and `ADMIN_OPERATIONAL_STATUS_ROUTES_EXTRACTION_PASS`. The moved handler block was also compared byte-for-byte with master `493e01f`: exact match, 17,584 characters / 300 lines.
- REVIEW: an early Codex money/security/auth review was requested on `793fbc0`; final review is still required after this lifecycle/status commit, so any earlier verdict is not merge authority.
- BEHAVIOUR: intended none. Read-only extraction only; no migration, real money, refund, payout, provider activation, auth-policy or production mutation.
- OPEN: current-base CI on the final head, final Codex review, merge, master CI, staging web/worker verification and status closeout.
- PERCENT: 80%.
- NEXT: mark PR #239 ready, require green CI + clean Codex on the final head against current master, then merge and verify staging before closing at 100%.

### ChatGPT latest milestone — Demo Readiness threshold regression suite closeout (2026-10-06)

- COMPLETED: `tests/demo_readiness_thresholds_validation.ts` pins the existing read-only `GET /api/admin/demo-readiness` safety boundaries: one DLQ row blocks; 3600s pending age does not warn while 3601s does; `environment.demo_preview` echoes the injected runtime flag; readiness executes no payment or payout provider operation.
- COMPLETED (focused gate): `npm run test:demo-readiness` runs both the original readiness validation and the threshold regression suite.
- TESTED (PR head): PR #238 exact head `c23e75a` passed Siton CI run 506 after a clean rerun of the previously cancelled jobs, including `ci-verdict`; Mobile canonical/static readiness run 211 passed; Codex reviewed exact head `c23e75a` and found no major issues, and the automatic Codex re-review workflow rerun passed.
- MERGED: PR #238 squash-merged as `19c9a0c20a908d9dc7ae447793dfb1bca9ed3f73`.
- BEHAVIOUR: test-only. No runtime, DB, migration, money, payment, provider, auth, UX or API-contract change; no staging redeploy is required.
- TESTED (master): Siton CI run 513 on `19c9a0c20a908d9dc7ae447793dfb1bca9ed3f73` passed all 18 jobs, including preflight-database and `ci-verdict`.
- OPEN: none for this demo-readiness follow-up.
- PERCENT: 100%.
- NEXT: continue PR #239 (admin operational status read extraction) against the current master.
