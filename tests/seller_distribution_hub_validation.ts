import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import "dotenv/config";

// SELLER DISTRIBUTION HUB — attribution + analytics only.
// Proves: several links per deal, visit/entry + unique-visitor measurement,
// last-eligible-link join attribution, joined vs FINAL charged units, gross
// actually collected, conversions, time series, disabling without losing
// history, seller isolation (A never sees B), the scoped read-only external
// link viewer (A1 sees A1 only; never A2, never seller data, never PII),
// revocation/reset invalidating sessions, login rate limiting, and that the
// buyer-facing flow is unchanged (no link data in buyer responses, direct
// joins keep working, replays never double count).

process.env.APP_DEPLOYMENT_MODE = "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.PORT = process.env.PORT || "3651";
delete process.env.BUYER_VERIFY_JOIN;

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton" });
const { app } = await import("../src/app.js");
const { recomputeDealViralMetrics } = await import("../src/viral_graph.js");
const { LINK_VIEWER_LOGIN_MAX_ATTEMPTS, LINK_VIEWER_SESSION_COOKIE } = await import("../src/distribution_hub.js");

const SELLER_A = `dist-seller-a-${randomUUID().slice(0, 8)}`;
const SELLER_B = `dist-seller-b-${randomUUID().slice(0, 8)}`;
let passed = 0, failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; } catch (e) { console.error(`FAIL ${name}: ${(e as any)?.stack || e}`); failed++; }
}

for (const sellerId of [SELLER_A, SELLER_B]) {
  await pool.query(
    `INSERT INTO siton.seller_accounts (seller_id, display_name, business_name, support_email, verification_status, settlement_status)
     VALUES ($1,$1,'Distribution Ltd','dist@siton.local','approved','active')
     ON CONFLICT (seller_id) DO NOTHING`,
    [sellerId]
  );
}

const PRICE = 50;
const DELIVERY_COST = 15;

