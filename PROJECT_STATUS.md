# SITON PROJECT STATUS

Updated: 2026-09-17
Canonical branch: `master`
Current merged baseline: `1907e7fb1974e3cd0c3fcd4c26c0de19ed7f600c`

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
- PR #35 merged at `1d38656950381733cbf2459913be7439038b4ccf`: Cloud Agent Manager reintegrated onto the current product baseline.
- PR #37 Seller Distribution Hub merged at `8bdd401aecef973dbeb65b405bf3e0ffe86a96be` with seller-created attribution links and optional scoped read-only external link dashboards, aggregate analytics only, no buyer PII and no distributor economics.
- Staging deployment failure after PR #37 was diagnosed as missing database migration 070. `070_seller_distribution_links.sql` was applied to Supabase staging; all four required external-viewer tables were verified; Render redeploy `dep-dalsa98ae00c73cf9tbg` reached LIVE on `8bdd401...`.
- Hosted CMS failure `column "draft_jsonb" does not exist` was diagnosed as missing CMS migration 069. `069_site_content_drafts_media.sql` was applied to Supabase staging and the draft/publish columns were verified readable.
- Hosted UX reality audit produced Issue #39 for terminal-deal archive, mature UI cleanup, multi-method receipt/redemption, preview-stage removal and support/deal-context unification.
- LONG_HORIZON_DEALS was promoted to the next blocking integration. Issue #40 is the clean current-master Claude execution packet; old PR #24 is source/provenance only.
- PR #38 integration order was updated: long-horizon owns migration 071; Product Catalog must move to 072 during later current-master reintegration.
- PR #42 merged at `72651b2da2152368b43eb39eabc805257b668f90`: LONG_HORIZON_DEALS rebuilt on current master as migration `071_long_horizon_authorization_renewal.sql`, CMS keeping 069 and the Seller Distribution Hub keeping 070. Old PR #24 was provenance only and is now CLOSED as superseded (verified equivalent apart from the 069->071 renumbering).
- Migration 071 was applied to Supabase staging. The staging ledger, which previously stopped at 068 because 069/070 had been applied as raw SQL without ledger rows, is now in full agreement with the repository manifest: 069/070/071 recorded at positions 62/63/64.
- Canonical documents that still described the seven-day cap as pending were reconciled: the foundation source of truth, the product-policy amendment and the code-cleanup task record it as DONE; the historical spec quote in the already-closed drift map is explicitly marked DEPRECATED rather than rewritten.

### TESTED / CHECKED

- PR #37 repository CI was green before merge; its distribution routes reported zero unclassified routes and zero unclassified sensitive routes after the release-tools fixture correction.
- Supabase staging now contains `distribution_link_viewers`, `distribution_link_viewer_grants`, `distribution_link_viewer_sessions`, and `distribution_link_viewer_login_attempts` from migration 070.
- Render staging is LIVE on PR #37 merge SHA `8bdd401aecef973dbeb65b405bf3e0ffe86a96be` after the migration repair.
- Supabase staging `site_content` now contains `draft_jsonb`, `draft_updated_at`, `draft_updated_by`, and `published_at`; a direct read using the new CMS schema succeeds.
- The obsolete seven-day maximum was REMOVED from active seller code by PR #42 (merged `72651b2`): picker, hint, validator, Hebrew error copy, backend validator and legacy `frontend/app.js` all carry no seven-day restriction. A scan of 87 shipped built assets finds no seven-day copy.
- Current seller dashboard still renders terminal deals as full cards instead of a compact archive; current product UI still contains decorative emoji/glyph residues; public support contact still lacks canonical deal/seller context; receipt/redemption remains single-method.
- Old PR #24 source evidence remains: deadline policy 5/5, authorization renewal lifecycle 10/10, worker long-horizon scheduling 4/4. Fresh current-master CI on the replacement PR is authoritative.
- PR #42 CI was green on all six jobs on head `57d6637` (backend-gates, preflight-static, preflight-database, web-runtime-core, web-runtime-resilience, docker-release-lab). The canonical verifier passed release-static, migrations-isolated and route-authorization, with the grouped repository suite at 243/243 test files.
- Staging verification after applying 071: migration high-water `071`, ledger 64 rows all `succeeded`, positions contiguous 1..64 with zero gaps, and a full id/position/filename/checksum comparison against `scripts/migration_manifest.cjs` reporting DRIFT=0. Schema shows 79 tables, all five new binding columns, the `reauthorize` attempt-type constraint, the renewal-shape constraint, the renewal-candidate index and the eligibility trigger.
- Staging Render web is LIVE on the merge SHA (`dep-dalum9vqj5pc73ebfl20`, auto-deployed on commit) and answered `/readiness` with HTTP 200 after migration 071 was applied.
- 30/60/90-day smoke on the merged master build through the real HTTP API: Draft create, deadline persisted exactly, publish, buyer-facing public re-read exact, and all three deals discoverable in the Mall listing. An ordinary 24-hour deal still creates and publishes. Under two hours is still rejected (`deadline_below_minimum`); beyond the technical ceiling is still rejected (`deadline_above_maximum`). 10/10 PASS.
- The same 30/60/90-day and short-deal shapes were exercised against the STAGING database itself inside a rolled-back transaction: all four accepted and stored to the exact instant, with nothing persisted.
- REAL MONEY remains 0. Grow remains untouched and unactivated. The smoke created no payment attempt, no reauthorization, no authorization binding, no platform-fee money event and no notification attempt.

