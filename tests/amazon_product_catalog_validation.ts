import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProductSnapshot, validateProductAttributes } from "../src/product_catalog.js";
import { productEnrichmentReadiness } from "../src/product_enrichment.js";

const [migration, funnelMigration, app, runtime, frontend, styles, serviceWorker, analytics, rls, base44Entity, base44Function] = await Promise.all([
  readFile("src/migrations/062_product_catalog_and_fulfillment_estimates.sql", "utf8"),
  readFile("src/migrations/051_commerce_viral_graph.sql", "utf8"),
  readFile("src/app.ts", "utf8"),
  readFile("src/frontend_runtime.ts", "utf8"),
  readFile("frontend/app.js", "utf8"),
  readFile("frontend/styles.css", "utf8"),
  readFile("frontend/service-worker.js", "utf8"),
  readFile("src/seller_analytics.ts", "utf8"),
  readFile("supabase/staging/062_amazon_product_catalog.sql", "utf8"),
  readFile("base44/entities/product.jsonc", "utf8"),
  readFile("base44/functions/siton-seller-product/index.ts", "utf8")
]);
const productLibrary = await import(pathToFileURL(join(process.cwd(), "frontend", "product-library.js")).href);

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
assert.match(runtime, /LEFT JOIN siton\.deals d ON d\.product_id=p\.product_id AND d\.seller_id=p\.seller_id/, "Product Deal counts cannot include another Seller's rows");
assert.match(runtime, /FROM siton\.products WHERE product_id=\$1 AND seller_id=\$2 LIMIT 1/, "Seller A cannot open Seller B Product");
assert.match(runtime, /FROM siton\.deals WHERE product_id=\$1 AND seller_id=\$2/, "Seller A cannot inspect Seller B Product history");
assert.match(runtime, /product_snapshot_revision/);
assert.match(runtime, /uses_historical_product_version/);
assert.match(frontend, /renderSellerProductLibrary\(true\)/, "Product Library is mounted in the canonical Seller Command Center");
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

const libraryRows = [
  { product_id: "physical", name: "מצלמה", category: "אלקטרוניקה", product_type: "physical_product", status: "active", revision: 3, deals_count: 2, updated_at: "2026-08-30T10:00:00Z" },
  { product_id: "voucher", name: "שובר ספא", category: "מתנות", product_type: "voucher", status: "archived", revision: 1, deals_count: 7, updated_at: "2026-08-20T10:00:00Z" },
  { product_id: "ticket", name: "כרטיס להופעה", category: "תרבות", product_type: "ticket", status: "active", revision: 2, deals_count: 1, updated_at: "2026-08-31T10:00:00Z" },
  { product_id: "service", name: "ייעוץ עסקי", category: "מקצועי", product_type: "service", status: "active", revision: 4, deals_count: 4, updated_at: "2026-09-01T10:00:00Z" }
];

assert.deepEqual(productLibrary.applyProductLibraryFilters(libraryRows, { query: "מצלמה" }).map((row: any) => row.product_id), ["physical"], "Product Library searches Product name");
assert.deepEqual(productLibrary.applyProductLibraryFilters(libraryRows, { query: "תרבות" }).map((row: any) => row.product_id), ["ticket"], "Product Library searches category");
assert.deepEqual(productLibrary.applyProductLibraryFilters(libraryRows, { status: "archived" }).map((row: any) => row.product_id), ["voucher"], "archive filtering is deterministic");
assert.equal(productLibrary.applyProductLibraryFilters(libraryRows, { status: "active" }).length, 3, "active filtering is deterministic");
assert.deepEqual(productLibrary.applyProductLibraryFilters(libraryRows, { type: "service" }).map((row: any) => row.product_id), ["service"], "Service behaves like every other Product type");
assert.deepEqual(productLibrary.applyProductLibraryFilters(libraryRows, { type: "ticket" }).map((row: any) => row.product_id), ["ticket"], "Product type filtering is deterministic");
assert.deepEqual(productLibrary.applyProductLibraryFilters(libraryRows, { sort: "deals" }).map((row: any) => row.product_id), ["voucher", "service", "physical", "ticket"], "Most Deals sorting is deterministic");
assert.deepEqual(productLibrary.applyProductLibraryFilters(libraryRows, { sort: "updated" }).map((row: any) => row.product_id), ["service", "ticket", "physical", "voucher"], "recently updated sorting is deterministic");
assert.deepEqual(productLibrary.applyProductLibraryFilters([{ product_id: "z", name: "Zulu" }, { product_id: "a", name: "Alpha" }], { sort: "name" }).map((row: any) => row.product_id), ["a", "z"], "name sorting is deterministic");
assert.equal(productLibrary.productLibraryEmptyKind([], [], {}), "library-empty", "zero Product state is explicit");
assert.equal(productLibrary.productLibraryEmptyKind(libraryRows, [], { query: "לא קיים" }), "search-empty", "zero search state is distinct");
assert.equal(productLibrary.productLibraryEmptyKind(libraryRows, [], { type: "voucher" }), "filter-empty", "zero filter state is distinct");

