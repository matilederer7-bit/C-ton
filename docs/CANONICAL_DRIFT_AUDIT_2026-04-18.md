# Canonical Drift Audit

Date: `2026-04-18`

## Scope

This audit compares the newly adopted canonical foundation pack against the repository as it exists now.

Canonical source of truth:

- [CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md](/c:/Users/Lenovo/Documents/C-ton/docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md)
- [סיטון אפיון מוצר מלא עדכני.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/סיטון אפיון מוצר מלא עדכני.docx)
- [UX סיטון.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/UX סיטון.docx)
- [סיטון - מפרט מערכת מחייב.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/סיטון - מפרט מערכת מחייב.docx)
- [חוקה וצקליסט לסיטון.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/חוקה וצקליסט לסיטון.docx)

## Executive Summary

The repository still contains a substantial amount of old-model logic and terminology. The drift is not limited to copy. It exists in schema, routes, admin surfaces, fee calculations, invoice fields, bootstrap defaults, tests, and internal dashboards.

The three dominant drift clusters are:

1. Distributor logic still modeled as an internal economic subsystem.
2. Fee model still modeled through `commission_rate` and legacy fee arithmetic.
3. Repeat purchases still conflict with key repository assumptions outside the narrow canonical schema guardrail.

## Top Priorities

1. Remove internal distributor economics from runtime/API/schema/UI surfaces.
2. Replace `commission_rate`-based fee modeling with the canonical platform-fee model.
3. Redesign repeat-purchase handling end-to-end so the same buyer can create multiple distinct joins in the same deal without breaking counters, idempotency, or UX.
4. Clean secondary docs and tests so they stop reasserting the old product story.

## Findings By Category

### Distributor Gaps

#### DRIFT-DIST-01

- What exists now:
  The runtime creates and uses `affiliate_accounts` and `affiliate_attributions`, including payout readiness and payout state.
- What the new source of truth requires:
  Distributors are a measured distribution channel only. No in-system payout engine, no in-system commission accounting, no internal payment obligation to the distributor.
- Why this is a real gap:
  This is active data model and runtime behavior, not naming only.
- Where it sits:
  [src/product_surface_support.ts](/c:/Users/Lenovo/Documents/C-ton/src/product_surface_support.ts), [scripts/init_db.sql](/c:/Users/Lenovo/Documents/C-ton/scripts/init_db.sql)
- Severity:
  `critical`
- Treatment type:
  `docs + DB + code + tests`
- Gap type:
  `product + financial + DB + API`
- Risk if left open:
  The system continues to encode a business obligation to distributors that the canonical product model explicitly removed.

#### DRIFT-DIST-02

- What exists now:
  Public/internal runtime exposes distributor payout routes and payout mutations.
- What the new source of truth requires:
  No payout flow inside the system. Distributor-commercial settlement is external.
- Why this is a real gap:
  These are live endpoints, not dead docs.
- Where it sits:
  [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts)
  Routes include `/api/affiliate/overview`, `/api/affiliate/payout-profile`, and `/api/admin/affiliate-payouts/:affiliateId`.
- Severity:
  `critical`
- Treatment type:
  `docs + code + tests`
- Gap type:
  `product + API + operational`
- Risk if left open:
  Internal and admin users are guided toward a payout model the product no longer supports.

#### DRIFT-DIST-03

- What exists now:
  Frontend still renders an affiliate workspace, affiliate payout profile, payout states, payout method, and admin payout control.
- What the new source of truth requires:
  A slim distributor module for attribution, measurement, and share-link management only.
- Why this is a real gap:
  The UI explicitly teaches the old model.
- Where it sits:
  [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js)
- Severity:
  `critical`
- Treatment type:
  `docs + code`
- Gap type:
  `UX + product + terminology`
- Risk if left open:
  Users and operators will act on the wrong business model.

#### DRIFT-DIST-04

- What exists now:
  Internal docs still describe affiliate verification, payout progression, admin settlement visibility, and affiliate compensation semantics as closed or internally complete.
- What the new source of truth requires:
  Distributor attribution only, with no in-product payout engine.
- Why this is a real gap:
  These docs still frame the old system as valid and complete.
- Where it sits:
  [docs/REMAINING_PRODUCT_SURFACES_LOG.md](/c:/Users/Lenovo/Documents/C-ton/docs/REMAINING_PRODUCT_SURFACES_LOG.md), [docs/REMAINING_PRODUCT_SURFACES_DECISION.md](/c:/Users/Lenovo/Documents/C-ton/docs/REMAINING_PRODUCT_SURFACES_DECISION.md), [docs/ULTIMATE_PRELIVE_QA_RC_LOG.md](/c:/Users/Lenovo/Documents/C-ton/docs/ULTIMATE_PRELIVE_QA_RC_LOG.md), [docs/ULTIMATE_PRELIVE_QA_RC_DECISION.md](/c:/Users/Lenovo/Documents/C-ton/docs/ULTIMATE_PRELIVE_QA_RC_DECISION.md)
