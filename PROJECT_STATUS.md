# SITON PROJECT STATUS

Updated: 2026-09-16
Canonical branch: `master`
Current merged baseline: `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`

## COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #22 merged to `master`: affiliate visit acknowledgement is emitted only after the recording transaction commits, with deterministic regression coverage.
- Agent efficiency v2 and v3 are merged. PR #23 merged at `39d9569fc3041bf0374e867a8902cea9ea8b5dd5`, providing isolated Claude/Codex status slots, retained task context while PRs are open, fail-closed task replacement and de-duplicated PR CI without reducing the explicit test inventory.
- LONG_HORIZON_DEALS repository implementation was transferred from Claude commit `6c5aacb61492b06c63ff8846fbf5ae0345e6c625` onto current master through a SHA-256 verified patch and opened as PR #24.
- Deal lifetime is decoupled from the lifetime of a single payment authorization. The buyer financial commitment remains in the existing participant state machine; the provider authorization is a renewable technical instrument.
- The 7-day product deadline cap is removed from API validation, seller UI, Hebrew copy and legacy frontend. Minimum deal duration remains 2 hours.
- Migration 069 and the authorization renewal lifecycle add renewable authorization metadata, `reauthorize`, idempotent renewal ownership and worker handling for long-horizon charging.
- The first PR #24 preflight exposed one logging-hygiene defect: the renewal success log emitted the replaced provider authorization id. The field was removed in `f5053ae9bbcbc32acd6b60f86c9c14ebef35b4b8` without changing money or state behavior.

## TESTED

- Transfer artifact SHA-256 verified exactly: `ca1a830c01c767ba0df567c3eb0ce913ca442f51ee5f5f738be18285cc87b61b`.
- Claude source-branch evidence: authorization renewal lifecycle 10/10, deadline policy 5/5, long-horizon worker scheduling 4/4, full grouped repository suite green with four environment-dependent files passing when their prerequisites were supplied, and static gates green.
- The transfer applies to current master with a single documentation conflict in `PROJECT_STATUS.md`; `src/frontend_runtime.ts` merges automatically. The status conflict was resolved while preserving the merged v3 workflow state.
- PR #24 initial release preflight passed TypeScript, backend enforcement, architecture, payment compliance, runtime DDL, Base44 integrity, secret/PII, startup matrix, no-real-money proof, migration static checks, demo build, mobile/PWA and repository hygiene. The only hard static failure was the logging-hygiene leak above, now corrected.
- Fresh GitHub CI on the corrected PR #24 head remains the merge authority.

## OPEN

- PR #24 requires fresh green GitHub CI and merge to `master`.
- Grow and Stripe `reauthorize` semantics are not yet proven in provider sandbox. This is an external-provider readiness blocker for real money, not a repository merge blocker.
- Runtime/production items still open: O-1 Render worker/Blueprint live sync, O-2 hosted `OTP_HASH_SALT`, F-12 production image pruning, F-07 architecture decision and legacy `/app/...` recovery URL cleanup.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

## PERCENTAGE

- LONG_HORIZON_DEALS repository implementation: 100% on PR #24, pending fresh GitHub CI and merge.
- Agent workflow repository implementation: 100% merged; owner-machine setup/doctor can be rechecked separately.
- Real-money readiness is not claimed until provider sandbox semantics are proven.

## NEXT STEP

1. Run fresh required GitHub CI on PR #24 after the logging-hygiene correction.
2. Inspect and fix only evidence-backed integration defects if any remain.
3. Merge PR #24 when green.
4. Prove the selected payment provider's token/reauthorization semantics in sandbox before enabling any real-money path.

## AGENT MILESTONES

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone

- UPDATED: 2026-09-16
- BRANCH: `import/long-horizon-2026-09-16`
- COMPLETED: LONG_HORIZON_DEALS transferred from Claude commit `6c5aacb61492b06c63ff8846fbf5ae0345e6c625` onto current master; 7-day cap removed; renewable authorization architecture and migration 069 included; initial PR logging-hygiene defect corrected.
- TESTED: source evidence 10/10 renewal lifecycle, 5/5 deadline policy, 4/4 worker scheduling, grouped full suite green; transfer SHA-256 verified exactly; first PR preflight isolated one logging leak and no other static hard failure before that point.
- OPEN: fresh GitHub PR CI and merge; provider sandbox proof for Grow/Stripe reauthorization before real money.
- PERCENTAGE: repository implementation 100% on PR #24; real money remains 0.
- NEXT STEP: qualify PR #24 and merge when green; then prove provider semantics in sandbox.
<!-- AGENT_STATUS:claude:END -->

Agent slots are intentionally independent. Each coding agent may replace only its own marked block.

<!-- AGENT_STATUS:codex:START -->
### Codex latest milestone

- UPDATED: not yet written by v3 workflow
- BRANCH: none
- COMPLETED: none
- TESTED: none
- OPEN: none
- PERCENTAGE: not set
- NEXT STEP: use this slot only from Codex finish
<!-- AGENT_STATUS:codex:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is 8% of the full collected amount including delivery and other applicable charges, excluding VAT.
- No distributor commission or distributor payout rail.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, PROJECT_STATUS update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.
