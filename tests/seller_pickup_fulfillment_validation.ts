// LAUNCH SPRINT 3 — physical pickup credential + seller handoff, DB-exercised.
// Bookstore scenario: seller "bookstore", product "ספר X", buyer ישראל ישראלי,
// qty 3 × ₪60 = ₪180, self pickup.
//
// Proves (spec §16 A-J + negative controls): eligible order gets a code + QR
// without PII; invalid / foreign / tampered codes are refused identically;
// the right seller verifies (name, product, qty, "שולם"); the handoff writes
// the canonical fulfilled state exactly once (replay + already-fulfilled are
// harmless); buyer tracking reflects the truth; an audit row exists; no
// money state moves. Every non-settled money state is refused. Voucher units
// are untouched. Real money: 0.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Pool } = pg;

process.env.APP_DEPLOYMENT_MODE = process.env.APP_DEPLOYMENT_MODE || "demo-preview";
process.env.DISABLE_OUTBOX_WORKER = "1";
// A dozen synthetic buyers in one minute would trip the product limiter (a feature); the proof harnesses raise it the same way.
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "10000";
process.env.RATE_LIMIT_READ_MAX = process.env.RATE_LIMIT_READ_MAX || "5000";
process.env.RATE_LIMIT_SENSITIVE_MAX = process.env.RATE_LIMIT_SENSITIVE_MAX || "1000";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || `pickup-test-admin-${randomUUID().slice(0, 8)}`;

const { app } = await import("../src/app.js");
const {
  BOOKSTORE_DELIVERY,
  BOOKSTORE_PICKUP,
  assertNoPii,
  createDeal,
  ensureSellerReady,
  forceDealState,
  forceParticipantTo,
  joinDeal,
  participantStates,
  piiStrings,
  publishDeal,
  sellerHeaders,
  tracking
} = await import("./helpers/physical_fulfillment_fixture.js");
const { decidePhysicalFulfillment, normalizeOrderCodeInput, formatOrderCode, pickupQrPayload } = await import("../src/physical_fulfillment.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/siton", max: 4 });
const ADMIN = { "x-admin-key": String(process.env.ADMIN_API_KEY) };

let passed = 0;
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (e: any) { console.error(`FAIL ${name}: ${e.message}`); failed++; }
}

const tag = randomUUID().slice(0, 6);
const SELLER_A = `bookstore-${tag}`;
const SELLER_B = `other-seller-${tag}`;
const HA = sellerHeaders(SELLER_A);
const HB = sellerHeaders(SELLER_B);
const BUYER = { name: "ישראל ישראלי", phone: `052${String(Date.now()).slice(-7)}`, email: `israel-${tag}@example.test` };
const DELIVERY_BUYER = { name: "נועה כהן", phone: `053${String(Date.now() + 7).slice(-7)}`, email: `noa-${tag}@example.test` };

await ensureSellerReady(app, SELLER_A, "חנות הספרים");
await ensureSellerReady(app, SELLER_B, "מוכר אחר");

// ── Fixtures ────────────────────────────────────────────────────────────────
const dealId = await createDeal(app, SELLER_A, { title: "ספר X", price: 60, minUnits: 3, maxUnits: 40 });
await publishDeal(app, SELLER_A, dealId);
const israel = await joinDeal(app, dealId, { ...BUYER, qty: 3, optionType: "pickup" });
const noa = await joinDeal(app, dealId, { ...DELIVERY_BUYER, qty: 2, optionType: "delivery", address: "דיזנגוף 100", city: "תל אביב", notes: "קומה 3, דלת ימין" });
const MONEY_CASES = ["AuthHeld", "AuthLocked", "ChargeAttempt", "ChargeFailedRecovery", "AuthReleased", "Refunded"] as const;
const moneyParticipants: Record<string, { participant_id: string; tracking_access_token: string; phone: string; name: string }> = {};
for (const [index, moneyState] of MONEY_CASES.entries()) {
  const phone = `054${String(Date.now() + 100 + index).slice(-7)}`;
  const name = `קונה ${moneyState}`;
  const joined = await joinDeal(app, dealId, { name, phone, qty: 1, optionType: "pickup" });
  moneyParticipants[moneyState] = { ...joined, phone, name };
}
const recovered = await joinDeal(app, dealId, { name: "קונה RecoveredCharge", phone: `055${String(Date.now() + 200).slice(-7)}`, qty: 1, optionType: "pickup" });

const openDealId = await createDeal(app, SELLER_A, { title: "ספר פתוח", price: 40, minUnits: 5, maxUnits: 40 });
await publishDeal(app, SELLER_A, openDealId);
const openJoin = await joinDeal(app, openDealId, { name: "קונה פתוח", phone: `056${String(Date.now() + 300).slice(-7)}`, qty: 1, optionType: "pickup" });

const failedDealId = await createDeal(app, SELLER_A, { title: "ספר שנכשל", price: 40, minUnits: 5, maxUnits: 40 });
await publishDeal(app, SELLER_A, failedDealId);
const failedJoin = await joinDeal(app, failedDealId, { name: "קונה נכשל", phone: `057${String(Date.now() + 400).slice(-7)}`, qty: 1, optionType: "pickup" });

const PII = piiStrings({ name: BUYER.name, phone: BUYER.phone, email: BUYER.email, participantId: israel.participant_id, token: israel.tracking_access_token });

const resolve = (headers: any, code: string) =>
  app.inject({ method: "GET", url: `/api/seller/fulfillment/resolve?code=${encodeURIComponent(code)}`, headers });