### OPEN MERGE / EXECUTION QUEUE

1. ~~Issue #40 — LONG_HORIZON_DEALS on current `master` with migration 071~~ **CLOSED 2026-09-17:** merged as PR #42 (`72651b2`), migration 071 applied to staging, Render staging LIVE on the merge SHA, 30/60/90-day smoke green, PR #24 closed as superseded.
3. Issue #39 — Claude UX/support lane starts only from the then-current master: terminal-deal archive, remove childish decorative glyphs, multiple receipt/redemption methods, remove standalone preview journey step, unify support with deal/seller context and PII-safe visibility.
4. PR #38 — clean reintegration only after the above; Product Catalog migration becomes 072. Preserve useful product catalog/mobile/native-brand/acceptance-harness work without blind-merging the stale branch.
5. PR #7 communications — extract only still-missing communications/runtime value on current master; do not merge stale branch wholesale.
6. Continue reducing the remaining shelf through current-master PRs, fresh CI, staging deploy and smoke evidence.

### PERCENTAGE

- Agent workflow v5: 100% merged repository-side.
- CMS/product-copy repository integration: 100%; missing staging migration repaired and schema verified. Authenticated CMS browser smoke remains a runtime follow-up.
- Cloud Agent Manager repository integration: 100%; credential activation and harmless computer-off smoke remain operational follow-up.
- Seller Distribution Hub: 100% merged and deployed to staging; authenticated seller end-to-end link-creation smoke remains to be performed.
- Long-horizon current-master integration: 100%. Merged to master (`72651b2`), migration 071 applied to staging with DRIFT=0, staging deployed and smoked at 30/60/90 days. Remaining long-horizon work is outside this track: Grow real-provider stored-instrument re-authorization is an external sandbox gap, not a repository task.
- Hosted UX reality closeout: scoped and queued as Issue #39; implementation not yet merged.
- PR #38 shelf-closeout integration: pending after long-horizon / UX sequencing.
- Real-money readiness: intentionally blocked.

### NEXT STEP

1. Execute Issue #39 from current master (`72651b2` plus the closeout commit) and drive it through the same CI → master → staging → smoke chain: terminal-deal archive, remove decorative glyph residue, multiple receipt/redemption methods, remove the standalone preview journey step, unify support with deal/seller context and PII-safe visibility.
2. Optionally re-run an authenticated seller browser smoke against hosted staging from an environment whose egress policy permits `*.onrender.com`; this session's container is denied CONNECT to that host, so the 30/60/90 smoke was proven against the merged build and directly against the staging database instead.
4. Reintegrate PR #38 with Product Catalog at migration 072.
5. Do not mark product work complete merely because code exists in a branch or PR; completion requires current master plus applicable staging migration/deployment and smoke evidence.

## PRODUCT POLICY ALIGNMENT

The binding policy source is `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`.

Current invariants:

