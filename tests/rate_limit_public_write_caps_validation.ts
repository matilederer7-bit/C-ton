// Black-Sky C5 — anonymous public writers (support form, deal inquiries, buyer
// feedback) had only PLATFORM-WIDE hourly caps (30 / 200 / 200): one client
// could exhaust them and starve every real buyer for the hour. Proves, through
// the live routes:
//   * one client address is refused at its own hourly budget (10 / 30 / 30)
//   * a DIFFERENT client address keeps working at that moment (no starvation)
//   * the refusal keeps the existing public error codes and writes no row
//   * IPv6 clients are budgeted per /64
//   * the platform-wide and per-identity caps are untouched (unit check)
// The per-minute request limiter is lifted for this file so only the new
// per-hour caps are under test.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = "3151";
process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "100000";
process.env.RATE_LIMIT_READ_MAX = "100000";
process.env.RATE_LIMIT_SELLER_MUTATION_MAX = "100000";
process.env.RATE_LIMIT_SELLER_MUTATION_IP_MAX = "100000";
delete process.env.SUPPORT_CONTACT_PER_IP_PER_HOUR;
delete process.env.INQUIRY_PER_IP_PER_HOUR;
delete process.env.FEEDBACK_PER_IP_PER_HOUR;

const { app } = await import("../src/app.js");
const { publicWriteCapPerHour, PublicWriteCapStore } = await import("../src/public_write_caps.js");
const { INQUIRY_LIMITS } = await import("../src/seller_inquiries.js");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e: any) { console.error(`FAIL ${name}: ${e?.stack || e?.message}`); failed++; }
}

const seller = `seller-c5-${randomUUID().slice(0, 8)}`;
const H = { "x-seller-id": seller, "content-type": "application/json" };
async function publishedDeal() {
  const r = await app.inject({
    method: "POST", url: "/deals", headers: { ...H, "idempotency-key": `c5-${randomUUID().slice(0, 12)}` },
    payload: {
      title: "עסקת מגבלות", description_short: "בדיקת מגבלות", price_per_unit: 45, min_units: 5, max_units: 200,
      deadline: new Date(Date.now() + 3 * 864e5).toISOString(), deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 }]
    }
  });
  assert.ok([200, 201].includes(r.statusCode), r.body);
  const dealId = String((r.json() as any).deal_id || (r.json() as any).deal?.deal_id);
  const bp = await app.inject({ method: "PUT", url: "/api/seller/business-profile", headers: H,
    payload: { business_name: "עסק מגבלות", business_id_number: "515000003", contact_name: "בודק", contact_phone: "0501234567" } });
  assert.equal(bp.statusCode, 200, bp.body);
  const pub = await app.inject({ method: "POST", url: `/deals/${dealId}/publish`, headers: { ...H, "idempotency-key": `c5-pub-${randomUUID().slice(0, 8)}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true } });
  assert.equal(pub.statusCode, 200, pub.body);
  return dealId;
}

const dealA = await publishedDeal();
const dealB = await publishedDeal();

const support = (ip: string, i: number) => app.inject({
  method: "POST", url: "/api/support/contact", headers: { "content-type": "application/json", "x-forwarded-for": ip },
  payload: { name: "בודק קצב", email: `c5-support-${i}-${randomUUID().slice(0, 6)}@siton.test`, category: "general", message: `פנייה מספר ${i} לבדיקת מגבלה` }
});
const inquiry = (ip: string, dealId: string, i: number) => app.inject({
  method: "POST", url: `/api/deals/${dealId}/inquiries`, headers: { "content-type": "application/json", "x-forwarded-for": ip },
  payload: { name: "בודק קצב", email: `c5-inq-${i}-${randomUUID().slice(0, 6)}@siton.test`, message: `שאלה מספר ${i} ${randomUUID()}` }
});
const feedback = (ip: string, dealId: string) => app.inject({
  method: "POST", url: `/api/deals/${dealId}/feedback`, headers: { "content-type": "application/json", "x-forwarded-for": ip },
  payload: { category: "other", surface: "tracking" }
});

await run("config: per-client defaults are 10 / 30 / 30 per hour and cannot be switched off", async () => {
  assert.equal(publicWriteCapPerHour("support_contact", {}), 10);
  assert.equal(publicWriteCapPerHour("inquiry", {}), 30);
  assert.equal(publicWriteCapPerHour("feedback", {}), 30);
  assert.equal(publicWriteCapPerHour("feedback", { FEEDBACK_PER_IP_PER_HOUR: "0" } as any), 1, "0 does not disable");
  assert.equal(publicWriteCapPerHour("inquiry", { INQUIRY_PER_IP_PER_HOUR: "abc" } as any), 30);
  // the platform-wide and per-identity inquiry caps are unchanged
  assert.equal(INQUIRY_LIMITS.global_per_hour, 200);
  assert.equal(INQUIRY_LIMITS.per_customer_per_hour, 5);
  assert.equal(INQUIRY_LIMITS.per_deal_per_hour, 40);
});

await run("support form: the 11th contact from one address in the hour is 429 support_rate_limited, another address still gets 201", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await support("198.51.100.10", i)).statusCode);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(201), codes.join(","));
  const refused = await support("198.51.100.10", 99);
  assert.equal(refused.statusCode, 429);
  assert.equal((refused.json() as any).code, "support_rate_limited");
  assert.equal(codes[10], 429);
  const other = await support("198.51.100.11", 100);
  assert.equal(other.statusCode, 201, other.body);
});

await run("inquiries: the 31st inquiry from one address is 429 inquiry_rate_limited with no row; another address still gets 201", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 30; i++) codes.push((await inquiry("198.51.100.20", i < 20 ? dealA : dealB, i)).statusCode);
  assert.deepEqual(codes, Array(30).fill(201), codes.join(","));
  const before = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_inquiry_messages`);
  const refused = await inquiry("198.51.100.20", dealB, 31);
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal((refused.json() as any).code, "inquiry_rate_limited");
  const after = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_inquiry_messages`);
  assert.equal(after.rows[0].n, before.rows[0].n, "a refused inquiry writes no message");
  const other = await inquiry("198.51.100.21", dealB, 32);
  assert.equal(other.statusCode, 201, other.body);
});

await run("feedback: the 31st answer from one address is 429 feedback_rate_limited; another address still gets 201", async () => {
  for (let i = 0; i < 30; i++) {
    const r = await feedback("198.51.100.30", i % 2 ? dealA : dealB);
    assert.equal(r.statusCode, 201, r.body);
  }
  const refused = await feedback("198.51.100.30", dealA);
  assert.equal(refused.statusCode, 429);
  assert.equal((refused.json() as any).code, "feedback_rate_limited");
  assert.equal((await feedback("198.51.100.31", dealA)).statusCode, 201);
});

await run("IPv6: rotating addresses inside one /64 shares one budget", async () => {
  const store = new PublicWriteCapStore();
  for (let i = 0; i < 30; i++) assert.equal(store.consume("feedback", `2001:db8:1:2::${(i + 1).toString(16)}`, 0), true);
  assert.equal(store.consume("feedback", "2001:db8:1:2:ffff::1", 0), false);
  assert.equal(store.consume("feedback", "2001:db8:1:3::1", 0), true, "a different /64 has its own budget");
  // the window resets after an hour
  assert.equal(store.consume("feedback", "2001:db8:1:2::1", 60 * 60_000 + 1), true);
});

await app.close();
await pool.end();
if (failed) process.exit(1);
console.log("PASS per-client public write caps");
