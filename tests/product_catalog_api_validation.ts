// Product catalog (migration 071) — API + database proof.
//
// Drives the real Fastify app (demo-preview seller authority) against the
// isolated test database: Product writers, Deal-from-Product creation with a
// frozen snapshot, draft locking, publish readiness, DB-level snapshot
// immutability after publication, seller isolation, archive semantics, Draft →
// Product promotion, shared-blob image deletion and estimate validation.
// No provider call, no real money.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3461");
process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "10000";
process.env.RATE_LIMIT_READ_MAX = process.env.RATE_LIMIT_READ_MAX || "5000";
process.env.RATE_LIMIT_SENSITIVE_MAX = process.env.RATE_LIMIT_SENSITIVE_MAX || "1000";

const { app } = await import("../src/app.js");
const { ensureSellerReady, sellerHeaders, BOOKSTORE_PICKUP, BOOKSTORE_DELIVERY, createDeal } = await import("./helpers/physical_fulfillment_fixture.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const tag = randomUUID().slice(0, 6);
const SELLER_A = `catalog-a-${tag}`;
const SELLER_B = `catalog-b-${tag}`;
const HA = sellerHeaders(SELLER_A);
const HB = sellerHeaders(SELLER_B);
// DELETE carries no body: no content-type, or Fastify refuses the empty JSON body
const DA = { "x-seller-id": SELLER_A };
const deadline = () => new Date(Date.now() + 3 * 864e5).toISOString();

async function insertDealImage(dealId: string, key = `deal-images/${dealId}/one.png`) {
  const r = await pool.query(
    `INSERT INTO siton.deal_images
       (deal_id, storage_provider, storage_key, public_url, original_filename, mime_type, size_bytes, sort_order, is_primary)
     VALUES ($1,'local',$2,$3,'one.png','image/png',128,0,true) RETURNING image_id`,
    [dealId, key, `/uploads/${key}`]
  );
  return String(r.rows[0].image_id);
}

await ensureSellerReady(app, SELLER_A, "ספריית מוצרים א");
await ensureSellerReady(app, SELLER_B, "ספריית מוצרים ב");

let productId = "";
let dealId = "";

await run("product_create_validates_and_returns_revision_1", async () => {
  const bad = await app.inject({ method: "POST", url: "/api/seller/products", headers: HA, payload: { name: "x", product_type: "service" } });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, "product_type_invalid");
  const badVoucher = await app.inject({ method: "POST", url: "/api/seller/products", headers: HA, payload: { name: "שובר", product_type: "voucher", type_attributes: { redemption_instructions: "x" } } });
  assert.equal(badVoucher.statusCode, 400, badVoucher.body);
  assert.equal(badVoucher.json().code, "voucher_location_required");
  const badEstimate = await app.inject({ method: "POST", url: "/api/seller/products", headers: HA, payload: { name: "x", product_type: "physical_product", fulfillment_defaults: { estimated_min_business_days: 6, estimated_max_business_days: 2 } } });
  assert.equal(badEstimate.statusCode, 400, badEstimate.body);
  assert.equal(badEstimate.json().code, "fulfillment_estimate_range_invalid");
  const anon = await app.inject({ method: "POST", url: "/api/seller/products", payload: { name: "x" } });
  // demo-preview seller authority answers 400 (no seller identity); hosted answers 401/403 — never a 201
  assert.ok([400, 401, 403].includes(anon.statusCode), `anonymous create must be refused: ${anon.statusCode}`);
  assert.equal(anon.json().ok, false);

  const ok = await app.inject({
    method: "POST", url: "/api/seller/products", headers: HA,
    payload: {
      name: "  מצלמה קומפקטית  ", short_description: "קטנה וחדה", long_description: "תיאור מלא", category: "אלקטרוניקה",
      product_type: "physical_product", type_attributes: { color: "שחור", weight_grams: "320" },
      fulfillment_defaults: { estimated_min_business_days: 2, estimated_max_business_days: 5 }
    }
  });
  assert.equal(ok.statusCode, 201, ok.body);
  const product = ok.json().product;
  productId = String(product.product_id);
  assert.equal(product.name, "מצלמה קומפקטית");
  assert.equal(Number(product.revision), 1);
  assert.equal(product.status, "active");
  assert.equal(product.type_attributes.weight_grams, 320);
  assert.equal(product.fulfillment_defaults.estimate_anchor, "deal_completed");
});