- Every publishable deal has a finite mandatory `max_units`. Unlimited or `NULL` capacity is non-canonical.
- Completion Window is exactly 24 hours and exists only for failed-charge recovery by eligible participants.
- Siton fee is fixed at 8% of all purchase money actually collected through Siton, including shipping/delivery and other applicable purchase charges, excluding the customer VAT component.
- There is no per-deal fee override.
- There is no distributor/affiliate user role or distributor product module. A seller may create attribution/measurement links and may grant an external viewer scoped read-only access to one link's aggregate dashboard. That viewer receives no buyer PII, seller navigation, Siton-managed commission, balance or payout rights.
- There is no fixed seven-day maximum deal duration. Older seven-day product-deadline references are historical and active code that still enforces them is a defect to remove.
- Current legal material remains unchanged unless the owner explicitly changes it.

## AGENT MILESTONES

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone

- UPDATED: 2026-09-17
- BRANCH: `claude/happy-mccarthy-qv1j9d` (repository-wide seven-day sweep) on merged master `1907e7fb1974e3cd0c3fcd4c26c0de19ed7f600c`; closeout branch `claude/long-horizon-closeout-20260917` merged as PR #43
- COMPLETED: The LONG_HORIZON_DEALS lane is CLOSED END TO END. PR #43 merged to `master` and is verified present on `origin/master` (`6987ce6` is an ancestor of `1907e7fb1974e3cd0c3fcd4c26c0de19ed7f600c`), carrying the migration-071 staging proof, the canonical-document reconciliation and the permanent `tests/long_horizon_staging_smoke_validation.ts` regression suite. A repository-wide sweep for the obsolete "maximum 7 days" product rule then ran across EVERY surface: source, web, tests, fixtures, seed scripts, all 64 migrations, docs, CI config, and the four original owner `.docx` foundation documents (which grep cannot read and which no earlier pass had covered). Result: NO active product rule enforcing a seven-day deal cap exists anywhere in code. `src/deadline_policy.ts` is the single server-side source of truth (2-hour product minimum, 20-year technical sanity ceiling, advisory-only notice above one year); `web/src/deadlinePolicy.ts` mirrors it and a test pins both together; `DEADLINE_MAX_MS` exists nowhere in the repository; no migration installs a deadline-cap CHECK or trigger; fixtures and seed scripts contain no cap. Two MISLEADING-BUT-UNMARKED artefacts were found and MARKED rather than rewritten, per the rule that historical text is preserved:
  1. `docs/foundation-canonical-2026-04-18/` — the owner's original constitution (§3.3 “כללים עסקיים מחייבים: דדליין מקסימום 7 ימים”), full product spec (“דדליין לעיסקה לא יעלה על 7 ימים ממועד הפרסום”, “מקסימום עד שבעה ימים קלנדריים”) and UX document (“שלב 4 – תנאים: דדליין עד 7 ימים”) still stated the cap as a BINDING business rule, with no supersession marker anywhere in that directory. A new `README.md` there marks the rule OBSOLETE/HISTORICAL, quotes each obsolete passage per document, states the current rule, and points to the canonical amendment, the architecture doc, `src/deadline_policy.ts`, migration 071 and the two regression suites. It also lists the unrelated seven-day values that must NOT be “fixed”: Grow's documented J5 hold validity, admin authorization-age alert thresholds, Freeze-Payouts approval validity, the Low-priority support SLA, and the `7d` analytics windows. The `.docx` files themselves are byte-untouched.
  2. `docs/SENIOR_ADVERSARIAL_REVIEW.md` §LONG_HORIZON_DEALS asserted in the PRESENT TENSE that “the runtime 7-day limitation is NOT solved. It is *enforced* (`src/app.ts:133` `DEADLINE_MAX_MS = 7 * 24 * 60 * 60 * 1000`)”, with its RESOLUTION NOTE seven lines below — far enough that a grep hit would not see it. The subsection heading is now prefixed `[OBSOLETE — HISTORICAL]` with an explicit banner directly above the bullets; the bullets are preserved verbatim.
  `docs/SPEC_DRIFT_MAP_2026-04-19.md` was already correctly headed `[CLOSED — HISTORICAL]` with its spec quote marked DEPRECATED, and was deliberately left alone.