- Severity:
  `major`
- Treatment type:
  `docs only`
- Gap type:
  `docs + product`
- Risk if left open:
  Future implementation work will keep rehydrating the deprecated distributor-money model.

### Fee Model Gaps

#### DRIFT-FEE-01

- What exists now:
  `commission_rate` is a first-class field on deals and remains part of schema, inserts, immutability rules, API payloads, and seller forms.
- What the new source of truth requires:
  The new product pack defines Siton platform pricing as a canonical 8% of the amount actually collected, not a free-form per-deal `commission_rate` control.
- Why this is a real gap:
  Runtime behavior still depends on seller-supplied or deal-stored `commission_rate`.
- Where it sits:
  [scripts/init_db.sql](/c:/Users/Lenovo/Documents/C-ton/scripts/init_db.sql), [src/app.ts](/c:/Users/Lenovo/Documents/C-ton/src/app.ts), [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts), [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js), [src/migrations/008_db_enforcement_phase2a.sql](/c:/Users/Lenovo/Documents/C-ton/src/migrations/008_db_enforcement_phase2a.sql), [src/migrations/014_demo_preview_bootstrap.sql](/c:/Users/Lenovo/Documents/C-ton/src/migrations/014_demo_preview_bootstrap.sql), [src/stage10c_harden_deals.sql](/c:/Users/Lenovo/Documents/C-ton/src/stage10c_harden_deals.sql)
- Severity:
  `critical`
- Treatment type:
  `docs + DB + code + tests`
- Gap type:
  `financial + product + schema`
- Risk if left open:
  Sellers can still think fee shape is per-deal configurable when the canonical product no longer says that.

#### DRIFT-FEE-02

- What exists now:
  Fee computation still subtracts an affiliate amount from seller economics and stores `affiliate_fee_amount` on invoice documents.
- What the new source of truth requires:
  No in-system distributor payout or affiliate fee allocation.
- Why this is a real gap:
  It changes money summaries, receipts, and admin reporting.
- Where it sits:
  [src/product_surface_support.ts](/c:/Users/Lenovo/Documents/C-ton/src/product_surface_support.ts), [src/app.ts](/c:/Users/Lenovo/Documents/C-ton/src/app.ts), [src/invoice_dispatch.ts](/c:/Users/Lenovo/Documents/C-ton/src/invoice_dispatch.ts), [src/migrations/018_invoice_documents.sql](/c:/Users/Lenovo/Documents/C-ton/src/migrations/018_invoice_documents.sql)
- Severity:
  `critical`
- Treatment type:
  `DB + code + tests`
- Gap type:
  `financial + accounting + schema`
- Risk if left open:
  Receipts and internal accounting continue to encode a deprecated affiliate-money leg.

#### DRIFT-FEE-03

- What exists now:
  Seller and admin dashboards still display fee fields derived from `commission_rate`, affiliate totals, payout status, and settlement summaries.
- What the new source of truth requires:
  One platform-fee model, with no internal affiliate settlement layer.
- Why this is a real gap:
  The surfaces operationalize the old model.
- Where it sits:
  [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js), [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts)
- Severity:
  `major`
- Treatment type:
  `docs + code`
- Gap type:
  `UX + product + financial`
- Risk if left open:
  The organization keeps reading old settlement concepts from supposedly current dashboards.

#### DRIFT-FEE-04

- What exists now:
  Historical docs and diagnostic outputs still normalize old fee fields such as `commission_rate`, payout readiness, and affiliate allocation.
- What the new source of truth requires:
  The old fee story must stop being treated as current truth.
- Why this is a real gap:
  Secondary documents still encode the previous contract.
- Where it sits:
  [docs/STAGE_9D_DRIFT_REPORT.md](/c:/Users/Lenovo/Documents/C-ton/docs/STAGE_9D_DRIFT_REPORT.md), [docs/STAGE_9F_SUSPICIOUS_DEALS_CLASSIFIED.json](/c:/Users/Lenovo/Documents/C-ton/docs/STAGE_9F_SUSPICIOUS_DEALS_CLASSIFIED.json), [docs/ADMIN_SUPPORT_OBSERVABILITY.md](/c:/Users/Lenovo/Documents/C-ton/docs/ADMIN_SUPPORT_OBSERVABILITY.md)
- Severity:
  `medium`
- Treatment type:
  `docs only`
- Gap type:
  `docs + terminology`
- Risk if left open:
  Future audits will continue to misclassify legacy fee shape as live product intent.

### Repeat Purchase Gaps

#### DRIFT-REPEAT-01

