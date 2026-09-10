// LAUNCH POLISH 2 — buyer feedback rail + seller trust fact, DB-exercised:
//  * POST /api/deals/:id/feedback stores ONE compact answer on the existing
//    operational-cases rail (Closed / Low / Buyer / opened_by=buyer_feedback):
//    no migration, no structured PII fields; optional free text must be treated as user-provided content (name/phone/e-mail/participant id
//    are neither accepted nor stored), bounded text, fixed categories,
//    honeypot, per-deal + platform hourly caps, unpublished deals refused
//  * the support queue never sees it as work (status Closed, not in Open)
//  * GET /api/admin/pilot-metrics aggregates it (admin-guarded)
//  * the public deal projection carries `seller.approved` as a boolean only
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `feedback-test-admin-${randomUUID().slice(0, 8)}`;

const { app } = await import("../src/app.js");
const { armTestFault } = await import("../src/fault_injection.js");
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

const seller = `seller-fb-${randomUUID().slice(0, 8)}`;
const H = { "x-seller-id": seller, "content-type": "application/json" };
const ADMIN = { "x-admin-key": String(process.env.ADMIN_API_KEY) };
const JSON_H = { "content-type": "application/json" };
const deadline = () => new Date(Date.now() + 3 * 864e5).toISOString();