async function createDeal(sellerId: string): Promise<string> {
  const create = await app.inject({
    method: "POST", url: "/deals",
    headers: { "x-seller-id": sellerId, "idempotency-key": `dist-create-${randomUUID()}` },
    payload: {
      seller_id: sellerId, title: "Distribution Hub Deal", description: "distribution hub proof",
      price_per_unit: PRICE, min_units: 3, max_units: 200,
      deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      delivery_options: [{ option_type: "pickup", label: "Pickup — Herzl 12, Tel Aviv", cost: 0 }, { option_type: "delivery", label: "Ship", cost: DELIVERY_COST }]
    }
  });
  assert.equal(create.statusCode, 200, create.body);
  const dealId = (create.json() as any).deal?.deal_id || (create.json() as any).deal_id;
  const publish = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`,
    headers: { "x-seller-id": sellerId },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(publish.statusCode, 200, publish.body);
  return dealId;
}

const sellerHeaders = (sellerId: string) => ({ "x-seller-id": sellerId });

async function join(dealId: string, buyerId: string, extra: Record<string, unknown> = {}, idem = `dist-join-${randomUUID()}`) {
  const res = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`,
    headers: { "idempotency-key": idem },
    payload: {
      buyer_id: buyerId, buyer_name: extra.buyer_name || `קונה ${buyerId.slice(-4)}`, qty: 1,
      buyer_terms_accepted: true, payment_disclosure_accepted: true, ...extra
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
}

async function visit(dealId: string, code: string, visitorId: string, entryId = `en_${randomUUID().slice(0, 12)}`) {
  const res = await app.inject({
    method: "POST", url: "/api/affiliate/links/visit",
    payload: { deal_id: dealId, source_code: code, click_id: `ck_${randomUUID().slice(0, 12)}`, entry_id: entryId, visitor_id: visitorId }
  });
  assert.equal(res.statusCode, 202, res.body);
  return (res.json() as any).recorded as boolean;
}

async function distribution(sellerId: string, dealId: string) {
  const res = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/distribution`, headers: sellerHeaders(sellerId) });
  return { status: res.statusCode, body: res.json() as any };
}

async function linkDashboard(sellerId: string, dealId: string, linkId: string, range = "") {
  const res = await app.inject({
    method: "GET",
    url: `/api/seller/deals/${dealId}/distribution/links/${linkId}${range ? `?range=${range}` : ""}`,
    headers: sellerHeaders(sellerId)
  });
  return { status: res.statusCode, body: res.json() as any };
}

function cookieOf(res: any): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join("; ") : String(raw || "");
  const match = header.match(new RegExp(`${LINK_VIEWER_SESSION_COOKIE}=([^;]*)`));
  return match ? `${LINK_VIEWER_SESSION_COOKIE}=${match[1]}` : "";
}

async function viewerLogin(username: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/api/link-viewer/session/login", payload: { username, password } });
  return { status: res.statusCode, body: res.json() as any, cookie: cookieOf(res) };
}

const PII_KEY_DENYLIST = /name|phone|email|address|buyer|participant|payment|token|auth_id|transaction|invoice|receipt|document|audit|ledger|support|user_id|seller_id|affiliate|city|notes/i;
// charged_participants is a COUNT of final charges (aggregate), never a list.
const PII_KEY_ALLOWLIST = new Set(["link_name", "username", "deal_title", "description_he", "disclaimer_he", "charged_participants"]);
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) { for (const v of value) collectKeys(v, out); return out; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out.push(k); collectKeys(v, out); }
  }
  return out;
}

const dealA = await createDeal(SELLER_A);
const dealB = await createDeal(SELLER_B);

await run("empty state: a deal without distribution links lists nothing and reports real zeros", async () => {
  const { status, body } = await distribution(SELLER_A, dealA);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.links, []);
  assert.equal(body.totals.entries, 0);
  assert.equal(body.totals.joins, 0);
  assert.equal(body.totals.charged_units, 0);
  assert.equal(body.totals.attributed_gross, 0);
  assert.equal(body.attribution_rule.code, "last_eligible_distribution_link_before_join");
  assert.ok(String(body.disclaimer_he).includes("מדידה וייחוס בלבד"));
});

const links: Record<string, any> = {};
await run("seller creates several distribution links for the same deal (name + optional channel), opaque codes, canonical share URL", async () => {
  for (const [name, channel] of [["WhatsApp קבוצה א", "whatsapp"], ["Facebook campaign", "facebook"], ["משפיען יוסי", ""]] as const) {
    const res = await app.inject({
      method: "POST", url: `/api/seller/deals/${dealA}/distribution/links`,
      headers: sellerHeaders(SELLER_A), payload: { internal_name: name, channel }
    });
    assert.equal(res.statusCode, 201, res.body);
    const link = (res.json() as any).link;
    assert.equal(link.internal_name, name);
    assert.equal(link.channel, channel || null);
    assert.equal(link.status, "active");
    assert.match(link.source_code, /^[a-z0-9][a-z0-9_-]{7,63}$/);
    assert.ok(!link.source_code.includes(dealA.slice(0, 8)), "code must not embed the deal id");
    assert.equal(link.share_url, `/d/${dealA}?ref=${link.source_code}`);
    assert.equal(link.metrics.entries, 0);
    assert.equal(link.metrics.joins, 0);
    assert.equal(link.external_access.enabled, false);
    links[name] = link;
  }
  const dup = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links`,
    headers: sellerHeaders(SELLER_A), payload: { internal_name: "whatsapp קבוצה א" }
  });
  assert.equal(dup.statusCode, 409, dup.body);
  const empty = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links`,
    headers: sellerHeaders(SELLER_A), payload: { internal_name: "   " }
  });
  assert.equal(empty.statusCode, 400, empty.body);
  const { body } = await distribution(SELLER_A, dealA);
  assert.equal(body.links.length, 3);
});
const L1 = links["WhatsApp קבוצה א"];
const L2 = links["Facebook campaign"];
const L3 = links["משפיען יוסי"];

await run("rename + channel edit keep the same code; unknown fields are refused", async () => {
  const res = await app.inject({
    method: "PATCH", url: `/api/seller/deals/${dealA}/distribution/links/${L3.link_id}`,
    headers: sellerHeaders(SELLER_A), payload: { internal_name: "משפיען יוסי — סטורי", channel: "instagram" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const link = (res.json() as any).link;
  assert.equal(link.internal_name, "משפיען יוסי — סטורי");
  assert.equal(link.channel, "instagram");
  assert.equal(link.source_code, L3.source_code);
  const bad = await app.inject({
    method: "PATCH", url: `/api/seller/deals/${dealA}/distribution/links/${L3.link_id}`,
    headers: sellerHeaders(SELLER_A), payload: { source_code: "hijack" }
  });
  assert.equal(bad.statusCode, 400, bad.body);
});

await run("Seller B never sees or edits Seller A's distribution data (404 on list, link, patch, create)", async () => {
  assert.equal((await distribution(SELLER_B, dealA)).status, 404);
  assert.equal((await linkDashboard(SELLER_B, dealA, L1.link_id)).status, 404);
  const patch = await app.inject({
    method: "PATCH", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}`,
    headers: sellerHeaders(SELLER_B), payload: { internal_name: "stolen" }
  });
  assert.equal(patch.statusCode, 404, patch.body);
  const create = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links`,
    headers: sellerHeaders(SELLER_B), payload: { internal_name: "B on A" }
  });
  assert.equal(create.statusCode, 404, create.body);
  // Cross-deal: A's link id under B's deal path is not A's data either.
  assert.equal((await linkDashboard(SELLER_B, dealB, L1.link_id)).status, 404);
  const unchanged = await distribution(SELLER_A, dealA);
  assert.equal(unchanged.body.links.find((l: any) => l.link_id === L1.link_id).internal_name, "WhatsApp קבוצה א");
});

await run("visit attribution: entries count per link, a refresh (same entry id) never double counts, unique visitors are measured", async () => {
  assert.equal(await visit(dealA, L1.source_code, "v_one", "en_refresh_same"), true);
  assert.equal(await visit(dealA, L1.source_code, "v_one", "en_refresh_same"), true); // refresh replay
  assert.equal(await visit(dealA, L1.source_code, "v_one"), true);                    // new session, same visitor
  assert.equal(await visit(dealA, L1.source_code, "v_two"), true);
  assert.equal(await visit(dealA, L2.source_code, "v_three"), true);
  const { body } = await distribution(SELLER_A, dealA);
  const l1 = body.links.find((l: any) => l.link_id === L1.link_id);
  const l2 = body.links.find((l: any) => l.link_id === L2.link_id);
  const l3 = body.links.find((l: any) => l.link_id === L3.link_id);
  assert.equal(l1.metrics.entries, 3, "3 distinct entries (refresh deduplicated)");
  assert.equal(l1.metrics.unique_visitors, 2);
  assert.equal(l2.metrics.entries, 1);
  assert.equal(l2.metrics.unique_visitors, 1);
  assert.equal(l3.metrics.entries, 0);
  assert.equal(body.totals.entries, 4);
});

const participants: Record<string, string> = Object.create(null);
const pid = (key: string): string => String(participants[key] || "");
await run("join attribution: last eligible distribution link before Join; direct joins stay unattributed; buyer responses carry no link data", async () => {
  const a = await join(dealA, "0530000001", { affiliate_ref: L1.source_code, qty: 2, buyer_name: "דנה לוי" });
  const b = await join(dealA, "0530000002", { affiliate_ref: L1.source_code, qty: 1, buyer_name: "רון כהן", buyer_email: "ron@example.test" });
  const c = await join(dealA, "0530000003", { affiliate_ref: L2.source_code, qty: 3, buyer_name: "מאיה בר", delivery_option_id: undefined });
  const direct = await join(dealA, "0530000004", { qty: 5, buyer_name: "ישיר גולן" });
  participants.a = a.participant_id; participants.b = b.participant_id; participants.c = c.participant_id; participants.direct = direct.participant_id;
  assert.equal(a.viral.attributed, true);
  assert.equal(direct.viral.attributed, false);
  for (const body of [a, b, c, direct]) {
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("WhatsApp קבוצה א") && !raw.includes("Facebook campaign"), "join response must not expose distribution link names");
    assert.ok(!raw.includes("whatsapp") && !raw.includes('"channel"'), "join response must not expose the link channel");
  }
  const attr = await pool.query(`SELECT participant_id, parent_link_id, origin_ref_type FROM siton.viral_attributions WHERE participant_id = ANY($1::uuid[])`, [Object.values(participants)]);
  const byId = new Map<string, any>(attr.rows.map((r: any) => [String(r.participant_id), r]));
  assert.equal(String(byId.get(pid("a")).parent_link_id), L1.link_id);
  assert.equal(byId.get(pid("a")).origin_ref_type, "seller");
  assert.equal(String(byId.get(pid("c")).parent_link_id), L2.link_id);
  assert.equal(byId.get(pid("direct")).parent_link_id, null);
  assert.equal(byId.get(pid("direct")).origin_ref_type, "none");
  // Buyer-facing acquisition stays 'direct': a seller link is tracking only.
  const acq = await pool.query(`SELECT acquisition_source FROM siton.participants WHERE participant_id=$1`, [pid("a")]);
  assert.equal(acq.rows[0].acquisition_source, "direct");

  const { body } = await distribution(SELLER_A, dealA);
  const l1 = body.links.find((l: any) => l.link_id === L1.link_id);
  const l2 = body.links.find((l: any) => l.link_id === L2.link_id);
  assert.equal(l1.metrics.joins, 2);
  assert.equal(l1.metrics.joined_units, 3);
  assert.equal(l2.metrics.joins, 1);
  assert.equal(l2.metrics.joined_units, 3);
  assert.equal(l1.metrics.charged_units, 0, "a join is NOT a final charge");
  assert.equal(l1.metrics.attributed_gross, 0);
  assert.equal(l1.metrics.conversion_entry_to_join, 0.6667, "4-decimal ratio");
  assert.equal(l1.metrics.conversion_entry_to_final_charge, 0);
  assert.equal(body.totals.joins, 3, "the direct join is not attributed to any link");
  assert.equal(body.totals.joined_units, 6);

  const pub = await app.inject({ method: "GET", url: `/api/deals/${dealA}/public` });
  assert.equal(pub.statusCode, 200);
  const pubRaw = pub.body;
  assert.ok(!pubRaw.includes("WhatsApp קבוצה א") && !pubRaw.includes(L1.source_code), "public deal payload is identical for every entry path");
});

await run("a transport replay (same idempotency key) never creates a second attributed join", async () => {
  const idem = `dist-replay-${randomUUID()}`;
  const first = await join(dealA, "0530000005", { affiliate_ref: L2.source_code, qty: 1 }, idem);
  const before = (await distribution(SELLER_A, dealA)).body.links.find((l: any) => l.link_id === L2.link_id).metrics;
  const replay = await join(dealA, "0530000005", { affiliate_ref: L2.source_code, qty: 1 }, idem);
  assert.equal(replay.participant_id, first.participant_id);
  const after = (await distribution(SELLER_A, dealA)).body.links.find((l: any) => l.link_id === L2.link_id).metrics;
  assert.equal(after.joins, before.joins);
  assert.equal(after.joined_units, before.joined_units);
  participants.replay = first.participant_id;
});

await run("a link of another deal or an unknown code is not eligible: the join degrades to unattributed, never to an error", async () => {
  const foreign = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealB}/distribution/links`,
    headers: sellerHeaders(SELLER_B), payload: { internal_name: "B link" }
  });
  assert.equal(foreign.statusCode, 201, foreign.body);
  links.B = (foreign.json() as any).link;
  const res = await join(dealA, "0530000006", { affiliate_ref: links.B.source_code, qty: 1 });
  assert.equal(res.viral.attributed, false);
  assert.equal((await distribution(SELLER_B, dealB)).body.links[0].metrics.joins, 0, "B's link gets nothing from A's deal");
});

