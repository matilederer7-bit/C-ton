// Delivery estimates — the optional business-day range a seller may claim on a
// physical delivery option (migration 072 columns on siton.deal_delivery_options),
// counted from Deal completion.
//
// This coverage used to live inside the Product Library suites
// (tests/product_catalog_*.ts). The Product Library was removed; the delivery
// estimate feature stays, so its behaviour is pinned here:
//
//   • src/delivery_estimate.ts: normalizeDeliveryEstimate (the writers' rule)
//     and describeDeliveryEstimate (the buyer-facing wording)
//   • web/src/deliveryEstimate.ts: the client mirror (deliveryEstimateText,
//     validateEstimateRange) agrees with the server wording
//   • every delivery-option writer normalizes estimates (create, draft patch,
//     delivery PUT) and every reader projects the same wording
//   • the real app: POST /deals refuses min > max, stores a valid range, and
//     the seller draft / seller deal / seller preview payloads carry estimate_text
//   • the Product Library surface is gone (routes 404, no product keys on the
//     public payload)
// No provider call, no real money.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { describeDeliveryEstimate, normalizeDeliveryEstimate } from "../src/delivery_estimate.js";
import { deliveryEstimateText, validateEstimateRange } from "../web/src/deliveryEstimate.js";
const { Pool } = pg;

process.env.PORT = String(process.env.PORT || "3461");
process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "10000";
process.env.RATE_LIMIT_READ_MAX = process.env.RATE_LIMIT_READ_MAX || "5000";
process.env.RATE_LIMIT_SENSITIVE_MAX = process.env.RATE_LIMIT_SENSITIVE_MAX || "1000";

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

// support, seller fulfillment, admin control-center (R6), admin growth and admin demo-readiness routes moved out of frontend_runtime.ts (Lean Refactor); they stay in this scan
const [app_src, runtime_src, sellerPage, dealPage, apiClient] = await Promise.all([
  readFile("src/app.ts", "utf8"),
  Promise.all([readFile("src/frontend_runtime.ts", "utf8"), readFile("src/support_routes.ts", "utf8"), readFile("src/seller_fulfillment_routes.ts", "utf8"), readFile("src/admin_control_center_routes.ts", "utf8"), readFile("src/admin_growth_routes.ts", "utf8"), readFile("src/admin_demo_readiness_routes.ts", "utf8")]).then((parts) => parts.join("\n")),
  readFile("web/src/pages/seller.tsx", "utf8"),
  readFile("web/src/pages/deal.tsx", "utf8"),
  readFile("web/src/api.ts", "utf8")
]);

await run("describe_delivery_estimate_wording", () => {
  assert.equal(describeDeliveryEstimate({ estimated_min_business_days: 2, estimated_max_business_days: 5 }).estimate_text, "2–5 ימי עסקים מהשלמת העסקה");
  assert.equal(describeDeliveryEstimate({ estimated_min_business_days: 3, estimated_max_business_days: 3 }).estimate_text, "3 ימי עסקים מהשלמת העסקה");
  assert.equal(describeDeliveryEstimate({ estimated_min_business_days: null, estimated_max_business_days: 7 }).estimate_text, "עד 7 ימי עסקים מהשלמת העסקה");
  assert.equal(describeDeliveryEstimate({ estimated_min_business_days: 4, estimated_max_business_days: null }).estimate_text, "לפחות 4 ימי עסקים מהשלמת העסקה");
  assert.deepEqual(describeDeliveryEstimate({}), { estimated_min_business_days: null, estimated_max_business_days: null, estimate_text: null });
});

await run("normalize_delivery_estimate_rule", () => {
  assert.deepEqual(normalizeDeliveryEstimate({}), { estimated_min_business_days: null, estimated_max_business_days: null });
  assert.deepEqual(normalizeDeliveryEstimate({ estimated_min_business_days: "", estimated_max_business_days: null }), { estimated_min_business_days: null, estimated_max_business_days: null });
  assert.deepEqual(normalizeDeliveryEstimate({ estimated_min_business_days: "2", estimated_max_business_days: 5 }), { estimated_min_business_days: 2, estimated_max_business_days: 5 });
  assert.throws(() => normalizeDeliveryEstimate({ estimated_min_business_days: 1.5 }), (e: any) => e.statusCode === 400 && e.code === "delivery_estimate_min_invalid");
  assert.throws(() => normalizeDeliveryEstimate({ estimated_max_business_days: 366 }), (e: any) => e.statusCode === 400 && e.code === "delivery_estimate_max_invalid");
  assert.throws(() => normalizeDeliveryEstimate({ estimated_min_business_days: -1 }), (e: any) => e.code === "delivery_estimate_min_invalid");
  assert.throws(() => normalizeDeliveryEstimate({ estimated_min_business_days: 5, estimated_max_business_days: 2 }), (e: any) => e.statusCode === 400 && e.code === "delivery_estimate_range_invalid");
});