await run("product_reads_are_seller_scoped", async () => {
  const listA = await app.inject({ method: "GET", url: "/api/seller/products?status=all", headers: HA });
  assert.equal(listA.statusCode, 200, listA.body);
  assert.ok(listA.json().products.some((p: any) => p.product_id === productId));
  const search = await app.inject({ method: "GET", url: "/api/seller/products?q=%D7%90%D7%9C%D7%A7%D7%98%D7%A8%D7%95%D7%A0%D7%99%D7%A7%D7%94", headers: HA });
  assert.equal(search.statusCode, 200, search.body);
  assert.ok(search.json().products.some((p: any) => p.product_id === productId), "category search");
  const listB = await app.inject({ method: "GET", url: "/api/seller/products?status=all", headers: HB });
  assert.equal(listB.statusCode, 200, listB.body);
  assert.equal(listB.json().products.some((p: any) => p.product_id === productId), false, "Seller B never sees Seller A's Product");
  const detailB = await app.inject({ method: "GET", url: `/api/seller/products/${productId}`, headers: HB });
  assert.equal(detailB.statusCode, 404, detailB.body);
  const patchB = await app.inject({ method: "PATCH", url: `/api/seller/products/${productId}`, headers: HB, payload: { name: "hijack" } });
  assert.equal(patchB.statusCode, 404, patchB.body);
  const badStatus = await app.inject({ method: "GET", url: "/api/seller/products?status=deleted", headers: HA });
  assert.equal(badStatus.statusCode, 400, badStatus.body);
});

await run("deal_from_product_freezes_snapshot_and_inherits_estimates", async () => {
  const foreign = await app.inject({
    method: "POST", url: "/deals", headers: { ...HB, "idempotency-key": `pc-b-${tag}` },
    payload: { product_id: productId, price_per_unit: 100, min_units: 2, max_units: 20, deadline: deadline(), delivery_options: [BOOKSTORE_PICKUP] }
  });
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal(foreign.json().code, "product_not_found");

  const mismatch = await app.inject({
    method: "POST", url: "/deals", headers: { ...HA, "idempotency-key": `pc-mm-${tag}` },
    payload: { product_id: productId, deal_type: "voucher", price_per_unit: 100, min_units: 2, max_units: 20, deadline: deadline() }
  });
  assert.equal(mismatch.statusCode, 409, mismatch.body);
  assert.equal(mismatch.json().code, "product_type_mismatch");

  const fixedDeadline = deadline();
  const created = await app.inject({
    method: "POST", url: "/deals", headers: { ...HA, "idempotency-key": `pc-a-${tag}` },
    payload: {
      product_id: productId, price_per_unit: 149, min_units: 3, max_units: 30, deadline: fixedDeadline,
      // no title, no copy: the snapshot owns them
      delivery_options: [BOOKSTORE_PICKUP, { ...BOOKSTORE_DELIVERY, estimated_min_business_days: 1, estimated_max_business_days: 3 }]
    }
  });
  assert.ok([200, 201].includes(created.statusCode), created.body);
  dealId = String(created.json().deal_id || created.json().deal?.deal_id);
  const row = await pool.query(`SELECT title, description, description_short, deal_type, product_id, product_snapshot_jsonb FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(row.rows[0].title, "מצלמה קומפקטית");
  assert.equal(row.rows[0].description_short, "קטנה וחדה");
  assert.equal(row.rows[0].product_id, productId);
  assert.equal(Number(row.rows[0].product_snapshot_jsonb.product_revision), 1);
  assert.match(String(row.rows[0].product_snapshot_jsonb.content_hash), /^[a-f0-9]{64}$/);
  const options = await pool.query(`SELECT option_type, estimated_min_business_days, estimated_max_business_days FROM siton.deal_delivery_options WHERE deal_id=$1 ORDER BY sort_order`, [dealId]);
  assert.deepEqual(options.rows.map((o: any) => [o.option_type, o.estimated_min_business_days, o.estimated_max_business_days]), [["pickup", 2, 5], ["delivery", 1, 3]], "explicit estimate wins, Product default fills the gap");

  const replay = await app.inject({
    method: "POST", url: "/deals", headers: { ...HA, "idempotency-key": `pc-a-${tag}` },
    payload: {
      product_id: productId, price_per_unit: 149, min_units: 3, max_units: 30, deadline: fixedDeadline,
      delivery_options: [BOOKSTORE_PICKUP, { ...BOOKSTORE_DELIVERY, estimated_min_business_days: 1, estimated_max_business_days: 3 }]
    }
  });
  assert.ok([200, 201].includes(replay.statusCode), replay.body);
  assert.equal(String(replay.json().deal_id || replay.json().deal?.deal_id), dealId, "same key + same payload replays the same Draft");
});

await run("draft_editor_cannot_diverge_from_the_snapshot", async () => {
  const locked = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: HA, payload: { title: "שם אחר" } });
  assert.equal(locked.statusCode, 409, locked.body);
  assert.equal(locked.json().code, "product_snapshot_fields_locked");
  const price = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: HA, payload: { price_per_unit: 159 } });
  assert.equal(price.statusCode, 200, price.body);
  const draft = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/draft`, headers: HA });
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json().draft.product_id, productId);
  assert.equal(draft.json().draft.product_snapshot.name, "מצלמה קומפקטית");
  assert.equal(draft.json().draft.delivery_options[0].estimate_text, "2–5 ימי עסקים מהשלמת העסקה");
  const badEstimate = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: HA, payload: { delivery_options: [{ ...BOOKSTORE_PICKUP, estimated_min_business_days: 9, estimated_max_business_days: 2 }] } });
  assert.equal(badEstimate.statusCode, 400, badEstimate.body);
  assert.equal(badEstimate.json().code, "delivery_estimate_range_invalid");
});