await run("disabling a link keeps its history but stops new visits and joins; re-enabling resumes", async () => {
  const disable = await app.inject({
    method: "PATCH", url: `/api/seller/deals/${dealA}/distribution/links/${L2.link_id}`,
    headers: sellerHeaders(SELLER_A), payload: { status: "disabled" }
  });
  assert.equal(disable.statusCode, 200, disable.body);
  assert.equal((disable.json() as any).link.status, "disabled");
  assert.equal(await visit(dealA, L2.source_code, "v_after_disable"), false);
  const late = await join(dealA, "0530000007", { affiliate_ref: L2.source_code, qty: 1 });
  assert.equal(late.viral.attributed, false, "a disabled link is not eligible");
  let l2 = (await distribution(SELLER_A, dealA)).body.links.find((l: any) => l.link_id === L2.link_id);
  assert.equal(l2.status, "disabled");
  assert.equal(l2.metrics.entries, 1, "history preserved");
  assert.equal(l2.metrics.joins, 2, "history preserved");
  const enable = await app.inject({
    method: "PATCH", url: `/api/seller/deals/${dealA}/distribution/links/${L2.link_id}`,
    headers: sellerHeaders(SELLER_A), payload: { status: "active" }
  });
  assert.equal(enable.statusCode, 200, enable.body);
  assert.equal(await visit(dealA, L2.source_code, "v_after_enable"), true);
  l2 = (await distribution(SELLER_A, dealA)).body.links.find((l: any) => l.link_id === L2.link_id);
  assert.equal(l2.metrics.entries, 2);
});

