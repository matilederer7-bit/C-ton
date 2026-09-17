// Product catalog (migration 072) — static + pure-rule validation.
//
// Ported from the shelf branch codex/amazon-benchmark-upgrade
// (tests/amazon_product_catalog_validation.ts) onto current master: the
// Base44 / legacy-frontend assertions of the original were dropped; the React
// web app (web/src) is the canonical frontend and is asserted instead.
//
//   • migration 072 is registered after 069 (070 reserved for PR #24) and
//     creates products / product_images / deals.product_id + snapshot + trigger
//     + delivery estimate columns, without a fourth deal type
//   • product_catalog rules: typed attributes, fulfillment defaults, deterministic
//     snapshot hash, revision status, estimate wording
//   • app.ts: seller-scoped writers, Product-backed create/publish rules,
//     shared-storage-safe image cleanup
//   • frontend_runtime.ts: seller-scoped reads, public projection of the snapshot
//   • web/src: Product Library pages, wizard prefill, estimate inputs, locked
//     Draft fields, public estimate rendering — mobile-safe (cards, not a table)
//   • enrichment stays a provider seam (no provider, no browser key)
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  buildProductSnapshot, describeDeliveryEstimate, normalizeDeliveryEstimate, normalizeFulfillmentDefaults,
  productDealRevisionStatus, validateProductAttributes, PRODUCT_TYPES
} from "../src/product_catalog.js";
import { productEnrichmentReadiness } from "../src/product_enrichment.js";
import {
  applyProductLibraryFilters, deliveryEstimateText, productDealRevisionStatus as clientRevisionStatus,
  productLibraryEmptyKind, validateEstimateRange
} from "../web/src/productLibrary.js";

