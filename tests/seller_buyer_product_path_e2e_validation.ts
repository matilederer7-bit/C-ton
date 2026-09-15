// OVERNIGHT PRODUCT INTEGRATION HARDENING — the ONE central product path,
// driven end to end against the real runtime in SERVER-SESSION mode (the mode
// hosted staging runs in; NOT the demo-preview header identity that most
// proofs use), so what is proven here is what a pilot seller and buyer get.
//
//   SELLER  provision → login (cookie) → business profile → create Draft →
//           read Draft back → edit Draft → upload image → buyer preview →
//           publish → deal visible in "my deals" only → post-publish edit refused
//   BUYER   public URL 404 before publish → real public payload after publish →
//           server-side amount for qty + delivery → mock authorization (payment-
//           safe boundary, no provider, no money) → join → retry is idempotent →
//           amount shown == amount held → progress reflects the join
//   STATES  closed / cancelled / malformed id / unknown id → bounded JSON, no 5xx
//   IDOR    seller B (own valid session) against seller A's deal on every seller
//           route: identical to a nonexistent deal; forged x-seller-id ignored;
//           anonymous caller refused with the stable seller-auth product code.
//
// Real money: 0. Provider calls: 0 (mockpay, mock-backed, in-process).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.SELLER_SESSION_SECRET = "product-path-e2e-seller-session-secret";
process.env.DISABLE_OUTBOX_WORKER = "1";
delete process.env.ADMIN_API_KEY;
delete process.env.PAYMENT_BINDING_ENFORCEMENT;

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}

const suffix = randomUUID().slice(0, 8);
const SELLER_A = `seller-pp-a-${suffix}`;
const SELLER_B = `seller-pp-b-${suffix}`;
const PASSWORD = "product-path-pass-123";
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhS8AAAAASUVORK5CYII=";
const PRICE = 42;
const DELIVERY_COST = 18;
const BUYER_PHONE = "0501234567";

let cookieA = "";
let cookieB = "";
let dealId = "";
let imageId = "";
let deliveryOptionId = "";
let draftUpdatedAt = "";
let publicBeforePublish: any = null;

function cookieOf(res: any) {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? String(raw[0] || "") : String(raw || "");
  return first.split(";")[0] || "";
}