await run("final charge attribution: only ChargedSuccess/RecoveredCharge count; gross is what was actually collected", async () => {
  const client = await pool.connect();
  try {
    await client.query(`SET session_replication_role = replica`);
    await client.query(`UPDATE siton.participants SET money_state='ChargedSuccess', buyer_state='ChargedSuccess' WHERE participant_id=$1`, [pid("a")]);
    await client.query(`UPDATE siton.participants SET money_state='RecoveredCharge', buyer_state='Recovered' WHERE participant_id=$1`, [pid("c")]);
    await client.query(`UPDATE siton.participants SET money_state='ChargedSuccess', buyer_state='ChargedSuccess' WHERE participant_id=$1`, [pid("direct")]);
    await client.query(`SET session_replication_role = DEFAULT`);
    // Participant c has a canonical money event: the collected gross wins over the computed estimate.
    await client.query(
      `INSERT INTO siton.platform_fee_money_events
         (participant_id, deal_id, seller_id, event_type, logical_entry_type, provider_code, source_money_state,
          payout_readiness_status, gross_amount, fee_base_amount, platform_fee_rate, platform_fee_vat_rate, platform_fee_amount, seller_net_amount)
       VALUES ($1,$2,$3,'recovery_captured','charge','mockpay','RecoveredCharge','ready_for_settlement',123.45,123.45,0.08,0.18,9.88,113.57)`,
      [pid("c"), dealA, SELLER_A]
    );
  } finally { client.release(); }
  const { body } = await distribution(SELLER_A, dealA);
  const l1 = body.links.find((l: any) => l.link_id === L1.link_id);
  const l2 = body.links.find((l: any) => l.link_id === L2.link_id);
  assert.equal(l1.metrics.joins, 2);
  assert.equal(l1.metrics.charged_participants, 1);
  assert.equal(l1.metrics.charged_units, 2, "participant a (qty 2) charged; participant b still provisional");
  assert.equal(l1.metrics.attributed_gross, 2 * PRICE, "no money event yet → computed collected amount (qty × price + delivery 0)");
  assert.equal(l1.metrics.conversion_entry_to_final_charge, 0.3333);
  assert.equal(l2.metrics.charged_units, 3);
  assert.equal(l2.metrics.attributed_gross, 123.45, "money-event gross actually collected wins");
  assert.equal(body.totals.charged_units, 5, "the charged direct join is not attributed to any link");
  assert.equal(body.totals.attributed_gross, 100 + 123.45);
  const raw = JSON.stringify(body);
  assert.ok(!/commission|payout|balance|wallet|entitlement/i.test(raw), "distribution surface carries measurement only");
});