await run("client_wording_and_validation_mirror_the_server", () => {
  for (const row of [
    { estimated_min_business_days: 2, estimated_max_business_days: 5 },
    { estimated_min_business_days: 3, estimated_max_business_days: 3 },
    { estimated_min_business_days: null, estimated_max_business_days: 7 },
    { estimated_min_business_days: 4, estimated_max_business_days: null }
  ]) {
    assert.equal(deliveryEstimateText(row), describeDeliveryEstimate(row).estimate_text, JSON.stringify(row));
  }
  assert.equal(deliveryEstimateText({}), null);
  assert.equal(deliveryEstimateText({ estimate_text: "מהשרת" }), "מהשרת", "server projection wins when present");
  assert.equal(validateEstimateRange("", ""), null);
  assert.equal(validateEstimateRange("2", "5"), null);
  assert.match(String(validateEstimateRange("5", "2")), /מקסימום/);
  assert.match(String(validateEstimateRange("400", "")), /365/);
  assert.match(String(validateEstimateRange("1.5", "")), /365/);
});

await run("writers_normalize_and_readers_project_estimates", () => {
  assert.match(app_src, /import \{ normalizeDeliveryEstimate \} from "\.\/delivery_estimate\.js";/);
  assert.equal((app_src.match(/\.\.\.normalizeDeliveryEstimate\(option\)/g) || []).length, 3, "create, draft patch and delivery PUT all normalize estimates");
  assert.match(runtime_src, /import \{ describeDeliveryEstimate \} from "\.\/delivery_estimate\.js";/);
  assert.equal((runtime_src.match(/\.\.\.describeDeliveryEstimate\(row\)/g) || []).length, 3, "public payload, seller draft and seller deal screen share one wording");
  assert.match(sellerPage, /from "\.\.\/deliveryEstimate"/);
  assert.match(sellerPage, /DeliveryEstimateInputs/);
  assert.match(sellerPage, /\.\.\.deliveryEstimatePayload\(d\)/);
  assert.match(sellerPage, /\.\.\.deliveryEstimatePayload\(r\)/);
  assert.match(dealPage, /data-testid="delivery-estimate"/, "buyers see the fulfillment estimate on the delivery option");
});

await run("product_library_surface_is_removed_from_source", () => {
  assert.doesNotMatch(app_src + runtime_src, /\/api\/seller\/products|\/api\/seller\/product-images|\/api\/seller\/deals\/:dealId\/product"/);
  assert.doesNotMatch(app_src + runtime_src, /product_snapshot_jsonb|product_catalog/);
  assert.doesNotMatch(apiClient, /\/api\/seller\/products|promoteDealToProduct/);
  assert.doesNotMatch(sellerPage, /#\/seller\/products|sellerProducts|productLibrary|ProductLinkPanel/);
});

const { app } = await import("../src/app.js");
const { ensureSellerReady, sellerHeaders, BOOKSTORE_PICKUP, BOOKSTORE_DELIVERY } = await import("./helpers/physical_fulfillment_fixture.js");
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });

const tag = randomUUID().slice(0, 6);
const SELLER = `estimate-${tag}`;
const H = sellerHeaders(SELLER);
const deadline = () => new Date(Date.now() + 3 * 864e5).toISOString();
await ensureSellerReady(app, SELLER, "בדיקת זמני אספקה");

let dealId = "";