await run("publish_readiness_then_db_level_snapshot_immutability", async () => {
  const publishPayload = { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true };
  const blocked = await app.inject({ method: "POST", url: `/deals/${dealId}/publish`, headers: { ...HA, "idempotency-key": `pc-pub-${tag}-1` }, payload: publishPayload });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "deal_product_readiness_failed");
  assert.equal(blocked.json().reason_code, "deal_image_missing");

  await insertDealImage(dealId);
  const missingEstimate = await app.inject({ method: "PUT", url: `/api/seller/deals/${dealId}/delivery`, headers: HA, payload: { delivery_options: [BOOKSTORE_PICKUP] } });
  assert.equal(missingEstimate.statusCode, 200, missingEstimate.body);
  const blocked2 = await app.inject({ method: "POST", url: `/deals/${dealId}/publish`, headers: { ...HA, "idempotency-key": `pc-pub-${tag}-2` }, payload: publishPayload });
  assert.equal(blocked2.statusCode, 409, blocked2.body);
  assert.equal(blocked2.json().reason_code, "delivery_estimate_missing");

  const restored = await app.inject({ method: "PUT", url: `/api/seller/deals/${dealId}/delivery`, headers: HA, payload: { delivery_options: [{ ...BOOKSTORE_PICKUP, estimated_min_business_days: 2, estimated_max_business_days: 4 }] } });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().delivery_options[0].estimated_max_business_days, 4);
  const published = await app.inject({ method: "POST", url: `/deals/${dealId}/publish`, headers: { ...HA, "idempotency-key": `pc-pub-${tag}-3` }, payload: publishPayload });
  assert.equal(published.statusCode, 200, published.body);

  await assert.rejects(
    pool.query(`UPDATE siton.deals SET product_snapshot_jsonb = product_snapshot_jsonb || '{"name":"tampered"}'::jsonb WHERE deal_id=$1`, [dealId]),
    /immutable/,
    "a published Deal's snapshot is frozen by the database"
  );
  await assert.rejects(pool.query(`UPDATE siton.deals SET product_id = NULL WHERE deal_id=$1`, [dealId]), /immutable/);
});

