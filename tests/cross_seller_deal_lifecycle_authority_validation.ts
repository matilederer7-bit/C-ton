import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

// MUTATION-TESTING FINDING (red-team §14) — TEST BLIND SPOT, now closed.
//
// Every deal LIFECYCLE route in src/app.ts re-checks ownership after the seller
// guard:
//     if (normalizeSellerId(r.rows[0].seller_id) !== sellerAuthority.seller_id)
//         -> 404, answered exactly like a deal that does not exist
// on /deals/:id/publish, /close_joining, /prepare_charging, /charging/start and
// /cancel (plus the same rule spelled differently in /reopen_joining).
//
// Replacing ALL of those checks with `if (false)` — i.e. letting any
// authenticated seller drive any other seller's deal — left the whole
// authorization suite green, including
// cross_principal_authorization_isolation_validation and the route-authorization
// gate (122 protected routes, 752 probes). The gate proves a route is
// AUTHENTICATED; it does not prove the route checks OWNERSHIP.
//
// The cross-principal suite looked like it covered this: its case is named
// "seller A cannot mutate seller B's deal (draft, delivery, publish, delete)",
// but the probe list is draft / delivery / DUPLICATE / delete — `publish` is in
// the title only. No test anywhere drove a lifecycle route across sellers, so
// the highest-impact writes in the product (publish someone else's draft, cancel
// someone else's live deal, start charging on it) were unguarded by tests.
//
// This suite probes every lifecycle route across sellers and asserts the victim
// deal is untouched, with a vacuity guard so it cannot pass by everything
// failing for unrelated reasons.

process.env.NODE_ENV = "test";
process.env.PORT = "3187";
process.env.APP_DEPLOYMENT_MODE = "internal-runtime";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.SELLER_SESSION_SECRET = "seller-session-secret-lifecycle-isolation";
process.env.ADMIN_API_KEY = "lifecycle-isolation-admin-key";
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "admin-session-secret-lifecycle-isolation";

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

const SELLER_A = `seller-life-a-${randomUUID().slice(0, 8)}`;
const SELLER_B = `seller-life-b-${randomUUID().slice(0, 8)}`;

async function provisionSeller(sellerId: string, email: string, accessCode: string) {
  const { cookie } = await establishNamedAdminSession(app, pool);
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/seller-auth/${sellerId}/provision`,
    headers: { cookie },
    payload: { display_name: sellerId, login_email: email, access_code: accessCode, auth_enabled: true }
  });
  assert.equal(response.statusCode, 200, `provision ${sellerId} failed: ${response.body}`);
}

async function loginSeller(email: string, accessCode: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/seller/session/login",
    payload: { identifier: email, access_code: accessCode }
  });
  assert.equal(login.statusCode, 200, `seller login failed: ${login.body}`);
  const cookie = String(login.headers["set-cookie"] || "").split(";")[0] || "";
  assert.ok(cookie.includes("siton_seller_session="), "seller session cookie missing");
  return cookie;
}

async function seedDeal(sellerId: string, title: string, state: "Draft" | "PendingTarget") {
  const published = state === "PendingTarget";
  const result = await pool.query(
    `INSERT INTO siton.deals (title, price_per_unit, min_units, max_units, threshold_units, deadline, seller_id, state, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING deal_id`,
    [title, 50, 1, 20, 5, new Date(Date.now() + 3 * 60 * 60_000).toISOString(), sellerId, state, published ? new Date().toISOString() : null]
  );
  return String(result.rows[0].deal_id);
}

async function dealState(dealId: string) {
  const res = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
  return res.rowCount ? String(res.rows[0].state) : "(missing)";
}

await provisionSeller(SELLER_A, `${SELLER_A}@example.com`, "alpha-pass-lifecycle-1");
await provisionSeller(SELLER_B, `${SELLER_B}@example.com`, "beta-pass-lifecycle-1");
const cookieA = await loginSeller(`${SELLER_A}@example.com`, "alpha-pass-lifecycle-1");

const dealAOwn = await seedDeal(SELLER_A, "A own live deal", "PendingTarget");
const dealBLive = await seedDeal(SELLER_B, "B live deal", "PendingTarget");
const dealBDraft = await seedDeal(SELLER_B, "B draft deal", "Draft");

function act(dealId: string, path: string) {
  return app.inject({
    method: "POST",
    url: `/deals/${dealId}/${path}`,
    headers: { cookie: cookieA, "content-type": "application/json", "x-request-id": randomUUID() },
    payload: {}
  } as any);
}

// ── Vacuity guard ───────────────────────────────────────────────────────────
// Without this, every probe below could "pass" simply because the route is
// broken for everyone.
await run("VACUITY GUARD: seller A can drive a lifecycle route on its OWN deal", async () => {
  const response = await act(dealAOwn, "close_joining");
  assert.ok(
    response.statusCode >= 200 && response.statusCode < 300,
    `seller A could not close its own deal (${response.statusCode}): ${response.body}`
  );
  assert.equal(await dealState(dealAOwn), "ClosedForJoining", "seller A's own close did not take effect");
});

// ── The real probes ─────────────────────────────────────────────────────────
await run("seller A cannot publish seller B's draft", async () => {
  const before = await dealState(dealBDraft);
  const response = await act(dealBDraft, "publish");
  assert.ok(
    !(response.statusCode >= 200 && response.statusCode < 300),
    `seller A published seller B's draft (${response.statusCode}): ${response.body}`
  );
  assert.equal(await dealState(dealBDraft), before, "seller B's draft changed state after seller A's publish attempt");
});

for (const path of ["close_joining", "prepare_charging", "charging/start", "cancel", "reopen_joining"]) {
  await run(`seller A cannot drive /${path} on seller B's live deal`, async () => {
    const before = await dealState(dealBLive);
    const response = await act(dealBLive, path);
    assert.ok(
      !(response.statusCode >= 200 && response.statusCode < 300),
      `seller A drove /${path} on seller B's deal (${response.statusCode}): ${response.body}`
    );
    const after = await dealState(dealBLive);
    assert.equal(after, before, `seller B's deal moved ${before} -> ${after} via seller A's /${path}`);
  });
}

await run("seller B's deals are untouched at the end", async () => {
  assert.equal(await dealState(dealBLive), "PendingTarget", "seller B's live deal was moved by seller A");
  assert.equal(await dealState(dealBDraft), "Draft", "seller B's draft was moved by seller A");
});

await pool.end();
await app.close();
console.log(`SUMMARY cross_seller_deal_lifecycle passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
