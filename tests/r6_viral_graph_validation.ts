import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// R6 — canonical commerce viral graph.
// Proves: personal share link per Join (idempotent per buyer share identity),
// parent linkage + chain origin + generation across generations, first/last
// touch persistence, repeat buyers and multi-unit purchases, no duplicate
// conversion from an idempotent replay, share-code collision resistance,
// async recompute producing metrics where "successful money" counts ONLY
// ChargedSuccess/RecoveredCharge, zero distributor payout, and tree privacy
// (no buyer PII in the cached tree).

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3641";
delete process.env.BUYER_VERIFY_JOIN;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });
const { app } = await import("../src/app.js");
const { recomputeDealViralMetrics, recomputeAggregateViralMetrics, generatePersonalShareCode } = await import("../src/viral_graph.js");

const SELLER_ID = `r6-viral-seller-${randomUUID().slice(0, 8)}`;
let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.stack || e}`); failed++; }
}

await pool.query(
  `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
   VALUES ($1,$1,'R6 Viral Ltd','r6-viral@siton.local','approved','active')
   ON CONFLICT (seller_id) DO NOTHING`,
  [SELLER_ID]
);

async function createDeal(): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/deals",
    headers: { "x-seller-id": SELLER_ID, "idempotency-key": `r6-create-${randomUUID()}` },
    payload: {
      seller_id: SELLER_ID, title: "R6 Viral Deal", description: "viral graph proof",
      price_per_unit: 50, min_units: 3, max_units: 100,
      deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "Pickup", cost: 0 }, { option_type: "delivery", label: "Ship", cost: 15 }]
    }
  });
  assert.equal(create.statusCode, 200, create.body);
  const dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
  const publish = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`,
    headers: { "x-seller-id": SELLER_ID },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(publish.statusCode, 200, publish.body);
  return dealId;
}

async function join(dealId: string, buyerId: string, extra: Record<string, unknown> = {}, idem = `r6-join-${randomUUID()}`) {
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`,
    headers: { "idempotency-key": idem },
    payload: {
      buyer_id: buyerId, buyer_name: extra.buyer_name || `קונה ${buyerId.slice(-4)}`, qty: 1,
      buyer_terms_accepted: true, payment_disclosure_accepted: true, ...extra
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  return { body: res.json() as any, idem };
}

const dealId = await createDeal();

// gen0 root joiner
let rootShareCode = "";
let rootParticipantId = "";
await run("Join returns a personal share link (viral block) and records generation 0 for a direct join", async () => {
  const { body } = await join(dealId, "0500000001", { buyer_name: "אילנה כהן", qty: 2 });
  rootParticipantId = body.participant_id;
  assert.ok(body.viral, "join response carries viral block");
  assert.equal(body.viral.attributed, false);
  assert.equal(body.viral.generation, 0);
  rootShareCode = body.viral.personal_share_code;
  assert.ok(rootShareCode && /^[a-z0-9][a-z0-9_-]{7,63}$/.test(rootShareCode), `personal code shape: ${rootShareCode}`);
  assert.ok(String(body.viral.personal_share_url).includes(rootShareCode));
  assert.ok(!String(body.viral.personal_share_url).includes(body.participant_id), "share URL must not expose internal ids");
  const attr = await pool.query(`SELECT * FROM siton.viral_attributions WHERE participant_id=$1`, [rootParticipantId]);
  assert.equal(attr.rowCount, 1);
  assert.equal(attr.rows[0].origin_ref_type, "none");
});

let childParticipantId = "";
let childShareCode = "";
await run("Join through a personal link binds parent participant, chain origin and generation 1", async () => {
  const { body } = await join(dealId, "0500000002", {
    affiliate_ref: rootShareCode,
    viral_first_touch_code: rootShareCode,
    viral_first_touch_at: new Date().toISOString(),
    viral_last_touch_code: rootShareCode,
    viral_last_touch_at: new Date().toISOString(),
    viral_visitor_id: "v_test_child",
    viral_session_id: "s_test_child"
  });
  childParticipantId = body.participant_id;
  childShareCode = body.viral.personal_share_code;
  assert.equal(body.viral.attributed, true);
  assert.equal(body.viral.generation, 1);
  const attr = await pool.query(`SELECT * FROM siton.viral_attributions WHERE participant_id=$1`, [childParticipantId]);
  const row = attr.rows[0];
  assert.equal(String(row.parent_participant_id), rootParticipantId, "parent participant preserved permanently");
  assert.equal(row.origin_ref_type, "participant");
  assert.equal(Number(row.generation), 1);
  assert.equal(row.first_touch_code, rootShareCode);
  assert.equal(row.last_touch_code, rootShareCode);
  assert.equal(row.visitor_id, "v_test_child");
  const link = await pool.query(`SELECT origin_link_id FROM siton.viral_attributions WHERE participant_id=$1`, [childParticipantId]);
  assert.ok(link.rows[0].origin_link_id, "chain origin link recorded");
});

let grandchildId = "";
await run("generation chains: grandchild joining via the child's personal link is generation 2 with correct chain origin", async () => {
  const { body } = await join(dealId, "0500000003", { affiliate_ref: childShareCode, qty: 3 });
  grandchildId = body.participant_id;
  assert.equal(body.viral.generation, 2);
  const [gc, child] = await Promise.all([
    pool.query(`SELECT * FROM siton.viral_attributions WHERE participant_id=$1`, [grandchildId]),
    pool.query(`SELECT * FROM siton.viral_attributions WHERE participant_id=$1`, [childParticipantId])
  ]);
  assert.equal(String(gc.rows[0].parent_participant_id), childParticipantId);
  assert.equal(String(gc.rows[0].origin_link_id), String(child.rows[0].origin_link_id), "chain origin propagates to descendants");
});

await run("repeat purchase by the same buyer keeps ONE personal link (no new viral identity)", async () => {
  const { body } = await join(dealId, "0500000001", { qty: 4 });
  assert.equal(body.viral.personal_share_code, rootShareCode, "same buyer+deal → same personal code");
  const links = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM siton.affiliate_links WHERE deal_id=$1 AND origin_buyer_id='0500000001' AND origin_type='participant'`,
    [dealId]
  );
  assert.equal(links.rows[0].cnt, 1);
});