await run("product_edit_creates_revision_2_and_history_marks_the_deal_historical", async () => {
  const edit = await app.inject({ method: "PATCH", url: `/api/seller/products/${productId}`, headers: HA, payload: { name: "מצלמה קומפקטית פלוס", fulfillment_defaults: { estimated_min_business_days: 1, estimated_max_business_days: 2 } } });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.equal(Number(edit.json().product.revision), 2);
  const typeChange = await app.inject({ method: "PATCH", url: `/api/seller/products/${productId}`, headers: HA, payload: { product_type: "voucher" } });
  assert.equal(typeChange.statusCode, 409, typeChange.body);
  assert.equal(typeChange.json().code, "product_type_locked");

  const detail = await app.inject({ method: "GET", url: `/api/seller/products/${productId}`, headers: HA });
  assert.equal(detail.statusCode, 200, detail.body);
  const history = detail.json().product.deals.find((d: any) => d.deal_id === dealId);
  assert.equal(history.product_snapshot_revision, 1);
  assert.equal(history.current_product_revision, 2);
  assert.equal(history.snapshot_status, "historical");
  assert.equal(history.uses_historical_product_version, true);

  const pub = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(pub.statusCode, 200, pub.body);
  const deal = pub.json().deal;
  assert.equal(deal.title, "מצלמה קומפקטית", "the published Deal keeps version A");
  assert.equal(deal.product.name, "מצלמה קומפקטית");
  assert.equal(deal.product.revision, 1);
  assert.equal(deal.product_id, productId);
  assert.equal(Object.prototype.hasOwnProperty.call(deal.product, "images"), false, "no storage internals on the public projection");
  assert.equal(deal.delivery_options[0].estimate_text, "2–4 ימי עסקים מהשלמת העסקה");

  const list = await app.inject({ method: "GET", url: "/api/seller/deals", headers: HA });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().seller_surface.deals.find((d: any) => d.deal_id === dealId)?.product_id, productId);
  const seller = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}`, headers: HA });
  assert.equal(seller.statusCode, 200, seller.body);
  assert.equal(seller.json().deal.product_snapshot.product_revision, 1);
});

await run("archived_product_cannot_silently_start_a_deal", async () => {
  const archive = await app.inject({ method: "PATCH", url: `/api/seller/products/${productId}`, headers: HA, payload: { status: "archived" } });
  assert.equal(archive.statusCode, 200, archive.body);
  const refused = await app.inject({
    method: "POST", url: "/deals", headers: { ...HA, "idempotency-key": `pc-arch-${tag}` },
    payload: { product_id: productId, price_per_unit: 100, min_units: 2, max_units: 20, deadline: deadline(), delivery_options: [BOOKSTORE_PICKUP] }
  });
  assert.equal(refused.statusCode, 404, refused.body);
  assert.equal(refused.json().code, "product_not_found");
  const active = await app.inject({ method: "GET", url: "/api/seller/products", headers: HA });
  assert.equal(active.json().products.some((p: any) => p.product_id === productId), false, "default list hides archived Products");
  const badStatus = await app.inject({ method: "PATCH", url: `/api/seller/products/${productId}`, headers: HA, payload: { status: "deleted" } });
  assert.equal(badStatus.statusCode, 400, badStatus.body);
  const restore = await app.inject({ method: "PATCH", url: `/api/seller/products/${productId}`, headers: HA, payload: { status: "active" } });
  assert.equal(restore.statusCode, 200, restore.body);
  const again = await app.inject({
    method: "POST", url: "/deals", headers: { ...HA, "idempotency-key": `pc-arch2-${tag}` },
    payload: { product_id: productId, price_per_unit: 100, min_units: 2, max_units: 20, deadline: deadline(), delivery_options: [BOOKSTORE_PICKUP] }
  });
  assert.ok([200, 201].includes(again.statusCode), again.body);
  const snap = await pool.query(`SELECT product_snapshot_jsonb->>'name' AS name, product_snapshot_jsonb->>'product_revision' AS rev FROM siton.deals WHERE deal_id=$1`, [String(again.json().deal_id || again.json().deal?.deal_id)]);
  assert.equal(snap.rows[0].name, "מצלמה קומפקטית פלוס", "a new Deal freezes the CURRENT revision");
  assert.equal(Number(snap.rows[0].rev), 4, "archive + restore each bumped the revision");
});

await run("draft_promotion_copies_images_and_shared_blobs_are_never_deleted", async () => {
  const plainDeal = await createDeal(app, SELLER_A, { title: "מארז זיתים" });
  const imageId = await insertDealImage(plainDeal, `deal-images/${plainDeal}/olives.png`);
  const foreign = await app.inject({ method: "POST", url: `/api/seller/deals/${plainDeal}/product`, headers: HB, payload: {} });
  assert.equal(foreign.statusCode, 404, foreign.body);
  const promoted = await app.inject({ method: "POST", url: `/api/seller/deals/${plainDeal}/product`, headers: HA, payload: { category: "מזון" } });
  assert.equal(promoted.statusCode, 201, promoted.body);
  const promotedProduct = promoted.json().product;
  assert.equal(promotedProduct.name, "מארז זיתים");
  assert.equal(promotedProduct.short_description, "ספר בכריכה קשה");
  assert.equal(promoted.json().snapshot.images.length, 1, "Draft imagery became Product imagery");
  const twice = await app.inject({ method: "POST", url: `/api/seller/deals/${plainDeal}/product`, headers: HA, payload: {} });
  assert.equal(twice.statusCode, 409, twice.body);
  assert.equal(twice.json().code, "deal_product_already_attached");

  const detail = await app.inject({ method: "GET", url: `/api/seller/products/${promotedProduct.product_id}`, headers: HA });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().product.images.length, 1);
  assert.match(detail.json().product.images[0].url, /^\/uploads\//);
  assert.equal(detail.json().product.deals[0].snapshot_status, "current");

  // The Draft's image row shares its blob with the Product image: deleting the
  // Deal image must remove the metadata only and report retained_shared.
  const del = await app.inject({ method: "DELETE", url: `/api/seller/deals/${plainDeal}/images/${imageId}`, headers: DA });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(del.json().deletion, "retained_shared");
  const cleanup = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.storage_cleanup_tasks WHERE storage_key=$1`, [`deal-images/${plainDeal}/olives.png`]);
  assert.equal(cleanup.rows[0].n, 0, "no cleanup task for a blob a Product still references");
  const stillProduct = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.product_images WHERE product_id=$1`, [promotedProduct.product_id]);
  assert.equal(stillProduct.rows[0].n, 1);

  // Deleting the Draft itself never schedules the shared blob either.
  const dealDelete = await app.inject({ method: "DELETE", url: `/api/seller/deals/${plainDeal}`, headers: DA });
  assert.equal(dealDelete.statusCode, 200, dealDelete.body);
  const cleanupAfter = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.storage_cleanup_tasks WHERE storage_key LIKE $1`, [`deal-images/${plainDeal}/%`]);
  assert.equal(cleanupAfter.rows[0].n, 0);
  const productSurvives = await pool.query(`SELECT status FROM siton.products WHERE product_id=$1`, [promotedProduct.product_id]);
  assert.equal(productSurvives.rows[0].status, "active", "the Product outlives the Draft it came from");
});