const search = (headers: any, q: string) =>
  app.inject({ method: "GET", url: `/api/seller/fulfillment/search?q=${encodeURIComponent(q)}`, headers });
const handoff = (headers: any, payload: any, key?: string) =>
  app.inject({ method: "POST", url: "/api/seller/fulfillment/handoff", headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) }, payload });
const list = (headers: any, id: string, qs = "") =>
  app.inject({ method: "GET", url: `/api/seller/deals/${id}/fulfillment${qs}`, headers });
async function eventCount(sellerId: string) {
  const r = await pool.query(`SELECT count(*)::int AS n FROM siton.seller_security_events WHERE seller_id=$1 AND event_type='fulfillment.handoff'`, [sellerId]);
  return Number(r.rows[0].n);
}
async function moneySnapshot() {
  const p = await participantStates(pool, israel.participant_id);
  const attempts = await pool.query(`SELECT count(*)::int AS n FROM siton.payment_attempts`);
  const audit = await pool.query(`SELECT count(*)::int AS n FROM siton.audit_log`);
  const fees = await pool.query(`SELECT count(*)::int AS n FROM siton.platform_fee_money_events`);
  const deal = await pool.query(`SELECT state FROM siton.deals WHERE deal_id=$1`, [dealId]);
  return { buyer_state: p.buyer_state, money_state: p.money_state, deal_state: String(deal.rows[0].state), attempts: Number(attempts.rows[0].n), audit: Number(audit.rows[0].n), fees: Number(fees.rows[0].n) };
}

let orderCode = "";
let qrPayload = "";

await run("0: the pure decision — only ChargedSuccess/RecoveredCharge on a Completed deal with a DealCompleted buyer are eligible; every other money state, Failed and Cancelled are refused with the right reason", async () => {
  const units = { total: 3, issued: 3, redeemed: 0, voided: 0, redeemed_at: null };
  const ok = decidePhysicalFulfillment({ dealType: "physical_product", dealState: "Completed", buyerState: "DealCompleted", moneyState: "ChargedSuccess", units });
  assert.equal(ok.seller_verdict, "ready"); assert.equal(ok.buyer_state, "ready"); assert.equal(ok.paid, true);
  const rec = decidePhysicalFulfillment({ dealType: "physical_product", dealState: "Completed", buyerState: "DealCompleted", moneyState: "RecoveredCharge", units });
  assert.equal(rec.seller_verdict, "ready");
  const expectations: Record<string, string> = {
    AuthHeld: "payment_incomplete", AuthLocked: "payment_incomplete", ChargeAttempt: "payment_incomplete",
    ChargeFailedRecovery: "payment_incomplete", AuthReleased: "not_eligible", Refunded: "refunded", NoFinancial: "payment_incomplete"
  };
  for (const [money, reason] of Object.entries(expectations)) {
    const v = decidePhysicalFulfillment({ dealType: "physical_product", dealState: "Completed", buyerState: "DealCompleted", moneyState: money, units });
    assert.equal(v.seller_verdict, "not_ready", money);
    assert.equal(v.not_ready_reason, reason, money);
    assert.notEqual(v.buyer_state, "ready", money);
  }
  assert.equal(decidePhysicalFulfillment({ dealType: "physical_product", dealState: "Completed", buyerState: "ChargedSuccess", moneyState: "ChargedSuccess", units }).not_ready_reason, "payment_incomplete", "buyer not DealCompleted yet");
  assert.equal(decidePhysicalFulfillment({ dealType: "physical_product", dealState: "Failed", buyerState: "DealFailed", moneyState: "AuthReleased", units }).buyer_state, "deal_failed");
  assert.equal(decidePhysicalFulfillment({ dealType: "physical_product", dealState: "Cancelled", buyerState: "NotJoined", moneyState: "NoFinancial", units }).buyer_state, "deal_cancelled");
  assert.equal(decidePhysicalFulfillment({ dealType: "physical_product", dealState: "PendingTarget", buyerState: "JoinedAuthorized", moneyState: "AuthHeld", units }).buyer_state, "deal_open");
  assert.equal(decidePhysicalFulfillment({ dealType: "voucher", dealState: "Completed", buyerState: "DealCompleted", moneyState: "ChargedSuccess", units }).buyer_state, "not_applicable");
  const done = decidePhysicalFulfillment({ dealType: "physical_product", dealState: "Completed", buyerState: "DealCompleted", moneyState: "ChargedSuccess", units: { total: 3, issued: 0, redeemed: 3, voided: 0, redeemed_at: "2026-09-08T10:00:00.000Z" } });
  assert.equal(done.seller_verdict, "already_fulfilled"); assert.equal(done.buyer_state, "fulfilled");
  // Code normalisation: typed variants + the QR URL all resolve to the same 8 digits; junk never does.
  assert.equal(normalizeOrderCodeInput("CT-1234-5678"), "12345678");
  assert.equal(normalizeOrderCodeInput("ct 1234 5678"), "12345678");
  assert.equal(normalizeOrderCodeInput("12345678"), "12345678");
  assert.equal(normalizeOrderCodeInput(pickupQrPayload("https://x.test", "CT-1234-5678")), "12345678");
  for (const junk of ["", "CT-1234", "1234567", "123456789", "CT-ABCD-EFGH", "<script>", "' OR 1=1 --", "%00", "x".repeat(600)]) assert.equal(normalizeOrderCodeInput(junk), null, junk.slice(0, 20));
  assert.equal(formatOrderCode("12345678"), "CT-1234-5678");
});