- What exists now:
  Join idempotency lookup is keyed by `deal_id + buyer_id + idempotency_key`, and the join path still treats the same buyer on the same deal as a special reuse path.
- What the new source of truth requires:
  The same buyer may create multiple distinct purchases in the same deal.
- Why this is a real gap:
  The runtime semantics still think in terms of one buyer identity flowing through one deal join stream unless idempotency differs perfectly.
- Where it sits:
  [src/app.ts](/c:/Users/Lenovo/Documents/C-ton/src/app.ts) in `POST /deals/:id/join`
- Severity:
  `critical`
- Treatment type:
  `code + tests`
- Gap type:
  `logical + API`
- Risk if left open:
  Repeat-purchase behavior will remain fragile and easy to mis-handle under retries, counters, and support tooling.

#### DRIFT-REPEAT-02

- What exists now:
  Seller/admin/user surfaces aggregate and search by `buyer_id` as if buyer identity is the main business join key.
- What the new source of truth requires:
  Multiple purchases by the same buyer in the same deal must be a first-class supported pattern.
- Why this is a real gap:
  Support and analytics still lean toward “buyer identity = join identity”.
- Where it sits:
  [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts)
- Severity:
  `major`
- Treatment type:
  `code + tests`
- Gap type:
  `logical + UX + admin`
- Risk if left open:
  Seller/admin tools can under-spec or misinterpret repeated joins from the same buyer.

#### DRIFT-REPEAT-03

- What exists now:
  Multiple tests and seed helpers still create one participant per buyer per deal and do not prove canonical repeated-purchase semantics.
- What the new source of truth requires:
  Repeat purchases must be explicitly modeled and verified.
- Why this is a real gap:
  The regression suite still tells the old story.
- Where it sits:
  [tests/join_flow_qa_validation.ts](/c:/Users/Lenovo/Documents/C-ton/tests/join_flow_qa_validation.ts), [tests/concurrency_proof.ts](/c:/Users/Lenovo/Documents/C-ton/tests/concurrency_proof.ts), [tests/preprod_torture_validation.ts](/c:/Users/Lenovo/Documents/C-ton/tests/preprod_torture_validation.ts), [tests/full_product_surface_validation.ts](/c:/Users/Lenovo/Documents/C-ton/tests/full_product_surface_validation.ts)
- Severity:
  `major`
- Treatment type:
  `tests only`
- Gap type:
  `tests + product`
- Risk if left open:
  Old assumptions will keep passing CI even when they contradict the new product pack.

### DB Gaps

#### DRIFT-DB-01

- What exists now:
  Canonical bootstrap no longer has unique `(deal_id, buyer_id)`, but the database model still carries old affiliate payout tables, fields, and invoice columns that encode the previous product economics.
- What the new source of truth requires:
  Distributor tracking only, not distributor settlement internals.
- Why this is a real gap:
  The schema itself still models the old economic story.
- Where it sits:
  [scripts/init_db.sql](/c:/Users/Lenovo/Documents/C-ton/scripts/init_db.sql), [src/product_surface_support.ts](/c:/Users/Lenovo/Documents/C-ton/src/product_surface_support.ts), [src/migrations/018_invoice_documents.sql](/c:/Users/Lenovo/Documents/C-ton/src/migrations/018_invoice_documents.sql)
- Severity:
  `critical`
- Treatment type:
  `DB + code + tests`
- Gap type:
  `DB + financial`
- Risk if left open:
  Even after UI cleanup, the platform will still carry obsolete affiliate-money storage and invariants.

#### DRIFT-DB-02

- What exists now:
  The updated constitution/checklist still references `commission_rate` in the “critical fields” list even though the updated product direction removes free-form internal distributor commissions and shifts to a tighter fee model.
- What the new source of truth requires:
  One coherent fee story across product, UX, system spec, and constitution.
- Why this is a real gap:
  This is a real contradiction inside the canonical pack itself.
- Where it sits:
  [חוקה וצקליסט לסיטון.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/חוקה וצקליסט לסיטון.docx), [סיטון אפיון מוצר מלא עדכני.docx](/c:/Users/Lenovo/Documents/C-ton/docs/foundation-canonical-2026-04-18/סיטון אפיון מוצר מלא עדכני.docx)
- Severity:
  `major`
- Treatment type:
  `docs only`
- Gap type:
  `docs + product`
- Risk if left open:
  Implementation alignment will remain ambiguous because the new canonical pack still contains a fee-field contradiction.

### API Gaps

#### DRIFT-API-01

- What exists now:
  Join contract still accepts `affiliate_ref` and stores distributor attribution into the business flow.
- What the new source of truth requires:
  Attribution-only distributor semantics may remain, but not payout-carrying business semantics.