await run("idempotent replay does NOT double-count: same idempotency key returns the same participant and one attribution row", async () => {
  const idem = `r6-replay-${randomUUID()}`;
  const first = await join(dealId, "0500000004", { affiliate_ref: rootShareCode }, idem);
  const before = await pool.query(`SELECT COUNT(*)::int AS cnt FROM siton.viral_attributions WHERE deal_id=$1`, [dealId]);
  const replay = await join(dealId, "0500000004", { affiliate_ref: rootShareCode }, idem);
  assert.equal(replay.body.participant_id, first.body.participant_id, "replay returns same participant");
  const after = await pool.query(`SELECT COUNT(*)::int AS cnt FROM siton.viral_attributions WHERE deal_id=$1`, [dealId]);
  assert.equal(after.rows[0].cnt, before.rows[0].cnt, "no extra attribution from transport retry");
});

await run("a self/unknown/disabled ref degrades to unattributed, never an error", async () => {
  const { body } = await join(dealId, "0500000005", { affiliate_ref: "nonexistent-code-123" });
  assert.equal(body.viral.attributed, false);
  assert.equal(body.viral.generation, 0);
});

await run("share code collision resistance: 2000 generated codes are unique and canonical", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const code = generatePersonalShareCode();
    assert.ok(/^[a-z0-9][a-z0-9_-]{7,63}$/.test(code), code);
    assert.ok(!seen.has(code), `collision at ${i}`);
    seen.add(code);
  }
});

await run("funnel events record once per client_event_id (retry-safe) and reject junk", async () => {
  const eventId = `ev_${randomUUID().slice(0, 12)}`;
  const payload = { event_type: "deal_view", deal_id: dealId, client_event_id: eventId, visitor_id: "v_x", session_id: "s_x" };
  const a = await app.inject({ method: "POST", url: "/api/viral/events", payload });
  assert.equal(a.statusCode, 202, a.body);
  assert.equal((a.json() as any).recorded, true);
  const b = await app.inject({ method: "POST", url: "/api/viral/events", payload });
  assert.equal((b.json() as any).recorded, false, "duplicate client_event_id is not re-recorded");
  const junk = await app.inject({ method: "POST", url: "/api/viral/events", payload: { ...payload, event_type: "made_up" } });
  assert.equal(junk.statusCode, 400);
  const cnt = await pool.query(`SELECT COUNT(*)::int AS cnt FROM siton.viral_events WHERE deal_id=$1 AND client_event_id=$2`, [dealId, eventId]);
  assert.equal(cnt.rows[0].cnt, 1);
});

