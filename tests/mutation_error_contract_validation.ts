// OVERNIGHT HARDENING — the error CONTRACT of every mutation the canonical
// React product actually calls (see web/src/api.ts, web/src/images.tsx,
// web/src/viral.ts), driven with hostile bodies. The read surface already has
// its own behavioural proof (input_error_surface_authority_validation); this is
// the write side. Invariants:
//   1. caller-controlled input never produces a 5xx (bounded 4xx),
//   2. every refusal is JSON with ok:false and a stable `error`,
//   3. no stack trace, SQL, driver text, file path or secret leaks.
// A route may ignore, clamp or refuse a hostile value — but it must never fault.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PAYMENT_PROVIDER_API_KEY = "sk_test_mutation_contract_must_not_leak";
process.env.PAYMENT_WEBHOOK_SECRET = "whsec_mutation_contract_must_not_leak";
process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_READ_MAX = "100000";

const { app } = await import("../src/app.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 3
});

const sellerId = `seller-mutation-${randomUUID().slice(0, 8)}`;
const SELLER = { "x-seller-id": sellerId };
const SECRETS = ["sk_test_mutation_contract_must_not_leak", "whsec_mutation_contract_must_not_leak"];
const LEAK = /(\bat\s+\w+.*\(|node_modules|\/home\/|\.ts:\d+|\.js:\d+|syntax error at|relation "|column "|siton\.\w+\s|ECONNREFUSED|password=)/i;

let failed = 0;
let probes = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error: any) {
    failed += 1;
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}

const HOSTILE_BODIES: Array<[string, any, Record<string, string>?]> = [
  ["empty object", {}],
  ["array body", [1, 2, 3]],
  ["string body", "\"just a string\""],
  ["number body", 42],
  ["null body", null],
  ["negative and huge numbers", { qty: -1, price_per_unit: 1e309, min_units: -5, max_units: "9".repeat(40), amount_minor: -100 }],
  ["wrong types", { qty: {}, buyer_id: [], title: { a: 1 }, delivery_options: "x", image_ids: 7, delivery_option_id: 12, payment_disclosure_accepted: "sure" }],
  ["oversized strings", { title: "א".repeat(20000), description: "x".repeat(200000), text: "y".repeat(60000), buyer_id: "0".repeat(5000), message: "z".repeat(60000) }],
  ["deep nesting", JSON.parse("{\"a\":".repeat(60) + "1" + "}".repeat(60))],
  ["prototype keys", { "__proto__": { polluted: true }, "constructor": { prototype: {} }, qty: 1 }],
  ["control characters", { title: `a${String.fromCharCode(0)}b`, buyer_id: `05${String.fromCharCode(0)}012`, text: `${String.fromCharCode(7, 27)}[31m`, buyer_name: String.fromCharCode(0x202e) }],
  ["uuid-looking garbage", { deal_id: "00000000-0000-0000-0000-00000000000g", delivery_option_id: "../../etc/passwd", authorization_id: "' OR 1=1 --", participant_id: "x".repeat(300) }],
  ["text/plain content type", "qty=1&buyer_id=1", { "content-type": "text/plain" }],
  ["broken json", "{\"qty\": 1,", { "content-type": "application/json" }]
];

async function probe(method: string, url: string, headers: Record<string, string> = {}) {
  for (const [label, body, extraHeaders] of HOSTILE_BODIES) {
    probes += 1;
    const raw = typeof body === "string" && extraHeaders ? body : JSON.stringify(body);
    const res = await app.inject({
      method: method as any,
      url,
      headers: { "content-type": "application/json", "idempotency-key": `mut-${randomUUID().slice(0, 12)}`, ...headers, ...(extraHeaders || {}) },
      payload: raw
    });
    const where = `${method} ${url} [${label}]`;
    assert.ok(res.statusCode < 500, `${where}: server fault ${res.statusCode}: ${res.body.slice(0, 200)}`);
    if (res.statusCode >= 400) {
      assert.match(String(res.headers["content-type"] || ""), /application\/json/, `${where}: refusal must be JSON, got ${res.headers["content-type"]}`);
      const parsed = res.json() as any;
      assert.equal(parsed.ok, false, `${where}: ok:false expected`);
      assert.ok(typeof parsed.error === "string" && parsed.error.length > 0, `${where}: stable error string expected`);
    }
    assert.ok(!LEAK.test(res.body), `${where}: internal detail leaked: ${res.body.slice(0, 200)}`);
    for (const secret of SECRETS) assert.ok(!res.body.includes(secret), `${where}: secret leaked`);
  }
}

let dealId = "";
let publishedDealId = "";
let imageId = "";
let deliveryOptionId = "";

