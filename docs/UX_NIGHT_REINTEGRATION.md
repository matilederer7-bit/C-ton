# Overnight UX reintegration on current master

## Provenance and scope

- Source base: `82c91d62fd092350748405c8aec15a23d0e2af5e`.
- Source night: `84d6c1d88ae3d2e860307f5dfd767876a6488931`.
- Source commits: `9ce6df9` (round 2), `84d6c1d` (overnight hardening).
- Fetched master / new branch base: `03793231aab4d11363dd6d5787a992c72ccd3237`.
- Branch: `codex/ux-night-reintegration-current-master`.
- Fresh isolated worktree; no merge, old-lineage rebase, deployment, or PR.

## Delta classification

| Category | Finding and disposition |
| --- | --- |
| A — already present | Canonical receipt persistence and entitlement gating, public seller profile storage, strict tracking-token policy, authentication redirects, hidden admin entry and step-up, Mall flag routing, and staging acceptance are inherited. The overnight tracking security test adds coverage, not a new tracking policy. No complete UX feature hunk in the two-commit delta was already applied on master. |
| B — superseded | Staging closure's participant/token React key is newer than the old source App and remains intact. R9C late-money exception handling in frontend_runtime is newer and remains intact. The old status text and instruction to integrate after R9C are obsolete; they are not copied. |
| C — missing and ported | Early canonical join CTA; strict typed quantity handling; exact field attention and clearing; labels; dialog focus containment/return; pending pickup status independent of receipt availability; entitlement identity scoping; uniform share controls; seller public identity projection and display; CMS/profile empty/error states; receipt selection presentation; one hero medium; FAQ fallback resolver; legal shell; async history scroll stabilization; narrow-width wrapping and spacing; regression tests and the complete 324-check browser harness. |
| D — not carried | Unrelated deletion of the unused legacy `web/src/vtree.tsx`; historical milestone/test claims; whole-file replacement of App/frontend_runtime/test files that would erase newer master changes. No backend receipt/FAQ/video/virality contracts are invented. |

Inspected `claude/ux-product-polish-round2` at `9ce6df9` (first source commit),
`claude/ux-sprint4-reintegration` at `4a86bc5` (already in master; not the
historical sprint implementation implied by its name), and
`claude/staging-acceptance-closure` at `d77aecb` (ancestor of master).

The original source-base-to-night patch was checked against current master and
applied by path/hunk, excluding status/docs and the unused-file deletion.
The only newer master production changes within the selected paths were the
App tracking identity key and frontend_runtime R9C additions; neither was
replaced. The staging regression assertion in buyer-polish validation remains.
The backend diff is limited to two public seller SELECT/projection hunks using
existing migration-066 fields, with a strict public payload allow-list test.

## Open backend contracts

Receipt method persistence remains single-valued; selection cards do not claim
multiple methods can be saved. Structured FAQ persistence and CMS hero-video
storage were closed by the site CMS (docs/SITE_CMS.md); windowed backend virality remains open. FAQ fallback and hero
precedence are presentation helpers, not new storage contracts. Existing
business-profile save semantics and legal content remain authoritative.

## Validation

Browser proof: **324 passed / 0 failed**, widths **320 / 390 / 430 / 768 / 1280 /
1440**, zero captured application console errors and zero overflow failures.
Command: `node scripts/ux_polish_round2_browser_proof.cjs --shots=.tmp_ux_shots`.
Local log: `.tmp_browser_final.log`; screenshots: `.tmp_ux_shots/`.
Browser evidence uses actual React components with deterministic local fixtures
and headless Edge; it is not a hosted production or real-device proof.

The first launch was blocked by sandbox process permissions. The first completed
run was 323/324: the receipt-choice CSS color transition had not completed at a
fixed 200 ms observation. The harness now waits at most its existing 8-second
budget for the required exact orange color, retaining all single-selection and
color assertions. The complete rerun passed, without reducing the check count.