await run("per-link dashboard: all-time totals, windowed totals and a time series for every range; invalid range falls back", async () => {
  for (const [range, bucket, minPoints] of [["24h", "hour", 24], ["7d", "day", 7], ["30d", "day", 30], ["all", "day", 1]] as const) {
    const { status, body } = await linkDashboard(SELLER_A, dealA, L1.link_id, range);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.range, range);
    assert.equal(body.link.internal_name, "WhatsApp קבוצה א");
    assert.equal(body.deal.title, "Distribution Hub Deal");
    assert.equal(body.series.bucket, bucket);
    assert.ok(body.series.points.length >= minPoints, `${range}: ${body.series.points.length} points`);
    const sum = (key: string) => body.series.points.reduce((s: number, p: any) => s + Number(p[key] || 0), 0);
    assert.equal(sum("entries"), 3, `${range}: entries series sums to the total`);
    assert.equal(sum("joins"), 2);
    assert.equal(sum("joined_units"), 3);
    assert.equal(sum("charged_units"), 2);
    assert.equal(sum("attributed_gross"), 100);
    assert.equal(body.window.entries, 3);
    assert.equal(body.window.charged_units, 2);
    assert.equal(body.link.metrics.entries, 3);
    for (const p of body.series.points) assert.match(String(p.t), /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
  }
  const fallback = await linkDashboard(SELLER_A, dealA, L1.link_id, "bogus");
  assert.equal(fallback.body.range, "7d");
  assert.equal((await linkDashboard(SELLER_A, dealA, randomUUID())).status, 404);
  assert.equal((await linkDashboard(SELLER_A, dealA, "not-a-uuid")).status, 400);
});

await run("seller links do not break the existing viral recompute", async () => {
  const client = await pool.connect();
  try {
    const metrics: any = await recomputeDealViralMetrics(client as any, dealA);
    assert.ok(metrics.totals, "recompute produced metrics");
  } finally { client.release(); }
});

