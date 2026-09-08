// LAUNCH MODE — closed-web-pilot readiness, DB-exercised:
//  * migration 065: deals.list_price_per_unit + viral_events (join_failed,
//    inquiry_started, detail) exist and are constrained
//  * regular ("normal") price: accepted only ABOVE the group price; carried by
//    the public deal payload, the seller Draft editor and the mall read model;
//    a Draft edit that makes a stored anchor invalid drops it instead of 500
//  * funnel: join_failed / inquiry_started are recorded (PII-free, bounded
//    detail) and surface in the seller funnel
//  * owner pilot metrics endpoint: guarded, aggregate, answers the pilot
//    questions (sellers in / created / published / repeat; buyers viewed /
//    tried / joined / conversion; inquiries)
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `pilot-test-admin-${randomUUID().slice(0, 8)}`;

const { app } = await import("../src/app.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton",
  max: 4
});

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const seller = `seller-pilot-${randomUUID().slice(0, 8)}`;
const H = { "x-seller-id": seller, "content-type": "application/json" };
const ADMIN = { "x-admin-key": String(process.env.ADMIN_API_KEY) };
const deadline = () => new Date(Date.now() + 3 * 864e5).toISOString();

async function createDeal(extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST", url: "/deals", headers: { ...H, "idempotency-key": `pilot-${randomUUID().slice(0, 12)}` },
    payload: {
      title: "מארז דבש פיילוט", description_short: "דבש פרחי בר", price_per_unit: 45, min_units: 5, max_units: 20,
      deadline: deadline(), deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 }],
      ...extra
    }
  });
}

await run("root routing: bare domain → /preview/ (React pilot product); /d/:id share route still lands on the React deal page; /app still answers", async () => {
  const root = await app.inject({ method: "GET", url: "/" });
  assert.equal(root.statusCode, 302, root.body);
  assert.equal(root.headers.location, "/preview/");
  const rootQuery = await app.inject({ method: "GET", url: "/?utm_source=whatsapp" });
  assert.equal(rootQuery.statusCode, 302);
  assert.equal(rootQuery.headers.location, "/preview/");
  const legacy = await app.inject({ method: "GET", url: "/app" });
  assert.notEqual(legacy.statusCode, 404, "legacy /app must remain reachable for direct links");
  // share route: a human browser must be forwarded INTO the React deal page, never the legacy app
  const share = await app.inject({ method: "GET", url: `/d/${randomUUID()}`, headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } });
  assert.ok([200, 302, 404].includes(share.statusCode), `share route ${share.statusCode}`);
  const target = share.statusCode === 302 ? String(share.headers.location || "") : share.body;
  assert.ok(!/\/app\b/.test(target.slice(0, 4000)) || /preview\/#\/deal/.test(target), `share route points at the legacy app: ${target.slice(0, 200)}`);
});

await run("migration 065: columns + constraints present", async () => {
  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema='siton' AND ((table_name='deals' AND column_name='list_price_per_unit') OR (table_name='viral_events' AND column_name='detail'))`
  );
  assert.equal(cols.rowCount, 2, JSON.stringify(cols.rows));
  const check = await pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='viral_events_event_type_check'`);
  assert.ok(String(check.rows[0]?.def || "").includes("join_failed") && String(check.rows[0]?.def).includes("inquiry_started"), check.rows[0]?.def);
  await assert.rejects(
    pool.query(`INSERT INTO siton.deals (deal_id, title, price_per_unit, list_price_per_unit, min_units, max_units, threshold_units, deadline)
                VALUES ($1, 'x', 10, 0, 1, 2, 1, now() + interval '1 day')`, [randomUUID()]),
    /deals_list_price_per_unit_check/
  );
});

let dealId = "";
await run("regular price: rejected when not above the group price; accepted when it is", async () => {
  const bad = await createDeal({ list_price_per_unit: 45 });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal((bad.json() as any).code, "list_price_invalid");
  const bad2 = await createDeal({ list_price_per_unit: "abc" });
  assert.equal(bad2.statusCode, 400, bad2.body);
  const ok = await createDeal({ list_price_per_unit: 65 });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json() as any;
  dealId = String(body.deal?.deal_id || body.deal_id);
  const row = await pool.query(`SELECT list_price_per_unit FROM siton.deals WHERE deal_id=$1`, [dealId]);
  assert.equal(Number(row.rows[0].list_price_per_unit), 65);
  const none = await createDeal({});
  assert.equal(none.statusCode, 200, none.body);
  const noneId = String((none.json() as any).deal?.deal_id || (none.json() as any).deal_id);
  const noneRow = await pool.query(`SELECT list_price_per_unit FROM siton.deals WHERE deal_id=$1`, [noneId]);
  assert.equal(noneRow.rows[0].list_price_per_unit, null);
});

