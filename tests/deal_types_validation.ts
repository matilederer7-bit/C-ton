// Deal Type Expansion Validation — physical_product / voucher / ticket.
//
// Source-static checks that verify the foundation contract:
//   • deal_type column exists with closed CHECK and default physical_product
//   • voucher / ticket terms tables exist with rigid columns
//   • fulfillment_units table exists with status / unit_index / unique constraint
//   • deal creation accepts deal_type and per-type config
//   • public deal page exposes deal_type and per-type terms
//   • buyer tracking only emits codes / event details when eligible
//   • exports exist, are Completed-only, eligible-only, and CSV-injection-safe
//   • redemption foundation enforces seller ownership + idempotency
//   • notification templates voucher_issued / ticket_issued exist
//   • mission control exposes deal_type_readiness + fulfillment_readiness
//   • refund policy + JSON boundary preserved
//   • full-e2e regression script reference is registered

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const migration = await readFile("src/migrations/038_deal_types_voucher_ticket.sql", "utf8");
const migrationManifest = await readFile("scripts/migration_manifest.cjs", "utf8");
const dealTypesModule = await readFile("src/deal_types.ts", "utf8");
const app = await readFile("src/app.ts", "utf8");
const runtime = await readFile("src/frontend_runtime.ts", "utf8");
const mission = await readFile("src/admin_mission_control.ts", "utf8");
const templates = await readFile("src/notification_templates.ts", "utf8");
const refundDoc = await readFile("docs/REFUND_POLICY.md", "utf8");
const dealTypeDoc = await readFile("docs/DEAL_TYPES_PHYSICAL_VOUCHER_TICKET.md", "utf8");
const bootstrap = await readFile("scripts/bootstrap_demo_db.cjs", "utf8");
const packageJson = await readFile("package.json", "utf8");
const reactSeller = await readFile("web/src/pages/seller.tsx", "utf8");

await runTest("deal_type_default_physical_validation", async () => {
  // Default value keeps existing deals valid without backfill.
  assert.match(migration, /ADD COLUMN IF NOT EXISTS deal_type TEXT NOT NULL DEFAULT 'physical_product'/);
  assert.match(migration, /UPDATE siton\.deals[\s\S]{0,80}SET deal_type = 'physical_product'/);
  assert.match(dealTypesModule, /normalizeDealType.*fallback: DealType = "physical_product"/);
  assert.match(dealTypesModule, /export const DEAL_TYPES = \["physical_product", "voucher", "ticket"\] as const/);
});