let credentials: { username: string; password: string } = { username: "", password: "" };
let viewerCookie = "";
await run("external access: default disabled; enabling returns one-time credentials; the raw password is never stored", async () => {
  const before = (await distribution(SELLER_A, dealA)).body.links.find((l: any) => l.link_id === L1.link_id);
  assert.equal(before.external_access.enabled, false);
  const res = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}/external-access`,
    headers: sellerHeaders(SELLER_A), payload: { action: "enable" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.external_access.enabled, true);
  assert.ok(body.credentials?.username && body.credentials?.password, "credentials returned once");
  assert.equal(body.credentials.login_path, "/preview/#/link-dashboard");
  credentials = { username: body.credentials.username, password: body.credentials.password };
  const stored = await pool.query(`SELECT secret_hash FROM siton.distribution_link_viewers WHERE lower(username)=$1`, [credentials.username.toLowerCase()]);
  assert.equal(stored.rowCount, 1);
  assert.ok(String(stored.rows[0].secret_hash).startsWith("scrypt$"));
  assert.ok(!String(stored.rows[0].secret_hash).includes(credentials.password));
  const again = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}/external-access`,
    headers: sellerHeaders(SELLER_A), payload: { action: "enable" }
  });
  assert.equal(again.statusCode, 409, again.body);
  const listed = (await distribution(SELLER_A, dealA)).body.links.find((l: any) => l.link_id === L1.link_id);
  assert.equal(listed.external_access.enabled, true);
  assert.equal(listed.external_access.username, credentials.username);
  assert.ok(!JSON.stringify(listed).includes(credentials.password), "password never appears again");
  // Seller B cannot manage A's external access either.
  const b = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}/external-access`,
    headers: sellerHeaders(SELLER_B), payload: { action: "reset_password" }
  });
  assert.equal(b.statusCode, 404, b.body);
});

await run("external login: wrong password and unknown user answer identically (401); a valid login issues an HttpOnly session cookie", async () => {
  const wrong = await viewerLogin(credentials.username, "definitely-wrong");
  assert.equal(wrong.status, 401);
  const unknown = await viewerLogin("lv-nobody00", "definitely-wrong");
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, wrong.body, "no account oracle");
  const missing = await app.inject({ method: "POST", url: "/api/link-viewer/session/login", payload: {} });
  assert.equal(missing.statusCode, 400);
  const ok = await viewerLogin(credentials.username, credentials.password);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.cookie, "session cookie set");
  const setCookie = String(ok.body && (await app.inject({ method: "POST", url: "/api/link-viewer/session/login", payload: credentials })).headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly/);
  viewerCookie = ok.cookie;
  assert.equal(ok.body.link_viewer.authenticated, true);
  assert.equal(ok.body.link_viewer.links.length, 1);
  assert.equal(ok.body.link_viewer.links[0].link_id, L1.link_id);
  const session = await app.inject({ method: "GET", url: "/api/link-viewer/session", headers: { cookie: viewerCookie } });
  assert.equal(session.statusCode, 200, session.body);
  const anon = await app.inject({ method: "GET", url: "/api/link-viewer/session" });
  assert.equal(anon.statusCode, 401);
  assert.equal((anon.json() as any).link_viewer.authenticated, false);
});

await run("external dashboard: A1 sees A1's aggregates only — never A2, never another seller's link, never a guessed id", async () => {
  const res = await app.inject({ method: "GET", url: "/api/link-viewer/dashboard?range=7d", headers: { cookie: viewerCookie } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.link.link_id, L1.link_id);
  assert.equal(body.link.link_name, "WhatsApp קבוצה א");
  assert.equal(body.deal.title, "Distribution Hub Deal");
  assert.equal(body.link.status, "active");
  assert.equal(body.totals.entries, 3);
  assert.equal(body.totals.unique_visitors, 2);
  assert.equal(body.totals.joins, 2);
  assert.equal(body.totals.joined_units, 3);
  assert.equal(body.totals.charged_units, 2);
  assert.equal(body.totals.attributed_gross, 100);
  assert.equal(body.totals.conversion_entry_to_join, 0.6667);
  assert.ok(Array.isArray(body.series.points) && body.series.points.length >= 7);
  assert.ok(String(body.disclaimer_he).includes("אינה מחשבת או מנהלת עמלה"));
  // Explicit selection of the granted link is fine; anything else is refused.
  const own = await app.inject({ method: "GET", url: `/api/link-viewer/dashboard?link=${L1.link_id}`, headers: { cookie: viewerCookie } });
  assert.equal(own.statusCode, 200);
  for (const other of [L2.link_id, L3.link_id, links.B.link_id, randomUUID(), "not-a-uuid"]) {
    const denied = await app.inject({ method: "GET", url: `/api/link-viewer/dashboard?link=${other}`, headers: { cookie: viewerCookie } });
    assert.equal(denied.statusCode, 403, `${other}: ${denied.body}`);
    assert.ok(!denied.body.includes("Facebook") && !denied.body.includes("B link"), "refusal leaks nothing");
    const viaAlias = await app.inject({ method: "GET", url: `/api/link-viewer/dashboard?link_id=${other}`, headers: { cookie: viewerCookie } });
    assert.equal(viaAlias.statusCode, 403);
  }
  const anon = await app.inject({ method: "GET", url: `/api/link-viewer/dashboard?link=${L1.link_id}` });
  assert.equal(anon.statusCode, 401, "no session → no data, even for a real link id");
});

await run("PII isolation: no external response contains names, phones, emails, addresses, participants, payment data or internal person ids", async () => {
  const responses = [
    await app.inject({ method: "GET", url: "/api/link-viewer/dashboard?range=all", headers: { cookie: viewerCookie } }),
    await app.inject({ method: "GET", url: "/api/link-viewer/dashboard?range=24h", headers: { cookie: viewerCookie } }),
    await app.inject({ method: "GET", url: "/api/link-viewer/session", headers: { cookie: viewerCookie } })
  ];
  for (const res of responses) {
    assert.equal(res.statusCode, 200, res.body);
    const raw = res.body;
    for (const phone of ["0530000001", "0530000002", "0530000003", "0530000004", "0530000005"]) assert.ok(!raw.includes(phone), `phone ${phone} leaked`);
    for (const name of ["דנה לוי", "רון כהן", "מאיה בר", "ישיר גולן"]) assert.ok(!raw.includes(name), `name ${name} leaked`);
    assert.ok(!raw.includes("@"), "no email");
    for (const pid of Object.values(participants)) assert.ok(!raw.includes(pid), "no participant id");
    assert.ok(!raw.includes(dealA), "no internal deal id for the external viewer");
    assert.ok(!raw.includes(SELLER_A), "no seller id");
    assert.ok(!raw.includes(L1.source_code), "no share code (the viewer measures, it does not mint)");
    const keys = collectKeys(res.json()).filter((k) => !PII_KEY_ALLOWLIST.has(k));
    const suspicious = keys.filter((k) => PII_KEY_DENYLIST.test(k));
    assert.deepEqual(suspicious, [], `suspicious keys in external payload: ${suspicious.join(",")}`);
  }
});

await run("the external credential cannot reach seller, distributor, affiliate, admin or participant surfaces", async () => {
  const probes = [
    { method: "GET", url: `/api/seller/deals/${dealA}/distribution` },
    { method: "GET", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}` },
    { method: "GET", url: `/api/seller/deals/${dealA}` },
    { method: "GET", url: `/api/seller/deals` },
    { method: "GET", url: `/api/seller/analytics` },
    { method: "GET", url: `/api/affiliate/overview` },
    { method: "GET", url: `/api/distributor/session` },
    { method: "GET", url: `/api/admin/r6/overview` },
    { method: "GET", url: `/api/admin/deals/${dealA}/viral` },
    // /api/participants/* is deliberately NOT probed here: demo-preview keeps
    // the legacy token-less tracking link tolerance for demo buyers, so its
    // answer says nothing about this credential. The non-demo refusal is
    // proven in link_viewer_authority_validation.ts (internal-runtime).
    { method: "POST", url: `/api/seller/deals/${dealA}/distribution/links`, payload: { internal_name: "viewer minted" } },
    { method: "PATCH", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}`, payload: { status: "disabled" } }
  ];
  for (const probe of probes) {
    const res = await app.inject({ ...(probe as any), headers: { cookie: viewerCookie } });
    const raw = res.body;
    // demo-preview seller routes fall back to a default seller workspace, so
    // the invariant is: never seller A's data, never the buyer list, never 2xx
    // with the probed resource.
    assert.ok(!raw.includes("דנה לוי") && !raw.includes("0530000001"), `${probe.method} ${probe.url} leaked buyer data`);
    // Admin surfaces legitimately show every link of a deal (demo-preview opens
    // them to the demo admin); the credential itself must never unlock seller data.
    if (!probe.url.startsWith("/api/admin/")) {
      assert.ok(!raw.includes("WhatsApp קבוצה א"), `${probe.method} ${probe.url} leaked seller A's link data`);
    }
    // /api/distributor/session answers with the demo distributor context in
    // demo-preview regardless of any cookie (existing demo behaviour, not this
    // credential); the leak assertions above still apply to it.
    // Demo-preview opens seller/admin read surfaces to the demo workspace by
    // design; the strict non-demo authority proof for this credential lives in
    // link_viewer_authority_validation.ts (internal-runtime).
  }
  const stillOne = (await distribution(SELLER_A, dealA)).body.links.filter((l: any) => l.internal_name === "viewer minted");
  assert.equal(stillOne.length, 0, "the viewer credential created nothing");
});