await run("regular price: Draft editor round-trips it; raising the group price above a stored anchor drops the anchor (no 500)", async () => {
  const draft = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/draft`, headers: H });
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(Number((draft.json() as any).draft.list_price_per_unit), 65);
  const clear = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: H, payload: { list_price_per_unit: null } });
  assert.equal(clear.statusCode, 200, clear.body);
  assert.equal((clear.json() as any).draft.list_price_per_unit, null);
  const set = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: H, payload: { list_price_per_unit: 60 } });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(Number((set.json() as any).draft.list_price_per_unit), 60);
  const below = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: H, payload: { list_price_per_unit: 45 } });
  assert.equal(below.statusCode, 400, below.body);
  // price raised ABOVE the stored anchor without touching the anchor → anchor dropped, edit succeeds
  const raise = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: H, payload: { price_per_unit: 70 } });
  assert.equal(raise.statusCode, 200, raise.body);
  assert.equal((raise.json() as any).draft.list_price_per_unit, null);
  const restore = await app.inject({ method: "PATCH", url: `/api/seller/deals/${dealId}/draft`, headers: H, payload: { price_per_unit: 45, list_price_per_unit: 65 } });
  assert.equal(restore.statusCode, 200, restore.body);
});

await run("regular price: public deal payload + mall read model carry it after publish", async () => {
  const bp = await app.inject({
    method: "PUT", url: "/api/seller/business-profile", headers: H,
    payload: { business_name: "עסק פיילוט", business_id_number: "515000002", contact_name: "בודק", contact_phone: "0501234567" }
  });
  assert.equal(bp.statusCode, 200, bp.body);
  const pub = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: { ...H, "idempotency-key": `pilot-pub-${randomUUID().slice(0, 8)}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(pub.statusCode, 200, pub.body);
  const pubDeal = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(pubDeal.statusCode, 200, pubDeal.body);
  const d = (pubDeal.json() as any).deal;
  assert.equal(Number(d.price_per_unit), 45);
  assert.equal(Number(d.list_price_per_unit), 65);
  const mall = await app.inject({ method: "GET", url: `/api/mall/deals?sort=newest` });
  assert.equal(mall.statusCode, 200, mall.body);
  const card = ((mall.json() as any).deals || []).find((x: any) => x.deal_id === dealId);
  assert.ok(card, "published deal missing from mall");
  assert.equal(Number(card.list_price_per_unit), 65);
  const sellerView = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}`, headers: H });
  assert.equal(sellerView.statusCode, 200, sellerView.body);
  assert.equal(Number((sellerView.json() as any).deal.list_price_per_unit), 65);
});

await run("funnel: join_failed + inquiry_started are recorded with bounded detail; unknown types refused", async () => {
  const visitor = `v-${randomUUID().slice(0, 12)}`;
  const post = (event_type: string, extra: Record<string, unknown> = {}) => app.inject({
    method: "POST", url: "/api/viral/events",
    payload: { event_type, deal_id: dealId, visitor_id: visitor, session_id: `s-${visitor}`, client_event_id: `ev_${randomUUID().replace(/-/g, "")}`, ...extra }
  });
  const jf = await post("join_failed", { detail: "payment_disclosure_required" });
  assert.equal(jf.statusCode, 202, jf.body);
  assert.equal((jf.json() as any).recorded, true);
  const long = await post("join_failed", { detail: "x".repeat(500) });
  assert.equal(long.statusCode, 202, long.body);
  const is = await post("inquiry_started");
  assert.equal(is.statusCode, 202, is.body);
  const unknown = await post("checkout_completed");
  assert.equal(unknown.statusCode, 400, unknown.body);
  const rows = await pool.query(
    `SELECT event_type, detail FROM siton.viral_events WHERE deal_id=$1 AND visitor_id=$2 ORDER BY created_at`, [dealId, visitor]
  );
  assert.deepEqual(rows.rows.map((r: any) => r.event_type), ["join_failed", "join_failed", "inquiry_started"]);
  assert.equal(rows.rows[0].detail, "payment_disclosure_required");
  assert.equal(String(rows.rows[1].detail).length, 120);
  assert.equal(rows.rows[2].detail, null);
});

await run("seller funnel exposes join_failures and inquiry_starts", async () => {
  const res = await app.inject({ method: "GET", url: `/api/seller/analytics?period=all&deal_id=${dealId}`, headers: H });
  assert.equal(res.statusCode, 200, res.body);
  const f = (res.json() as any).funnel;
  assert.equal(f.join_failures, 2);
  assert.equal(f.inquiry_starts, 1);
});

await run("pilot metrics: anonymous refused; owner key answers the pilot questions", async () => {
  const anon = await app.inject({ method: "GET", url: "/api/admin/pilot-metrics" });
  assert.ok([401, 403].includes(anon.statusCode), `anonymous got ${anon.statusCode}`);
  // one synthetic join so buyers.joins is non-zero
  const pubDeal = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  const option = (pubDeal.json() as any).deal.delivery_options[0];
  const join = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`, headers: { "content-type": "application/json", "idempotency-key": `pilot-join-${randomUUID().slice(0, 8)}` },
    payload: { buyer_id: "0501112233", buyer_name: "קונה", qty: 1, delivery_option_id: option.option_id, buyer_terms_accepted: true, payment_disclosure_accepted: true }
  });
  assert.ok([200, 201].includes(join.statusCode), join.body);
  const inq = await app.inject({ method: "POST", url: `/api/deals/${dealId}/inquiries`, payload: { name: "שואל", email: "asker@siton.test", message: "שאלה לבדיקה" } });
  assert.equal(inq.statusCode, 201, inq.body);

  const res = await app.inject({ method: "GET", url: "/api/admin/pilot-metrics?days=7", headers: ADMIN });
  assert.equal(res.statusCode, 200, res.body);
  const m = res.json() as any;
  assert.equal(m.window_days, 7);
  for (const key of ["sellers", "deals", "buyers", "inquiries", "per_seller"]) assert.ok(key in m, `missing ${key}`);
  assert.ok(m.sellers.created_a_deal >= 1 && m.sellers.published_a_deal >= 1, JSON.stringify(m.sellers));
  assert.ok(m.deals.drafts_created >= 2 && m.deals.published >= 1, JSON.stringify(m.deals));
  assert.ok(m.buyers.join_failures >= 2 && m.buyers.inquiry_starts >= 1 && m.buyers.joins >= 1, JSON.stringify(m.buyers));
  assert.ok(m.inquiries.threads >= 1, JSON.stringify(m.inquiries));
  const mine = m.per_seller.find((r: any) => r.seller_id === seller);
  assert.ok(mine && mine.published === 1 && mine.drafts === 2, JSON.stringify(mine));
  const clamp = await app.inject({ method: "GET", url: "/api/admin/pilot-metrics?days=9999", headers: ADMIN });
  assert.equal((clamp.json() as any).window_days, 365);
});