Web TypeScript (`tsc -b web`), backend TypeScript (`tsc --noEmit -p tsconfig.json`),
test compilation, static route inventory plus all four behavioral authorization
suites, backend enforcement/lint, architecture truth gate, runtime-DDL scan and
payment compliance scan passed.

The full runner executed all **225 files**, initially 218 pass / 7 process-launch
failures (4/10 groups clean in that invocation). It was not a clean full-suite
invocation. The process failures were `db_client_error_process_survival`,
`worker_two_process_fencing`, `provider_environment_capability`,
`real_listener_hostile_request_security`, `web_sigterm_fault_process`, and the
two existing `frontend_browser_smoke` / `frontend_browser_v11` suites. Six
reported `spawn EPERM` directly; provider capability's empty child output passed
on rerun with child-process permission. No test implementation was changed.

All seven failed files passed their focused reruns with process permissions.
**225/225 distinct files passed across the full run and corrective reruns**:

| Group | Final file coverage |
| --- | --- |
| Unit | 16/16 |
| Integration | 31/31 |
| Database | 8/8 |
| API | 44/44 |
| Workers | 13/13 |
| Payments | 43/43 |
| Security | 40/40 |
| Concurrency | 8/8 |
| Failure | 9/9 |
| E2E | 13/13 |

Local evidence: `.tmp_full_suite.log`, `.tmp_db_retry.log`,
`.tmp_worker_retry.log`, `.tmp_provider_retry.log`, `.tmp_security_retry.log`,
`.tmp_failure_retry.log`, `.tmp_e2e_retry.log`, `.tmp_routes.log`.
The new tracking regression includes 90 real anonymous requests under production
signal combinations; all refuse the tokenless request without buyer PII.

The protected `deal_types_e2e_validation.ts` passed in the full run. The known
master voucher/hash false-positive is **BASELINE_EXTERNAL (reported by task;
not reproduced locally)**. This does not certify remote master CI as green.

## Files ported

- Public projection: `src/frontend_runtime.ts` (public profile ID/image only).
- React shell/controls: `web/src/App.tsx`, `components.tsx`, `dialogFocus.ts`,
  `faqContent.ts`, `fieldAttention.ts`, `heroMedium.ts`, `pickupCard.tsx`,
  `quantityInput.ts`, `receiptContent.tsx`, `scrollRestoration.ts`, `styles.css`.
- Pages: `web/src/pages/admin.tsx`, `deal.tsx`, `landing.tsx`, `seller.tsx`,
  `sellerInquiries.tsx`, `sellerPickup.tsx`, `track.tsx`.
- Tests: `tests/buyer_feedback_support_operations_validation.ts`,
  `frontend_foundation_buyer_polish_validation.ts`,
  `frontend_foundation_ux_premerge_validation.ts`,
  `ux_premerge_tracking_security_validation.ts`.
- Proof: `scripts/ux_polish_round2_browser_proof.cjs`,
  `scripts/ux_premerge_browser_checks.cjs`, and the `package.json` proof command.
- New milestone documentation: this report and an append-only block in
  `PROJECT_STATUS.md` (no historical blocks replaced).

## Isolation

`tests/deal_types_e2e_validation.ts`, migrations 067/068, payment behavior,
notification configuration, Grow integration, Claude branches, and master are
unchanged. REAL_MONEY=0. GROW_CALLED=NO. No notifications activated.

## Finalization

Final fetch still reports master
`03793231aab4d11363dd6d5787a992c72ccd3237`. No master movement or newer status
block required reconciliation. The task reports a separate Claude CI repair;
it has not landed on fetched master. This branch is ready for rebase onto the
eventual green master, followed by renewed diff review and tests. No exact
future base SHA is available yet. READY_FOR_REBASE_ON_GREEN_MASTER=YES;
READY_FOR_PR=NO. No PR opened, no merge performed.