async function runTest(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

const [migration, manifest, schema, app, runtime, dealTypes, sellerPage, productsPage, dealPage, apiClient, styles, grants] = await Promise.all([
  readFile("src/migrations/072_product_catalog_and_fulfillment_estimates.sql", "utf8"),
  readFile("scripts/migration_manifest.cjs", "utf8"),
  readFile("src/schema_contract.ts", "utf8"),
  readFile("src/app.ts", "utf8"),
  readFile("src/frontend_runtime.ts", "utf8"),
  readFile("src/deal_types.ts", "utf8"),
  readFile("web/src/pages/seller.tsx", "utf8"),
  readFile("web/src/pages/sellerProducts.tsx", "utf8"),
  readFile("web/src/pages/deal.tsx", "utf8"),
  readFile("web/src/api.ts", "utf8"),
  readFile("web/src/styles.css", "utf8"),
  readFile("supabase/staging/025_product_catalog_grants.sql", "utf8")
]);

await runTest("migration_071_registered_after_069_without_renumbering", async () => {
  const names = await readdir("src/migrations");
  assert.ok(names.includes("072_product_catalog_and_fulfillment_estimates.sql"));
  assert.equal(names.some((n) => /^06[2-4]_.*product/.test(n) || /^070_/.test(n)), false, "071 does not squat on 062-064 or on the 070 slot reserved for PR #24");
  const ids = [...manifest.matchAll(/\["(\d{3}a?)", "/g)].map((m) => m[1]);
  assert.equal(ids[ids.length - 1], "071", "071 is the last manifest position");
  assert.equal(ids[ids.length - 2], "069", "071 appends directly after 069 (070 is left for the long-horizon renumbering)");
  assert.match(schema, /"products", "product_images"/, "boot fail-closes until 071 is applied (same rule as content tables)");
});

await runTest("migration_071_shape_and_constraints", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS siton\.products/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS siton\.product_images/);
  assert.match(migration, /product_type IN \('physical_product','voucher','ticket'\)/, "no fourth product type");
  assert.doesNotMatch(migration, /'service'/, "the shelf branch's service deal type is not carried");
  assert.doesNotMatch(migration, /deal_service_terms|viral_events_event_type_check/, "funnel/service extensions are not carried");
  assert.match(migration, /product_snapshot_jsonb JSONB/);
  assert.match(migration, /product_id IS NULL OR product_snapshot_jsonb IS NOT NULL/, "legacy product_id NULL Deals remain valid");
  assert.match(migration, /prevent_published_deal_product_snapshot_change/);
  assert.match(migration, /OLD\.state <> 'Draft' OR NEW\.state <> 'Draft'/, "snapshot cannot change during or after publication");
  assert.match(migration, /ON DELETE SET NULL/, "a Product row removal never cascades into Deals");
  assert.match(migration, /estimated_min_business_days INTEGER NULL/);
  assert.match(migration, /estimated_max_business_days >= estimated_min_business_days/);
  assert.match(migration, /BETWEEN 0 AND 365/);
  assert.match(dealTypes, /export const DEAL_TYPES = \["physical_product", "voucher", "ticket"\] as const/, "closed deal type set unchanged");
  assert.deepEqual([...PRODUCT_TYPES], ["physical_product", "voucher", "ticket"]);
});

await runTest("staging_grants_follow_the_web_runtime_only_rule", () => {
  assert.match(grants, /run migration 072 before this grant file/);
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON siton\.products TO siton_web_runtime/);
  assert.doesNotMatch(grants, /GRANT[^;]+\b(?:anon|authenticated)\b/i, "no Data API exposure");
  assert.match(grants, /products must be archived, not deleted by the web runtime/);
});

await runTest("typed_attributes_and_fulfillment_defaults_are_validated", () => {
  const physical = validateProductAttributes("physical_product", { weight_grams: "250", color: " שחור ", variation_axes: [{ name: "מידה", values: ["S", "M", "M", ""] }] });
  assert.equal(physical.weight_grams, 250);
  assert.equal(physical.color, "שחור");
  assert.deepEqual(physical.variation_axes, [{ name: "מידה", values: ["S", "M"] }]);
  assert.throws(() => validateProductAttributes("physical_product", { weight_grams: -1 }), /weight_grams/);
  assert.throws(() => validateProductAttributes("voucher", { redemption_instructions: "x" }), /redemption_location is required/);
  assert.throws(() => validateProductAttributes("voucher", { redemption_location: "a", redemption_instructions: "b", valid_from: "2026-10-01", valid_until: "2026-09-01" }), /valid_until must be after/);
  const ticket = validateProductAttributes("ticket", { event_name: "הופעה", event_starts_at: "2026-12-01T18:00:00Z", venue_name: "היכל", entry_instructions: "QR" });
  assert.equal(ticket.ticket_type, "general_admission");
  assert.equal(ticket.seat_mode, "general_admission");
  assert.throws(() => validateProductAttributes("ticket", { event_name: "x" }), /event_starts_at is required/);
  assert.throws(() => normalizeFulfillmentDefaults({ estimated_min_business_days: 5, estimated_max_business_days: 2 }), /at least/);
  assert.throws(() => normalizeFulfillmentDefaults({ estimated_min_business_days: 1.5 }), /integer/);
  assert.deepEqual(normalizeFulfillmentDefaults({}), { estimated_min_business_days: null, estimated_max_business_days: null, estimate_anchor: "deal_completed" });
  assert.throws(() => normalizeDeliveryEstimate({ estimated_min_business_days: 400 }), /estimated_min_business_days is invalid/);
  assert.deepEqual(normalizeDeliveryEstimate({ estimated_min_business_days: "2", estimated_max_business_days: "" }), { estimated_min_business_days: 2, estimated_max_business_days: null });
});

await runTest("snapshot_hash_is_deterministic_and_revision_aware", () => {
  const product = {
    product_id: "11111111-1111-4111-8111-111111111111", revision: 2, name: "מצלמה", short_description: "קומפקטית",
    long_description: "תיאור", product_type: "physical_product", category: "אלקטרוניקה",
    type_attributes: { color: "שחור" }, fulfillment_defaults: { estimated_min_business_days: 2, estimated_max_business_days: 5 }
  };
  const images = [{ product_image_id: "22222222-2222-4222-8222-222222222222", storage_provider: "supabase", storage_key: "p/a.webp", public_url: null, original_filename: "a.webp", mime_type: "image/webp", size_bytes: 1200, checksum_sha256: "a".repeat(64), sort_order: 0, is_primary: true }];
  const first = buildProductSnapshot(product, images);
  const replay = buildProductSnapshot({ ...product, type_attributes: { color: "שחור" } }, images);
  assert.equal(first.content_hash, replay.content_hash, "same Product revision → same hash");
  const edited = buildProductSnapshot({ ...product, revision: 3, name: "מצלמה פלוס" }, images);
  assert.notEqual(first.content_hash, edited.content_hash);
  assert.equal(first.name, "מצלמה"); assert.equal(edited.name, "מצלמה פלוס"); assert.equal(first.product_id, edited.product_id);
  assert.deepEqual(productDealRevisionStatus(2, 3), { product_snapshot_revision: 2, current_product_revision: 3, snapshot_status: "historical", uses_historical_product_version: true });
  assert.equal(productDealRevisionStatus(3, 3).snapshot_status, "current");
  assert.equal(productDealRevisionStatus(undefined, 3).snapshot_status, "unknown");
  assert.throws(() => buildProductSnapshot({ ...product, product_type: "service" }, images), /product_type must be one of/);
});

await runTest("delivery_estimate_wording_is_shared_by_server_and_client", () => {
  assert.equal(describeDeliveryEstimate({ estimated_min_business_days: 2, estimated_max_business_days: 5 }).estimate_text, "2–5 ימי עסקים מהשלמת העסקה");
  assert.equal(describeDeliveryEstimate({ estimated_min_business_days: 3, estimated_max_business_days: 3 }).estimate_text, "3 ימי עסקים מהשלמת העסקה");
  assert.equal(describeDeliveryEstimate({ estimated_min_business_days: null, estimated_max_business_days: 7 }).estimate_text, "עד 7 ימי עסקים מהשלמת העסקה");
  assert.equal(describeDeliveryEstimate({}).estimate_text, null);
  assert.equal(deliveryEstimateText({ estimated_min_business_days: 2, estimated_max_business_days: 5 }), describeDeliveryEstimate({ estimated_min_business_days: 2, estimated_max_business_days: 5 }).estimate_text);
  assert.equal(deliveryEstimateText({ estimate_text: "מהשרת" }), "מהשרת", "server projection wins when present");
  assert.equal(validateEstimateRange("", ""), null);
  assert.equal(validateEstimateRange("2", "5"), null);
  assert.match(String(validateEstimateRange("5", "2")), /מקסימום/);
  assert.match(String(validateEstimateRange("400", "")), /365/);
  assert.match(String(validateEstimateRange("1.5", "")), /365/);
});

await runTest("product_library_pure_rules", () => {
  const rows = [
    { product_id: "physical", name: "מצלמה", category: "אלקטרוניקה", product_type: "physical_product", status: "active", revision: 3, deals_count: 2, updated_at: "2026-08-30T10:00:00Z" },
    { product_id: "voucher", name: "שובר ספא", category: "מתנות", product_type: "voucher", status: "archived", revision: 1, deals_count: 7, updated_at: "2026-08-20T10:00:00Z" },
    { product_id: "ticket", name: "כרטיס להופעה", category: "תרבות", product_type: "ticket", status: "active", revision: 2, deals_count: 1, updated_at: "2026-08-31T10:00:00Z" }
  ];
  assert.deepEqual(applyProductLibraryFilters(rows, { query: "מצלמה" }).map((r) => r.product_id), ["physical"]);
  assert.deepEqual(applyProductLibraryFilters(rows, { query: "תרבות" }).map((r) => r.product_id), ["ticket"], "category is searchable");
  assert.deepEqual(applyProductLibraryFilters(rows, { status: "archived" }).map((r) => r.product_id), ["voucher"]);
  assert.deepEqual(applyProductLibraryFilters(rows, { type: "ticket" }).map((r) => r.product_id), ["ticket"]);
  assert.deepEqual(applyProductLibraryFilters(rows, { sort: "deals" }).map((r) => r.product_id), ["voucher", "physical", "ticket"]);
  assert.deepEqual(applyProductLibraryFilters(rows, { sort: "updated" }).map((r) => r.product_id), ["ticket", "physical", "voucher"]);
  assert.deepEqual(applyProductLibraryFilters([{ product_id: "z", name: "Zulu" }, { product_id: "a", name: "Alpha" }], { sort: "name" }).map((r) => r.product_id), ["a", "z"]);
  assert.equal(productLibraryEmptyKind([], [], {}), "library-empty");
  assert.equal(productLibraryEmptyKind(rows, [], { query: "לא קיים" }), "search-empty");
  assert.equal(productLibraryEmptyKind(rows, [], { type: "voucher" }), "filter-empty");
  assert.equal(productLibraryEmptyKind(rows, rows, {}), "none");
  assert.deepEqual(clientRevisionStatus({ product_snapshot_revision: 1 }, 3), { snapshotRevision: 1, currentRevision: 3, isCurrent: false, isHistorical: true, isUnknown: false });
  assert.equal(clientRevisionStatus({ product_snapshot_revision: 3 }, 3).isCurrent, true);
});

await runTest("app_writers_are_seller_scoped_and_snapshot_safe", () => {
  assert.match(app, /app\.post\("\/api\/seller\/products", SELLER_AUTHORITY_ROUTE/);
  assert.match(app, /app\.patch\("\/api\/seller\/products\/:productId", SELLER_AUTHORITY_ROUTE/);
  assert.match(app, /app\.post\("\/api\/seller\/deals\/:dealId\/product", SELLER_AUTHORITY_ROUTE/);
  assert.match(app, /WHERE product_id=\$1 AND seller_id=\$2\$\{allowArchived \? "" : " AND status='active'"\}/, "Seller A cannot use Seller B's Product; archived Products cannot start a Deal");
  assert.match(app, /if \(!productId && !title\) \{/, "Product-backed creation does not trust browser-owned copy");
  assert.match(app, /product_type_mismatch/);
  assert.match(app, /product_snapshot_fields_locked/, "Draft edits cannot mutate Product-owned snapshot copy");
  assert.match(app, /product_type cannot change after creation/);
  assert.match(app, /revision=revision\+1/, "editing a Product creates revision N+1");
  assert.match(app, /deal_product_readiness_failed/);
  assert.match(app, /delivery_estimate_missing/);
  assert.doesNotMatch(app, /product_snapshot_image_missing/, "a Product without imagery may still start a Deal whose images are uploaded in the wizard");
  assert.equal((app.match(/SELECT 1 FROM siton\.product_images WHERE storage_provider=\$1 AND storage_key=\$2/g) || []).length, 2, "image delete + cleanup batch both reference-count shared blobs");
  assert.match(app, /retained_shared/);
  assert.match(app, /NOT EXISTS \(SELECT 1 FROM siton\.product_images pi/, "deal deletion never schedules a Product-owned blob");
  assert.match(app, /\.\.\.normalizeDeliveryEstimate\(option\)/);
  assert.equal((app.match(/\.\.\.normalizeDeliveryEstimate\(option\)/g) || []).length, 3, "create, draft patch and delivery PUT all normalize estimates");
});

await runTest("runtime_reads_are_seller_scoped_and_public_projection_is_presentation_only", () => {
  assert.match(runtime, /app\.get\("\/api\/seller\/products"/);
  assert.match(runtime, /LEFT JOIN siton\.deals d ON d\.product_id=p\.product_id AND d\.seller_id=p\.seller_id/, "Product Deal counts cannot include another Seller's rows");
  assert.match(runtime, /FROM siton\.products WHERE product_id=\$1 AND seller_id=\$2 LIMIT 1/);
  assert.match(runtime, /FROM siton\.deals WHERE product_id=\$1 AND seller_id=\$2/);
  assert.match(runtime, /productDealRevisionStatus\(row\.product_snapshot_jsonb\?\.product_revision, currentRevision\)/);
  assert.match(runtime, /product: productSnapshotProjection\(\(deal as any\)\.product_snapshot_jsonb\)/);
  assert.doesNotMatch(runtime.slice(runtime.indexOf("function productSnapshotProjection"), runtime.indexOf("async function buildPublicDealPayload")), /seller_id|storage_key/, "public projection carries no storage or seller internals");
  assert.match(runtime, /\.\.\.describeDeliveryEstimate\(row\)/);
  assert.match(runtime, /product_snapshot: draft\.product_snapshot_jsonb \?\? null/);
});

await runTest("react_seller_surface_carries_the_library_and_the_locked_wizard", () => {
  assert.match(sellerPage, /sub\[0\] === "products"/);
  assert.match(sellerPage, /data-testid="dash-product-library"/, "Product Library is reachable from the seller command center");
  assert.match(sellerPage, /productId=\{query\?\.get\("product"\) \|\| null\}/, "create-a-Deal-from-a-Product enters the canonical wizard");
  assert.match(sellerPage, /product_id: String\(product\.product_id\)/);
  assert.match(sellerPage, /data-testid="wizard-product-summary"/);
  assert.match(sellerPage, /data-testid="deal-promote-product"/, "a Draft can be saved as a Product");
  assert.match(sellerPage, /data-testid="draft-product-locked"/);
  assert.match(sellerPage, /deal\.product_id \? \{\} : \{ title: title\.trim\(\)/, "Draft editor never sends snapshot-owned fields for a Product-backed Draft");
  assert.match(sellerPage, /DeliveryEstimateInputs/);
  assert.match(sellerPage, /\.\.\.deliveryEstimatePayload\(d\)/);
  assert.match(sellerPage, /\.\.\.deliveryEstimatePayload\(r\)/);
  assert.match(productsPage, /data-testid="product-library"/);
  assert.match(productsPage, /data-testid="product-create-deal"/);
  assert.match(productsPage, /שחזור ויצירת עסקה/, "archived Product creation requires an explicit restore-and-continue action");
  assert.match(productsPage, /עדיין לא נוצרו עסקאות מהמוצר הזה/, "Product with zero Deals has a useful action");
  assert.match(productsPage, /עסקאות קיימות שפורסמו לא השתנו/, "Product edit success explains immutable published Deals");
  assert.match(productsPage, /העסקה פורסמה על בסיס גרסה/, "revision drift is explained as informational history");
  assert.match(productsPage, /lockType/, "product type is locked after creation");
  assert.doesNotMatch(productsPage, /<table/i, "Product Library does not depend on a desktop-only table");
  assert.match(styles, /\.product-library-controls \.row, \.product-library-card \.row, \.product-detail-header, \.product-history-row \{ flex-direction: column/, "mobile Product Library is a one-column contract");
  assert.match(dealPage, /data-testid="delivery-estimate"/, "buyers see the fulfillment estimate on the delivery option");
  assert.match(apiClient, /sellerProducts:|createProduct:|updateProduct:|promoteDealToProduct:/);
});

await runTest("enrichment_is_a_seam_only", () => {
  assert.deepEqual(productEnrichmentReadiness(), {
    enabled: false, status: "provider_pending", authority: "suggestions_only",
    note: "A future provider may suggest copy or variation axes; seller approval remains mandatory and Deal snapshots remain immutable."
  });
  assert.doesNotMatch(app + runtime, /product_enrichment/, "no runtime route calls an enrichment provider");
});

console.log("PRODUCT_CATALOG_VALIDATION_PASS");