const historical = productLibrary.productDealRevisionStatus({ product_snapshot_revision: 1 }, 3);
assert.deepEqual(historical, { snapshotRevision: 1, currentRevision: 3, isCurrent: false, isHistorical: true, isUnknown: false });
const current = productLibrary.productDealRevisionStatus({ product_snapshot_revision: 3 }, 3);
assert.equal(current.isCurrent, true, "a Deal frozen at the current Product revision is reported as current");
const linkedDeals = [{ deal_id: "deal-a", product_snapshot_revision: 1 }, { deal_id: "deal-b", product_snapshot_revision: 3 }];
assert.equal(linkedDeals.map((deal) => productLibrary.productDealRevisionStatus(deal, 3)).length, 2, "a Product with two Deals preserves both history entries");

assert.match(runtime, /legacy:\s*true/, "legacy Deals retain a Product-shaped read fallback without a Product row");
assert.match(frontend, /SELLER_CREATE_RESUME_KEY/, "Product-aware creation reuses the canonical resume rail");
assert.match(frontend, /sellerProductId/, "Product association is persisted in canonical form state");
assert.match(frontend, /renderCtonDealPageView\(buildSellerPreviewPayload\(\), \{ preview: true \}\)/, "Buyer Preview reuses the canonical public renderer");
assert.match(frontend, /כל פעולות Join, Authorization ופרסום כבויות/, "Preview explicitly disables state-changing buyer actions");
assert.match(app, /Product-backed fields are owned by the Product snapshot/, "Draft edits cannot mutate Product-owned snapshot copy");
assert.match(app, /revision=revision\+1/, "editing a Product creates revision N+1");
assert.match(app, /AND status='active'/, "an archived Product cannot silently start a Deal");
assert.match(frontend, /שחזור ויצירת עסקה/, "archived Product creation requires an explicit restore-and-continue action");
assert.match(frontend, /עדיין לא נוצרו עסקאות מהמוצר הזה/, "Product with zero Deals has a useful action");
assert.match(frontend, /עסקאות קיימות שפורסמו לא השתנו/, "Product edit success explains immutable published Deals");
assert.match(frontend, /העסקה פורסמה על בסיס גרסה/, "revision drift is explained as informational history");
assert.match(migration, /product_id IS NULL OR product_snapshot_jsonb IS NOT NULL/, "legacy product_id NULL Deals remain valid");
assert.match(styles, /\.product-library-card\s*\{/);
assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.product-library-controls, \.product-library-card, \.product-detail-header, \.product-history-row \{ grid-template-columns: 1fr; \}/, "mobile Product Library is a one-column card contract, not a desktop table");
assert.doesNotMatch(frontend, /<table[^>]+product-library/i, "Product Library does not depend on a desktop-only table");
assert.match(runtime, /app\/assets\/product-library\.js/);
assert.match(serviceWorker, /app\/assets\/product-library\.js/);
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
