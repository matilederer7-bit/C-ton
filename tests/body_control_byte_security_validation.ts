// CONTROL BYTES IN REQUEST BODIES — a caller's bytes never become a 500.
//
// Independent review LOW-3: a NUL byte inside a JSON string reached PostgreSQL
// (`invalid byte sequence for encoding "UTF8": 0x00`) and surfaced as 500 on
// POST /deals and the draft patch. V5 had closed the same class for the QUERY
// STRING only. A caller-chosen byte that is guaranteed to fail downstream must be
// refused at the entry point with a bounded, deterministic 4xx.
//
// Also pinned here (LOW-2): the NUL rejection for query parameters used to run
// before the request-id / security-header / no-store / rate-limit hooks, so the
// rejection went out without the standard safe envelope. It must carry it.
//
// Two edges are asserted so the fix cannot overreach:
//   - legitimate Unicode (Hebrew, RTL marks, emoji, combining marks) is accepted
//   - other C0 control bytes never fault either (accepted-and-scrubbed or 4xx,
//     never 500), without demanding a rejection the product never promised
//
// No money, no provider, no e-mail.

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

process.env.NODE_ENV = "test";
process.env.PORT = "3143";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
// A real (generous) limiter so the envelope test can prove the rejection is
// counted; everything else in this file stays far below it.
process.env.RATE_LIMIT_MAX = "400";
process.env.RATE_LIMIT_SENSITIVE_MAX = "0";
process.env.RATE_LIMIT_READ_MAX = "0";
process.env.RATE_LIMIT_WINDOW_MS = "600000";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-ctrl";
process.env.ADMIN_SESSION_SECRET = "admin-session-secret-ctrl";
process.env.ADMIN_API_KEY = "ctrl-admin-key";

const { app } = await import("../src/app.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
await app.ready();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 5
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${(error as any)?.message || error}`); }
}

const NUL = "\u0000";
const INTERNAL_DETAIL = [/invalid byte sequence/i, /\bat [A-Za-z0-9_$.]+ \(.*:\d+:\d+\)/, /node_modules/, /\bpostgres(?:ql)?:\/\//i];

const SELLER = `seller-ctrl-${randomUUID().slice(0, 8)}`;
const SELLER_EMAIL = `${SELLER}@siton.test`;
const SELLER_CODE = "ControlBytePass123!";
const { cookie: adminCookie } = await establishNamedAdminSession(app, pool);
assert.equal(
  (await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${SELLER}/provision`,
    headers: { cookie: adminCookie },
    payload: { display_name: SELLER, login_email: SELLER_EMAIL, access_code: SELLER_CODE, auth_enabled: true }
  } as any)).statusCode,
  200,
  "seller provisioning failed"
);
const login = await app.inject({ method: "POST", url: "/api/seller/session/login", payload: { identifier: SELLER_EMAIL, access_code: SELLER_CODE } } as any);
assert.equal(login.statusCode, 200, login.body);
const cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";
const headers = () => ({ cookie, "content-type": "application/json", "x-request-id": randomUUID() });

function dealBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "control byte probe",
    description: "probe",
    price_per_unit: 50,
    min_units: 1,
    max_units: 20,
    threshold_units: 5,
    deadline: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
    seller_terms_accepted: true,
    ...overrides
  };
}

async function draft() {
  const result = await pool.query(
    `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state)
     VALUES ($1,50,1,20,5,$2,$3,'Draft') RETURNING deal_id`,
    [`Ctrl ${randomUUID().slice(0, 8)}`, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), SELLER]
  );
  return String(result.rows[0].deal_id);
}

async function thread(dealId: string) {
  const result = await pool.query(
    `INSERT INTO siton.seller_inquiry_threads (deal_id, seller_id, customer_name, customer_email, customer_ref, customer_access_token_hash, last_message_preview)
     VALUES ($1,$2,'Ctrl Customer',$3,$4,$5,'probe') RETURNING thread_id`,
    [dealId, SELLER, `ctrl-${randomUUID().slice(0, 8)}@siton.test`, randomUUID(), randomUUID().replace(/-/g, "")]
  );
  return String(result.rows[0].thread_id);
}

function assertBounded(label: string, response: any) {
  assert.ok(response.statusCode >= 400 && response.statusCode < 500, `${label}: expected a bounded 4xx, got ${response.statusCode} ${response.body.slice(0, 200)}`);
  for (const pattern of INTERNAL_DETAIL) assert.ok(!pattern.test(response.body || ""), `${label}: the error body describes the server: ${response.body.slice(0, 200)}`);
}

await run("VACUITY GUARD: the same bodies without the byte are accepted", async () => {
  const created = await app.inject({ method: "POST", url: "/deals", headers: headers(), payload: dealBody({ title: "clean title" }) } as any);
  assert.ok(created.statusCode >= 200 && created.statusCode < 300, `clean create failed: ${created.statusCode} ${created.body}`);
});