- TESTED: PR #43 CI green on all six jobs on head `6987ce6` (backend-gates, preflight-static, preflight-database, web-runtime-core, web-runtime-resilience, docker-release-lab). Re-verified ON MASTER `1907e7fb1974e3cd0c3fcd4c26c0de19ed7f600c` AFTER the merge against a disposable local PostgreSQL 16.13, seeded exactly as CI does via `scripts/seed_test_prerequisites.cjs` with `PAYMENT_PROVIDER=mockpay`: all 64 migrations apply clean from empty (`MIGRATIONS_COMPLETE count=64`); `tests/long_horizon_deadline_policy_validation.ts` **5/5 PASS**; `tests/long_horizon_staging_smoke_validation.ts` **10/10 PASS** with evidence `days=30/60/90 state=PendingTarget`, deadlines persisted to the exact instant, `SMOKE_LISTING total=3 long_horizon=3`, the ordinary 24-hour deal unaffected, both rejection boundaries holding, the built bundle carrying no seven-day copy, and `SMOKE_SAFETY real_money=0 reauthorize=0 bindings=0 fee_events=0`. Local gate set PASS on the master head and on this sweep branch: `tsc --noEmit` clean plus `lint`, `scan:payment`, `scan:backend`, `scan:secrets`, `gate:architecture`, `gate:real-money`, `gate:logging-hygiene`, `migrations:preflight`; `gate:real-money` reports `REAL_MONEY: BLOCKED` with `NO_REAL_MONEY_PROOF_SUMMARY overall=PASS pass=16 fail=0`. The sweep classified every one of the 124 raw matches: zero active product rules; the remainder are Grow J5 provider facts (already annotated in code as provider facts, not Siton rules), SQL analytics windows, support SLA thresholds, `7d` UI range selectors, `now()+interval '7 days'` fixture deadline VALUES (a value, never a cap), commit SHAs that happen to contain `7d`, and correctly-marked historical documents.
- OPEN: The canonical verifier `scripts/siton_verify.cjs` was NOT run end to end in this session; the focused long-horizon suites, the clean-from-empty 64-migration run and the full local gate set were run instead against the disposable local PostgreSQL, and CI's `preflight-database` and `backend-gates` jobs (green, real PostgreSQL service, `test:all` complete repository suite) remain the authority for that layer. An authenticated seller BROWSER smoke against hosted staging is still unrun: this container's egress policy answers 403 to CONNECT for `siton-staging-web.onrender.com:443`, so the 30/60/90-day proof stands on the real HTTP API against the merged build plus a rolled-back transaction against the staging database. Grow real-provider stored-instrument re-authorization remains an unproven external sandbox gap by design. Issue #39 is untouched and is the next lane. PR #38 Product Catalog still needs migration 072 on reintegration.
- PERCENTAGE: LONG_HORIZON_DEALS 100% — merged, staged, smoked, documented and swept. No contradiction remains between the constitution, product spec, UX, DB docs, migrations, tests, code comments, fixtures, seed data and this file: the only surviving seven-day deal-duration statements are the owner's original `.docx` sources and the adversarial review, both now explicitly marked OBSOLETE/HISTORICAL. Long-horizon track 100% for repository and staging scope; production remains intentionally out of scope.
- NEXT STEP: execute Issue #39 from current master and drive it through the same CI → master → staging → smoke chain; reintegrate PR #38 afterwards at migration 072.
<!-- AGENT_STATUS:claude:END -->

Agent slots are intentionally independent. Each coding agent may replace only its own marked block.

<!-- AGENT_STATUS:codex:START -->
### Codex latest milestone

- UPDATED: 2026-09-17
- BRANCH: `master`
- COMPLETED: PR #37 Seller Distribution Hub merged; missing migration 070 was applied to staging; Render redeploy reached LIVE; missing CMS migration 069 was applied and verified; hosted UX/runtime gaps were converted into Issues #39/#40 with collision-safe sequencing.
- TESTED: distribution schema exists; Render is LIVE on `8bdd401...`; CMS draft schema reads successfully; the previously confirmed active seven-day seller restriction was resolved and merged in PR #42 (`72651b2`).
- OPEN: Claude Issue #40 replacement PR, then merge/migration071/deploy/smoke; Issue #39 follows; PR #38 after that with Product Catalog migration 072.
- PERCENTAGE: Distribution Hub merged/deployed 100%; long-horizon current-master integration pending.
- NEXT STEP: integrate Issue #40 output through fresh CI and staging before accepting any later overlapping UX/shelf branch.
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
