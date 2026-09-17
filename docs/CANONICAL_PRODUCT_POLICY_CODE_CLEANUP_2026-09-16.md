# Siton Code Cleanup Task — Canonical Policy Alignment 2026-09-16

This task implements `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` in runtime code. Do not modify the CMS/content-management work currently being implemented in parallel.

## Scope

### A. Fixed 24-hour Completion Window

- Replace any environment-configurable Completion Window duration with a code-level canonical constant of exactly 24 hours.
- Remove `COMPLETION_WINDOW_MINUTES` or equivalent runtime/deployment overrides from product behavior and examples.
- Preserve the existing one-time `completion_window_until` timestamp model.
- Recovery remains available only to participants in `ChargeFailedCompletion` and the corresponding money recovery state.
- Add regression coverage proving 24 hours is fixed and cannot be changed by environment variables or request fields.

### B. Mandatory finite `max_units`

Audit every create, clone, edit, publish, import, admin, API, and inventory path.

Required invariant:

- `max_units` is finite, positive, non-null, and at least `min_units`.
- No unlimited/null representation is legal.
- Draft creation may choose a finite fallback only as a temporary safe draft value; publish must validate that a finite upper limit is present and seller-facing UX must expose/confirm it.
- Preserve the current staging DB `NOT NULL` and `max_units >= min_units` enforcement.
- Add regression tests around create/edit/publish and concurrent capacity enforcement.

### C. Remove distributor product role/module

There is no distributor/affiliate user role in the canonical product.

Remove or retire distributor-specific runtime surfaces including, where present:

- distributor identity and session code;
- distributor login/authentication and environment secrets;
- distributor dashboards/routes/pages/components;
- seller-to-distributor flows;
- distributor-specific links and attribution product surfaces;
- schema-contract requirements for legacy distributor/affiliate tables;
- distributor-specific API contracts and tests;
- admin UI that presents distributors as a product role.

Preserve ordinary deal sharing and role-neutral viral/acquisition analytics where they do not create a distributor identity, permission set, economic entitlement, or separate product path.

Do not rewrite already-applied historical migrations. After all runtime dependencies are removed, use a forward migration if legacy `affiliate_*` / `distributor_*` tables can safely be dropped. If dropping them is not yet safe, mark them explicitly deprecated and non-canonical and remove them from required runtime contracts.

### D. Fixed Siton fee

Verify and preserve the existing implementation:

- fixed system rate `0.08`;
- fee base includes all collected purchase amounts including delivery/shipping;
- customer VAT component is excluded from the 8% base;
- no per-deal `commission_rate` or override exists;
- no distributor commission or payout logic exists.

Strengthen regression coverage if any execution path is not covered.

### E. Deal-duration coordination

**RESOLVED 2026-09-17.** The no-seven-day-cap work landed on `master` in PR #42 as migration 071 (`docs/LONG_HORIZON_AUTHORIZATION_ARCHITECTURE.md`). There is no longer a parallel task to coordinate with. What remains binding: never reintroduce a seven-day maximum deal duration in any active surface (seller picker, hint, validator, Hebrew copy, backend validator, legacy frontend). The two-hour minimum stands, and the remaining twenty-year ceiling is a technical sanity bound, not a business or payment cap.

## Safety boundaries

- Real money remains 0.
- Do not activate or modify Grow.
- Do not change legal text in this task.
- Do not edit CMS/content-management scope.
- Do not weaken state-machine, idempotency, audit, outbox, inventory, security, or 90% completion rules.
- Do not modify historical applied migrations in place.

## Verification

At minimum:

1. focused tests for completion-window policy, `max_units`, distributor removal, and 8% fee;
2. TypeScript/build and relevant static gates;
3. schema/migration integrity gates;
4. `npm test` if the scope touches shared runtime paths;
5. release preflight/static architecture checks relevant to changed paths;
6. proof that no real-money or Grow activation occurred.

## Completion protocol

Update `PROJECT_STATUS.md` with completed, tested, open, percentage, and next step. Review the full diff. Commit with a clear message, push the task branch, and open a PR. Do not auto-merge over failing CI.