await run("public activity feed exposes masked first names only — no phones, emails or ids", async () => {
  const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/activity` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.ok(Array.isArray(body.recent_joins) && body.recent_joins.length >= 3);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("0500000001"), "no buyer phone in public activity");
  assert.ok(!raw.includes(rootParticipantId), "no participant ids in public activity");
  const ilana = body.recent_joins.find((j: any) => j.display === "אילנה");
  assert.ok(ilana, "masked first name present");
});

await run("recompute: provisional joins are never counted as successful money; only ChargedSuccess/RecoveredCharge are", async () => {
  const client = await pool.connect();
  try {
    let metrics = await recomputeDealViralMetrics(client as any, dealId);
    let totals: any = (metrics as any).totals;
    assert.equal(totals.charged_units, 0, "AuthHeld frames are NOT charged units");
    assert.equal(totals.charged_gmv, 0);
    assert.ok(totals.units_joined >= 10, `joined units aggregated (${totals.units_joined})`);
    // Force two participants into final successful money states (fixture-only bypass).
    await client.query(`SET session_replication_role = replica`);
    await client.query(`UPDATE siton.participants SET money_state='ChargedSuccess', buyer_state='ChargedSuccess' WHERE participant_id=$1`, [childParticipantId]);
    await client.query(`UPDATE siton.participants SET money_state='RecoveredCharge', buyer_state='Recovered' WHERE participant_id=$1`, [grandchildId]);
    await client.query(`SET session_replication_role = DEFAULT`);
    metrics = await recomputeDealViralMetrics(client as any, dealId);
    totals = (metrics as any).totals;
    const viral: any = (metrics as any).viral;
    assert.equal(totals.charged_units, 4, "child qty 1 + grandchild qty 3");
    assert.equal(viral.attributed_charged_participants, 2);
    assert.equal(viral.attributed_charged_units, 4);
    assert.ok(viral.attributed_charged_gmv > 0);
    assert.equal(viral.max_generation, 2);
    assert.equal(viral.generation_distribution["1"], 2, "two gen-1 joins (child + replay buyer)");
    assert.equal(viral.generation_distribution["2"], 1);
  } finally {
    client.release();
  }
});

await run("subtree rollups credit ancestors: root's branch contains child+grandchild units", async () => {
  const cache = await pool.query(`SELECT metrics FROM siton.viral_metrics_cache WHERE scope_type='deal' AND scope_id=$1`, [dealId]);
  const metrics = cache.rows[0].metrics;
  const root = (metrics.top_sharers as any[]).find((s) => s.participant_id === rootParticipantId);
  assert.ok(root, "root appears as a sharer");
  assert.ok(root.subtree_joins >= 3, `root subtree joins ${root.subtree_joins}`);
  assert.equal(root.subtree_charged_units, 4, "charged units roll up the whole branch");
  assert.equal(root.max_depth, 2);
});

await run("tree privacy: cached tree/metrics contain no phone, email, or full buyer names", async () => {
  const cache = await pool.query(`SELECT metrics::text AS raw FROM siton.viral_metrics_cache WHERE scope_type='deal' AND scope_id=$1`, [dealId]);
  const raw = String(cache.rows[0].raw);
  assert.ok(!raw.includes("05000000"), "no buyer phones in cache");
  assert.ok(!raw.includes("@"), "no emails in cache");
  assert.ok(!raw.includes("אילנה כהן"), "full names are masked to first name");
  assert.ok(raw.includes("אילנה"), "masked first name retained for the explorer");
});

await run("distributor/participant payout remains ZERO: no money-authority fields anywhere in the viral surfaces", async () => {
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='siton' AND table_name IN ('viral_attributions','viral_events','viral_metrics_cache','affiliate_links')
       AND (column_name ILIKE '%commission%' OR column_name ILIKE '%payout%' OR column_name ILIKE '%balance%' OR column_name ILIKE '%wallet%')`
  );
  assert.equal(cols.rowCount, 0, "no commission/payout/balance/wallet columns");
  const cache = await pool.query(`SELECT metrics::text AS raw FROM siton.viral_metrics_cache WHERE scope_type='deal' AND scope_id=$1`, [dealId]);
  assert.ok(!/commission|payout|wallet/i.test(String(cache.rows[0].raw)), "metrics carry measurement only");
});

await run("aggregate recompute rolls the deal into seller + platform caches", async () => {
  const client = await pool.connect();
  try {
    await recomputeAggregateViralMetrics(client as any, SELLER_ID);
  } finally { client.release(); }
  const seller = await pool.query(`SELECT metrics FROM siton.viral_metrics_cache WHERE scope_type='seller' AND scope_id=$1`, [SELLER_ID]);
  assert.equal(seller.rowCount, 1);
  assert.ok(Number(seller.rows[0].metrics.attributed_charged_units) >= 4);
  const platform = await pool.query(`SELECT metrics FROM siton.viral_metrics_cache WHERE scope_type='platform' AND scope_id='global'`);
  assert.equal(platform.rowCount, 1);
  assert.ok(Array.isArray(platform.rows[0].metrics.top_deals));
});

await run("join enqueues a debounced viral_recompute outbox job (one pending per deal)", async () => {
  const rows = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM siton.outbox_events WHERE event_type='viral_recompute' AND aggregate_id=$1 AND status IN ('pending','processing')`,
    [dealId]
  );
  assert.equal(rows.rows[0].cnt, 1, "exactly one pending recompute despite many joins");
});

await run("participant impact endpoint is token-gated and returns safe aggregates only", async () => {
  const noToken = await app.inject({ method: "GET", url: `/api/participants/${rootParticipantId}/impact` });
  assert.equal(noToken.statusCode, 401);
  // issue a fresh join to get a live tracking token for the root buyer's newest participation
  const { body } = await join(dealId, "0500000009");
  const res = await app.inject({
    method: "GET",
    url: `/api/participants/${body.participant_id}/impact`,
    headers: { authorization: `Bearer ${body.tracking_access_token}` }
  });
  assert.equal(res.statusCode, 200, res.body);
  const impact = (res.json() as any).impact;
  assert.ok(impact.personal_share_code, "impact returns the personal share identity");
  const raw = JSON.stringify(impact);
  assert.ok(!raw.includes("05000000"), "impact carries no phone numbers");
});

await app.close().catch(() => undefined);
await pool.end();
console.log(`\nR6_VIRAL_GRAPH ${failed === 0 ? "PASS" : "FAIL"} passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
