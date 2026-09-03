// P0.7 polish — DB-exercised proof of the seller-authorized BUYER PREVIEW:
//  1. the owner seller can preview its OWN Draft (same projection as public)
//  2. another seller answers 404 (like a missing deal)
//  3. a non-owner / guest context cannot reach the Draft; the public route keeps 404
//  4. previewing creates NO join / share / payment / publish / outbox state
//  5. pickup location parity: preview projection == public projection after publish
//  6. countdown parity: same canonical deadline field (same component on the page)
//  7. published public behavior unchanged; preview also works for published deals
//  + the public projection carries no seller e-mail / phone
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";

const { app } = await import("../src/app.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const sellerA = `seller-p07pa-${randomUUID().slice(0, 8)}`;
const sellerB = `seller-p07pb-${randomUUID().slice(0, 8)}`;
const HA = { "x-seller-id": sellerA, "content-type": "application/json" };
const HB = { "x-seller-id": sellerB, "content-type": "application/json" };
const PHONE = "0509876543";
const PICKUP = "רח׳ אלנבי 5, תל אביב — קומה 2";

async function createDraft(headers: Record<string, string>, title: string) {
  const res = await app.inject({
    method: "POST", url: "/deals", headers: { ...headers, "idempotency-key": `p07p-${randomUUID().slice(0, 12)}` },
    payload: {
      title, description_short: "טיוטה לתצוגה מקדימה", description: "תיאור", price_per_unit: 35, min_units: 5, max_units: 30,
      deadline: new Date(Date.now() + 3 * 864e5 + 5 * 3600e3).toISOString(), deal_type: "physical_product",
      delivery_options: [
        { option_type: "pickup", label: PICKUP, cost: 0, sort_order: 0, latitude: 32.0642, longitude: 34.7696 },
        { option_type: "delivery", label: "משלוח שליח", cost: 20, sort_order: 1 }
      ]
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  return String(body.deal?.deal_id || body.deal_id);
}

function projection(o: any) {
  return { option_type: o.option_type, label: o.label, cost: o.cost, location_text: o.location_text, has_location: o.has_location, map_url: o.map_url };
}

async function sideEffectSnapshot(dealId: string) {
  const r = await pool.query(
    `SELECT (SELECT count(*)::int FROM siton.participants WHERE deal_id=$1) AS participants,
            (SELECT count(*)::int FROM siton.viral_events WHERE deal_id=$1) AS viral_events,
            (SELECT count(*)::int FROM siton.affiliate_link_events e JOIN siton.affiliate_links l ON l.link_id=e.link_id WHERE l.deal_id=$1) AS link_events,
            (SELECT count(*)::int FROM siton.payment_authorization_bindings WHERE deal_id=$1) AS bindings,
            (SELECT count(*)::int FROM siton.outbox_events WHERE aggregate_type='deal' AND aggregate_id=$1) AS outbox,
            (SELECT count(*)::int FROM siton.audit_log WHERE deal_id=$1) AS audit,
            (SELECT state FROM siton.deals WHERE deal_id=$1) AS state,
            (SELECT published_at FROM siton.deals WHERE deal_id=$1) AS published_at`,
    [dealId]
  );
  return r.rows[0];
}

let draftA = "";
let previewBeforePublish: any = null;

await run("setup: seller A (with a support phone) owns a Draft; seller B exists", async () => {
  for (const [headers, id] of [[HA, sellerA], [HB, sellerB]] as const) {
    const bp = await app.inject({
      method: "PUT", url: "/api/seller/business-profile", headers,
      payload: { business_name: `עסק ${id}`, business_id_number: "515000009", contact_name: "בודק", contact_phone: PHONE, contact_email: `${id}@siton.test` }
    });
    assert.equal(bp.statusCode, 200, bp.body);
  }
  draftA = await createDraft(HA, "טיוטה של מוכר א");
  const state = await pool.query(`SELECT state, published_at FROM siton.deals WHERE deal_id=$1`, [draftA]);
  assert.equal(state.rows[0].state, "Draft");
  assert.equal(state.rows[0].published_at, null);
});

await run("1: the owner seller previews its own Draft through the seller-authorized route (same projection, no contact data)", async () => {
  const res = await app.inject({ method: "GET", url: `/api/seller/deals/${draftA}/preview`, headers: HA });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.ok, true);
  assert.equal(body.preview.mode, "seller_preview");
  assert.equal(body.preview.read_only, true);
  assert.equal(body.preview.published, false);
  assert.equal(body.deal.state, "Draft");
  assert.equal(body.deal.published_at, null);
  assert.ok(typeof body.deal.deadline === "string" && Number.isFinite(Date.parse(body.deal.deadline)), "canonical deadline present for the countdown");
  const pickup = body.deal.delivery_options.find((o: any) => o.option_type === "pickup");
  assert.equal(pickup.location_text, PICKUP);
  assert.equal(pickup.has_location, true);
  assert.match(String(pickup.map_url), /32\.0642,34\.7696/);
  assert.ok(!("support_email" in body.seller) && !("support_phone" in body.seller), "no seller contact data in the preview projection");
  assert.ok(!res.body.includes(PHONE) && !res.body.includes("@siton.test"), "no phone / e-mail anywhere in the preview JSON");
  assert.equal(body.seller.contact_channel, "siton_inquiry");
  for (const key of ["deal", "metrics", "seller", "availability"]) assert.ok(key in body, `public shape key ${key}`);
  previewBeforePublish = body;
});

await run("2: another seller receives 404 for the Draft preview (exactly like a missing deal)", async () => {
  const res = await app.inject({ method: "GET", url: `/api/seller/deals/${draftA}/preview`, headers: HB });
  assert.equal(res.statusCode, 404, res.body);
  const missing = await app.inject({ method: "GET", url: `/api/seller/deals/${randomUUID()}/preview`, headers: HB });
  assert.equal(missing.statusCode, 404);
  assert.equal((res.json() as any).error, (missing.json() as any).error, "foreign and missing are indistinguishable");
});

await run("3: a non-owner context cannot reach the Draft and the public route keeps it undiscoverable", async () => {
  // demo-preview resolves an anonymous request to the default seller context — still not the owner → 404
  const guest = await app.inject({ method: "GET", url: `/api/seller/deals/${draftA}/preview` });
  assert.ok([401, 403, 404].includes(guest.statusCode), `guest got ${guest.statusCode}`);
  const pub = await app.inject({ method: "GET", url: `/api/deals/${draftA}/public` });
  assert.equal(pub.statusCode, 404, "a Draft must never be served by the public route");
  const og = await app.inject({ method: "GET", url: `/d/${draftA}` });
  assert.equal(og.statusCode, 302, "share route only redirects, never renders a Draft");
});

await run("4: previewing (repeatedly) creates no join / share / payment / publish / outbox state", async () => {
  const before = await sideEffectSnapshot(draftA);
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: "GET", url: `/api/seller/deals/${draftA}/preview`, headers: HA });
    assert.equal(res.statusCode, 200);
  }
  const after = await sideEffectSnapshot(draftA);
  assert.deepEqual(after, before, `side effects: ${JSON.stringify({ before, after })}`);
  assert.equal(after.state, "Draft");
  assert.equal(after.published_at, null);
  assert.equal(after.participants, 0);
  assert.equal(after.bindings, 0);
  assert.equal(after.outbox, 0);
});