async function provisionAndLogin(sellerId: string, email: string) {
  const { cookie: adminCookie } = await establishNamedAdminSession(app, pool);
  const provisioned = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${sellerId}/provision`,
    headers: { cookie: adminCookie },
    payload: { display_name: `Seller ${sellerId}`, login_email: email, access_code: PASSWORD, auth_enabled: true }
  });
  assert.equal(provisioned.statusCode, 200, provisioned.body);
  const login = await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    payload: { identifier: email, access_code: PASSWORD }
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = cookieOf(login);
  assert.match(cookie, /siton_seller_session=/);
  return cookie;
}

const json = (res: any) => {
  assert.match(String(res.headers["content-type"] || ""), /application\/json/, `JSON contract expected, got ${res.headers["content-type"]}: ${String(res.body).slice(0, 120)}`);
  return res.json() as any;
};

try {
  await run("SELLER: two sellers are provisioned and log in through the real cookie session rail", async () => {
    cookieA = await provisionAndLogin(SELLER_A, `${SELLER_A}@siton.test`);
    cookieB = await provisionAndLogin(SELLER_B, `${SELLER_B}@siton.test`);
    const session = await app.inject({ method: "GET", url: "/api/seller/session", headers: { cookie: cookieA } });
    const body = json(session);
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(body.seller_auth?.authenticated, true);
    assert.equal(body.seller_auth?.mode, "server-session");
  });

  await run("SELLER: an anonymous caller gets the stable seller-auth refusal, never a listing or a validation hint", async () => {
    const list = await app.inject({ method: "GET", url: "/api/seller/deals" });
    assert.equal(list.statusCode, 401, list.body);
    assert.equal(json(list).ok, false);
    const create = await app.inject({ method: "POST", url: "/deals", payload: {} });
    assert.equal(create.statusCode, 401, create.body);
    const body = json(create);
    assert.equal(body.product_code, "SELLER_AUTH_REQUIRED");
    assert.ok(!/title/.test(String(body.error)), "no validation detail before authentication");
  });

  await run("SELLER: my-deals is a sane empty state before any deal exists", async () => {
    const res = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie: cookieA } });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.ok, true);
    const deals = body.seller_surface?.deals;
    assert.ok(Array.isArray(deals), "seller_surface.deals is the list the dashboard renders");
    assert.equal(deals.filter((d: any) => String(d.title || "").includes(suffix)).length, 0);
    assert.equal(Number(body.seller_surface.totals?.total_deals), deals.length);
  });

  await run("SELLER: business profile saved; Draft created with a delivery option and read back", async () => {
    const profile = await app.inject({
      method: "PUT",
      url: "/api/seller/business-profile",
      headers: { cookie: cookieA },
      payload: { business_name: `העסק של ${SELLER_A}`, business_id_number: "515000009", contact_name: "בודק", contact_phone: "0509876543", contact_email: `${SELLER_A}@siton.test` }
    });
    assert.equal(profile.statusCode, 200, profile.body);

    const created = await app.inject({
      method: "POST",
      url: "/api/deals",
      headers: { cookie: cookieA, "idempotency-key": `pp-create-${suffix}` },
      payload: {
        title: `עסקת מסלול מוצר ${suffix}`,
        description_short: "תיאור קצר",
        description: "תיאור מלא של המוצר",
        price_per_unit: PRICE,
        list_price_per_unit: 60,
        min_units: 4,
        max_units: 10,
        deadline: new Date(Date.now() + 3 * 864e5).toISOString(),
        deal_type: "physical_product",
        delivery_options: [
          { option_type: "delivery", label: "משלוח עד הבית", cost: DELIVERY_COST, sort_order: 0 },
          { option_type: "pickup", label: "איסוף עצמי — רח׳ הרצל 10, חיפה", cost: 0, sort_order: 1, latitude: 32.8191, longitude: 34.9983 }
        ]
      }
    });
    assert.equal(created.statusCode, 200, created.body);
    const body = json(created);
    dealId = String(body.deal?.deal_id || body.deal_id);
    assert.match(dealId, /^[0-9a-f-]{36}$/);

    const draft = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/draft`, headers: { cookie: cookieA } });
    assert.equal(draft.statusCode, 200, draft.body);
    const d = json(draft);
    const deal = d.deal || d.draft || d;
    assert.equal(String(deal.state), "Draft");
    assert.equal(Number(deal.price_per_unit), PRICE);
    assert.equal(Number(deal.threshold_units), Math.ceil(0.9 * 4), "90% threshold computed server-side");
    draftUpdatedAt = String(deal.updated_at || "");
    const row = await pool.query(`SELECT seller_id, state, published_at FROM siton.deals WHERE deal_id=$1`, [dealId]);
    assert.equal(row.rows[0].seller_id, SELLER_A, "the deal belongs to the session identity, not to any header");
    assert.equal(row.rows[0].published_at, null);
  });

  await run("SELLER: the Draft is edited (title, price, max units) and the edit is what the runtime now holds", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/seller/deals/${dealId}/draft`,
      headers: { cookie: cookieA },
      payload: { title: `עסקת מסלול מוצר ${suffix} — מעודכן`, price_per_unit: PRICE, max_units: 6, ...(draftUpdatedAt ? { expected_updated_at: draftUpdatedAt } : {}) }
    });
    assert.equal(res.statusCode, 200, res.body);
    const row = await pool.query(`SELECT title, max_units, state FROM siton.deals WHERE deal_id=$1`, [dealId]);
    assert.equal(row.rows[0].title, `עסקת מסלול מוצר ${suffix} — מעודכן`);
    assert.equal(Number(row.rows[0].max_units), 6);
    assert.equal(row.rows[0].state, "Draft");
  });

  await run("SELLER: an image is uploaded to the Draft and is served back", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/seller/deals/${dealId}/images`,
      headers: { cookie: cookieA, "idempotency-key": `pp-image-${suffix}` },
      payload: { image_data_url: `data:image/png;base64,${PIXEL_PNG}`, filename: "pixel.png", is_primary: true }
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = json(res);
    imageId = String(body.image?.image_id || body.image_id || (body.images || [])[0]?.image_id || "");
    assert.match(imageId, /^[0-9a-f-]{36}$/, `image id in response: ${res.body.slice(0, 200)}`);
    const served = await app.inject({ method: "GET", url: `/api/deal-images/${imageId}`, headers: { cookie: cookieA } });
    assert.equal(served.statusCode, 200, `owner can read its unpublished image: ${served.body.slice(0, 120)}`);
    assert.match(String(served.headers["content-type"]), /image\/png/);
  });

  await run("SELLER: the buyer preview of the Draft is the public projection (image, price, delivery, seller) with join disabled", async () => {
    const res = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/preview`, headers: { cookie: cookieA } });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.preview?.mode, "seller_preview");
    assert.equal(body.preview?.read_only, true);
    assert.equal(body.deal.state, "Draft");
    assert.equal(body.deal.images.length, 1);
    assert.equal(body.deal.images[0].image_id, imageId);
    assert.equal(Number(body.deal.price_per_unit), PRICE);
    assert.equal(body.deal.delivery_options.length, 2);
    deliveryOptionId = String(body.deal.delivery_options.find((o: any) => o.option_type === "delivery").option_id);
    assert.equal(body.availability.canJoin, false);
    assert.equal(body.seller.contact_channel, "siton_inquiry");
    assert.ok(!res.body.includes("@siton.test"), "no seller e-mail in the projection");
    publicBeforePublish = body;
  });

  await run("BUYER: before publish the public URL is a clean 404 — a Draft is not discoverable", async () => {
    const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(json(res).ok, false);
    const share = await app.inject({ method: "GET", url: `/d/${dealId}` });
    assert.equal(share.statusCode, 302, "unpublished share link falls through to the app without leaking metadata");
  });

  await run("SELLER: publish moves Draft → PendingTarget through the transition layer with audit + outbox", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/publish`,
      headers: { cookie: cookieA, "idempotency-key": `pp-publish-${suffix}` },
      payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
    });
    assert.equal(res.statusCode, 200, res.body);
    const row = await pool.query(
      `SELECT d.state, d.published_at,
              (SELECT count(*)::int FROM siton.audit_log a WHERE a.deal_id=d.deal_id AND a.to_state='PendingTarget') AS audit_rows,
              (SELECT count(*)::int FROM siton.outbox_events o WHERE o.aggregate_id=d.deal_id AND o.event_type='deadline_check') AS deadline_events
       FROM siton.deals d WHERE d.deal_id=$1`,
      [dealId]
    );
    assert.equal(row.rows[0].state, "PendingTarget");
    assert.ok(row.rows[0].published_at, "published_at set");
    assert.equal(row.rows[0].audit_rows, 1, "exactly one publish audit row");
    assert.equal(row.rows[0].deadline_events, 1, "exactly one deadline_check outbox event");
  });

  await run("SELLER: the published deal is listed for its owner and a post-publish draft edit is refused with a typed 409", async () => {
    const list = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie: cookieA } });
    assert.equal(list.statusCode, 200, list.body);
    const mine = json(list).seller_surface.deals.find((d: any) => d.deal_id === dealId);
    assert.ok(mine, "owner sees the deal");
    assert.equal(mine.state, "PendingTarget");
    assert.equal(mine.images.length, 1);

    const detail = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}`, headers: { cookie: cookieA } });
    assert.equal(detail.statusCode, 200, detail.body);

    const edit = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: { cookie: cookieA }, payload: { title: "לא אמור להישמר" } });
    assert.equal(edit.statusCode, 409, edit.body);
    assert.equal(json(edit).code, "DEAL_NOT_EDITABLE");
  });

  await run("BUYER: the public page now comes from the runtime and matches the seller's preview", async () => {
    const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    for (const key of ["deal_id", "title", "description", "state", "price_per_unit", "min_units", "max_units", "threshold_units", "deadline", "delivery_options", "images"]) {
      assert.ok(key in body.deal, `public deal carries ${key}`);
    }
    assert.equal(body.deal.state, "PendingTarget");
    assert.equal(body.deal.title, `עסקת מסלול מוצר ${suffix} — מעודכן`);
    assert.equal(Number(body.deal.max_units), 6);
    assert.equal(body.deal.images[0].image_id, imageId);
    assert.equal(body.metrics.joined_units, 0);
    assert.equal(body.metrics.remaining_units, 6);
    assert.equal(body.availability.canJoin, true);
    assert.ok(body.seller.business_name, "seller identity present");
    assert.deepEqual(
      body.deal.delivery_options.map((o: any) => [o.option_type, o.cost]),
      publicBeforePublish.deal.delivery_options.map((o: any) => [o.option_type, o.cost]),
      "preview == public"
    );
    const image = await app.inject({ method: "GET", url: `/api/deal-images/${imageId}` });
    assert.equal(image.statusCode, 200, "published image is public");
    const share = await app.inject({ method: "GET", url: `/d/${dealId}`, headers: { host: "siton.test" } });
    assert.equal(share.statusCode, 200);
    assert.match(share.body, /og:title/);
    assert.match(share.body, new RegExp(`#/deal/${dealId}`));
  });

  await run("BUYER: the amount is computed server-side for qty + delivery and held by the MOCK adapter (payment-safe boundary)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/payments/authorize-mock",
      payload: { deal_id: dealId, buyer_id: BUYER_PHONE, qty: 2, delivery_option_id: deliveryOptionId, payer_name: "קונה בודק", payment_method_id: `pm_mock_product_path_${suffix}` }
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.ok, true);
    assert.equal(body.authorization, "authorized");
    assert.ok(body.authorization_id, "opaque authorization handle");
    const binding = await pool.query(
      `SELECT amount_minor, qty, provider_code, provider_mode, status FROM siton.payment_authorization_bindings WHERE authorization_id=$1 AND deal_id=$2`,
      [String(body.authorization_id), dealId]
    );
    assert.equal(binding.rowCount, 1, "server-owned binding recorded for this deal");
    assert.equal(binding.rows[0].status, "authorized");
    assert.equal(Number(binding.rows[0].amount_minor), (2 * PRICE + DELIVERY_COST) * 100, "amount = qty × price + delivery, in agorot, from the server");
    assert.equal(Number(binding.rows[0].qty), 2);
    assert.equal(binding.rows[0].provider_mode, "mock-backed", "no real provider was involved");
    (globalThis as any).__authorizationId = String(body.authorization_id);
  });

  await run("BUYER: join records the participation, the hold total equals the shown amount, and a retry is idempotent", async () => {
    const idem = `pp-join-${suffix}`;
    const payload = {
      buyer_id: BUYER_PHONE,
      buyer_name: "קונה בודק",
      qty: 2,
      delivery_option_id: deliveryOptionId,
      delivery_address: "רח׳ הנביאים 3",
      delivery_city: "חיפה",
      payment_disclosure_accepted: true,
      payment_method: "credit_card",
      authorization_id: (globalThis as any).__authorizationId,
      authorization_provider: "mockpay"
    };
    const first = await app.inject({ method: "POST", url: `/api/deals/${dealId}/join`, headers: { "idempotency-key": idem }, payload });
    assert.equal(first.statusCode, 200, first.body);
    const body = json(first);
    assert.equal(body.hold_total, 2 * PRICE + DELIVERY_COST, "hold total == qty × price + delivery");
    assert.ok(body.participant_id && body.tracking_access_token, "tracking credential issued");

    const retry = await app.inject({ method: "POST", url: `/api/deals/${dealId}/join`, headers: { "idempotency-key": idem }, payload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(json(retry).participant_id, body.participant_id, "same participant on retry");

    const mismatch = await app.inject({ method: "POST", url: `/api/deals/${dealId}/join`, headers: { "idempotency-key": idem }, payload: { ...payload, qty: 3 } });
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    assert.equal(json(mismatch).code, "idempotency_payload_mismatch");

    const state = await pool.query(
      `SELECT buyer_state, money_state, qty FROM siton.participants WHERE deal_id=$1`,
      [dealId]
    );
    assert.equal(state.rowCount, 1, "exactly one participant after retry + mismatch");
    assert.equal(state.rows[0].buyer_state, "JoinedAuthorized");
    assert.equal(state.rows[0].money_state, "AuthHeld");
    assert.equal(Number(state.rows[0].qty), 2);
    const consumed = await pool.query(
      `SELECT status, consumed_by_participant_id FROM siton.payment_authorization_bindings WHERE authorization_id=$1 AND deal_id=$2`,
      [String((globalThis as any).__authorizationId), dealId]
    );
    assert.equal(consumed.rows[0].status, "consumed", "join consumed the server-side binding");
    assert.equal(String(consumed.rows[0].consumed_by_participant_id), String(body.participant_id));
    const attempts = await pool.query(`SELECT count(*)::int AS n FROM siton.payment_attempts WHERE deal_id=$1`, [dealId]);
    assert.equal(attempts.rows[0].n, 0, "no charge attempt exists — money stays at the authorization boundary");

    const pub = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
    const metrics = json(pub).metrics;
    assert.equal(metrics.joined_units, 2);
    assert.equal(metrics.remaining_units, 4);
    assert.equal(metrics.participants_count, 1);

    const tracking = await app.inject({ method: "GET", url: `/api/participants/${body.participant_id}/tracking`, headers: { authorization: `Bearer ${body.tracking_access_token}` } });
    assert.equal(tracking.statusCode, 200, tracking.body);
    const t = json(tracking).tracking;
    assert.ok(t && t.personal_status && typeof t.personal_status.title === "string", "tracking.personal_status carries the title the tracking page renders");
    assert.equal(t.buyer_state ?? t.personal?.buyer_state ?? "JoinedAuthorized", "JoinedAuthorized");
  });

  await run("IDOR: seller B (valid session) cannot read, edit, publish, upload, reorder, delete, duplicate, export or preview seller A's deal — foreign == nonexistent", async () => {
    const ghost = randomUUID();
    const probes: Array<[string, string, any]> = [
      ["GET", "/api/seller/deals/{id}", undefined],
      ["GET", "/api/seller/deals/{id}/draft", undefined],
      ["GET", "/api/seller/deals/{id}/preview", undefined],
      ["GET", "/api/seller/deals/{id}/export.xlsx", undefined],
      ["GET", "/api/seller/deals/{id}/shipping-export", undefined],
      ["GET", "/api/seller/deals/{id}/fulfillment", undefined],
      ["GET", "/api/seller/deals/{id}/delivery-handoff", undefined],
      ["PATCH", "/api/seller/deals/{id}/draft", { title: "hijack" }],
      ["PUT", "/api/seller/deals/{id}/delivery", { delivery_options: [{ option_type: "pickup", label: "x", cost: 0 }] }],
      ["POST", "/api/seller/deals/{id}/images", { image_data_url: `data:image/png;base64,${PIXEL_PNG}` }],
      ["PATCH", "/api/seller/deals/{id}/images/order", { image_ids: [imageId] }],
      ["DELETE", `/api/seller/deals/{id}/images/${imageId}`, undefined],
      ["POST", "/api/seller/deals/{id}/duplicate", {}],
      ["DELETE", "/api/seller/deals/{id}", undefined],
      ["POST", "/api/deals/{id}/publish", { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }],
      ["POST", "/api/deals/{id}/close_joining", {}],
      ["POST", "/api/deals/{id}/cancel", {}]
    ];
    for (const [method, template, payload] of probes) {
      const foreign = await app.inject({ method: method as any, url: template.replace("{id}", dealId), headers: { cookie: cookieB, "idempotency-key": `pp-idor-${suffix}-${randomUUID().slice(0, 6)}` }, payload });
      const missing = await app.inject({ method: method as any, url: template.replace("{id}", ghost), headers: { cookie: cookieB, "idempotency-key": `pp-idor-${suffix}-${randomUUID().slice(0, 6)}` }, payload });
      assert.ok(foreign.statusCode >= 400 && foreign.statusCode < 500, `${method} ${template}: foreign must be refused, got ${foreign.statusCode} ${foreign.body.slice(0, 100)}`);
      assert.equal(foreign.statusCode, missing.statusCode, `${method} ${template}: foreign (${foreign.statusCode}) must look like missing (${missing.statusCode})`);
      assert.equal(json(foreign).error, json(missing).error, `${method} ${template}: same error body for foreign and missing`);
    }
    const untouched = await pool.query(`SELECT state, title, seller_id, (SELECT count(*)::int FROM siton.deal_images WHERE deal_id=$1) AS images FROM siton.deals WHERE deal_id=$1`, [dealId]);
    assert.equal(untouched.rows[0].state, "PendingTarget");
    assert.equal(untouched.rows[0].seller_id, SELLER_A);
    assert.equal(untouched.rows[0].images, 1);
    assert.equal(untouched.rows[0].title, `עסקת מסלול מוצר ${suffix} — מעודכן`);
  });

  await run("IDOR: a forged x-seller-id / seller_id on a real session changes nothing — identity is the session", async () => {
    const list = await app.inject({ method: "GET", url: "/api/seller/deals", headers: { cookie: cookieB, "x-seller-id": SELLER_A } });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(json(list).seller_surface.deals.some((d: any) => d.deal_id === dealId), false, "seller B never sees A's deal, even with a forged header");
    const draft = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/draft`, headers: { cookie: cookieB, "x-seller-id": SELLER_A } });
    assert.equal(draft.statusCode, 404, draft.body);
    const hijackClose = await app.inject({ method: "POST", url: `/api/deals/${dealId}/close_joining`, headers: { cookie: cookieB, "x-seller-id": SELLER_A }, payload: { seller_id: SELLER_A } });
    assert.equal(hijackClose.statusCode, 404, hijackClose.body);
    const switchContext = await app.inject({ method: "POST", url: "/api/seller/context", headers: { cookie: cookieB }, payload: { seller_id: SELLER_A } });
    assert.equal(switchContext.statusCode, 403, "manual context switching is disabled outside demo-preview");
    const state = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
    assert.equal(state.rows[0].state, "PendingTarget");
  });

  await run("STATES: closed for joining, cancelled draft, malformed id and unknown id all answer bounded JSON", async () => {
    const close = await app.inject({ method: "POST", url: `/api/deals/${dealId}/close_joining`, headers: { cookie: cookieA, "idempotency-key": `pp-close-${suffix}` }, payload: {} });
    assert.equal(close.statusCode, 200, close.body);
    const closedPublic = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
    assert.equal(closedPublic.statusCode, 200, closedPublic.body);
    const closedBody = json(closedPublic);
    assert.equal(closedBody.deal.state, "ClosedForJoining");
    assert.equal(closedBody.availability.canJoin, false);
    const lateJoin = await app.inject({ method: "POST", url: `/api/deals/${dealId}/join`, headers: { "idempotency-key": `pp-late-${suffix}` }, payload: { buyer_id: "0507654321", qty: 1, payment_disclosure_accepted: true, delivery_option_id: deliveryOptionId, delivery_address: "x", delivery_city: "y" } });
    assert.equal(lateJoin.statusCode, 409, lateJoin.body);
    assert.equal(json(lateJoin).ok, false);

    const secondDraft = await app.inject({ method: "POST", url: "/api/deals", headers: { cookie: cookieA, "idempotency-key": `pp-create2-${suffix}` }, payload: { title: `טיוטה לביטול ${suffix}`, price_per_unit: 10, min_units: 2, max_units: 5, deadline: new Date(Date.now() + 2 * 864e5).toISOString() } });
    assert.equal(secondDraft.statusCode, 200, secondDraft.body);
    const secondId = String(json(secondDraft).deal?.deal_id || json(secondDraft).deal_id);
    const cancel = await app.inject({ method: "POST", url: `/api/deals/${secondId}/cancel`, headers: { cookie: cookieA, "idempotency-key": `pp-cancel-${suffix}` }, payload: {} });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const cancelledPublic = await app.inject({ method: "GET", url: `/api/deals/${secondId}/public` });
    assert.equal(cancelledPublic.statusCode, 404, "a never-published cancelled draft stays undiscoverable");
    const cancelledOwner = await app.inject({ method: "GET", url: `/api/seller/deals/${secondId}`, headers: { cookie: cookieA } });
    assert.equal(cancelledOwner.statusCode, 200, cancelledOwner.body);
    assert.equal(json(cancelledOwner).deal?.state ?? json(cancelledOwner).state, "Cancelled");

    for (const bad of ["not-a-uuid", "12345", "%00", `${dealId}x`]) {
      const res = await app.inject({ method: "GET", url: `/api/deals/${bad}/public` });
      assert.equal(res.statusCode, 400, `malformed public id ${bad}: ${res.statusCode} ${res.body.slice(0, 80)}`);
      assert.equal(json(res).ok, false);
      assert.ok(!/stack|at \w+ \(|\.ts:|\.js:/.test(res.body), "no stack trace or file path in the error body");
    }
    const unknown = await app.inject({ method: "GET", url: `/api/deals/${randomUUID()}/public` });
    assert.equal(unknown.statusCode, 404);
    const sellerBad = await app.inject({ method: "GET", url: "/api/seller/deals/not-a-uuid/draft", headers: { cookie: cookieA } });
    assert.equal(sellerBad.statusCode, 400, sellerBad.body);
    assert.equal(json(sellerBad).ok, false);
    const badShare = await app.inject({ method: "GET", url: "/d/not-a-uuid" });
    assert.equal(badShare.statusCode, 302);
  });

  await run("SELLER: logout revokes the session; the cookie no longer authorizes anything", async () => {
    const logout = await app.inject({ method: "POST", url: "/api/seller/session/logout", headers: { cookie: cookieA } });
    assert.equal(logout.statusCode, 200, logout.body);
    const after = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}`, headers: { cookie: cookieA } });
    assert.equal(after.statusCode, 401, after.body);
    assert.equal(json(after).product_code, "SELLER_SESSION_EXPIRED");
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

console.log(`SUMMARY seller_buyer_product_path passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