await run("a NUL byte in a top-level JSON string is a bounded 4xx on every seller mutation, never a 500", async () => {
  const dealId = await draft();
  const threadId = await thread(dealId);
  const targets: Array<[string, string, unknown]> = [
    ["POST /deals title", "/deals", dealBody({ title: `nul${NUL}title` })],
    ["POST /deals description", "/deals", dealBody({ description: `x${NUL}y` })],
    [`PATCH draft title`, `/api/seller/deals/${dealId}/draft`, { title: `nul${NUL}title` }],
    [`PATCH draft description`, `/api/seller/deals/${dealId}/draft`, { description: `nul${NUL}desc` }],
    [`PUT delivery label`, `/api/seller/deals/${dealId}/delivery`, { delivery_options: [{ option_type: "pickup", label: `רחוב${NUL}1, חיפה`, cost: 0 }] }],
    [`POST inquiry reply`, `/api/seller/inquiries/${threadId}/reply`, { message: `hello${NUL}there` }],
    [`POST image filename`, `/api/seller/deals/${dealId}/images`, { image_data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", original_filename: `a${NUL}b.png` }]
  ];
  for (const [label, url, payload] of targets) {
    const method = url === "/deals" ? "POST" : url.endsWith("/draft") ? "PATCH" : url.endsWith("/delivery") ? "PUT" : "POST";
    const response = await app.inject({ method, url, headers: headers(), payload } as any);
    assertBounded(label, response);
  }
  const survived = await pool.query(`SELECT COUNT(*)::int AS n FROM siton.deals WHERE title LIKE 'nul%title'`);
  assert.equal(survived.rows[0].n, 0, "a NUL-bearing title was persisted");
});

await run("a NUL byte nested in objects, arrays and object KEYS is refused the same way", async () => {
  const dealId = await draft();
  const shapes: Array<[string, unknown]> = [
    ["nested object", dealBody({ voucher_terms: { redemption: { note: `x${NUL}y` } } })],
    ["array element", dealBody({ delivery_options: [{ option_type: "pickup", label: "ok", cost: 0 }, { option_type: "pickup", label: `bad${NUL}`, cost: 0 }] })],
    ["object key", JSON.parse(`{"title":"k","description":"d","price_per_unit":50,"min_units":1,"max_units":20,"threshold_units":5,"deadline":"${new Date(Date.now() + 3 * 3600e3).toISOString()}","seller_terms_accepted":true,"ke\\u0000y":"v"}`)],
    ["deep array", dealBody({ meta: [[[[`deep${NUL}`]]]] })]
  ];
  for (const [label, payload] of shapes) {
    const response = await app.inject({ method: "POST", url: "/deals", headers: headers(), payload } as any);
    assertBounded(`POST /deals ${label}`, response);
  }
  const patched = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: headers(), payload: { title: "ok", voucher_terms: { a: [{ b: `c${NUL}` }] } } } as any);
  assertBounded("PATCH draft nested", patched);
});

await run("other C0 control bytes never fault: accepted-and-scrubbed or refused, never 500", async () => {
  const faults: string[] = [];
  for (const byte of ["\u0001","\u0002","\u0007","\u0008","\u000b","\u000c","\u001b","\u001f"]) {
    const response = await app.inject({ method: "POST", url: "/deals", headers: headers(), payload: dealBody({ title: `ctl${byte}title` }) } as any);
    if (response.statusCode >= 500) faults.push(`U+${byte.charCodeAt(0).toString(16).padStart(4, "0")} -> ${response.statusCode}`);
    for (const pattern of INTERNAL_DETAIL) if (pattern.test(response.body || "")) faults.push(`U+${byte.charCodeAt(0).toString(16)} leaked detail`);
  }
  assert.deepEqual(faults, [], "control bytes produced server faults");
});

await run("legitimate Unicode is not collateral damage", async () => {
  const titles = ["עסקה משתלמת בחיפה", "مرحبا بالعالم", "日本語のタイトル", "Café crème – naïve façade", "emoji 🎉🛒 title", "rtl ‏ mark ‎", "combining é marks"];
  for (const title of titles) {
    const response = await app.inject({ method: "POST", url: "/deals", headers: headers(), payload: dealBody({ title }) } as any);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `legitimate title refused: ${JSON.stringify(title)} -> ${response.statusCode} ${response.body.slice(0, 120)}`);
  }
});

await run("a NUL in the query string is rejected WITH the standard safe envelope", async () => {
  const response = await app.inject({ method: "GET", url: "/api/seller/deals?state=%00", headers: { cookie } } as any);
  assert.equal(response.statusCode, 400, response.body);
  assert.match(String(response.headers["x-request-id"] || ""), /^[A-Za-z0-9._:-]{8,160}$/, "no canonical request id on the rejection");
  assert.equal(response.headers["x-content-type-options"], "nosniff", "nosniff missing on the rejection");
  assert.equal(response.headers["x-frame-options"], "DENY", "frame protection missing on the rejection");
  assert.match(String(response.headers["cache-control"] || ""), /no-store/, "no-store missing on the rejection");
});

await run("a NUL-query rejection is counted by the rate limiter (cheap rejection, still accounted)", async () => {
  // Rejections that bypass the limiter are free requests. RATE_LIMIT_MAX=400 for
  // this process; hammer well past it with NUL-bearing queries and expect 429.
  let throttled = 0;
  for (let index = 0; index < 450; index += 1) {
    const response = await app.inject({ method: "GET", url: `/health?x=%00&i=${index}`, remoteAddress: "10.99.0.7" } as any);
    if (response.statusCode === 429) { throttled += 1; break; }
    assert.ok(response.statusCode === 400, `unexpected ${response.statusCode} on iteration ${index}`);
  }
  assert.ok(throttled > 0, "450 NUL-query rejections were never rate-limited - the rejection runs before accounting");
});

console.log(`SUMMARY passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
await app.close().catch(() => undefined);
await pool.end().catch(() => undefined);