await run("5+7: after publishing, the public projection equals the preview projection (pickup parity) and the public route behaves as before", async () => {
  const publish = await app.inject({
    method: "POST", url: `/deals/${draftA}/publish`, headers: { ...HA, "idempotency-key": `p07pp-${randomUUID().slice(0, 12)}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(publish.statusCode, 200, publish.body);
  const pub = await app.inject({ method: "GET", url: `/api/deals/${draftA}/public` });
  assert.equal(pub.statusCode, 200, pub.body);
  const pubBody = pub.json() as any;
  assert.deepEqual(pubBody.deal.delivery_options.map(projection), previewBeforePublish.deal.delivery_options.map(projection));
  assert.equal(pubBody.deal.deadline, previewBeforePublish.deal.deadline, "same canonical deadline drives the same countdown component");
  assert.equal(pubBody.deal.title, previewBeforePublish.deal.title);
  assert.deepEqual(pubBody.seller, previewBeforePublish.seller, "identical seller identity block (no contact data)");
  assert.ok(!("preview" in pubBody), "the public route never carries preview metadata");
  assert.equal(pubBody.deal.state, "PendingTarget");
  // preview still works for the published deal and says so
  const previewPublished = await app.inject({ method: "GET", url: `/api/seller/deals/${draftA}/preview`, headers: HA });
  assert.equal(previewPublished.statusCode, 200);
  assert.equal((previewPublished.json() as any).preview.published, true);
  assert.equal((previewPublished.json() as any).preview.state, "PendingTarget");
  // still seller-isolated after publish
  const foreign = await app.inject({ method: "GET", url: `/api/seller/deals/${draftA}/preview`, headers: HB });
  assert.equal(foreign.statusCode, 404);
});

await run("public contract: no seller phone / e-mail on a published deal either", async () => {
  const pub = (await app.inject({ method: "GET", url: `/api/deals/${draftA}/public` }));
  assert.ok(!pub.body.includes(PHONE) && !/support_phone|support_email/.test(pub.body), "phone / e-mail leaked");
});

console.log(`\nP07B_RESULT passed=${passed} failed=${failed}`);
await pool.end().catch(() => undefined);
await app.close().catch(() => undefined);
process.exit(failed ? 1 : 0);