await run("pause → reopen → pause again (no client idempotency key) acts every time; an explicit key still replays", async () => {
  const state = async () => String(((await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` })).json() as any).deal.state);
  const pause = (headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `/deals/${dealId}/close_joining`, headers: { ...H, ...headers }, payload: {} });
  const reopen = () => app.inject({ method: "POST", url: `/deals/${dealId}/reopen_joining`, headers: H, payload: {} });
  assert.ok(["PendingTarget", "TargetReached"].includes(await state()), `precondition: deal open, got ${await state()}`);
  const p1 = await pause(); assert.equal(p1.statusCode, 200, p1.body);
  assert.equal(await state(), "ClosedForJoining");
  const r1 = await reopen(); assert.equal(r1.statusCode, 200, r1.body);
  assert.ok(["PendingTarget", "TargetReached"].includes(await state()), "reopen failed");
  const p2 = await pause(); assert.equal(p2.statusCode, 200, p2.body);
  assert.equal(await state(), "ClosedForJoining", "second header-less pause must close the deal again (was replayed as a no-op before)");
  const r2 = await reopen(); assert.equal(r2.statusCode, 200, r2.body);
  // explicit key: first call acts, the exact same key replays without touching state
  const key = `pilot-close-${randomUUID()}`;
  const p3 = await pause({ "idempotency-key": key }); assert.equal(p3.statusCode, 200, p3.body);
  assert.equal(await state(), "ClosedForJoining");
  const r3 = await reopen(); assert.equal(r3.statusCode, 200, r3.body);
  const p4 = await pause({ "idempotency-key": key }); assert.equal(p4.statusCode, 200, p4.body);
  assert.ok(["PendingTarget", "TargetReached"].includes(await state()), "same explicit key must replay, not act");
});

await run("admin sellers list carries verification_status (who is waiting for approval)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/admin/r6/sellers", headers: ADMIN });
  assert.equal(res.statusCode, 200, res.body);
  const mine = ((res.json() as any).sellers || []).find((r: any) => r.seller_id === seller);
  assert.ok(mine, "seller missing from admin list");
  assert.ok(["pending", "approved", "rejected"].includes(String(mine.verification_status)), String(mine.verification_status));
});

await pool.end();
await app.close();
console.log(`\nPILOT_READINESS passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
