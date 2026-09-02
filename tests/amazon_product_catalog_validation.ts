import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { buildProductSnapshot, validateProductAttributes } from "../src/product_catalog.js";
import { productEnrichmentReadiness } from "../src/product_enrichment.js";

const [migration, funnelMigration, app, runtime, frontend, analytics, rls, base44Entity, base44Function] = await Promise.all([
  readFile("src/migrations/062_product_catalog_and_fulfillment_estimates.sql", "utf8"),
  readFile("src/migrations/051_commerce_viral_graph.sql", "utf8"),
  readFile("src/app.ts", "utf8"),
  readFile("src/frontend_runtime.ts", "utf8"),
  readFile("frontend/app.js", "utf8"),
  readFile("src/seller_analytics.ts", "utf8"),
  readFile("supabase/staging/062_amazon_product_catalog.sql", "utf8"),
  readFile("base44/entities/product.jsonc", "utf8"),
  readFile("base44/functions/siton-seller-product/index.ts", "utf8")
]);

const migrationNames = await readdir("src/migrations");
assert.equal(migrationNames.some((name) => /^(060|061)_.*product_catalog/.test(name)), false, "Amazon catalog does not occupy Claude's 060/061 reservations");
assert.ok(migrationNames.includes("062_product_catalog_and_fulfillment_estimates.sql"));
assert.match(migration, /CREATE TABLE IF NOT EXISTS siton\.products/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS siton\.product_images/);
assert.match(migration, /product_snapshot_jsonb JSONB/);
assert.match(migration, /prevent_published_deal_product_snapshot_change/);
assert.match(migration, /estimated_min_business_days/);
assert.match(migration, /deal_service_terms/);
assert.match(migration, /OLD\.state <> 'Draft' OR NEW\.state <> 'Draft'/, "snapshot cannot change during or after publication");

assert.match(app, /WHERE product_id=\$1 AND seller_id=\$2/);
assert.match(app, /buildProductSnapshot/);
assert.match(app, /deal_product_readiness_failed/);
assert.match(app, /if \(!productId && !title\)/, "Product-backed creation does not trust or require browser-owned Product copy");
assert.match(runtime, /api\/seller\/products/);
assert.match(runtime, /product_snapshot/);
assert.match(frontend, /ספריית המוצרים שלי/);
assert.match(frontend, /sellerProductMode/);
assert.match(frontend, /sellerServiceLocationMode/);
assert.match(frontend, /deliveryEstimateText/);

for (const event of ["deal_view", "share_button_click", "join_started", "otp_started", "otp_completed", "payment_screen_reached", "authorization_attempt", "authorization_success", "joined", "completed_purchase"]) {
  assert.ok(migration.includes(event), `migration permits ${event}`);
  assert.ok(frontend.includes(event), `canonical frontend recognizes ${event}`);
}

assert.match(rls, /siton_web_runtime/);
assert.doesNotMatch(rls, /GRANT\s+SELECT[^;]+\b(?:anon|authenticated)\b/i);
assert.match(base44Entity, /"name": "Product"/);
assert.match(base44Entity, /"service"/);
assert.match(base44Function, /sellerAuthority/);
assert.match(base44Function, /asServiceRole/);

const service = validateProductAttributes("service", {
  service_location_mode: "online",
  redemption_instructions: "Book through the seller portal",
  variation_axes: [{ name: "duration", values: ["30m", "60m"] }]
});
assert.deepEqual(service.variation_axes, [{ name: "duration", values: ["30m", "60m"] }]);
assert.throws(() => validateProductAttributes("service", { service_location_mode: "onsite", redemption_instructions: "Book" }), /service_location is required/);

const product = {
  product_id: "11111111-1111-4111-8111-111111111111",
  revision: 2,
  name: "Consultation",
  short_description: "A focused session",
  long_description: "A focused seller consultation.",
  product_type: "service",
  category: "professional",
  type_attributes: service,
  fulfillment_defaults: { estimated_min_business_days: 0, estimated_max_business_days: 1 }
};
const images = [{
  product_image_id: "22222222-2222-4222-8222-222222222222", storage_provider: "s3", storage_key: "p/image.webp",
  public_url: null, original_filename: "image.webp", mime_type: "image/webp", size_bytes: 1200,
  checksum_sha256: "a".repeat(64), sort_order: 0, is_primary: true
}];
const first = buildProductSnapshot(product, images);
const replay = buildProductSnapshot(product, images);
assert.equal(first.content_hash, replay.content_hash, "same Product revision has a deterministic snapshot hash");
const editedProduct = { ...product, revision: 3, name: "Consultation Plus" };
const nextDealSnapshot = buildProductSnapshot(editedProduct, images);
assert.notEqual(first.content_hash, nextDealSnapshot.content_hash, "edited Product produces a new immutable Deal snapshot");
assert.equal(first.name, "Consultation", "the earlier Deal snapshot retains version A");
assert.equal(nextDealSnapshot.name, "Consultation Plus", "a later Deal can use version B");
assert.equal(first.product_id, nextDealSnapshot.product_id, "multiple Deals reuse one Product identity");

assert.match(runtime, /legacy:\s*true/, "legacy Deals retain a Product-shaped read fallback without a Product row");
assert.match(frontend, /SELLER_CREATE_RESUME_KEY/, "Product-aware creation reuses the canonical resume rail");
assert.match(frontend, /sellerProductId/, "Product association is persisted in canonical form state");
assert.match(frontend, /renderCtonDealPageView\(buildSellerPreviewPayload\(\), \{ preview: true \}\)/, "Buyer Preview reuses the canonical public renderer");
assert.match(frontend, /כל פעולות Join, Authorization ופרסום כבויות/, "Preview explicitly disables state-changing buyer actions");
assert.match(app, /Product-backed fields are owned by the Product snapshot/, "Draft edits cannot mutate Product-owned snapshot copy");
assert.match(funnelMigration, /UNIQUE \(deal_id, event_type, client_event_id\)/, "funnel retries are database-idempotent");
assert.match(frontend, /sessionStorage\.getItem\(dedupeKey\)/, "browser reloads in a session do not inflate funnel stages");
for (const field of ["otp_starts", "otp_completions", "payment_screen_reached", "authorization_attempts", "authorization_successes", "joins", "completed_purchases"]) {
  assert.ok(analytics.includes(field), `seller analytics exposes canonical ${field}`);
}
assert.match(analytics, /joins:\s*joinsInWindow/, "JOINED is derived from canonical participant rows");
assert.match(analytics, /completed_purchases:\s*moneyTotals\.eligible_buyers/, "COMPLETED_PURCHASE is derived from canonical money truth");

assert.deepEqual(productEnrichmentReadiness(), {
  enabled: false,
  status: "provider_pending",
  authority: "suggestions_only",
  note: "A future provider may suggest copy or variation axes; seller approval remains mandatory and Deal snapshots remain immutable."
});

console.log("AMAZON_PRODUCT_CATALOG_VALIDATION_PASS");