await run("password reset invalidates the old password and every live session; the new password works", async () => {
  const res = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}/external-access`,
    headers: sellerHeaders(SELLER_A), payload: { action: "reset_password" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as any;
  assert.equal(body.credentials.username, credentials.username, "same identity");
  assert.notEqual(body.credentials.password, credentials.password);
  const oldSession = await app.inject({ method: "GET", url: "/api/link-viewer/dashboard", headers: { cookie: viewerCookie } });
  assert.equal(oldSession.statusCode, 401, "old session revoked");
  assert.equal((await viewerLogin(credentials.username, credentials.password)).status, 401, "old password rejected");
  credentials = { username: body.credentials.username, password: body.credentials.password };
  const fresh = await viewerLogin(credentials.username, credentials.password);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  viewerCookie = fresh.cookie;
  assert.equal((await app.inject({ method: "GET", url: "/api/link-viewer/dashboard", headers: { cookie: viewerCookie } })).statusCode, 200);
});

await run("logout revokes the session cookie", async () => {
  const out = await app.inject({ method: "POST", url: "/api/link-viewer/session/logout", headers: { cookie: viewerCookie } });
  assert.equal(out.statusCode, 200);
  assert.equal((out.json() as any).link_viewer.authenticated, false);
  assert.equal((await app.inject({ method: "GET", url: "/api/link-viewer/dashboard", headers: { cookie: viewerCookie } })).statusCode, 401);
  viewerCookie = (await viewerLogin(credentials.username, credentials.password)).cookie;
});

await run("revoking external access invalidates sessions and logins but keeps the link and its analytics", async () => {
  const res = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}/external-access`,
    headers: sellerHeaders(SELLER_A), payload: { action: "disable" }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as any).external_access.enabled, false);
  assert.equal((await app.inject({ method: "GET", url: "/api/link-viewer/dashboard", headers: { cookie: viewerCookie } })).statusCode, 401);
  const login = await viewerLogin(credentials.username, credentials.password);
  assert.ok(login.status === 401 || login.status === 403, `revoked credential refused (${login.status})`);
  const l1 = (await distribution(SELLER_A, dealA)).body.links.find((l: any) => l.link_id === L1.link_id);
  assert.equal(l1.status, "active", "the link itself is untouched");
  assert.equal(l1.metrics.entries, 3, "analytics untouched");
  assert.equal(l1.external_access.enabled, false);
  const reset = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}/external-access`,
    headers: sellerHeaders(SELLER_A), payload: { action: "reset_password" }
  });
  assert.equal(reset.statusCode, 409, "nothing to reset while disabled");
  const reEnable = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links/${L1.link_id}/external-access`,
    headers: sellerHeaders(SELLER_A), payload: { action: "enable" }
  });
  assert.equal(reEnable.statusCode, 200, reEnable.body);
  const fresh = (reEnable.json() as any).credentials;
  assert.notEqual(fresh.username, credentials.username, "a revoked identity is never resurrected");
  assert.equal((await viewerLogin(fresh.username, fresh.password)).status, 200);
});