try {
  await run("setup: a seller with a Draft and a published deal", async () => {
    const profile = await app.inject({ method: "PUT", url: "/api/seller/business-profile", headers: SELLER, payload: { business_name: `עסק ${sellerId}`, business_id_number: "515000009", contact_name: "בודק", contact_phone: "0509876543", contact_email: `${sellerId}@siton.test` } });
    assert.equal(profile.statusCode, 200, profile.body);
    for (const publish of [false, true]) {
      const created = await app.inject({
        method: "POST", url: "/deals", headers: { ...SELLER, "idempotency-key": `mut-create-${randomUUID().slice(0, 8)}` },
        payload: { title: `עסקה ${publish ? "מפורסמת" : "טיוטה"} ${sellerId}`, price_per_unit: 30, min_units: 2, max_units: 8, deadline: new Date(Date.now() + 2 * 864e5).toISOString(), delivery_options: [{ option_type: "delivery", label: "משלוח", cost: 10, sort_order: 0 }] }
      });
      assert.equal(created.statusCode, 200, created.body);
      const id = String((created.json() as any).deal?.deal_id || (created.json() as any).deal_id);
      if (publish) {
        const res = await app.inject({ method: "POST", url: `/deals/${id}/publish`, headers: { ...SELLER, "idempotency-key": `mut-pub-${randomUUID().slice(0, 8)}` }, payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
        assert.equal(res.statusCode, 200, res.body);
        publishedDealId = id;
        const pub = await app.inject({ method: "GET", url: `/api/deals/${id}/public` });
        deliveryOptionId = String((pub.json() as any).deal.delivery_options[0].option_id);
      } else {
        dealId = id;
        const img = await app.inject({ method: "POST", url: `/api/seller/deals/${id}/images`, headers: { ...SELLER, "idempotency-key": `mut-img-${randomUUID().slice(0, 8)}` }, payload: { image_data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhS8AAAAASUVORK5CYII=" } });
        assert.equal(img.statusCode, 201, img.body);
        imageId = String((img.json() as any).image.image_id);
      }
    }
  });

  await run("buyer-facing mutations answer bounded JSON for every hostile body", async () => {
    await probe("POST", `/api/deals/${publishedDealId}/join`);
    await probe("POST", `/api/deals/${publishedDealId}/chat`);
    await probe("POST", `/api/deals/${publishedDealId}/chat/${randomUUID()}/reaction`);
    await probe("POST", `/api/deals/${publishedDealId}/inquiries`);
    await probe("POST", `/api/inquiries/${randomUUID()}/messages`);
    await probe("POST", `/api/deals/${publishedDealId}/feedback`);
    await probe("POST", "/api/support/contact");
    await probe("POST", "/api/viral/events");
    await probe("POST", "/api/affiliate/links/visit");
    await probe("POST", "/api/mall/events");
    await probe("POST", "/api/payments/authorize-mock");
    await probe("POST", "/api/payments/status");
    await probe("POST", "/api/otp/start");
    await probe("POST", "/api/otp/verify");
    await probe("PUT", `/api/participants/${randomUUID()}/public-name`);
  });

  await run("seller mutations answer bounded JSON for every hostile body", async () => {
    await probe("POST", "/deals", SELLER);
    await probe("PATCH", `/api/seller/deals/${dealId}/draft`, SELLER);
    await probe("PUT", `/api/seller/deals/${dealId}/delivery`, SELLER);
    await probe("POST", `/api/seller/deals/${dealId}/images`, SELLER);
    await probe("PATCH", `/api/seller/deals/${dealId}/images/order`, SELLER);
    await probe("PUT", "/api/seller/business-profile", SELLER);
    await probe("PUT", "/api/seller/profile", SELLER);
    await probe("PUT", `/api/seller/deals/${dealId}/receipt`, SELLER);
    await probe("POST", `/deals/${dealId}/publish`, SELLER);
    // close_joining on a Draft is an illegal transition (409); on the published
    // deal an EMPTY body is a legitimate close, so the probe targets the Draft.
    await probe("POST", `/deals/${dealId}/close_joining`, SELLER);
    await probe("POST", `/deals/${dealId}/reopen_joining`, SELLER);
    await probe("POST", `/api/seller/deals/${dealId}/duplicate`, SELLER);
    await probe("POST", "/api/seller/fulfillment/handoff", SELLER);
    await probe("POST", `/api/seller/inquiries/${randomUUID()}/reply`, SELLER);
    await probe("POST", "/api/seller/content-assets", SELLER);
    await probe("PUT", "/api/seller/public-profile", SELLER);
  });

  await run("hostile bodies changed nothing durable", async () => {
    const draft = await pool.query(`SELECT state, title, (SELECT count(*)::int FROM siton.deal_images WHERE deal_id=$1) AS images FROM siton.deals WHERE deal_id=$1`, [dealId]);
    assert.equal(draft.rows[0].state, "Draft");
    assert.equal(draft.rows[0].images, 1, `image ${imageId} still the only image`);
    const published = await pool.query(`SELECT state, (SELECT count(*)::int FROM siton.participants WHERE deal_id=$1) AS participants FROM siton.deals WHERE deal_id=$1`, [publishedDealId]);
    assert.equal(published.rows[0].state, "PendingTarget", "no hostile close_joining succeeded");
    assert.equal(published.rows[0].participants, 0, "no hostile join created a participant");
    assert.ok(deliveryOptionId, "fixture sanity");
    console.log(`  probes=${probes}`);
  });
} finally {
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

if (failed > 0) {
  console.error(`FAILED ${failed} mutation error contract checks`);
  process.exit(1);
}
console.log("All mutation error contract checks passed.");
