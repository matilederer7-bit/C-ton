# SITON PROJECT STATUS

Updated: 2026-09-17
Canonical branch: `master`
Current merged baseline: `1d38656950381733cbf2459913be7439038b4ccf`

## CURRENT SNAPSHOT

### COMPLETED

- PR #19 merged: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #22 merged: affiliate visit acknowledgement is emitted only after the recording transaction commits.
- PR #23 merged: isolated Claude/Codex status slots and agent-efficiency v3.
- PR #26 merged: canonical product policy amendment covering finite `max_units`, fixed 24-hour Completion Window, fixed 8% Siton fee, no distributor product role, and no seven-day deal cap.
- PR #27 merged: Claude repository entry point and no-loop Git authorization fallback.
- PR #31 merged: fail-closed distributor attribution-only financial regression guard.
- PR #33 merged: agent workflow v5 refresh with repeated-task branch allocation, focused packets, and start-time push/SHA checkpoint.
- PR #34 merged at `18ba51985f71ebf83563216ec22f88aaa7c023f0`: block-based Site CMS and editable product copy across deal, tracking, seller and support surfaces.
- Render staging confirmed PR #34 deployment `dep-dalqc695efls73bnm0v0` LIVE.
- PR #35 merged at `1d38656950381733cbf2459913be7439038b4ccf`: Cloud Agent Manager reintegrated onto the current product baseline without changing product runtime, database, payments or Grow.
- Legacy PRs #2, #4 and #5 were closed as archival/superseded paths rather than active merge candidates.
- Seller Distribution Hub from stale PR #36 was rebuilt cleanly on current master as PR #37 instead of merging a conflicted branch.

### TESTED / CHECKED

- PR #34 passed Backend and deployment quality gates, Release readiness, and Web runtime depth gates before merge and its exact merge SHA was confirmed LIVE on Render.
- PR #37 is mergeable on current master. Its first fresh run exposed one stale release-tools fixture: the route scanner now reads `src/distribution_hub.ts` but the fixture did not copy that file.
- The fixture was corrected in commit `13742469ab0d51db8fff8abb0b113a0734942f30`; the authorization mechanism itself was not weakened or bypassed.
- The real route inventory reported 226 routes, zero unclassified routes and zero unclassified sensitive routes before the fixture correction.
- Fresh repository CI after the fixture correction remains the merge authority for PR #37.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

### OPEN MERGE QUEUE

1. PR #37 Seller Distribution Hub: finish fresh CI, merge, confirm staging, then close stale PR #36 as superseded.
2. PR #24 LONG_HORIZON_DEALS: re-integrate on the resulting master using migration 071, resolve only current overlaps, run fresh CI, then merge.
3. PR #7 launch integration: do not merge stale branch wholesale. Extract only still-missing communications/runtime value onto current master and close the obsolete PR.
4. Reconcile remaining divergent shelf branches in risk/value order: authenticated UI acceptance harness, pre-financial resilience, CI request-id flake repair, closed-pilot war game, Amazon/product-catalog work, mobile release readiness, and visual C-ton rebrand.
5. Archive older planning-only or fully superseded branches after confirming they contain no unique executable value.
6. Hosted/runtime readiness remains open for external payment-provider semantics, hosted OTP secret, production image pruning, architecture decision, and remaining legacy recovery/runtime cleanup.

### PERCENTAGE

- Agent workflow v5: 100% merged repository-side.
- CMS/product-copy integration: 100% merged and confirmed live on staging.
- Cloud Agent Manager repository integration: 100% merged; credential activation and harmless computer-off smoke proof remain operational follow-up.
- Seller Distribution Hub: 95% pending corrected fresh CI, merge and staging smoke.
- Shelf cleanup and integration: in progress; active divergent work is being reduced item by item rather than left on stale branches.
- Long-horizon runtime integration: not complete on `master`.
- Real-money readiness: intentionally blocked.

### NEXT STEP

