// P0.7C — server-side proof that public READ polling has its own bounded budget
// while every sensitive MUTATION keeps the strict per-IP bucket:
//   • bucket classification: reads on the deal prefixes → "read", mutations → "sensitive", others → "none"
//   • B: three "tabs" worth of first-minute reads (30 GETs) from ONE IP → no 429 (old rule: 429 after 20)
//   • the read budget is still bounded (RATE_LIMIT_READ_MAX + 1 → 429)
//   • E/G: 20 sensitive POSTs then the 21st → 429 (inquiries, OTP, support); reads never consume it
//   • F: the inquiry spam limiter (5 per customer per hour) is intact
//   • H: the public activity feed still reflects a new join
//   • I: the Draft preview route is outside both buckets
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.RATE_LIMIT_MAX = "200";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "20";
process.env.RATE_LIMIT_READ_MAX = "120";

const { app, rateLimitBucketFor } = await import("../src/app.js");
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const seller = `seller-p07c-${randomUUID().slice(0, 8)}`;
const HS = { "x-seller-id": seller, "content-type": "application/json" };
let dealId = "";
const ip = (n: number) => `10.77.${Math.floor(n / 250)}.${(n % 250) + 1}`;
async function get(url: string, clientIp: string) {
  return app.inject({ method: "GET", url, headers: { "x-forwarded-for": clientIp } });
}
async function post(url: string, clientIp: string, payload: unknown) {
  return app.inject({ method: "POST", url, headers: { "x-forwarded-for": clientIp, "content-type": "application/json" }, payload: payload as any });
}

