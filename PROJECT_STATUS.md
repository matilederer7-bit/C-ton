# SITON PROJECT STATUS

Updated: 2026-09-17
Canonical branch: `master`
Current merged baseline: `18ba51985f71ebf83563216ec22f88aaa7c023f0`

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
- Render staging auto-deployed PR #34 and reported deploy `dep-dalqc695efls73bnm0v0` LIVE.
- Legacy PRs #2, #4 and #5 were closed as archival/superseded paths rather than active merge candidates.
- Shelf-integration work started: Cloud Agent Manager v1 has been ported onto current master on `chatgpt/integrate-cloud-agent-manager-20260917` without carrying stale product-policy text.

### TESTED / CHECKED

- PR #34 head passed Backend and deployment quality gates, Release readiness, and Web runtime depth gates before merge.
- Render confirmed the exact merge SHA `18ba51985f71ebf83563216ec22f88aaa7c023f0` as LIVE.
- Open shelf was inventoried across open PRs and divergent branches; branches already fully behind master are not treated as active backlog.
- Cloud Agent Manager source blobs are preserved from the previously reviewed PR #25 implementation; current-master integration receives fresh CI before merge.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

### OPEN MERGE QUEUE

1. Cloud Agent Manager current-master integration: fresh CI, merge, then one-time credential activation and harmless cloud smoke task.
2. PR #24 LONG_HORIZON_DEALS: re-integrate on current master, renumber its conflicting migration 069 now that CMS migration 069 is merged, resolve overlapping runtime files, run fresh CI, then merge.
3. PR #7 launch integration: do not merge stale branch wholesale. Extract only still-missing communications/runtime value onto current master and close the obsolete PR.
4. Divergent shelf branches requiring reconciliation rather than blind cherry-pick: authenticated UI acceptance harness, pre-financial resilience, CI request-id flake repair, closed-pilot war game, mobile release readiness, Amazon/product-catalog work, and visual C-ton rebrand.
5. Older planning-only branches may be archived after confirming no unique executable value remains.
6. Hosted/runtime readiness remains open for external payment-provider semantics, hosted OTP secret, production image pruning, architecture decision, and remaining legacy recovery/runtime cleanup.

### PERCENTAGE

- Agent workflow v5: 100% merged repository-side.
- CMS/product-copy integration: 100% merged and live on staging.
- Shelf cleanup and integration: in progress; the active queue is now explicit and being reduced item by item.
- Cloud Agent Manager repository integration: 95% pending fresh current-master CI and merge; activation credentials and smoke proof remain afterward.
- Long-horizon runtime integration: not complete on `master`.
- Real-money readiness: intentionally blocked.

### NEXT STEP

1. Finish Cloud Agent Manager current-master PR through fresh CI and merge.
2. Rebuild PR #24 on the resulting master, renumber migration 069, resolve overlaps, and qualify it through CI.
3. Extract still-unique communications work from PR #7 and close the stale integration path.
4. Reconcile remaining divergent shelf branches in risk/value order, merging only unique current-compatible changes.
5. Keep every accepted item moving through PR, green CI, master, Render staging where applicable, and smoke evidence; archive rejected/superseded items explicitly.

## PRODUCT POLICY ALIGNMENT

The binding policy source is `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`.

Current invariants:

- Every publishable deal has a finite mandatory `max_units`. Unlimited or `NULL` capacity is non-canonical.
- Completion Window is exactly 24 hours and exists only for failed-charge recovery by eligible participants.
- Siton fee is fixed at 8% of all purchase money actually collected through Siton, including shipping/delivery and other applicable purchase charges, excluding the customer VAT component.
- There is no per-deal fee override.
- There is no distributor/affiliate user role or distributor product module. Ordinary sharing and role-neutral attribution measurement remain allowed without distributor identity, permissions, economics, or payout rights.
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
- BRANCH: `chatgpt/integrate-cloud-agent-manager-20260917`
- COMPLETED: shelf inventory completed; PR #34 merged and confirmed live; archival PRs #2/#4/#5 closed; Cloud Agent Manager ported onto current master with current product invariants preserved.
- TESTED: source Cloud Agent Manager implementation retained its reviewed files; fresh GitHub CI on the new current-master integration branch is the merge authority.
- OPEN: fresh CI and merge for Cloud Agent Manager; PR #24, PR #7 extraction, and remaining divergent shelf branches follow.
- PERCENTAGE: shelf cleanup in progress; Cloud Agent Manager integration 95% pending CI/merge.
- NEXT STEP: open current-master Cloud Agent Manager PR, require all repository gates green, merge, then continue immediately to PR #24.
<!-- AGENT_STATUS:codex:END -->

<!-- AGENT_STATUS:cloud-manager:START -->
### Cloud Agent Manager latest milestone

- UPDATED: 2026-09-17
- BRANCH: `chatgpt/integrate-cloud-agent-manager-20260917`
- BUILDER: manager infrastructure ported from PR #25
- REVIEWER: fresh repository CI pending
- COMPLETED: GitHub-hosted orchestration, serialized writer queue, provider selection, task packets, builder lifecycle/control-plane guards, bounded review/fix cycle, canonical verification, dedicated autonomous Git lifecycle token, isolated status ownership and PR creation are present on the current-master integration branch.
- TESTED: original PR #25 implementation carried dedicated contract coverage; current-master integration requires fresh CI before merge.
- OPEN: fresh CI, merge, one-time `SITON_AGENT_GITHUB_TOKEN` plus coding-agent credential activation, and harmless computer-off smoke proof.
- PERCENTAGE: 95%
- NEXT STEP: pass current-master CI, merge, configure minimal credentials, then execute a harmless cloud smoke task.
<!-- AGENT_STATUS:cloud-manager:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is fixed at 8% of the full collected purchase amount including delivery and other applicable purchase charges, excluding the customer VAT component.
- No per-deal commission-rate override.
- Every publishable deal has a finite mandatory `max_units`; no unlimited or `NULL` capacity.
- Completion Window is fixed at exactly 24 hours and only serves failed-charge recovery for `ChargeFailedCompletion` participants.
- No distributor/affiliate user role, commission, balance, payout rail, or separate distributor product module. Ordinary role-neutral sharing/attribution remains allowed.
- No fixed seven-day maximum deal duration.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, security, and 90% success rules remain safety boundaries.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, `PROJECT_STATUS.md` update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.