await run("1: before the deal completes, the buyer sees 'העסקה עדיין לא הושלמה' — no code, no QR (open deal, AuthHeld)", async () => {
  const r = await tracking(app, openJoin.participant_id, openJoin.tracking_access_token);
  assert.equal(r.statusCode, 200, r.body);
  const pickup = (r.json() as any).tracking.pickup;
  assert.ok(pickup && pickup.applicable, r.body);
  assert.equal(pickup.state, "deal_open");
  assert.equal(pickup.headline, "העסקה עדיין לא הושלמה");
  assert.equal(pickup.order_code, null);
  assert.equal(pickup.qr_payload, null);
  assert.equal(pickup.method, "pickup");
});

// Settle the bookstore + delivery buyers, park every money case, complete the deal.
await forceParticipantTo(pool, israel.participant_id, "ChargedSuccess");
await forceParticipantTo(pool, noa.participant_id, "ChargedSuccess");
for (const moneyState of MONEY_CASES) await forceParticipantTo(pool, moneyParticipants[moneyState]!.participant_id, moneyState);
await forceParticipantTo(pool, recovered.participant_id, "RecoveredCharge");
await forceDealState(pool, dealId, "Completed");
await forceDealState(pool, failedDealId, "Failed");

await run("A: the eligible physical order gets a valid credential — CT-NNNN-NNNN code, QR payload with the locator only, qty 3, 'ספר X', pickup location, 'מוכן לאיסוף'; three units issued lazily, one code shared by the order", async () => {
  const r = await tracking(app, israel.participant_id, israel.tracking_access_token);
  assert.equal(r.statusCode, 200, r.body);
  const t = (r.json() as any).tracking;
  const pickup = t.pickup;
  assert.equal(pickup.state, "ready", JSON.stringify(pickup));
  assert.equal(pickup.headline, "מוכן לאיסוף");
  assert.match(String(pickup.order_code), /^CT-\d{4}-\d{4}$/);
  orderCode = String(pickup.order_code);
  qrPayload = String(pickup.qr_payload);
  assert.ok(qrPayload.includes(`code=${encodeURIComponent(orderCode)}`), qrPayload);
  assert.ok(/^https?:\/\/[^/]+\/preview\/#\/seller\/pickup\?code=/.test(qrPayload), qrPayload);
  assertNoPii(qrPayload, PII, "QR payload");
  assert.equal(pickup.qty, 3);
  assert.equal(pickup.product_title, "ספר X");
  assert.equal(pickup.method, "pickup");
  assert.equal(pickup.method_label, "איסוף עצמי");
  assert.ok(String(pickup.pickup_location).includes("הרצל 12"), String(pickup.pickup_location));
  assert.equal(pickup.buyer_name, BUYER.name);
  assert.equal(pickup.phone_last4, BUYER.phone.slice(-4));
  assert.equal(pickup.fulfilled_at, null);
  assert.equal(pickup.disclosure, "סביבת הדגמה — אין חיוב אמיתי");
  assert.equal(Number(t.qty), 3);
  assert.equal(Number(t.estimated_total), 180);
  const units = await pool.query(`SELECT status, unit_index, metadata_jsonb->>'order_code' AS code, code_display_last4 FROM siton.fulfillment_units WHERE participant_id=$1 ORDER BY unit_index`, [israel.participant_id]);
  assert.equal(units.rowCount, 3);
  for (const u of units.rows) { assert.equal(u.status, "Issued"); assert.equal(u.code, orderCode); assert.equal(u.code_display_last4, orderCode.slice(-4)); }
  const again = await tracking(app, israel.participant_id, israel.tracking_access_token);
  assert.equal((again.json() as any).tracking.pickup.order_code, orderCode, "the code is stable across reads");
});

await run("B: invalid credentials are rejected with ONE identical 404 and no PII — random, malformed, tampered digit, hostile strings, empty", async () => {
  const digits = orderCode.replace(/\D/g, "");
  const tampered = formatOrderCode(String((Number(digits) + 1) % 100000000).padStart(8, "0"));
  const bodies = new Set<string>();
  for (const bad of ["CT-0000-0000", tampered, "CT-1234", "not-a-code", "<script>alert(1)</script>", "' OR 1=1 --", "%00", "", "x".repeat(600), "CT-ABCD-EFGH"]) {
    const r = await resolve(HA, bad);
    assert.equal(r.statusCode, 404, `${bad.slice(0, 20)} → ${r.statusCode} ${r.body}`);
    assert.equal((r.json() as any).code, "pickup_code_not_found");
    assertNoPii(r.body, PII, `refusal for ${bad.slice(0, 12)}`);
    bodies.add(r.body);
  }
  assert.equal(bodies.size, 1, "every refusal carries the same body (no oracle)");
});

await run("C: the wrong seller cannot resolve, search or fulfill the order — identical 404 / empty result, no PII", async () => {
  const r = await resolve(HB, orderCode);
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((r.json() as any).code, "pickup_code_not_found");
  assertNoPii(r.body, PII, "foreign resolve");
  const unknown = await resolve(HB, "CT-0000-0000");
  assert.equal(unknown.body, r.body, "foreign code and unknown code answer identically");
  const s = await search(HB, BUYER.phone.slice(-6));
  assert.equal(s.statusCode, 200, s.body);
  assert.deepEqual((s.json() as any).orders, []);
  assertNoPii(s.body, PII, "foreign search");
  const h = await handoff(HB, { participant_id: israel.participant_id, expected_qty: 3, source: "scan" }, `k-b-${tag}`);
  assert.equal(h.statusCode, 404, h.body);
  assert.equal((h.json() as any).code, "pickup_code_not_found");
  assertNoPii(h.body, PII, "foreign handoff");
  const l = await list(HB, dealId);
  assert.equal(l.statusCode, 404, l.body);
  const states = await participantStates(pool, israel.participant_id);
  assert.equal(states.money_state, "ChargedSuccess");
  const units = await pool.query(`SELECT count(*) FILTER (WHERE status='Redeemed')::int AS n FROM siton.fulfillment_units WHERE participant_id=$1`, [israel.participant_id]);
  assert.equal(units.rows[0].n, 0, "nothing was fulfilled by the wrong seller");
});

await run("C2: the default/anonymous seller context in demo mode cannot resolve the code either (404, no PII)", async () => {
  const r = await app.inject({ method: "GET", url: `/api/seller/fulfillment/resolve?code=${encodeURIComponent(orderCode)}` });
  assert.ok([401, 403, 404].includes(r.statusCode), `${r.statusCode} ${r.body}`);
  assertNoPii(r.body, PII, "anonymous resolve");
  const h = await app.inject({ method: "POST", url: "/api/seller/fulfillment/handoff", headers: { "content-type": "application/json", authorization: `Bearer ${israel.tracking_access_token}` }, payload: { participant_id: israel.participant_id, expected_qty: 3 } });
  assert.ok([401, 403, 404].includes(h.statusCode), `buyer token as seller → ${h.statusCode} ${h.body}`);
  const units = await pool.query(`SELECT count(*) FILTER (WHERE status='Redeemed')::int AS n FROM siton.fulfillment_units WHERE participant_id=$1`, [israel.participant_id]);
  assert.equal(units.rows[0].n, 0, "a buyer cannot mark themselves fulfilled");
});

await run("D: the correct seller verifies — GREEN: buyer, product, qty 3, 'שולם', 'איסוף עצמי', code; accepts typed variants and the QR URL", async () => {
  const r = await resolve(HA, orderCode);
  assert.equal(r.statusCode, 200, r.body);
  const o = (r.json() as any).order;
  assert.equal(o.verdict, "ready");
  assert.equal(o.verdict_label, "מוכן למסירה");
  assert.equal(o.buyer_name, BUYER.name);
  assert.equal(o.buyer_phone, BUYER.phone);
  assert.equal(o.buyer_phone_masked, `•••${BUYER.phone.slice(-4)}`);
  assert.equal(o.product_title, "ספר X");
  assert.equal(o.qty, 3);
  assert.equal(o.paid, true);
  assert.equal(o.payment_label, "שולם");
  assert.equal(o.method, "pickup");
  assert.equal(o.method_label, "איסוף עצמי");
  assert.equal(o.order_code, orderCode);
  assert.equal(o.fulfillment_status, "awaiting");
  assert.equal(o.participant_id, israel.participant_id);
  assert.equal(o.deal_id, dealId);
  assert.equal((r.json() as any).mock_money, true);
  for (const variant of [orderCode.toLowerCase(), orderCode.replace(/\D/g, ""), orderCode.replace(/-/g, " "), qrPayload]) {
    const v = await resolve(HA, variant);
    assert.equal(v.statusCode, 200, `${variant} → ${v.statusCode}`);
    assert.equal((v.json() as any).order.participant_id, israel.participant_id);
  }
  assert.doesNotMatch(r.body, /authorization_id|provider_reference|stripe_|payplus_|tracking_access_token|token_hash/);
});

await run("D2: search fallback — phone digits and buyer name find the order for its seller; a typed code routes to the code resolver", async () => {
  const byPhone = await search(HA, BUYER.phone.slice(-7));
  assert.equal(byPhone.statusCode, 200, byPhone.body);
  const phoneHits = (byPhone.json() as any).orders as any[];
  assert.ok(phoneHits.some((o) => o.participant_id === israel.participant_id), byPhone.body);
  const byName = await search(HA, "ישראל");
  assert.ok(((byName.json() as any).orders as any[]).some((o) => o.participant_id === israel.participant_id), byName.body);
  const byCode = await search(HA, orderCode);
  assert.equal((byCode.json() as any).mode, "code");
  assert.equal((byCode.json() as any).orders[0].participant_id, israel.participant_id);
  const none = await search(HA, "אין כזה קונה");
  assert.deepEqual((none.json() as any).orders, []);
});

await run("E/I/J: the handoff writes the canonical fulfilled state — 3 units Redeemed with redeemed_at, handoff record on the units, ONE audit event with seller/request/idempotency identity, idempotency_log row — and no money state, deal state, payment attempt, lifecycle audit or fee event changes", async () => {
  const before = await moneySnapshot();
  const eventsBefore = await eventCount(SELLER_A);
  const r = await handoff(HA, { participant_id: israel.participant_id, order_code: orderCode, expected_qty: 3, source: "scan" }, `handoff-${tag}-1`);
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json() as any;
  assert.equal(j.ok, true); assert.equal(j.idempotent, false); assert.equal(j.replay, false);
  assert.equal(j.units_marked, 3);
  assert.ok(j.fulfilled_at, "fulfilled_at present");
  assert.equal(j.message, "המסירה נרשמה");
  assert.equal(j.order.verdict, "already_fulfilled");
  assert.equal(j.order.fulfillment_status, "fulfilled");
  assert.equal(j.order.qty, 3);
  const units = await pool.query(`SELECT status, redeemed_at, metadata_jsonb FROM siton.fulfillment_units WHERE participant_id=$1 ORDER BY unit_index`, [israel.participant_id]);
  assert.equal(units.rowCount, 3);
  for (const u of units.rows) {
    assert.equal(u.status, "Redeemed");
    assert.ok(u.redeemed_at, "redeemed_at set");
    assert.equal(u.metadata_jsonb.handoff.seller_id, SELLER_A);
    assert.equal(u.metadata_jsonb.handoff.idempotency_key, `handoff-${tag}-1`);
    assert.equal(u.metadata_jsonb.handoff.qty, 3);
    assert.equal(u.metadata_jsonb.handoff.source, "scan");
    assert.equal(u.metadata_jsonb.order_code, orderCode);
  }
  const events = await pool.query(`SELECT actor_ref, request_id, idempotency_key, payload, from_status, to_status FROM siton.seller_security_events WHERE seller_id=$1 AND event_type='fulfillment.handoff'`, [SELLER_A]);
  assert.equal(events.rowCount, eventsBefore + 1, "exactly one audit event");
  const ev = events.rows[0];
  assert.match(String(ev.actor_ref), /^seller:/);
  assert.ok(ev.request_id, "request id recorded");
  assert.equal(ev.idempotency_key, `handoff-${tag}-1`);
  assert.equal(ev.payload.participant_id, israel.participant_id);
  assert.equal(ev.payload.deal_id, dealId);
  assert.equal(ev.payload.qty, 3);
  assert.equal(ev.payload.units_marked, 3);
  assert.equal(ev.payload.order_code_last4, orderCode.slice(-4));
  assert.ok(!JSON.stringify(ev.payload).includes(orderCode), "the audit payload never stores the full code");
  assert.equal(ev.from_status, "Issued"); assert.equal(ev.to_status, "Redeemed");
  const idem = await pool.query(`SELECT response_code FROM siton.idempotency_log WHERE entity_type='participant' AND entity_id=$1 AND action_name='fulfillment.handoff' AND idempotency_key=$2`, [israel.participant_id, `handoff-${tag}-1`]);
  assert.equal(idem.rowCount, 1); assert.equal(idem.rows[0].response_code, "OK");
  const after = await moneySnapshot();
  assert.deepEqual(after, before, "money/deal/audit/fee state untouched by the handoff");
});

await run("F: the second handoff is idempotent — same key replays the stored response, a new key answers 'כבר סומן כנמסר', no second audit event, redeemed_at unchanged, no unit touched", async () => {
  const stamp = await pool.query(`SELECT max(redeemed_at) AS at, max(updated_at) AS upd FROM siton.fulfillment_units WHERE participant_id=$1`, [israel.participant_id]);
  const eventsBefore = await eventCount(SELLER_A);
  const replay = await handoff(HA, { participant_id: israel.participant_id, expected_qty: 3, source: "scan" }, `handoff-${tag}-1`);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal((replay.json() as any).replay, true);
  assert.equal((replay.json() as any).idempotent, true);
  assert.equal((replay.json() as any).units_marked, 0);
  const again = await handoff(HA, { participant_id: israel.participant_id, expected_qty: 3, source: "manual" }, `handoff-${tag}-2`);
  assert.equal(again.statusCode, 200, again.body);
  const aj = again.json() as any;
  assert.equal(aj.idempotent, true); assert.equal(aj.already_fulfilled, true); assert.equal(aj.units_marked, 0);
  assert.equal(aj.message, "כבר סומן כנמסר");
  assert.equal(aj.order.verdict, "already_fulfilled");
  const noKey = await handoff(HA, { participant_id: israel.participant_id, source: "list" });
  assert.equal(noKey.statusCode, 200, noKey.body);
  assert.equal((noKey.json() as any).idempotent, true);
  assert.equal(await eventCount(SELLER_A), eventsBefore, "no second audit event");
  const after = await pool.query(`SELECT max(redeemed_at) AS at, max(updated_at) AS upd FROM siton.fulfillment_units WHERE participant_id=$1`, [israel.participant_id]);
  assert.equal(String(after.rows[0].at), String(stamp.rows[0].at), "redeemed_at authoritative and unchanged");
  assert.equal(String(after.rows[0].upd), String(stamp.rows[0].upd), "units untouched by the repeat");
});

await run("F2: a repeated scan resolves to AMBER 'כבר נמסר' with the fulfillment time and code — no active fulfil verdict", async () => {
  const r = await resolve(HA, orderCode);
  assert.equal(r.statusCode, 200, r.body);
  const o = (r.json() as any).order;
  assert.equal(o.verdict, "already_fulfilled");
  assert.equal(o.verdict_label, "כבר נמסר");
  assert.ok(o.fulfilled_at, "fulfilled_at on the amber card");
  assert.equal(o.order_code, orderCode);
  assert.equal(o.qty, 3);
});

await run("H: buyer tracking reflects the fulfilled truth — 'ההזמנה נמסרה', fulfilled_at, code still shown, no ready QR emphasis", async () => {
  const r = await tracking(app, israel.participant_id, israel.tracking_access_token);
  assert.equal(r.statusCode, 200, r.body);
  const pickup = (r.json() as any).tracking.pickup;
  assert.equal(pickup.state, "fulfilled");
  assert.equal(pickup.headline, "ההזמנה נמסרה");
  assert.ok(pickup.fulfilled_at, "fulfilled_at on the buyer card");
  assert.equal(pickup.order_code, orderCode);
  assert.equal(pickup.qty, 3);
});

await run("N1-N6: every non-settled money state on the completed deal is refused — AuthHeld, AuthLocked, ChargeAttempt, ChargeFailedRecovery, AuthReleased, Refunded — no code, no QR, handoff 409 with a human reason, nothing marked", async () => {
  const expectedReason: Record<string, string> = {
    AuthHeld: "payment_incomplete", AuthLocked: "payment_incomplete", ChargeAttempt: "payment_incomplete",
    ChargeFailedRecovery: "payment_incomplete", AuthReleased: "not_eligible", Refunded: "refunded"
  };
  for (const moneyState of MONEY_CASES) {
    const p = moneyParticipants[moneyState]!;
    const states = await participantStates(pool, p.participant_id);
    assert.equal(states.money_state, moneyState, `fixture ${moneyState}`);
    const t = await tracking(app, p.participant_id, p.tracking_access_token);
    assert.equal(t.statusCode, 200, t.body);
    const pickup = (t.json() as any).tracking.pickup;
    assert.notEqual(pickup.state, "ready", moneyState);
    assert.notEqual(pickup.state, "fulfilled", moneyState);
    assert.equal(pickup.order_code, null, moneyState);
    assert.equal(pickup.qr_payload, null, moneyState);
    assert.ok(["payment_pending", "unavailable"].includes(pickup.state), `${moneyState} → ${pickup.state}`);
    assert.ok(["ההזמנה עדיין לא מוכנה למסירה", "ההזמנה אינה זמינה למסירה"].includes(pickup.headline), pickup.headline);
    const h = await handoff(HA, { participant_id: p.participant_id, source: "list" }, `neg-${moneyState}-${tag}`);
    assert.equal(h.statusCode, 409, `${moneyState}: ${h.body}`);
    assert.equal((h.json() as any).code, "fulfillment_not_ready");
    assert.equal((h.json() as any).reason, expectedReason[moneyState], moneyState);
    assert.ok(String((h.json() as any).message).length > 3, "human reason");
    assert.equal((h.json() as any).order.verdict, "not_ready");
    assert.equal((h.json() as any).order.paid, moneyState === "Refunded" ? false : false);
    const units = await pool.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status='Redeemed')::int AS r FROM siton.fulfillment_units WHERE participant_id=$1`, [p.participant_id]);
    assert.equal(units.rows[0].r, 0, `${moneyState}: nothing marked`);
    const after = await participantStates(pool, p.participant_id);
    assert.equal(after.money_state, moneyState, "money state untouched");
    const s = await search(HA, p.phone.slice(-7));
    const hit = ((s.json() as any).orders as any[]).find((o) => o.participant_id === p.participant_id);
    if (hit) { assert.equal(hit.verdict, "not_ready"); assert.equal(hit.paid, false); assert.equal(hit.payment_label, "לא שולם"); }
  }
});

await run("N7: RecoveredCharge counts as paid — the recovered buyer gets a code and a green verdict", async () => {
  const t = await tracking(app, recovered.participant_id, recovered.tracking_access_token);
  const pickup = (t.json() as any).tracking.pickup;
  assert.equal(pickup.state, "ready", JSON.stringify(pickup));
  assert.match(String(pickup.order_code), /^CT-\d{4}-\d{4}$/);
  const r = await resolve(HA, pickup.order_code);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((r.json() as any).order.verdict, "ready");
  assert.equal((r.json() as any).order.payment_label, "שולם");
});

await run("N8/N9: a failed deal and an open deal cannot be fulfilled — buyer sees the honest state, handoff 409", async () => {
  const f = await tracking(app, failedJoin.participant_id, failedJoin.tracking_access_token);
  const fp = (f.json() as any).tracking.pickup;
  assert.equal(fp.state, "deal_failed"); assert.equal(fp.order_code, null);
  assert.equal(fp.headline, "העסקה לא הושלמה — אין הזמנה למסירה");
  const fh = await handoff(HA, { participant_id: failedJoin.participant_id, source: "list" }, `neg-failed-${tag}`);
  assert.equal(fh.statusCode, 409, fh.body); assert.equal((fh.json() as any).reason, "deal_failed");
  const oh = await handoff(HA, { participant_id: openJoin.participant_id, source: "list" }, `neg-open-${tag}`);
  assert.equal(oh.statusCode, 409, oh.body); assert.equal((oh.json() as any).reason, "deal_not_completed");
  const ol = await list(HA, openDealId);
  assert.equal(ol.statusCode, 409, ol.body); assert.equal((ol.json() as any).code, "deal_not_completed");
  const bad = await handoff(HA, { participant_id: "not-a-uuid", source: "list" });
  assert.equal(bad.statusCode, 400, bad.body);
  const ghost = await handoff(HA, { participant_id: randomUUID(), source: "list" });
  assert.equal(ghost.statusCode, 404, ghost.body);
});

await run("N10: displayed quantity is the canonical participant qty — a stale expected_qty is refused 409 before anything is marked", async () => {
  const r = await handoff(HA, { participant_id: noa.participant_id, expected_qty: 5, source: "list" }, `qty-${tag}`);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((r.json() as any).code, "fulfillment_qty_mismatch");
  assert.equal((r.json() as any).order.qty, 2);
  assert.ok(String((r.json() as any).message).includes("2"));
  const units = await pool.query(`SELECT count(*) FILTER (WHERE status='Redeemed')::int AS r FROM siton.fulfillment_units WHERE participant_id=$1`, [noa.participant_id]);
  assert.equal(units.rows[0].r, 0);
});

let deliveryCode = "";
await run("DELIVERY: the courier order gets an order code but no counter QR; the buyer sees the address, the seller list carries code/buyer/phone/e-mail/qty/method/address/city/notes/payment/fulfillment", async () => {
  const t = await tracking(app, noa.participant_id, noa.tracking_access_token);
  const pickup = (t.json() as any).tracking.pickup;
  assert.equal(pickup.state, "ready"); assert.equal(pickup.method, "delivery");
  assert.match(String(pickup.order_code), /^CT-\d{4}-\d{4}$/);
  assert.equal(pickup.qr_payload, null, "no counter QR for delivery");
  assert.equal(pickup.delivery_address, "דיזנגוף 100"); assert.equal(pickup.delivery_city, "תל אביב");
  deliveryCode = String(pickup.order_code);
  const l = await list(HA, dealId);
  assert.equal(l.statusCode, 200, l.body);
  const lj = l.json() as any;
  assert.equal(lj.deal.deal_id, dealId);
  // israel (fulfilled), noa (awaiting), recovered (awaiting), refunded (blocked: settled once, money returned — the seller must see it as "אין למסור")
  assert.equal(lj.counts.total, 4, JSON.stringify(lj.counts));
  assert.equal(lj.counts.fulfilled, 1); assert.equal(lj.counts.awaiting, 2); assert.equal(lj.counts.blocked, 1);
  const refundedRow = (lj.orders as any[]).find((o) => o.participant_id === moneyParticipants.Refunded!.participant_id);
  assert.ok(refundedRow, "refunded order listed"); assert.equal(refundedRow.verdict, "not_ready"); assert.equal(refundedRow.not_ready_label, "התשלום הוחזר"); assert.equal(refundedRow.paid, false); assert.equal(refundedRow.order_code, null);
  const row = (lj.orders as any[]).find((o) => o.participant_id === noa.participant_id);
  assert.ok(row, "delivery row present");
  assert.equal(row.order_code, deliveryCode); assert.equal(row.buyer_name, DELIVERY_BUYER.name); assert.equal(row.buyer_phone, DELIVERY_BUYER.phone);
  assert.equal(row.buyer_email, DELIVERY_BUYER.email); assert.equal(row.qty, 2); assert.equal(row.method, "delivery"); assert.equal(row.method_label, "משלוח");
  assert.equal(row.delivery_address, "דיזנגוף 100"); assert.equal(row.delivery_city, "תל אביב"); assert.equal(row.delivery_notes, "קומה 3, דלת ימין");
  assert.equal(row.payment_label, "שולם"); assert.equal(row.fulfillment_status, "awaiting");
  assert.doesNotMatch(l.body, /tracking_number|shipped_at|delivered_at|delivery_status|delivery_issue|authorization_id|provider_reference/);
  const pending = await list(HA, dealId, "?status=pending");
  assert.ok(((pending.json() as any).orders as any[]).every((o) => o.fulfillment_status === "awaiting"));
  const fulfilled = await list(HA, dealId, "?status=fulfilled");
  assert.deepEqual(((fulfilled.json() as any).orders as any[]).map((o) => o.participant_id), [israel.participant_id]);
  const byCode = await list(HA, dealId, `?q=${encodeURIComponent(deliveryCode)}`);
  assert.deepEqual(((byCode.json() as any).orders as any[]).map((o) => o.participant_id), [noa.participant_id]);
  const byName = await list(HA, dealId, `?q=${encodeURIComponent("נועה")}`);
  assert.deepEqual(((byName.json() as any).orders as any[]).map((o) => o.participant_id), [noa.participant_id]);
});

await run("EXCEL: the delivery export row matches canonical data — order code, buyer, phone, e-mail, qty, method, address, city, notes, 'שולם', fulfillment state; after the list handoff it says 'נמסר'", async () => {
  const ExcelJS = (await import("exceljs")).default;
  async function exportRows() {
    const r = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/delivery-handoff/export.xlsx`, headers: HA });
    assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.rawPayload as any);
    const ws = wb.worksheets[0]!;
    const header = (ws.getRow(1).values as any[]).slice(1).map(String);
    const rows: Record<string, any>[] = [];
    ws.eachRow((row, n) => { if (n > 1) { const values = (row.values as any[]).slice(1); rows.push(Object.fromEntries(header.map((h, i) => [h, values[i]]))); } });
    return { header, rows, raw: r.rawPayload as Buffer };
  }
  const first = await exportRows();
  for (const h of ["קוד הזמנה", "שם מקבל", "טלפון", "אימייל", "כמות", "אופן קבלה", "כתובת", "עיר", "הערת משלוח", "מצב תשלום", "מצב מסירה", "תאריך מסירה"]) assert.ok(first.header.includes(h), `header ${h}`);
  const row = first.rows.find((x) => x["שם מקבל"] === DELIVERY_BUYER.name);
  assert.ok(row, "delivery buyer row");
  assert.equal(row!["קוד הזמנה"], deliveryCode); assert.equal(row!["טלפון"], DELIVERY_BUYER.phone); assert.equal(row!["אימייל"], DELIVERY_BUYER.email);
  assert.equal(Number(row!["כמות"]), 2); assert.equal(row!["אופן קבלה"], "delivery"); assert.equal(row!["כתובת"], "דיזנגוף 100"); assert.equal(row!["עיר"], "תל אביב");
  assert.equal(row!["הערת משלוח"], "קומה 3, דלת ימין"); assert.equal(row!["מצב תשלום"], "שולם"); assert.equal(row!["מצב מסירה"], "ממתין למסירה");
  const israelRow = first.rows.find((x) => x["שם מקבל"] === BUYER.name);
  assert.equal(israelRow!["מצב מסירה"], "נמסר"); assert.equal(israelRow!["קוד הזמנה"], orderCode); assert.ok(israelRow!["תאריך מסירה"]);
  const rawText = first.raw.toString("latin1");
  assert.doesNotMatch(rawText, /tracking_number|shipped_at|delivered_at|delivery_status|delivery_issue|authorization_id|stripe_|payplus_/);
  const h = await handoff(HA, { participant_id: noa.participant_id, expected_qty: 2, source: "list" }, `delivery-${tag}`);
  assert.equal(h.statusCode, 200, h.body); assert.equal((h.json() as any).units_marked, 2);
  const second = await exportRows();
  assert.equal(second.rows.find((x) => x["שם מקבל"] === DELIVERY_BUYER.name)!["מצב מסירה"], "נמסר");
  const l = await list(HA, dealId);
  assert.equal((l.json() as any).counts.fulfilled, 2);
});