1. Require all PR #37 repository gates green and merge it.
2. Confirm the resulting master deployment on Render and perform a lightweight distribution-hub smoke check.
3. Close PR #36 as superseded.
4. Rebuild PR #24 on that master as migration 071 and qualify it through fresh CI.
5. Continue immediately through communications, product catalog, mobile, rebrand and remaining hardening/test shelf work.

## PRODUCT POLICY ALIGNMENT

The binding policy source is `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`.

Current invariants:

- Every publishable deal has a finite mandatory `max_units`. Unlimited or `NULL` capacity is non-canonical.
- Completion Window is exactly 24 hours and exists only for failed-charge recovery by eligible participants.
- Siton fee is fixed at 8% of all purchase money actually collected through Siton, including shipping/delivery and other applicable purchase charges, excluding the customer VAT component.
- There is no per-deal fee override.
- There is no distributor/affiliate user role or distributor product module. A seller may create attribution/measurement links and may grant an external viewer scoped read-only access to one link's aggregate dashboard. That viewer receives no buyer PII, seller navigation, Siton-managed commission, balance or payout rights.
- There is no fixed seven-day maximum deal duration. Older seven-day product-deadline references are historical.
- Current legal material remains unchanged unless the owner explicitly changes it.

## AGENT MILESTONES

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone

- UPDATED: not yet written by current workflow
- BRANCH: none
- COMPLETED: none
- TESTED: none
- OPEN: none
- PERCENTAGE: not set
- NEXT STEP: use this slot only from Claude Code finish
<!-- AGENT_STATUS:claude:END -->

Agent slots are intentionally independent. Each coding agent may replace only its own marked block.

<!-- AGENT_STATUS:codex:START -->
### Codex latest milestone

- UPDATED: 2026-09-17
- BRANCH: `chatgpt/integrate-distribution-hub-20260917`
- COMPLETED: PR #35 merged; stale PR #36 was rebuilt as clean current-master PR #37; the release-tools fixture was updated to include the new distribution route source.
- TESTED: PR #37 is mergeable; real route inventory has zero unclassified routes and zero unclassified sensitive routes; fresh CI is running after the focused fixture fix.
- OPEN: all PR #37 gates green, merge, Render smoke, close #36, then PR #24 long-horizon reintegration as migration 071.
- PERCENTAGE: Seller Distribution Hub 95% pending CI/merge/staging smoke.
- NEXT STEP: merge PR #37 only after all repository gates are green, then continue directly to long-horizon integration.
<!-- AGENT_STATUS:codex:END -->

<!-- AGENT_STATUS:cloud-manager:START -->
### Cloud Agent Manager latest milestone

- UPDATED: 2026-09-17
- BRANCH: `master`
- BUILDER: manager infrastructure from PR #35
- REVIEWER: repository integration completed
- COMPLETED: GitHub-hosted orchestration, serialized writer queue, provider selection, task packets, builder lifecycle/control-plane guards, bounded review/fix cycle, canonical verification, dedicated autonomous Git lifecycle token path, isolated status ownership and PR creation are merged on master.
- TESTED: repository integration completed through PR #35; no product runtime, database, payment or Grow behavior was changed by that merge.
- OPEN: configure the required minimal credentials and execute one harmless computer-off smoke task.
- PERCENTAGE: 100% repository-side; operational activation pending.
- NEXT STEP: perform credential activation and harmless cloud smoke without enabling real money or Grow.
<!-- AGENT_STATUS:cloud-manager:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is fixed at 8% of the full collected purchase amount including delivery and other applicable purchase charges, excluding the customer VAT component.
- No per-deal commission-rate override.
- Every publishable deal has a finite mandatory `max_units`; no unlimited or `NULL` capacity.
- Completion Window is fixed at exactly 24 hours and only serves failed-charge recovery for `ChargeFailedCompletion` participants.
- No distributor/affiliate product role, commission, balance, payout rail, or separate distributor product module. Seller-created attribution links and a scoped read-only aggregate dashboard for an external link viewer are allowed without exposing buyer PII or creating platform economics.
- No fixed seven-day maximum deal duration.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, security, and 90% success rules remain safety boundaries.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, `PROJECT_STATUS.md` update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.
