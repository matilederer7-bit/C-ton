// Canonical SQL invariants that used to be asserted only by Base44-era tests.
//
// Lean Refactor D3 retires the Base44 gate cluster. Two of its tests carried
// assertions about LIVE canonical sources — the Mall discovery read model
// (migration 049) and the siton_inventory audit-function hardening — that no
// other test repeated. They live here now, against the canonical files only,
// so the Base44 wrappers can go without losing coverage.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PUBLIC_MALL_DEAL_FIELDS } from "../src/mall_read_model.js";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

// ── Migration 049: the Mall discovery read model ────────────────────────────
// Kept from tests/base44_mall_contract_validation.ts (its only assertions on a
// canonical file). The Mall stays in the product (hidden behind
// PUBLIC_MALL_ENABLED); its schema, indexes and PII boundary are live.
const migration = read("src/migrations/049_mall_discovery_read_model.sql");
assert.match(migration, /CREATE TABLE IF NOT EXISTS siton\.discovery_events/, "049 creates the discovery_events table");
assert.match(migration, /idx_deals_mall_type_published/, "049 keeps the Mall type/published index");
assert.match(migration, /idx_deals_mall_state_published/, "049 keeps the Mall state/published index");
assert.match(migration, /idx_deal_images_mall_order/, "049 keeps the Mall image-order index");
assert.doesNotMatch(migration, /WHERE public_url IS NOT NULL/, "049 must not partially index on public_url");
assert.match(migration, /acquisition_source IN \('direct', 'mall', 'distributor', 'other'\)/, "049 constrains acquisition_source to the four analytics-only sources");
assert.doesNotMatch(migration, /(?:buyer_email|buyer_phone|ip_address|user_agent|payment_reference)/i, "049 stores no buyer PII or payment reference in the discovery read model");

// The public Mall projection exposes no buyer PII, money state or internal
// row identity: the read model's field allowlist is the contract the API
// serves (src/mall_read_model.ts) and it must stay free of these names.
const publicFields = new Set<string>(PUBLIC_MALL_DEAL_FIELDS as readonly string[]);
assert.ok(publicFields.size > 0, "PUBLIC_MALL_DEAL_FIELDS is non-empty");
for (const forbidden of ["buyer_email", "buyer_phone", "ip_address", "user_agent", "payment_reference", "source_deal_record_id", "source_image_record_id", "published_sort_key", "commission_rate", "payout_amount", "charge_amount", "seller_id", "owner_user_id"]) {
  assert.equal(publicFields.has(forbidden), false, `PUBLIC_MALL_DEAL_FIELDS must not expose ${forbidden}`);
}

// ── siton_inventory audit functions: fixed, empty search_path ──────────────
// Kept from tests/supabase_inventory_activation_hardening_validation.ts, which
// asserted a Base44-era copy (base44/supabase/siton_inventory_activation_hardening.sql)
// of what the canonical grant file supabase/staging/001 already applies. The
// hardening itself is live: both trigger functions that reject audit-table
// mutations run with search_path = '' so a malicious schema on the path cannot
// shadow what they reference.
const inventory = read("supabase/staging/001_siton_inventory_v1.sql");
assert.match(inventory, /CREATE OR REPLACE FUNCTION siton_inventory\.reject_participant_state_audit_mutation\(\)/, "001 defines the participant audit guard");
assert.match(inventory, /CREATE OR REPLACE FUNCTION siton_inventory\.reject_deal_state_audit_mutation\(\)/, "001 defines the deal audit guard");
assert.match(inventory, /ALTER FUNCTION siton_inventory\.reject_participant_state_audit_mutation\(\)\s+SET search_path = '';/, "participant audit guard runs with an empty search_path");
assert.match(inventory, /ALTER FUNCTION siton_inventory\.reject_deal_state_audit_mutation\(\)\s+SET search_path = '';/, "deal audit guard runs with an empty search_path");
assert.match(inventory, /EXECUTE FUNCTION siton_inventory\.reject_participant_state_audit_mutation\(\)/, "participant audit guard is wired to a trigger");
assert.match(inventory, /EXECUTE FUNCTION siton_inventory\.reject_deal_state_audit_mutation\(\)/, "deal audit guard is wired to a trigger");

console.log("PASS canonical SQL invariants: migration 049 Mall read model + PUBLIC_MALL_DEAL_FIELDS PII boundary + siton_inventory audit-guard search_path hardening");
