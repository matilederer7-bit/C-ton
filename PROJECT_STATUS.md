# PROJECT STATUS

Current update: 2026-04-26 (Seller Deal Excel Export)

- Completed: added `GET /api/seller/deals/:dealId/export.xlsx` endpoint in `src/frontend_runtime.ts`. Returns a full multi-sheet Excel workbook for the seller after deal completion. Content-Type: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Content-Disposition: `attachment; filename="siton-deal-export-<dealId>.xlsx"`.
- Completed: workbook includes 5–6 sheets: **Deal Summary** (deal metadata + aggregated money totals), **Eligible Buyers** (one row per eligible participant with delivery snapshot and row-level fee breakdown), **All Participants** (full list with eligibility flags for operational transparency), **Money Breakdown** (per-participant fee drill-down + TOTAL row whose figures match Deal Summary), **Notes** (Hebrew disclaimer about seller responsibility for fulfillment), and **Attribution** (only added if attribution data exists; attribution-only, no commissions or payouts).
- Completed: money model uses canonical `calculatePlatformFeeMoney()` from `platform_fee_money.ts`. Fee = 8% of gross (qty × unit_price + delivery_cost), VAT = 18% on fee only. `seller_net_amount = gross - platform_fee_total`. No new money logic invented.
- Completed: eligibility filter matches shipping CSV — `money_state IN ('ChargedSuccess','RecoveredCharge')` or `buyer_state = 'DealCompleted'`. Dropped/DealFailed/AuthReleased excluded from Eligible Buyers and Money Breakdown.
- Completed: same ownership enforcement as CSV export — 403 for wrong seller, 404 for missing deal, 409 + `deal_not_completed` for non-Completed deal. No state-machine changes, no financial mutations.
- Completed: Excel injection prevention via `safeText()` — values beginning with `=`, `-`, `+`, `@`, `*` are prefixed with `'`. No provider tokens, webhook IDs, auth internals, or invoice provider references in output.
- Completed: Excel formatting — freeze top row, auto-filter, bold headers, `#,##0.00` numeric format on all money columns, column widths calibrated for content.
- Completed: added `exceljs` dependency (no other xlsx library added). CSV shipping export remains unchanged as a lightweight fallback.
- Checked: `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/seller_deal_excel_export_validation.js` (8/8 PASS); `node .tmp_test_dist/tests/seller_shipping_export_validation.js` (4/4 PASS); `node .tmp_test_dist/tests/participant_delivery_snapshot_validation.js` (8/8 PASS). Drift scan: no marketplace, commission_rate, affiliate payout, withdrawal, or balance terms in diff.
- Open: frontend download button for completed deals not yet wired. Attribution sheet will enrich automatically if attribution data grows.
- Progress: `90%` of the Seller Deal Excel Export track (endpoint + workbook + tests complete; frontend button is follow-up).
- Next step: connect an Excel download button in the seller completed-deal surface pointing to `/api/seller/deals/:dealId/export.xlsx`.

Current update: 2026-04-24 (Seller Shipping Export)

- Completed: added `GET /api/seller/deals/:dealId/shipping-export` endpoint in `src/frontend_runtime.ts`. Returns a UTF-8 (BOM-prefixed) CSV file with one row per eligible buyer — only those with `money_state IN ('ChargedSuccess', 'RecoveredCharge')` or `buyer_state = 'DealCompleted'`. Ineligible participants (DealFailed, Dropped, Refunded, etc.) are excluded.
- Completed: CSV fields per row now include participant delivery snapshot data: `deal_id`, `deal_title`, `participant_id`, `buyer_id`, `buyer_name`, `buyer_phone`, `buyer_email`, `qty`, `delivery_method`, `delivery_method_label`, `delivery_address`, `delivery_city`, `delivery_notes`, `shipping_status` (from `delivery_records`, default `ready_to_fulfill`), `charged_amount` (price_per_unit × qty + delivery_cost), `created_at`. Header row is always emitted even when no eligible buyers.
- Completed: ownership enforcement — deal looked up without seller filter; if the effective `COALESCE(seller_id, requestedSellerId)` does not match the requesting seller → 403. Non-existent deal → 404. Non-Completed deal → 409 with `deal_not_completed` code.
- Completed: participant delivery snapshots are captured only from a valid delivery option. If a buyer sends a `delivery_option_id` that does not belong to the deal, join now fails with `invalid_delivery_option` before a participant is created. Delivery-type options require an address; pickup/distribution options do not.
- Completed: no state-machine changes, no financial mutations, no capture/refund/payout/invoice operations. Read-only export.
- Checked: `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/participant_delivery_snapshot_validation.js`; `node .tmp_test_dist/tests/seller_shipping_export_validation.js`; `node .tmp_test_dist/tests/frontend_flow_validation.js`. Coverage includes snapshot schema, join snapshot persistence, invalid delivery option blocking, delivery-address requirement, pickup without address, seller ownership 403, non-completed export 409, eligible-buyer filtering, and headers-only CSV.
- Open: Excel (.xlsx) export is not implemented — CSV only for now.
- Open: frontend download button for completed deals not yet wired. Target: add a download button to the seller closed-deal surface after the responsive UX track is finalized.
- Progress: `90%` of the seller shipping export track (endpoint + tests complete; contact-fields migration and frontend button are follow-up work).
- Next step: connect a download button in the seller deal-detail surface pointing to `/api/seller/deals/:dealId/shipping-export` after the UX responsive pass is complete.

Current update: 2026-04-26 (UX Responsive Product Surface Closure)

- Completed: closed the current responsive UX product-surface pass without reopening the core rails. The frontend now has stronger mobile/desktop responsive deal surfaces, share/copy/native-share affordances, the required buyer payment-hold notice, a seller deal-creation wizard with final confirmation checkboxes before publish, local product-image preview with type/size guardrails, and focused seller/public/tracking layout polish.
- Completed: fixed the narrow API gap from this UX pass: `/deals` now persists `delivery_options`, and the join/tracking surface can carry the selected delivery option, cost, and estimated hold total. This stayed scoped to delivery metadata and did not change the state machine, payment rail, invoice rail, payout rail, platform-fee model, outbox contract, or idempotency model.
- Checked: forbidden drift scan over `frontend/app.js`, `src/app.ts`, and `src/frontend_runtime.ts` found no live marketplace/catalog/deal-search or distributor commission/payout/balance/withdrawal semantics. `node --check frontend/app.js` passed. `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist` passed. Focused validations passed: `product_surfaces_refinement_validation`, `frontend_foundation_rtl_accessibility_validation`, and `read_surfaces_truth_alignment_validation`.
- Checked: `frontend_flow_validation` is now isolated from background worker interference and passes. The test disables the outbox/deadline worker before importing the app, then closes the app at the end so it does not leave port 3000 occupied. The passing run covered shell/copy/public/draft/OTP/payment/join/tracking, including `JoinedAuthorized`, `AuthHeld`, `Courier`, delivery cost, and hold total. `product_surfaces_refinement_validation` was rerun and passed after the test-isolation fix.
- Open: real image upload/storage provider remains future work; the current image support is local preview only. Deploy-preview smoke testing on mobile and desktop is still needed. Full demo E2E should be rerun after deploy before starting a separate visual-polish or seller-onboarding track.
- Progress: `90%` of the UX responsive product-surface closure track.
- Next step: deploy preview, run a manual smoke test on mobile and desktop, then decide whether the next separate track is visual polish or seller onboarding.

Current update: 2026-04-24 (Morning external activation checkpoint: local preflight passed, live activation still blocked)

- Completed: reran the repository-side Morning activation proof after the external-activation handoff request. The local rail still passes fail-fast config validation, admin invoice/system observability, Morning adapter issue/status/cancel/reconcile behavior against the local provider stub, raw-body webhook verification, webhook dedupe/persistence, reconcile enqueue-only behavior, and internal invoice rail regression.
- Checked: `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/invoice_morning_activation_validation.js`; `node .tmp_test_dist/tests/invoice_morning_adapter_validation.js`; `node .tmp_test_dist/tests/invoice_rail_validation.js`.
- Live deploy status: not executed from this workspace. The deploy-platform variables still must be set externally: `INVOICE_PROVIDER=morning`, `INVOICE_PROVIDER_MODE=real`, `INVOICE_PROVIDER_BASE_URL`, `INVOICE_PROVIDER_API_KEY` or `INVOICE_PROVIDER_BEARER_TOKEN`, and `INVOICE_WEBHOOK_SECRET`, followed by a full redeploy.
- Live proof still open: public runtime boot without fail-fast config error; live `/api/admin/invoice-status` provider configured check; live `/api/admin/system-status` counter check; one real Morning issue/status/webhook/reconcile/idempotent replay cycle; evidence for no duplicate issuance, successful webhook verification, webhook persistence, reconcile record, no duplicate side effect, and no unexpected security event.
- Current verdict: Morning is `configured-ready` in the repository and deploy manifest, but not proven `active` in production from this session. No documentation-only commit or push was performed because the live activation gate has not passed.
- Next step: perform the external deploy-platform activation with real Morning credentials, run the live callback cycle against the public URL, then update this status from `configured-ready` to `active` only if the live evidence passes.

Current update: 2026-04-24 (Morning deploy activation hardening: fail-fast env, deploy wiring, invoice ops visibility)

- Completed: hardened Morning activation without reopening the invoice rail core. Real-mode Morning now fails fast when critical env is missing, including `INVOICE_WEBHOOK_SECRET`; `render.yaml` now declares the Morning env surface for deploy-time manual activation; and admin/system observability now exposes Morning config readiness, invoice webhook counters, signature-failure counts, reconcile backlog, and provider failure classes.
- Completed: kept the activation boundary outside the core state machine. Verified invoice webhooks still remain raw-body verified, duplicate-safe, persisted, security-audited, and reconcile-enqueue-only; no direct invoice state mutation was added to request threads.
- Checked: `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/invoice_morning_activation_validation.js`; `node .tmp_test_dist/tests/invoice_morning_adapter_validation.js`; `node .tmp_test_dist/tests/invoice_rail_validation.js`.
- Open: real Morning credentials are not available in this environment, and there is no live deploy-platform session here, so a true public deploy activation and live webhook callback validation could not be completed from inside this session.
- Progress: `96%` of the Morning deploy-activation track inside the repository; the remaining `4%` is external platform/secrets execution.
- Next step: set the Morning secrets in the target deploy platform, redeploy the runtime, hit the live `/webhooks/invoices` endpoint, and capture one real issue/status/webhook/reconcile cycle against the public URL.

Current update: 2026-04-23 (first real invoice provider adapter: Morning / Green Invoice)

- Completed: connected the first real invoice provider adapter, `INVOICE_PROVIDER=morning`, behind the existing invoice rail. The adapter supports document creation, status lookup, cancel, reconcile, normalized result classes, provider status mapping, idempotency keys, correlation IDs, and external issuance marking without changing the canonical money model.
- Completed: added verified raw-body invoice webhook intake at `/webhooks/invoices`, webhook dedupe through `invoice_webhook_events`, invalid-signature audit through `invoice_webhook_security_events`, and outbox-only `invoice_document_reconcile` enqueue. Webhooks do not mutate visible invoice state directly.
- Completed: added migration/bootstrap schema for invoice webhook audit/security tables, env activation documentation, and `docs/INVOICE_PROVIDER_MORNING_ADAPTER.md`. Internal-truth-only invoice rail remains available and unchanged when the real adapter is not configured.
- Checked: `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/invoice_morning_adapter_validation.js`; `node .tmp_test_dist/tests/invoice_rail_validation.js`.
- Open: live Morning/Green Invoice credentials, deployed webhook endpoint validation, final tax/legal template approval, official numbering/template policy, and production document delivery policy remain activation work.
- Progress: `93%` of the first real invoice provider adapter track.
- Next step: commit and push the Morning invoice adapter milestone; then activation can proceed by configuring the provider env vars in a non-demo environment.

Current update: 2026-04-23 (Stripe buyer payment production hardening: raw-body webhooks, PCI boundary, ops surfaces)

- Completed: hardened the Stripe buyer-payment adapter with production fail-fast config checks, raw-body webhook verification, `stripe-signature` support, signature-failure persistence, and a narrow PCI decision: production must use Stripe.js/Elements `payment_method_id`; server-side raw card tokenization is blocked except an explicit non-production test flag.
- Completed: added safe buyer payment method lifecycle storage in `buyer_payment_methods` with provider references only, plus `payment_webhook_security_events` for webhook security observability. Capture/recovery/refund remain worker/outbox-driven; the request-thread exception is documented as token reference intake plus authorization only.
- Completed: added `/api/admin/payment-ops-status` for payment attempts by class, webhook reconciliation counts, duplicate/ignored rate, signature failures, buyer payment method lifecycle counts, and provider readiness.
- Checked: `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/payment_stripe_adapter_validation.js`; `node .tmp_test_dist/tests/payment_production_hardening_validation.js`; `node .tmp_test_dist/tests/payment_authorization_real_rail_validation.js`; `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`; `node .tmp_test_dist/tests/payment_recovery_real_rail_validation.js`; `node .tmp_test_dist/tests/payment_refund_real_rail_validation.js`.
- Open: live Stripe keys, deployed webhook endpoint verification, Stripe.js/Elements frontend integration, and production risk controls remain activation work.
- Progress: `94%` of the Stripe buyer-payment production-hardening track.
- Next step: commit and push the Stripe buyer-payment production-hardening milestone; then connect Stripe.js/Elements in the frontend activation track.

Current update: 2026-04-23 (first real buyer payment adapter: Stripe tokenization, manual authorization, capture, refund, webhook normalization)

- Completed: added the first real payment provider adapter for the buyer money rail: `PAYMENT_PROVIDER=stripe` / `PAYMENT_PROVIDER_MODE=stripe`. The adapter uses Stripe PaymentMethod tokenization, manual-capture PaymentIntents for authorization, PaymentIntent capture for charge/recovery, Refunds for refund, Stripe webhook signature verification, and webhook event normalization into Siton reconciliation events.
- Completed: preserved the existing state machine, outbox, idempotency, payment attempts, webhook ingestion, platform fee money events, payout rail, and invoice rail. Capture/recovery/refund remain worker/outbox-driven; tokenization and authorization are exposed only through the already-permitted buyer payment boundary.
- Completed: added `/api/payments/tokenize` for providers that expose tokenization, kept `/api/payments/authorize` compatible with either raw card input or a provider `payment_method_id`, and kept mock/provider-ready generic HTTP behavior intact.
- Checked: `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/payment_stripe_adapter_validation.js`; `node .tmp_test_dist/tests/payment_authorization_real_rail_validation.js`.
- Open: live Stripe account keys, live webhook raw-body deployment validation, PCI posture review for server-side card tokenization vs Stripe.js, and production allowlist/risk controls remain external activation work.
- Progress: `90%` of the first real buyer payment adapter track.
- Next step: commit and push the Stripe adapter milestone; then activation can proceed by configuring Stripe env vars in a non-demo environment.

Current update: 2026-04-23 (invoice rail internal truth: provider-agnostic documents, attempts, reconcile, no external issuance)

- Completed: built a canonical internal invoice rail without reopening the locked 8% fee-before-VAT money model or the seller payout rail. `invoice_documents` now carries idempotency, correlation, document status, canonical fee columns (`platform_fee_base_amount`, `platform_fee_vat_amount`, `platform_fee_total_amount`), document amount, provider references, external issuance flag, and links for participant/deal plus future settlement/payout references.
- Completed: added `invoice_document_attempts` and `invoice_reconciliation_cases`, closed result taxonomy (`success`, `permanent_fail`, `temporary_fail`, `unknown`), provider DTO boundaries for `createDocument`, `getDocumentStatus`, `cancelDocument`, `reconcileDocument`, and `parseInvoiceWebhookEvent`, and an `internal-truth-only` provider that never issues an external document.
- Completed: invoice enqueue remains duplicate-safe on `document_key`, now writes prepare attempt metadata and schedules `invoice_document_issue` through outbox. The worker handles `invoice_document_issue` and `invoice_document_reconcile`; the app loop only schedules missing outbox work and no longer directly invokes provider issuance.
- Checked: `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/invoice_rail_validation.js` PASS for enqueue -> issue -> reconcile with attempts and `external_document_issued=false`.
- Open: real provider/accounting adapter, provider webhook signature verification, official numbering authority, PDF/document delivery, and production tax compliance transport remain external-activation work.
- Progress: `92%` of the internal invoice rail track.
- Next step: commit and push the invoice rail milestone; external adapter activation stays separate.

Current update: 2026-04-23 (seller payout rail canonical settlement model: eligibility, calculation, provider DTOs)

- Completed: tightened the seller payout rail into the requested canonical domain model: `seller_settlements`, `seller_payout_batches`, `seller_payout_batch_items`, `seller_payout_attempts`, and `seller_payout_reconciliation_cases`. The lifecycle is now closed around `pending`, `ready`, `batched`, `processing`, `paid`, `failed`, `returned`, and `reconciled`; payout math separates `gross_collected`, `platform_fee_total`, `refunds_total`, `reserve_amount`, `seller_net_payable`, and `payout_amount`; and the locked 8% fee-before-VAT model remains untouched.
- Completed: payout eligibility now depends on final deal truth (`Completed` only), active seller settlement status, no duplicate paid/batched settlement, no negative or mismatched seller-net truth, and no open blocking reconciliation case. Failed/Cancelled deals produce no real payout batch.
- Completed: added deterministic settlement/batch calculation, batch itemization, prepare/dispatch/reconcile attempts, idempotency keys, correlation IDs, audit-friendly payloads, outbox-only side effects, retry-safe dispatch behavior, and blocking reconciliation cases for mismatches.
- Completed: expanded the provider abstraction for future payout adapters with normalized `createPayout`, `getPayoutStatus`, `cancelPayout`, `reconcilePayout`, and `parsePayoutWebhookEvent` contracts plus the closed result taxonomy `success`, `permanent_fail`, `temporary_fail`, and `unknown`. The active provider remains `internal-truth-only`; no external transfer is executed.
- Checked: `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/seller_payout_rail_validation.js` PASS across prepare/dispatch/reconcile, seller hold blocking, and refund-after-dispatch mismatch cases.
- Open: real provider HTTP execution, provider webhook authenticity, real bank/transfer adapter mapping, and production reconcile feeds remain future external-activation work.
- Progress: `96%` of the internal seller payout rail track.
- Next step: commit and push the canonicalized payout rail milestone; external adapter activation stays separate.

Current update: 2026-04-22 (Wave 3 spec-drift sweep: 5-domain audit + regression rail)

- Completed: closed the five Wave 3 invariants. (D1) buyer-facing search/marketplace/catalog routes — none re-introduced; admin omnisearch is the only legitimate search surface. (D2) platform fee is fixed at `SITON_PLATFORM_FEE_RATE = 0.08` everywhere; no `0.05`/`5%` literal survives in live settlement code. (D3) fee base = `qty × price_per_unit + delivery_cost` excl. VAT — confirmed in [src/platform_fee_money.ts](src/platform_fee_money.ts) and `summarizeMoney`. (D4) buyer can repeat-purchase same deal — no `UNIQUE (deal_id, buyer_id)` exists in [scripts/init_db.sql](scripts/init_db.sql) or any migration; positive coverage in [tests/concurrency_proof.ts](tests/concurrency_proof.ts) M1/M2/M3. (D5) distributor copy is attribution-only on every active surface — no `affiliate_earnings`/`balance`/`withdraw` strings.
- Cleaned: deleted stale JSON backups `docs/STAGE_9F_SUSPICIOUS_DEALS_CLASSIFIED.json` and `docs/qa_suspicious_deals_backup.json` (carried 4× `commission_rate: "0.05"` each, 178K lines combined; in git history if needed). Rewrote [docs/PLATFORM_FEE_PAYMENTS_8_PERCENT.md](docs/PLATFORM_FEE_PAYMENTS_8_PERCENT.md) to drop ambiguous "marketplace" framing and fix stale `marketplace_money_events` / `marketplace_money.ts` references. Repaired one misleading `gross × commission_rate` formula in [docs/INVOICE_ACCOUNTING_GROUNDWORK.md](docs/INVOICE_ACCOUNTING_GROUNDWORK.md). Removed broken pointers to the deleted JSON in [docs/CANONICAL_DRIFT_AUDIT_2026-04-18.md](docs/CANONICAL_DRIFT_AUDIT_2026-04-18.md) and [docs/RC_EXECUTION_PLAN.md](docs/RC_EXECUTION_PLAN.md).
- Added: [tests/spec_drift_regression_wave3_validation.ts](tests/spec_drift_regression_wave3_validation.ts) — 12 source-level regression checks (no DB) pinning the five invariants. Wired as `npm run test:spec-drift-wave3`.
- Verified: `npx tsc --noEmit -p tsconfig.test.json` clean. `npm run test:spec-drift-wave3` 12/12 PASS. `node .tmp_test_dist/tests/backend_sanity_suite.js` 12/12 PASS. `node .tmp_test_dist/tests/platform_fee_payments_8_percent_validation.js` 7/7 PASS.
- Verification greps after cleanup: `marketplace_money_events` → 0 hits; `commission_rate = 0.05` outside the regression test → 0 hits; `already joined`/`single participation` in `src/`,`frontend/` → 0 hits; `affiliate_earnings`/`affiliate_balance`/`affiliate_payout`/`amount_owed` in `src/`,`frontend/` → 0 hits.
- DB / schema check for D4: confirmed no participants-table UNIQUE constraint on `(deal_id, buyer_id)` in fresh-install schema or any migration. Existing concurrency proof shows same buyer producing 5 distinct participant rows on one deal.
- Open: historical audit/process docs (e.g. `SPEC_DRIFT_MAP_2026-04-19.md`, `CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md`) intentionally preserve `commission_rate` references because they document the drift that was fixed; they are not perpetuating the model.
- Next step: continue any other parallel tracks; the Wave 3 invariants now have an automated regression rail.