await run("ADMIN: the deal profile carries awaiting/fulfilled counts and per-participant handoff state with the code as last4 only; anonymous is refused", async () => {
  const r = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/profile`, headers: ADMIN });
  assert.equal(r.statusCode, 200, r.body);
  const f = (r.json() as any).profile.fulfillment;
  assert.equal(f.applicable, true);
  assert.equal(f.fulfilled, 2); assert.equal(f.awaiting, 1);
  assert.equal(f.by_participant[israel.participant_id].fulfillment_status, "fulfilled");
  assert.ok(f.by_participant[israel.participant_id].fulfilled_at);
  assert.equal(f.by_participant[israel.participant_id].order_code_last4, orderCode.slice(-4));
  assert.ok(!r.body.includes(orderCode), "admin profile never carries the full code");
  assert.equal(f.by_participant[recovered.participant_id].fulfillment_status, "awaiting");
  const anon = await app.inject({ method: "GET", url: `/api/admin/deals/${dealId}/profile` });
  assert.ok([401, 403].includes(anon.statusCode), `anonymous admin → ${anon.statusCode}`);
});

await run("VOUCHER/TICKET isolation: a voucher participant's tracking has no pickup credential and the physical handoff refuses it; the voucher redeem route is untouched", async () => {
  const voucherDealId = await createDeal(app, SELLER_A, {
    title: "שובר ארוחה", price: 100, minUnits: 1, maxUnits: 10,
    deliveryOptions: [BOOKSTORE_PICKUP],
    extra: {
      deal_type: "voucher",
      voucher_terms: {
        face_value_amount: 100, currency: "ILS",
        valid_from: new Date(Date.now() - 864e5).toISOString(), valid_until: new Date(Date.now() + 90 * 864e5).toISOString(),
        redemption_location: "מסעדת הדגים, הים 12, תל אביב", redemption_instructions: "להציג בקופה", terms: "תקף לארוחה אחת",
        is_single_use: true, allow_partial_redemption: false, voucher_code_mode: "system_generated"
      }
    }
  });
  await publishDeal(app, SELLER_A, voucherDealId);
  const vj = await joinDeal(app, voucherDealId, { name: "קונה שובר", phone: `058${String(Date.now() + 500).slice(-7)}`, qty: 1, optionType: "pickup" });
  await forceParticipantTo(pool, vj.participant_id, "ChargedSuccess");
  await forceDealState(pool, voucherDealId, "Completed");
  const t = await tracking(app, vj.participant_id, vj.tracking_access_token);
  assert.equal(t.statusCode, 200, t.body);
  const tj = (t.json() as any).tracking;
  assert.equal(tj.deal_type, "voucher");
  assert.equal(tj.pickup.applicable, false);
  assert.equal(tj.pickup.state, "not_applicable");
  assert.equal(tj.pickup.order_code, null);
  assert.equal(tj.fulfillment.eligible, true);
  const h = await handoff(HA, { participant_id: vj.participant_id, source: "list" }, `voucher-${tag}`);
  assert.equal(h.statusCode, 409, h.body); assert.equal((h.json() as any).reason, "not_physical");
  const units = await pool.query(`SELECT fulfillment_unit_id, status, code_hash, metadata_jsonb FROM siton.fulfillment_units WHERE participant_id=$1`, [vj.participant_id]);
  for (const u of units.rows) { assert.equal(u.status, "Issued"); assert.ok(!u.metadata_jsonb.order_code, "no pickup code on a voucher unit"); }
  if (units.rowCount) {
    const redeem = await app.inject({ method: "POST", url: `/api/seller/fulfillment/${units.rows[0].fulfillment_unit_id}/redeem`, headers: HA });
    assert.equal(redeem.statusCode, 200, redeem.body);
    assert.equal((redeem.json() as any).status, "Redeemed");
  }
  const s = await search(HA, "קונה שובר");
  assert.deepEqual((s.json() as any).orders, [], "voucher orders never appear in the physical search");
});

await run("EXISTING delivery-handoff contract unchanged — buyers list still carries the pinned fields, no logistics literals", async () => {
  const r = await app.inject({ method: "GET", url: `/api/seller/deals/${dealId}/delivery-handoff`, headers: HA });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json() as any;
  assert.ok(Array.isArray(j.buyers) && j.buyers.length >= 3);
  for (const b of j.buyers) for (const f of ["participant_id", "buyer_id", "buyer_name", "buyer_phone", "qty", "delivery_method_type", "delivery_method_label", "delivery_address", "delivery_city", "delivery_notes", "joined_at"]) assert.ok(f in b, f);
  assert.doesNotMatch(r.body, /tracking_number|shipped_at|delivered_at|delivery_status|delivery_issue/);
});

await pool.end();
await app.close();
console.log(`\nPICKUP_FULFILLMENT passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
