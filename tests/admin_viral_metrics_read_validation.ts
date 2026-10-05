// Admin viral metrics reads — DB-exercised success-path proof for
// GET /api/admin/deals/:dealId/viral and GET /api/admin/sellers/:sellerId/viral.
// Until this test, both routes only had an authorization probe. It documents
// the EXISTING behaviour (nothing in the routes was changed for it):
//  * an authorised admin (named session cookie, or the ops x-admin-key) gets 200
//  * the payload is the canonical viral metrics cache, i.e. exactly what the
//    viral engine (recomputeDealViralMetrics / recomputeAggregateViralMetrics)
//    wrote for that scope — never a re-computation and never another scope
//  * deal and seller scoping hold: deal A answers A's metrics (A's seller, A's
//    participants), deal B answers B's; seller S1 answers S1's rollup only
//  * the response shape is { ok, deal_id | seller_id, metrics, computed_at, stale }
//  * a scope with no cache row answers 200 with metrics null and stale true
//  * the admin read guard cannot be bypassed: no credentials, a wrong key, a
//    forged session cookie, a seller identity or an x-admin-user header alone
//    are all 401 with no metrics in the body, and the guard runs before the
//    uuid check (authorization precedes observation)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.ADMIN_API_KEY = "admin-viral-read-key";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.APP_DEPLOYMENT_MODE = "demo-preview";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton"
});

const { app } = await import("../src/app.js");
const { recomputeDealViralMetrics, recomputeAggregateViralMetrics } = await import("../src/viral_graph.js");
const { establishNamedAdminSession } = await import("./helpers/named_admin_session.js");
const { cookie: ADMIN_COOKIE } = await establishNamedAdminSession(app, pool);

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const KEY_HEADERS = { "x-admin-key": "admin-viral-read-key" };
const SESSION_HEADERS = { cookie: ADMIN_COOKIE };

const suffix = randomUUID().slice(0, 8);
const SELLER_1 = `seller-avr1-${suffix}`;
const SELLER_2 = `seller-avr2-${suffix}`;

async function seedDeal(sellerId: string, title: string, participants: Array<{ name: string; qty: number }>) {
  const dealId = randomUUID();
  await pool.query(
    `INSERT INTO siton.deals
       (deal_id, title, price_per_unit, min_units, max_units, threshold_units, deadline, state, seller_id, published_at)
     VALUES ($1,$2,10,5,50,5,$3,'PendingTarget',$4,now())`,
    [dealId, title, new Date(Date.now() + 3 * 864e5).toISOString(), sellerId]
  );
  for (const p of participants) {
    await pool.query(
      `INSERT INTO siton.participants (deal_id, buyer_id, buyer_name, qty, buyer_state, money_state, delivery_cost)
       VALUES ($1, $2, $3, $4, 'JoinedAuthorized', 'AuthHeld', 0)`,
      [dealId, `avr-buyer-${p.name}-${suffix}`, p.name, p.qty]
    );
  }
  return dealId;
}

