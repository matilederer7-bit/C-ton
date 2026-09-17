# SITON PROJECT STATUS

Updated: 2026-09-17
Canonical branch: `master`
Baseline verified at start of this status refresh: `50e4635eedf7e9de29a98f064aafbbb2f7879235`

## CURRENT SNAPSHOT

### COMPLETED

- PR #19 merged to `master`: adversarial production hardening plus seller-to-buyer product-path closeout.
- PR #22 merged to `master`: affiliate visit acknowledgement is emitted only after the recording transaction commits, with deterministic regression coverage.
- PR #23 merged to `master`: agent efficiency v3 with isolated Claude/Codex status writes, branch retention while PRs remain open, and streamlined aggregate test execution.
- PR #26 merged to `master`: canonical product policy amendment 2026-09-16.
- PR #27 merged to `master` at `7c975d062eecc02faf1c3ab48909b7f05043c7a8`: agent efficiency v4 with root `CLAUDE.md`, no-loop Git authorization fallback, push-checkpoint discipline, and release-tool contract coverage.
- Repository-side agent workflow is therefore merged through v4.
- Site CMS is complete on `claude/siton-admin-cms-templates-s8g2ih` (rebased onto `master` `50e4635`): the template-driven content editor from `claude/admin-cms-template-editor-x9mava` was ADOPTED rather than rebuilt, and extended with the product-copy surfaces the owner's task named (deal page, buyer tracking, seller area, support).

### SITE CMS — CURRENT STATE

Branch `claude/siton-admin-cms-templates-s8g2ih` = current `master` + the adopted template
editor (`8679cb4`, cherry-picked) + the product-copy extension. No competing second CMS was
written: there is ONE content mechanism (`siton.site_content` rows, block pages validated by
`web/src/content/cmsTemplates.ts`) and ONE admin screen (`#/admin/content`).

Editable through templates today:

| Area | Page key | What the admin edits |
|---|---|---|
| Home | `home` | hero (title, subtitle, intro, image/video, CTA labels) plus addable/reorderable/hideable blocks: text, image+text, CTA, steps, FAQ, columns |
| FAQ | `home` (`faq` block) | ordered add / edit / delete / reorder |
| Footer | `footer` | text + ordered links |
| About | `about` | title, body, optional image |
| Legal (7 documents) | `legal_<slug>` | title + body of תקנון / פרטיות / ביטולים והחזרים / תשלומים / מוכרים / שותפים / דמו |
| Deal page + tracking | `deal_page` | the explainer, why the price is lower, what happens on tap, the hold notice, the share headline, the how-it-works steps, the tracking hold note, the return headline, three empty-state titles |
| Seller area | `seller_area` | empty state (title/body/button), guidance headline, pending / rejected account messages, incomplete-profile headline |
| Support | `support_page` | form title + intro, post-submit title + body |

Workflow per page: שמור טיוטה → תצוגה מקדימה → פרסם באתר. Drafts live in `draft_jsonb` and are
never public; publish moves the draft to `value_jsonb` and keeps the previous value; a stale
revision is refused with 409. Product surfaces are LOCKED contracts (no block can be added,
removed, hidden or reordered) so a content edit can never delete a sentence the flow needs.

Deliberately NOT content (system truth): tracking status headline/subline/next steps, prices,
unit counts, deadlines, the pilot mock-money disclosure, the fee and every money state.

### TESTED / CHECKED

- GitHub `master` was verified at `7c975d062eecc02faf1c3ab48909b7f05043c7a8` at the start of this status refresh.
- PR #27 was verified as closed and merged, with merge commit `7c975d062eecc02faf1c3ab48909b7f05043c7a8`.
- `AGENTS.md` already declares the current no-seven-day-cap product invariant and the source-of-truth precedence rules.
- `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md` already records the no-seven-day-cap decision as binding and explicitly marks older seven-day references as historical.
- Current `src/app.ts` still contains the legacy seven-day runtime maximum. This is implementation drift, not current product policy.
- Runtime tests were not run for this status-only refresh because no runtime, schema, dependency, configuration, payment, or UI file was changed.

### OPEN

- LONG_HORIZON_DEALS remains open in runtime. The legacy seven-day maximum still exists in `src/app.ts` and must not be removed as an isolated two-line change if the durable future-charge/payment semantics are not landed with it.
- The previously prepared long-horizon implementation exists outside current GitHub history and still needs safe publication/integration before it can be reviewed and merged.
- Runtime product-policy cleanup remains required for the fixed 24-hour Completion Window and legacy distributor/affiliate surfaces, without touching ordinary sharing or role-neutral viral analytics.
- The site CMS branch is not merged yet: it needs a PR and fresh GitHub CI. It carries migration `069_site_content_drafts_media.sql`, and PR #24 (long-horizon) also claims id `069` — whichever merges second must be renumbered before merge.
- Branch `claude/admin-cms-template-editor-x9mava` is now redundant: its commit is contained in `claude/siton-admin-cms-templates-s8g2ih`. Do not open two PRs for the same work.
- The buyer tracking status texts, seller KYC wording inside conditional branches and the deal-page fulfilment strings remain code-owned by design; moving more of them to the CMS is a follow-up decision, not a gap.
- Owner-machine agent worktrees should be rechecked after the next local sync with `node scripts/agent.cjs setup` or `node scripts/agent.cjs doctor`.
- Hosted/runtime readiness remains open for the existing Render worker/Blueprint, hosted OTP secret, external payment-provider semantics, production image pruning, architecture decision, and legacy recovery-URL cleanup tracks.
- REAL MONEY remains 0. Grow remains untouched and unactivated.