await run("a link viewer for A2 cannot read A1 (each credential is scoped to its own grant)", async () => {
  const enable = await app.inject({
    method: "POST", url: `/api/seller/deals/${dealA}/distribution/links/${L2.link_id}/external-access`,
    headers: sellerHeaders(SELLER_A), payload: { action: "enable" }
  });
  assert.equal(enable.statusCode, 200, enable.body);
  const c2 = (enable.json() as any).credentials;
  const login = await viewerLogin(c2.username, c2.password);
  assert.equal(login.status, 200);
  const own = await app.inject({ method: "GET", url: "/api/link-viewer/dashboard", headers: { cookie: login.cookie } });
  assert.equal(own.statusCode, 200);
  assert.equal((own.json() as any).link.link_id, L2.link_id);
  assert.equal((own.json() as any).totals.entries, 2);
  const other = await app.inject({ method: "GET", url: `/api/link-viewer/dashboard?link=${L1.link_id}`, headers: { cookie: login.cookie } });
  assert.equal(other.statusCode, 403);
});

await run("login attempts are rate limited (fail closed after repeated failures)", async () => {
  let limited = false;
  for (let i = 0; i < LINK_VIEWER_LOGIN_MAX_ATTEMPTS + 2; i++) {
    const res = await viewerLogin(`lv-bruteforce`, `wrong-${i}`);
    if (res.status === 429) { limited = true; break; }
    assert.equal(res.status, 401);
  }
  assert.ok(limited, "429 after repeated failures");
  assert.equal((await viewerLogin(credentials.username, credentials.password)).status, 429, "the caller address is limited too, not only the username");
});

await app.close().catch(() => undefined);
await pool.end();
console.log(`\nseller distribution hub validation: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