const dealA = await seedDeal(SELLER_1, `עסקת קריאה א ${suffix}`, [{ name: "Alef", qty: 1 }, { name: "Bet", qty: 2 }, { name: "Gimel", qty: 3 }]);
const dealB = await seedDeal(SELLER_2, `עסקת קריאה ב ${suffix}`, [{ name: "Dalet", qty: 4 }]);
// The canonical engine fills the cache the routes read. The seller / platform
// rollup (recomputeAggregateViralMetrics) folds at most 2000 deal cache rows
// in no particular order; the group runner gives every test a fresh database,
// so this precondition only trips on a long-lived local database — it names
// the cause instead of failing as an unexplained count mismatch.
const dealCacheRows = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM siton.viral_metrics_cache WHERE scope_type='deal'`)).rows[0].n);
assert.ok(dealCacheRows <= 1998, `precondition: the rollup reads at most 2000 deal cache rows and this database already holds ${dealCacheRows}; run through scripts/run_test_group.cjs (fresh database)`);
await recomputeDealViralMetrics(pool, dealA);
await recomputeDealViralMetrics(pool, dealB);
await recomputeAggregateViralMetrics(pool, SELLER_1);
await recomputeAggregateViralMetrics(pool, SELLER_2);

async function cacheRow(scopeType: string, scopeId: string) {
  const r = await pool.query(
    `SELECT metrics, computed_at FROM siton.viral_metrics_cache WHERE scope_type=$1 AND scope_id=$2`,
    [scopeType, scopeId]
  );
  assert.equal(r.rowCount, 1, `one cache row for ${scopeType}:${scopeId}`);
  return r.rows[0];
}

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

await run("deal viral: an authorised admin gets 200 with exactly { ok, deal_id, metrics, computed_at, stale }", async () => {
  for (const headers of [KEY_HEADERS, SESSION_HEADERS]) {
    const res = await get(`/api/admin/deals/${dealA}/viral`, headers);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ["computed_at", "deal_id", "metrics", "ok", "stale"]);
    assert.equal(body.ok, true);
    assert.equal(body.deal_id, dealA);
    assert.equal(body.stale, false, "freshly computed metrics are not stale");
    assert.ok(!Number.isNaN(Date.parse(body.computed_at)), "computed_at is an ISO instant");
  }
});

await run("deal viral: the payload is the viral engine's cache row for that deal, verbatim", async () => {
  const body = (await get(`/api/admin/deals/${dealA}/viral`, KEY_HEADERS)).json();
  const row = await cacheRow("deal", dealA);
  const metrics = typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics;
  assert.deepEqual(body.metrics, metrics, "metrics come from siton.viral_metrics_cache");
  assert.equal(body.computed_at, new Date(String(row.computed_at)).toISOString(), "computed_at is the cache row's");
  // and the cache row is the engine's view of deal A's real participants
  assert.equal(body.metrics.deal_id, dealA);
  assert.equal(body.metrics.seller_id, SELLER_1);
  assert.equal(body.metrics.totals.participants, 3);
  assert.equal(body.metrics.totals.units_joined, 6);
});

await run("deal viral: scoping — deal B answers B's metrics only, never A's", async () => {
  const a = (await get(`/api/admin/deals/${dealA}/viral`, KEY_HEADERS)).json();
  const b = (await get(`/api/admin/deals/${dealB}/viral`, KEY_HEADERS)).json();
  assert.equal(b.deal_id, dealB);
  assert.equal(b.metrics.deal_id, dealB);
  assert.equal(b.metrics.seller_id, SELLER_2);
  assert.equal(b.metrics.totals.participants, 1);
  assert.equal(b.metrics.totals.units_joined, 4);
  assert.notDeepEqual(a.metrics, b.metrics);
});

await run("deal viral: a deal with no cache row answers 200 with metrics null and stale true", async () => {
  const unknown = randomUUID();
  const res = await get(`/api/admin/deals/${unknown}/viral`, KEY_HEADERS);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, deal_id: unknown, metrics: null, computed_at: null, stale: true });
});

await run("deal viral: a malformed id is a 400 for an admin (uuid validation kept)", async () => {
  const res = await get(`/api/admin/deals/not-a-uuid/viral`, KEY_HEADERS);
  assert.equal(res.statusCode, 400, res.body);
  assert.doesNotMatch(res.body, /"metrics"/);
});

const DENIED: Array<[string, Record<string, string>]> = [
  ["no credentials", {}],
  ["a wrong x-admin-key", { "x-admin-key": "not-the-key" }],
  ["a forged admin session cookie", { cookie: "siton_admin_session=forged-session-token" }],
  ["a seller identity", { "x-seller-id": SELLER_1 }],
  ["an x-admin-user header alone", { "x-admin-user": "owner" }]
];

await run("deal viral: the admin read guard cannot be bypassed, and runs before the uuid check", async () => {
  for (const [label, headers] of DENIED) {
    for (const id of [dealA, "not-a-uuid"]) {
      const res = await get(`/api/admin/deals/${id}/viral`, headers);
      assert.equal(res.statusCode, 401, `${label} (${id}): ${res.body}`);
      assert.doesNotMatch(res.body, /"metrics"|totals|seller_id/, `${label}: no data in the denial`);
    }
  }
});

await run("seller viral: an authorised admin gets 200 with exactly { ok, seller_id, metrics, computed_at, stale }, from the seller cache row", async () => {
  for (const headers of [KEY_HEADERS, SESSION_HEADERS]) {
    const res = await get(`/api/admin/sellers/${encodeURIComponent(SELLER_1)}/viral`, headers);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ["computed_at", "metrics", "ok", "seller_id", "stale"]);
    assert.equal(body.ok, true);
    assert.equal(body.seller_id, SELLER_1);
    assert.equal(body.stale, false);
    const row = await cacheRow("seller", SELLER_1);
    assert.deepEqual(body.metrics, typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics);
    assert.equal(body.metrics.seller_id, SELLER_1);
    assert.ok(body.metrics.top_deals.some((d: any) => d.deal_id === dealA), "the seeded deal is in the rollup");
    assert.equal(body.metrics.deals, 1, "seller 1 rolls up exactly its one deal");
    assert.equal(body.metrics.participants, 3);
    assert.ok(body.metrics.top_deals.every((d: any) => d.seller_id === SELLER_1), "only the seller's own deals");
  }
});

await run("seller viral: scoping — seller 2 answers its own rollup only", async () => {
  const body = (await get(`/api/admin/sellers/${encodeURIComponent(SELLER_2)}/viral`, KEY_HEADERS)).json();
  assert.equal(body.seller_id, SELLER_2);
  assert.equal(body.metrics.seller_id, SELLER_2);
  assert.ok(body.metrics.top_deals.some((d: any) => d.deal_id === dealB), "the seeded deal is in the rollup");
  assert.equal(body.metrics.deals, 1);
  assert.equal(body.metrics.participants, 1);
  assert.ok(!JSON.stringify(body.metrics).includes(dealA), "deal A never appears in seller 2's rollup");
});

await run("seller viral: an unknown seller answers 200 with metrics null; a routable 100-character id is echoed verbatim", async () => {
  const unknown = `seller-unknown-${suffix}`;
  const res = await get(`/api/admin/sellers/${unknown}/viral`, KEY_HEADERS);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, seller_id: unknown, metrics: null, computed_at: null, stale: true });
  const long = "s".repeat(100);
  const echoed = await get(`/api/admin/sellers/${long}/viral`, KEY_HEADERS);
  assert.equal(echoed.statusCode, 200, echoed.body);
  assert.equal(echoed.json().seller_id, long);
});

await run("seller viral: the admin read guard cannot be bypassed", async () => {
  for (const [label, headers] of DENIED) {
    const res = await get(`/api/admin/sellers/${encodeURIComponent(SELLER_1)}/viral`, headers);
    assert.equal(res.statusCode, 401, `${label}: ${res.body}`);
    assert.doesNotMatch(res.body, /"metrics"|participants/, `${label}: no data in the denial`);
  }
});

await app.close();
await pool.end();
console.log(`admin_viral_metrics_read_validation passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