async function createDeal(extra: Record<string, unknown> = {}) {
  const r = await app.inject({
    method: "POST", url: "/deals", headers: { ...H, "idempotency-key": `fb-${randomUUID().slice(0, 12)}` },
    payload: {
      title: "מארז דבש משוב", description_short: "דבש פרחי בר", price_per_unit: 45, list_price_per_unit: 65, min_units: 5, max_units: 20,
      deadline: deadline(), deal_type: "physical_product",
      delivery_options: [{ option_type: "pickup", label: "הרצל 12, תל אביב", cost: 0, sort_order: 0, latitude: 32.0668, longitude: 34.7647 }],
      ...extra
    }
  });
  assert.ok([200, 201].includes(r.statusCode), r.body);
  const j = r.json() as any;
  return String(j.deal_id || j.deal?.deal_id);
}
async function publish(dealId: string) {
  const bp = await app.inject({
    method: "PUT", url: "/api/seller/business-profile", headers: H,
    payload: { business_name: "עסק משוב", business_id_number: "515000003", contact_name: "בודק", contact_phone: "0501234567" }
  });
  assert.equal(bp.statusCode, 200, bp.body);
  const pub = await app.inject({
    method: "POST", url: `/deals/${dealId}/publish`, headers: { ...H, "idempotency-key": `fb-pub-${randomUUID().slice(0, 8)}` },
    payload: { seller_terms_accepted: true, seller_critical_terms_accepted: true, seller_threshold_90_accepted: true }
  });
  assert.equal(pub.statusCode, 200, pub.body);
}
const feedback = (dealId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/deals/${dealId}/feedback`, headers: JSON_H, payload });

const dealId = await createDeal();
const draftId = await createDeal();
await publish(dealId);

await run("1: a published deal accepts ONE compact answer → 201; stored Closed/Low/Buyer on operational_cases, opened_by=buyer_feedback, deal + seller linked, no buyer_ref, no participant_id", async () => {
  const r = await feedback(dealId, { category: "price", text: "  לא הבנתי  אם המחיר כולל  משלוח ", surface: "join_success" });
  assert.equal(r.statusCode, 201, r.body);
  const j = r.json() as any;
  assert.ok(j.ok && j.feedback_id && j.category === "price", r.body);
  const row = await pool.query(`SELECT * FROM siton.operational_cases WHERE case_id=$1`, [j.feedback_id]);
  assert.equal(row.rowCount, 1);
  const c = row.rows[0];
  assert.equal(c.opened_by, "buyer_feedback");
  assert.equal(c.status, "Closed");
  assert.equal(c.priority, "Low");
  assert.equal(c.source, "Buyer");
  assert.equal(c.case_type, "Other");
  assert.equal(String(c.deal_id), dealId);
  assert.equal(String(c.seller_id), seller);
  assert.equal(c.buyer_ref, null, "feedback never carries a buyer reference");
  assert.equal(c.participant_id, null, "feedback never carries a participant id");
  assert.ok(c.closed_at, "closed immediately");
  assert.ok(String(c.resolution_note || "").length > 0, "close-note constraint satisfied");
  assert.equal(c.subject, "משוב קונה: המחיר / ההנחה");
  assert.match(String(c.description), /^קטגוריה: price\nמסך: join_success\nטקסט: לא הבנתי אם המחיר כולל משלוח$/, "whitespace-normalised, category first, text last");
});

await run("2: PII sent by a hostile or buggy client is NOT stored (name/phone/email/participant fields are ignored)", async () => {
  const r = await feedback(dealId, {
    category: "other", text: "משהו", surface: "tracking",
    name: "ישראל ישראלי", phone: "0521234567", email: "pii@example.com", participant_id: randomUUID(), buyer_id: "0521234567"
  });
  assert.equal(r.statusCode, 201, r.body);
  const row = await pool.query(`SELECT * FROM siton.operational_cases WHERE case_id=$1`, [(r.json() as any).feedback_id]);
  const blob = JSON.stringify(row.rows[0]);
  assert.ok(!/ישראל ישראלי|0521234567|pii@example\.com/.test(blob), `PII leaked into the row: ${blob.slice(0, 300)}`);
  assert.equal(row.rows[0].participant_id, null);
  assert.equal(row.rows[0].buyer_ref, null);
});

await run("3: the empty-text 'all clear' answer is accepted and stored without a text line", async () => {
  const r = await feedback(dealId, { category: "all_clear", surface: "join_success" });
  assert.equal(r.statusCode, 201, r.body);
  const row = await pool.query(`SELECT description, subject FROM siton.operational_cases WHERE case_id=$1`, [(r.json() as any).feedback_id]);
  assert.equal(row.rows[0].description, "קטגוריה: all_clear\nמסך: join_success");
  assert.equal(row.rows[0].subject, "משוב קונה: הכול היה ברור");
});

await run("4: refusals — unknown category 400, text over 280 chars 400, unknown surface stored as 'unknown', bad uuid 400, unpublished (draft) deal 404, honeypot 200 with no row", async () => {
  const bad = await feedback(dealId, { category: "rating_5_stars", surface: "tracking" });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal((bad.json() as any).code, "feedback_category_invalid");
  const long = await feedback(dealId, { category: "other", text: "א".repeat(281), surface: "tracking" });
  assert.equal(long.statusCode, 400, long.body);
  assert.equal((long.json() as any).code, "feedback_text_too_long");
  const surf = await feedback(dealId, { category: "delivery", surface: "<script>" });
  assert.equal(surf.statusCode, 201, surf.body);
  const surfRow = await pool.query(`SELECT description FROM siton.operational_cases WHERE case_id=$1`, [(surf.json() as any).feedback_id]);
  assert.match(String(surfRow.rows[0].description), /\nמסך: unknown$/);
  const uuid = await app.inject({ method: "POST", url: "/api/deals/not-a-uuid/feedback", headers: JSON_H, payload: { category: "other" } });
  assert.equal(uuid.statusCode, 400, uuid.body);
  const draft = await feedback(draftId, { category: "other", surface: "tracking" });
  assert.equal(draft.statusCode, 404, draft.body);
  assert.equal((draft.json() as any).code, "feedback_deal_unavailable");
  const before = await pool.query(`SELECT count(*)::int AS n FROM siton.operational_cases WHERE opened_by='buyer_feedback'`);
  const hp = await feedback(dealId, { category: "other", surface: "tracking", website: "http://spam.example" });
  assert.equal(hp.statusCode, 200, hp.body);
  assert.deepEqual(hp.json(), { ok: true, received: true });
  const after = await pool.query(`SELECT count(*)::int AS n FROM siton.operational_cases WHERE opened_by='buyer_feedback'`);
  assert.equal(after.rows[0].n, before.rows[0].n, "honeypot must not create a row");
});

await run("5: the support queue never treats feedback as work — not listed under status=Open, open_count unchanged", async () => {
  const openBefore = await app.inject({ method: "GET", url: "/api/admin/support-cases?status=Open", headers: ADMIN });
  assert.equal(openBefore.statusCode, 200, openBefore.body);
  const listBefore = ((openBefore.json() as any).cases || []) as any[];
  const r = await feedback(dealId, { category: "target", text: "מה קורה אם לא מגיעים", surface: "tracking" });
  assert.equal(r.statusCode, 201, r.body);
  const openAfter = await app.inject({ method: "GET", url: "/api/admin/support-cases?status=Open", headers: ADMIN });
  const listAfter = ((openAfter.json() as any).cases || []) as any[];
  assert.equal(listAfter.length, listBefore.length, "feedback must not appear as an open case");
  assert.ok(!listAfter.some((c) => c.opened_by === "buyer_feedback"), "no feedback row in the open queue");
  const closed = await app.inject({ method: "GET", url: "/api/admin/support-cases?status=Closed", headers: ADMIN });
  assert.equal(closed.statusCode, 200, closed.body);
  const closedList = ((closed.json() as any).cases || []) as any[];
  assert.ok(closedList.some((c) => String(c.case_id) === String((r.json() as any).feedback_id)), "the feedback is visible to the owner as a closed case");
});

await run("6: hourly caps — the 61st answer for one deal within the hour is refused 429 (feedback_rate_limited) and creates no row", async () => {
  const capDeal = await createDeal();
  await publish(capDeal);
  for (let i = 0; i < 60; i++) {
    await pool.query(
      `INSERT INTO siton.operational_cases (case_type, status, priority, source, deal_id, seller_id, opened_by, subject, description, resolution_note, closed_at)
       VALUES ('Other','Closed','Low','Buyer',$1,$2,'buyer_feedback','משוב קונה: משהו אחר','קטגוריה: other\nמסך: tracking','seed',now())`,
      [capDeal, seller]
    );
  }
  const before = await pool.query(`SELECT count(*)::int AS n FROM siton.operational_cases WHERE deal_id=$1`, [capDeal]);
  const r = await feedback(capDeal, { category: "other", surface: "tracking" });
  assert.equal(r.statusCode, 429, r.body);
  assert.equal((r.json() as any).code, "feedback_rate_limited");
  const after = await pool.query(`SELECT count(*)::int AS n FROM siton.operational_cases WHERE deal_id=$1`, [capDeal]);
  assert.equal(after.rows[0].n, before.rows[0].n);
  // other deals are unaffected by one deal's cap
  const other = await feedback(dealId, { category: "how_it_works", surface: "tracking" });
  assert.equal(other.statusCode, 201, other.body);
});

await run("7: pilot metrics aggregate the categories + recent texts (admin only; anonymous refused)", async () => {
  const anon = await app.inject({ method: "GET", url: "/api/admin/pilot-metrics?days=7" });
  assert.ok([401, 403].includes(anon.statusCode), `anonymous got ${anon.statusCode}`);
  const res = await app.inject({ method: "GET", url: "/api/admin/pilot-metrics?days=7", headers: ADMIN });
  assert.equal(res.statusCode, 200, res.body);
  const fb = (res.json() as any).feedback;
  assert.ok(fb && typeof fb.total === "number" && fb.total >= 5, JSON.stringify(fb));
  const cats = Object.fromEntries((fb.by_category as any[]).map((r) => [r.category, r.count]));
  assert.ok(cats.price >= 1 && cats.other >= 1 && cats.all_clear >= 1 && cats.target >= 1 && cats.how_it_works >= 1, JSON.stringify(cats));
  assert.ok((fb.recent as any[]).some((r) => r.category === "price" && r.text === "לא הבנתי אם המחיר כולל משלוח"), JSON.stringify(fb.recent));
  assert.ok((fb.recent as any[]).every((r) => !("buyer_ref" in r) && !("participant_id" in r)), "aggregate rows carry no identity fields");
  const blob = JSON.stringify(fb);
  assert.ok(!/ישראל ישראלי|0521234567|pii@example\.com/.test(blob), "no PII in the aggregate");
});

// ROUND 2 (UX-5): the public seller block now also carries the seller PUBLIC
// PROFILE identity the owner asked to see on the deal page — `profile_id` (the
// same public_profile_id /api/public-sellers/:id already answers on, and which
// appears in public profile URLs) and `image` (the /api/content-assets/<uuid>
// URL of the logo the seller uploaded, served unauthenticated by design).
// The allow-list stays STRICT — a future key has to be added here deliberately
// — and the leak proof below is now explicit about every class of private
// datum that must never appear: internal seller id, e-mail, phone, address,
// bank details, raw verification status.
await run("8: public projection — public identity only (approved is a boolean; no raw status, no PII, no internal ids)", async () => {
  const pub = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  assert.equal(pub.statusCode, 200, pub.body);
  const s = (pub.json() as any).seller;
  assert.deepEqual(
    Object.keys(s).sort(),
    ["approved", "business_description", "business_name", "contact_channel", "image", "profile_id"],
    JSON.stringify(s)
  );
  assert.equal(s.approved, true, "demo seller rows default to approved");
  assert.equal(s.contact_channel, "siton_inquiry");
  // the public profile id is the PUBLIC one, never the internal seller_id
  assert.match(String(s.profile_id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(String(s.profile_id), String(seller), "public_profile_id must not be the internal seller_id");
  // the logo, when present, is only ever the public content-asset URL
  const withImage = await pool.query(`SELECT profile_image_id FROM siton.seller_accounts WHERE seller_id=$1`, [seller]);
  assert.equal(s.image, withImage.rows[0].profile_image_id ? `/api/content-assets/${withImage.rows[0].profile_image_id}` : null);
  await pool.query(`UPDATE siton.seller_accounts SET verification_status='pending' WHERE seller_id=$1`, [seller]);
  const pending = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  const p = (pending.json() as any).seller;
  assert.equal(p.approved, false);
  const blob = JSON.stringify(p);
  assert.ok(!/verification_status|pending/.test(blob), "raw status never on the public payload");
  assert.ok(!blob.includes(String(seller)), "internal seller_id never on the public payload");
  assert.ok(!/support_email|support_phone|bank_|business_address|@|05\d{8}/.test(blob), `contact/bank detail leaked: ${blob}`);
  await pool.query(`UPDATE siton.seller_accounts SET verification_status='approved' WHERE seller_id=$1`, [seller]);
});

await run("9: a joined buyer's tracking answers what/how-many/deadline (unchanged contract the tracking page derives its next steps from)", async () => {
  const pubDeal = await app.inject({ method: "GET", url: `/api/deals/${dealId}/public` });
  const opt = (pubDeal.json() as any).deal.delivery_options[0];
  const join = await app.inject({
    method: "POST", url: `/deals/${dealId}/join`, headers: { ...JSON_H, "idempotency-key": `fb-join-${randomUUID().slice(0, 8)}` },
    payload: { buyer_id: "0501112233", buyer_name: "נועה", qty: 2, delivery_option_id: opt.option_id, buyer_terms_accepted: true, payment_disclosure_accepted: true, payment_method: "credit_card" }
  });
  assert.equal(join.statusCode, 200, join.body);
  const j = join.json() as any;
  assert.ok(j.participant_id && j.tracking_access_token && Number(j.hold_total) === 90, join.body);
  const tr = await app.inject({ method: "GET", url: `/api/participants/${j.participant_id}/tracking`, headers: { authorization: `Bearer ${j.tracking_access_token}` } });
  assert.equal(tr.statusCode, 200, tr.body);
  const t = (tr.json() as any).tracking;
  assert.equal(Number(t.qty), 2);
  assert.equal(Number(t.threshold_units), 5);
  assert.equal(Number(t.progress.current_units), 2);
  assert.ok(t.deadline && t.headline && t.deal_id === dealId);
  const bad = await app.inject({ method: "GET", url: `/api/participants/${j.participant_id}/tracking`, headers: { authorization: "Bearer not-the-token" } });
  assert.ok([401, 403].includes(bad.statusCode), `bad token got ${bad.statusCode}`);
});

await run("10: the 201 is sent only after COMMIT — with the INSERT's transaction parked before COMMIT the reply stays pending; once it arrives, a separate connection reads the returned feedback_id at once (no sleeps, no retries)", async () => {
  const raceDeal = await createDeal();
  await publish(raceDeal);
  // withTx #1 of the request is ensureOperationalCaseTables; #2 holds the INSERT.
  const barrier = armTestFault("db.before_commit", { kind: "block" }, 2);
  assert.ok(barrier, "block fault did not return a barrier");
  const order: string[] = [];
  const settled = feedback(raceDeal, { category: "delivery", surface: "tracking" }).then((res) => { order.push("response"); return res; });
  await barrier!.entered;
  const parked = await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND query ILIKE '%INSERT INTO siton.operational_cases%'`
  );
  assert.equal(parked.rows[0].n, 1, "the INSERT's transaction is parked before COMMIT");
  const uncommitted = await pool.query(`SELECT count(*)::int AS n FROM siton.operational_cases WHERE deal_id=$1 AND opened_by='buyer_feedback'`, [raceDeal]);
  assert.equal(uncommitted.rows[0].n, 0, "nothing is visible to another connection before COMMIT");
  order.push("release");
  barrier!.release();
  const res = await settled;
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(order, ["release", "response"], `the reply must not be dispatched before COMMIT (observed ${order.join(" -> ")})`);
  const row = await pool.query(`SELECT description FROM siton.operational_cases WHERE case_id=$1`, [(res.json() as any).feedback_id]);
  assert.equal(row.rowCount, 1, "the feedback_id returned with the 201 is readable at once on another connection");
  assert.match(String(row.rows[0].description), /^קטגוריה: delivery\nמסך: tracking$/);
});

await pool.end();
await app.close();
console.log(`BUYER_FEEDBACK_RESULT passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