await run("delivery_estimate_validation_on_create", async () => {
  const bad = await app.inject({
    method: "POST", url: "/deals", headers: { ...HA, "idempotency-key": `pc-est-${tag}` },
    payload: { title: "בדיקה", description_short: "x", price_per_unit: 10, min_units: 2, max_units: 5, deadline: deadline(), delivery_options: [{ ...BOOKSTORE_PICKUP, estimated_min_business_days: 5, estimated_max_business_days: 2 }] }
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, "delivery_estimate_range_invalid");
  const legacy = await app.inject({
    method: "POST", url: "/deals", headers: { ...HA, "idempotency-key": `pc-legacy-${tag}` },
    payload: { title: "ללא מוצר", description_short: "x", price_per_unit: 10, min_units: 2, max_units: 5, deadline: deadline(), delivery_options: [BOOKSTORE_PICKUP] }
  });
  assert.ok([200, 201].includes(legacy.statusCode), legacy.body);
  const legacyId = String(legacy.json().deal_id || legacy.json().deal?.deal_id);
  const row = await pool.query(`SELECT product_id, product_snapshot_jsonb FROM siton.deals WHERE deal_id=$1`, [legacyId]);
  assert.equal(row.rows[0].product_id, null, "legacy Deals stay product-free");
  assert.equal(row.rows[0].product_snapshot_jsonb, null);
  const rename = await app.inject({ method: "PATCH", url: `/api/seller/deals/${legacyId}/draft`, headers: HA, payload: { title: "שם חדש" } });
  assert.equal(rename.statusCode, 200, rename.body);
});

await pool.end();
await app.close();
console.log(`PRODUCT_CATALOG_API_VALIDATION passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
