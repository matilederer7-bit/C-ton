// SPRINT 4 (A8) — the admin virality dashboard is WINDOWED, DB-exercised.
//  * default = last 7 days; 30 / 90 / custom [from,to) / all time
//  * the window drives the ACTUAL numbers: a range that covers the joins sees
//    them, a range in the past sees zero, top deals follow the window
//  * malformed / inverted / absurd ranges are refused with a Hebrew reason
//  * the lifetime rollup is a separate, labelled block; no hidden 7-day card
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3652";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `growth-test-admin-${randomUUID().slice(0, 8)}`;
delete process.env.BUYER_VERIFY_JOIN;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });
const { app } = await import("../src/app.js");

const SELLER_ID = `growth-seller-${randomUUID().slice(0, 8)}`;
const ADMIN = { "x-admin-key": String(process.env.ADMIN_API_KEY) };
let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.stack || e}`); failed++; }
}

await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
   VALUES ($1,'מכוורת הגליל','Growth Ltd','growth@siton.local','approved','active') ON CONFLICT (seller_id) DO NOTHING`,
  [SELLER_ID]
);

async function createDeal(): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/deals",
    headers: { "x-seller-id": SELLER_ID, "idempotency-key": `growth-create-${randomUUID()}` },
    payload: {
      seller_id: SELLER_ID, title: "עסקת ויראליות", description: "growth window proof",
      price_per_unit: 50, min_units: 2, max_units: 100,
      deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0 }]
    }
  });
  assert.equal(create.statusCode, 200, create.body);
  const dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
  const publish = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: { "x-seller-id": SELLER_ID },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(publish.statusCode, 200, publish.body);
  return dealId;
}
async function join(dealId: string, buyerId: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`, headers: { "idempotency-key": `growth-join-${randomUUID()}` },
    payload: { buyer_id: buyerId, buyer_name: `קונה ${buyerId.slice(-4)}`, qty: 2, buyer_terms_accepted: true, payment_disclosure_accepted: true, ...extra }
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
}
async function growth(qs = "") {
  return app.inject({ method: "GET", url: `/api/admin/growth${qs}`, headers: ADMIN });
}

const dealId = await createDeal();
const stamp = String(Date.now()).slice(-6);
await run("fixtures: a root join, two attributed joins through the root's personal link, a share click", async () => {
  const root = await join(dealId, `0501${stamp}`);
  const code = root.viral.personal_share_code;
  assert.ok(code);
  await join(dealId, `0502${stamp}`, { affiliate_ref: code });
  await join(dealId, `0503${stamp}`, { affiliate_ref: code });
  const ev = await app.inject({ method: "POST", url: "/api/viral/events", payload: { event_type: "share_button_click", deal_id: dealId, client_event_id: `ev_${randomUUID().slice(0, 12)}`, share_channel: "whatsapp" } });
  assert.equal(ev.statusCode, 202, ev.body);
});

await run("default window = last 7 days; the windowed block sees the joins and the attributed joins; the lifetime block is separate and labelled; no hidden last_7_days card", async () => {
  const res = await growth();
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.window.kind, "days");
  assert.equal(body.window.days, 7);
  assert.ok(body.window.from && body.window.to, "window bounds are explicit UTC instants");
  assert.ok(Date.parse(body.window.to) - Date.parse(body.window.from) === 7 * 24 * 3600_000);
  assert.ok(body.windowed.joins >= 3, JSON.stringify(body.windowed));
  assert.ok(body.windowed.attributed_joins >= 2, JSON.stringify(body.windowed));
  assert.ok(body.windowed.share_button_clicks >= 1);
  assert.ok(body.windowed.personal_links >= 1);
  assert.ok(body.windowed.sharing_participants >= 1);
  assert.ok(body.windowed.max_generation >= 1);
  assert.ok(body.windowed.viral_share_of_joins > 0 && body.windowed.viral_share_of_joins <= 1);
  const top = body.windowed.top_deals.find((d: any) => d.deal_id === dealId);
  assert.ok(top && top.attributed_participants >= 2, JSON.stringify(body.windowed.top_deals));
  const seller = body.windowed.top_sellers.find((s: any) => s.seller_id === SELLER_ID);
  assert.ok(seller && seller.seller_name === "מכוורת הגליל", JSON.stringify(body.windowed.top_sellers));
  assert.equal(body.lifetime.label_he, "מצטבר מאז ההשקה (כל הזמן)");
  assert.ok(!("last_7_days" in body), "no mixed-window card");
});

await run("presets 30 / 90 change the window bounds; days=abc falls back to 7; days=99999 is clamped to the technical ceiling, not a tiny product cap", async () => {
  for (const days of [30, 90]) {
    const body = (await growth(`?days=${days}`)).json() as any;
    assert.equal(body.window.days, days);
    assert.ok(Date.parse(body.window.to) - Date.parse(body.window.from) === days * 24 * 3600_000);
    assert.ok(body.windowed.attributed_joins >= 2, `${days}d still covers today's joins`);
  }
  assert.equal(((await growth("?days=abc")).json() as any).window.days, 7);
  assert.equal(((await growth("?days=99999")).json() as any).window.days, 3650);
});