### PERCENTAGE

- Agent workflow repository-side implementation: 100% through merged v4.
- Canonical product-policy decision and source-of-truth alignment: 100%.
- Runtime implementation alignment for the current product-policy set: incomplete. Do not infer readiness from documentation alignment alone.
- Long-horizon runtime integration: not complete on `master`.
- Admin content management (owner can edit the site without code): 95% — implemented, tested and browser-proven on the branch; the remaining 5% is PR review, GitHub CI and merge.

### NEXT STEP

1. Open ONE pull request from `claude/siton-admin-cms-templates-s8g2ih` for the complete site CMS (adopted editor + product copy) and merge it on green CI, renumbering migration 069 if PR #24 lands first.
2. Publish and review the complete long-horizon implementation against current `master`, rather than deleting only the seven-day validator.
3. Merge long-horizon work only after focused regression tests and payment-lifecycle invariants are proven.
4. Continue the separate canonical policy runtime cleanup on an isolated branch without colliding with CMS or duration work.
5. Re-run owner-machine agent doctor after the next local sync.
6. Keep real money disabled until the existing provider-readiness gates are explicitly cleared.

## PRODUCT POLICY ALIGNMENT — 2026-09-16

The binding policy source is `docs/CANONICAL_PRODUCT_POLICY_AMENDMENT_2026-09-16.md`.

Current invariants:

- Every publishable deal has a finite mandatory `max_units`. Unlimited or `NULL` capacity is non-canonical.
- Completion Window is exactly 24 hours and exists only for failed-charge recovery by eligible participants.
- Siton fee is fixed at 8% of all purchase money actually collected through Siton, including shipping/delivery and other applicable purchase charges, excluding the customer VAT component.
- There is no per-deal fee override.
- There is no distributor/affiliate user role or distributor product module. Ordinary sharing remains role-neutral.
- There is no fixed seven-day maximum deal duration. Older seven-day product-deadline references are historical.
- Current legal material remains unchanged unless the owner explicitly changes it.

## AGENT MILESTONES

<!-- AGENT_STATUS:claude:START -->
### Claude Code latest milestone

- UPDATED: not yet written by v3 workflow
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

- UPDATED: 2026-09-16
- BRANCH: `chore/status-refresh-2026-09-16`
- COMPLETED: refreshed stale project status after PR #27 merge; aligned the recorded baseline with the verified task-start `master`; verified canonical deadline policy already exists and recorded the remaining runtime drift without making a partial payment-sensitive code change.
- TESTED: task-start GitHub `master` SHA and PR #27 merge state verified; canonical policy and agent source-of-truth files inspected; runtime tests not applicable to this documentation-only change.
- OPEN: long-horizon runtime integration still not on `master`; legacy seven-day validator remains until the complete duration/payment design lands safely.
- PERCENTAGE: 100% for this status-integrity task.
- NEXT STEP: integrate the complete long-horizon implementation on a separate branch and prove its regression/payment invariants before merge.
<!-- AGENT_STATUS:codex:END -->

## STANDING SAFETY AND COMMERCIAL INVARIANTS

- Siton fee is fixed at 8% of the full collected purchase amount including delivery and other applicable purchase charges, excluding the customer VAT component.
- No per-deal commission-rate override.
- Every publishable deal has a finite mandatory `max_units`; no unlimited or `NULL` capacity.
- Completion Window is fixed at exactly 24 hours and only serves failed-charge recovery for `ChargeFailedCompletion` participants.
- No distributor/affiliate user role or distributor product module. Ordinary sharing remains role-neutral.
- No fixed seven-day maximum deal duration.
- Existing state-machine, idempotency, atomicity, audit, outbox, inventory, security, and 90% success rules remain safety boundaries.
- Real money must remain disabled unless explicitly authorized by the owner.
- Grow must remain untouched unless explicitly authorized.
- Claude Code and Codex must not edit the same product/code scope concurrently.
- External research belongs outside coding-agent credit. Coding agents receive conclusions and repository tasks.
- Meaningful work ends with tests, diff review, `PROJECT_STATUS.md` update, clear commit, push and PR. No retry loops.

Historical milestone detail is preserved in Git history and should not be loaded into normal agent context.