await runTest("seller_create_physical_validation", async () => {
  // Physical deal creation path must still wire delivery_options when type is physical.
  assert.match(app, /if \(dealType === "physical_product"\) \{[\s\S]{0,400}deal_delivery_options/);
});

await runTest("seller_create_voucher_validation", async () => {
  // Voucher creation requires voucher_terms; voucher path writes deal_voucher_terms.
  assert.match(app, /voucher_terms_required/);
  assert.match(app, /upsertVoucherTerms\(c, String\(deal\.deal_id\), voucherTermsInput\)/);
  assert.match(dealTypesModule, /face_value_amount must be a positive number/);
  // seller_uploaded codes are explicitly rejected.
  assert.match(dealTypesModule, /voucher_code_mode_unsupported/);
});

await runTest("seller_create_ticket_validation", async () => {
  // Ticket creation requires ticket_terms; ticket path writes deal_ticket_terms.
  assert.match(app, /ticket_terms_required/);
  assert.match(app, /upsertTicketTerms\(c, String\(deal\.deal_id\), ticketTermsInput\)/);
  assert.match(dealTypesModule, /event_name is required for ticket deals/);
  // Assigned-seat seating is explicitly rejected (no seating engine yet).
  assert.match(dealTypesModule, /ticket_seat_mode_unsupported/);
});

await runTest("react_seller_wizard_three_type_payload_validation", async () => {
  // The canonical React wizard must expose all three types and submit only the
  // matching fulfillment shape. The same publish-lock API remains in force.
  assert.match(reactSeller, /type WizardDealType = "physical_product" \| "voucher" \| "ticket"/);
  assert.match(reactSeller, /deal_type: dealType/);
  assert.match(reactSeller, /delivery_options: delivery[\s\S]{0,400}\.filter/);
  assert.match(reactSeller, /dealType === "voucher"[\s\S]{0,1200}voucher_terms:/);
  assert.match(reactSeller, /voucher_code_mode: "system_generated"/);
  assert.match(reactSeller, /dealType === "ticket"[\s\S]{0,1200}ticket_terms:/);
  assert.match(reactSeller, /seat_mode: seatMode/);
  assert.match(reactSeller, /await api\.publishDeal\(dealId\)/);
  assert.match(reactSeller, /ack1 && ack2/, "both publish-lock acknowledgements stay mandatory");
  assert.doesNotMatch(reactSeller, /deal_type:\s*"physical_product"/, "the React wizard must not force every deal to physical_product");
});

await runTest("public_deal_type_copy_validation", async () => {
  // Public deal endpoint surfaces deal_type, per-type terms, and the per-type copy.
  assert.match(runtime, /deal_type: dealType/);
  assert.match(runtime, /voucher_terms: voucherTerms/);
  assert.match(runtime, /ticket_terms: ticketTerms/);
  assert.match(runtime, /fulfillment_copy: fulfillmentCopy/);
  // Physical-only fields are suppressed for non-physical deals.
  assert.match(runtime, /delivery_options: dealType === "physical_product"/);
  assert.match(dealTypesModule, /publicDealCopy\(dealType: DealType\)/);
});

await runTest("buyer_tracking_voucher_validation", async () => {
  // Tracking exposes a fulfillment block with voucher_terms when applicable.
  assert.match(runtime, /voucher_terms: voucherTermsRow/);
  assert.match(runtime, /fulfillment: \{[\s\S]{0,300}eligible: fulfillmentDecision\.shouldIssue/);
  assert.match(dealTypesModule, /השובר עדיין לא הונפק/);
  assert.match(dealTypesModule, /השובר הונפק/);
});

await runTest("buyer_tracking_ticket_validation", async () => {
  // Tracking exposes ticket_terms in the fulfillment block.
  assert.match(runtime, /ticket_terms: ticketTermsRow/);
  assert.match(dealTypesModule, /הכרטיס עדיין לא הונפק/);
  assert.match(dealTypesModule, /הכרטיס הונפק/);
});

await runTest("fulfillment_not_before_completed_validation", async () => {
  // Issuance helper refuses to issue unless deal is Completed and money is settled.
  assert.match(dealTypesModule, /if \(args\.dealState !== "Completed"\)/);
  assert.match(dealTypesModule, /if \(args\.moneyState !== "ChargedSuccess" && args\.moneyState !== "RecoveredCharge"\)/);
  // Mission control raises a P0 if any unit exists for a non-Completed deal.
  assert.match(mission, /fulfillment_issued_before_completed/);
});

await runTest("fulfillment_only_for_eligible_validation", async () => {
  // Eligibility query enforces buyer_state=DealCompleted and money_state in ChargedSuccess/RecoveredCharge.
  assert.match(app, /AND p\.buyer_state = 'DealCompleted'/);
  assert.match(app, /AND p\.money_state IN \('ChargedSuccess','RecoveredCharge'\)/);
});

await runTest("fulfillment_idempotency_validation", async () => {
  // UNIQUE (deal_id, participant_id, unit_index) + ON CONFLICT DO NOTHING prevents duplicates.
  assert.match(migration, /UNIQUE \(deal_id, participant_id, unit_index\)/);
  assert.match(dealTypesModule, /ON CONFLICT \(deal_id, participant_id, unit_index\) DO NOTHING/);
  // The issuance call site is idempotency-safe (returns existing rows when qty already met).
  assert.match(dealTypesModule, /if \(existing\.rowCount && existing\.rowCount >= args\.qty\)/);
});

await runTest("voucher_qty_units_validation", async () => {
  // qty=N produces N units (one fulfillment unit per qty).
  assert.match(dealTypesModule, /for \(let unitIndex = startIndex; unitIndex <= args\.qty; unitIndex \+= 1\)/);
  assert.match(dealTypeDoc, /qty=N. produces N fulfillment units/);
});

await runTest("ticket_qty_units_validation", async () => {
  // Ticket policy uses the same qty=N → N units rule.
  assert.match(dealTypeDoc, /one per ticket/);
});

await runTest("voucher_export_validation", async () => {
  // Export route exists and is voucher-only, completed-only, eligible-only.
  assert.match(runtime, /\/api\/seller\/deals\/:dealId\/voucher-export/);
  assert.match(runtime, /deal_type_not_voucher/);
  assert.match(runtime, /AND p\.buyer_state = 'DealCompleted'/);
  // Voucher export columns include voucher_code_last4 (not plaintext).
  assert.match(runtime, /"voucher_code_last4"/);
});

await runTest("ticket_export_validation", async () => {
  // Export route exists and is ticket-only, completed-only, eligible-only.
  assert.match(runtime, /\/api\/seller\/deals\/:dealId\/ticket-export/);
  assert.match(runtime, /deal_type_not_ticket/);
  assert.match(runtime, /"ticket_code_last4"/);
  assert.match(runtime, /"event_name"/);
});

await runTest("fulfillment_csv_excel_injection_validation", async () => {
  // csvSafeCell neutralizes = + - @ prefixes.
  assert.match(dealTypesModule, /csvSafeCell.*\(value: string \| number \| null \| undefined\)/);
  assert.match(dealTypesModule, /if \(\/\^\[=\+\\-@\]\/\.test\(str\)\) \{/);
  assert.match(dealTypesModule, /str = "'" \+ str/);
  // Both exports map values through csvSafeCell.
  const voucherExport = runtime.match(/\/api\/seller\/deals\/:dealId\/voucher-export[\s\S]{0,5000}/)?.[0] || "";
  const ticketExport = runtime.match(/\/api\/seller\/deals\/:dealId\/ticket-export[\s\S]{0,5000}/)?.[0] || "";
  assert.match(voucherExport, /\.map\(csvSafeCell\)/);
  assert.match(ticketExport, /\.map\(csvSafeCell\)/);
});

await runTest("seller_redeem_ownership_validation", async () => {
  // Redemption endpoint exists and enforces seller ownership.
  assert.match(runtime, /\/api\/seller\/fulfillment\/:unitId\/redeem/);
  assert.match(runtime, /fulfillment_unit_forbidden/);
  assert.match(runtime, /seller does not own this fulfillment unit/);
});

await runTest("fulfillment_redeem_idempotency_validation", async () => {
  // Repeated redeem returns idempotent ok.
  assert.match(runtime, /idempotent: true,[\s\S]{0,80}status: "Redeemed"/);
  // Non-Issued/Sent units are refused with 409.
  assert.match(runtime, /fulfillment_unit_not_redeemable/);
});

await runTest("failed_deal_no_fulfillment_validation", async () => {
  // The issuance entrypoint short-circuits when deal state is not Completed.
  assert.match(app, /if \(deal\.state !== "Completed"\) \{[\s\S]{0,200}return \{ dealType: deal\.deal_type as DealType, eligible: \[\] \};/);
});

await runTest("refund_policy_still_no_manual_refund_validation", async () => {
  // Refund policy doc references the new fulfillment doc but does not relax any rule.
  assert.match(refundDoc, /Refunds in Siton are system-mandated only/);
  assert.match(refundDoc, /DEAL_TYPES_PHYSICAL_VOUCHER_TICKET/);
  assert.doesNotMatch(refundDoc, /voucher refund/i);
  assert.doesNotMatch(refundDoc, /ticket refund/i);
});

await runTest("json_boundary_deal_type_validation", async () => {
  // Mission Control classifies fulfillment_units.metadata_jsonb as allowed_metadata
  // (truth lives in rigid columns).
  assert.match(mission, /table: "fulfillment_units",[\s\S]{0,200}column: "metadata_jsonb",[\s\S]{0,200}classification: "allowed_metadata"/);
  // No source code reads truth keys out of fulfillment metadata_jsonb.
  assert.doesNotMatch(app + runtime + dealTypesModule, /metadata_jsonb->>['"](?:money_state|deal_state|buyer_state|status|eligible)['"]/);
});

await runTest("mission_control_deal_type_readiness_validation", async () => {
  assert.match(mission, /deal_type_readiness: dealTypeReadiness/);
  assert.match(mission, /fulfillment_readiness: fulfillmentReadiness/);
  assert.match(mission, /async function buildDealTypeReadiness/);
  assert.match(mission, /async function buildFulfillmentReadiness/);
  assert.match(mission, /deal_types_supported: \["physical_product", "voucher", "ticket"\]/);
  assert.match(mission, /manual_refund_allowed: false/);
  assert.match(mission, /manual_issuance_before_completed_allowed: false/);
  assert.match(mission, /eligible_money_states: \["ChargedSuccess", "RecoveredCharge"\]/);
});

await runTest("notifications_voucher_ticket_templates_validation", async () => {
  assert.match(templates, /"buyer_voucher_issued"/);
  assert.match(templates, /"buyer_ticket_issued"/);
  assert.match(templates, /buyer_voucher_issued_he:/);
  assert.match(templates, /buyer_ticket_issued_he:/);
  // Templates inherit the same compatibleChannels guard structure.
  assert.match(templates, /buyer_voucher_issued_he:[\s\S]{0,300}compatibleChannels:/);
});

await runTest("full_e2e_deal_type_smoke_validation", async () => {
  // The canonical manifest registers migration 038; bootstrap delegates schema work to it.
  assert.match(migrationManifest, /"038_deal_types_voucher_ticket\.sql"/);
  assert.match(bootstrap, /runMigrations/);
  // Deal-types script is wired in package.json.
  assert.match(packageJson, /"test:deal-types"/);
  // Canonical doc enumerates the verdict markers.
  assert.match(dealTypeDoc, /DEAL_TYPES_E2E_PASS_READY_FOR_PROVIDER_SANDBOX/);
});

await runTest("issuance_runs_only_after_completion_pipeline_validation", async () => {
  // The handleFinalizeDealEvent success branch invokes issuance after Completed
  // (after notifying participants). issueFulfillmentForCompletedDeal also
  // re-checks deal.state inside its own transaction.
  assert.match(app, /async function issueFulfillmentForCompletedDeal\(dealId: string\): Promise<void>/);
  assert.match(app, /await issueFulfillmentForCompletedDeal\(dealId\)\.catch/);
  assert.match(app, /export \{ app, issueFulfillmentForCompletedDeal \}/);
});