await run("custom range drives the data: a range around now sees the joins; a range in 2024 sees zero joins and no top deals", async () => {
  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date(Date.now() + 3600_000).toISOString();
  const nowBody = (await growth(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json() as any;
  assert.equal(nowBody.window.kind, "custom");
  assert.equal(nowBody.window.from, from);
  assert.equal(nowBody.window.to, to);
  assert.ok(nowBody.windowed.attributed_joins >= 2, JSON.stringify(nowBody.windowed));
  const past = (await growth(`?from=2024-01-01T00:00:00.000Z&to=2024-02-01T00:00:00.000Z`)).json() as any;
  assert.equal(past.windowed.joins, 0);
  assert.equal(past.windowed.attributed_joins, 0);
  assert.equal(past.windowed.attributed_charged_gmv, 0);
  assert.deepEqual(past.windowed.top_deals, []);
  assert.deepEqual(past.windowed.top_sellers, []);
  assert.equal(past.windowed.viral_coefficient, 0);
});

await run("refusals: inverted, malformed, before 2020, in the future — each a 400 with a Hebrew reason", async () => {
  const cases: Array<[string, string]> = [
    ["?from=2026-09-08T00:00:00Z&to=2026-09-01T00:00:00Z", "growth_range_inverted"],
    ["?from=lastweek&to=now", "growth_range_invalid"],
    ["?from=2019-06-01T00:00:00Z&to=2026-09-01T00:00:00Z", "growth_range_too_early"],
    [`?from=2026-09-01T00:00:00Z&to=${encodeURIComponent(new Date(Date.now() + 30 * 864e5).toISOString())}`, "growth_range_future"]
  ];
  for (const [qs, error] of cases) {
    const res = await growth(qs);
    assert.equal(res.statusCode, 400, `${qs} → ${res.statusCode} ${res.body}`);
    const body = res.json() as any;
    assert.equal(body.error, error);
    assert.match(String(body.message), /[֐-׿]/, "Hebrew reason");
  }
});

await run("range=all is the lifetime window (open start); the endpoint is admin-only", async () => {
  const all = (await growth("?range=all")).json() as any;
  assert.equal(all.window.kind, "all");
  assert.equal(all.window.from, null);
  assert.ok(all.windowed.attributed_joins >= 2);
  const anon = await app.inject({ method: "GET", url: "/api/admin/growth" });
  assert.ok([401, 403].includes(anon.statusCode), `anonymous got ${anon.statusCode}`);
});

await app.close().catch(() => undefined);
await pool.end();
console.log(`\nADMIN_GROWTH_WINDOW passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