await run("setup: a published deal with a pickup address", async () => {
  const bp = await app.inject({ method: "PUT", url: "/api/seller/business-profile", headers: HS,
    payload: { business_name: "עסק P0.7C", business_id_number: "515000077", contact_name: "בודק", contact_phone: "0501234567", contact_email: `${seller}@siton.test` } });
  assert.equal(bp.statusCode, 200, bp.body);
  const created = await app.inject({ method: "POST", url: "/deals", headers: { ...HS, "idempotency-key": `p07c-${randomUUID().slice(0, 12)}` },
    payload: { title: "עסקת P0.7C", description_short: "polling", price_per_unit: 20, min_units: 5, max_units: 50,
      deadline: new Date(Date.now() + 2 * 864e5).toISOString(), deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "רח׳ הרצל 12, תל אביב", cost: 0, sort_order: 0 }] } });
  assert.equal(created.statusCode, 200, created.body);
  dealId = String((created.json() as any).deal?.deal_id || (created.json() as any).deal_id);
  const pub = await app.inject({ method: "POST", url: `/deals/${dealId}/publish`, headers: { ...HS, "idempotency-key": `p07cp-${randomUUID().slice(0, 12)}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
  assert.equal(pub.statusCode, 200, pub.body);
});

await run("bucket classification: reads on the deal prefixes → read; mutations → sensitive; seller/inquiry routes → none", async () => {
  assert.equal(rateLimitBucketFor("GET", `/api/deals/${dealId}/activity`), "read");
  assert.equal(rateLimitBucketFor("GET", `/api/deals/${dealId}/public`), "read");
  assert.equal(rateLimitBucketFor("GET", `/api/deals/${dealId}/chat?limit=100`), "read");
  assert.equal(rateLimitBucketFor("HEAD", `/api/deals/${dealId}/public`), "read");
  assert.equal(rateLimitBucketFor("POST", `/api/deals/${dealId}/inquiries`), "sensitive");
  assert.equal(rateLimitBucketFor("POST", `/api/deals/${dealId}/chat`), "sensitive");
  assert.equal(rateLimitBucketFor("POST", `/api/deals/${dealId}/chat/x/reaction`), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/otp/start"), "sensitive");
  assert.equal(rateLimitBucketFor("POST", "/api/support/contact"), "sensitive");
  assert.equal(rateLimitBucketFor("PUT", "/api/deals/anything"), "sensitive");
  assert.equal(rateLimitBucketFor("GET", `/api/seller/deals/${dealId}/preview`), "none");
  assert.equal(rateLimitBucketFor("GET", "/api/inquiries/x?t=y"), "none");
  assert.equal(rateLimitBucketFor("GET", "/api/preview/meta"), "none");
});

await run("B: three tabs' first-minute reads from ONE IP (30 GETs: public + activity + chat) never see 429", async () => {
  const clientIp = ip(1);
  const statuses: number[] = [];
  for (let tab = 0; tab < 3; tab++) {
    statuses.push((await get(`/api/deals/${dealId}/public`, clientIp)).statusCode);
    for (let i = 0; i < 6; i++) statuses.push((await get(`/api/deals/${dealId}/activity`, clientIp)).statusCode);
    for (let i = 0; i < 3; i++) statuses.push((await get(`/api/deals/${dealId}/chat?limit=100`, clientIp)).statusCode);
  }
  assert.equal(statuses.length, 30);
  assert.ok(statuses.every((s) => s === 200), `statuses: ${statuses.join(",")}`);
});

await run("read budget is still bounded: request 121 on the read prefixes → 429 rate_limit_exceeded", async () => {
  const clientIp = ip(2);
  let firstBlocked = -1;
  for (let i = 1; i <= 121; i++) {
    const res = await get(`/api/deals/${dealId}/activity`, clientIp);
    if (res.statusCode === 429) { firstBlocked = i; assert.equal((res.json() as any).error, "rate_limit_exceeded"); break; }
    assert.equal(res.statusCode, 200, `read ${i}: ${res.statusCode}`);
  }
  assert.equal(firstBlocked, 121, `read budget tripped at ${firstBlocked}`);
});

await run("E/G: sensitive mutations keep the strict bucket — 20 inquiry POSTs pass the limiter, the 21st is 429", async () => {
  const clientIp = ip(3);
  for (let i = 1; i <= 20; i++) {
    const res = await post(`/api/deals/${dealId}/inquiries`, clientIp, { name: "", email: "x", message: "" });
    assert.equal(res.statusCode, 400, `mutation ${i} should reach validation, got ${res.statusCode}`);
  }
  const blocked = await post(`/api/deals/${dealId}/inquiries`, clientIp, { name: "", email: "x", message: "" });
  assert.equal(blocked.statusCode, 429, blocked.body);
  assert.equal((blocked.json() as any).error, "rate_limit_exceeded");
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  // OTP + support share the same mutation bucket per IP
  const otpIp = ip(4);
  for (let i = 1; i <= 20; i++) await post("/api/otp/start", otpIp, { phone: "0501234567" });
  const otpBlocked = await post("/api/otp/start", otpIp, { phone: "0501234567" });
  assert.equal(otpBlocked.statusCode, 429, "OTP start still strictly limited");
  const supportIp = ip(5);
  for (let i = 1; i <= 20; i++) await post("/api/support/contact", supportIp, { website: "bot" });
  const supportBlocked = await post("/api/support/contact", supportIp, { website: "bot" });
  assert.equal(supportBlocked.statusCode, 429, "support contact still strictly limited");
});

await run("reads never consume the mutation budget: 60 reads then 20 mutations pass, the 21st mutation is 429", async () => {
  const clientIp = ip(6);
  for (let i = 0; i < 60; i++) assert.equal((await get(`/api/deals/${dealId}/activity`, clientIp)).statusCode, 200);
  for (let i = 1; i <= 20; i++) {
    const res = await post(`/api/deals/${dealId}/inquiries`, clientIp, { name: "", email: "x", message: "" });
    assert.equal(res.statusCode, 400, `mutation ${i} after reads: ${res.statusCode}`);
  }
  const blocked = await post(`/api/deals/${dealId}/inquiries`, clientIp, { name: "", email: "x", message: "" });
  assert.equal(blocked.statusCode, 429);
  // and the reads from that IP are still fine afterwards (separate budget)
  assert.equal((await get(`/api/deals/${dealId}/activity`, clientIp)).statusCode, 200);
});

await run("F: the inquiry spam limiter (5 per customer per hour) is intact", async () => {
  const clientIp = ip(7);
  const email = `spam-p07c-${randomUUID().slice(0, 6)}@siton.test`;
  let accepted = 0, limited = 0;
  for (let i = 0; i < 6; i++) {
    const res = await post(`/api/deals/${dealId}/inquiries`, clientIp, { name: "ספאם", email, message: `הודעה ${i} שונה` });
    if (res.statusCode === 201) accepted++;
    else if (res.statusCode === 429) { limited++; assert.equal((res.json() as any).code, "inquiry_rate_limited", res.body); }
    else assert.fail(`unexpected ${res.statusCode}: ${res.body}`);
  }
  assert.equal(accepted, 5);
  assert.equal(limited, 1);
});

await run("H: the public activity feed still reflects a new join immediately", async () => {
  const before = await get(`/api/deals/${dealId}/activity`, ip(8));
  assert.equal(before.statusCode, 200);
  assert.equal((before.json() as any).participants, 0);
  await pool.query(
    `INSERT INTO siton.participants (deal_id, buyer_id, buyer_name, qty, buyer_state, money_state, delivery_cost)
     VALUES ($1, $2, 'רות כהן', 2, 'JoinedAuthorized', 'AuthHeld', 0)`,
    [dealId, `p07c-buyer-${randomUUID().slice(0, 8)}`]
  );
  const after = await get(`/api/deals/${dealId}/activity`, ip(8));
  assert.equal(after.statusCode, 200);
  const body = after.json() as any;
  assert.equal(body.participants, 1);
  assert.equal(body.joined_units, 2);
  assert.equal(body.recent_joins[0].display, "רות");
  assert.equal(body.recent_joins[0].qty, 2);
});

await run("I: the Draft preview route is outside both budgets and creates nothing", async () => {
  const draft = await app.inject({ method: "POST", url: "/deals", headers: { ...HS, "idempotency-key": `p07cd-${randomUUID().slice(0, 12)}` },
    payload: { title: "טיוטה P0.7C", description_short: "draft", price_per_unit: 20, min_units: 5, max_units: 50,
      deadline: new Date(Date.now() + 2 * 864e5).toISOString(), deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "רח׳ הרצל 12, תל אביב", cost: 0, sort_order: 0 }] } });
  const draftId = String((draft.json() as any).deal?.deal_id || (draft.json() as any).deal_id);
  const clientIp = ip(9);
  for (let i = 0; i < 130; i++) {
    const res = await app.inject({ method: "GET", url: `/api/seller/deals/${draftId}/preview`, headers: { ...HS, "x-forwarded-for": clientIp } });
    assert.equal(res.statusCode, 200, `preview ${i}: ${res.statusCode}`);
  }
  const events = await pool.query(`SELECT count(*)::int AS n FROM siton.viral_events WHERE deal_id=$1`, [draftId]);
  assert.equal(events.rows[0].n, 0, "preview creates no funnel events");
  assert.equal((await get(`/api/deals/${draftId}/public`, clientIp)).statusCode, 404);
});

console.log(`\nP07C_RATE_RESULT passed=${passed} failed=${failed}`);
await pool.end().catch(() => undefined);
await app.close().catch(() => undefined);
process.exit(failed ? 1 : 0);