- Why this is a real gap:
  The current contract is entangled with the old payout model and old naming.
- Where it sits:
  [src/app.ts](/c:/Users/Lenovo/Documents/C-ton/src/app.ts), [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js)
- Severity:
  `major`
- Treatment type:
  `docs + code + tests`
- Gap type:
  `API + terminology + product`
- Risk if left open:
  Attribution remains coupled to deprecated affiliate-money concepts instead of a clean distributor attribution model.

### UX Gaps

#### DRIFT-UX-01

- What exists now:
  Seller create-deal and internal pages still expose editable “platform fee” / `commission_rate`.
- What the new source of truth requires:
  The fee model is no longer a seller-tuned surface.
- Why this is a real gap:
  The UI still asks the seller to author the old economic parameter.
- Where it sits:
  [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js)
- Severity:
  `critical`
- Treatment type:
  `code + tests`
- Gap type:
  `UX + product + financial`
- Risk if left open:
  Seller-created deals can continue to carry old fee assumptions at creation time.

#### DRIFT-UX-02

- What exists now:
  Internal copy still uses “affiliate”, “payout”, “commission”, and “settlement” in core internal surfaces.
- What the new source of truth requires:
  Distributor language should be about attribution and distribution links, not internal money operations.
- Why this is a real gap:
  Terminology reinforces the wrong mental model.
- Where it sits:
  [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js), [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts)
- Severity:
  `major`
- Treatment type:
  `docs + code`
- Gap type:
  `terminology + UX`
- Risk if left open:
  Even if logic changes later, operators and future contributors will keep rebuilding the old model from the labels.

### Terminology Gaps

#### DRIFT-TERM-01

- What exists now:
  File names, constants, and route names still center `affiliate`.
- What the new source of truth requires:
  The product moved to a lean distributor/distribution-link model.
- Why this is a real gap:
  Naming controls future architecture decisions.
- Where it sits:
  [src/product_surface_support.ts](/c:/Users/Lenovo/Documents/C-ton/src/product_surface_support.ts), [src/frontend_runtime.ts](/c:/Users/Lenovo/Documents/C-ton/src/frontend_runtime.ts), [frontend/app.js](/c:/Users/Lenovo/Documents/C-ton/frontend/app.js), many tests under [tests](/c:/Users/Lenovo/Documents/C-ton/tests)
- Severity:
  `medium`
- Treatment type:
  `docs + code + tests`
- Gap type:
  `terminology`
- Risk if left open:
  The codebase will keep reintroducing obsolete product assumptions.

### Test Gaps

#### DRIFT-TEST-01

- What exists now:
  Several test suites explicitly assert affiliate payout profile behavior, admin payout approval, affiliate commissions, and settlement summaries as passing behavior.
- What the new source of truth requires:
  Those behaviors are no longer canonical product goals.
- Why this is a real gap:
  CI still defends the old product.
- Where it sits:
  [tests/master_product_depth_validation.ts](/c:/Users/Lenovo/Documents/C-ton/tests/master_product_depth_validation.ts), [tests/remaining_product_surfaces_validation.ts](/c:/Users/Lenovo/Documents/C-ton/tests/remaining_product_surfaces_validation.ts), [tests/ultimate_prelive_qa_rc_validation.ts](/c:/Users/Lenovo/Documents/C-ton/tests/ultimate_prelive_qa_rc_validation.ts), [tests/full_product_surface_validation.ts](/c:/Users/Lenovo/Documents/C-ton/tests/full_product_surface_validation.ts)
- Severity:
  `critical`
- Treatment type:
  `docs + tests`
- Gap type:
  `tests + product`
- Risk if left open:
  The suite will actively resist migration toward the new canonical product model.

## Ten Most Material Gaps

1. Internal affiliate payout subsystem still exists in schema and runtime.
2. Affiliate payout/profile/admin payout routes still exist and are live.
3. Frontend still presents affiliate payout and settlement UX.
4. `commission_rate` is still a first-class deal field and seller input.
5. Fee computation and invoice docs still include `affiliate_fee_amount`.
6. Internal dashboards still compute seller/platform/affiliate settlement views.
7. Repeat-purchase semantics are still under-modeled in join/idempotency logic.
8. Tests still defend affiliate payout and settlement behavior as correct.
9. Secondary docs still narrate affiliate economics as if they are valid.
10. The new canonical pack itself still contains one fee-field contradiction around `commission_rate`.

## Recommended Fix Order

1. Freeze and deprecate affiliate payout semantics in docs and tests.
2. Remove seller-editable `commission_rate` from UI/API creation flow.
3. Replace fee math and invoice fields with the canonical fee model.
4. Redesign distributor attribution as attribution-only, with renamed routes and entities.
5. Run a dedicated repeat-purchase implementation track against join flow, schema, counters, and tests.

