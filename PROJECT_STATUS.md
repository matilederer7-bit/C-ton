# SITON PROJECT STATUS

Updated: 2026-09-16
Canonical branch: `master`
Current merged baseline: `8b9945f2c83a9380c78d9fd75d7d36c944f3cf40`

## COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #18 closed as superseded by PR #19.
- Agent efficiency v2 is merged to `master` at `294399e32bbcd090761eb9e7774e64ef89d3eca3`.
- PR #22 merged to `master` at `8b9945f2c83a9380c78d9fd75d7d36c944f3cf40`: affiliate visit acknowledgement is emitted only after the recording transaction commits, with deterministic regression coverage.
- PR #21 was closed without merge as the stale-base predecessor superseded by PR #22.
- Agent workflow includes isolated permanent Claude and Codex worktrees, one-command setup and doctor, fail-closed branch collision checks, untracked task packets, automated verification/commit/push/PR creation, compact CI failure summaries and no auto-merge.
- Agent efficiency v3 hardening is implemented on `chore/agent-efficiency-v3-status-isolation`:
  - Claude and Codex update separate fixed status slots inside this file instead of appending into the same EOF region.
  - `finish` keeps the worktree on the active task branch while the PR remains open so CI fixes continue with the same context.
  - the next `start` automatically releases only a clean prior task whose PR is already merged or closed.
  - an open prior PR blocks task replacement instead of silently discarding context.
  - PR backend CI runs the ten explicit test groups once; the aggregate `test:all` re-run is retained only on push to `master`, eliminating a proven duplicate pass on every PR without reducing PR test inventory.

## TESTED

- PR #22 passed Backend and deployment quality gates, Web runtime depth gates and Release readiness before merge, including the complete repository suite and extended Docker smoke.
- Agent efficiency v2/v3 contract tests are under `tests/release_tools/agent_efficiency_v2.test.cjs` and are part of the standard/full release-preflight catalogue.
- The v3 contract requires isolated Claude/Codex status markers, retained task branches while PRs are open, automatic release only after PR resolution and preservation of all ten explicit PR test groups while `test:all` is push-only.
- PR #23 was refreshed onto merged master after PR #22. Fresh GitHub CI on the resulting combined head remains the merge authority.

## OPEN

- PR #23 requires fresh green GitHub CI after its master refresh and CI de-duplication change before merge.
- Owner-machine worktrees should be rechecked with `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` after v3 merges.
- The deterministic task-branch slug can still collide when the exact same task text is reused after a historical branch remains locally or remotely. This is a workflow follow-up, not a v3 merge blocker.
- Task packets currently use the compact top-of-file status excerpt; later refinement can include the active agent's isolated status slot directly.
- Runtime/production items intentionally remain open: O-1 Render worker/Blueprint live sync, O-2 hosted `OTP_HASH_SALT`, F13 external provider semantics, LONG_HORIZON_DEALS dependent on F13, F-12 production image pruning, F-07 architecture decision, and legacy `/app/...` recovery URL cleanup.
- Site CMS (template editor, drafts/preview/publish, FAQ + hero video persistence) is implemented on `claude/admin-cms-template-editor-x9mava`; staging needs migration 069 before deploy. See the Claude milestone slot and docs/SITE_CMS.md.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

## PERCENTAGE

- Agent workflow repository-side implementation: 98% pending fresh PR #23 CI and merge.
- Agent workflow owner-machine activation: not re-verified by this repository-only change.
- Product/real-money readiness percentages are intentionally not recomputed by this workflow-only change.

## NEXT STEP

1. Complete fresh GitHub CI on PR #23 and inspect only evidence-backed failures.
2. Merge PR #23 when all required workflows are green.
3. Re-run `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor` once on the owner machine.
4. Harden repeated-task branch naming and improve task-packet status targeting in the next workflow-only change.
5. Evaluate further path-sensitive CI optimization only with explicit protection against skipped required checks.

## AGENT MILESTONES

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone

- UPDATED: 2026-09-16
- BRANCH: `claude/admin-cms-template-editor-x9mava` (baseline `39d9569fc3041bf0374e867a8902cea9ea8b5dd5` = merged master after PR #23)
- TASK: Siton admin CMS → template-driven site editor (docs/SITE_CMS.md)
- COMPLETED:
  - Audit of the existing CMS (site_content / content_assets, `src/site_content.ts`, admin + public content API, ContentAdmin, landing, About, footer, legal pages, FAQ + hero-medium resolvers, tests) recorded in `docs/SITE_CMS.md`.
  - ONE shared template library `web/src/content/cmsTemplates.ts` (hero, text, image_text, cta, steps, faq, columns, about, legal, footer; page contracts for home / about / footer / legal_*; strict `validatePage`, lenient `normalizePage`, legacy flat → blocks conversion, flat legacy projection) used by the backend validator, the admin editor and the public renderers.
  - Persistence: migration `069_site_content_drafts_media.sql` (additive: `draft_jsonb`, `draft_updated_at/by`, `published_at`; `content_assets` MIME check widened to video/mp4 + video/webm). `value_jsonb` stays the published page; existing flat rows remain readable and migrate deterministically.
  - API: `GET /api/site-content` (published, enabled blocks + legacy flat fields), `GET /api/admin/site-content` (published + draft + contract + revision), `PUT …/:key/draft`, `POST …/:key/publish` (re-validates the stored draft), `POST …/:key/discard`, `GET /api/admin/site-content/preview` (named admin only), legacy `PUT …/:key` kept; admin video upload (bounded, signature-checked) and byte-range playback on `/api/content-assets/:id`.
  - Admin UI `#/admin/content` (ניהול תוכן האתר): page chips (דף הבית / אודות / תחתית האתר / legal pages), block editor cards generated from the schema, enable/disable, up/down reordering, add block from the allowed template library, remove optional blocks, repeatable items (FAQ questions, steps, columns, footer links) with add/delete/reorder, image and video upload with preview, שמור טיוטה / תצוגה מקדימה / פרסם באתר / ביטול הטיוטה, 409 conflict surfaced (no silent overwrite).
  - Public: landing renders the published `home` blocks in order with LANDING_HE fallback; FAQ, how-it-works, why, for buyers/sellers, trust, contact CTA and hero (incl. buyer-entry text, CTA labels/links, media choice) are CMS-driven; footer text + links, About and legal documents render from blocks inside the Siton shell; preview mode is a per-tab flag with a visible banner.
- TESTED (all PASS locally on a migrated local Postgres unless stated):
  - `tests/site_content_cms_validation.ts` 17 cases (legacy compatibility, fallback, templates load, text edit, image replace, FAQ add/edit/delete/reorder, block reorder/disable, hero lock, draft vs public, preview, publish, discard, invalid stored draft never publishes, revision conflict, malformed / HTML / script / executable-link / foreign-asset rejection, unauthorized seller/buyer/anonymous, video upload + range, single hero medium).
  - `tests/receipt_content_integration_validation.ts` 13 cases updated to the block shape.
  - `npm run proof:cms` (new browser proof, 62 checks at 320/390/768/1440: block order, hidden block absent, FAQ, hero image, footer links, preview banner/exit/denied, legal doc, editor edit/add/delete/reorder/hide/remove/upload/draft/publish/discard/409/add-from-library, no horizontal overflow).
  - `node scripts/receipt_content_browser_proof.cjs` PASS; `npm run proof:ux-round2` 324/324 PASS (hardened UX intact).
  - `node scripts/site_cms_rehearsal.cjs --local-admin` against a locally running full stack (built web bundle + Fastify + Postgres): 28 checks — draft heading → public unchanged (API + browser) → preview tab shows draft → publish → public changes → original restored; smoke of landing, legal, about, seller login, admin gate, deal, tracking, support without crash or overflow.
  - Targeted regression run (19 files across all 10 groups incl. admin/seller route auth coverage, protected route gate, admin mutation inventory, legal trust, frontend foundation, cache policy, json boundary, deal images, storage readiness): PASS. `tsc --noEmit` (backend) and `tsc -b` + Vite build (web) PASS. `npm run lint`, `scan:runtime-ddl`, `scan:payment`, `web_route_inventory` (0 unguarded), `ci:migrations` on a fresh DB (62 migrations, rerun pass): PASS.
  - Full `npm test` (`test:all`, 235 files, 10 groups) on the committed tree: PASS (groups_passed=10, groups_failed=0). Two e2e browser files need a Chromium at `/usr/bin/google-chrome` (environment prerequisite, satisfied locally).
- OPEN:
  - Staging: migration 069 must be applied through the canonical runner and the branch deployed before the staging rehearsal (`node scripts/site_cms_rehearsal.cjs --base-url=<staging> --admin-cookie=<session>`) can run; this session has no deploy/migration authority (protected action).
  - `GET /api/admin/site-content` still honours the operator `x-admin-key` read path (drafts included); the preview and every mutation require a named admin session.
  - Landing "about" section is now its own home text block (hidden by default); the About page is edited separately — the old implicit "About page text shows on the landing" coupling is gone.
- PERCENTAGE: CMS task 95% (repository work complete and verified locally; staging migration + rehearsal pending deploy).
- NEXT STEP: merge PR → apply migration 069 on staging via `npm run db:migrate` → run `scripts/site_cms_rehearsal.cjs` against staging with an admin session → restore content.
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
