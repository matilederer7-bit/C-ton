# Shelf closeout — Claude lane (2026-09-17)

Branch `claude/shelf-heavy-closeout-20260917` from `origin/master` `1d38656` (PR #35 merged).
Method: every shelf branch was compared against current master (tree diff for the three
unrelated-history Codex branches, commit-range diff for the rest), the unique part was
identified, existing equivalents on master were checked, and only still-missing,
architecture-compatible functionality was ported. No blind cherry-pick. Excluded by
instruction and untouched: PR #24 / long-horizon, `import/long-horizon-2026-09-16`,
authorization-lifetime changes, PR #7 / pilot communications, `src/notification_events.ts`,
pilot-communications migrations/docs, Cloud Agent Manager (PR #35). No Base44 business
dependency was added. REAL MONEY stays 0; Grow untouched.

## Classification

| Branch | Result | What was carried onto master | Evidence |
|---|---|---|---|
| `codex/amazon-benchmark-upgrade` (unrelated history, 363 commits) | **STILL VALUABLE → INTEGRATED (product catalog)** | Migration **071** (`products`, `product_images`, `deals.product_id` + frozen `product_snapshot_jsonb` with DB-trigger immutability after Draft, delivery estimate range), `src/product_catalog.ts`, enrichment provider seam, seller-scoped product writers (`POST/PATCH /api/seller/products`, `POST /api/seller/deals/:id/product`) and readers (`GET /api/seller/products[/:id]`), Deal-from-Product creation (`POST /deals` + `product_id`), draft locking, publish readiness, shared-blob-safe image cleanup, React Product Library (`#/seller/products…`), wizard prefill (`#/seller/new?product=`), estimate inputs, buyer estimate line, staging grants, `docs/PRODUCT_CATALOG.md` | `npm run test:product-catalog` (static 11/11 + DB API 9/9), deal_types 25/25 |
| ↳ not carried | — | `service` deal type + `deal_service_terms`, funnel-event extension, Base44 `product.jsonc` / `siton-seller-product`, legacy `frontend/` Product Library UI | product decision outside scope; Base44 not a source of truth; React `web/` is canonical |
| `codex/mobile-release-readiness` | **STILL VALUABLE → INTEGRATED** | canonical `web/` bundle at `/preview/`, SHA-256 manifest + read-only release gate, `mobile/runtime.js`, `web/src/mobileUrls.ts`, Android/iOS metadata hardening, association templates, 12 negative-control tests, mobile CI workflow, inventories/runbook | Linux: build → `cap sync` (android+ios) → `MOBILE_GATE_PASS` → `MOBILE_TESTS_PASS negative_controls=12`; legacy `mobile_readiness_validation` PASS; `release:preflight:static` PASS (`mobile-pwa-gate` PASS) |
| ↳ external blockers (unchanged) | — | signing keys, store accounts, Apple/Google credentials, domain association hosting, device proof, `SITON_APP_ID`/link host | `.invalid` placeholders rejected by `--release` |
| `codex/visual-rebrand-c-ton` (unrelated history) | **web: SUPERSEDED · native/PWA: INTEGRATED** | React web already graphite + orange; glow/shadow tokens toned down ~15%; Android launcher set, iOS AppIcon + splash, PWA manifest identity (C-ton, graphite chrome), `assets/logo.svg` + `frontend/icons` now the same graphite C mark with the orange bar (teal/cream native art retired); CMS untouched | `npm run test:visual-brand` PASS; mobile gate re-PASS |
| ↳ not carried | — | 474-line dark rework of the legacy `frontend/styles.css` + `app.js`, and the branch's older light `web/src/styles.css` | legacy surface; master web supersedes |
| `claude/authenticated-ui-acceptance-harness` | **STILL VALUABLE → INTEGRATED (ported to block CMS)** | `scripts/authenticated_ui_acceptance.cjs` (A3–A8 rewritten for draft → publish → revision conflict), dry-fit seed, contract test, docs, Linux/CI browser lookup | contract 6/6; local dry-fit `DRYFIT_PASS` 17/17 at desktop and mobile, no run marker left; hosted acceptance blocked on owner credentials |
| `claude/pre-financial-resilience` | **SUPERSEDED** | nothing (master `693628c` carries the cancel `serializeOnEntity` and the checked-out PG client error guard in a later form) | `attachClientErrorGuard`, `dbClientErrorObservations`, `serializeOnEntity: true` on cancel present on master |
| `claude/ci-request-id-flake-repair` | **SUPERSEDED** | nothing (master `ad42e9e`/`2cdc89a` carry the value-form leak check, the forced-collision regression and a shared `leaksCredential` predicate) | grep on master tests |
| `codex/closed-pilot-war-game` | **STILL VALUABLE → INTEGRATED** | admin-overview settlement fix (successful money only) + regression test; `scripts/closed_pilot_war_game.cjs` / `closed_pilot_scenario.cjs` (`npm run qa:pilot-war-game`), report annotated | scenario phases `PILOT_WAR_GAME_PASS` on master (day/restart/workers); `test:admin-overview-settlement` 2/2 |
| `claude/backend-sensitive-ux-plan` | **SUPERSEDED (planning only)** | nothing; its four items are either shipped by PR #34 (CMS FAQ, hero image/video, migration 069) or remain product decisions (multi-method receipt, windowed virality) | docs-only branch, no runtime |
| `codex/r5-auth-readiness` (unrelated history) | **SUPERSEDED** | nothing; R2–R4 auth work is on master in later form; the R5 audit docs describe a pre-Supabase-cutover state | `SELLER_AUTH_ATTACK_PLAN.md`, `ARCHITECTURE_REBASE_R1…` already on master |
| `claude/ux-product-polish-round2` | **INTEGRATED (earlier)** | nothing new (master `a28afcd` reintegrated the superset branch; CMS closed the documented gaps) | file-by-file delta shows master newer |
| `codex/ux-premerge-hardening-night` | **INTEGRATED (earlier)** | nothing new (same `a28afcd`) | `ux_premerge_browser_checks.cjs`, `dialogFocus.ts`, tests present |
| `claude/launch-ux-cleanup` | **STILL VALUABLE → partially INTEGRATED** | pickup navigation truth (Google Maps + Waze from one stored truth, precision hint for sellers, one React renderer on deal page + tracking card) | `npm run test:pickup-navigation` PASS; countdown/pickup + p07 suites PASS |
| ↳ deferred (documented, not lost) | — | React legal pages (`/api/legal/:slug` + `#/legal/*`), buyer-facing viral-tree removal, admin growth window + buyer search intent, 17-route overflow sweep proof | each is a 150–600 line UX/admin change on a base 63 commits behind master; needs its own reconciliation against the CMS-era pages |

## Migration sequencing

`070` is left free for PR #24's renumbered long-horizon migration; the product catalog appends as
`071` (manifest position after `069`). The isolated migration proof and the migration
preflight run against the full ledger (63 rows).

## Not done here (owner / integrator)

- Staging: apply migration 071 and `supabase/staging/025_product_catalog_grants.sql` before deploying
  (boot fail-closes on the new required tables, like the content tables).
- Hosted acceptance run needs the four `SITON_ACCEPTANCE_*` logins.
- Mobile store readiness stays external (signing, accounts, association hosting, devices).
- Final review and merge are the integrator's (ChatGPT); this branch is not self-merged.