await run("create_refuses_an_inverted_range", async () => {
  const bad = await app.inject({
    method: "POST", url: "/deals", headers: { ...H, "idempotency-key": `est-bad-${tag}` },
    payload: { title: "בדיקה", description_short: "x", price_per_unit: 10, min_units: 2, max_units: 5, deadline: deadline(), delivery_options: [{ ...BOOKSTORE_PICKUP, estimated_min_business_days: 5, estimated_max_business_days: 2 }] }
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, "delivery_estimate_range_invalid");
});

await run("create_stores_the_range_and_payloads_carry_the_wording", async () => {
  const created = await app.inject({
    method: "POST", url: "/deals", headers: { ...H, "idempotency-key": `est-ok-${tag}` },
    payload: {
      title: "עסקה עם זמן אספקה", description_short: "x", price_per_unit: 10, min_units: 2, max_units: 5, deadline: deadline(),
      delivery_options: [{ ...BOOKSTORE_PICKUP }, { ...BOOKSTORE_DELIVERY, estimated_min_business_days: 2, estimated_max_business_days: 5 }]
    }
  });
  assert.ok([200, 201].includes(created.statusCode), created.body);
  const body = created.json() as any;
  dealId = String(body.deal_id || body.deal?.deal_id);
  assert.ok(!("product_id" in body), "the create response carries no Product association");
  const rows = await pool.query(
    `SELECT option_type, estimated_min_business_days, estimated_max_business_days
       FROM siton.deal_delivery_options WHERE deal_id=$1 ORDER BY sort_order`,
    [dealId]
  );
  assert.deepEqual(rows.rows.map((r: any) => [r.option_type, r.estimated_min_business_days, r.estimated_max_business_days]), [["pickup", null, null], ["delivery", 2, 5]]);

  const draft = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/draft`, headers: H });
  assert.equal(draft.statusCode, 200, draft.body);
  const draftJson = draft.json() as any;
  assert.ok(!("product_id" in draftJson.draft) && !("product_snapshot" in draftJson.draft), "the draft payload carries no Product keys");
  const draftDelivery = draftJson.draft.delivery_options.find((o: any) => o.option_type === "delivery");
  assert.equal(draftDelivery.estimate_text, "2–5 ימי עסקים מהשלמת העסקה");

  const screen = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}`, headers: H });
  assert.equal(screen.statusCode, 200, screen.body);
  const screenJson = screen.json() as any;
  assert.ok(!("product_id" in screenJson.deal) && !("product_snapshot" in screenJson.deal), "the seller deal screen carries no Product keys");
  assert.equal(screenJson.delivery_options.find((o: any) => o.option_type === "delivery").estimate_text, "2–5 ימי עסקים מהשלמת העסקה");

  const preview = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/preview`, headers: H });
  assert.equal(preview.statusCode, 200, preview.body);
  const previewDeal = (preview.json() as any).deal;
  assert.ok(!("product_id" in previewDeal) && !("product" in previewDeal), "the public payload carries no Product keys");
  const previewDelivery = previewDeal.delivery_options.find((o: any) => o.option_type === "delivery");
  assert.equal(previewDelivery.estimate_text, "2–5 ימי עסקים מהשלמת העסקה");
  assert.equal(previewDeal.delivery_options.find((o: any) => o.option_type === "pickup").estimate_text, null);
});

await run("draft_patch_and_delivery_put_validate_estimates", async () => {
  const rename = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: H, payload: { title: "שם חדש", description: "תיאור חדש" } });
  assert.equal(rename.statusCode, 200, rename.body);
  const title = await pool.query(`SELECT title, description FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.deepEqual([title.rows[0].title, title.rows[0].description], ["שם חדש", "תיאור חדש"]);

  const badPut = await app.inject({
    method: "PUT", url: `/api/seller/deals/${dealId}/delivery`, headers: H,
    payload: { delivery_options: [{ ...BOOKSTORE_DELIVERY, estimated_min_business_days: 9, estimated_max_business_days: 1 }] }
  });
  assert.equal(badPut.statusCode, 400, badPut.body);
  assert.equal(badPut.json().code, "delivery_estimate_range_invalid");

  const put = await app.inject({
    method: "PUT", url: `/api/seller/deals/${dealId}/delivery`, headers: H,
    payload: { delivery_options: [{ ...BOOKSTORE_DELIVERY, estimated_max_business_days: 7 }] }
  });
  assert.equal(put.statusCode, 200, put.body);
  const stored = await pool.query(`SELECT estimated_min_business_days, estimated_max_business_days FROM siton.deal_delivery_options WHERE deal_id=$1`, [dealId]);
  assert.deepEqual(stored.rows.map((r: any) => [r.estimated_min_business_days, r.estimated_max_business_days]), [[null, 7]]);
  const draft = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/draft`, headers: H });
  assert.equal((draft.json() as any).draft.delivery_options[0].estimate_text, "עד 7 ימי עסקים מהשלמת העסקה");
});

await run("product_library_routes_are_gone", async () => {
  for (const [method, url] of [
    ["GET", "/api/seller/products"],
    ["POST", "/api/seller/products"],
    ["GET", `/api/seller/products/${randomUUID()}`],
    ["PATCH", `/api/seller/products/${randomUUID()}`],
    ["GET", `/api/seller/product-images/${randomUUID()}`],
    ["POST", `/api/seller/deals/${dealId}/product`]
  ] as const) {
    const r = await app.inject({ method, url, headers: H, ...(method === "GET" ? {} : { payload: {} }) });
    assert.equal(r.statusCode, 404, `${method} ${url} -> ${r.statusCode} ${r.body}`);
  }
});

await pool.end();
await app.close();
console.log(`DELIVERY_ESTIMATE_VALIDATION passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