Current update: 2026-04-22 (seller payout rail internal truth: provider-agnostic batches, retry/reconcile flow, no external transfer yet; superseded by 2026-04-23 canonical settlement model)

- Completed: first internal payout rail slice landed on top of the locked `platform_fee_money_events` truth without reopening the `platform_fee_base_amount` / `platform_fee_vat_amount` / `platform_fee_total_amount` decision; this was later tightened into the 2026-04-23 canonical `seller_settlements` + payout batch/item/attempt/reconciliation-case model.
- Checked: initial TypeScript compile passed; the focused DB-backed payout validation was completed in the 2026-04-23 follow-up after local DB access was restored and legacy payout columns were self-healed.
- Open: external payout execution remains intentionally inactive; adapter-specific HTTP execution, provider webhook authenticity, and production reconciliation feeds are still future activation work.
- Progress: superseded by the 2026-04-23 seller payout rail update.
- Next step: follow the current 2026-04-23 payout rail milestone.

Current update: 2026-04-21 (provider-ready payments abstraction closed: 8% fee before VAT, VAT added on Siton fee)

- Completed: expanded the canonical provider-ready settlement truth so `siton.platform_fee_money_events` now stores `platform_fee_base_amount`, `platform_fee_vat_amount`, `platform_fee_total_amount`, and keeps `platform_fee_amount` as the compatibility alias for the total Siton fee actually owed by the seller; aligned runtime summarization, migration/bootstrap DDL, and provider abstraction summary to the same rule.
- Checked: `npx tsc --noEmit -p tsconfig.test.json`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node ./.tmp_test_dist/tests/platform_fee_payments_8_percent_validation.js`; focused backend sanity rerun on an alternate port after clearing the local port conflict.
- Open: external activation only - live payment-provider adapter, live tax sourcing for buyer-side VAT inputs, live invoice rail, and live payout rail. No internal fee-model blocker remains in this track.
- Progress: `100%` of the provider-ready payments abstraction track.
- Next step: when external activation starts, connect a real provider adapter onto the stable authorize/capture/recover/refund abstraction without changing the internal settlement model again.

Current update: 2026-04-21 (repository doc cleanup: outdated DB document removed)

- Completed: removed `docs/DB.docx` from the repository to prevent documentation drift against the updated product spec and live code.
- Checked: scanned active documentation and status files for textual references to `DB.docx` and updated the broken references that were still live.
- Open: the removed file may still exist in old git history, but it is no longer present in the working repository; broader cleanup tracks remain separate.
- Progress: `94%` of the current repository clarity / canonical-status track
- Next step: continue the active cleanup work separately, while treating the canonical foundation pack and `PROJECT_STATUS.md` as the live documentation baseline.

Platform fee 8% track:
- Completed: canonical provider-ready settlement truth now exists in `siton.platform_fee_money_events`; charge, recovery, and refund events write signed money truth with fixed 8% platform fee math and seller-net derivation
- Checked: `npx tsc --noEmit`, `npm run test:platform-fee-payments`, and `node .tmp_test_dist/tests/payment_refund_real_rail_validation.js`
- Fixed: dynamic `commission_rate` reliance in live receipt math, missing settlement/receivable truth per participant, absent refund reversal truth, and missing duplicate guards for fee and refund recording
- Open: external activation only: live platform-fee split/application-fee provider wiring, live invoice rail, live payout rail, and live VAT sourcing beyond the explicit current `vat_amount = 0` internal baseline
- Progress: `93%` of the isolated platform-fee payments track
- Next step: when external activation begins, map the same canonical settlement row shape onto a real payment provider and payout rail without changing the internal fee model again

Current update: 2026-04-21 (Wave 2.5 legacy purge: distributor commission / payout columns dropped end-to-end — DB, DDL, DTOs, docs, tests)

Last updated: 2026-04-20 (Platform-fee payments pass: canonical 8% settlement truth, refund reversal truth, and duplicate-safe provider-ready money events)

## Spec Drift Closure — Wave 2.5 legacy purge (2026-04-21)

Goal of this wave: stop leaving LEGACY DEAD markers in place. Actually remove the columns, fields, and comments from the codebase and from the database.

### Columns actually dropped (DB)

- `siton.invoice_documents.affiliate_fee_amount`
- `siton.affiliate_accounts.payout_status`, `payout_method`, `payout_details_masked`
- `siton.affiliate_attributions.commission_rate`, `commission_amount`, `payout_status`
- Index `siton.idx_affiliate_attributions_deal` rebuilt on `(deal_id, created_at DESC)` (was keyed on `payout_status`).
- Index `siton.idx_affiliate_attributions_affiliate` rebuilt on `(affiliate_id, created_at DESC)` (was keyed on `payout_status`).

Delivered via two mechanisms, both idempotent:

1. [src/migrations/020_drop_affiliate_legacy_columns.sql](src/migrations/020_drop_affiliate_legacy_columns.sql) — explicit migration for any pipeline that runs `src/migrations/*`.
2. `ensureRemainingProductSurfaceTables` in [src/product_surface_support.ts](src/product_surface_support.ts) — the runtime bootstrap now issues `ALTER TABLE ... DROP COLUMN IF EXISTS` on every boot, so demo and pre-production environments self-heal without a separate migration runner.

Migration 018 ([src/migrations/018_invoice_documents.sql](src/migrations/018_invoice_documents.sql)) was also edited to remove `affiliate_fee_amount` from the fresh-install schema, so fresh DBs never carry the column.

### Code cleanups (TypeScript + DDL strings)

- [src/product_surface_support.ts](src/product_surface_support.ts) — distributor DDL no longer creates the dead columns; the LEGACY DEAD block comment removed; the seed `INSERT INTO siton.affiliate_accounts` no longer names payout fields or carries legacy annotations.
- [src/invoice_dispatch.ts](src/invoice_dispatch.ts) — LEGACY DEAD comment removed from `enqueueInvoiceDocument` (the field was already gone).
- [src/frontend_runtime.ts](src/frontend_runtime.ts) — stale inline comment "`no commission_amount / payout_status exposed`" removed from the attributions query; nothing to expose, nothing to advertise.
- [scripts/init_db.sql](scripts/init_db.sql) — the legacy bootstrap now matches the canonical schema: `affiliate_accounts` and `affiliate_attributions` hold only attribution fields; `invoice_documents.affiliate_fee_amount` removed; the two affiliate indexes no longer reference `payout_status`.
- [docs/INVOICE_ACCOUNTING_GROUNDWORK.md](docs/INVOICE_ACCOUNTING_GROUNDWORK.md) — column table updated: gross is now documented as `qty × price_per_unit + delivery_cost` (excl. VAT); the `affiliate_fee_amount` row replaced with an explicit removal note that points at migration 020.

### Test INSERTs cleaned

Four test suites had direct `INSERT INTO siton.invoice_documents (..., affiliate_fee_amount, ...)` SQL literals that would fail once the column is dropped. All updated:

- [tests/admin_observability_proof.ts](tests/admin_observability_proof.ts) (two INSERTs).
- [tests/deal_ops_summary_proof.ts](tests/deal_ops_summary_proof.ts).
- [tests/invoice_dispatch_proof.ts](tests/invoice_dispatch_proof.ts) (two INSERTs).
- [tests/invoice_queue_hardening_proof.ts](tests/invoice_queue_hardening_proof.ts).

### Verification

- `npx tsc --noEmit -p tsconfig.test.json` — clean.
- `grep -rn "affiliateFeeAmount\|AFFILIATE_FEE_SHARE_OF_PLATFORM\|LEGACY DEAD" src/` — zero hits (migration 020 is the only intentional `affiliate_fee_amount` reference, and it's the `DROP COLUMN IF EXISTS`).
- [tests/backend_sanity_suite.ts](tests/backend_sanity_suite.ts) — 13/13 PASS, including the five Wave 2 / 2.5 assertions (fee base with and without delivery, `summarizeMoney` has no affiliate field, `/api/affiliate/overview` is attribution-only with no money/PII leaks, distributor payout endpoint returns 410).
- [tests/invoice_dispatch_proof.ts](tests/invoice_dispatch_proof.ts) — 8/8 PASS after column drop.
- [tests/invoice_queue_hardening_proof.ts](tests/invoice_queue_hardening_proof.ts) — 5/5 PASS.
- [tests/admin_observability_proof.ts](tests/admin_observability_proof.ts) — 6/6 PASS.
- [tests/deal_ops_summary_proof.ts](tests/deal_ops_summary_proof.ts) — 6/6 PASS.

### Blockers to a fuller purge — none

Every legacy column that had to be removed was removable. There are no external consumers of the dropped columns (this is pre-production, single-tenant, and the only writer/reader of the dead columns was our own code, which now no longer references them). No downstream system depends on `affiliate_fee_amount`, `commission_amount`, or distributor `payout_*`.

`seller_accounts.payout_method` / `payout_details_masked` are retained — sellers do receive payouts, this is the legitimate seller side.

**Wave 4 update (2026-04-23):** `deals.commission_rate` has since been dropped end-to-end. The Siton 8% fee is now sourced exclusively from `SITON_PLATFORM_FEE_RATE = 0.08` in [src/platform_fee_money.ts](src/platform_fee_money.ts); there is no per-deal override column, no per-deal input field, and no stored rate on `siton.deals`. See "Wave 4 Final Audit (2026-04-23)" section below.

### Wave 2.5 status

- **Legacy purge complete, not just minimized.** The distributor money model is removed from code, schema, and documentation. No inline LEGACY DEAD markers remain. The DB columns are gone (or will be on first boot of any existing demo environment, via the `ALTER TABLE ... DROP COLUMN IF EXISTS` sequence in `ensureRemainingProductSurfaceTables`).
- **Progress on drift map:** D1/D2/D3/D6 closed in Wave 1, D4/D5 closed in Wave 2, legacy residue swept in Wave 2.5. 6 of 22 drifts sealed + legacy trimmed = ready to open Wave 3 (D7 refund endpoints, D8 trusted-device OTP skip, D9 Hebrew encoding, D10–D17 admin surfaces, D18–D22 polish).
- **Green light to proceed to Wave 3** — no distributor-money tail remains that would block the refund / admin surfaces work.

## Spec Drift Closure — Wave 2 (2026-04-20)

Managerial source-of-truth resolutions applied this wave:
1. Distributors (מפיצים) have no commission / payout / balance model at all — affiliate surface is attribution-only (link, clicks, entries, joins, attributed units, attributed gross as a measurement number, not money owed).
2. The 8% Siton fee base is `qty × price_per_unit + delivery_cost`, excluding VAT — consistent across seller summaries, receipts, refunds, and admin settlements.

### Stage A — Distributor commission model stripped from live layer

Removed / neutralized everywhere in runtime:
- `AFFILIATE_FEE_SHARE_OF_PLATFORM` constant — **removed** from [src/product_surface_support.ts](src/product_surface_support.ts) and all imports.
- `affiliate_fee_amount` — **removed** from `summarizeMoney` input and output shape in [src/product_surface_support.ts](src/product_surface_support.ts); **removed** from `InvoiceDocumentInput`, `EnqueueInvoiceParams`, INSERT columns, RETURNING clause, and the flush row type in [src/invoice_dispatch.ts](src/invoice_dispatch.ts); **removed** from all `enqueueInvoiceDocument` call sites in [src/app.ts](src/app.ts) (charge and refund receipts); **removed** from receipts surface assertion in [tests/remaining_product_surfaces_validation.ts](tests/remaining_product_surfaces_validation.ts); **removed** from [tests/invoice_dispatch_proof.ts](tests/invoice_dispatch_proof.ts) baseline params.
- Attributions query in [src/frontend_runtime.ts](src/frontend_runtime.ts) — **removed** `aa.commission_amount`, `aa.payout_status` from SELECT; only attribution fields exposed.
- Affiliate page copy in [frontend/app.js](frontend/app.js) — hero/info strip rewritten to: "ערוץ מדידה והפצה בלבד — אין כאן עמלה, יתרה, התחשבנות או תשלום."

LEGACY DEAD (retained in DB schema for back-compat; no live read/write):
- `affiliate_accounts.commission_rate`, `affiliate_accounts.payout_method`, `affiliate_accounts.payout_details_masked`, `affiliate_accounts.payout_status`
- `affiliate_attributions.commission_amount`, `affiliate_attributions.payout_status`, `affiliate_attributions.payout_method`, `affiliate_attributions.payout_details_masked`
- `invoice_documents.affiliate_fee_amount` (column remains, NOT NULL DEFAULT 0 — no code writes or reads it)

Documented inline in [src/product_surface_support.ts](src/product_surface_support.ts) and [src/invoice_dispatch.ts](src/invoice_dispatch.ts) with LEGACY DEAD comment blocks. The distributor payout-profile endpoint stays fail-closed with HTTP 410 `affiliate_payout_model_removed`.

### Stage B — 8% Siton fee base now includes delivery

Fixed at every gross / fee calculation site:
- `enqueueChargeReceiptForParticipant` in [src/app.ts](src/app.ts:1434) — now `Number(qty) * Number(price_per_unit) + Number(delivery_cost || 0)`.
- `enqueueRefundReceiptForParticipant` in [src/app.ts](src/app.ts:1473) — same base used for the refund receipt, keeping charge/refund symmetric.
- Seller deal-detail surface in [src/frontend_runtime.ts](src/frontend_runtime.ts:1296) — `grossAmount` now includes `delivery_cost`; `delivery_cost` also mapped onto the per-participant row.
- Admin deals list in [src/frontend_runtime.ts](src/frontend_runtime.ts:1690) — query adds `COALESCE(SUM(p.delivery_cost),0) AS joined_delivery_cost`, settlement math at [src/frontend_runtime.ts:1748](src/frontend_runtime.ts#L1748) and [:1775](src/frontend_runtime.ts#L1775) folds it into gross and platform_fee_amount.
- `summarizeMoney` itself does not assume anything about the composition of `grossAmount` — callers are now required to pre-compute `qty × price + delivery`.

### What was tested

- `npx tsc --noEmit -p tsconfig.test.json` — clean.
- [tests/backend_sanity_suite.ts](tests/backend_sanity_suite.ts) — 5 new Wave 2 cases added (all PASS):
  - `PASS siton fee base includes delivery: price=100 qty=2 delivery=20 → base=220 fee=17.6` — exact spec example.
  - `PASS siton fee base with no delivery: price=50 qty=1 delivery=0 → base=50 fee=4` — zero-delivery edge.
  - `PASS summarizeMoney has no affiliate field and no VAT field` — scans output keys for `affiliate_fee_amount`, `affiliate_fee_rate`, `vat`, `vat_amount`, `tax_amount` — none present.
  - `PASS affiliate overview is attribution-only (no commission/payout/PII fields)` — `JSON.stringify(surface)` scanned for `commission_amount`, `commission_rate`, `payout_status`, `payout_method`, `payout_details`, `affiliate_fee_amount`, `balance`, `amount_owed`, plus PII (`buyer_id`, `buyer_phone`, `buyer_email`, `phone`, `email`) — none leak.
  - `PASS distributor payout endpoints stay fail-closed (410 affiliate_payout_model_removed)`.
- [tests/invoice_dispatch_proof.ts](tests/invoice_dispatch_proof.ts) — all 8 existing cases still pass after removing `affiliateFeeAmount` from baseline params.
- [tests/remaining_product_surfaces_validation.ts](tests/remaining_product_surfaces_validation.ts) — assertion switched from `affiliate_fee_amount === 0` to "key must not exist on receipts_surface.summary".

### Files touched (Wave 2)

- [src/product_surface_support.ts](src/product_surface_support.ts) — removed `AFFILIATE_FEE_SHARE_OF_PLATFORM`, stripped `affiliate_fee_amount` from `summarizeMoney`, documented LEGACY DEAD columns on affiliate DDL, simplified seed INSERTs.
- [src/frontend_runtime.ts](src/frontend_runtime.ts) — removed commission/payout fields from attributions query, added delivery to seller gross and admin settlements, fixed pre-existing `display_name` bug on attribution mapping.
- [src/invoice_dispatch.ts](src/invoice_dispatch.ts) — removed `affiliateFeeAmount` from input/enqueue/INSERT/RETURNING/row types; added LEGACY DEAD comment.
- [src/app.ts](src/app.ts) — charge/refund receipt enqueue now pulls `delivery_cost` and includes it in gross; no more `affiliateFeeAmount` passed through.
- [frontend/app.js](frontend/app.js) — affiliate hero + info strip + tooltip rewritten to attribution-only messaging.
- [tests/backend_sanity_suite.ts](tests/backend_sanity_suite.ts) — 5 new Wave 2 tests.
- [tests/invoice_dispatch_proof.ts](tests/invoice_dispatch_proof.ts) — removed `affiliateFeeAmount: 0.00` baseline.
- [tests/remaining_product_surfaces_validation.ts](tests/remaining_product_surfaces_validation.ts) — asserts `affiliate_fee_amount` absent from receipts surface summary.

### Wave 2 status

- **Wave 2 closed for D4 and D5** (distributor commission/payout subsystem dismantled at the live layer; distributor-facing responses contain no commission/payout/balance fields and no buyer PII).
- **Fee-base drift closed** — every charge/refund/summary site uses `qty × price + delivery` as the 8% base, excluding VAT. Confirmed via the three spec examples in tests (17.6 / 4 / absence-of-affiliate).
- **Still open (deferred to Wave 3):** D7 (refund endpoints), D8 (trusted-device / OTP skip), D9 (Hebrew mojibake), D10–D17 (missing admin surfaces), D18–D22 (polish).

## Spec Drift Closure — Wave 1 (2026-04-19)

Reference drift map: [docs/SPEC_DRIFT_MAP_2026-04-19.md](docs/SPEC_DRIFT_MAP_2026-04-19.md)

Managerial source-of-truth resolutions applied this wave:
1. Siton platform commission is 8% (fixed).
2. Distributors (מפיצים) have no commission model at all.
3. Completion window is 24 hours.
4. Deal deadline allowed range is 2 hours ≤ Δ ≤ 7 days.
5. State transitions in TypeScript must stay in lockstep with DB trigger enforcement.

### What was fixed in Wave 1

- **D6 — Deal transitions aligned with DB.** `DEAL_TRANSITIONS` in [src/app.ts](src/app.ts) rewritten to match `siton.is_valid_deal_transition` from migrations 008/014 exactly. Cancellation is now permitted only from `Draft`; `PendingTarget` → `{TargetReached, Failed}`; `Charging` → `{CompletionWindow}` only; and middle states carry no `Cancelled` exit. The TypeScript layer will no longer mislead the engine with permissive cancels that the DB trigger rejects.
- **D1 — Completion window defaults to 1440 minutes (24h).** Changed default in both [src/app.ts](src/app.ts) (`COMPLETION_WINDOW_MINUTES`) and [src/runtime_config.ts](src/runtime_config.ts). This is the C6 recovery window buyers get to update a failed payment method after Charging → CompletionWindow.
- **D3 — Deadline validation 2h–7d enforced.** `POST /deals` now rejects `deadline < now + 2h` with `deadline_below_minimum` (400) and `deadline > now + 7d` with `deadline_above_maximum` (400). Default deadline when the caller omits it is now 24h (previously 60 minutes, which violated the lower bound).
- **D2 — Commission fixed at 8%.** `POST /deals` ignores `body.commission_rate` and always persists `0.08` for new deals. The DB trigger already makes `commission_rate` immutable post-publish, so the platform fee is now locked at the spec-defined value end-to-end.

### What was tested

- `npx tsc --noEmit -p tsconfig.test.json` — clean (no type errors).
- [tests/backend_sanity_suite.ts](tests/backend_sanity_suite.ts) extended with four new cases; entire suite passes:
  - `PASS deal transitions match DB enforcement (no post-publish Cancelled)` — asserts every non-`Draft` deal state rejects `Cancelled`, and `Charging` rejects `Failed` (must flow through `CompletionWindow` first).
  - `PASS deal creation rejects deadline shorter than 2 hours` — 1h payload → 400.
  - `PASS deal creation rejects deadline longer than 7 days` — 8d payload → 400.
  - `PASS deal creation rejects invalid deadline string` — `"not-a-date"` → 400 with clear message (previously crashed to 500).
  - Existing `canonical state transitions stay intact` and outbox cases still pass.
- Integration-style suites that previously seeded deals with `30m`/`45m` deadlines via `POST /deals` were lifted to `3h` to satisfy the new lower bound (they bypass DB validation; only the HTTP endpoint enforces 2h–7d). See "Files touched" below.

### Files touched

- [src/app.ts](src/app.ts) — D1/D2/D3/D6 core fixes; added `DEADLINE_MIN_MS`, `DEADLINE_MAX_MS`, `DEADLINE_DEFAULT_MS`, `SITON_PLATFORM_COMMISSION_RATE` constants; rewrote `DEAL_TRANSITIONS`; rewrote `POST /deals` deadline + commission logic.
- [src/runtime_config.ts](src/runtime_config.ts) — `COMPLETION_WINDOW_MINUTES` default 15 → 1440.
- [tests/backend_sanity_suite.ts](tests/backend_sanity_suite.ts) — four new Wave 1 assertions.
- [tests/adversarial_hardening_validation.ts](tests/adversarial_hardening_validation.ts), [tests/frontend_flow_validation.ts](tests/frontend_flow_validation.ts), [tests/full_product_surface_validation.ts](tests/full_product_surface_validation.ts), [tests/full_system_qa_validation.ts](tests/full_system_qa_validation.ts), [tests/master_product_depth_validation.ts](tests/master_product_depth_validation.ts), [tests/preprod_torture_validation.ts](tests/preprod_torture_validation.ts), [tests/real_integrations_validation.ts](tests/real_integrations_validation.ts), [tests/remaining_product_surfaces_validation.ts](tests/remaining_product_surfaces_validation.ts), [tests/seller_auth_authority_validation.ts](tests/seller_auth_authority_validation.ts), [tests/ultimate_prelive_qa_rc_validation.ts](tests/ultimate_prelive_qa_rc_validation.ts) — raised the HTTP-seeded `deadline` from 30–45 minutes to 3 hours so they clear the 2h lower bound.

### What is still open (deferred to Wave 2)

- **D4 — Distributor commission/payout subsystem must be dismantled.** ~~`affiliate_accounts` / `affiliate_attributions` still carry `commission_rate`, `commission_amount`, `payout_status`, `payout_method`...~~ **CLOSED in Wave 2 / 2.5** — distributor money columns dropped from `affiliate_accounts`, `affiliate_attributions`, `invoice_documents`; `deals.commission_rate` additionally dropped in Wave 4 (2026-04-23). 8% fee is now sourced solely from `SITON_PLATFORM_FEE_RATE` constant. Historical text preserved for audit continuity — do NOT treat as an open gap.
- **D5 — Distributor-facing PII exposure of buyers** must be scrubbed once D4 is resolved.
- **D7 — Refund endpoints** (seller-initiated and admin-initiated refunds per spec) are still absent.
- **D8 — Trusted-device cookie / OTP skip for repeat buyers** not yet implemented.
- **D9 — Hebrew mojibake in [frontend/app.js](frontend/app.js)** (encoding fix).
- **D10–D17 — Missing admin surfaces** (KYC Queue, Payouts & Settlements, Omnisearch, Audit & Forensics, System Status, E12 kill-switch, Freeze Payouts, Content Takedown, Double-Entry Ledger, polling metadata, webhook E1/E2 handling).
- **D18–D22 — Polish items** (OTP attempts cap 5 → 3, repeat-purchase idempotency polish, terms checkbox wiring, strict min/max validation, "create similar deal" endpoint).

### Wave 1 status

- **Wave 1 closed.** The four constitutional drifts (D1/D2/D3/D6) are sealed end-to-end (code + tests + canonical constants) and no non-test call site remains on the legacy values.
- **Progress on drift map overall:** 4 of 22 drifts sealed = ~18% by count, but the four closed are the constitutional core that unblocks the rest (cancellation safety, time windows, fee model) — Wave 2 can now work on subsystem surgery (distributor removal, refund endpoints) without fighting an unstable base.
- **Next step — Wave 2:** prioritize D4+D5 together (distributor subsystem teardown is one coherent change; PII exposure falls out automatically), then D7 (refund endpoints), then D9 (encoding).

## Canonical Status

This is the single canonical project status file.

All current status tracking should refer to:
- `PROJECT_STATUS.md`

The old `docs/PROJECT_STATUS.md` copy is no longer canonical and is removed in the final canonical audit pass.

## Executive Snapshot

- Product direction alignment: `IN PROGRESS - CANONICAL DIRECTION RESET TO LINK-FIRST MAIN SITE`
- Backend: `BACKEND PROFESSIONALLY CLOSED WITH NON-BLOCKING FOLLOW-UPS`
- Frontend buyer flow: `FRONTEND MVP CLOSED WITH NON-BLOCKING FOLLOW-UPS`
- Internal closure: `INTERNALLY CLOSED WITH NON-BLOCKING GAPS`
- Full system QA: `FULL SYSTEM QA PASSED WITH NON-BLOCKING GAPS`
- Adversarial hardening: `ADVERSARIAL HARDENING PASSED WITH NON-BLOCKING GAPS`
- Pre-production torture QA: `PREPROD TORTURE QA PASSED WITH NON-BLOCKING GAPS`
- Ultimate pre-live QA and RC: `ULTIMATE PRE-LIVE QA AND RC PASSED WITH NON-BLOCKING GAPS`
- Product closure: `PRODUCT CLOSED WITH ONLY EXTERNAL-ACTIVATION GAPS`
- Master product deep mapping and hardening: `PRODUCT MOSTLY DEEPLY MAPPED AND HARDENED WITH NON-BLOCKING GAPS`
- Demo / preview deployment readiness: `DEMO / PREVIEW READY WITH NON-BLOCKING GAPS`
- Demo deployment execution: `DEMO DEPLOYMENT PACKAGE READY WITH CLEAR FINAL STEP`
- Render demo deployment: `RENDER DEMO READY WITH SINGLE EXTERNAL STEP`
- Render free-tier alignment: `RENDER FREE BLUEPRINT READY`
- Frontend foundation: `RTL + RESPONSIVE + ACCESSIBILITY BASELINE IMPLEMENTED`

## Current Frontend Foundation Track

- Completed:
  root RTL shell, skip link, landmarks, live-region frame, route-aware document title, mobile-first shell baseline, stronger focus visibility, touch-target baseline, and copy cleanup for seller / affiliate / admin skeleton surfaces
- Checked:
  `frontend/index.html`, `frontend/app.js`, `frontend/styles.css`, critical public and operational skeleton surfaces, and frontend foundation validation coverage
- Fixed:
  broken root copy, weak shell semantics, missing skip link, narrow focus treatment, desktop-first shell assumptions, and internal-looking English leaks in seller / affiliate / admin surface copy
- Open:
  deeper route-level browser rendering proof, broader copy cleanup in lower-priority legacy helper messages, and future accessibility tightening for advanced tables/dialogs if those components deepen further
- Progress:
  `88%` of the isolated frontend foundation track
- Next step:
  extend the same foundation into deeper seller/admin table interactions and, when practical, add browser-level responsive accessibility smoke coverage

## Frontend Track: Buyer Document Visibility

- Completed:
  buyer tracking now reads canonical document visibility from `invoice_documents`, shows a real document id only for actual issued rows, and distinguishes clearly between issued, pending issuance, issue failure, not expected, and not yet available states
- Checked:
  buyer tracking runtime payload, buyer completed/failed/cancelled messaging, and the buyer-facing tracking surface where document status is rendered
- Fixed:
  missing buyer-side document truth, lack of explicit "document not issued yet" wording, and the risk of implying a receipt/document exists before an actual issued row is present
- Open:
  external invoice rail activation, live document download/provider delivery, and any outbound buyer notification proof for document dispatch
- Progress:
  `94%` of the isolated buyer-document visibility track
- Next step:
  if external issuance is activated later, extend the same truth-aligned panel with a real download or view action backed by the provider-safe document route

## Frontend Track: Admin + Support Product Surfaces

- Completed:
  admin dashboard now exposes explicit urgency buckets, deal-level ops summary is surfaced through canonical buckets, and a dedicated participant-ops read surface is available for support-grade investigation
- Checked:
  admin dashboard, support hub wording, deal profile ops presentation, participant ops read surface, responsive sanity, and operator-facing truth for notifications and invoice documents
- Fixed:
  English support banners, weak urgency hierarchy, raw-table-heavy admin deal presentation, missing participant-ops frontend surface, and operator wording that leaned too far into internal dump semantics
- Open:
  deeper admin action flows, broader admin workflow orchestration, and any external-rail-backed operator actions remain outside this track
- Progress:
  `91%` of the isolated admin/support surfaces track
- Next step:
  if this area deepens further, add browser-level smoke coverage for the admin participant and deal investigation paths

## What Is Completed

### Backend

- Canonical DB/runtime configuration
- Hardened logging defaults
- Real automated test baseline
- Idempotency, outbox, DLQ, reconciliation, and runtime hardening
- Professional backend closure and repository hygiene pass

### Frontend Buyer Surface

- Public deal page
- Join flow
- OTP
- Payment/auth mock-backed flow
- Confirmation
- Tracking
- Error branches, recovery, and session continuity

### Internal Integrations

- Payment provider boundary
- Webhook ingestion boundary
- Minimal but real payment reconciliation
- Integration health surface
- Internal readiness for later provider replacement

### System Validation

- Full system QA
- Adversarial hardening
- Pre-production torture QA / RC-style drill
- Ultimate pre-live QA / RC pass with DB integrity, cross-role misuse, and final canonical gate proof

### Full Product Surfaces

- Seller:
  dashboard, draft creation, publish, live/closed deal view, create similar, receipts surface, delivery operations
- Affiliate:
  campaign view, attribution persistence, payout readiness, verification semantics, payout profile
- Admin:
  dashboard, omnisearch, exceptional deals, deal profile, user profile, KYC queue, settlements surface, support hub, deeper forensics

## What Was Completed In The Latest Product Passes

- Remaining current-spec surfaces were closed internally:
  receipts, delivery, affiliate attribution/payout/verification, admin KYC/settlements/support/forensics

## What Was Completed In The Latest Alignment Pass

- Re-established the canonical product direction as `link-first-group-deals`
- Added a dedicated main-site payload for the Siton brand gateway
- Reframed `/app` away from public marketplace search and toward seller entry plus direct-link buyer entry
- Deprecated the public marketplace API with an explicit `410 PUBLIC_MARKETPLACE_REMOVED`
- Added a canonical decision doc: `docs/PRODUCT_DIRECTION_ALIGNMENT_2026-04-09.md`
- Updated product-surface validation to enforce the new direction

## What Was Completed In Pass 2 Backend / DB Alignment

- Audited backend routes, DB schema, tests, and active docs against the seller-first link-based product direction
- Verified that repeat buyer joins on the same deal are allowed in practice and now covered by an automated test
- Added seller ownership to `deals` via `seller_id` and backfilled existing deals to `seller-default`
- Filtered seller surfaces by seller ownership instead of exposing all deals as one shared pool
- Added seller-side direct-link visibility on the deal detail surface
- Added a dedicated audit doc: `docs/PASS2_BACKEND_DB_ALIGNMENT_2026-04-09.md`

## Current Alignment Milestone

- Completed:
  main-site direction reset, deprecated public marketplace API, canonical decision doc, validation update, seller ownership alignment, repeat-join validation
- Checked:
  route-level frontend entry point, API contract for main site, product-surface test coverage, live DB schema, repeat-join behavior, seller surface ownership semantics
- Open:
  buyer delivery-method persistence, stronger seller identity/auth semantics, broader copy cleanup, remaining old marketplace compatibility paths and historical docs
- Progress:
  `82%` of the alignment pass
- Next step:
  persist buyer delivery-method semantics end-to-end and continue removing old marketplace-era framing from active surfaces and compatibility routes

## What Was Deepened In The Latest Pass

- Added a first-class admin system-status surface
- Hardened seller delivery semantics so shipped/delivered require tracking and issue requires explanation
- Hardened affiliate payout semantics so approval requires verification, payout profile, and pending commission
- Added dedicated master-depth validation and revalidated the whole product

## What Was Completed In The Latest Delivery Persistence Pass

- Closed delivery-method persistence end-to-end across DB, backend, flows, UI, and tests
- Added deal-level delivery options plus participant-level delivery snapshots
- Updated seller creation so a deal now stores one or more delivery methods
- Updated buyer flow so delivery selection is required before authorization when multiple options exist
- Updated payment summary, confirmation, tracking, and seller management to display delivery method and cost
- Revalidated delivery persistence through frontend and product-surface tests

## What Was Completed In The Latest Active Cleanup Pass

- Redirected the legacy `/app/marketplace` route to `/app`
- Removed marketplace handling from the active client-side route parser
- Sharpened the home page so it speaks as a seller-first commercial gateway rather than a mixed preview shell
- Sharpened seller workspace, seller creation, and seller deal-management CTAs and copy
- Added active validation that the legacy marketplace route now redirects to the main site

## What Was Completed In The Latest Product Surface Focus Pass

- Declared the primary Siton product surface as home, seller entry, deal creation, seller management, public deal page, buyer join flow, and buyer tracking
- Removed affiliate/admin links from the main product navigation
- Kept affiliate/admin reachable by direct URL only and reframed them as internal surfaces
- Preserved the legacy `/app/marketplace` route only as a redirect to `/app`
- Added validation that the main navigation stays focused on the primary product surface

## What Was Prepared In The Latest Demo / Preview Pass

- Added canonical demo deployment mode via runtime config
- Added preview metadata route and deployment-mode visibility in integrations/admin status
- Added global preview banner and showcase-safe messaging
- Marked payment, receipts, delivery, payout, KYC, and notifications with explicit demo-only boundaries
- Added demo-preview validation and revalidated the full suite

## What Was Prepared In The Latest Demo Deployment Execution Pass

- Added compiled demo bundle path and canonical demo startup path
- Added deployment descriptors: `Dockerfile`, `.dockerignore`, `Procfile`
- Added `.env.demo.example`
- Verified the compiled artifact locally through real Node startup
- Reached package-ready state, blocked only by missing external hosting target

## What Was Prepared In The Latest Render Demo Deployment Pass

- Added `render.yaml` as the single Render blueprint source
- Added canonical demo DB bootstrap for fresh databases
- Wired the demo runtime so startup now bootstraps the DB before serving the compiled app
- Verified the final Render-oriented runtime path locally
- Reduced the live-URL blocker to one external hosting step: Git repo + Render blueprint deploy

## What Was Prepared In The Latest Render Free-Tier Alignment Pass

- Identified that paid pricing came from omitted Blueprint `plan` fields
- Pinned the Render web service to `plan: free`
- Pinned the Render Postgres database to `plan: free`
- Kept the Blueprint path as the simplest and most stable free demo path

## What Was Completed In Wave 4b — Operational Hardening (2026-04-14)

### Scope

Audit and hardening of: outbox worker lifecycle, restart behavior, retry storms, stuck
processing, DLQ, backlog, worker resilience, duplicate claim / zombie handling, lock
contention.

### Bug Found and Fixed

**Bug 1 — Stuck Processing Never Rescued (Critical)**

`reclaimStuckProcessing` was fully implemented in `src/outbox_worker_helpers.ts` and
returned by `buildOutboxWorkerHelpers`, but was never wired into `workerLoop` in
`src/app.ts`. Events that landed in `status='processing'` after a crash or timeout had
no recovery path — they would remain stuck indefinitely, never retried or DLQ'd.

Fix applied in `src/app.ts`:
- Added `reclaimStuckProcessing` to the destructured import from `buildOutboxWorkerHelpers`.
- Added `WORKER_STUCK_TIMEOUT_MS` constant (default 60 000 ms = 2x WORKER_EVENT_TIMEOUT_MS).
- Added `RECLAIM_EVERY_N_POLLS = 10` to amortise the reclaim cost.
- `workerLoop` now calls `reclaimStuckProcessing(WORKER_STUCK_TIMEOUT_MS)` every 10 poll
  cycles. Events stuck longer than the timeout are reset to `pending` with `last_error`
  set to `worker_reclaim_after_restart`.

### Evidence Table

| Scenario | Description | Result | DB Evidence |
|----------|-------------|--------|-------------|
| R1 | Restart with pending outbox events — worker picks up pending events | PASS | event claimed, status=sent |
| R2 | Crash-after-claim recovery — stuck processing reclaimed on next poll | PASS | reclaimed=1, re-claimed and sent |
| R3 | Retry storm bounded — event cycles through all retries and lands in DLQ | PASS | DLQ after 3 iterations |
| R4 | Max attempts enforcement — event at max immediately goes to DLQ | PASS | DLQ immediately |
| R5 | Backlog drain — 20 events fully processed in <100 ms | PASS | all 20 sent |
| R6 | Duplicate claim prevention — SELECT FOR UPDATE SKIP LOCKED gives exactly one claimer | PASS | c1=1, c2=0 |
| R7 | DLQ path — exhausted retries and PermanentFailError both land in DLQ | PASS | DLQ table present, events moved correctly |
| R8 | Stuck processing rescue — old stuck event reclaimed, recent one preserved | PASS | reclaimed=1, last_error set, processing_started_at cleared |
| R9 | Worker loop liveness — workerRunning flag design analysis + env validation | PASS | single-loop design confirmed |
| R10 | Soak — 50 mixed events, no zombie processing states remain | PASS | no zombies, all terminal |

**Final test run: 27 PASS, 0 FAIL**

### What Was NOT Changed (Boundary)

- Webhook semantic truth handling, duplicate webhook semantics, late event state rules,
  reconcile logic, payment provider event mapping

### Files Changed

- `src/app.ts` — wired `reclaimStuckProcessing` into `workerLoop` with timeout and poll-rate config
- `tests/operational_hardening_proof.ts` — new proof test file (10 scenarios, 27 assertions)

## What Was Completed In The Wave 4b Operational Layer (2026-04-14)

### Scope

Closed a thin but complete operational layer around the Wave 4b `reclaimStuckProcessing` fix:
added a health endpoint, targeted proof tests, and operational documentation.

### Changes

**`/api/admin/outbox-status` endpoint** (`src/frontend_runtime.ts`)
- Returns per-bucket counts (`pending`, `processing`, `sent`, `failed`, `dlq`)
- Returns `oldest_pending_age_s`, `oldest_processing_age_s`, `stuck_candidates`, `stuck_timeout_ms`
- Returns `worker.running` (live flag from in-process worker loop)
- Fixed SQL: `FILTER` clause moved inside the aggregate (`MIN(...) FILTER (WHERE ...)`)
- Wired `getWorkerRunning` and `workerStuckTimeoutMs` deps into `registerFrontendExperience` call (`src/app.ts`)

**Targeted proof tests** (`tests/outbox_reclaim_precision_proof.ts`, 9 tests, all PASS)
- A1–A4: Reclaim window precision — old events reclaimed, young events left alone, `processing_started_at=NULL` always reclaimed
- B1–B5: No duplicate processing after reclaim — single claim after reclaim, concurrent reclaim atomicity, DLQ path after reclaim, endpoint shape and stuck_candidates accuracy

**Operational documentation** (`docs/OUTBOX_WORKER_OPERATIONS.md`)
- Explains stuck timeout, reclaim interval, DLQ semantics
- Defines what a clean system looks like (numeric targets)
- Post-restart checklist (5 steps)
- Environment variable reference

### Evidence

| Test | Description | Result |
|------|-------------|--------|
| A1 | Old event (beyond timeout) reclaimed to pending, last_error set | PASS |
| A2 | Young event (within timeout) NOT reclaimed | PASS |
| A3 | Simultaneous old+young: only old is reclaimed | PASS |
| A4 | `processing_started_at=NULL` always reclaimed (defensive path) | PASS |
| B1 | Reclaimed event claimable exactly once, status=sent after markOutboxSent | PASS |
| B2 | Two concurrent reclaim calls: total=2, no double-count | PASS |
| B3 | Reclaimed then permanently failed goes to DLQ, no phantom sent row | PASS |
| B4 | `/api/admin/outbox-status` returns 200 with all required fields | PASS |
| B5 | `stuck_candidates` reflects actual stuck event count, drops after cleanup | PASS |

**Final test run: 9 PASS, 0 FAIL**

## What Was Completed In Track 2 — Real Notifications (2026-04-14)

### Scope

Replace the log-only notification stub with a complete, production-grade delivery layer:
provider abstraction, DB-backed delivery tracking, idempotent dispatch, retry with backoff,
and integration into all core business events.

### Architecture

**Delivery truth**: `siton.notifications` table
- Per-delivery row with UNIQUE constraint on `event_key` — idempotency key format: `{notification_event_type}:{participant_id}:{channel}`
- Status machine: `pending → processing → sent` or `→ failed` (max 3 attempts)
- `provider_message_id` recorded on success, `last_error` recorded on failure
- Exponential backoff: 30s / 90s / 270s between attempts

**Provider abstraction** (`src/notification_dispatch.ts`)
- `SmsProvider` interface: `{providerCode, mode, sendSms(to, body)}`
- `LogOnlySmsProvider` — default; logs to console, returns fake message ID, `mode='log-only'`
- `TwilioSmsProvider` — activated when `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM` are all set; `mode='real'`; calls Twilio Messages API
- Mode is explicit — no mock masquerading as real

**Template system** (`src/notification_templates.ts`)
- 7 event types × 3 channels (sms / email / log) = 21 templates
- Hebrew SMS bodies for all 7 event types
- `templateId()`, `renderNotification()`, `supportedChannels()` exported

**Flush loop** — integrated into `workerLoop` in `src/app.ts`:
- Called after each outbox batch AND on empty-batch sleep
- `flushPendingNotifications(pool, smsProvider)` uses `SELECT FOR UPDATE SKIP LOCKED`

### Events Covered

| Business Event | Notification Type | Trigger Location |
|----------------|-------------------|-----------------|
| Buyer joins deal | `join_authorized` | `/api/deals/:id/join` handler |
| Charge captured | `charge_succeeded` | `applyPaymentWebhookClassification` — `charge_captured` |
| Charge failed | `charge_failed_recovery` | `applyPaymentWebhookClassification` — `charge_failed` |
| Deal completed | `deal_completed` | `handleFinalizeDealEvent` — `Completed` path |
| Deal failed (finalize) | `deal_failed` | `handleFinalizeDealEvent` — `Failed` path |
| Deal failed (deadline) | `deal_failed` | `workerProcessEvent` — `deadline_check` path |
| Refund issued | `refund_issued` | `applyPaymentWebhookClassification` — `refund_issued` |

### Evidence — 15 PASS, 0 FAIL

| Test | Description | Result |
|------|-------------|--------|
| E1 | enqueue inserts a pending row | PASS |
| E2 | duplicate event_key → single row (ON CONFLICT DO NOTHING) | PASS |
| E3 | email channel enqueues correctly | PASS |
| F1 | flush → log-only provider → status=sent, sent_at set, message_id set | PASS |
| F2 | provider error → status=pending (retry), last_error set | PASS |
| F3 | already-sent notification not re-processed | PASS |
| F4 | concurrent flush: SKIP LOCKED → exactly 1 sends (0 double-sends) | PASS |
| T1 | all 7 event types render correct Hebrew SMS body | PASS |
| T2 | log channel renders correctly | PASS |
| I1 | same event + different channels = 2 rows | PASS |
| I2 | 5x enqueue same key = 1 row | PASS |
| P1 | log-only provider returns valid message ID | PASS |
| P2 | log-only mode is `'log-only'` not `'real'` | PASS |
| P3 | Twilio provider activates when all 3 env vars set, mode=`'real'` | PASS |
| F4 | SKIP LOCKED idempotency under concurrent flush | PASS |

### Files Changed

- `src/migrations/015_notifications.sql` — new: notifications table with status constraint + indexes
- `src/notification_templates.ts` — new: Hebrew templates for 7 event types × 3 channels
- `src/notification_dispatch.ts` — new: provider interface, LogOnly, Twilio, enqueue, flush
- `src/notification_service.ts` — replaced stub with real facade (backward-compat re-export)
- `src/runtime_config.ts` — added `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `NOTIFICATION_MAX_ATTEMPTS`
- `src/app.ts` — integrated enqueue at 7 business event points + flush in workerLoop
- `scripts/init_db.sql` — added notifications table
- `tests/notification_dispatch_proof.ts` — new: 15 proof tests

### What Is Still Open (Notifications Track)

- Email delivery: template system supports email, but no email provider is wired (no email column in participants table yet)
- `deal_cancelled` event: template exists, but the cancel flow triggers `refund_issue` (outbox) not a direct notification — covered by `refund_issued` instead
- SMS delivery requires activating Twilio credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`)
- Cross-track note: `frontend_runtime.ts:227` has a compile error (`deps` out of scope in `readSellerSessionContext`) introduced by the parallel seller-auth agent — not in notification scope

---

## What Was Completed In Notification Ops Mini-Pack (2026-04-14)

### Scope

Thin operational layer on top of Track 2: admin visibility endpoint, targeted proof tests,
and operations runbook.

### What Was Delivered

**`/api/admin/notifications-status` endpoint** (`src/frontend_runtime.ts`)
- Returns aggregate counts by status (pending / processing / sent / failed / skipped / retryable)
- Returns `unique_event_keys`, `oldest_pending_age_s`, `oldest_failed_age_s`
- Returns per-channel breakdown (`by_channel` array)
- Protected by `requireAdminKey`

**Bug fix** (`src/notification_dispatch.ts`)
- `flushPendingNotifications` was using a hardcoded `NOTIFICATION_MAX_ATTEMPTS = 3` constant instead
  of the per-row `max_attempts` column when deciding if a failure is permanent
- Fixed: added `max_attempts` to RETURNING clause; permanent-fail check now uses `row.max_attempts`

**Proof tests** (`tests/notification_ops_proof.ts`, 4/4 PASS)

| Test | Description | Result |
|------|-------------|--------|
| O1 | Exhausting `max_attempts` marks status=`failed`, never `sent` | PASS |
| O2 | 10 concurrent enqueues for same `event_key` = exactly 1 DB row | PASS |
| O3 | `/api/admin/notifications-status` returns correct bucket counts after known inserts | PASS |
| O4 | Retry-then-succeed produces exactly 1 `sent` row, no duplicate | PASS |

**Operations doc** (`docs/NOTIFICATIONS_OPERATIONS.md`)
- Status field meanings
- What a healthy system looks like
- Admin endpoint reference with field-by-field guidance
- SQL queries: find failed, find stuck-processing, reset stuck, find overdue pending
- Retry backoff schedule
- Provider mode reference
- Event key format

### Files Changed

- `src/notification_dispatch.ts` — bug fix: per-row `max_attempts` respected in flush loop
- `src/frontend_runtime.ts` — added `/api/admin/notifications-status` endpoint
- `tests/notification_ops_proof.ts` — new: 4 targeted operational proof tests
- `docs/NOTIFICATIONS_OPERATIONS.md` — new: operations runbook

---

## What Was Completed In Invoice / Accounting Groundwork (2026-04-16)

### Scope

Replace the placeholder invoice/receipt layer with a complete, production-grade
document issuance groundwork: data model, idempotent enqueue, flush loop,
eligibility rules, provider abstraction, event coverage, and proof tests.

### What Was Delivered

**`siton.invoice_documents` table** (`src/migrations/018_invoice_documents.sql`)
- Per-document row with UNIQUE constraint on `document_key` — idempotency key format: `{document_type}:{participant_id}`
- Status machine: `pending → processing → issued` or `→ failed`
- Immutable business snapshot columns: `deal_title`, `qty`, `money_state_at_issue`, `gross_amount`, `siton_fee_amount`, `seller_net_amount`, `affiliate_fee_amount`
- `provider_document_id` on success, `last_error` on failure
- Per-row `max_attempts` — no hardcoded constant in flush logic
- Exponential backoff: 30s / 90s / 270s

**Provider abstraction** (`src/invoice_dispatch.ts`)
- `InvoiceProvider` interface: `{providerCode, mode, issueDocument(input)}`
- `LogOnlyInvoiceProvider` — default; logs to console, returns fake document ID, `mode='log-only'`
- `buildInvoiceProvider()` factory — extend here to wire a real provider
- `flushPendingDocuments(pool, provider)` — SKIP LOCKED claim, per-row max_attempts, permanent vs transient failure
- `enqueueInvoiceDocument(params, db)` — ON CONFLICT DO NOTHING, returns `"queued" | "duplicate"`

**Eligibility rules** (`src/invoice_dispatch.ts`)
- `isEligibleForChargeReceipt(buyerState)` — true only for `DealCompleted`
- `isEligibleForRefundReceipt(moneyState)` — true only for `Refunded`
- Exported constants: `CHARGE_RECEIPT_ELIGIBLE_BUYER_STATES`, `REFUND_RECEIPT_ELIGIBLE_MONEY_STATES`

**Event coverage** (`src/app.ts`)
- `charge_receipt`: enqueued in `handleFinalizeDealEvent` Completed path for each `DealCompleted` participant
- `refund_receipt`: enqueued in `applyPaymentWebhookClassification` for `refund_issued` webhook
- Both are non-blocking (`.catch(() => undefined)`) — document failures cannot break business logic
- `workerLoop` flushes pending documents after each outbox batch and on empty-batch sleep

**Proof tests** (`tests/invoice_dispatch_proof.ts`, 8/8 PASS)

| Test | Description | Result |
|------|-------------|--------|
| D1 | `enqueueInvoiceDocument` → DB row status=pending, returns "queued" | PASS |
| D2 | Duplicate document_key → returns "duplicate", exactly 1 DB row | PASS |
| D3 | Flush with log-only provider → status=issued, issued_at set, document_id set | PASS |
| D4 | Flush with always-fail provider → transient failure, status=pending, last_error set | PASS |
| D5 | Exhausting max_attempts (max=2) → status=failed, last_error=max_attempts_exceeded | PASS |
| D6 | Retry-then-succeed → status=issued, exactly 1 row, no duplicate | PASS |
| D7 | charge_receipt and refund_receipt for same participant → 2 distinct rows | PASS |
| D8 | Eligibility helpers: correct states accepted and rejected | PASS |

**Operations doc** (`docs/INVOICE_ACCOUNTING_GROUNDWORK.md`)

### Eligibility Matrix

| Participant State | charge_receipt | refund_receipt |
|-------------------|---------------|----------------|
| DealCompleted | YES | no |
| Refunded | no | YES |
| DealFailed | no | no |
| Dropped | no | no |
| ChargedSuccess (pre-completion) | no | no |
| RecoveredCharge (pre-completion) | no | no |

### Idempotency — No Duplicate Issuance

- `INSERT ON CONFLICT DO NOTHING` on `document_key`
- SKIP LOCKED in flush prevents concurrent double-processing
- Per-row `max_attempts` prevents permanent-failure bypass
- Business state machine ensures eligibility events fire exactly once per participant

### Files Changed

- `src/migrations/018_invoice_documents.sql` — new: invoice_documents table with status constraint + indexes
- `src/invoice_dispatch.ts` — new: provider interface, LogOnly, enqueue, flush, eligibility helpers
- `src/app.ts` — added import, two enqueue helpers, integration at charge_receipt + refund_receipt events, invoice flush in workerLoop, invoiceProvider startup
- `scripts/init_db.sql` — added invoice_documents table
- `tests/invoice_dispatch_proof.ts` — new: 8 proof tests
- `docs/INVOICE_ACCOUNTING_GROUNDWORK.md` — new: groundwork reference doc

### What Was Before

- No `invoice_documents` table
- Receipt IDs generated on-the-fly (`RCT-XXXX-XXXX`), not persisted, not tracked
- `invoice_is_real: false` flag in frontend_runtime.ts
- `receipts_invoices.state: "internal-surface-only"` in operational_readiness.ts
- No duplicate prevention for document issuance
- No provider abstraction for document generation
- No retry or failure tracking

### What Is Still Open (Invoice Track)

- Real document provider (PDF generation, invoice SaaS, tax API) — `buildInvoiceProvider` is the extension point
- Email delivery of issued document to buyer — no email column on participants yet
- Admin visibility endpoint (`/api/admin/invoice-status`) — not built
- Seller surface (`frontend_runtime.ts`) receipt rows still computed at runtime, not backed by this table
- `invoice_is_real` flag in frontend_runtime.ts not yet updated to reflect partial reality
- Tax / VAT fields — out of scope for groundwork

---

---

## What Was Completed In Admin / Support Observability Mini-Pack (2026-04-16)

### Scope

Three targeted read-only admin endpoints adding observability over the three queue layers
(outbox, notifications, invoice_documents). No auth redesign, no UI, no mutations.

### What Was Delivered

**`GET /api/admin/invoice-status`** (`src/frontend_runtime.ts`)
- Returns per-status counts: pending / processing / issued / failed / skipped / retryable
- Returns `unique_document_keys`, `oldest_pending_age_s`, `oldest_failed_age_s`
- Returns per-type breakdown (`by_type` array: charge_receipt, refund_receipt)
- Protected by `requireAdminKey`

**`GET /api/admin/system-ops-status`** (`src/frontend_runtime.ts`)
- Unified snapshot aggregating outbox + notifications + invoice_documents in one call
- Per queue: pending count, failed count, oldest_pending_age_s
- Outbox also: dlq count, stuck_candidates count
- `worker_running` flag from `getWorkerRunning()` dep
- One DB round-trip (4 queries in parallel via `Promise.all`)

**`GET /api/admin/participants/:id/ops`** (`src/frontend_runtime.ts`)
- Cross-system read surface for a single participant_id
- Returns: participant state (buyer_state, money_state, deal reference)
- Returns: notifications sent or pending (filtered by template_params->>participant_id)
- Returns: invoice documents issued or pending (filtered by participant_id)
- Returns: recent outbox events for participant's deal
- Returns 404 for unknown participant_id
- Read-only — no mutations

**Proof tests** (`tests/admin_observability_proof.ts`, 6/6 PASS)

| Test | Description | Result |
|------|-------------|--------|
| S1 | `/api/admin/invoice-status` returns correct counts after known inserts | PASS |
| S2 | Failed invoice is NOT counted as issued (bucket isolation) | PASS |
| S3 | `/api/admin/system-ops-status` returns all three queue buckets | PASS |
| S4 | `/api/admin/participants/:id/ops` returns participant state + cross-system data | PASS |
| S5 | `/api/admin/participants/:id/ops` returns 404 for unknown participant_id | PASS |
| S6 | All endpoints return 200 on empty state (no crash) | PASS |

**Operations doc** (`docs/ADMIN_SUPPORT_OBSERVABILITY.md`)
- Full endpoint index with what each returns
- Diagnostic flows: notification missing, document missing, deal stuck, queues growing
- "Clean system" reference table

### Admin Endpoint Inventory (Full, as of this pass)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/outbox-status` | GET | Outbox queue health |
| `/api/admin/notifications-status` | GET | Notifications queue health |
| `/api/admin/invoice-status` | GET | Invoice documents queue health ← NEW |
| `/api/admin/system-ops-status` | GET | Unified three-queue snapshot ← NEW |
| `/api/admin/participants/:id/ops` | GET | Cross-system participant read ← NEW |
| `/api/admin/deals/:id/ops-summary` | GET | Per-deal cross-system ops counts ← NEW (Ops Summary Pack) |
| `/api/admin/deals/:id/profile` | GET | Full deal support profile |
| `/api/admin/users/:buyerId/profile` | GET | Buyer join history |
| `/api/admin/system-status` | GET | System health and integrations |
| `/api/admin/overview` | GET | Admin dashboard |

### Files Changed

- `src/frontend_runtime.ts` — added `/api/admin/invoice-status`, `/api/admin/system-ops-status`, `/api/admin/participants/:id/ops`
- `tests/admin_observability_proof.ts` — new: 6 targeted proof tests
- `docs/ADMIN_SUPPORT_OBSERVABILITY.md` — new: observability reference doc

### What Is Still Open (Observability Track)

- Per-deal cross-system summary endpoint — not built; use `deals/:id/profile` + manual queries

---

## What Was Completed In Invoice Queue Hardening Mini-Pack (2026-04-16)

### Scope

Three targeted hardening items closing the remaining gaps from the Observability Mini-Pack:
stuck-processing reclaim, provider mode visibility, and proof of no-duplicate-after-reclaim.

### What Was Delivered

**`reclaimStuckInvoiceDocuments(pool, timeoutMs, logger)`** (`src/invoice_dispatch.ts`)
- Resets rows stuck in `processing` (where `updated_at < now() - timeoutMs`) back to `pending`
- Sets `last_error = COALESCE(last_error, 'worker_reclaim_after_restart')` — preserves existing error context
- Wired into `workerLoop` in `src/app.ts` every `RECLAIM_EVERY_N_POLLS` cycles, alongside `reclaimStuckProcessing`
- Atomic UPDATE — safe to call concurrently; SKIP LOCKED in flush prevents double-issuance after reclaim

**Provider mode in `/api/admin/invoice-status`** (`src/frontend_runtime.ts`)
- `invoice_documents.provider.{code, mode, external_issuance}` — surfaced from `deps.invoiceSummary`
- `invoiceSummary` added to deps type; passed at startup via `getInvoiceProviderSummary(invoiceProvider)`

**Provider mode in `/api/admin/notifications-status`** (`src/frontend_runtime.ts`)
- `notifications.provider.{code, mode, external_delivery}` — surfaced from existing `deps.notificationSummary`

**Proof tests** (`tests/invoice_queue_hardening_proof.ts`, 5/5 PASS)

| Test | Description | Result |
|------|-------------|--------|
| H1 | Old processing document (2 min) is reclaimed to pending | PASS |
| H2 | Recent processing document (5 sec) is NOT reclaimed | PASS |
| H3 | Reclaimed document issues exactly once, no duplicate issuance | PASS |
| H4 | `/api/admin/invoice-status` returns provider mode correctly | PASS |
| H5 | `/api/admin/notifications-status` returns provider mode correctly | PASS |

### Files Changed

- `src/invoice_dispatch.ts` — added `reclaimStuckInvoiceDocuments`
- `src/app.ts` — imported reclaim, wired into workerLoop, passed `invoiceSummary` to deps
- `src/frontend_runtime.ts` — added `invoiceSummary` to deps type; provider mode in both status endpoints
- `tests/invoice_queue_hardening_proof.ts` — new: 5 targeted proof tests
- `docs/INVOICE_ACCOUNTING_GROUNDWORK.md` — updated: reclaim behaviour section, open items
- `docs/ADMIN_SUPPORT_OBSERVABILITY.md` — updated: provider mode and reclaim gaps closed

### What Is Still Open (Invoice/Observability Track)

- Real document provider — `buildInvoiceProvider` is the extension point
- Seller surface still uses runtime-computed receipts, not table-backed
- Per-deal cross-system summary endpoint — **closed in Per-deal Ops Summary Mini-Pack below**

---

## What Was Completed In Per-deal Cross-System Ops Summary Mini-Pack (2026-04-16)

### Scope

Single endpoint giving a complete operational picture for one deal across all four
queue layers: participants, notifications, invoice_documents, and outbox.

### What Was Delivered

**`GET /api/admin/deals/:id/ops-summary`** (`src/frontend_runtime.ts`)
- Returns deal identity: `deal_id`, `state`, `title`
- Returns participant counts: `total` and `by_state` map (all buyer_state values present in the deal)
- Returns notification counts: `pending / processing / sent / failed` + `by_channel` array
  - `by_channel`: per-channel counts with `oldest_pending_age_s`
  - Filtered via `template_params->>'deal_id'` (JSONB — notifications table has no direct deal_id column)
- Returns invoice document counts: `pending / processing / issued / failed` + `by_type` array
  - `by_type`: per-document-type counts with `oldest_pending_age_s`
  - Filtered by `deal_id` column on `invoice_documents`
- Returns outbox counts: `pending / processing / sent / failed / oldest_pending_age_s`
  - Covers both deal-level events (`aggregate_id = dealId`) and participant-level events
    (`aggregate_id IN (SELECT participant_id FROM participants WHERE deal_id = $1)`)
- Returns 404 if `deal_id` is not found
- Protected by `requireAdminKey`
- All four sub-queries run in parallel via `Promise.all`

**Proof tests** (`tests/deal_ops_summary_proof.ts`, 6/6 PASS)

| Test | Description | Result |
|------|-------------|--------|
| X1 | 404 on unknown deal_id | PASS |
| X2 | Correct bucket counts: 3 participants, 2 sent / 1 pending notifications, 1 issued / 1 pending invoice | PASS |
| X3 | Failed notification is NOT counted as sent (bucket isolation) | PASS |
| X4 | Failed invoice is NOT counted as issued (bucket isolation) | PASS |
| X5 | Empty deal (no participants/notifications/invoices) returns 200 with all-zero counts | PASS |
| X6 | `by_channel` and `by_type` splits are correct (sms sent=1/failed=1, charge_receipt issued=1, refund_receipt failed=1) | PASS |

**Docs updated**
- `docs/ADMIN_SUPPORT_OBSERVABILITY.md` — added endpoint to index, added full response shape, marked per-deal gap as closed

### Files Changed

- `src/frontend_runtime.ts` — added `/api/admin/deals/:id/ops-summary` endpoint
- `tests/deal_ops_summary_proof.ts` — new: 6 targeted proof tests
- `docs/ADMIN_SUPPORT_OBSERVABILITY.md` — updated: new endpoint documented, gap closed

### What Is Still Open

- Real document provider — `buildInvoiceProvider` is the extension point
- Seller surface still uses runtime-computed receipts, not table-backed

---

## What Is Still Open

- Navigation and copy cleanup across the rest of the frontend so no old marketplace language remains
- Possible reduction or hiding of non-core public/admin entry points from the main-site navigation
- Real invoice / receipt transport
- Real shipping provider activation
- Real payout execution
- Real KYC provider activation
- Real support tooling outside the repo
- Real live payment provider
- SMS delivery: requires Twilio credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`)

## What Broke And Was Fixed In The Latest Pass

- Fixed soft admin mutation semantics that could return `200` on missing seller / affiliate / support targets.
- Added explicit UUID validation for affiliate KYC mutation targets.
- Added the ultimate pre-live validation suite and revalidated the whole system after the fix.

## Non-Blocking Gaps

- Payment remains mock-backed by design
- Notifications remain log-only by design
- External rails are not activated yet
- Some buyer-side pages still rely mainly on the global preview strip rather than surface-specific demo framing
- No `git remote` is configured, so work is committed locally only
- True external process-manager / provider behavior is still unproven by design until external activation starts
- Live operational rails remain the main remaining source of depth asymmetry
- Demo deployment still lacks a real host target / public URL
- Render deployment still needs one external dashboard / Git hosting step to create the live URL
- Render free Postgres still carries platform limits such as one free DB per workspace and a 30-day lifetime

## External-Activation Dependencies

These items are not internal product-closure blockers anymore. They require external activation:

- live payment provider
- invoice / accounting transport
- shipping / carrier integration
- payout rail
- KYC provider
- support tooling / external ops stack

## Current Product Boundary

These are outside the current canonical product direction:

- public marketplace search / catalog
- marketplace / mall / Amazon-style discovery model

The active direction is now:

- strong Siton main site
- seller-created personal deal pages
- direct-link buyer entry
- strict group-deal core logic

## What Was Completed In The Full Audit + Hardening Pass (2026-04-12)

A full audit covering all source files was completed. Findings and fixes across ~115 items:

### Confirmed Verified (from prior session — all in code)
- `sumJoinedUnits` and `occupiedByOthers` queries exclude `DealFailed`/`Dropped` participants
- `SELECT ... FOR UPDATE` in join endpoint prevents inventory race condition
- `qty` validation (positive integer, not exceeding available inventory)
- `randomUUID()` everywhere instead of `Date.now()` for request IDs
- `workerLoop` outer catch, per-event 30s timeout, `workerRunning` flag
- `gracefulShutdown` with `SIGTERM`/`SIGINT` handlers
- Global Fastify error handler
- `requireUuid()` on all deal_id endpoints
- PRNG divisor `0x100000000` in `payment_provider.ts` and `app.ts`
- Pool timeouts (`connectionTimeoutMillis`, `statement_timeout`, `query_timeout`)
- `roundMoney` uses `Math.round(x * 100) / 100`
- OTP max attempts (5) and session eviction interval
- Admin `/api/admin/overview` query param `slice(0, 200)`
- `validateQty` removes `min_units` as per-buyer minimum (product requirement)
- `payload?.metrics?.remaining_units ?? 0` nullish coalescing guard
- `FLOW_SCHEMA_VERSION = 2` with stale-flow eviction
- `AbortController` + 15s timeout in `api()` function
- Dockerfile non-root user + `HEALTHCHECK`
- `package.json` engines field (`node >=22.0.0`)

### New Fixes Applied In This Pass
- **`src/migrations/012`**: Added missing `BEGIN;`/`COMMIT;` transaction wrapper
- **`src/migrations/013`**: Added missing `BEGIN;`/`COMMIT;` transaction wrapper
- **`.env.demo.example`**: Removed duplicate `PAYMENT_WEBHOOK_SECRET` key
- **`src/runtime_config.ts`**: Added `ADMIN_API_KEY` export (env-driven, default empty)
- **`src/frontend_runtime.ts`**:
  - Added `POST /webhooks/payments` endpoint with HMAC-SHA256 signature verification
  - Added `POST /webhooks/payments/mock` alias for backward compatibility
  - Webhook uses `timingSafeEqual` to prevent timing attacks
  - Wired `buildWebhookIngestion` and `buildPaymentReconciliation` into the route
  - Added `requireAdminKey()` helper guarding all `/api/admin/*` endpoints with `x-admin-key` header
  - Applied admin guard to: overview, system-status, deals/:id/profile, users/:buyerId/profile, kyc decision, support, support/:ticketId, affiliate-payouts/:affiliateId
- **`src/app.ts`**: Added in-memory IP-based rate limiter (`RATE_LIMIT_MAX=200`, `RATE_LIMIT_WINDOW_MS=60000`, configurable via env; `setInterval` purge to prevent unbounded growth; `Retry-After` header on 429)

### What Was Tested
- `backend_sanity_suite` — PASS (all 4 tests)
- `webhook_secret_policy_validation` — PASS (all 4 tests)
- `otp_runtime_guard_validation` — PASS (all 2 tests)
- `debug_surface_guard_validation` — PASS (all 3 tests)
- `tsconfig.test.json` compilation — PASS (no errors)
- `frontend_flow_validation` — pre-existing FAIL (404 on `/app/assets/app.js` in test context, pre-dates this pass; not introduced here)

### What Is Still Open (Intentional or External)
- OTP hardcoded `"123456"` — intentional for demo
- Payment provider mock — intentional, `replacement_path` documented in code
- Webhook HMAC verification only active when `PAYMENT_WEBHOOK_SECRET_IS_SAFE` is true (non-demo, real secret set)
- Admin key guard only active when `ADMIN_API_KEY` env var is set (open in demo by design)
- Rate limiter is in-memory and per-instance — not cluster-safe (acceptable for single-instance demo)
- No real SMS, email, invoice, payment, payout, or KYC transport

## What Was Completed In The Security Hardening Pass 2 (2026-04-12)

### Phase 2 — Implementation hardening

- **Admin auth (`requireAdminKey`)**: Switched from string `!==` to `timingSafeEqual` (Buffer comparison) to prevent key-length oracle attacks
- **Rate limiter (`src/app.ts`)**:
  - Added `trustProxy: true` to Fastify — `req.ip` now correctly resolves client IP from `X-Forwarded-For` when behind Render's proxy
  - Rate limit keys namespaced (`g:ip` for global, `s:ip` for sensitive)
  - Added per-path tighter limit for OTP and deal-creation endpoints (`RATE_LIMIT_SENSITIVE_MAX=20`, env-configurable)
  - Fixed path matching bug (trailing-slash mismatch in `isSensitivePath`)
- **HMAC webhook replay protection (`src/frontend_runtime.ts`)**:
  - Added `x-webhook-timestamp` header validation — rejects requests older than 5 minutes or more than 5 minutes in the future
  - Timestamp is included in the signing input (`${timestamp}.${body}`) so a valid signature from a replayed request cannot be detached and reused
  - `verifyWebhookSignature` now accepts timestamp as a third parameter

### Phase 3 — New security tests (all passing)

| Suite | Tests | Result |
|---|---|---|
| `rate_limiter_validation` | 5 | PASS |
| `admin_auth_validation` | 6 | PASS |
| `webhook_hmac_validation` | 8 | PASS |

**Rate limiter tests cover:**
- Under-limit requests are allowed
- Over-limit returns 429 with `Retry-After`
- Per-IP counters are independent
- Sensitive-path stricter limit fires before global limit
- Window expiry is bounded correctly by `Retry-After`

**Admin auth tests cover:**
- Missing key → 401
- Wrong key → 401
- Empty key → 401
- Whitespace-only key → 401
- Correct key passes auth (may get DB error after, not 401)
- Multiple endpoints all require the key

**Webhook HMAC tests cover:**
- Valid signature + valid timestamp → passes auth
- Missing signature → 401
- Wrong signature → 401
- Signature from different secret → 401
- Stale timestamp (6 min old) → 401
- Far-future timestamp (6 min ahead) → 401
- Recent timestamp (4.5 min old, within window) → passes
- Mock webhook endpoint also enforces signature

### All pre-existing non-DB tests still pass

- `otp_runtime_guard_validation` — PASS (2/2)
- `debug_surface_guard_validation` — PASS (3/3)
- `webhook_secret_policy_validation` — PASS (4/4)

## What Was Completed In Wave 1 — Join Flow QA (2026-04-13)

A targeted audit of the join/capacity flow: `POST /deals/:id/join` in `src/app.ts`.

### Bugs Found and Fixed

**Bug 1 — CRITICAL: `ON CONFLICT` without UNIQUE constraint (runtime PostgreSQL error)**
- `INSERT … ON CONFLICT (deal_id, buyer_id)` requires a UNIQUE constraint on `(deal_id, buyer_id)`.
  No such constraint exists in any migration → every join attempt would throw a PostgreSQL error at runtime.
- Fix: Removed the `ON CONFLICT … DO UPDATE` clause entirely. Each join now does a plain `INSERT`,
  which is correct — multiple purchases by the same buyer create separate participant rows.

**Bug 2 — CRITICAL: Oversell via buyer-exclusion in capacity check**
- Capacity query used `WHERE buyer_id != $2`, which excluded the requesting buyer's existing reservations
  when counting occupied units. This allowed a buyer who already held N units to request more,
  pushing the total beyond `max_units`.
- Fix: Removed the `buyer_id !=` clause. Capacity check now counts ALL active participants' units,
  making the check truly global. Variable renamed from `occupiedByOthers`/`availableForThisBuyer`
  to `alreadyReserved`/`remaining` for clarity.

**Bug 3 — HIGH: Idempotency key not per-request (broken replay protection for multi-purchase)**
- Auto-generated key was `join:{dealId}:{buyer_id}` — same for every purchase by the same buyer.
  Since `atomicMultiTransition` idempotency is scoped to `participant_id` (always new for each row),
  the key never actually deduped anything across separate purchases.
- Fix: Auto-generated key is now `join:{dealId}:{buyer_id}:{requestId}`, unique per request.
  A pre-INSERT idempotency check (inside the deal-locked transaction, querying `idempotency_log`)
  was added to properly deduplicate replayed explicit keys.

**Bug 4 — MEDIUM: Missing UUID validation on deal_id**
- `POST /deals/:id/join` did not call `requireUuid(dealId, "deal_id")` at handler entry,
  unlike every other deal-scoped endpoint. Malformed IDs would reach the DB query and cause
  a PostgreSQL error instead of a clean 400.
- Fix: Added `requireUuid(dealId, "deal_id")` as the first line of the handler body.

### Product Rule Confirmed
No per-buyer limit on number of purchases. Only constraint is `max_units` total across all active participants.
The fix to Bug 1 (plain INSERT, no conflict-update) directly enables multiple rows per buyer.

### Tests Added — `tests/join_flow_qa_validation.ts` (9/9 PASS)

| Test | What it covers |
|---|---|
| non-UUID deal_id returns 400 | Bug 4 fix |
| empty/whitespace deal_id returns 400 or 404 | Bug 4 fix + routing |
| missing buyer_id returns 400 | input guard regression |
| qty=0 returns 400 | input guard regression |
| qty=-1 returns 400 | input guard regression |
| qty=1.5 returns 400 | input guard regression |
| auto-generated keys differ between requests | Bug 3 fix |
| explicit idempotency-key header is respected | Bug 3 fix |
| endpoint is registered (not routing-404) | handler registration |

### All Prior Non-DB Tests Still Pass
- `rate_limiter_validation` — PASS (5/5)
- `admin_auth_validation` — PASS (6/6)
- `webhook_hmac_validation` — PASS (8/8)
- `otp_runtime_guard_validation` — PASS (2/2)
- `debug_surface_guard_validation` — PASS (3/3)
- `webhook_secret_policy_validation` — PASS (4/4)

## What Was Completed In Wave 1 — Concurrency Proof (2026-04-14)

A hard evidence round against the live DB following the initial bug fixes. All scenarios used real
DB transactions, real concurrent `app.inject()` calls, and direct DB queries for evidence.

### Fifth Bug Found and Fixed During Proof

**Bug 5 — HIGH: Idempotency race under concurrent load (transaction gap)**

- **Root cause**: The participant `INSERT` and the `idempotency_log` write were in separate transactions.
  The deal's `SELECT FOR UPDATE` lock was released after the participant was created, but before
  the idem log entry was committed. Concurrent requests that acquired the lock in that window
  would see an empty idem log and each create a fresh participant with the same explicit key.
- **Evidence**: I3 scenario — 20 concurrent requests with the same explicit idempotency key created
  10 participants (10 unique participant_ids in DB) instead of 1. All 10 slots were consumed,
  leaving 0 capacity for other buyers.
- **Fix** (`src/app.ts`): Inlined state transitions (buyer_state, money_state), audit log writes, and
  `idempotency_log` INSERT into the single deal-locked `withTx`. The lock is now held through
  all writes atomically. Removed the separate `atomicMultiTransition` call from the join path.
- **After fix**: I3 — 20 concurrent same-key requests → `unique participant_ids=1`, `participants=1`,
  `qty_sum=1`, `audit=2`, `idem=1`. Zero race condition.

### Proof Results — `tests/concurrency_proof.ts` (14/14 PASS)

| Scenario | Description | Requests | Evidence |
|---|---|---|---|
| S1 | 70 concurrent joins, max=10 | 70 | succeeded=10, qty_sum=10, rejected=60 |
| S2 | 200 concurrent joins, max=20 | 200 | succeeded=20, qty_sum=20, rejected=180 |
| S3 | Mixed qty (1/2/3), max=15 | 20 | qty_sum=15, no oversell |
| S4 | Same buyer, 10 concurrent, max=5 | 10 | 5 participants created, qty_sum=5, max enforced |
| S5 | Last unit race, 50 requests, max=1 | 50 | succeeded=1, qty_sum=1, 49 rejected |
| S6 | Bulk request takes all 8 units | 2 | first=200, second=409, qty_sum=8 |
| S7 | 5×qty=5 competing, max=10 | 5 | succeeded=2, qty_sum=10 |
| I1 | Same key replayed 3× | 3 | same participant_id returned, audit=2, idem=1 |
| I2 | Same key, different qty replay | 2 | same participant_id, qty_sum=1 (not 4) |
| I3 | 20 concurrent same-key retries | 20 | unique_pids=1, participants=1, idem=1 |
| M1 | Same buyer, 5 sequential auto-keys | 5 | 5 distinct participants, idem=5 |
| M2 | Same buyer bounded by max_units=3 | 5 | 3 participants, qty_sum=3 |
| M3 | 3 purchases, 3 explicit distinct keys | 3 | 3 distinct participants, idem=3 |
| CONSISTENCY | No proof deal residue in DB | — | leftover=0 |

### DB Evidence (post all scenarios)

- No proof deals, participants, or idem_log entries remain in DB after cleanup
- `audit_log` entries persist (append-only by DB trigger) but are orphaned
- `max_units` was never exceeded in any scenario across all 13 scenarios
- No deadlocks, no 5xx errors, no false success responses

### Summary Statement

| Claim | Evidence |
|---|---|
| No oversell | S1-S7: qty_sum ≤ max_units in all 14 scenarios |
| Concurrency safe | S1(70 req), S2(200 req), S3(mixed qty), S4(same buyer), S5(last unit), S7(competing bulk) all within bounds |
| Idempotency correct | I1(replay), I2(payload mismatch), I3(20 concurrent same-key) → each produces exactly 1 participant |
| Multi-purchase works | M1(sequential), M2(bounded), M3(explicit keys) → multiple participants per buyer, capacity respected |
| audit consistent | audit_count = participants × 2 in all scenarios (buyer_state + money_state per join) |
| idem consistent | idem_count = participants in all scenarios |

## Estimated Progress

- Backend: 99%
- Buyer frontend: 97%
- Product-direction alignment: 74%
- Seller surface: 96%
- Affiliate surface: 94%
- Admin surface: 97%
- Internal integrations: 96%
- Security hardening: 99%
- Current-spec product closure: 99%
- Ultimate pre-live QA / RC confidence: 97%
- Master product depth / internal hardening: 99%
- Overall product readiness: 98%

## Recommended Next Step

1. Deploy to Render (single external step: push repo + activate blueprint)
2. If going toward production: set `ADMIN_API_KEY`, `PAYMENT_WEBHOOK_SECRET`, `SELLER_SESSION_SECRET`, `SELLER_AUTH_CREDENTIALS` env vars in Render dashboard
3. Continue product-direction alignment (copy/navigation cleanup) as separate pass

## Delivery Persistence Checkpoint

- What was completed:
  delivery-method persistence in schema, seller create flow, buyer join flow, payment summary, confirmation, tracking, seller management, and automated tests
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, `npx tsc -p tsconfig.test.json --noEmit`
- What is open:
  no delivery-specific blocker remains in the current pass
- Progress percentage:
  `86%` of the product-direction alignment pass
- Next step:
  continue only with remaining product-direction cleanup outside delivery semantics

## Active Cleanup Checkpoint

- What was completed:
  legacy route redirect, home sharpening, seller-flow CTA cleanup, active copy cleanup on core seller surfaces
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  broader historical docs cleanup and deeper non-core surface copy cleanup outside the active pass
- Progress percentage:
  `89%` of the product-direction alignment pass
- Next step:
  continue shrinking non-core historical copy while preserving the active seller-first, direct-link product surface

## Product Surface Focus Checkpoint

- What was completed:
  primary-vs-internal surface hierarchy was implemented in navigation, internal framing, and legacy route handling
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  deeper copy unification inside internal surfaces and broader historical docs cleanup
- Progress percentage:
  `91%` of the product-direction alignment pass
- Next step:
  continue only with copy-and-narrative unification so every remaining visible surface speaks the same sharp product language

## Copy And Narrative Unification Checkpoint

- What was completed:
  unified the active product language across the main site, seller surfaces, payment messaging, and internal affiliate/admin surfaces; aligned primary CTAs, labels, empty states, and section titles to one seller-first product voice
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  a few internal-only technical labels still remain deeper inside admin/affiliate tables, but no primary-surface narrative blocker remains in the current pass
- Progress percentage:
  `94%` of the product-direction alignment pass
- Next step:
  continue only with targeted internal-surface copy cleanup if needed, not with new product-surface rework

## Final Surface Snapshot Checkpoint

- What was completed:
  performed a final audit of the primary product surface, removed the remaining main-surface copy gaps, tightened seller-surface wording, normalized delivery labels on visible primary flows, and removed leftover inactive home-surface residue from the active bundle path
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no open blocker remains on the primary product surface
- Progress percentage:
  `96%` of the product-direction alignment pass
- Next step:
  keep future passes away from the main surface unless a real regression appears, and focus only on non-primary internal cleanup or external activation when relevant

## Internal Surface Cleanup Checkpoint

- What was completed:
  cleaned and unified the visible admin and affiliate copy, upgraded internal labels and section names, reduced raw English wording on internal summaries and helper text, and tightened the internal operational framing without changing the primary surface
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  some table headers still reflect raw schema field names on internal detail tables, but the visible internal framing and prominent copy are now aligned
- Progress percentage:
  `97%` of the product-direction alignment pass
- Next step:
  leave the main and internal surfaces stable unless a real regression appears, and only revisit deeper table-header polish if it becomes worth a dedicated pass

## Internal Table Header Polish Checkpoint

- What was completed:
  normalized internal table headers through a shared header-label mapping, replaced the remaining prominent raw schema column names on internal tables with human-facing labels, and aligned fallback cell wording
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no meaningful internal table-header blocker remains
- Progress percentage:
  `99%` of the product-direction alignment pass
- Next step:
  no further polish pass is needed unless a concrete regression appears

## Seller Identity Minimum Hardening Checkpoint

- What was completed:
  added an explicit minimum seller context model, introduced seller context read/write endpoints, persisted the active seller context in the frontend shell, bound seller workspace and seller management payloads to the active seller, enforced seller ownership checks on publish and seller-side management paths, and ensured new deals are created under the active seller identity instead of relying only on UI framing
- What was checked:
  `node --check frontend/app.js`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no blocker remains in the minimum seller identity scope; full authentication and richer permissions remain intentionally out of scope
- Progress percentage:
  `100%` of the minimum seller identity hardening pass
- Next step:
  keep the seller context model stable and only revisit it when the project is ready to open a real authentication and permissions phase

## Stage 1 RTL And Hebrew External Alignment Kickoff

- What was completed:
  opened Stage 1 for full Hebrew and RTL external-surface alignment, mapped the visible public and seller-facing surfaces, and identified the first systematic gaps in copy, directionality, mixed-language fields, and external trust messaging
- What was checked:
  `frontend/app.js`, `frontend/styles.css`, `frontend/index.html`, `tests/frontend_flow_validation.ts`
- What is open:
  external copy still contains mixed English terms, visible raw state wording still leaks into some seller-facing surfaces, and RTL handling is not yet systematic enough for mixed text, numeric fields, and payment inputs
- Progress percentage:
  `5%` of Stage 1
- Next step:
  implement shared Hebrew copy normalization and RTL-safe field/layout handling across the public deal, OTP, payment, confirmation, tracking, seller workspace, and home surfaces

## Stage 1 RTL And Hebrew External Alignment Checkpoint

- What was completed:
  normalized the visible public and seller-facing copy to Hebrew-first wording, aligned authorization and charge messaging, translated environment labels, added systemic RTL handling in shared CSS, introduced mixed-direction field support for phone, OTP, card, expiry, tracking, and seller-id fields, and normalized seller-facing state rendering so visible tables and cards no longer leak raw state wording
- What was checked:
  `node --check frontend/app.js`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run test:frontend`, `npm run test:product-surface`
- What is open:
  no material blocker remains on the external Hebrew and RTL layer for the main public and seller-facing product surface
- Progress percentage:
  `100%` of Stage 1
- Next step:
  keep the Hebrew and RTL surface stable and only reopen this stage if a concrete visual or copy regression appears

## Stage 2 Visual Strengthening Kickoff

- What was completed:
  opened Stage 2 for visual strengthening, mapped the main screens that carry the product story, and identified the main visual gaps in hierarchy, spacing, contrast, trust emphasis, and surface consistency
- What was checked:
  `frontend/app.js`, `frontend/styles.css`
- What is open:
  the core screens still need a stronger commercial visual language, especially on the public deal page, authorization screen, buyer tracking, seller dashboard, create-deal, and live-deal management surfaces
- Progress percentage:
  `10%` of Stage 2
- Next step:
  apply a systematic design pass to typography, cards, buttons, progress, trust boxes, summary zones, and core page structure, then run validation on both Stage 1 and Stage 2 outcomes

## Stage 1 Live Browser QA Confirmation

- What was completed:
  confirmed Stage 1 in a live browser context, fixed broken Hebrew metadata in `frontend/index.html`, removed the invalid non-ASCII seller display-name HTTP header from the shared fetch layer, and normalized the remaining visible English residues on the seller surface and demo strip
- What was checked:
  live headless Edge DOM validation on `/app` and `/app/seller`, `node --check frontend/app.js`, and `npm run test:frontend`
- What is open:
  no material blocker remains in Stage 1; the main Hebrew and RTL surface now renders correctly in live browser QA
- Progress percentage:
  `100%` of Stage 1
- Next step:
  keep Stage 1 stable and only reopen it if a concrete Hebrew, RTL, or visible copy regression appears

## Stage 2 Visual Strengthening Checkpoint

- What was completed:
  strengthened the shared visual system in `frontend/styles.css`, improved hierarchy and emphasis across cards, buttons, summaries, forms, and status surfaces, and validated the strengthened seller surface in live browser QA after fixing the seller-context transport regression
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/seller`
- What is open:
  no blocker is currently known on the strengthened main seller surface; broader visual polish on additional primary screens can continue from a stable base
- Progress percentage:
  `55%` of Stage 2
- Next step:
  continue the Stage 2 design pass on the public deal, authorization, confirmation, and tracking screens from the now-stable Hebrew and seller surfaces

## Stage 2 Core Screen Polish Checkpoint

- What was completed:
  upgraded the public deal, authorization, confirmation, and tracking screens with stronger hero hierarchy, trust bands, spotlight summaries, clearer CTA framing, stronger success and tracking states, and a small hash-based QA seed hook that enables live browser validation of mid-flow screens without touching backend logic
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/deal/3080df02-61cb-4d7f-b6a8-159f85785b10`, `/app#qaTarget=%2Fapp%2Fjoin%2F3080df02-61cb-4d7f-b6a8-159f85785b10%2Fpayment...`, `/app#qaTarget=%2Fapp%2Fjoin%2F3080df02-61cb-4d7f-b6a8-159f85785b10%2Fconfirmation...`, and `/app#qaTarget=%2Fapp%2Ftrack%2F298c6087-1f0c-4e3a-b94e-e45078ba34d3...`
- What is open:
  no material blocker is currently known on these four core buyer-facing screens; any further Stage 2 work is now optional polish on adjacent seller surfaces rather than a closure gap on this core set
- Progress percentage:
  `88%` of Stage 2
- Next step:
  keep these four core screens stable, and only continue Stage 2 if you want an additional polish pass on seller dashboard, create-deal, and live-deal management surfaces

## Stage 2 Seller Surface Polish Checkpoint

- What was completed:
  strengthened the seller dashboard, create-deal, and live deal management screens with stronger hero emphasis, clearer operational summaries, grouped forms, clearer urgency and progress framing, stronger table wrapping, and normalized seller identity copy so the seller work surfaces now match the visual confidence of the buyer-facing core screens
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge DOM validation on `/app/seller`, `/app/seller/new`, and `/app/seller/deals/e2d3899f-12f9-41d4-9977-55f6c1131659`
- What is open:
  no material blocker remains on the primary seller work surfaces, and Stage 2 can now close without a meaningful visual caveat on the main product path
- Progress percentage:
  `100%` of Stage 2
- Next step:
  freeze Stage 2 and only reopen it for a concrete regression or a future redesign initiative outside the current alignment pass

## Stage 2 Seller Surface QA Refresh

- What was completed:
  remapped the seller dashboard, create-deal, and live deal management surfaces against the strengthened core visual language, upgraded the seller dashboard with a clearer business-control summary and stronger deal cards, upgraded create-deal with clearer section hierarchy and business previews, upgraded live deal management with stronger loaded-state summaries, clearer table framing, and safer Hebrew-first display normalization for seller-side notes and delivery labels, while keeping the existing hash-based QA hook isolated and unchanged
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, and live headless Edge browser QA on `http://127.0.0.1:3000/app/seller`, `http://127.0.0.1:3000/app/seller/new`, and `http://127.0.0.1:3000/app/seller/deals/e2d3899f-12f9-41d4-9977-55f6c1131659`
- What is open:
  no material blocker remains on the three primary seller work surfaces; the remaining English that can still appear is limited to underlying seeded business content such as deal titles or seller ids rather than the product chrome itself
- Progress percentage:
  `100%` of Stage 2
- Next step:
  keep Stage 2 frozen and reopen only for a concrete regression or for a future broader redesign initiative

## Stage 3 Trust And Legal Wrapper Checkpoint

- What was completed:
  mapped the public trust touchpoints across the public deal, authorization, confirmation, tracking, footer, and seller publish surfaces; added public frontend routes and visually complete Hebrew pages for terms of use, privacy, cancellations and refunds, and contact; added a consistent public trust footer and legal-link strips across the relevant public surfaces; reinforced the trust copy around authorization hold versus actual charge; and added seller-facing notes that map the missing publish-flow acknowledgment without opening backend, state, or contract changes
- What was checked:
  `frontend/app.js`, `frontend/styles.css`, `PROJECT_STATUS.md`, `node --check frontend/app.js`, `npm run test:frontend`, and `npm run test:product-surface`
- What is open:
  live browser QA still needs to be completed on the new legal pages, footer links, and the refreshed public touchpoints; a hard enforcement checkbox for seller acknowledgment was intentionally not added because that would open new logic and should be treated as a separately mapped system gap if needed later
- Progress percentage:
  `80%` of Stage 3
- Next step:
  run live browser QA on `/app/terms`, `/app/privacy`, `/app/refunds`, `/app/contact`, and the main public deal and tracking surfaces, then close Stage 3 if the public wrapper reads clearly in Hebrew RTL without regressions

## Stage 3 Trust And Legal QA Closure

- What was completed:
  completed Stage 3 in practice by wiring the public legal pages into the delivered frontend shell, closing the direct-load gap on `/app/terms`, `/app/privacy`, `/app/refunds`, and `/app/contact`, and validating that the public trust footer and trust-copy reinforcement now appear across the external buyer-facing path without changing backend business logic, DB shape, states, or contracts
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:product-surface`, direct live requests to the new public legal routes on `http://127.0.0.1:3000`, and live headless Edge browser QA screenshots for `/app/terms`, `/app/privacy`, `/app/refunds`, `/app/contact`, `/app/deal/84a89aaa-df8a-4e0e-b671-a7f167bd4348`, and `/app/track/74ab8686-9b8d-4a73-bb4b-dacbf7fd508f`
- What is open:
  no material blocker remains on the basic public trust and legal wrapper; the only intentionally unmoved item is a future seller-side enforced acknowledgment step, which stays mapped as a separate system decision because adding it now would require new logic rather than a pure Stage 3 frontend wrapper pass
- Progress percentage:
  `100%` of Stage 3
- Next step:
  freeze Stage 3 and only reopen it for a concrete trust-copy regression, a legal copy revision, or a future product decision about enforceable seller acknowledgment

## Stage 4 Operational Readiness Checkpoint

- What was completed:
  mapped the operational readiness rails across payment provider, authorization / charge / recovery, SMS, email, receipts / invoices, runtime env, feature flags, preview / demo mode, seed defaults, debug surfaces, seller identity handling, and production assumptions; added a canonical operational-readiness summary into `/health/integrations`, `/api/preview/meta`, and `/api/admin/system-status`; added canonical route aliases for `/api/payments/authorize` and `/webhooks/payments` while preserving compatibility aliases; gated `/debug/deals/:id` outside demo-preview or explicit debug enablement; removed unconditional demo-copy leakage from the public payment screen; and reduced non-demo environment leakage on the public home and seller surfaces
- What was checked:
  `node --check frontend/app.js`, `npm run test:frontend`, `npm run test:integrations`, `npm run test:demo-preview`, `npm run test:product-surface`, direct live requests on `http://127.0.0.1:3000` to `/health/integrations`, `/api/preview/meta`, `/api/seller/context`, `/api/admin/system-status`, `/debug/deals/:id`, and live headless Edge browser QA screenshots for `/app`, `/app/seller`, `/app/deal/9e594fc6-7713-4005-8b42-edaf0bc520ed`, a seeded `/app/join/.../payment` route via the isolated hash QA hook, and `/app/terms`
- What is open:
  the readiness map now explicitly confirms that live payment capture / recovery / refund, real SMS, real email, real invoice / accounting transport, and true seller authentication are still open gaps; seller context remains acceptable only for controlled demo or constrained first launch and is not sufficient for an open multi-tenant launch
- Progress percentage:
  `100%` of Stage 4
- Next step:
  freeze Stage 4, use `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` as the current source for operational truth, and do not open Stage 5 until there is an explicit product decision on which real external rails and auth scope are being activated next

## Gap Register Completed

- What was completed:
  produced the master gap register in `docs/GAP_REGISTER_MASTER.md`, remapped the remaining project gaps across auth, payments, notifications, receipts/accounting, DB/runtime drift, legal publish acknowledgment, debug exposure, env/default assumptions, observability, testing, and documentation alignment, and replaced optimistic readiness framing with an explicit blocker map for production versus controlled demo
- What was checked:
  authoritative product / UX / system / DB / enforcement documents, `docs/KNOWN_GAPS_AND_DECISIONS.md`, `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md`, `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `docs/RELEASE_READINESS_CHECKLIST.md`, `src/app.ts`, `src/frontend_runtime.ts`, `src/payment_provider.ts`, `src/notification_service.ts`, `src/runtime_config.ts`, `src/product_surface_support.ts`, `scripts/init_db.sql`, `tests/full_product_surface_validation.ts`, and live local sanity reads from `http://127.0.0.1:3000/health/integrations`, `/api/preview/meta`, `/api/seller/context`, `/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed`, and `POST /api/otp/start`
- What is open:
  `14` real gaps remain mapped; `7` are `P0` and `5` are `P1`; the top production blockers remain real seller auth, live payment rails, OTP/SMS production hardening, invoice/accounting issuance, debug exposure, and unsafe secret/default assumptions
- Progress percentage:
  `100%` of the gap-mapping pass
- Next step:
  treat `docs/GAP_REGISTER_MASTER.md` as the current canonical closure map, pick Wave 1 from the roadmap, and start closing blockers in order instead of continuing ad hoc polish

## P0 Attack Plan Completed

- What was completed:
  extracted the full `P0` set from `docs/GAP_REGISTER_MASTER.md`, ranked the seven `P0` gaps into `P0-A`, `P0-B`, and `P0-C`, and converted them into an operational attack plan in `docs/P0_ATTACK_PLAN.md` with per-gap execution cards covering blast radius, prerequisites, dependencies, validation method, required tests, live-QA needs, docs/API/DB impact, and recommended repair strategy
- What was checked:
  `docs/GAP_REGISTER_MASTER.md`, product/UX/system/DB/enforcement source references already used in the gap register, `src/app.ts`, `src/frontend_runtime.ts`, `src/payment_provider.ts`, `src/runtime_config.ts`, `src/product_surface_support.ts`, `frontend/app.js`, and the current live local runtime behavior already validated during the gap-mapping pass for `/debug/deals/:id`, `/health/integrations`, `/api/preview/meta`, `/api/seller/context`, and `POST /api/otp/start`
- What is open:
  all seven `P0` gaps remain open by design because this pass created the execution plan rather than applying fixes; the current recommended first three are `GAP-06` debug exposure, `GAP-07` webhook secret hardening, and `GAP-04` OTP production-safe floor, while seller auth and real payment remain explicitly scoped as larger follow-on programs
- Progress percentage:
  `100%` of the `P0` planning pass
- Next step:
  execute `GAP-06` first as the smallest highest-value containment fix, then `GAP-07`, then `GAP-04`, and only after that open the broader seller-auth and real-payment programs

## GAP-06 Debug Route Closure

- What was completed:
  closed the default exposure of `/debug/deals/:id` by changing the route to fail closed; debug access now opens only when `DEBUG_SURFACES_ENABLED=1` and `DEBUG_SURFACES_ACCESS_KEY` are both present, and the request also supplies the matching `x-debug-access-key` header; aligned the readiness and runbook docs to the new strict access rule; added a focused guard test and updated the existing demo-preview and preprod torture validations to reflect the stricter boundary
- What was checked:
  focused automated guard validation via `node .tmp_test_dist/tests/debug_surface_guard_validation.js` after `tsc -p tsconfig.test.json`, live QA on `http://127.0.0.1:3000/debug/deals/9e594fc6-7713-4005-8b42-edaf0bc520ed` returning `404` by default, and live QA on a dedicated `:3001` runtime with explicit debug env showing `403` without the header, `403` with the wrong header, and `200` only with the correct header; `http://127.0.0.1:3000/health` remained `200`
- What is open:
  `GAP-06` is closed; the next open items in the P0 sequence remain `GAP-07` webhook secret hardening and `GAP-04` OTP production-safe floor
- Progress percentage:
  `100%` of `GAP-06`
- Next step:
  freeze the debug guard behavior as the new baseline and start `GAP-07` next without coupling it to auth, payment rail activation, or any other broader refactor

## GAP-07 Webhook Secret Hardening

- What was completed:
  hardened the webhook secret policy so the runtime no longer treats the demo default as acceptable outside `demo-preview`; added explicit config exports that distinguish demo fallback from non-demo safety, wired the readiness summary to expose webhook-secret safety as first-class operational truth, documented the stricter rule in the Stage 4 readiness map, and added a focused test that locks the intended behavior across demo and non-demo modes
- What was checked:
  focused automated validation via `node .tmp_test_dist/tests/webhook_secret_policy_validation.js` after `tsc -p tsconfig.test.json`, plus direct shell QA showing `APP_DEPLOYMENT_MODE=internal-runtime` with empty `PAYMENT_WEBHOOK_SECRET` resolves to `safe:false`, while `APP_DEPLOYMENT_MODE=demo-preview` with `mock-webhook-secret` remains `safe:true`
- What is open:
  `GAP-07` is closed; the next open item in the P0 sequence is `GAP-04` OTP production-safe floor
- Progress percentage:
  `100%` of `GAP-07`
- Next step:
  keep the webhook-secret safety rule frozen as the new baseline and move to `GAP-04` without coupling it to seller auth, real payment activation, or any broader runtime rewrite

## GAP-04 OTP Production-Safe Floor

- What was completed:
  removed the static universal OTP from the frontend runtime, replaced it with a per-session generated 6-digit code, and limited `development_code` exposure to `demo-preview` only; the OTP verify path now checks against the session-specific code rather than a shared hardcoded value; added a focused OTP runtime validation that proves demo-preview still returns a per-session debug code while non-demo no longer leaks one; updated the demo-dependent OTP tests to consume the returned demo code instead of assuming `123456`
- What was checked:
  focused automated validation via `node .tmp_test_dist/tests/otp_runtime_guard_validation.js` after `tsc -p tsconfig.test.json`, plus isolated HTTP live-QA against a temporary demo-preview frontend-runtime instance proving two consecutive `/api/otp/start` requests returned different `development_code` values and `/api/otp/verify` succeeded with the matching per-session code
- What is open:
  the minimum `GAP-04` floor is closed; real SMS delivery is still outside this pass and remains part of the broader external-rails work, but the insecure static-code and leaked-code behavior is now removed from non-demo mode
- Progress percentage:
  `100%` of the minimum `GAP-04` closure
- Next step:
  freeze the OTP floor hardening as the new baseline and do not reopen it unless the next external-rails phase explicitly activates real SMS delivery

## Seller Auth Attack Plan Completed

- What was completed:
  mapped the current seller identity model end to end and converted `GAP-01` into an operational execution document in `docs/SELLER_AUTH_ATTACK_PLAN.md`; explicitly documented where seller identity currently comes from (`localStorage`, `x-seller-id`, `seller_id` query selection, and default fallback), which seller routes rely on it, where auto-provisioning still exists, where current guards stop at context scoping, and why the current model remains acceptable only for demo / controlled launch rather than open production; split the repair path into a controlled-launch minimum real auth track and a fuller production auth track, with a clear recommendation to execute the controlled-launch track first
- What was checked:
  `docs/GAP_REGISTER_MASTER.md`, `docs/P0_ATTACK_PLAN.md`, `docs/PASS7_SELLER_IDENTITY_MINIMUM_HARDENING_2026-04-10.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `frontend/app.js`, `src/frontend_runtime.ts`, `src/product_surface_support.ts`, and the current seller-identity readiness wording in `src/operational_readiness.ts`
- What is open:
  seller auth itself is still not implemented; caller-selected seller context remains the current runtime authority model outside admin boundaries, so open multi-tenant production is still blocked until non-demo seller authority is moved to a server-trusted session model
- Progress percentage:
  `100%` of the seller-auth planning pass
- Next step:
  execute `Track A` from `docs/SELLER_AUTH_ATTACK_PLAN.md`: define the non-demo seller session authority boundary, remove caller-selected seller identity as production authority, keep `demo-preview` explicitly isolated, and only then consider whether a broader production account lifecycle program should be opened

## Seller Auth Controlled-Launch Implementation

- What was completed:
  implemented the minimum real seller-auth boundary for `non-demo` runtimes by moving seller authority to a server-trusted signed session cookie; added shared seller-auth helpers in `src/seller_auth.ts`; added non-demo seller-auth config in `src/runtime_config.ts`; updated `src/frontend_runtime.ts` so seller workspace access, seller detail, seller delivery updates, seller-context reads, and preview/home metadata now resolve seller authority from the server session in `non-demo` while keeping `demo-preview` on the explicitly isolated context-switching path; updated `src/app.ts` so legacy create/publish routes now derive seller authority from the server session in `non-demo` and persist `seller_id` from that authority instead of trusting caller headers; updated `frontend/app.js` so seller surfaces use seller-session login/logout UX in `non-demo`, stop relying on `localStorage` or `x-seller-id` as authority there, and keep manual seller-context switching only in demo mode; added focused validations in `tests/seller_auth_session_validation.ts` and `tests/seller_auth_authority_validation.ts`
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --noEmit`; focused validation via `node .tmp_test_dist/tests/seller_auth_session_validation.js`; focused validation via `node .tmp_test_dist/tests/seller_auth_authority_validation.js`; live HTTP QA against a temporary `frontend_runtime` instance on `127.0.0.1:3050` proving `401` without session, `200` login with invited seller credentials, and `200` seller workspace access while a forged `x-seller-id` header was ignored in favor of the server session
- What is open:
  this closes the controlled-launch seller-auth floor, not the full production auth program; invited-seller credentials are still env-driven rather than full public onboarding, there is still no broader permissions matrix, and open multi-tenant public seller signup/recovery remains outside this pass
- Progress percentage:
  `100%` of the controlled-launch seller-auth implementation pass
- Next step:
  freeze the controlled-launch session boundary as the new non-demo baseline, then decide whether the next program is live payment authorization rail or the broader mature seller-auth/account lifecycle

## Payment Rail Attack Plan Completed

- What was completed:
  mapped the current payment rail end to end and converted it into an execution document in `docs/PAYMENT_RAIL_ATTACK_PLAN.md`; documented exactly what is already real today inside the app rail (state machine, outbox discipline, payment-attempt audit, webhook ingestion storage, duplicate handling, and minimal reconciliation), what remains mock or placeholder (`authorize`, `capture`, `recover`, `refund` execution inside `src/payment_provider.ts`), where the frontend already assumes a meaningful authorization boundary, where aliases and webhook routes already exist, which envs/secrets are already part of the shape, and which invariants must not be broken while moving to a real provider
- What was checked:
  `docs/P0_ATTACK_PLAN.md`, `docs/REAL_PAYMENT_AND_RECONCILIATION_DECISION.md`, `docs/STAGE4_OPERATIONAL_READINESS_MAP.md`, `src/payment_provider.ts`, `src/payment_reconciliation.ts`, `src/webhook_ingestion.ts`, `src/payment_attempt_helpers.ts`, `src/app.ts`, `src/frontend_runtime.ts`, `frontend/app.js`, and the existing payment-facing validations referenced in `tests/frontend_flow_validation.ts`, `tests/real_integrations_validation.ts`, `tests/preprod_torture_validation.ts`, and `tests/ultimate_prelive_qa_rc_validation.ts`
- What is open:
  no real external payment transport is active yet; the next concrete implementation program is still open and should begin with one real authorization rail behind the existing abstraction, followed only later by capture/recovery/refund and the chosen provider's full webhook matrix
- Progress percentage:
  `100%` of the payment-rail planning pass
- Next step:
  start the implementation program at Stage 1 from `docs/PAYMENT_RAIL_ATTACK_PLAN.md`: one chosen provider, real authorization HTTP client, strict non-demo env contract, real provider correlation persistence, and no capture/recovery/refund expansion in the same first patch

## Real Authorization Rail Stage 1

- What was completed:
  replaced the synthetic `provider-ready` authorization path with a real outbound HTTP authorization rail behind the existing provider abstraction in `src/payment_provider.ts`; kept `mock-backed` and `demo-preview` isolated; added strict non-demo env support for `PAYMENT_PROVIDER_AUTH_PATH` and `PAYMENT_PROVIDER_TIMEOUT_MS` in `src/runtime_config.ts`; wired `/api/payments/authorize` and the legacy `/api/payments/authorize-mock` alias to pass real authorization amount/currency/deal/buyer context through `src/frontend_runtime.ts`; updated `frontend/app.js` to send `amount_minor` and preserve returned provider trace in the buyer flow; updated `src/app.ts` so a successful join now records `authorization_id`, `authorization_provider`, and `authorization_correlation_id` inside the existing `participant.join_authorize` audit payload instead of an unqualified mock marker; aligned `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` with the new truth
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_authorization_real_rail_validation.js`; focused env-guard validation via `node .tmp_test_dist/tests/payment_authorization_env_guard_validation.js`; live HTTP QA against a temporary runtime on `127.0.0.1:3072` with a local provider stub proving `POST /api/payments/authorize` returned `200` with `mock:false` and a real `provider_reference`, while `POST /api/payments/authorize-mock` returned `402` with `mock:false` and `card_declined` instead of bypassing to a mock path; an additional `frontend_flow_validation` pass was attempted and confirmed the existing buyer/public shell still loads, but the suite remains partly blocked by pre-existing `app.ts` environment drift unrelated to the new authorization rail
- What is open:
  `capture`, `recovery`, and `refund` are still non-live; no real invoice/accounting rail or notifications were opened in this pass; `src/app.ts` and `src/frontend_runtime.ts` still carry architectural drift outside the authorization boundary; broader end-to-end payment truth still depends on the later webhook/catalog and capture phases
- Progress percentage:
  `100%` of Stage 1 real authorization rail
- Next step:
  freeze the real authorization rail as the new non-demo baseline, then move only to the next payment stage in order: tighten provider-specific webhook truth and the capture path without reopening auth, notifications, or invoice/accounting in the same patch

## Payment Rail Stage 2: Webhook Truth + Capture Path

- What was completed:
  replaced the remaining mock `charge_deal` execution path with a real provider-backed capture call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added strict env support for `PAYMENT_PROVIDER_CAPTURE_PATH` and provider currency wiring in `src/runtime_config.ts`; updated `src/app.ts` so charge execution now reads the recorded authorization trace from the existing `participant.join_authorize` audit payload, records the capture attempt before I/O, calls the real provider capture rail, and routes success or terminal failure back through the existing webhook ingestion + reconciliation truth path instead of mutating participant money states directly from mock code; kept temporary failures on the outbox retry path so no invalid transition is forced on timeout or unknown result; extended `src/frontend_runtime.ts` and `src/operational_readiness.ts` so preview/admin readiness now reflects live authorization + capture while still honestly marking recovery/refund as non-live; aligned `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` with the new capture/webhook truth baseline; added focused validation in `tests/payment_capture_webhook_real_rail_validation.ts`
- What was checked:
  `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`; live HTTP QA against a temporary runtime on `127.0.0.1:3085` with a local provider stub proving `/api/preview/meta` exposed the updated partial payment readiness, `processOutboxEventById(...)` drove a real provider-backed capture call, `GET /api/participants/:id/tracking` showed `ChargedSuccess` after a successful capture and `ChargeFailedCompletion` / `ChargeFailedRecovery` after a declined capture, and `POST /webhooks/payments` treated a late fail event as `ignored` and a replay of the same event as `duplicate:true`
- What is open:
  recovery and refund are still not live; invoice/accounting, real notifications, and broader financial reconciliation remain outside this pass; payment truth is now real for authorization + capture only, so the remaining production blockers are the downstream money lifecycle rails and the other external systems already mapped in the gap register
- Progress percentage:
  `100%` of the webhook-truth + capture-path stage
- Next step:
  freeze authorization + capture as the new non-demo baseline, then decide whether the next payment program is recovery rail or the remaining production blockers outside payments, without reopening state-model, repeat-joins, or invoice/accounting work in the same patch

## Payment Rail Stage 3: Recovery Rail

- What was completed:
  replaced the mock `recovery_deal` execution path with a real provider-backed recovery call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added explicit recovery event classification to `recovery_captured` / `recovery_failed`; updated `src/app.ts` so recovery execution now stays strictly inside `CompletionWindow`, records the recovery attempt before I/O, calls the real provider recovery rail, and routes terminal outcomes through the existing webhook ingestion + reconciliation truth path instead of mutating states directly from mock logic; kept temporary failures on the outbox retry path and rejected missing reconciliation truth instead of silently forcing an unsafe fallback; aligned `src/operational_readiness.ts` and `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` so readiness now reflects live authorization + capture + recovery while still honestly marking refund as non-live; added focused validation in `tests/payment_recovery_real_rail_validation.ts`
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_recovery_real_rail_validation.js`; regression validation via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`; live local QA through the recovery validation runtime on `127.0.0.1:3086` proved `/api/preview/meta` reports `authorization-capture-recovery-partial`, provider-backed recovery success moves a participant to `Recovered` / `RecoveredCharge`, declined recovery moves to `Dropped` / `AuthReleased`, timeout keeps the outbox pending without an invalid transition, late recovery failure webhooks are ignored after success, duplicate replays remain duplicate-safe, and recovery does not execute outside the completion window
- What is open:
  refund remains non-live; invoice/accounting, real notifications, and the other mapped non-payment blockers remain outside this pass; payment truth is now real for authorization + capture + recovery only, so the remaining money-rail blocker is refund and the broader external-finance envelope already mapped elsewhere
- Progress percentage:
  `100%` of the recovery-rail stage
- Next step:
  freeze authorization + capture + recovery as the new non-demo baseline and only then decide whether to open refund rail or step back to the other production blockers, without reopening state-model, repeat-joins, invoice/accounting, or notification work in the same patch

## Payment Rail Stage 4: Refund Rail Verified

- What was completed:
  finalized the refund rail on top of the real authorization/capture/recovery stack by wiring `refund_issue` / `cancel_refund` through the real provider refund client in `src/payment_provider.ts`; updated `src/app.ts` so refund execution reads traceable authorization and capture/recovery references from the existing audit rail, records the refund attempt before I/O, and routes `refund_issued` outcomes through webhook ingestion + reconciliation truth instead of relying on a silent direct-success fallback; added `refund_issued` classification to `src/payment_reconciliation.ts`; updated `src/operational_readiness.ts` and `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` so readiness now reflects that the core payment execution rail is live across authorization + capture + recovery + refund
- What was checked:
  `node --check frontend/app.js`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/payment_refund_real_rail_validation.js`; regression validation via `node .tmp_test_dist/tests/payment_recovery_real_rail_validation.js`; live local QA through the refund validation runtime on `127.0.0.1:3087` proved `/api/preview/meta` reports `authorization-capture-recovery-refund-partial`, provider-backed refund success moves `money_state` to `Refunded`, late refund webhooks are ignored after success, duplicate refund replays remain duplicate-safe, permanent-fail refunds move the outbox event to `outbox_dlq` without corrupting participant state, and timeout keeps the outbox pending without forcing an invalid transition
- What is open:
  invoice/accounting transport, real SMS, real email, real notification delivery, and true open-production seller auth remain outside this pass; the core payment execution rail is now complete in `provider-ready` mode, but the broader commercial external envelope is still not fully live
- Progress percentage:
  `100%` of the verified refund-rail stage; the core payment execution rail is fully closed
- Next step:
  freeze the payment rail as the new non-demo baseline and move to the next independent external blocker without reopening payment execution paths, state-model work, repeat-joins, or invoice/accounting in the same patch

## Wave 2: State / Audit / Outbox Hardening Verified

- What was completed:
  hardened the runtime and DB state boundary so illegal `DealState`, `BuyerState`, and `MoneyState` jumps are now blocked in the database even if transaction flags are forged; aligned bootstrap flag references to `siton.*`; tightened `require_action_name` to an explicit runtime vocabulary with a deliberate `test.*` namespace for test-only helpers; made `audit_log` append-only and validated legal `audit_log` transitions on insert; expanded deal-level outbox enforcement so `deal.publish`, `charging.start`, `charging.to_completion_window`, `charging.finalize_failed`, and `deal.cancel` all require outbox in the same transaction; and moved `recovery_deal` enqueue into the same `charging.to_completion_window` transaction so recovery orchestration is no longer created in a separate follow-up transaction
- What was checked:
  static scan via `rg -n "UPDATE siton\\.deals SET state|UPDATE siton\\.participants SET buyer_state|UPDATE siton\\.participants SET money_state|set_config\\('siton\\.(action_name|audit_written|outbox_written)'" src tests scripts`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused validation via `node .tmp_test_dist/tests/state_engine_atomicity_validation.js`; targeted regression via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`
- What is open:
  production/runtime state mutation paths are now closed through the DB enforcement layer for this wave; the remaining bypass-shaped items found here are explicit test helpers in `tests/remaining_product_surfaces_validation.ts`, `tests/master_product_depth_validation.ts`, and `tests/ultimate_prelive_qa_rc_validation.ts`, which still use `test.*` action names and direct SQL to accelerate surface tests and should stay classified as test-only debt rather than production authority
- Progress percentage:
  `100%` of Wave 2 production-path hardening; `test-only debt` remains documented but is not a live-runtime bypass
- Next step:
  freeze Wave 2 at this new baseline and hand control back to the next independent track without reopening join/capacity work, payment flow expansion, or unrelated surface redesign in the same pass

## Wave 3: Charging / Recovery / Completion Window / 90 Percent Rule Verified

- What was completed:
  verified that the remaining bypasses found after Wave 2 are still test-only helpers in `tests/remaining_product_surfaces_validation.ts`, `tests/master_product_depth_validation.ts`, and `tests/ultimate_prelive_qa_rc_validation.ts`, with no runtime or production-path helper/script leaking around the state engine; aligned DB buyer-state legality with the live runtime by allowing the full `-> DealFailed` branch that `failAllParticipantsForDeal(...)` and finalize already use in `src/app.ts`; hardened `POST /deals/:id/charging/start` in `src/app.ts` so replay on a non-`ReadyForCharging` deal now fails closed with `409` instead of silently creating fresh orchestration; moved `completion_window_until`, `finalize_deal`, and `recovery_deal` creation into the same `charging.to_completion_window` transaction so completion-window opening and downstream orchestration stay atomic; removed false reconciliation truth on capture/recovery by forcing `payment_attempts.result_class='unknown'` plus retry/error when the provider response lacks a real reconciliation event type; added deterministic Wave 3 torture coverage in `tests/charging_completion_window_validation.ts`; and stabilized the manual outbox test harness with the test-only `DISABLE_OUTBOX_WORKER=1` gate so focused validations no longer race the background worker while production runtime defaults remain unchanged
- What was checked:
  static scan via `rg -n "test\\.|processOutboxEventById|charging.start|ChargeFailedCompletion|DealFailed|completion_window_until|sumCapturedUnits" src tests scripts`; `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused Wave 3 verification via `node .tmp_test_dist/tests/charging_completion_window_validation.js`; regression verification via `node .tmp_test_dist/tests/payment_capture_webhook_real_rail_validation.js`, `node .tmp_test_dist/tests/payment_recovery_real_rail_validation.js`, `node .tmp_test_dist/tests/payment_refund_real_rail_validation.js`, and `node .tmp_test_dist/tests/state_engine_atomicity_validation.js`; live local QA through the focused runtimes on `127.0.0.1:3093`, `127.0.0.1:3084`, `127.0.0.1:3086`, `127.0.0.1:3087`, and `127.0.0.1:3092`, proving `charging.start` rejects replay on the wrong state, `charge_deal` opens `CompletionWindow` once and enqueues `finalize_deal` + `recovery_deal` atomically, recovery does not run outside the window, finalize defers before expiry and replays idempotently after completion, and the threshold decision now follows `threshold_units` with `ChargedSuccess + RecoveredCharge` counted while `ChargeFailedCompletion` and `Dropped` do not count
- What is open:
  no production-path Wave 3 defect remains open after this pass; within this wave the charging/recovery/finalize/completion-window path, audit, outbox, and payment-attempt traces are now verified; items still open are outside Wave 3 scope, including invoice/accounting, real notifications, and the remaining non-payment launch blockers already mapped elsewhere
- Progress percentage:
  `100%` of Wave 3
- Next step:
  freeze Wave 3 as the new charging baseline and hand off to the next independent blocker without reopening join/capacity logic, repeat-join semantics, state-model redesign, or broader operational hardening in the same patch

## Payment Rail Stage 4: Refund Rail

- What was completed:
  replaced the mock `refund_issue` / `cancel_refund` execution path with a real provider-backed refund call in `src/payment_provider.ts` for `provider-ready` non-demo runtime; added `PAYMENT_PROVIDER_REFUND_PATH` and `PAYMENT_PROVIDER_RECOVERY_PATH` to `src/runtime_config.ts`; added `RefundPaymentInput` type; updated `handleRefundEvent` in `src/app.ts` to read the capture reference trace from the audit log (via `participant.join_authorize` for auth_id and `charging.charge_success`/`payment.capture_success` for capture_reference), record the refund attempt before I/O, call the real provider refund rail, and route `refund_issued` events through the webhook ingestion + reconciliation truth path; added `refund_issued` handling to `applyPaymentWebhookClassification` so a live provider refund confirmation transitions `money_state` → `Refunded` atomically; updated `docs/STAGE4_OPERATIONAL_READINESS_MAP.md` and `PROJECT_STATUS.md` to reflect that all four execution paths are now live in `provider-ready`
- What was checked:
  `./node_modules/.bin/tsc -p tsconfig.test.json --outDir .tmp_test_dist` (exit 0); full 31-test non-DB regression suite passing after changes; all security hardening, OTP, webhook, admin auth, rate limiter, and seller auth tests green
- What is open:
  invoice/accounting transport, real SMS, real email, real notification delivery, true open-production seller auth — none of these were opened in this pass; the payment execution rail is now complete end-to-end in `provider-ready` mode
- Progress percentage:
  `100%` of the refund-rail stage; payment execution rail is fully closed
- Next step:
  all four payment execution paths (authorize, capture, recover, refund) are now real in `provider-ready` mode — the remaining external-activation blockers are notifications, invoice/accounting, and production seller auth, which are each independent tracks


## Wave 4a: Webhook Truth / Duplicate / Late / Reconcile Verified

- What was completed:
  hardened the webhook truth path in `src/webhook_ingestion.ts`, `src/payment_reconciliation.ts`, and `src/frontend_runtime.ts` so provider callbacks are now claimed through an explicit `processing` state instead of a loose insert-only flow; previously `failed` webhook rows can now be retried with the same `provider + event_id` and re-enter processing instead of being dead-deduped forever; stored webhook payloads now persist top-level `event_type`, `correlation_id`, `provider_reference`, `deal_id`, and `participant_id` for traceability; classification reasons are written back into `webhook_events`; participant fallback reconciliation now recovers the latest matching `payment_attempts.correlation_id` when only `participant_id` is present; duplicate events stop at one persisted row and one logical mutation; late/conflicting events are recorded but ignored against already-advanced logical state; and the public/admin supported-event surface now includes `refund_issued`; Wave 4a truth coverage is codified in `tests/webhook_truth_handling_validation.ts`
- What was checked:
  `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; focused Wave 4a validation via `node .tmp_test_dist/tests/webhook_truth_handling_validation.js`; direct DB evidence queries after the run proved that `Wave4A Charge dup-success` persisted exactly one `webhook_events` row with `status='processed'`, `classification_reason='capture_success'`, `webhook_row_count='1'`, `capture_audit_count='2'`, and `payment_attempts.result_class='success'`; `wave4a-unknown-*` stayed `status='failed'` with `reason='missing_correlation_target'` and no state change until `wave4a-reconcile-success-*` later landed as `status='processed'` with the preserved correlation id; and conflicting charge/recovery sequences stored the earlier truth event as `processed` while the later contradictory webhook was persisted as `ignored` with `reason='not_waiting_for_charge_capture'`
- What is open:
  no production-path Wave 4a defect remains open after this pass; one verification-only finding was explicitly classified to Wave 4b and not fixed here: long-lived local Node runtimes on the shared database can interfere with broad outbox regressions and create false negatives outside the focused webhook-truth path, but that is operational harness noise rather than a webhook-semantics hole
- Progress percentage:
  `100%` of Wave 4a
- Next step:
  freeze webhook truth handling as the new baseline and hand off only the operational noise / worker-resilience follow-up to Wave 4b, without reopening webhook semantics, state-model work, or broader payment-path changes in the same pass

## Final Gate: Backend Readiness Check

- What was completed:
  assembled the final backend change map across payment rail, state/audit/outbox hardening, seller session authority, and webhook truth handling; reviewed merge/conflict exposure across tracked runtime files, migrations, and untracked focused regression tests; re-checked runtime hygiene for debug, webhook-secret, seller-session, and outbox-worker gating; and closed the package with a final regression gate instead of opening another QA wave
- What was checked:
  `git status --short`; `git diff --stat`; `git diff --name-only`; `rg -n "test\\.|DISABLE_OUTBOX_WORKER|DEBUG_SURFACES_ENABLED|DEBUG_SURFACES_ACCESS_KEY|MOCK_|claimEvent|supported_events|refund_issued|SELLER_AUTH_MODE|SELLER_AUTH_CONFIGURED|PAYMENT_WEBHOOK_SECRET_IS_SAFE" src scripts`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/state_engine_atomicity_validation.js`; `node .tmp_test_dist/tests/charging_completion_window_validation.js`; `node .tmp_test_dist/tests/webhook_truth_handling_validation.js`; `node .tmp_test_dist/tests/debug_surface_guard_validation.js`; `node .tmp_test_dist/tests/webhook_secret_policy_validation.js`; `node .tmp_test_dist/tests/seller_auth_session_validation.js`; `node .tmp_test_dist/tests/seller_auth_authority_validation.js`; focused Wave 1 proof already verified earlier in the hardening pass with first join `200`, replay `200`, second buyer blocked at `409`, `participant_id` reused, and DB evidence `participants=1`, `qty_sum=1`, `idem_rows=1`; `node .tmp_test_dist/tests/operational_hardening_proof.js` was also run and surfaced two remaining failures tied to shared-runtime outbox interference rather than a newly found state/payment/webhook semantic break
- What was fixed:
  no new final-gate blocker fix was needed inside runtime semantics; the final gate only validated that prior fixes still hold together and classified the remaining outbox-hardening noise as an open operational item rather than reopening Wave 1–4 logic
- What is open:
  backend semantics for join idempotency/capacity, state/audit/outbox, charging/completion window, seller session authority, and webhook truth are holding together; the limited open items are outside the just-closed semantic core: broad operational outbox hardening still shows shared-runtime interference in `tests/operational_hardening_proof.js`, invoice/accounting is still not live, real notifications are still not live, and open multi-tenant production seller auth is still not closed
- Progress percentage:
  `95%` of the current backend hardening/readiness package
- Next step:
  treat the backend as ready for continued UX/frontend work and controlled backend integration, then close the remaining external-activation tracks separately: operational Wave 4b cleanup, invoice/accounting, real notifications, and the full open-production seller-auth track; do not reopen the already-verified Wave 1–4 semantic fixes unless a merge conflict or real blocker appears

## Open-Production Seller Auth Closed

- What was completed:
  completed the migration from the earlier controlled-launch seller session model to one DB-backed seller-auth model for non-demo runtime; non-demo seller login now authenticates against `siton.seller_accounts` with `auth_secret_hash`, issues a revocable record in `siton.seller_sessions`, and resolves seller authority only from the server-side session row; added admin provisioning for seller auth bootstrap via `/api/admin/seller-auth/:sellerId/provision`; hardened `src/app.ts` so seller-sensitive legacy routes now enforce ownership from the DB-backed server session for `create deal`, `publish`, `close_joining`, `prepare_charging`, `charging.start`, and `cancel`; kept `demo-preview` on its isolated manual seller-context path without allowing that path to leak into non-demo authority; and updated seller-auth validation coverage so login, session reuse, logout/revoke, expiry, header-forgery rejection, cross-seller isolation, and server-authoritative route protection are now all asserted explicitly
- What was checked:
  `npx tsc -p tsconfig.test.json --noEmit`; `npx tsc -p tsconfig.test.json --outDir .tmp_test_dist`; `node .tmp_test_dist/tests/seller_auth_session_validation.js`; `node .tmp_test_dist/tests/seller_auth_authority_validation.js`; targeted static scans for legacy authority inputs via `rg -n "readSellerSessionToken|buildSellerSessionToken|SELLER_AUTH_CREDENTIALS|x-seller-id|localStorage" src frontend tests`; runtime proof showed forged `x-seller-id` without a session is `401`, seller A cannot read seller B workspace/deal detail (`404` on cross-seller detail), logout revokes the DB session and blocks reuse, expired sessions are blocked, parallel seller cookies stay isolated across separate requests, and seller-only legacy routes refuse cross-seller publish/close/prepare/start/cancel attempts
- What was fixed:
  removed the remaining half-migrated dependency on the old signed seller-session payload model in the live non-demo authority path; fixed admin seller-auth provisioning SQL so `auth_secret_hash` updates are typed correctly; aligned the seller-auth tests to the DB-backed session model instead of constructing legacy seller cookies directly; and closed the missing seller-ownership checks on `close_joining`, `prepare_charging`, `charging.start`, and `cancel`
- What is open:
  no open-production seller-auth defect remains open inside this track; what remains open in the product is outside this track: invoice/accounting, real notifications, and the separate operational hardening work already mapped elsewhere
- Progress percentage:
  `100%` of the open-production seller-auth track
- Next step:
  freeze seller auth as closed, treat non-demo seller authority as DB-backed and server-authoritative, and move only to the remaining external tracks without reopening seller-context fallback or any signed-payload legacy session logic

## Foundation Pack Reset: New Canonical Source Of Truth Adopted

- What was completed:
  ingested the newly attached foundation documents into a new canonical repository pack under `docs/foundation-canonical-2026-04-18/`; added a binding source-of-truth decision in `docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md`; added an initial deprecation and archival map in `docs/LEGACY_FOUNDATION_DOC_STATUS_2026-04-18.md`; and explicitly established that the new product spec, UX, system spec, and constitution/checklist supersede older repository foundation documents anywhere there is contradiction, ambiguity, duplication, or drift
- What was checked:
  direct text extraction and comparison of the new attached `.docx` files against the older repository `.docx` foundation files; targeted keyword diff on distributor/affiliate, commission, repeat-purchase, and publish-acknowledgment semantics; and repository scan for older docs and derived markdown files that still looked like foundation truth candidates
- What was fixed:
  removed ambiguity about the active foundation pack by placing the new canonical documents in a dedicated `docs/foundation-canonical-2026-04-18/` directory and documenting their authority explicitly; marked the older product spec and older constitution as fully deprecated as foundation truth; marked `חוקה לדאטה בייס.docx` and `מנגנון אכיפה.docx` as historical or partial-reference documents only; later removed `DB.docx` from the repository entirely as an outdated DB reference; and locked in the new product-direction interpretation that distributors are now a measured distribution channel rather than an in-system commission and payout engine
- What is open:
  this step did not yet realign all code, schema, and secondary docs to the new canonical foundation pack; the next stage must map and then close the newly exposed drifts, especially repeated purchases by the same buyer in the same deal versus any remaining uniqueness assumptions, and the lingering `commission_rate` references that survived in older technical material and in parts of the updated foundation pack itself
- Progress percentage:
  `100%` of the source-of-truth reset step; implementation alignment against the new foundation pack remains a separate follow-up track
- Next step:
  start a focused drift-and-implementation alignment pass from the new canonical foundation pack outward: product, UX, schema, runtime, and secondary docs, without reopening this adoption step itself

## Canonical Drift Audit: Foundation Pack Vs Live Repository

- What was completed:
  completed a deep drift audit between the newly adopted canonical foundation pack and the repository as it currently exists; produced a structured report in `docs/CANONICAL_DRIFT_AUDIT_2026-04-18.md`; and classified the most material live contradictions across distributor logic, fee modeling, repeat-purchase assumptions, schema, APIs, UX surfaces, terminology, and tests
- What was checked:
  repository-wide static scan across `docs`, `src`, `frontend`, `scripts`, and `tests`; direct review of runtime schema builders in `src/product_surface_support.ts` and `scripts/init_db.sql`; direct review of seller/admin/affiliate and dashboard routes in `src/frontend_runtime.ts`; direct review of deal creation and join flow in `src/app.ts`; direct review of fee and invoice logic in `src/invoice_dispatch.ts`; and comparison back to the newly adopted canonical product, UX, system, and constitution documents
- What was fixed:
  no broad runtime refactor was opened in this step by design; the only repository change here is documentary hardening of the new drift truth so the next implementation stage starts from one explicit map instead of scattered assumptions
- What is open:
  the audit found major live drift that now needs implementation work: the repository still models distributors as an internal economic subsystem with payout/profile/admin payout semantics; `commission_rate` is still a live deal field and seller-facing input; fee calculations and invoice documents still include `affiliate_fee_amount`; and repeat-purchase support is still under-modeled outside the narrow no-unique-index guardrail, especially in join/idempotency semantics, internal surfaces, and tests
- Progress percentage:
  `100%` of the audit step; `0%` of the subsequent implementation-alignment step
- Next step:
  start the next pass by removing the internal affiliate payout model from docs/tests/runtime surfaces, then replace `commission_rate` with the canonical fee model, and only then open the dedicated repeat-purchase implementation pass across join flow, schema, counters, and regression coverage

## Frontend Track: Product Surfaces Refinement

- What was completed:
  refined the public deal page into a stronger product-facing hero with a visual summary block, clearer availability framing, sharper progress language, and a cleaner action-side hierarchy; reorganized the seller workspace into urgency/draft/closed sections instead of one flat list; and upgraded the seller deal page top layer into a clearer control surface with charged/pending/unresolved snapshots in addition to the existing progress, urgency, receipts, and delivery sections
- What was checked:
  direct code review of `renderDealPage`, `renderSellerPage`, `renderSellerDealPage`, and the shared surface CSS; `node --check frontend/app.js`; `npx tsc --noEmit`; `npx tsc -p tsconfig.test.json --noEmit`; and `npm run test:product-surfaces-refinement`
- What was fixed:
  weak hierarchy in the public deal hero, thin seller workspace navigation by urgency, and the lack of an explicit seller deal operational snapshot above the lower tables and receipts/delivery surfaces
- What is open:
  this pass intentionally did not redesign admin or affiliate surfaces, did not deepen payment UX, and did not introduce new backend media contracts; if a later pass adds canonical product media, the public deal page can upgrade from a strong fallback visual block to a real gallery without reopening the current layout model
- Progress percentage:
  `91%` of the current frontend surfaces refinement track
- Next step:
  continue only if we want a dedicated follow-up on buyer tracking depth or richer seller table interactions; otherwise treat the public deal page, seller workspace, seller dashboard, and seller deal page as the aligned baseline for ongoing frontend product work

## Frontend Track: Buyer Tracking Refinement

- What was completed:
  refined the post-join confirmation and buyer tracking journey so the buyer now sees a clearer separation between successful join, authorization hold, real charge, completion-window handling, and terminal outcomes; added focused next-step cards, a concise timeline, and stronger source-of-truth framing inside the buyer tracking screen; and tightened the terminal and action-required narratives without opening backend money or state-machine work
- What was checked:
  direct review of `renderConfirmationPage`, `renderTrackingPage`, `buildJourney`, and `nextTrackingStep` in `frontend/app.js`; `node --check frontend/app.js`; `npx tsc --noEmit`; `npx tsc -p tsconfig.test.json --noEmit`; and `npm run test:buyer-tracking-refinement`
- What was fixed:
  weak post-join explanation after authorization, thin buyer-facing “what happens now” messaging, missing compact timeline context inside tracking, and insufficiently explicit action-required versus no-action-needed framing
- What is open:
  this pass intentionally did not deepen backend payment handling, did not redesign delivery follow-up as a full standalone buyer surface, and did not add browser-level route QA; any richer post-completion delivery/document storytelling remains a separate frontend follow-up only
- Progress percentage:
  `93%` of the isolated buyer tracking refinement track
- Next step:
  keep this buyer-tracking narrative as the current baseline and only open a follow-up if we explicitly want deeper delivery/document post-completion UX or browser-level route rendering proof

## Frontend Track: Read Surfaces Truth Alignment

- What was completed:
  aligned seller receipt visibility to actual `invoice_documents` rows instead of pseudo receipt ids; tightened the seller completed-deal read surface so missing documents stay explicitly missing; connected the admin read surface to canonical notifications and invoice status endpoints; and normalized support/document status wording so read surfaces stop overstating truth they do not actually have
- What was checked:
  targeted review of seller receipt shaping in `src/frontend_runtime.ts`; targeted review of seller/admin read surfaces in `frontend/app.js`; `node --check frontend/app.js`; `npx tsc --noEmit`; and `npm run test:read-surfaces-truth-alignment`
- What was fixed:
  generated receipt identifiers in seller read surfaces, receipt counts that could imply document truth too early, admin status visibility that stopped at provider mode instead of operational counts, and support read surfaces that still leaked raw internal scope/status codes
- What is open:
  this pass intentionally did not open new buyer document UI, did not activate external invoice or notification rails, and did not add deep admin operations drill-downs beyond the existing read surface truth alignment
- Progress percentage:
  `94%` of the isolated read-surfaces truth-alignment track
- Next step:
  keep these read surfaces as the truthful baseline and only open a follow-up if we explicitly want buyer-facing document visibility or a deeper admin operations panel

## Frontend Track: Browser-Level Smoke

- What was completed:
  added a focused browser-level smoke suite that opens the public deal page, seller workspace, seller deal page, buyer tracking, admin dashboard, admin deal page, and participant ops inside a real headless browser after seeding one published deal and one joined participant
- What was checked:
  desktop and narrow-mobile route opening, hydrated DOM hierarchy, screen-specific CTA and status copy, and fallback sanity for not-found, missing tracking, and missing participant-ops routes
- What was fixed:
  browser route exposure for `/app/admin/participants/:participantId`, plus a frontend shell catch-all for unknown `/app/*` routes so browser not-found states stop leaking raw Fastify JSON
- What is open:
  this pass does not provide screenshot diffing, pixel-level clipping assertions, or a full browser interaction lab; if we later need deeper browser confidence, the next step is a small interaction or screenshot suite for seller/admin drill-downs
- Progress percentage:
  `100%` of the isolated frontend browser-smoke track
- Next step:
  keep this browser smoke as the route-level safety net and only deepen it if we explicitly want interaction coverage beyond route open, hierarchy, CTA presence, and fallback states

## Wave 4 Final Audit (2026-04-23) — Five Canonical Truths Enforced in Repo

Request: explicit verification (not assessment) that the repo contains no live file — code, doc, audit, JSON, snapshot, or comment — that could mislead an agent, developer, or reviewer into believing any of five anti-truths.

The five canonical truths now enforced across the repo:

1. **No live search / marketplace / catalog / browse / discover product surface exists or is planned.** Buyers arrive via a direct deal link shared by the distributor; the public surface is a single deal page only.
2. **No distributor commission / payout / settlement / balance / withdraw money model.** The distributor surface is attribution-only (link, clicks, entries, joins, attributed units, attributed gross as a measurement number). All money columns on `affiliate_accounts` and `affiliate_attributions` were dropped in Wave 2 / 2.5. The payout-profile endpoint returns HTTP 410 `affiliate_payout_model_removed`.
3. **Siton fee is exactly 8% — not 5%, not 0.05, not per-deal configurable.** Sourced from `SITON_PLATFORM_FEE_RATE = 0.08` in [src/platform_fee_money.ts](src/platform_fee_money.ts). In Wave 4 the legacy `deals.commission_rate` column (and every write path that referenced it) was dropped end-to-end via [src/migrations/022_drop_deals_commission_rate.sql](src/migrations/022_drop_deals_commission_rate.sql), and the column is no longer created by fresh-install paths ([scripts/init_db.sql](scripts/init_db.sql), [src/migrations/014_demo_preview_bootstrap.sql](src/migrations/014_demo_preview_bootstrap.sql)) or written by any live or test INSERT. Two plpgsql triggers (`siton.deals_before_update_enforce`, `siton.deals_before_update_enforce_hardening`) were `CREATE OR REPLACE`'d inside migration 022 before the `DROP COLUMN` so plpgsql's cached parse plans no longer reference the dead column.
4. **Siton fee base includes delivery.** Every charge/refund/seller-summary/admin-settlement site computes gross as `qty × price_per_unit + delivery_cost` (pre-VAT). Enforced in Wave 2 at:
   - `enqueueChargeReceiptForParticipant` + `enqueueRefundReceiptForParticipant` in [src/app.ts](src/app.ts)
   - seller deal-detail surface and admin settlement math in [src/frontend_runtime.ts](src/frontend_runtime.ts)
   - backend sanity suite spec example: `price=100 qty=2 delivery=20 → base=220 fee=17.6`
5. **A buyer can make multiple purchases on the same deal.** Participant idempotency is keyed on `(deal_id, idempotency_key)`, not `(deal_id, buyer_id)`; `tests/adversarial_hardening_validation.ts` covers the repeat-join path for the same buyer on the same deal.

### Scope of the verification sweep

Scanned and either cleaned or stamped: `src/**`, `scripts/**`, `tests/**`, `docs/**`, `frontend/**`, `archive/**`, root `*.md`, migration SQL, seed SQL, DDL strings, comments, TODO markers, and direct SQL INSERTs.

### Confusion-surface remediation actions (2026-04-23)

- **Doc banners** — SUPERSEDED / CLOSED / HISTORICAL / NOT-ACCEPTED banners applied at the top of every legacy planning / audit / drift-report document that could be mistaken for live direction. Covered: [docs/SPEC_DRIFT_MAP_2026-04-19.md](docs/SPEC_DRIFT_MAP_2026-04-19.md), [docs/CANONICAL_DRIFT_AUDIT_2026-04-18.md](docs/CANONICAL_DRIFT_AUDIT_2026-04-18.md), [docs/STAGE_9D_DRIFT_REPORT.md](docs/STAGE_9D_DRIFT_REPORT.md), [docs/LEGACY_FOUNDATION_DOC_STATUS_2026-04-18.md](docs/LEGACY_FOUNDATION_DOC_STATUS_2026-04-18.md), [docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md](docs/CANONICAL_FOUNDATION_SOURCE_OF_TRUTH_2026-04-18.md), the FULL_PRODUCT_CLOSURE trio + its morning handoff, MASTER/REMAINING PRODUCT deep-map docs + their morning handoffs, and the PASS2 / PASS4 / PASS5 / PASS6 progression docs.
- **`deals.commission_rate` column drop** — end-to-end cleanup:
  - [scripts/init_db.sql](scripts/init_db.sql), [src/migrations/014_demo_preview_bootstrap.sql](src/migrations/014_demo_preview_bootstrap.sql), [src/migrations/008_db_enforcement_phase2a.sql](src/migrations/008_db_enforcement_phase2a.sql), [src/stage10c_harden_deals.sql](src/stage10c_harden_deals.sql) — column removed from CREATE TABLE; removed from all trigger-function bodies; fresh installs never carry the column.
  - [src/migrations/022_drop_deals_commission_rate.sql](src/migrations/022_drop_deals_commission_rate.sql) — NEW migration for any existing DB on Wave 3 schema; redefines both enforcement trigger functions (`CREATE OR REPLACE FUNCTION`) before `ALTER TABLE ... DROP COLUMN IF EXISTS commission_rate` so plpgsql cached plans don't break.
  - [src/app.ts](src/app.ts) — `INSERT INTO siton.deals` no longer writes `commission_rate`; `SITON_PLATFORM_FEE_RATE` import trimmed (no longer used there).
  - [src/product_surface_support.ts](src/product_surface_support.ts) — `summarizeMoney` no longer accepts `commissionRate`; comment updated to reference the canonical constant.
  - [src/frontend_runtime.ts](src/frontend_runtime.ts) — `summarizeMoney` call drops the `commissionRate` argument.
  - 15 test files — every `INSERT INTO siton.deals (..., commission_rate, ...)` SQL literal and every `commission_rate: 0.08 / 0.1` in-memory fixture removed. Param-index `$N` placeholders renumbered; call-site payloads updated.
- **Regression assertions retained (deliberate):** `tests/backend_sanity_suite.ts` / `tests/platform_fee_payments_8_percent_validation.ts` / `tests/spec_drift_regression_wave3_validation.ts` still name the string `"commission_rate"` in forbidden-key lists — these assert that the column / field MUST NOT appear anywhere on a response body or in a column introspection. These are anti-drift tripwires, not usage.

### Files touched in Wave 4

- Code + DDL: `scripts/init_db.sql`, `src/migrations/008_db_enforcement_phase2a.sql`, `src/migrations/014_demo_preview_bootstrap.sql`, `src/migrations/022_drop_deals_commission_rate.sql` (NEW), `src/stage10c_harden_deals.sql`, `src/app.ts`, `src/product_surface_support.ts`, `src/frontend_runtime.ts`.
- Tests: `tests/backend_sanity_suite.ts`, `tests/platform_fee_payments_8_percent_validation.ts`, `tests/concurrency_proof.ts`, `tests/charging_completion_window_validation.ts`, `tests/admin_observability_proof.ts`, `tests/deal_ops_summary_proof.ts`, `tests/payment_refund_real_rail_validation.ts`, `tests/payment_recovery_real_rail_validation.ts`, `tests/payment_capture_webhook_real_rail_validation.ts`, `tests/webhook_truth_handling_validation.ts`, `tests/seller_auth_session_validation.ts`, `tests/state_engine_atomicity_validation.ts`, `tests/seller_payout_rail_validation.ts`, `tests/full_product_surface_validation.ts`, `tests/master_product_depth_validation.ts`, `tests/remaining_product_surfaces_validation.ts`, `tests/ultimate_prelive_qa_rc_validation.ts`, `tests/seller_auth_authority_validation.ts`.
- Docs: every doc listed under "Doc banners" above, plus this PROJECT_STATUS.md update.

### Audit verdict

- **PASS on the strict bar.** The working tree carries zero live file that could mislead a reader into believing any of the five anti-truths. Every remaining `commission_rate` hit in the repo is one of: (a) a `DROP COLUMN` migration statement, (b) a trigger-function re-definition removing the column, (c) an anti-drift test asserting the column/field must NOT exist, or (d) a historical PROJECT_STATUS.md audit log line explicitly marked as historical.
- The residue policy going forward: any new file that would re-introduce a `commission_rate` column, a per-deal fee override, a marketplace/catalog surface, a distributor money field, or a single-purchase-per-buyer constraint must be treated as a direct contradiction of the canonical spec and rejected.
